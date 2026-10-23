import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Settings } from "../schema/types.ts"
import { normalizeSettings } from "../normalize/settings.ts"
import { watchSettings, safeWatchWarning, type SettingsWatchHandle, type SettingsWatchError } from "../observation/watch-settings.ts"
import { stampBytes, sameSourceStamp, type SettingsSourceStamp } from "../observation/source-stamp.ts"
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
  private watcher: SettingsWatchHandle | undefined
  private sourceStamps = new Map<string, SettingsSourceStamp>()
  private reloadJob: Promise<void> | undefined
  private closeJob: Promise<void> | undefined
  private disposed = false
  private reloadPending: string[] = []

  constructor(options: LayeredStoreOptions = {}) {
    this.options = { ...options }
    this.resolvedRoots = resolveLayeredDefaults(options)
  }

  get(): Settings { return structuredClone(this.current) }

  getSectionMutationBase(name: "llm" | "onboarding" | "instructions"): unknown { return structuredClone(this.current[name]) }

  isLoaded(): boolean { return this.loaded }

  load(): Promise<Settings> {
    if (this.disposed) return Promise.reject(new Error("Settings store is closed"))
    return this.queue.run(() => this.read())
  }

  private async read(): Promise<Settings> {
    const raws = new Map<string, Record<string, unknown>>()
    const stamps = new Map<string, SettingsSourceStamp>()
    for (const source of this.resolvedRoots) {
      if (source.path === null) continue
      let bytes: Buffer
      try { bytes = await readFile(source.path) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error
        stamps.set(source.path, { kind: "missing" }); continue
      }
      stamps.set(source.path, stampBytes(bytes))
      const raw = parseDocumentTolerant(bytes.toString("utf8"))
      instructionMigrationMeta(raw, source.path)
      raws.set(source.path, raw)
    }
    this.sourceStamps = stamps
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
    if (this.disposed) return Promise.reject(new Error("Settings store is closed"))
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
    if (this.disposed) return Promise.reject(new Error("Settings store is closed"))
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
    if (this.disposed) return () => {}
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  async reloadFromDisk(): Promise<Settings> {
    return this.load()
  }

  /** Terminal fence: new mutations/reads reject; accepted store operations join. */
  dispose(): void {
    if (this.disposed) return
    this.fence()
    void this.close().catch(() => safeWatchWarning("close"))
  }

  private fence(): void {
    if (this.disposed) return
    this.disposed = true
    this.reloadPending.length = 0
    this.listeners.clear()
    this.watcher?.dispose()
  }

  /** Joins accepted store operations, the watch reload queue and watcher cleanup.
   * Async continuations returned by void subscribers remain caller-owned. */
  close(): Promise<void> {
    this.fence()
    if (this.closeJob) return this.closeJob
    const job = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([this.watcher?.close(), this.reloadJob, this.queue.drain()])
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Settings store cleanup incomplete")
    })
    this.closeJob = job
    void job.catch(() => { if (this.closeJob === job) this.closeJob = undefined })
    return job
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
    this.sourceStamps.set(master.path, stampBytes(Buffer.from(text, "utf8")))
    this.rawsByPath.set(master.path, doc)
    master.raws = doc
    this.publish()
  }

  /** Import targets only the host-selected global profile, never the master
   * merely because it happens to have the highest precedence. */
  migrateInstructions(input: LegacyInstructionImport): Promise<Settings> {
    if (this.disposed) return Promise.reject(new Error("Settings store is closed"))
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
      let text = staged.text
      if (staged.changed) {
        const revision = loadRevisionMeta(staged.raw)
        staged.raw._revision = { ...revision, instructions: (revision.instructions ?? 0) + 1 }
        text = patchJsonDocumentKeepingComments(staged.text, staged.raw, ["instructions", "_instructionsMigration"])
        await writeSettingsDocument(request.profilePath, text, request.expectedDocumentHash)
      }
      this.sourceStamps.set(source.path!, stampBytes(Buffer.from(text, "utf8")))
      this.rawsByPath.set(source.path!, staged.raw)
      source.raws = staged.raw
      this.publish()
      return this.get()
    })
  }

  private ensureWatcher(): void {
    if (this.disposed || this.watcher || this.options.watchIntervalMs === false) return
    const paths = this.resolvedRoots.map(source => source.path).filter((path): path is string => path !== null)
    if (!paths.length) return
    // The adapter selects absolute keys; retain the committed bytes rather than
    // letting a relative workspace key miss and trigger a second baseline read.
    // Source paths keep their configured spelling for callback attribution.
    const baseline = new Map([...this.sourceStamps].map(([path, stamp]) => [resolve(path), stamp]))
    this.watcher = watchSettings(paths, path => this.handleWatchedChange(path), {
      service: this.options.watchService, baseline,
      onError: failure => this.report(failure),
    })
  }

  private report(failure: SettingsWatchError): void {
    if (this.disposed || !this.options.onWatchError) { safeWatchWarning(failure.phase); return }
    try { void Promise.resolve(this.options.onWatchError(failure)).catch(() => safeWatchWarning(failure.phase)) }
    catch { safeWatchWarning(failure.phase) }
  }

  private notify(path: string): void {
    for (const listener of [...this.listeners]) {
      if (this.disposed) return
      if (!this.listeners.has(listener)) continue
      try { void Promise.resolve(listener(path)).catch(error => this.report({ phase: "consumer", error, path })) }
      catch (error) { this.report({ phase: "consumer", error, path }) }
    }
    if (this.disposed) return
    try { void Promise.resolve(this.options.telemetry?.emit({ type: "settings/changed", ts: Date.now(), data: { path } })).catch(error => this.report({ phase: "consumer", error, path })) }
    catch (error) { this.report({ phase: "consumer", error, path }) }
  }

  // Capture both sides inside the same queued read: intervening queued writes
  // cannot contaminate attribution. Public reloadFromDisk retains its surface.
  private watchedRead(): Promise<{ settings: Settings; beforeEffective: Settings; changedSourcePaths: string[] }> {
    return this.queue.run(async () => {
      const beforeEffective = this.current
      const before = new Map(this.sourceStamps)
      const settings = await this.read()
      const changedSourcePaths = this.resolvedRoots.flatMap(source => source.path !== null
        && !sameSourceStamp(before.get(source.path), this.sourceStamps.get(source.path)) ? [source.path] : [])
      return { settings, beforeEffective, changedSourcePaths }
    })
  }

  private handleWatchedChange(path: string): Promise<void> | undefined {
    if (this.disposed) return
    if (!this.reloadPending.includes(path)) this.reloadPending.push(path)
    if (this.reloadJob) return this.reloadJob
    const job = Promise.resolve().then(async () => {
      while (!this.disposed && this.reloadPending.length) {
        this.reloadPending.shift()
        try {
          const result = await this.watchedRead()
          if (this.disposed) break
          if (JSON.stringify(result.settings) !== JSON.stringify(result.beforeEffective)) {
            for (const changed of result.changedSourcePaths) {
              if (this.disposed) break
              this.notify(changed)
            }
          }
        } catch (error) { if (!this.disposed) this.report({ phase: "read", error }) }
      }
    })
    this.reloadJob = job
    void job.finally(() => {
      if (this.reloadJob === job) this.reloadJob = undefined
      if (!this.disposed && this.reloadPending.length) this.handleWatchedChange(this.reloadPending[0]!)
    }).catch(() => {})
    return job
  }

}

/** Convenience factory for the layered store. */
export function createLayeredStore(options: LayeredStoreOptions = {}): LayeredSettingsStore {
  return new LayeredSettingsStore(options)
}
