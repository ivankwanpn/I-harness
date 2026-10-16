import { AGENT_SHELL_CHOICES, type Settings, type SettingsApprovalMode, type SettingsLanguage, type SettingsOnboarding, type SettingsSandboxMode, type SettingsSearchBackend } from "../schema/types.ts"
import { FONT_SIZE_MIN, FONT_SIZE_MAX, SETTINGS_DEFAULTS } from "../schema/defaults.ts"
import { normalizeContextSubsystems } from "../context-subsystems.ts"
import { isRecord, booleanOf, numberInList, oneOf } from "./primitives.ts"
import { normalizeWslExecution, normalizeCodeMode, normalizeModelWait } from "./execution.ts"
import { normalizeAgents, normalizeLlm, normalizeLlmWithLegacy } from "./providers.ts"
import { normalizeTui } from "./tui.ts"

const SANDBOX_MODES: readonly SettingsSandboxMode[] = ["read-only", "workspace-write", "danger-full-access"]

const APPROVAL_MODES: readonly SettingsApprovalMode[] = ["dangerous", "ask-all", "delegate", "full-access"]

const SEARCH_BACKENDS: readonly SettingsSearchBackend[] = ["jsonl", "sqlite"]

const LANGUAGES: readonly SettingsLanguage[] = ["zh"]

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
  if (!isRecord(raw)) {
    return {
      ...base,
      wslExecution: { ...base.wslExecution },
      contextSubsystems: normalizeContextSubsystems(undefined),
      plugins: { ...base.plugins },
      agents: normalizeAgents(undefined, base.agents),
      llm: normalizeLlm(undefined, base.llm),
      onboarding: { ...base.onboarding },
      compaction: { ...base.compaction },
      codeMode: { ...base.codeMode },
      tui: normalizeTui(undefined, base.tui),
    }
  }
  const pluginsRaw = isRecord(raw.plugins) ? raw.plugins : {}
  const compactionRaw = isRecord(raw.compaction) ? raw.compaction : {}
  const tuiRaw = isRecord(raw.tui) ? raw.tui : {}
  return {
    sandboxMode: oneOf(raw.sandboxMode, SANDBOX_MODES, base.sandboxMode),
    windowsSandboxBackend: oneOf(raw.windowsSandboxBackend, ["legacy", "psec", "wsl"] as const, base.windowsSandboxBackend),
    wslExecution: normalizeWslExecution(raw.wslExecution),
    // Older documents fetched live. Fresh stores use the cached default above.
    webSearchMode: Object.hasOwn(raw, "webSearchMode") ? oneOf(raw.webSearchMode, ["disabled", "cached", "indexed", "live"] as const, base.webSearchMode) : "live",
    contextSubsystems: normalizeContextSubsystems(raw.contextSubsystems),
    codeMode: normalizeCodeMode(raw.codeMode),
    autoTitle: typeof raw.autoTitle === "boolean" ? raw.autoTitle : true,
    modelWait: normalizeModelWait(raw.modelWait),
    modelRetryLimit: typeof raw.modelRetryLimit === "number" && Number.isSafeInteger(raw.modelRetryLimit) && raw.modelRetryLimit >= 0 && raw.modelRetryLimit <= 100 ? raw.modelRetryLimit : 5,
    agentShell: oneOf(raw.agentShell, AGENT_SHELL_CHOICES, base.agentShell),
    approvalMode: oneOf(raw.approvalMode, APPROVAL_MODES, base.approvalMode),
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
