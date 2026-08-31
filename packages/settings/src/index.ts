/**
 * Global user settings for I-harness (dsh §ui-settings parity surface).
 *
 * A single JSON document under the user's config home carries every setting;
 * the web host exposes it over `/api/settings` and the CLI applies it when
 * composing live agents (sandbox mode, model). Kept deliberately simple:
 * the dsh original uses YAML + cross-process writer locks + hot-publish
 * watchers — we only need durable, atomically-written JSON that the web
 * server reads at startup and the settings UI writes through.
 *
 * @module @i-harness/settings
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
// Runtime import of the protocol constants (the enum's single source). Safe:
// sections.ts only ever imports TYPES from this module, so the runtime edge
// is one-directional (this module → sections.ts) — no evaluation-order cycle.
import { PROVIDER_PROTOCOLS } from "./sections.ts"
import type { SettingsProviderProtocol } from "./sections.ts"

/** Sandbox mode: mirrors the @i-harness/sandbox union (kept local to stay
 * dependency-free — the settings package must not import sandbox). */
export type SettingsSandboxMode = "read-only" | "workspace-write" | "danger-full-access"

/** Theme preference: which color scheme to apply. `system` follows the OS. */
export type SettingsTheme = "light" | "dark" | "system"

/** Completed-turn transcript presentation (dsh settings.transcript). */
export type SettingsTranscriptMode = "normal" | "compact"

/** Enter-while-busy behavior (dsh settings.busyEnter). */
export type SettingsBusyEnter = "interrupt" | "wait"

/** Session-search backend (Task 1.2, 方案 A): the durable preference record
 * for the session-query search/lineage endpoints. `jsonl` (default) keeps the
 * frontend's search UI in the "not enabled" state; `sqlite` declares that the
 * server was started with the sqlite session backend (`--session-backend
 * sqlite` — the FTS5 precondition). The RUNTIME gate is the backend the server
 * actually started with: an sqlite document on a jsonl-run server still leaves
 * the endpoints answering "not enabled" (web.ts warns on the mismatch). */
export type SettingsSearchBackend = "jsonl" | "sqlite"

/** Language of the UI. v0 ships zh only — the field is durable and forward-compatible. */
export type SettingsLanguage = "zh"

export interface SettingsPluginToggles {
  agentLoop: boolean
  bash: boolean
  webSearch: boolean
  subagentModel: boolean
}

/** One configured model row (llm.providers.<route>.models[i]): `id` is the only
 * addressable key; the caps are optional UI/discovery hints. Old-format string
 * entries soft-upgrade to {id} at normalize (D5 — no migration chain). */
export interface SettingsModel {
  id: string
  name?: string
  /** Context window in tokens. */
  contextWindow?: number
  /** Maximum output tokens. */
  maxTokens?: number
}

/** User override for one provider route (llm.providers.<route>): the API key
 * is NOT stored here — `apiKeyEnv` is a credential-ref name resolved by
 * packages/credentials (Task 2), so this document never holds key material. */
export interface SettingsProviderConfig {
  apiKeyEnv?: string
  /** Host ROOT after normalize (a trailing /v1 is stripped — the adapters
   * assemble /v1/... themselves); see stripBaseURLSuffix. */
  baseURL?: string
  /** Display label overriding the route name for the UI row. */
  displayName?: string
  /** Wire protocol (D2). normalizeSettings keeps VALID values only: absent
   * stays absent and invalid raw degrades to absent (review r1 — a normalizing
   * default-fill would shadow the consumers' resolution chain; the per-route
   * default belongs there, never in the stored document). Per-route
   * resolution is resolveProviderProtocol (user > SEEDED_PROTOCOLS > DEFAULT
   * — the seeded map is EMPTY after the amendment); the section API's mutate
   * rejects unknown values fail-loud. */
  protocol?: SettingsProviderProtocol
  /** Model rows (objects since T1; string entries soft-upgrade at normalize). */
  models?: SettingsModel[]
}

/** The section-level default model (resolution chain in Task 5:
 * session.meta.modelSelection > llm.defaultModel > core.model > mock). The
 * DEFAULT is {provider:"",model:""} = unset (amendment: no seeded default);
 * an absent/invalid raw value normalizes back to that empty value at read
 * (old files that carry a value keep it — no migration chain). */
export interface SettingsDefaultModel {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Appended section (no migration): per-provider overrides + the default model. */
export interface SettingsLlm {
  providers: Record<string, SettingsProviderConfig>
  defaultModel: SettingsDefaultModel
}

/** Appended section (no migration): UI lifecycle acknowledgements. */
export interface SettingsOnboarding {
  welcomeNoticeVersion: string
}

/** The full, durable settings document. Every field has a default so an
 * absent field in a partial on-disk document falls back instead of breaking. */
export interface Settings {
  sandboxMode: SettingsSandboxMode
  model: string
  language: SettingsLanguage
  theme: SettingsTheme
  fontSize: number
  transcriptMode: SettingsTranscriptMode
  busyEnter: SettingsBusyEnter
  searchBackend: SettingsSearchBackend
  plugins: SettingsPluginToggles
  /** Appended in this plan: previously-absent top-level key, additive-only. */
  llm: SettingsLlm
  onboarding: SettingsOnboarding
}

export const SETTINGS_DEFAULTS: Settings = {
  sandboxMode: "workspace-write",
  // Amendment (seeded defaults removed): "" = UNset — no default model. Every
  // model now comes from the user section (llm.providers + llm.defaultModel)
  // or a per-session selection; the field is kept so an OLD file's written
  // value survives verbatim (no migration chain) while a fresh document has
  // no default anywhere.
  model: "",
  language: "zh",
  theme: "system",
  fontSize: 14,
  transcriptMode: "normal",
  busyEnter: "interrupt",
  searchBackend: "jsonl",
  plugins: { agentLoop: true, bash: true, webSearch: false, subagentModel: false },
  // Appended sections: fresh documents default here without any migration path
  // (old files without these keys load with these values — D5/no-migration).
  llm: {
    providers: {},
    // Amendment: the section default is EMPTY ("" = unset) — no seeded model
    // is filled anywhere; the resolve chain (web.ts) treats the seed-equal
    // value as "never user-set" and falls through to core.model / mock.
    defaultModel: { provider: "", model: "" },
  },
  // "" = no welcome notice acknowledged; the frontend shows the notice while
  // welcomeNoticeVersion !== "2026-08-30.1" (Task 9) — the empty default keeps
  // the first-run notice visible, while a plain old document stays unset.
  onboarding: { welcomeNoticeVersion: "" },
}

/** Bounds for font size (dsh font-size row: 13–16 px). */
export const FONT_SIZE_MIN = 13
export const FONT_SIZE_MAX = 16

const SANDBOX_MODES: readonly SettingsSandboxMode[] = ["read-only", "workspace-write", "danger-full-access"]
const THEMES: readonly SettingsTheme[] = ["light", "dark", "system"]
const TRANSCRIPT_MODES: readonly SettingsTranscriptMode[] = ["normal", "compact"]
const BUSY_ENTERS: readonly SettingsBusyEnter[] = ["interrupt", "wait"]
const SEARCH_BACKENDS: readonly SettingsSearchBackend[] = ["jsonl", "sqlite"]
const LANGUAGES: readonly SettingsLanguage[] = ["zh"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function booleanOf(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function numberInList(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== ""
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isProviderProtocol(value: unknown): value is SettingsProviderProtocol {
  return typeof value === "string" && (PROVIDER_PROTOCOLS as readonly string[]).includes(value)
}

/** cc-switch rule (spec D3): a trailing `/v1` or `/v1/` is the client-facing
 * version segment — the adapters assemble `/v1/...` from the host ROOT
 * themselves, so the setting only ever stores the root. Strips only that ONE
 * segment: `https://x.com/api/v1` → `https://x.com/api`; `/anthropic`,
 * `/openai`, `/v2` and any other subpath never match. */
function stripBaseURLSuffix(baseURL: string): string {
  return baseURL.replace(/(?:^|\/)v1\/?$/, "")
}

/** Model rows: old-format strings soft-upgrade to `{id}` (D5, no migration
 * path); object entries keep their addressable `id` plus the optional validated
 * caps; entries without a non-empty string id are dropped. */
function normalizeModels(raw: unknown): SettingsModel[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const models: SettingsModel[] = []
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry === "") continue
      models.push({ id: entry })
    } else if (isRecord(entry)) {
      const id = isNonEmptyString(entry.id) ? entry.id : undefined
      if (id === undefined) continue
      const model: SettingsModel = { id }
      if (isNonEmptyString(entry.name)) model.name = entry.name
      if (isPositiveInteger(entry.contextWindow)) model.contextWindow = entry.contextWindow
      if (isPositiveInteger(entry.maxTokens)) model.maxTokens = entry.maxTokens
      models.push(model)
    }
  }
  return models.length > 0 ? models : undefined
}

/** Validate a single provider-route user override; unknown/typed-wrong keys
 * are dropped, an entry with no recognizable field is discarded entirely.
 * A VALID protocol counts as a recognizable field; an invalid one is junk
 * (it never rescues a route either).
 * TWO-TIER protocol stance (review r1): at READ a valid raw value is kept,
 * an absent/invalid raw value stays ABSENT — normalize never fills a default,
 * because the per-route default belongs to resolveProviderProtocol's chain
 * (user > SEEDED_PROTOCOLS({}) > DEFAULT — the seeded map is empty after the
 * amendment); filling here would shadow the consumers' resolution and
 * mis-dispatch the T2 probe / T4 build. Fail-loud rejection of unknown
 * values remains the section API's mutate (the protocol enum FieldSpec). */
function normalizeProviderConfig(raw: unknown): SettingsProviderConfig | null {
  if (!isRecord(raw)) return null
  const out: SettingsProviderConfig = {}
  if (isNonEmptyString(raw.apiKeyEnv)) out.apiKeyEnv = raw.apiKeyEnv
  if (isNonEmptyString(raw.baseURL)) {
    const baseURL = stripBaseURLSuffix(raw.baseURL)
    if (baseURL !== "") out.baseURL = baseURL
  }
  if (isNonEmptyString(raw.displayName)) out.displayName = raw.displayName
  const models = normalizeModels(raw.models)
  if (models !== undefined) out.models = models
  if (isProviderProtocol(raw.protocol)) out.protocol = raw.protocol
  if (Object.keys(out).length === 0) return null
  return out
}

/** Appended llm section defaulting: partial/corrupt input degrades per field,
 * custom routes are kept as-is, unknown route fields are dropped. */
function normalizeLlm(raw: unknown, base: SettingsLlm): SettingsLlm {
  if (!isRecord(raw)) return { providers: {}, defaultModel: { ...base.defaultModel } }
  const providers: Record<string, SettingsProviderConfig> = {}
  if (isRecord(raw.providers)) {
    for (const [route, cfg] of Object.entries(raw.providers)) {
      const normalized = normalizeProviderConfig(cfg)
      if (normalized !== null) providers[route] = normalized
    }
  }
  const dm = isRecord(raw.defaultModel) ? raw.defaultModel : {}
  return {
    providers,
    defaultModel: {
      provider: isNonEmptyString(dm.provider) ? dm.provider : base.defaultModel.provider,
      model: isNonEmptyString(dm.model) ? dm.model : base.defaultModel.model,
      // string passthrough (forward-compatible with future effort levels);
      // mutateSection validates the closed enum in the section API
      ...(typeof dm.reasoningEffort === "string" ? { reasoningEffort: dm.reasoningEffort } : {}),
    },
  }
}

/** Appended onboarding section: a string field, corrupt input degrades to default. */
function normalizeOnboarding(raw: unknown, base: SettingsOnboarding): SettingsOnboarding {
  if (!isRecord(raw)) return { ...base }
  return {
    welcomeNoticeVersion: typeof raw.welcomeNoticeVersion === "string"
      ? raw.welcomeNoticeVersion
      : base.welcomeNoticeVersion,
  }
}

/**
 * Merge a possibly-partial/unknown on-disk document onto the defaults so a
 * corrupt or older file degrades to sane values instead of throwing.
 * @param raw - the parsed on-disk value (may be anything).
 * @returns a fully-populated Settings object.
 */
export function normalizeSettings(raw: unknown): Settings {
  const base = SETTINGS_DEFAULTS
  if (!isRecord(raw)) return { ...base, plugins: { ...base.plugins }, llm: normalizeLlm(undefined, base.llm), onboarding: { ...base.onboarding } }
  const pluginsRaw = isRecord(raw.plugins) ? raw.plugins : {}
  return {
    sandboxMode: oneOf(raw.sandboxMode, SANDBOX_MODES, base.sandboxMode),
    model: typeof raw.model === "string" && raw.model !== "" ? raw.model : base.model,
    language: oneOf(raw.language, LANGUAGES, base.language),
    theme: oneOf(raw.theme, THEMES, base.theme),
    fontSize: numberInList(raw.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, base.fontSize),
    transcriptMode: oneOf(raw.transcriptMode, TRANSCRIPT_MODES, base.transcriptMode),
    busyEnter: oneOf(raw.busyEnter, BUSY_ENTERS, base.busyEnter),
    searchBackend: oneOf(raw.searchBackend, SEARCH_BACKENDS, base.searchBackend),
    plugins: {
      agentLoop: booleanOf(pluginsRaw.agentLoop, base.plugins.agentLoop),
      bash: booleanOf(pluginsRaw.bash, base.plugins.bash),
      webSearch: booleanOf(pluginsRaw.webSearch, base.plugins.webSearch),
      subagentModel: booleanOf(pluginsRaw.subagentModel, base.plugins.subagentModel),
    },
    // Appended sections (D5, no migration): absent keys get the defaults above
    // and the original top-level keys are never rewritten.
    llm: normalizeLlm(raw.llm, base.llm),
    onboarding: normalizeOnboarding(raw.onboarding, base.onboarding),
  }
}

export interface SettingsStoreOptions {
  /** Document path; defaults to `<configDir>/settings.json` (see defaultSettingsPath). */
  path?: string
  /** Config home used when `path` is omitted; defaults to `$IH_CONFIG_DIR` or `~/.i-harness`. */
  configDir?: string
}

/**
 * Resolve the settings document path: an explicit `path` wins, otherwise it
 * lives under the config home (`$IH_CONFIG_DIR` or `~/.i-harness`), which is
 * GLOBAL (not workspace-scoped) — matching dsh's `<harness home>/settings.yaml`.
 * @param options - user-specified path or config dir.
 * @returns the fully resolved absolute document path.
 */
export function resolveSettingsPath(options: SettingsStoreOptions = {}): string {
  if (options.path !== undefined) return resolve(options.path)
  const dir = options.configDir ?? process.env.IH_CONFIG_DIR ?? join(homedir(), ".i-harness")
  return join(dir, "settings.json")
}

/** Per-section revision counters persisted as the additive `_revision` top-level
 * meta key (section-mutate protocol, Task 1 of the models plan). Old readers
 * only read the nine original keys, so the meta key is harmless to them, and
 * normalizeSettings never surfaces it in its output. */
function loadRevisionMeta(raw: unknown): Record<string, number> {
  if (!isRecord(raw) || !isRecord(raw._revision)) return {}
  const out: Record<string, number> = {}
  for (const [name, value] of Object.entries(raw._revision)) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) out[name] = value
  }
  return out
}

/** A single atomic JSON-file settings store. */
export class SettingsStore {
  private readonly filename: string
  private settings: Settings
  private loaded = false
  private saving: Promise<void> | null = null
  /** Per-section mutation counters (see loadRevisionMeta). */
  private revision: Record<string, number> = {}

  constructor(options: SettingsStoreOptions = {}) {
    this.filename = resolveSettingsPath(options)
    this.settings = normalizeSettings(undefined)
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

  /**
   * Load the document from disk, merging onto defaults. Missing/corrupt files
   * are not fatal — they yield the defaults so a first run behaves sanely.
   */
  async load(): Promise<Settings> {
    try {
      const raw = await readFile(this.filename, "utf8")
      const parsed = JSON.parse(raw)
      this.settings = normalizeSettings(parsed)
      this.revision = loadRevisionMeta(parsed)
    } catch {
      // ENOENT (first run) or a corrupt document: keep the defaults in memory.
      this.settings = normalizeSettings(undefined)
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
    this.settings = normalizeSettings({ ...this.settings, ...patch })
    // Section content written through the store advances that section's
    // counter: a concurrent mutant holding an older revision then fails its
    // expectedRevision guard ("mutated elsewhere" → 409 → reload/replay).
    if ("llm" in patch) this.revision.llm = (this.revision.llm ?? 0) + 1
    if ("onboarding" in patch) this.revision.onboarding = (this.revision.onboarding ?? 0) + 1
    await this.persist()
    return this.settings
  }

  /** Reset every field to its default and persist. */
  async reset(): Promise<Settings> {
    this.settings = normalizeSettings(undefined)
    // reset() rewrites every section to defaults — advance counters so a
    // client holding a pre-reset revision refetches instead of stale-mutating.
    this.revision.llm = (this.revision.llm ?? 0) + 1
    this.revision.onboarding = (this.revision.onboarding ?? 0) + 1
    await this.persist()
    return this.settings
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
      const doc: Record<string, unknown> = { ...this.settings }
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

// Section descriptor API (Task 1 of the models plan): schemas, redacted
// describe views, validated mutate ops and the revision-guard errors. Built on
// this package's store — the section module itself stays dependency-free.
export * from "./sections.ts"
