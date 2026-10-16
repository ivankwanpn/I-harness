import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { resolveHarnessHome } from "@i-harness/harness-home"
import type { Settings, SettingsLlm } from "../schema/types.ts"
import { SETTINGS_DEFAULTS } from "../schema/defaults.ts"
import { normalizeSettings } from "../normalize/settings.ts"
import { normalizeLlm } from "../normalize/providers.ts"
import { isRecord } from "../normalize/primitives.ts"
import { loadRevisionMeta } from "./revision.ts"
import type { SettingsStoreOptions } from "./contracts.ts"

/**
 * Resolve the settings document path: an explicit `path` wins, otherwise it
 * lives under the config home (`$IH_CONFIG_DIR` or `~/.i-harness`), which is
 * GLOBAL (not workspace-scoped) — matching dsh's `<harness home>/settings.yaml`.
 * @param options - user-specified path or config dir.
 * @returns the fully resolved absolute document path.
 */
export function resolveSettingsPath(options: SettingsStoreOptions = {}): string {
  if (options.path !== undefined) return resolve(options.path)
  const dir = resolveHarnessHome(options.configDir)
  return join(dir, "settings.json")
}

/** A single atomic JSON-file settings store. */
export class SettingsStore {
  private readonly filename: string
  private settings: Settings
  /** Explicit canonical llm content, excluding the effective legacy projection. */
  private canonicalLlm: SettingsLlm | undefined
  /** M49 Task 6: the RAW legacy `tui.providers` section of the loaded
   * document (read-only provenance — the read migration projects it into
   * llm.providers on every normalize; the normalized output never exposes it
   * and the file section is preserved verbatim on writes until it is
   * re-saved through the canonical plane). undefined = no legacy section. */
  private legacyProviders: Record<string, unknown> | undefined
  private loaded = false
  private saving: Promise<void> | null = null
  /** Per-section mutation counters (see loadRevisionMeta). */
  private revision: Record<string, number> = {}

  constructor(options: SettingsStoreOptions = {}) {
    this.filename = resolveSettingsPath(options)
    this.settings = normalizeSettings(undefined)
    this.canonicalLlm = undefined
    this.legacyProviders = undefined
  }

  /** The current in-memory snapshot (defaults until load()). */
  get(): Settings {
    return this.settings
  }

  /** Current revision counter for a section (0 = never mutated). Used by the
   * section-mutate protocol: expectedRevision guard + 409 conflict. */
  getSectionRevision(name: string): number {
    return this.revision[name] ?? 0
  }

  /** Unprojected section content used when a mutation must preserve provenance. */
  getSectionMutationBase(name: "llm" | "onboarding"): unknown {
    if (name === "llm") return this.canonicalLlm ?? normalizeLlm(undefined, SETTINGS_DEFAULTS.llm)
    return this.settings.onboarding
  }

  /**
   * Load the document from disk, merging onto defaults. Missing/corrupt files
   * are not fatal — they yield the defaults so a first run behaves sanely.
   */
  async load(): Promise<Settings> {
    try {
      const raw = await readFile(this.filename, "utf8")
      const parsed: unknown = JSON.parse(raw)
      this.canonicalLlm = isRecord(parsed) && Object.hasOwn(parsed, "llm")
        ? normalizeLlm(parsed.llm, SETTINGS_DEFAULTS.llm)
        : undefined
      const tuiRaw = isRecord(parsed) && isRecord(parsed.tui) ? parsed.tui : undefined
      this.legacyProviders = isRecord(tuiRaw?.providers) ? tuiRaw.providers : undefined
      this.settings = normalizeSettings(parsed)
      this.revision = loadRevisionMeta(parsed)
    } catch {
      // ENOENT (first run) or a corrupt document: keep the defaults in memory.
      this.settings = normalizeSettings(undefined)
      this.canonicalLlm = undefined
      this.legacyProviders = undefined
      this.revision = {}
    }
    this.loaded = true
    return this.settings
  }

  /** Whether load() has run (used by callers that need a known state). */
  isLoaded(): boolean {
    return this.loaded
  }

  /**
   * Update one or more fields and persist. Fields not present in the partial
   * are left untouched; invalid values fall back to their defaults on the
   * NEXT load, but the write itself stores what it was given so a subsequent
   * normalize on read applies the fallback consistently.
   * @param patch - partial settings to apply.
   * @returns the merged in-memory settings (already normalized).
   */
  async set(patch: Partial<Settings>): Promise<Settings> {
    if ("llm" in patch) this.canonicalLlm = normalizeLlm(patch.llm, SETTINGS_DEFAULTS.llm)
    this.settings = normalizeSettings(this.rawWithPins(patch))
    // Section content written through the store advances that section's
    // counter: a concurrent mutant holding an older revision then fails its
    // expectedRevision guard ("mutated elsewhere" → 409 → reload/replay).
    if ("llm" in patch) this.revision.llm = (this.revision.llm ?? 0) + 1
    if ("onboarding" in patch) this.revision.onboarding = (this.revision.onboarding ?? 0) + 1
    if ("tui" in patch) this.revision.tui = (this.revision.tui ?? 0) + 1
    await this.persist()
    return this.settings
  }

  /**
   * Drop one row from the legacy `tui.providers` read-pin (the pre-canonical
   * provider plane). The pin is provenance-only — the canonical `llm` section
   * is untouched — and the read migration projects it into `llm.providers` on
   * every normalize, so this is the only way a legacy-only row can be removed
   * without it reappearing on the next reload. No-op when the id is absent
   * (or the document has no legacy section). An `activeProviderId` pointing
   * at the dropped row is unpinned too (it would otherwise keep the
   * default-model projection aimed at a row that no longer exists).
   */
  async dropLegacyTuiProvider(id: string): Promise<void> {
    const pin = this.legacyProviders
    const rows = pin !== undefined && isRecord(pin.providers) ? pin.providers : undefined
    if (rows === undefined || !Object.hasOwn(rows, id)) return
    const nextRows = { ...rows }
    delete nextRows[id]
    // The last row takes the whole pin with it (version/activeProviderId are
    // meaningless without rows).
    if (Object.keys(nextRows).length === 0) {
      this.legacyProviders = undefined
    } else {
      const nextPin: Record<string, unknown> = { ...pin, providers: nextRows }
      if (nextPin.activeProviderId === id) nextPin.activeProviderId = ""
      this.legacyProviders = nextPin
    }
    this.settings = normalizeSettings(this.rawWithPins())
    await this.persist()
  }

  /** Reset every field to its default and persist. */
  async reset(): Promise<Settings> {
    this.settings = normalizeSettings(undefined)
    this.canonicalLlm = normalizeLlm(undefined, SETTINGS_DEFAULTS.llm)
    this.legacyProviders = undefined
    // reset() rewrites every section to defaults — advance counters so a
    // client holding a pre-reset revision refetches instead of stale-mutating.
    this.revision.llm = (this.revision.llm ?? 0) + 1
    this.revision.onboarding = (this.revision.onboarding ?? 0) + 1
    this.revision.tui = (this.revision.tui ?? 0) + 1
    await this.persist()
    return this.settings
  }

  /** The raw document the normalizer sees: the current snapshot plus the
   * explicit canonical `llm` section and the pinned legacy `tui.providers`
   * provenance (the normalized OUTPUT never carries the legacy rows). */
  private rawWithPins(patch: Partial<Settings> = {}): Record<string, unknown> {
    const source: Record<string, unknown> = { ...this.settings, ...patch }
    if (this.canonicalLlm === undefined) delete source.llm
    else source.llm = this.canonicalLlm
    // Re-inject the pinned legacy section into the raw merge so the read
    // migration keeps projecting the legacy rows after this write (the file
    // keeps its own copy — the provider flow never writes through it).
    if (this.legacyProviders !== undefined) {
      source.tui = { ...(isRecord(source.tui) ? source.tui : {}), providers: this.legacyProviders }
    }
    return source
  }

  /** Write the current in-memory document atomically (tmp + rename). */
  private async persist(): Promise<void> {
    // Serialize concurrent saves so a slower first write never lands after a
    // newer one (rename ordering is otherwise racy under interleaving).
    if (this.saving !== null) {
      await this.saving
    }
    const write = (async () => {
      await mkdir(dirname(this.filename), { recursive: true })
      const tmp = `${this.filename}.tmp`
      // Additive meta key: only present once a section has been mutated.
      // RACE NOTE: two processes writing the same file (e.g. CLI web server +
      // another process sharing IH_CONFIG_DIR) can still lose a concurrent
      // increment — last rename wins. This is accepted: the section protocol
      // guards the single long-lived store instance (web server process);
      // cross-process writers already concede to the 跨 tab/pragmatism stance.
      const doc: Record<string, unknown> = this.rawWithPins()
      if (Object.keys(this.revision).length > 0) doc._revision = { ...this.revision }
      await writeFile(tmp, JSON.stringify(doc, null, 2), "utf8")
      await rename(tmp, this.filename)
    })()
    this.saving = write
    try {
      await write
    } finally {
      this.saving = null
    }
  }
}

/** Convenience one-shot: normalize + persist a patch with a fresh store. */
export async function updateSettings(
  options: SettingsStoreOptions,
  patch: Partial<Settings>,
): Promise<Settings> {
  const store = new SettingsStore(options)
  await store.load()
  return store.set(patch)
}
