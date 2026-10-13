import type { SettingsProviderProtocol } from "../sections.ts"
import type { SettingsContextSubsystems } from "../context-subsystems.ts"

/** Sandbox mode: mirrors the @i-harness/sandbox union (kept local to stay
 * dependency-free — the settings package must not import sandbox). */
export type SettingsSandboxMode = "read-only" | "workspace-write" | "danger-full-access"

export type SettingsWindowsSandboxBackend = "legacy" | "psec" | "wsl"

export type SettingsWebSearchMode = "disabled" | "cached" | "indexed" | "live"

export interface SettingsWslExecution {
  distribution: string
  networkAccess: boolean
  workspaceDependencies: boolean
}

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

export const AGENT_SHELL_CHOICES = ["auto", "git-bash", "pwsh", "powershell", "cmd", "bash", "zsh", "sh"] as const

export type SettingsAgentShell = typeof AGENT_SHELL_CHOICES[number]

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
  /** Content types this MODEL accepts. A historical provider declaration is
   * used only as a compatibility default for listed models. */
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

/** User override for one provider route (llm.providers.<route>): the API key
 * is NOT stored here — `apiKeyEnv` is a credential-ref name resolved by
 * packages/credentials (Task 2), so this document never holds key material. */
export interface SettingsProviderConfig {
  apiKeyEnv?: string
  /** Opaque account reference owned by Coding Plans; never an access token. */
  oauthAccountId?: string
  oauthProvider?: "openai-codex"
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
  /** Legacy M61 route-level input type. New Desktop writes use model rows only;
   * keep this readable so existing settings retain their listed models' image
   * capability until each model is configured explicitly. */
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
  /** Opt-in explicit cache metadata for this route. Absence keeps existing
   * payloads. Retention is an Anthropic marker TTL; Responses uses affinity
   * only because its retention policies have different durations. */
  promptCache?: { mode: "off" | "automatic"; retention?: "5m" | "1h" }
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
 * Package-private vocabulary shared with the provider normalizer; the public
 * entry does not export it. Task 4's resolver and Task 5's CLI build object
 * literals, which structural typing accepts. The public export was removed in
 * commit 8ec8fda0 because nothing outside settings names it. */
export interface SettingsRoleModel {
  provider: string
  model: string
  protocol?: SettingsProviderProtocol
  reasoningEffort?: string
}

/** `agents.roles.<name>`: the model a sub-agent role runs on. An ABSENT role
 * inherits the parent's client — which is what every role did before this
 * section existed, and what an unconfigured harness still does.
 * Package-private; see SettingsRoleModel. */
export interface SettingsAgents {
  roles: Record<string, SettingsRoleModel>
}

/** Canonical provider overrides + the default model. */
export interface SettingsLlm {
  providers: Record<string, SettingsProviderConfig>
  defaultModel: SettingsDefaultModel
  /** Explicit secondary Chat audio model used by read_video. */
  videoAudio?: { provider: string; model: string }
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
  contextSubsystems: SettingsContextSubsystems
  codeMode: SettingsCodeMode
  /** Automatic conversation titles. Absent documents retain the existing enabled default. */
  autoTitle?: boolean
  /** Host deadlines in seconds; zero disables each deadline independently. */
  modelWait: ModelWaitSettings
  /** Additional model attempts after a transient failure; zero disables retry. */
  modelRetryLimit: number
  sandboxMode: SettingsSandboxMode
  windowsSandboxBackend: SettingsWindowsSandboxBackend
  wslExecution: SettingsWslExecution
  webSearchMode: SettingsWebSearchMode
  /** Executable preference for new Agent shell commands. */
  agentShell: SettingsAgentShell
  /** Desktop tool approvals; legacy files default to dangerous-only. */
  approvalMode: SettingsApprovalMode
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

/** Backend Code Mode preference. Omitted limits use the runtime defaults. */
export interface SettingsCodeMode {
  mode: "off" | "mixed" | "only"
  memoryLimitMb?: number
  cpuTimeMs?: number
  maxActiveCells?: number
  maxPendingCalls?: number
  maxSourceBytes?: number
  maxResultBytes?: number
  maxStoreBytes?: number
  defaultYieldTimeMs?: number
  defaultOutputTokens?: number
}

export type SettingsApprovalMode = "dangerous" | "ask-all" | "delegate" | "full-access"

export interface ModelWaitSettings { firstResponseSeconds: number; progressSeconds: number }
