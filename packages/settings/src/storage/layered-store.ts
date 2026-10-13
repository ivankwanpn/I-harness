import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Settings } from "../schema/types.ts"
import { normalizeSettings } from "../normalize/settings.ts"
import { watchSettings } from "../observation/watch-settings.ts"
import { loadRevisionMeta } from "./revision.ts"
import { mergeRawLayers, resolveLayeredDefaults, type LayerSource } from "./layers.ts"
import { parseDocumentTolerant, patchJsonDocumentKeepingComments, SettingsPatchError } from "./json-patch.ts"
import type { LayeredStoreOptions } from "./contracts.ts"

/**
 * A layered Settings store (SettingsStore-compatible surface — usable where a
 * SettingsStore is accepted). Sources are merged by RAW documents (deep, last
 * wins) and normalized ONCE, so unknown keys survive as long as a higher layer
 * does not override them. Writes go to the MASTER = the highest-priority
 * EXISTING source, via the comment-preserving leaf patch. Revision meta
 * (`_revision`) follows the master document.
 */
export class LayeredSettingsStore {
  private readonly options: LayeredStoreOptions
  private readonly resolvedRoots: LayerSource[]
  private rawsByPath = new Map<string, Record<string, unknown>>()
  private current: Settings = normalizeSettings(undefined)
  private loaded = false
  private revision: Record<string, number> = {}
  private listeners = new Set<(path: string) => void>()
  private watcher: { dispose: () => void } | undefined
  // WHY: an in-flight reload calls load(), which must not reopen a disposed
  // watcher (test/watch-events.test.ts:190).
  private disposed = false
  /** W1 conflate state: a reload is in flight, and the detections that arrived
   * while it was — arrival-ordered and deduped (a file re-observed inside its
   * own window, e.g. the settled half of a non-atomic write, is not a new
   * change). BOTH settle paths resolve this queue — see recheckPendingChange.
   * The paths are part of the state, not decoration: the re-check reports under
   * a pending detection's path, never under the one that started the reload in
   * flight (measured: the wrong path is user-visible in `data.path`). */
  private reloadInFlight = false
  private reloadPending: string[] = []

  constructor(options: LayeredStoreOptions = {}) {
    this.options = options
    this.resolvedRoots = resolveLayeredDefaults(options)
  }

  get(): Settings { return this.current }

  isLoaded(): boolean { return this.loaded }

  async load(): Promise<Settings> {
    this.rawsByPath.clear()
    for (const source of this.resolvedRoots) {
      source.raws = undefined
      if (source.path === null) continue
      const text = await readFile(source.path, "utf8").catch(() => undefined)
      if (text === undefined) continue
      const raw = parseDocumentTolerant(text)
      this.rawsByPath.set(source.path, raw)
      source.raws = raw
    }
    const master = this.masterSource()
    const masterRaw = master !== undefined ? this.rawsByPath.get(master.path!) : undefined
    this.revision = loadRevisionMeta(masterRaw)
    this.current = normalizeSettings(this.rawsByPath.size === 0 ? undefined : mergeRawLayers([...this.resolvedRoots]))
    this.loaded = true
    this.ensureWatcher()
    return this.current
  }

  async set(patch: Partial<Settings>): Promise<Settings> {
    if (!this.loaded) await this.load()
    // The first durable write must carry the new-store web default. Otherwise
    // that newly created partial document would look like an older live policy.
    if (this.rawsByPath.size === 0 && patch.webSearchMode === undefined) patch = { ...patch, webSearchMode: this.current.webSearchMode }
    this.current = normalizeSettings(mergeRawLayers([...this.resolvedRoots, { raws: patch }]))
    if ("llm" in patch) this.revision.llm = (this.revision.llm ?? 0) + 1
    if ("onboarding" in patch) this.revision.onboarding = (this.revision.onboarding ?? 0) + 1
    if ("tui" in patch) this.revision.tui = (this.revision.tui ?? 0) + 1
    await this.writeMaster(patch, { ...this.revision })
    return this.current
  }

  async reset(): Promise<Settings> {
    if (!this.loaded) await this.load()
    this.current = normalizeSettings(undefined)
    this.revision.llm = (this.revision.llm ?? 0) + 1
    this.revision.onboarding = (this.revision.onboarding ?? 0) + 1
    this.revision.tui = (this.revision.tui ?? 0) + 1
    await this.writeMaster({}, { ...this.revision })
    return this.current
  }

  getSectionRevision(name: string): number { return this.revision[name] ?? 0 }

  sources(): LayerSource[] { return this.resolvedRoots }

  onChange(cb: (path: string) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  async reloadFromDisk(): Promise<Settings> {
    return this.load()
  }

  dispose(): void {
    this.disposed = true
    this.watcher?.dispose()
    this.watcher = undefined
  }

  /** Highest-priority EXISTING source; the write target. */
  private masterSource(): LayerSource | undefined {
    for (let i = this.resolvedRoots.length - 1; i >= 0; i -= 1) {
      const source = this.resolvedRoots[i]!
      if (source.path !== null && this.rawsByPath.has(source.path)) return source
    }
    return this.resolvedRoots.find((s) => s.path !== null) ?? this.resolvedRoots.at(-1)
  }

  /**
   * Leaf-patch write: merge the patch ONTO THE MASTER RAW DOCUMENT (never the
   * normalized memory — unknown keys and hand-edited extras survive) and
   * persist atomically through the comment-preserving patcher. A document the
   * patcher's parser rejects is untouched and the write throws
   * SettingsPatchError (fail-closed — never a destructive rewrite).
   */
  private async writeMaster(patch: Record<string, unknown>, nextRevision: Record<string, number>): Promise<void> {
    const master = this.masterSource()
    if (master?.path === undefined || master.path === null) return // nothing to write
    const dir = dirname(master.path)
    await mkdir(dir, { recursive: true })
    const existing = await readFile(master.path, "utf8").catch(() => undefined)
    const doc = existing !== undefined
      ? mergeRawLayers([{ raws: parseDocumentTolerant(existing) }, { raws: patch }])
      : mergeRawLayers([{ raws: {} }, { raws: patch }])
    if (Object.keys(nextRevision).length > 0) doc._revision = { ...nextRevision }

    let text: string
    if (existing !== undefined) {
      try {
        text = patchJsonDocumentKeepingComments(existing, doc)
      } catch (error) {
        // fail-closed: never destroy a document the patcher cannot read
        throw new SettingsPatchError(`cannot safely patch ${master.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      text = JSON.stringify(doc, null, 2)
    }
    const tmp = `${master.path}.tmp`
    await writeFile(tmp, text, "utf8")
    await rename(tmp, master.path)
    this.rawsByPath.set(master.path, doc)
    master.raws = doc
  }

  /** WHY: use fs-watch's explicit file roots, baseline and 100ms write
   * stability instead of polling (packages/fs-watch/src/index.ts:145).
   * Changed paths reload the merged view and notify onChange/telemetry;
   * W1 state-based conflate is unchanged (test/watch-events.test.ts:115). */
  private ensureWatcher(): void {
    if (this.disposed || this.watcher !== undefined || this.options.watchIntervalMs === false) return
    const intervalMs = this.options.watchIntervalMs ?? 500
    const paths = this.resolvedRoots
      .map((s) => s.path)
      .filter((p): p is string => p !== null && p !== undefined)
    if (paths.length === 0) return
    this.watcher = watchSettings(paths, (path) => this.handleWatchedChange(path), { intervalMs })
  }

  /**
   * W1 conflate: at most one `reloadFromDisk()` in flight, and a detection that
   * lands while one is in flight is absorbed UNLESS the disk moved again behind
   * it — the settle re-check compares STATE, never time.
   *
   * The baseline `before` is snapshotted synchronously and compared AFTER the
   * await, so two detections landing inside one reload's latency both compare
   * against the same pre-change view and both emit. That is one of the three
   * sources of the double report: the watcher can re-report one write (its own
   * out-of-order capture — guarded there now) and a non-atomic `writeFile`
   * (truncate → write) genuinely presents two `mtime:size` states, so a single
   * write can legitimately deliver two detections. The conflate absorbs the
   * second one here.
   *
   * The re-check is what keeps the conflate honest, and why it is not a
   * debounce: the pending detection starts a fresh reload whose baseline is the
   * state the in-flight reload produced. A detection that merely re-observed
   * the change just reported compares equal and emits nothing; a genuinely
   * separate write that the in-flight reload did not read differs and fires
   * once. Two real writes therefore stay two reports, no matter how close.
   */
  private handleWatchedChange(path: string): void {
    if (this.reloadInFlight) {
      // The pending detection keeps ITS OWN path (see recheckPendingChange).
      if (!this.reloadPending.includes(path)) this.reloadPending.push(path)
      return
    }
    // NOTE: no queue clear here. This is also the re-check's entry point, and a
    // re-check must not drop the detections queued behind the one it resolves
    // (they drain one per cycle, see recheckPendingChange). Nothing is pending
    // when a ROOT cycle starts: `reloadInFlight` is only ever false with an
    // empty queue — the settle clears the flag and starts the next re-check in
    // the same synchronous block, so no detection can slip between them.
    this.reloadInFlight = true
    // The pre-reload view is the change baseline: reloadFromDisk → load()
    // ALREADY assigns this.current, so comparing against this.current here
    // would always compare the merged view to itself (the dormant
    // store-level detection — M40 A6 fixes it by snapshotting BEFORE).
    const before = this.current
    void this.reloadFromDisk().then((settings) => {
      const reported = JSON.stringify(settings) !== JSON.stringify(before)
      if (reported) {
        for (const cb of [...this.listeners]) cb(path)
        this.options.telemetry?.emit({ type: "settings/changed", ts: Date.now(), data: { path } })
      }
      this.reloadInFlight = false
      this.recheckPendingChange(reported ? path : undefined)
    }).catch(() => {
      // A reload that threw (a torn read of a non-atomic writer's file, a
      // document the tolerant parser rejects) must not wedge the handler — and
      // must NOT drop the pending detection either. The watcher advanced its
      // snapshot to the state that raised the failure when it fired, so a
      // settled state observed DURING the failed reload is never re-detected:
      // dropping it here would lose the change outright (pre-conflate, that
      // detection's own reload read the settled state and reported it). So the
      // failure path resolves the pending exactly as the success path does —
      // and it reported nothing, so no path is excluded below.
      this.reloadInFlight = false
      this.recheckPendingChange(undefined)
    })
  }

  /**
   * Resolve ONE detection that arrived while a reload was in flight, from
   * EITHER settle path (the success path and the `catch` — a reload that threw
   * reported nothing, so it excludes no path). The entry starts a fresh reload
   * whose comparison baseline is the state the previous one produced
   * (`this.current` — unchanged by a reload that threw). A detection that
   * merely re-observed the change just reported compares equal and emits
   * nothing; a write the previous reload did not read differs and reports once,
   * under its OWN path.
   *
   * ONE entry per cycle, never the whole queue: an entry's change may be read
   * by a later cycle than the one that drained the entry before it (this reload
   * may itself fail, or may have read the disk before that write landed), and
   * the watcher advanced its snapshot when it fired — so a dropped entry is a
   * change that is never reported again. Each remaining entry gets its own
   * cycle this way; one whose change is already covered compares equal, emits
   * nothing, and is gone.
   *
   * `reportedPath` is the file the settled reload has ALREADY reported
   * (undefined when it reported nothing). The re-check prefers a pending path
   * different from it: that event is already out, so naming the same file again
   * would attribute the next transition to a file whose only other detection is
   * its own re-observation — the settled half of a non-atomic write, measured
   * to be visible to the poll — while another pending file's change has not
   * been reported at all. When nothing else is pending it re-checks that one
   * file anyway; the state comparison, not this choice, decides what fires.
   */
  private recheckPendingChange(reportedPath: string | undefined): void {
    const index = this.reloadPending.findIndex((p) => p !== reportedPath)
    if (index === -1 && this.reloadPending.length === 0) return
    const next = this.reloadPending.splice(index === -1 ? 0 : index, 1)[0]!
    this.handleWatchedChange(next)
  }
}

/** Convenience factory for the layered store. */
export function createLayeredStore(options: LayeredStoreOptions = {}): LayeredSettingsStore {
  return new LayeredSettingsStore(options)
}
