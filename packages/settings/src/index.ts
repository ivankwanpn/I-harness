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
// Runtime import of the protocol constants (the enum's single source). Safe:
// sections.ts only ever imports TYPES from this module, so the runtime edge
// is one-directional (this module → sections.ts) — no evaluation-order cycle.
import { PROVIDER_PROTOCOLS } from "./sections.ts"
import type { SettingsProviderProtocol } from "./sections.ts"
import type { Telemetry } from "@i-harness/telemetry"
import { resolveHarnessHome } from "@i-harness/harness-home"

/** Sandbox mode: mirrors the @i-harness/sandbox union (kept local to stay
 * dependency-free — the settings package must not import sandbox). */
export type SettingsSandboxMode = "read-only" | "workspace-write" | "danger-full-access"

/** Completed-turn transcript presentation (dsh settings.transcript). Retained as
 * a vocabulary type after the `transcriptMode` key was retired: it is not one of
 * the retired names, and it still names the closed value set. */
export type SettingsTranscriptMode = "normal" | "compact"

/** Enter-while-busy behavior (dsh settings.busyEnter). Retained as a vocabulary
 * type alongside `transcriptMode` — see the note there. */
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
   * override in the unified resolution chain — and since M72 Ⅱ the FIRST
   * source of the request's output cap (spec §1.1), so NOT display-only: the
   * resolved value travels down the chain into the request, where core-agent
   * clamps it against the context window (`clampOutputCap` in llm-seam,
   * applied at `packages/core-agent/src/index.ts`) before it is sent. */
  maxTokens?: number
  /** The WIRE PROTOCOL for this model, overriding the route's. One endpoint can
   * serve different models on different protocols (the gateway case), and the
   * protocol is a property of the endpoint, so the route states the default and
   * a row states the exception. Absent → the route's. */
  protocol?: SettingsProviderProtocol
  /** M61: content types this MODEL accepts — the per-model override of the
   * route's declaration (see SettingsProviderConfig.inputModalities). */
  inputModalities?: SettingsInputModality[]
}

/** M61: a route's/model's accepted content types. The M14 negative-capability
 * rule is the default: ABSENT = text-only, and image parts are projected to a
 * deterministic text placeholder before the request leaves the adapter. Until
 * this field existed NOTHING in the product could set `inputModalities`, so
 * every provider — including the multimodal ones — was text-only and
 * `read_image` could never deliver a real picture to a model. */
export type SettingsInputModality = "text" | "image"

/** M72 Ⅱ: the two CHAT-completions spellings of the output cap. Which one a
 * route sends is a PER-ROUTE choice rather than a rule of the protocol:
 * `max_tokens` is the spelling compatible gateways take (why this adapter
 * exists), while the newest OpenAI models reject it as a legacy name and want
 * `max_completion_tokens`. A wrong name here is a 400, which is why it is
 * declared rather than probed. */
export type SettingsMaxTokensField = "max_tokens" | "max_completion_tokens"

const MAX_TOKENS_FIELDS: readonly SettingsMaxTokensField[] = ["max_tokens", "max_completion_tokens"]

const INPUT_MODALITIES: readonly SettingsInputModality[] = ["text", "image"]

/** Keep only the known modality names, in declaration order, deduped; an empty
 * or malformed value degrades to `undefined` (= text-only), never a throw. */
export function normalizeInputModalities(raw: unknown): SettingsInputModality[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: SettingsInputModality[] = []
  for (const entry of raw) {
    if (typeof entry !== "string") continue
    const value = entry as SettingsInputModality
    if (INPUT_MODALITIES.includes(value) && !out.includes(value)) out.push(value)
  }
  return out.length > 0 ? out : undefined
}

/** User override for one provider route (llm.providers.<route>): the API key
 * is NOT stored here — `apiKeyEnv` is a credential-ref name resolved by
 * packages/credentials (Task 2), so this document never holds key material. */
export interface SettingsProviderConfig {
  apiKeyEnv?: string
  /** The model-card FAMILY this route draws its per-model capability metadata
   * from (`model-catalog.json`'s top-level key — `deepseek`, `gemini`, …).
   *
   * The route NAME is the default, and that is deliberate: most routes are named
   * after their vendor, so the default is the status quo rather than a guess.
   * This field exists for the routes where it is not — the user's second route
   * for a vendor (`deepseek1`, opened to use a second API key) inherits nothing
   * from the name `deepseek`, and before this field it inherited nothing at all.
   *
   * It is declared, NOT derived from baseURL, because a derivation would be wrong
   * on precisely the set-ups the field exists for: gateways, proxies, regional
   * and subscription variants, and any vendor fronted by a custom host. A wrong
   * family is worse than no family — it supplies another vendor's numbers. */
  catalog?: string
  /** Host ROOT after normalize (a trailing /v1 is stripped — the adapters
   * assemble /v1/... themselves); see stripBaseURLSuffix. */
  baseURL?: string
  /** Models-endpoint override for provider discovery. */
  modelsURL?: string
  /** Display label overriding the route name for the UI row. */
  displayName?: string
  /** Wire protocol (D2). normalizeSettings keeps VALID values only: absent
   * stays absent and invalid raw degrades to absent (review r1 — a normalizing
   * default-fill would shadow the consumers' resolution chain; the resolved
   * protocol belongs there, never in the stored document). Per-route
   * resolution is resolveProviderProtocol (user > SEEDED_PROTOCOLS — the
   * seeded map is EMPTY after the amendment, and absence is where the chain
   * ends); the section API's mutate rejects unknown values fail-loud. */
  protocol?: SettingsProviderProtocol
  /** Model rows (objects since T1; string entries soft-upgrade at normalize). */
  models?: SettingsModel[]
  /** M59: literal extra request headers for this route (e.g. a gateway's
   * session/tenant header). Keys and values are non-empty strings; secrets
   * belong in `apiKeyEnv`, not here. */
  headers?: Record<string, string>
  /** M61: content types this ROUTE accepts — the fallback when the selected
   * model entry does not declare its own. Absent = text-only (M14). */
  inputModalities?: SettingsInputModality[]
  /** M72 Ⅱ: the wire field this ROUTE's openai-compatible requests carry the
   * output cap on. Absent = the adapter's own `max_tokens` default, which is
   * the compatible-gateway spelling; a route aimed at the newest OpenAI models
   * says `max_completion_tokens` here. Read by that one protocol — the other
   * wires each have a single fixed spelling. */
  maxTokensField?: SettingsMaxTokensField
  /** M72 Ⅲ: whether this route's `openai-compatible` requests ask the gateway
   * for usage (`stream_options.include_usage`). Absent = the adapter's own
   * default, which is ON — `false` is the per-route escape for a gateway that
   * rejects the KEY, and it sends nothing rather than `include_usage: false`.
   * A boolean, so `false` is a declaration and not an absence: the normalizer
   * keeps it only as a real boolean, and never fills a default here (the
   * resolved ask belongs to the adapter, not to the stored document). */
  usageInStream?: boolean
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

/** One role's model selection: the shape of `SettingsDefaultModel` plus the
 * protocol, because a role may name an endpoint as well as a model. `provider`
 * and `model` are required TOGETHER — a role that named only one would be
 * asking us to guess the other.
 *
 * NOT EXPORTED. Nothing outside this file ever NAMES it: Task 4's resolver and
 * Task 5's CLI both build object literals, which structural typing accepts. And
 * the reachability instrument counts `export interface` as a row — an export
 * whose consumer is three tasks away is what commit 8ec8fda0 removed. */
interface SettingsRoleModel {
  provider: string
  model: string
  protocol?: SettingsProviderProtocol
  reasoningEffort?: string
}

/** `agents.roles.<name>`: the model a sub-agent role runs on. An ABSENT role
 * inherits the parent's client — which is what every role did before this
 * section existed, and what an unconfigured harness still does.
 * Not exported; see SettingsRoleModel. */
interface SettingsAgents {
  roles: Record<string, SettingsRoleModel>
}

/** Canonical provider overrides + the default model. */
export interface SettingsLlm {
  providers: Record<string, SettingsProviderConfig>
  defaultModel: SettingsDefaultModel
}

/** M46b G1: the grok default word-separator set (text_selection.rs:
 * DEFAULT_WORD_SEPARATORS `!"#$%&'()*+,-./:;<=>?@[\]^`{|}~`). */
export const SETTINGS_DEFAULT_WORD_SEPARATORS = "!\"#$%&'()*+,-./:;<=>?@[\\]^`{|}~"

/** TUI UI-preference knobs (M46a modal categories — durable, host-honored).
 * M46b G1 appends the mouse knobs (grok's Mouse settings category): the
 * scroll-stream profile math, the selection-hold semantics and the opt-in
 * mouse-reporting toggle (Ctrl+R binding + /toggle-mouse-reporting). */
/** M49 Task 13 (spec §9.2): the configurable builtin status-line segments
 * (the order is the row's priority from left to right — the rightmost drop
 * first on a narrow row per spec §9.6). */
export const SETTINGS_STATUS_LINE_SEGMENTS = [
  "cwd", "branch", "model", "context", "turn-timer", "session", "queue", "tasks",
] as const
export type SettingsStatusLineSegment = (typeof SETTINGS_STATUS_LINE_SEGMENTS)[number]

/** M49 Task 13 (spec §8.3): dashboard order ids (tui.prefs.dashboard) — ids
 * ONLY; missing ids are ignored for display and deleted only after the next
 * successful commit. */
export interface SettingsTuiDashboardPrefs {
  order: string[]
}

/** M49 Task 13 (spec §9.2/§9.6): the status line preferences. */
export interface SettingsTuiStatusLinePrefs {
  mode: "disabled" | "builtin" | "command"
  /** The builtin segments rendered (gated ALSO by real-value availability —
   * an unknown value is omitted, never fabricated). Default: all. */
  items: SettingsStatusLineSegment[]
  /** The command-mode command (an opaque shell command — the host's exec
   * runner owns the actual interpretation). Present only for mode "command". */
  command?: string
  /** Command refresh interval; minimum 300ms (spec §9.6). Default 1000. */
  refreshMs?: number
}

export interface SettingsTuiPrefs {
  /** UI density compaction (the loop's layout compact mode). */
  compact: boolean
  /** Approval guardian: ON = tool asks go to the user (approveAll off). */
  guardian: boolean
  /** M49 Task 13 (spec §9.2): the local dashboard's order id list. */
  dashboard: SettingsTuiDashboardPrefs
  /** M49 Task 13 (spec §9.2): the status-line preferences. */
  statusLine: SettingsTuiStatusLinePrefs
}

/** The appended TUI section (M49 Task 6: presentation preferences only — the
 * provider plane is the canonical `llm.providers`; legacy `tui.providers`
 * documents are still READ as the deterministic in-memory migration). */
export interface SettingsTui {
  prefs: SettingsTuiPrefs
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
  fontSize: number
  /** M29: search-index ON-switch, not a persistence backend (JSONL is the sole
   *  authority). "jsonl" = index enabled (default); legacy "sqlite" value reads
   *  as enabled (compat); unknown value normalizes to "jsonl". */
  searchBackend: SettingsSearchBackend
  plugins: SettingsPluginToggles
  /** Agent-role configuration. A separate plane from `llm`: `llm` is the
   * provider plane, this is which of them a ROLE runs on. */
  agents: SettingsAgents
  /** Appended in this plan: previously-absent top-level key, additive-only. */
  llm: SettingsLlm
  onboarding: SettingsOnboarding
  /** Compaction engine switch. Distinct from `tui.prefs.compact`, which is UI
   *  density — this one governs whether context-pressure AUTO-compaction runs.
   *  Kept local like SettingsSandboxMode so the settings package stays
   *  dependency-free. A manual `/compact` is unaffected by `auto:false`. */
  compaction: SettingsCompaction
  /** Appended M46a G1: TUI UI-preference knobs (M49 Task 6 — the provider
   * registry is the canonical llm.providers plane; presentation only here). */
  tui: SettingsTui
}

export interface SettingsCompaction {
  /** false disables AUTO compaction ONLY. The engine is still constructed, so a
   *  manual `/compact` and the pressure gate's other layers keep working. */
  auto: boolean
}

// NOT exported (2026-09-18): nothing outside this module names it, and
// `normalizeSettings` is the public way to obtain the same values — which is
// what the three test files that used it as an oracle now do. The row this
// retires was blocked for months by a mis-stated reason; see the correction in
// docs/handoff/2026-09-17-remove-tui-and-web-frontends.md §3.
const SETTINGS_DEFAULTS: Settings = {
  sandboxMode: "workspace-write",
  // ON by default, matching the engine's own default (`deps.compact?.auto ?? true`)
  // and its designed ladder: layer 1 is pressure compaction at 80% of the window,
  // layers 2-3 are the pure reset and the fail-closed refusal. Shipping with this
  // unreachable meant layer 1 never ran and long sessions fell straight through to
  // `prompt_too_long`. Turning it OFF is the opt-out, not the other way round.
  compaction: { auto: true },
  // Amendment (seeded defaults removed): "" = UNset — no default model. Every
  // model now comes from the user section (llm.providers + llm.defaultModel)
  // or a per-session selection; the field is kept so an OLD file's written
  // value survives verbatim (no migration chain) while a fresh document has
  // no default anywhere.
  model: "",
  language: "zh",
  fontSize: 14,
  searchBackend: "jsonl",
  plugins: { agentLoop: true, bash: true, webSearch: false, subagentModel: false },
  agents: { roles: {} },
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
  // M46a G1 appended section (M49 Task 6: presentation prefs only — the
  // provider plane is llm.providers): compact off (the fullscreen default) and
  // guardian off (the embedded factory's approveAll:true default).
  tui: {
    prefs: {
      compact: false, guardian: false,
      // M49 Task 13 (spec §9.2): dashboard order empty; the builtin status line
      // with every configurable segment.
      dashboard: { order: [] },
      statusLine: { mode: "builtin", items: [...SETTINGS_STATUS_LINE_SEGMENTS] },
    },
  },
}

/** Bounds for font size (dsh font-size row: 13–16 px). */
export const FONT_SIZE_MIN = 13
export const FONT_SIZE_MAX = 16

const SANDBOX_MODES: readonly SettingsSandboxMode[] = ["read-only", "workspace-write", "danger-full-access"]
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

/** M72 Ⅱ: the closed pair (see SettingsMaxTokensField). Anything else — a
 * Responses spelling, a number, a typo — degrades to absent rather than
 * travelling to a wire that would reject the whole request. */
function isMaxTokensField(value: unknown): value is SettingsMaxTokensField {
  return typeof value === "string" && (MAX_TOKENS_FIELDS as readonly string[]).includes(value)
}

/** M49 Task 13: a string id list (non-empty strings, deduped — corrupt entries
 * dropped, non-array input degrades to []). */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === "string" && entry !== "" && !out.includes(entry)) out.push(entry)
  }
  return out
}

/** M49 Task 13: the status-segment allowlist — only valid segments survive;
 * a NON-array input (or an all-corrupt list) falls back to the full default
 * list (a corrupt file must not silently hide every segment). */
function statusLineItems(value: unknown): SettingsStatusLineSegment[] {
  if (!Array.isArray(value)) return [...SETTINGS_STATUS_LINE_SEGMENTS]
  const out: SettingsStatusLineSegment[] = []
  for (const entry of value) {
    if ((SETTINGS_STATUS_LINE_SEGMENTS as readonly string[]).includes(entry as string)) {
      out.push(entry as SettingsStatusLineSegment)
    }
  }
  return out.length > 0 ? out : [...SETTINGS_STATUS_LINE_SEGMENTS]
}

/** cc-switch rule (spec D3): a trailing `/v1` or `/v1/` is the client-facing
 * version segment — the adapters assemble `/v1/...` from the host ROOT
 * themselves, so the setting only ever stores the root. Strips only that ONE
 * segment: `https://x.com/api/v1` → `https://x.com/api`; `/anthropic`,
 * `/openai`, `/v2` and any other subpath never match. */
function stripBaseURLSuffix(baseURL: string): string {
  return baseURL.replace(/(?:^|\/)v1\/?$/, "")
}

function migrateLegacyProtocol(value: unknown): SettingsProviderProtocol | undefined {
  if (value === "openai-compatible") return "openai-completions"
  if (value === "anthropic") return "anthropic-messages"
  if (value === "openai-responses" || value === "gemini" || value === "bedrock") return value
  return undefined
}

function migrateLegacyTuiProviders(raw: unknown): {
  providers: Record<string, SettingsProviderConfig>
  activeProviderId: string
} {
  if (!isRecord(raw) || !isRecord(raw.providers)) return { providers: {}, activeProviderId: "" }
  const out: Record<string, SettingsProviderConfig> = {}
  for (const [id, value] of Object.entries(raw.providers)) {
    if (!isRecord(value) || typeof value.baseUrl !== "string" || value.baseUrl === "") continue
    const protocol = migrateLegacyProtocol(value.protocol)
    out[id] = {
      baseURL: stripBaseURLSuffix(value.baseUrl),
      ...(typeof value.name === "string" && value.name !== "" ? { displayName: value.name } : {}),
      ...(typeof value.apiKeyRef === "string" && value.apiKeyRef !== "" ? { apiKeyEnv: value.apiKeyRef } : {}),
      ...(typeof value.modelsUrl === "string" && value.modelsUrl !== "" ? { modelsURL: value.modelsUrl } : {}),
      ...(protocol !== undefined ? { protocol } : {}),
    }
  }
  return {
    providers: out,
    activeProviderId: typeof raw.activeProviderId === "string" ? raw.activeProviderId : "",
  }
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
      if (isProviderProtocol(entry.protocol)) model.protocol = entry.protocol
      const modalities = normalizeInputModalities(entry.inputModalities)
      if (modalities !== undefined) model.inputModalities = modalities
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
 * because the resolved protocol belongs to resolveProviderProtocol's chain
 * (user > SEEDED_PROTOCOLS({}) — the seeded map is empty after the
 * amendment, and the chain has no tail after it); filling here would shadow
 * the consumers' resolution and mis-dispatch the T2 probe / T4 build.
 * Fail-loud rejection of unknown values remains the section API's mutate
 * (the protocol enum FieldSpec). */
function normalizeProviderConfig(raw: unknown): SettingsProviderConfig | null {
  if (!isRecord(raw)) return null
  const out: SettingsProviderConfig = {}
  if (isNonEmptyString(raw.apiKeyEnv)) out.apiKeyEnv = raw.apiKeyEnv
  if (isNonEmptyString(raw.baseURL)) {
    const baseURL = stripBaseURLSuffix(raw.baseURL)
    if (baseURL !== "") out.baseURL = baseURL
  }
  if (isNonEmptyString(raw.modelsURL)) out.modelsURL = raw.modelsURL
  if (isNonEmptyString(raw.displayName)) out.displayName = raw.displayName
  if (isNonEmptyString(raw.catalog)) out.catalog = raw.catalog
  const models = normalizeModels(raw.models)
  if (models !== undefined) out.models = models
  const headers = normalizeProviderHeaders(raw.headers)
  if (headers !== undefined) out.headers = headers
  const modalities = normalizeInputModalities(raw.inputModalities)
  if (modalities !== undefined) out.inputModalities = modalities
  if (isMaxTokensField(raw.maxTokensField)) out.maxTokensField = raw.maxTokensField
  // M72 Ⅲ: a real boolean only. `false` IS the declaration (the route asking
  // us not to send the key), so this must not be a truthiness test, and absent
  // must stay absent — the ADAPTER's default decides, and a filled-in default
  // here would be a second place to be wrong.
  if (typeof raw.usageInStream === "boolean") out.usageInStream = raw.usageInStream
  if (isProviderProtocol(raw.protocol)) out.protocol = raw.protocol
  if (Object.keys(out).length === 0) return null
  return out
}

/** One role entry. Returns null for anything that is not a complete selection —
 * a half entry (`provider` without `model` or vice versa) is DROPPED, not
 * completed: completing it is the guess this design exists to avoid. */
function normalizeRoleModel(raw: unknown): SettingsRoleModel | null {
  if (!isRecord(raw)) return null
  if (!isNonEmptyString(raw.provider) || !isNonEmptyString(raw.model)) return null
  const out: SettingsRoleModel = { provider: raw.provider, model: raw.model }
  if (isProviderProtocol(raw.protocol)) out.protocol = raw.protocol
  if (isNonEmptyString(raw.reasoningEffort)) out.reasoningEffort = raw.reasoningEffort
  return out
}

function normalizeAgents(raw: unknown, base: SettingsAgents): SettingsAgents {
  if (!isRecord(raw)) return { roles: { ...base.roles } }
  const rolesRaw = isRecord(raw.roles) ? raw.roles : {}
  const roles: Record<string, SettingsRoleModel> = {}
  for (const [name, value] of Object.entries(rolesRaw)) {
    const entry = normalizeRoleModel(value)
    if (entry !== null) roles[name] = entry
  }
  return { roles }
}

/** M59: extra request headers — dynamic string keys, non-empty string values;
 * anything else degrades per entry (no throw, D5 no-migration). */
function normalizeProviderHeaders(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (name !== "" && isNonEmptyString(value)) out[name] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
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

function normalizeLlmWithLegacy(raw: unknown, legacyRaw: unknown, base: SettingsLlm): SettingsLlm {
  const canonical = normalizeLlm(raw, base)
  const legacy = migrateLegacyTuiProviders(legacyRaw)
  const providers: Record<string, SettingsProviderConfig> = { ...legacy.providers }
  for (const [id, config] of Object.entries(canonical.providers)) {
    providers[id] = { ...providers[id], ...config }
  }
  return {
    providers,
    defaultModel: {
      ...canonical.defaultModel,
      provider: canonical.defaultModel.provider !== ""
        ? canonical.defaultModel.provider
        : legacy.activeProviderId,
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

/** Appended TUI section (M49 Task 6): the presentation prefs only — the
 * legacy `providers` payload is no longer normalized (the canonical plane is
 * `llm.providers`; the store still passes the raw legacy section to the
 * read migration). Corrupt input degrades per pref.
 *
 * The projection names every key it reads, so a retired key left in an older
 * on-disk document is simply never read — the document still loads. */
function normalizeTui(raw: unknown, base: SettingsTui): SettingsTui {
  const prefsRaw = isRecord(raw) && isRecord(raw.prefs) ? raw.prefs : {}
  const b = base.prefs
  return {
    prefs: {
      compact: typeof prefsRaw.compact === "boolean" ? prefsRaw.compact : b.compact,
      guardian: typeof prefsRaw.guardian === "boolean" ? prefsRaw.guardian : b.guardian,
      // M49 Task 13 (spec §9.2): dashboard order + the status line — corrupt
      // input degrades per field (the run-time nullability of command/refreshMs
      // is preserved — an absent value means "host default 1000ms/1s", never a
      // fabricated one).
      dashboard: {
        order: stringList((isRecord(prefsRaw.dashboard) ? prefsRaw.dashboard : {}).order),
      },
      statusLine: (() => {
        const slRaw = isRecord(prefsRaw.statusLine) ? prefsRaw.statusLine : {}
        const mode = oneOf(slRaw.mode, ["disabled", "builtin", "command"] as const, b.statusLine.mode)
        const items = statusLineItems(slRaw.items)
        const command = typeof slRaw.command === "string" && slRaw.command !== "" ? slRaw.command : undefined
        const refreshMs = isPositiveInteger(slRaw.refreshMs) ? Math.max(300, slRaw.refreshMs) : undefined
        return { mode, items, ...(command !== undefined ? { command } : {}), ...(refreshMs !== undefined ? { refreshMs } : {}) }
      })(),
    },
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
  if (!isRecord(raw)) {
    return {
      ...base,
      plugins: { ...base.plugins },
      agents: normalizeAgents(undefined, base.agents),
      llm: normalizeLlm(undefined, base.llm),
      onboarding: { ...base.onboarding },
      compaction: { ...base.compaction },
      tui: normalizeTui(undefined, base.tui),
    }
  }
  const pluginsRaw = isRecord(raw.plugins) ? raw.plugins : {}
  const compactionRaw = isRecord(raw.compaction) ? raw.compaction : {}
  const tuiRaw = isRecord(raw.tui) ? raw.tui : {}
  return {
    sandboxMode: oneOf(raw.sandboxMode, SANDBOX_MODES, base.sandboxMode),
    model: typeof raw.model === "string" && raw.model !== "" ? raw.model : base.model,
    language: oneOf(raw.language, LANGUAGES, base.language),
    fontSize: numberInList(raw.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, base.fontSize),
    searchBackend: oneOf(raw.searchBackend, SEARCH_BACKENDS, base.searchBackend),
    compaction: { auto: booleanOf(compactionRaw.auto, base.compaction.auto) },
    plugins: {
      agentLoop: booleanOf(pluginsRaw.agentLoop, base.plugins.agentLoop),
      bash: booleanOf(pluginsRaw.bash, base.plugins.bash),
      webSearch: booleanOf(pluginsRaw.webSearch, base.plugins.webSearch),
      subagentModel: booleanOf(pluginsRaw.subagentModel, base.plugins.subagentModel),
    },
    agents: normalizeAgents(raw.agents, base.agents),
    // Transition read migration: legacy TUI providers fill missing canonical
    // fields in memory only; explicit llm values win and no file is rewritten.
    llm: normalizeLlmWithLegacy(raw.llm, tuiRaw.providers, base.llm),
    onboarding: normalizeOnboarding(raw.onboarding, base.onboarding),
    tui: normalizeTui(raw.tui, base.tui),
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
  const dir = resolveHarnessHome(options.configDir)
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
  /** M40 A6: host telemetry stream for the hot-reload change notification
   * (`settings/changed` — the manifest code is declared; this is its producer).
   * Per-change emits carry `data: { path }` (the changed file). Absent → the
   * store stays telemetry-free (existing behavior). */
  telemetry?: Telemetry
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
  /** Optional unprojected source for stores that expose migrated effective views. */
  getSectionMutationBase?(name: "llm" | "onboarding"): unknown
  /** Optional narrow legacy-plane mutation: drop one `tui.providers` row from
   * the read-pin (see SettingsStore.dropLegacyTuiProvider). */
  dropLegacyTuiProvider?(id: string): Promise<void>
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
   * analog at the store surface: `onChange`). M40 A6: the DETECTED CHANGE
   * (subsequent ticks only — the first tick snapshots, see watchSettings)
   * also emits `settings/changed` to the injected telemetry stream. W1: the
   * reload itself is conflated — see handleWatchedChange. */
  private ensureWatcher(): void {
    if (this.watcher !== undefined || this.options.watchIntervalMs === false) return
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
  const configDir = resolveHarnessHome(options.configDir)
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
 * stops polling. W1/A: captures never overlap (an in-flight tick is skipped),
 * so one write can no longer be reported twice by an out-of-order overwrite.
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
  // W1/A: one capture at a time. `capture()` awaits a stat per file, and
  // without this guard consecutive ticks run their captures concurrently — an
  // OLDER capture can then resolve after a newer one and overwrite `snapshot`
  // with its stale value, so the next tick sees the same change again and
  // fires a SECOND onChange for one write. A tick that finds a capture in
  // flight is SKIPPED, not queued: the next tick re-stats the current state,
  // so skipping costs at most one poll interval of latency and can never miss
  // a state that has settled. The initial snapshot holds the guard too —
  // otherwise a tick could start alongside it and be overwritten by it.
  let capturing = true

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

  void capture().then((snap) => {
    snapshot = snap
    capturing = false
  })
  timer = setInterval(() => {
    if (capturing) return // one capture in flight; the next tick re-reads
    capturing = true
    void capture().then((snap) => {
      capturing = false
      for (const [file, info] of snap) {
        if (snapshot.get(file) !== info) {
          // One batch per tick — and advance ONLY the marker of the file just
          // reported. Advancing the whole capture would record every other
          // changed file as seen while reporting one of them, so their changes
          // would be DROPPED rather than deferred (this snapshot is the only
          // place a change is ever detected). The next tick re-finds them and
          // reports the next one; the rest wait their turn.
          snapshot.set(file, info)
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
