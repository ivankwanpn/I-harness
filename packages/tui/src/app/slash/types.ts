// @i-harness/tui — G2 (M46a): slash registry TYPES (spec §2 — the grok
// registry shape: SlashCommand + visible() gating). M49 Task 14 (spec §10):
// the typed SlashCapability inventory + the capability-gated ctx seams.
// Pure types + one helper — impls import this module only; the loop wires the
// context.

import type { BackendClient, ScrollbackEngine, WorkflowSurface } from "../../contracts.ts"
import type { SettingsTheme } from "@i-harness/settings"
import type { TuiAppState } from "../present.ts"

// ------------------------------------------------------------------ capabilities

/**
 * The typed capability inventory (spec §10.1): one string per LIVE backend/
 * host surface the registry gates on. `visible()` checks only REAL capability
 * strings — the loop derives `ctx.capabilities` from the wired host members
 * (never a fake). The M49 TUI backend has no live switching/guardian/vim
 * capability, so plan-mode/guardian/vim-mode are NEVER supplied (their
 * commands stay hidden — no UI-state-only fakes).
 */
export type SlashCapability =
  | "session-create"     // backend.createSession — /new
  | "session-list"       // backend.listSessions — /resume
  | "dashboard"          // backend.dashboard — /dashboard
  | "provider-settings"  // the provider controller — /settings //provider //model /effort
  | "rewind"             // backend.rewind bridge — /rewind
  | "compact"            // backend.compact — /compact
  | "fork"               // backend.forkSession — /fork
  | "context"            // backend.context — /context
  | "plan-mode"          // live backend switching/guardian — /plan //view-plan (absent at M49)
  | "guardian"           // live guardian capability — /auto //always-approve (absent at M49)
  | "vim-mode"           // live vim editor capability — /vim-mode (absent at M49)

/** Capability gate helper (impls use it instead of hand-written includes). */
export function hasCapability(ctx: SlashContext, cap: SlashCapability): boolean {
  return ctx.capabilities !== undefined && ctx.capabilities.includes(cap)
}

// ------------------------------------------------------------------ panels

/** Light panels (views/light-*.ts) the registry commands open — one generic
 * row-list view per kind, data from the REAL backends where the host has one. */
export type PanelKind =
  | "skills" | "mcps" | "hooks" | "plugins" | "marketplace"
  | "personas" | "config-agents" | "workflow"
  | "usage" | "session-info" | "goal" | "tutorial" | "jump" | "doctor"
  | "favorites" | "cheatsheet"
  // M46b G2 (mouse click semantics): the plan status-chip click → the
  // view-plan panel (same rows as /plan //view-plan).
  | "plan"

export interface SlashPanelRow {
  /** Primary text (the row body). */
  label: string
  /** Right-aligned detail (gray) — statuses / counts / ids. */
  detail?: string
  /** Whether this row is a section header (set by the impl — not drawn yet;
   * kept for future panel polish; the plain list is the v1 row format). */
  header?: boolean
}

export interface SlashPanelRequest {
  kind: PanelKind
  /** Top-left label of the panel (` {title} `). */
  title: string
  rows: SlashPanelRow[]
  /** Enter on a row → onSelect(index) (e.g. /jump jumps the viewport). */
  onSelect?: (index: number) => void
  /** Initial cursor (default 0). */
  cursor?: number
  /** Panel is loading (empty rows render "  Loading..."). */
  loading?: boolean
  /** M46c G2: [r] refresh closure (the /workflow status panel re-fetches its
   * rows — the loop calls it from the key intercept while the panel is open). */
  refresh?: () => void
}

// ------------------------------------------------------------------ command

export interface SlashCommand {
  /** Command name WITHOUT the leading slash (e.g. "new"). */
  name: string
  aliases?: string[]
  description: string
  /** Shown after the name in the dropdown ghost row ("/name <hint>"). */
  argumentHint?: string
  run(ctx: SlashContext): Promise<void> | void
  /** Visibility gate — checks the live capability inventory (spec §10.1:
   * view/screenMode/session/backend capability/feature setting). A hidden
   * command is not listed nor matched — its run can never fire. */
  visible?(ctx: SlashContext): boolean
}

/** What a run() may do — the LOOP-owned behaviors, injected as closures (the
 * impls never import loop.ts — no cycle; testable against a fake ctx). */
export interface SlashContext {
  app: TuiAppState
  backend: BackendClient
  engine: ScrollbackEngine
  /** Full trimmed submitted line (e.g. "/theme grokday"). */
  input: string
  /** Argument text after the name (e.g. "grokday"; "" when none). */
  arg: string
  /** Show a bottom-right toast (3 s). */
  toast(text: string): void
  /** The typed capability inventory (spec §10.1) — the visible() gates read
   * it; the loop derives it from the REAL backend/host members. Absent =
   * every capability-gated command stays hidden (never reachable). */
  capabilities?: SlashCapability[]
  /** Workspace root the host runs in (skills/hooks/plugins/workflow scans). */
  workspace?: string
  /** Current session id when the host or backend session/open event knows it. */
  sessionId?: string
  /** Turn count — the engine's User-block walk (turn anchors). */
  turns(): number
  /** Turn anchors (User blocks → display lines) — the /jump list. */
  jumpAnchors(): Array<{ line: number; n: number; text?: string }>
  /** Jump the scrollback viewport to a display line (follow off). */
  gotoLine(line: number): void
  // ---- navigation
  openPanel(req: SlashPanelRequest): void
  openSessions(): void
  openHistoryPanel(): void
  openRewind(): void
  /** /find <pattern> — activate the scrollback search, prefilled. */
  startSearch(pattern?: string): void
  /** The last assistant block's rows (the plan text viewer). */
  planRows(): Array<{ label: string }>
  /** /btw <question> — show the btw overlay + steer the question. */
  toggleBtwWith(question: string): void
  /** /btw with no arg — prompt for the question (text-input overlay). */
  openBtwInput(): void
  // ---- ui / toggles
  setScreen(screen: "agent" | "welcome"): void
  /** /theme — the shared preview/commit/rollback path (M49 Task 8). */
  setTheme(kind: SettingsTheme): void
  setTimestamps(on: boolean): void
  setMultiline(on: boolean): void
  setCompactMode(on: boolean): void
  focusPrompt(): void
  // ---- session lifecycle
  resetSession(): void
  renameSession(title: string): void
  /** /minimal //fullscreen: the host relaunches the same session in the target
   * mode (ModeSwitch); true = spawned (the loop then quits this process). */
  relaunch(): boolean
  quitApp(): void
  /** /effort — the settings reasoningEffort surface (the six-level contract). */
  effort?(level: string): void
  /** M46b G1: the mouse-reporting-toggle feature gate (settings knob / env
   * forced) — true exposes /toggle-mouse-reporting (visible + executable);
   * false keeps it hidden and inert (feature setting per spec §10.1). */
  mouseReportingToggle?: boolean
  // ---- tools
  /** /copy — copy the selected block (the clipboard adapter's checked path). */
  copy(): void
  /** /edit-prompt — the $EDITOR round-trip over the prompt draft. */
  editPromptInEditor(): void
  /** /export — write the transcript; resolves the written path (undefined =
   * failure). */
  exportTranscript(): Promise<string | undefined>
  /** /transcript — serialize rows to a temp file + spawn $PAGER. */
  openTranscriptPager(): Promise<boolean>
  /** /doctor — the capability report (tui-core probe context). */
  probeReport?(): Promise<SlashPanelRow[]>
  // ---- M46c G2: /workflow surface (additive members)
  /** The /workflow host (contracts.ts WorkflowSurface) — the loop wires the
   * default @i-harness/workflow-backed surface; tests inject a fake. */
  workflow?: WorkflowSurface
  /** Open the text-input overlay (the /workflow run params line — the same
   * bindTextInput seam /btw uses). Absent → the command toasts honestly. */
  openTextInput?(opts: { title: string; initial?: string; onSubmit(text: string): void; onCancel?(): void }): void
  // ---- M49 Task 14 capability-gated seams (spec §10.2)
  /** /new — backend session create. */
  createSession?(): Promise<void> | void
  /** /dashboard — the local dashboard projection. */
  dashboard?(): void
  /** /queue — the queue pane (honest empty/unavailable states). */
  queue?(): void
  /** /tasks — the tasks pane. */
  tasks?(): void
  /** /settings — the settings modal. */
  openSettings?(): void
  /** /provider [arg] — the provider master/detail modal. */
  provider?(arg: string): void
  /** /model [name] — the model picker over the active provider catalog. */
  model?(arg: string): void
  /** /fork [title] — backend session fork. */
  fork?(title?: string): void
  /** /context — the local context-usage panel. */
  openContext?(): void
  /** /help — the CURRENT visible command rows (never a static list). */
  visibleCommands?(): Array<{ name: string; description: string }>
  /** /help — the ACTIVE key bindings (the shortcuts-bar rows). */
  keyBindings?(): Array<{ key: string; label: string }>
}
