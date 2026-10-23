import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Settings } from "../schema/types.ts"
import { normalizeSettings } from "../normalize/settings.ts"
import { watchSettings } from "../observation/watch-settings.ts"
import { loadRevisionMeta } from "./revision.ts"
import { mergeRawLayers, resolveLayeredDefaults, type LayerSource } from "./layers.ts"
import { parseDocumentTolerant, patchJsonDocumentKeepingComments, SettingsPatchError } from "./json-patch.ts"
import type { LayeredStoreOptions, SettingsRevisionGuard } from "./contracts.ts"
import { SettingsConflictError } from "../sections.ts"
import { assertInstructionData, validateInstructions } from "../instructions.ts"
import { captureLegacyInstructionImport, InstructionMigrationError, instructionMigrationMeta, nativeInstructionMeta, stageInstructionImport, type LegacyInstructionImport } from "./instruction-migration.ts"
import { SettingsWriteQueue, writeSettingsDocument } from "./transaction.ts"

/**
 * A layered Settings store (SettingsStore-compatible surface — usable where a
 * SettingsStore is accepted). Sources are merged by RAW documents (deep, last
 * wins) and normalized ONCE, so unknown keys survive as long as a higher layer
 * does not override them. Writes go to the MASTER = the highest-priority
 * EXISTING source, via the comment-preserving leaf patch. Instructions are
 * whole-policy replacements; other fields retain the existing deep merge.
 * Revision meta follows each write target; the effective instructions counter
 * sums source counters so a profile import fences drafts even below a master.
 */
export class LayeredSettingsStore {
  private readonly options: LayeredStoreOptions
  private readonly resolvedRoots: LayerSource[]
  private rawsByPath = new Map<string, Record<string, unknown>>()
  private current: Settings = normalizeSettings(undefined)
  private loaded = false
  private revision: Record<string, number> = {}
  private readonly queue = new SettingsWriteQueue()
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
    this.options = { ...options }
    this.resolvedRoots = resolveLayeredDefaults(options)
  }

  get(): Settings { return structuredClone(this.current) }

  getSectionMutationBase(name: "llm" | "onboarding" | "instructions"): unknown { return structuredClone(this.current[name]) }

  isLoaded(): boolean { return this.loaded }

  load(): Promise<Settings> { return this.queue.run(() => this.read()) }

  private async read(): Promise<Settings> {
    const raws = new Map<string, Record<string, unknown>>()
    for (const source of this.resolvedRoots) {
      if (source.path === null) continue
      const text = await readFile(source.path, "utf8").catch(() => undefined)
      if (text === undefined) continue
      const raw = parseDocumentTolerant(text)
      instructionMigrationMeta(raw, source.path)
      raws.set(source.path, raw)
    }
    this.rawsByPath = raws
    for (const source of this.resolvedRoots) source.raws = source.path === null ? undefined : raws.get(source.path)
    this.publish()
    this.loaded = true
    this.ensureWatcher()
    return this.get()
  }

  private publish(): void {
    const master = this.masterSource()
    const masterRaw = master !== undefined ? this.rawsByPath.get(master.path!) : undefined
    this.revision = loadRevisionMeta(masterRaw)
    this.revision.instructions = [...this.rawsByPath.values()].reduce((sum, raw) => sum + (loadRevisionMeta(raw).instructions ?? 0), 0)
    const merged = mergeRawLayers(this.resolvedRoots)
    // Policies are complete sections: a higher explicit policy replaces the
    // lower policy, so a reset can durably restore absent/native globals.
    for (const source of this.resolvedRoots) if (source.raws && Object.hasOwn(source.raws, "instructions")) merged.instructions = source.raws.instructions
    this.current = normalizeSettings(this.rawsByPath.size === 0 ? undefined : merged)
  }

  set(input: Partial<Settings>, guard?: SettingsRevisionGuard): Promise<Settings> {
    assertInstructionData(input)
    if (Object.hasOwn(input, "instructions")) validateInstructions(input.instructions)
    let patch = structuredClone(input)
    assertInstructionData(guard)
    const capturedGuard = structuredClone(guard)
    return this.queue.run(async () => {
      if (!this.loaded) await this.read()
      if (capturedGuard !== undefined && this.getSectionRevision(capturedGuard.section) !== capturedGuard.expectedRevision) {
        throw new SettingsConflictError(capturedGuard.expectedRevision, this.getSectionRevision(capturedGuard.section))
      }
      // First durable writes retain the new-store web default.
      if (this.rawsByPath.size === 0 && patch.webSearchMode === undefined) patch = { ...patch, webSearchMode: this.current.webSearchMode }
      await this.writeMaster(patch, Object.keys(patch))
      return this.get()
    })
  }

  reset(): Promise<Settings> {
    return this.queue.run(async () => {
      if (!this.loaded) await this.read()
      const defaults = normalizeSettings(undefined)
      await this.writeMaster(defaults as unknown as Record<string, unknown>, ["llm", "onboarding", "tui", "instructions"], Object.keys(defaults))
      return this.get()
    })
  }

  getSectionRevision(name: string): number { return this.revision[name] ?? 0 }

  sources(): LayerSource[] { return structuredClone(this.resolvedRoots) }

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
  private async writeMaster(patch: Record<string, unknown>, changed: readonly string[], replaceKeys: readonly string[] = ["instructions"]): Promise<void> {
    const master = this.masterSource()
    if (master?.path === undefined || master.path === null) throw new SettingsPatchError("no configured settings source")
    const existing = await readFile(master.path, "utf8").catch(() => undefined)
    const raw = existing !== undefined ? parseDocumentTolerant(existing) : {}
    const meta = instructionMigrationMeta(raw, master.path)
    const doc = mergeRawLayers([{ raws: raw }, { raws: patch }])
    for (const key of replaceKeys) if (Object.hasOwn(patch, key)) doc[key] = patch[key]
    const nextRevision = loadRevisionMeta(raw)
    for (const name of ["llm", "onboarding", "tui", "instructions"]) if (changed.includes(name)) nextRevision[name] = (nextRevision[name] ?? 0) + 1
    if (Object.keys(nextRevision).length > 0) doc._revision = nextRevision
    if (meta !== undefined) doc._instructionsMigration = meta
    else if (master.label === "global" || (master.label === "file" && this.options.instructionProfilePath !== undefined && isAbsolute(this.options.instructionProfilePath)
      && resolve(this.options.instructionProfilePath) === master.path)) doc._instructionsMigration = nativeInstructionMeta(master.path)

    let text: string
    if (existing !== undefined) {
      try {
        text = patchJsonDocumentKeepingComments(existing, doc, replaceKeys)
      } catch (error) {
        // fail-closed: never destroy a document the patcher cannot read
        throw new SettingsPatchError(`cannot safely patch ${master.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      text = JSON.stringify(doc, null, 2)
    }
    await writeSettingsDocument(master.path, text)
    this.rawsByPath.set(master.path, doc)
    master.raws = doc
    this.publish()
  }

  /** Import targets only the host-selected global profile, never the master
   * merely because it happens to have the highest precedence. */
  migrateInstructions(input: LegacyInstructionImport): Promise<Settings> {
    const selected = this.options.instructionProfilePath ?? this.resolvedRoots.find((source) => source.label === "global")?.path
    const matches = selected && isAbsolute(selected) ? this.resolvedRoots.filter((candidate) => candidate.path === resolve(selected)) : []
    const source = matches.length === 1 ? matches[0] : undefined
    if (source?.path === undefined || source.path === null || source.label === "workspace" || source.label === "project") {
      throw new InstructionMigrationError("invalid-request", "legacy import requires an explicitly selected global profile source")
    }
    const request = captureLegacyInstructionImport(input, source.path)
    return this.queue.run(async () => {
      if (!this.loaded) await this.read()
      const staged = await stageInstructionImport(request)
      if (staged.changed) {
        const revision = loadRevisionMeta(staged.raw)
        staged.raw._revision = { ...revision, instructions: (revision.instructions ?? 0) + 1 }
        const text = patchJsonDocumentKeepingComments(staged.text, staged.raw, ["instructions", "_instructionsMigration"])
        await writeSettingsDocument(request.profilePath, text, request.expectedDocumentHash)
      }
      this.rawsByPath.set(source.path!, staged.raw)
      source.raws = staged.raw
      this.publish()
      return this.get()
    })
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
