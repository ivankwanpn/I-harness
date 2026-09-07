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
// M49 Task 10: the typed tool presentation (redaction seam §7.3 + the family
// formatters) and THE one-active modal/viewer union (block viewer + the
// real-file line viewer + the input owner).
export { redactToolPayload, SECRET_KEYS, presentTool } from "./tool-presentation/index.ts"
export type { ToolPresentation, ToolBodyEntry, ToolEventLike } from "./tool-presentation/index.ts"
export { createBlockViewer } from "./views/block-viewer.ts"
export type { BlockViewerState, BlockViewerRow, BlockViewerOptions, BlockViewerSearchState, BlockViewerCopyFeedback } from "./views/block-viewer.ts"
export { ModalOwner, createFileViewer, modalHitTargets } from "./views/modal.ts"
export type { ActiveModal, FileViewerState, FileViewerOptions, ModalHitTarget } from "./views/modal.ts"
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
import type { TextStyle } from "./contracts.ts"
export type { ScrollbackEngineOptions } from "./scrollback/engine.ts"
export { createEmbeddedBackend, defaultEmbeddedFactory } from "./backend/embedded.ts"
export type { EmbeddedOptions, EmbeddedFactoryOptions } from "./backend/embedded.ts"
// M49 Task 10: the typed session-event mapper is re-exported too — the app
// host (apps/tui) uses the SAME pure mapper when it owns the assembly itself
// (bridge tests + the production interaction pump).
export { createEventMapState, mapSessionEvent } from "./backend/embedded.ts"
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
  DashboardSessionResult,
  DashboardSessionRow,
  DisplayLine,
  ScrollbackEngine,
  ScrollbackSearchResult,
  SessionSummary,
  StyledRun,
  TextStyle,
  TodoItem,
  ToolKind,
  ToolViewInfo,
  TuiEvent,
  TuiToolEvent,
} from "./contracts.ts"
// M49 Task 13: the local dashboard state + the status-line truth source (the
// apps/tui host composes them from settings + @i-harness/exec).
export { createDashboardState } from "./views/dashboard-state.ts"
export type { DashboardState, DashboardPrefs } from "./views/dashboard-state.ts"
export {
  collectStatus,
  createCommandStatusSource,
  sanitizeStatusText,
  firstNonEmptyLine,
} from "./app/status-source.ts"
export type {
  StatusLineState,
  StatusAggregateInput,
  StatusCommandContext,
  StatusCommandSource,
  StatusRunner,
  StatusLineSegmentKind,
} from "./app/status-source.ts"
export type { StatusLineOptions } from "./app/loop.ts"
// G1↔G2 minimal-mode contracts (contracts.ts is G1's — re-exported read-only).
export type { InlineLiveRegion, InlineMetrics, RegionLine } from "./minimal/contracts.ts"
// M49 Task 8: minimal ANSI from the active semantic palette (design §9.3) —
// the style-map override the executable hosts pass to the inline engine.
export { sgrFromPalette } from "./minimal/inline.ts"
export type { InlineEngineOptions } from "./minimal/inline.ts"
// M38a G2: minimal-mode views (pure content model) + print-once commit pipeline.
export { composeRegion } from "./minimal/live-region.ts"
export type { ComposeRegionOptions, LiveRegionState } from "./minimal/live-region.ts"
export { MinimalCommits, commitDelta, displayToRegion } from "./minimal/commit.ts"
export type { CommitEngine, CommitOptions, CommitWriter } from "./minimal/commit.ts"
export { ModeSwitch, defaultRelaunchSpawn, parseModeArg, relaunchArgs } from "./minimal/mode.ts"
export type { ModeSwitchOptions, RelaunchSpawn } from "./minimal/mode.ts"
// M49 Task 6: provider/model TUI management — the UI-only provider controller
// (over provider-runtime + settings + credentials + the live backend), the
// typed settings registry/controller and the three modal surfaces (provider
// master/detail, typed settings modal, model picker) + their binders/views.
export { ProviderController, maskKey } from "./app/provider-controller.ts"
export type {
  ProviderControllerBackend,
  ProviderControllerOptions,
  ProviderControllerState,
  ProviderDiscoveryState,
  ProviderDraftInput,
} from "./app/provider-controller.ts"
export type { SettingsCategory, SettingDefinition, SettingsContext, SettingsCapabilityContext, SettingValueKind, SettingsRegistry } from "./settings/registry.ts"
export { createSettingsRegistry, SETTINGS_CATEGORY_ORDER } from "./settings/registry.ts"
export { createSettingsController } from "./settings/controller.ts"
export type { SettingsController } from "./settings/controller.ts"
export {
  bindProviderOverlay,
  editorAdvance,
  editorAppend,
  editorBackspace,
  editorSwitchField,
  isProviderOverlay,
  makeDraft,
  manualModelOf,
  providerRowCount,
  providerRows,
  renderProviderOverlay,
} from "./views/provider.ts"
export type {
  ManualModelDraft,
  ProviderBindOptions,
  ProviderDraft,
  ProviderEditorMode,
  ProviderEditorState,
  ProviderField,
  ProviderRow,
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
  NEW_SESSIONS_LABEL,
  SETTINGS_CATEGORY_WINDOW,
  SETTINGS_TITLE,
  bindSettingsOverlay,
  createTuiSettingsRegistry,
  displayValue,
  isSettingsOverlay,
  nextTheme,
  nextValueOf,
  renderSettingsModal,
  settingsCategoryWindow,
  settingsKnobRows,
  settingsSnapshot,
  themeDisplayName,
  tuiSettingsDefinitions,
} from "./views/settings.ts"
export type {
  SettingsBindOptions,
  SettingsKnobRow,
  SettingsModalState,
  SettingsSnapshot,
  TuiSettingsHost,
  TuiSettingDefinition,
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
 * types it loosely so this surface compiles before G1 lands. M49 Task 8: the
 * optional `sgr` is the palette-derived style override (minimal ANSI from the
 * active semantic palette — design §9.3). */
export type MinimalHostFactory = (
  opts?: { cols?: number; rows?: number; sgr?: Record<TextStyle, string> },
) => InlineLiveRegion

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
