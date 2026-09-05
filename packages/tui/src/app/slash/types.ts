// @i-harness/tui — G2 (M46a): slash registry TYPES (spec §2 — the grok
// registry shape: SlashCommand + visible() gating).
// Pure types — impls import this module only; the loop wires the context.

import type { BackendClient, ScrollbackEngine, WorkflowSurface } from "../../contracts.ts"
import type { TuiAppState } from "../present.ts"

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
  /** Visibility gate — a hidden command exists in the registry (documented,
   * testable) but is not listed nor matched for execution (spec §2: the
   * skip-list is registered hidden with a comment instead of omitted). */
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
  /** Workspace root the host runs in (skills/hooks/plugins/workflow scans). */
  workspace?: string
  /** Current session id when the host knows it (host option; embedded
   * sessions have an in-process id the app cannot introspect — honest absent). */
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
  startSearch(): void
  /** The last assistant block's rows (the plan text viewer). */
  planRows(): Array<{ label: string }>
  /** /btw <question> — show the btw overlay + steer the question. */
  toggleBtwWith(question: string): void
  /** /btw with no arg — prompt for the question (text-input overlay). */
  openBtwInput(): void
  // ---- ui / toggles
  togglePane(kind: "todo" | "tasks" | "queue"): void
  setScreen(screen: "agent" | "welcome"): void
  setTheme(kind: "groknight" | "grokday" | "auto"): void
  setTimestamps(on: boolean): void
  setMultiline(on: boolean): void
  setCompactMode(on: boolean): void
  setAutoApprove(on: boolean): void
  focusPrompt(): void
  // ---- session lifecycle
  resetSession(): void
  renameSession(title: string): void
  deleteSession(): void
  /** /minimal //fullscreen: the host relaunches the same session in the target
   * mode (ModeSwitch); true = spawned (the loop then quits this process). */
  relaunch(): boolean
  quitApp(): void
  /** G1-owned modal surfaces (/provider //model //settings — their
   * text-match intercepts BEFORE the registry run; absent host store → false). */
  g1Modal?(input: string): boolean
  /** /effort — the settings reasoningEffort surface (G1 provider store). */
  effort?(level: string): void
  /** M46b G1: the mouse-reporting-toggle feature gate (settings knob / env
   * forced) — true exposes /toggle-mouse-reporting (visible + executable);
   * false keeps it hidden and inert. */
  mouseReportingToggle?: boolean
  // ---- tools
  copyBlock(): void
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
}
