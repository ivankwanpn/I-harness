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

export type {
  SettingsSandboxMode,
  SettingsWindowsSandboxBackend,
  SettingsWebSearchMode,
  SettingsWslExecution,
  SettingsTranscriptMode,
  SettingsBusyEnter,
  SettingsSearchBackend,
  SettingsLanguage,
  SettingsAgentShell,
  SettingsPluginToggles,
  SettingsModel,
  SettingsInputModality,
  SettingsMaxTokensField,
  SettingsProviderConfig,
  SettingsDefaultModel,
  SettingsLlm,
  SettingsStatusLineSegment,
  SettingsTuiDashboardPrefs,
  SettingsTuiStatusLinePrefs,
  SettingsTuiPrefs,
  SettingsTui,
  SettingsOnboarding,
  Settings,
  SettingsCompaction,
  SettingsCodeMode,
  SettingsApprovalMode,
  ModelWaitSettings,
} from "./schema/types.ts"
export { AGENT_SHELL_CHOICES, SETTINGS_DEFAULT_WORD_SEPARATORS, SETTINGS_STATUS_LINE_SEGMENTS } from "./schema/types.ts"
export { FONT_SIZE_MIN, FONT_SIZE_MAX } from "./schema/defaults.ts"
export { normalizeWslExecution, normalizeCodeMode, validModelWaitSeconds } from "./normalize/execution.ts"
export { normalizeInputModalities } from "./normalize/providers.ts"
export { normalizeSettings } from "./normalize/settings.ts"
export type { SettingsStoreOptions, LayeredStoreOptions, SettingsStoreSurface } from "./storage/contracts.ts"
export type { LayerSource, LayeredRoots, LayerRaw } from "./storage/layers.ts"
export { resolveLayeredSources, mergeRawLayers } from "./storage/layers.ts"
export { SettingsPatchError, patchJsonDocumentKeepingComments } from "./storage/json-patch.ts"
export { SettingsStore, resolveSettingsPath, updateSettings } from "./storage/single-store.ts"
export { LayeredSettingsStore, createLayeredStore } from "./storage/layered-store.ts"
export { watchSettings } from "./observation/watch-settings.ts"
export * from './context-subsystems.ts'

// Section descriptor API (Task 1 of the models plan): schemas, redacted
// describe views, validated mutate ops and the revision-guard errors. Built on
// this package's store — the section module itself stays dependency-free.
export * from "./sections.ts"
