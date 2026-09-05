// @i-harness/tui — M37a public surface, extended at M37b/G4 (the wheel).
// The single import surface for hosts (apps/tui + future --attach hosts):
// the app loop + its option/state types, the scrollback engine, the embedded
// backend (bridge + mock-first factory), the shared contracts, the G1↔G2
// overlay-seam binders, and the approval/question bridge (extension surface
// + store listing).
// Runtime dependencies: workspace packages only (@i-harness/tui-core /
// @i-harness/session-executor / @i-harness/core-session / @i-harness/
// interaction / @i-harness/session-persistence* — see package.json).

export { TuiApp } from "./app/loop.ts"
export type { TuiAppOptions, InputSource, InlineHost } from "./app/loop.ts"
export type { TuiAppState } from "./app/present.ts"
// M39 G2: FPS/scroll-debug HUD — zero overhead (allocated only when the app
// option hud:true is on; renderHud draws the top-right 32-col band).
export { FpsMeter, HUD_PANEL_W, renderHud } from "./app/hud.ts"
export type { HudState } from "./app/hud.ts"
// G4: the G1↔G2 overlay binder (seam adapters) — a host wires
// `app.state().overlay = bindPermissionOverlay(surf, state, opts)`.
export { bindPermissionOverlay, bindQuestionOverlay, bindCancelTurnOverlay, overlaySeam } from "./app/overlay-seam.ts"
export type {
  CancelTurnBindOptions,
  CancelTurnDecision,
  PermissionBindOptions,
  PermissionDecision,
  PermissionVerdict,
  QuestionBindOptions,
  QuestionDecision,
  QuestionMode,
  SeamKind,
} from "./app/overlay-seam.ts"
export type { OverlaySeam } from "./app/present.ts"
export { createScrollbackEngine } from "./scrollback/engine.ts"
import type { InlineLiveRegion } from "./minimal/contracts.ts"
export type { ScrollbackEngineOptions } from "./scrollback/engine.ts"
export { createEmbeddedBackend, defaultEmbeddedFactory } from "./backend/embedded.ts"
export type { EmbeddedOptions, EmbeddedFactoryOptions } from "./backend/embedded.ts"
// M38b G2: remote/SDK backend (--attach) — the stdio wire client
// (spawnSdkSubprocess, mirrors @i-harness/sdk HarnessClient.spawn without the
// dep) + the BackendClient adapter (createRemoteBackend; SdkClientLike is the
// structural seam a host with the REAL HarnessClient can plug instead).
// M41a: the wire v1 result shapes (session/history + session/list) the seam
// exposes to hosts that use the mirror's typed helpers; M41b v1.1: the
// capability-gated cancel/rewind result shapes (session/cancel +
// session/rewind/* — the mirror's typed helpers) the same way.
export { createRemoteBackend, spawnSdkSubprocess } from "./backend/remote.ts"
export type {
  HistoryResult,
  RemoteBackendOptions,
  SdkClientLike,
  SdkNotification,
  SessionListResult,
  CancelResult,
  RewindPointsResult,
  RewindPlanResult,
  RewindExecuteResult,
  RewindFileOpWire,
} from "./backend/remote.ts"
// G1 interaction surfaces (spec §3.7/§3.8/§3.11) — what a host builds and
// passes into the seam binders.
export type {
  PermissionKey,
  PermissionKeyAction,
  PermissionRow,
  PermissionState,
  PermissionSurface,
} from "./views/permission.ts"
export type { QuestionKey, QuestionKeyAction, QuestionOption, QuestionQuestion, QuestionState } from "./views/question.ts"
export type { CancelTurnKey, CancelTurnKeyAction, CancelTurnState } from "./views/cancel-turn.ts"
// G1 approval/question bridge extension (contracts.ts stays closed) + the
// read-only store listing a host wires into TuiAppOptions.listSessions.
export { DECISION_MAP, attachApproval, createApprovalBridge, listSessionsFromStore } from "./backend/approval.ts"
export type { ApprovalBridge, ApprovalBridgeService, ApprovalClient, StoredSession } from "./backend/approval.ts"
export { toolKindOf } from "./contracts.ts"
export type {
  BackendClient,
  BackendContextUsage,
  DisplayLine,
  ScrollbackEngine,
  ScrollbackSearchResult,
  SessionSummary,
  StyledRun,
  TextStyle,
  TodoItem,
  ToolKind,
  TuiEvent,
} from "./contracts.ts"
// G1↔G2 minimal-mode contracts (contracts.ts is G1's — re-exported read-only).
export type { InlineLiveRegion, InlineMetrics, RegionLine } from "./minimal/contracts.ts"
// M38a G2: minimal-mode views (pure content model) + print-once commit pipeline.
export { composeRegion } from "./minimal/live-region.ts"
export type { ComposeRegionOptions, LiveRegionState } from "./minimal/live-region.ts"
export { MinimalCommits, commitDelta, displayToRegion } from "./minimal/commit.ts"
export type { CommitEngine, CommitOptions, CommitWriter } from "./minimal/commit.ts"
export { ModeSwitch, defaultRelaunchSpawn, parseModeArg, relaunchArgs } from "./minimal/mode.ts"
export type { ModeSwitchOptions, RelaunchSpawn } from "./minimal/mode.ts"
// M46a G1: provider/model TUI management — the store, the factory chain and
// the three modal surfaces (provider menu/wizard, settings 8-category modal,
// model picker) + their binders/views.
export {
  ProviderStore,
  DISCOVERY_TIMEOUT_MS,
  PROVIDER_STORE_VERSION,
  discoveryCandidates,
  maskKey,
  parseModelsBody,
  providerApiKeyRef,
} from "./app/provider-store.ts"
export type {
  CredentialFace,
  FetchedModel,
  ProviderEntry,
  ProviderProtocol,
  ProviderStoreOptions,
} from "./app/provider-store.ts"
export { createTuiModelBuilder, mapTuiProtocol, providerProfileFromEntry, resolveTuiModel } from "./app/model-factory.ts"
export type { TuiModelResolution } from "./app/model-factory.ts"
export {
  bindProviderOverlay,
  isProviderOverlay,
  makeWizard,
  menuRows,
  renderProviderOverlay,
  wizardAdvance,
  wizardAppend,
  wizardBackspace,
  wizardEntryOf,
  wizardSwitchField,
} from "./views/provider.ts"
export type {
  MenuRow,
  ProviderBindOptions,
  ProviderViewPhase,
  ProviderViewState,
  ProviderWizardState,
} from "./views/provider.ts"
export {
  MODEL_MORE,
  MODEL_NO_OVERRIDE,
  MODEL_PICKER_MAX_ROWS,
  MODEL_PICKER_TITLE,
  bindModelPickerOverlay,
  isModelPickerOverlay,
  modelPickerEntries,
  modelPickerWindow,
  renderModelPicker,
} from "./views/model-picker.ts"
export type { ModelPickerBindOptions, ModelPickerEntry, ModelPickerState } from "./views/model-picker.ts"
export {
  SETTINGS_CATEGORIES,
  SETTINGS_NOT_AVAILABLE,
  SETTINGS_TITLE,
  bindSettingsOverlay,
  isSettingsOverlay,
  nextTheme,
  renderSettingsModal,
  settingsCategoryWindow,
  settingsKnobRows,
  settingsSnapshot,
  themeDisplayName,
} from "./views/settings.ts"
export type {
  SettingsBindOptions,
  SettingsCategory,
  SettingsKnobRow,
  SettingsModalState,
  SettingsSnapshot,
} from "./views/settings.ts"
// M46a G2: the slash command registry (backend-supported builtin map + the
// visibility-gated skip-list inventory) + the light-panel row model/renderer
// + the text-input overlay binder (registry ctx seams).
export { CommandRegistry, builtinCommands, defaultRegistry } from "./app/slash/registry.ts"
export type { SlashCommand, SlashContext, SlashPanelRequest, SlashPanelRow } from "./app/slash/types.ts"
export { bindTextInput } from "./app/slash/impl/text-input.ts"
export type { TextInputOptions } from "./app/slash/impl/text-input.ts"
export { renderLightPanel } from "./views/light-panel.ts"
export type { LightPanelRow, LightPanelState } from "./views/light-panel.ts"

/** G1's inline-engine factory shape (createInlineLiveRegion) — the loader
 * types it loosely so this surface compiles before G1 lands. */
export type MinimalHostFactory = (opts?: { cols?: number; rows?: number }) => InlineLiveRegion

/** Lazy G1 inline-engine loader — the DYNAMIC import keeps this surface
 * compiling while G1's inline.ts is still in flight; when the module is not
 * there yet it resolves undefined (hosts fall back to fullscreen; a later
 * relaunch picks it up). Resolved through the app's own package dir. */
export async function loadMinimalHost(): Promise<MinimalHostFactory | undefined> {
  const spec: string = "./minimal/inline.ts"
  try {
    const mod = (await import(spec)) as { createInlineLiveRegion?: MinimalHostFactory }
    return mod.createInlineLiveRegion
  } catch {
    return undefined
  }
}
