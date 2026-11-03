import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { resolveHarnessHome } from "@i-harness/harness-home"
import type { Settings } from "../schema/types.ts"
import { SETTINGS_DEFAULTS } from "../schema/defaults.ts"
import { normalizeSettings } from "../normalize/settings.ts"
import { normalizeLlm } from "../normalize/providers.ts"
import { isRecord } from "../normalize/primitives.ts"
import { assertInstructionData, validateInstructions } from "../instructions.ts"
import { loadRevisionMeta } from "./revision.ts"
import type { SettingsStoreOptions, SettingsRevisionGuard, ObservedSettingsLoadOptions, ObservedSettingsLoad } from "./contracts.ts"
import { SettingsConflictError } from "../sections.ts"
import { parseDocumentTolerant, patchJsonDocumentKeepingComments } from "./json-patch.ts"
import { captureLegacyInstructionImport, instructionMigrationMeta, nativeInstructionMeta, stageInstructionImport, type LegacyInstructionImport } from "./instruction-migration.ts"
import { SettingsWriteQueue, writeSettingsDocument } from "./transaction.ts"
import { readObservedDocument } from "./observed-read.ts"

/** Global settings path; an explicit document path wins. */
export function resolveSettingsPath(options: SettingsStoreOptions = {}): string {
  if (options.path !== undefined) return resolve(options.path)
  return resolve(join(resolveHarnessHome(options.configDir), "settings.json"))
}

/** A single atomic JSON-file settings store. Serialized writes publish only after rename. */
export class SettingsStore {
  private readonly filename: string
  private settings: Settings = normalizeSettings(undefined)
  private raw: Record<string, unknown> = {}
  private loaded = false
  private revision: Record<string, number> = {}
  private readonly queue = new SettingsWriteQueue()

  constructor(options: SettingsStoreOptions = {}) { this.filename = resolveSettingsPath(options) }
  /** Snapshots/drafts belong to callers; edits cannot mutate saved state. */
  get(): Settings { return structuredClone(this.settings) }
  getSectionRevision(name: string): number { return this.revision[name] ?? 0 }
  getSectionMutationBase(name: "llm" | "onboarding" | "instructions"): unknown {
    return name === "llm" ? normalizeLlm(this.raw.llm, SETTINGS_DEFAULTS.llm) : structuredClone(this.settings[name])
  }
  isLoaded(): boolean { return this.loaded }
  load(): Promise<Settings> { return this.queue.run(() => this.read()) }

  /** Strict saved read; a rejected observation never replaces last-good state. */
  loadObserved(options: ObservedSettingsLoadOptions = {}): Promise<ObservedSettingsLoad> {
    const validate = options.validate
    return this.queue.run(async () => {
      const observed = await readObservedDocument(this.filename, validate)
      if (observed === undefined) {
        if (!this.loaded) this.publish(undefined)
        return { kind: "missing", stamp: { kind: "missing" } }
      }
      this.publish(observed.raw)
      return { kind: "loaded", settings: this.get(), stamp: observed.stamp }
    })
  }

  private async read(): Promise<Settings> {
    let parsed: Record<string, unknown> | undefined
    try { parsed = parseDocumentTolerant(await readFile(this.filename, "utf8")) } catch { /* missing/corrupt normal loads use defaults */ }
    if (parsed !== undefined) instructionMigrationMeta(parsed, this.filename)
    this.publish(parsed)
    return this.get()
  }
  private publish(raw: Record<string, unknown> | undefined): void {
    this.raw = raw ?? {}
    this.settings = normalizeSettings(raw)
    this.revision = loadRevisionMeta(raw)
    this.loaded = true
  }

  set(input: Partial<Settings>, guard?: SettingsRevisionGuard): Promise<Settings> {
    // Capture before entering the queue; later caller edits cannot change the write.
    assertInstructionData(input)
    if (Object.hasOwn(input, "instructions")) validateInstructions(input.instructions)
    const patch = structuredClone(input)
    assertInstructionData(guard)
    const capturedGuard = structuredClone(guard)
    return this.queue.run(async () => {
      if (!this.loaded) await this.read()
      if (capturedGuard !== undefined && this.getSectionRevision(capturedGuard.section) !== capturedGuard.expectedRevision) {
        throw new SettingsConflictError(capturedGuard.expectedRevision, this.getSectionRevision(capturedGuard.section))
      }
      const source: Record<string, unknown> = { ...this.raw, ...this.settings, ...patch }
      // Preserve the unprojected canonical provider plane and legacy read pin.
      if ("llm" in patch) source.llm = normalizeLlm(patch.llm, SETTINGS_DEFAULTS.llm)
      else if (Object.hasOwn(this.raw, "llm")) source.llm = normalizeLlm(this.raw.llm, SETTINGS_DEFAULTS.llm)
      else delete source.llm
      const legacy = isRecord(this.raw.tui) ? this.raw.tui.providers : undefined
      if (isRecord(legacy)) source.tui = { ...(isRecord(source.tui) ? source.tui : {}), providers: legacy }
      const next: Record<string, unknown> = { ...source, ...normalizeSettings(source), llm: source.llm, tui: source.tui }
      if (source.llm === undefined) delete next.llm
      return this.save(next, Object.keys(patch))
    })
  }

  reset(): Promise<Settings> {
    return this.queue.run(async () => {
      if (!this.loaded) await this.read()
      return this.save({ ...this.raw, ...normalizeSettings(undefined) }, ["llm", "onboarding", "tui", "instructions"])
    })
  }

  dropLegacyTuiProvider(id: string): Promise<void> {
    return this.queue.run(async () => {
      if (!this.loaded) await this.read()
      const doc = structuredClone(this.raw)
      const tui = isRecord(doc.tui) ? doc.tui : undefined
      const pin = isRecord(tui?.providers) ? tui.providers : undefined
      const rows = isRecord(pin?.providers) ? pin.providers : undefined
      if (tui === undefined || pin === undefined || rows === undefined || !Object.hasOwn(rows, id)) return
      delete rows[id]
      if (Object.keys(rows).length === 0) delete tui.providers
      else if (pin.activeProviderId === id) pin.activeProviderId = ""
      await this.save(doc, [])
    })
  }

  migrateInstructions(input: LegacyInstructionImport): Promise<Settings> {
    const request = captureLegacyInstructionImport(input, this.filename)
    return this.queue.run(async () => {
      const staged = await stageInstructionImport(request)
      if (!staged.changed) {
        this.publish(staged.raw)
        return this.get()
      }
      const revisions = loadRevisionMeta(staged.raw)
      staged.raw._revision = { ...revisions, instructions: (revisions.instructions ?? 0) + 1 }
      const text = patchJsonDocumentKeepingComments(staged.text, staged.raw)
      await writeSettingsDocument(this.filename, text, request.expectedDocumentHash)
      this.publish(staged.raw)
      return this.get()
    })
  }

  private async save(doc: Record<string, unknown>, changed: readonly string[]): Promise<Settings> {
    // Raw extension data survives ordinary writes, but these known retired
    // preferences must not be restored by merging that data with the snapshot.
    for (const key of ["theme", "busyEnter", "transcriptMode"]) delete doc[key]
    const meta = instructionMigrationMeta(this.raw, this.filename)
    doc._instructionsMigration = meta ?? nativeInstructionMeta(this.filename)
    const revision = { ...this.revision }
    for (const name of ["llm", "onboarding", "tui", "instructions"]) if (changed.includes(name)) revision[name] = (revision[name] ?? 0) + 1
    if (Object.keys(revision).length > 0) doc._revision = revision
    await writeSettingsDocument(this.filename, JSON.stringify(doc, null, 2))
    this.publish(doc)
    return this.get()
  }
}

export async function updateSettings(options: SettingsStoreOptions, patch: Partial<Settings>): Promise<Settings> {
  const store = new SettingsStore(options)
  await store.load()
  return store.set(patch)
}
