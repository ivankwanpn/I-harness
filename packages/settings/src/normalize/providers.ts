import { PROVIDER_PROTOCOLS } from "../sections.ts"
import type { SettingsProviderProtocol } from "../sections.ts"
import type { SettingsAgents, SettingsInputModality, SettingsLlm, SettingsMaxTokensField, SettingsModel, SettingsProviderConfig, SettingsRoleModel } from "../schema/types.ts"
import { isRecord, isNonEmptyString, isPositiveInteger } from "./primitives.ts"

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

function isProviderProtocol(value: unknown): value is SettingsProviderProtocol {
  return typeof value === "string" && (PROVIDER_PROTOCOLS as readonly string[]).includes(value)
}

/** M72 Ⅱ: the closed pair (see SettingsMaxTokensField). Anything else — a
 * Responses spelling, a number, a typo — degrades to absent rather than
 * travelling to a wire that would reject the whole request. */
function isMaxTokensField(value: unknown): value is SettingsMaxTokensField {
  return typeof value === "string" && (MAX_TOKENS_FIELDS as readonly string[]).includes(value)
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
  if (isNonEmptyString(raw.oauthAccountId)) out.oauthAccountId = raw.oauthAccountId
  if (raw.oauthProvider === "openai-codex") out.oauthProvider = raw.oauthProvider
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
  if (isRecord(raw.promptCache) && (raw.promptCache.mode === "off" || raw.promptCache.mode === "automatic")
    && (raw.promptCache.retention === undefined || raw.promptCache.retention === "5m" || raw.promptCache.retention === "1h")) {
    out.promptCache = { mode: raw.promptCache.mode, ...(raw.promptCache.retention !== undefined ? { retention: raw.promptCache.retention } : {}) }
  }
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

export function normalizeAgents(raw: unknown, base: SettingsAgents): SettingsAgents {
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
export function normalizeLlm(raw: unknown, base: SettingsLlm): SettingsLlm {
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
    ...(isRecord(raw.videoAudio) && isNonEmptyString(raw.videoAudio.provider) && isNonEmptyString(raw.videoAudio.model)
      ? { videoAudio: { provider: raw.videoAudio.provider, model: raw.videoAudio.model } } : {}),
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

export function normalizeLlmWithLegacy(raw: unknown, legacyRaw: unknown, base: SettingsLlm): SettingsLlm {
  const canonical = normalizeLlm(raw, base)
  const legacy = migrateLegacyTuiProviders(legacyRaw)
  const providers: Record<string, SettingsProviderConfig> = { ...legacy.providers }
  for (const [id, config] of Object.entries(canonical.providers)) {
    providers[id] = { ...providers[id], ...config }
  }
  return {
    ...(canonical.videoAudio ? { videoAudio: { ...canonical.videoAudio } } : {}),
    providers,
    defaultModel: {
      ...canonical.defaultModel,
      provider: canonical.defaultModel.provider !== ""
        ? canonical.defaultModel.provider
        : legacy.activeProviderId,
    },
  }
}
