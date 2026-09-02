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

import { existsSync } from "node:fs"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
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

/** Session search-backend preference (M29 語意降級——search index switch):
 * record-derived only. M29 removed the sqlite persistence backend; the search
 * surface is the file-backed derived index, now ENABLED by default from any
 * jsonl store root. The field keeps its old vocabulary for on-disk
 * compatibility: `"jsonl"` (default) / the legacy `"sqlite"` value both read
 * as "index enabled" (same runtime semantics — the search surface no longer
 * depends on any backend string; the value is informational). */
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
  /** Maximum OUTPUT tokens — the model's output-length cap (M32 T1/FIX: same
   * semantics as the provider catalog's `maxOutputTokens` card field; the M31
   * G1 mapping of this value onto `maxContextWindow` is removed). A per-model
   * override in the unified resolution chain; never a request default. */
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
  /** M29: search-index ON-switch, not a persistence backend (JSONL is the sole
   *  authority). "jsonl" = index enabled (default); legacy "sqlite" value reads
   *  as enabled (compat); unknown value normalizes to "jsonl". */
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
      // string passthrough (mutateSection validates the closed enum in the
      // section API). M32: legacy "none" maps to the unified "off".
      ...(typeof dm.reasoningEffort === "string"
        ? { reasoningEffort: dm.reasoningEffort === "none" ? "off" : dm.reasoningEffort }
        : {}),
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

// ── M27 R-E10: layered sources (global < workspace < project, last wins) ─────
// Additive only: SettingsStore / normalizeSettings / resolveSettingsPath keep
// their exact behavior; layering is a NEW family of helpers + a store variant
// built on the same normalize layer.

/** One resolved settings source, lowest → highest priority. */
export interface LayerSource {
  /** Path on disk (null = the source does not exist yet). */
  path: string | null
  /** 0 = lowest, 2 = highest (3+ for extra configured files). */
  order: number
  label: "global" | "workspace" | "project" | "file"
  /** Raw parsed document (comment-stripped), when the source exists. */
  raws?: Record<string, unknown>
}

/** Layered roots: explicit paths, or "auto" (resolved by the store against its
 * configDir/workspace/cwd — see createLayeredStore). */
export interface LayeredRoots {
  global?: string | "auto"
  workspace?: string | "auto"
  project?: string | "auto"
}

const SOURCE_ORDER: Record<string, number> = { global: 0, workspace: 1, project: 2 }

/**
 * Resolve ordered sources from explicit roots (missing files are dropped —
 * a layer without a file contributes nothing). Order: global < workspace <
 * project (project wins).
 */
export function resolveLayeredSources(roots: LayeredRoots): LayerSource[] {
  const sources: LayerSource[] = []
  for (const label of ["global", "workspace", "project"] as const) {
    const configured = roots[label]
    if (configured === undefined) continue
    const path = resolve(configured)
    if (!existsSync(path)) continue // a layer without a file contributes nothing
    sources.push({ path, order: SOURCE_ORDER[label]!, label })
  }
  return sources
}

/** One raw doc contribution to a layer merge (the minimal shape). */
export interface LayerRaw {
  raws?: unknown
}

/** Deep-merge raw layer documents low → high: plain objects merge per key,
 * arrays/scalars are replaced (last wins). The merged RAW is normalized ONCE. */
export function mergeRawLayers(layers: readonly (LayerSource | LayerRaw)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    if (!isRecord(layer.raws)) continue
    for (const [key, value] of Object.entries(layer.raws)) {
      out[key] = isRecord(out[key]) && isRecord(value)
        ? mergeRawLayers([{ raws: out[key] }, { raws: value }])
        : value
    }
  }
  return out
}

/** Fail-closed leaf-patch error: a document the patchter cannot rewrite
 * safely stays untouched (the caller surfaces it; nothing is destroyed). */
export class SettingsPatchError extends Error {
  readonly code = "settings-leaf-patch" as const
  constructor(message: string) {
    super(`[settings-leaf-patch] ${message}`)
    this.name = "SettingsPatchError"
  }
}

const COMMENT_LINE = /^\s*(\/\/|#|\/\*|\*|\*\/)/
const BLOCK_START = /^\s*\/\*/
const BLOCK_END = /\*\//

interface AnchoredLine {
  text: string
  /** index of the next structural line (raw's structural index) */
  anchor: number
}

/** Split raw text into structural lines (strippable JSON) + comment/blank
 * lines anchored to the next structural line. Full-line comments only (an
 * inline comment inside a value string is indistinguishable — fail-closed
 * rather than corrupt). */
function splitRawLines(raw: string): { structural: string[]; extras: AnchoredLine[] } {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n")
  const structural: string[] = []
  const extras: AnchoredLine[] = []
  let inBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (inBlock) {
      extras.push({ text: line, anchor: structural.length })
      if (BLOCK_END.test(trimmed)) inBlock = false
      continue
    }
    if (BLOCK_START.test(trimmed)) {
      extras.push({ text: line, anchor: structural.length })
      if (!(BLOCK_END.test(trimmed.slice(trimmed.indexOf("/*") + 2)))) inBlock = true
      continue
    }
    if (COMMENT_LINE.test(trimmed) || trimmed === "") {
      extras.push({ text: line, anchor: structural.length })
      continue
    }
    structural.push(line)
  }
  return { structural, extras }
}

/** Comment-tolerant parse for READ paths (a hand-edited comment-bearing
 * document still loads); throws when even the stripped text is invalid. */
function parseDocumentTolerant(raw: string): Record<string, unknown> {
  const { structural } = splitRawLines(raw)
  const parsed = JSON.parse(structural.join("\n")) as unknown
  if (!isRecord(parsed)) throw new Error("settings document is not an object")
  return parsed
}

/**
 * Comment/blank-line-preserving JSON patch. The raw document is parsed after
 * stripping FULL-LINE comments (`//`, `#`, `/* … *​/`, `*`) and blank lines; the
 * patch deep-merges into it; the result is re-serialized with every comment
 * line re-anchored to its positional line (identical structural layout = the
 * file this package writes; a REORGANIZED document degrades to preserving the
 * leading/trailing blocks — still no data loss, and a fault unsafe to fix
 * throws SettingsPatchError BEFORE writing).
 */
export function patchJsonDocumentKeepingComments(raw: string, patch: Record<string, unknown>): string {
  const { structural, extras } = splitRawLines(raw)
  // Fail-closed: a document that does not parse even comment-stripped is left
  // untouched (the caller surfaces; the file is never destroyed).
  const baseDoc = parseDocumentTolerant(raw)
  const merged = mergeRawLayers([{ raws: baseDoc }, { raws: patch }])
  const oldLines = JSON.stringify(baseDoc, null, 2).split("\n")
  const newLines = JSON.stringify(merged, null, 2).split("\n")

  // Canonical alignment: raw structural lines must be exactly the canonical
  // re-serialization of the parsed doc (the formatter this package writes).
  const canonical = structural.length === oldLines.length
    && structural.every((line, i) => line === oldLines[i])
  if (!canonical) {
    // Degraded preservation: leading + trailing comment blocks only; interior
    // extras relocate to the end (they never delete user data, and a compact
    // document is being normalized to the canonical layout).
    const leading = extras.filter((e) => e.anchor === 0)
    const trailing = extras.filter((e) => e.anchor === structural.length)
    return [
      ...leading.map((e) => e.text),
      ...newLines,
      ...trailing.map((e) => e.text),
    ].join("\n")
  }

  // Positional re-anchoring: key order is preserved through
  // parse→patch→stringify, so structural index k maps to the same logical
  // line when the line counts match; extras are re-emitted before it.
  if (newLines.length === oldLines.length) {
    const out: string[] = []
    for (let k = 0; k < newLines.length; k += 1) {
      for (const extra of extras) if (extra.anchor === k && !out.includes(extra.text)) out.push(extra.text)
      out.push(newLines[k])
    }
    for (const extra of extras) if (extra.anchor === structural.length && !out.includes(extra.text)) out.push(extra.text)
    return out.join("\n")
  }

  // Counts differ (a leaf set/unset changed the line count): keep the leading
  // block, the extras anchored to lines that survived verbatim, then every
  // remaining extra followed by the trailing block — deterministic, no loss.
  const out: string[] = []
  const placed = new Set<string>()
  for (const extra of extras) if (extra.anchor === 0) { out.push(extra.text); placed.add(extra.text) }
  for (const line of newLines) {
    const oldIdx = oldLines.indexOf(line)
    if (oldIdx !== -1) {
      for (const extra of extras) {
        if (extra.anchor === oldIdx && !placed.has(extra.text)) { out.push(extra.text); placed.add(extra.text) }
      }
    }
    out.push(line)
  }
  for (const extra of extras) if (!placed.has(extra.text)) out.push(extra.text)
  return out.join("\n")
}

export interface LayeredStoreOptions {
  /** Explicit ordered file list (LOW → HIGH priority). Takes precedence over
   * `roots` when both are given. */
  files?: string[]
  /** Conventional roots; each is either an explicit path or "auto" (resolved
   * by the store: global = configDir/settings.json, workspace =
   * <workspace>/.i-harness/settings.json, project = <cwd>/settings.json). */
  roots?: LayeredRoots
  /** Config home for the global root default; defaults to `$IH_CONFIG_DIR` or
   * `~/.i-harness` (same chain as resolveSettingsPath). */
  configDir?: string
  /** Workspace root for the workspace layer default (absent → process.cwd()). */
  workspace?: string
  /** Polling interval for the internal hot-reload watcher (default 500ms).
   * `false` disables it. */
  watchIntervalMs?: number | false
}

/** The structural surface the section protocol needs from a settings store
 * (SettingsStore and LayeredSettingsStore both satisfy it). */
export interface SettingsStoreSurface {
  get(): Settings
  isLoaded(): boolean
  load(): Promise<Settings>
  set(patch: Partial<Settings>): Promise<Settings>
  reset(): Promise<Settings>
  getSectionRevision(name: string): number
}

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

  constructor(options: LayeredStoreOptions = {}) {
    this.options = options
    this.resolvedRoots = resolveLayeredDefaults(options)
  }

  get(): Settings { return this.current }

  isLoaded(): boolean { return this.loaded }

  async load(): Promise<Settings> {
    this.rawsByPath.clear()
    for (const source of this.resolvedRoots) {
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
    this.current = normalizeSettings(mergeRawLayers([...this.resolvedRoots]))
    this.loaded = true
    this.ensureWatcher()
    return this.current
  }

  async set(patch: Partial<Settings>): Promise<Settings> {
    if (!this.loaded) await this.load()
    this.current = normalizeSettings(mergeRawLayers([...this.resolvedRoots, { raws: patch }]))
    if ("llm" in patch) this.revision.llm = (this.revision.llm ?? 0) + 1
    if ("onboarding" in patch) this.revision.onboarding = (this.revision.onboarding ?? 0) + 1
    await this.writeMaster(patch, { ...this.revision })
    return this.current
  }

  async reset(): Promise<Settings> {
    if (!this.loaded) await this.load()
    this.current = normalizeSettings(undefined)
    this.revision.llm = (this.revision.llm ?? 0) + 1
    this.revision.onboarding = (this.revision.onboarding ?? 0) + 1
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
  }

  /** Polling watcher (500ms default — no fs events, no chokidar): when a
   * source's mtime/size changed, reload merged view + notify (settings/changed
   * analog at the store surface: `onChange`). */
  private ensureWatcher(): void {
    if (this.watcher !== undefined || this.options.watchIntervalMs === false) return
    const intervalMs = this.options.watchIntervalMs ?? 500
    const paths = this.resolvedRoots
      .map((s) => s.path)
      .filter((p): p is string => p !== null && p !== undefined)
    if (paths.length === 0) return
    this.watcher = watchSettings(paths, (path) => {
      void this.reloadFromDisk().then((settings) => {
        if (JSON.stringify(settings) !== JSON.stringify(this.current)) {
          this.current = settings
          for (const cb of [...this.listeners]) cb(path)
        }
      }).catch(() => {})
    }, { intervalMs })
  }
}

/** Convenience factory for the layered store. */
export function createLayeredStore(options: LayeredStoreOptions = {}): LayeredSettingsStore {
  return new LayeredSettingsStore(options)
}

/** Resolve the layered roots with the store-level defaults: global =
 * `<configDir>/settings.json` (config home, same chain as resolveSettingsPath);
 * workspace = `<workspace>/.i-harness/settings.json`; project =
 * `<cwd>/settings.json`. */
function resolveLayeredDefaults(options: LayeredStoreOptions): LayerSource[] {
  if (options.files !== undefined) {
    return options.files.map((file, i) => ({ path: resolve(file), order: i, label: "file" as const }))
  }
  const roots = options.roots ?? {}
  const sources: LayerSource[] = []
  const configDir = options.configDir ?? process.env.IH_CONFIG_DIR ?? join(homedir(), ".i-harness")
  const workspaceRoot = options.workspace ?? process.cwd()
  if (roots.global !== undefined) {
    const path = roots.global === "auto" ? join(configDir, "settings.json") : resolve(roots.global)
    sources.push({ path, order: 0, label: "global" })
  }
  if (roots.workspace !== undefined) {
    const path = roots.workspace === "auto" ? join(workspaceRoot, ".i-harness", "settings.json") : resolve(roots.workspace)
    sources.push({ path, order: 1, label: "workspace" })
  }
  if (roots.project !== undefined) {
    const path = roots.project === "auto" ? join(process.cwd(), "settings.json") : resolve(roots.project)
    sources.push({ path, order: 2, label: "project" })
  }
  return sources
}

/**
 * Polling settings watcher (no new deps — no chokidar). `intervalMs` defaults
 * to 500. The FIRST tick only snapshots (a pre-existing state never fires);
 * a change fires the callback with the changed path. Returns a dispose() that
 * stops polling.
 */
export function watchSettings(
  paths: string | string[],
  onChange: (path: string) => void,
  opts?: { intervalMs?: number },
): { dispose: () => void } {
  const files = Array.isArray(paths) ? paths : [paths]
  const intervalMs = opts?.intervalMs ?? 500
  let snapshot = new Map<string, string>()
  let timer: ReturnType<typeof setInterval> | undefined

  const capture = async (): Promise<Map<string, string>> => {
    const snap = new Map<string, string>()
    for (const file of files) {
      const info = await stat(file).then(
        (s) => `${s.mtimeMs}:${s.size}`,
        () => "", // missing → empty marker (reappearance fires)
      )
      snap.set(file, info)
    }
    return snap
  }

  void capture().then((snap) => { snapshot = snap })
  timer = setInterval(() => {
    void capture().then((snap) => {
      for (const [file, info] of snap) {
        if (snapshot.get(file) !== info) {
          snapshot = snap
          onChange(file)
          return // one batch per tick
        }
      }
      snapshot = snap
    })
  }, intervalMs)
  // A hot-reload poll must never keep the process alive (tests / short hosts).
  timer.unref?.()

  return {
    dispose: () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}

// Section descriptor API (Task 1 of the models plan): schemas, redacted
// describe views, validated mutate ops and the revision-guard errors. Built on
// this package's store — the section module itself stays dependency-free.
export * from "./sections.ts"
