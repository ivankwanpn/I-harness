// @i-harness/tui — M46b G2: MOUSE CLICK SEMANTICS — the dispatch core.
//
// One dead-simple contract with the loop: the loop converts parser mouse
// events to 0-based cell events (kind: down/up/motion — the parser's M46b
// `released` bit is the press/release divider) and calls
//   mouse.handle(ev)      → press/drag/click dispatch to the widget under the cell
//   mouse.frame(now)      → per-tick drag autoscroll + flash-expiry clearing
//   loop routes wheel     → G1 scroll-stream seam (consume) else ±3 fallback
//
// Widget coverage (spec new-truth §3, M46b design §3):
//   scrollback  click=select+focus · ≤300ms double=fold (class: group header /
//               bg-task-subagent viewer / prompt entry fold+scroll-top) ·
//               triple=fold+scroll-top · word_select mode 1/2/3 select-word-
//               paragraph · drag ≥1 cell = display-line selection + autoscroll
//               (2-row edge bands 1/2/3/5 rows/tick) + auto-copy on up +
//               "Copied!" toast + flashUntil · lost-up recovery
//   scrollbar   down = latch + fraction jump (grok thumb: Top/Bottom/Offset),
//               drag continuous, up ends
//   prompt      click = cursor at cell · double on file-ref = line viewer ·
//               double on paste chip = expand (toast, source not retained) ·
//               drag = text selection + copy on up
//   permission  single = active row · double (≤300ms same index) fires
//               (binder's decide reused via the seam's act)
//   question    single = toggle/cursor · double = select + answer
//   cancel-turn click fires the choice
//   status      cwd copy path · tasks pane toggle · context → 300ms-debounce
//               usage panel · goal detail · plan view (M46a surfaces)
//   panes       tasks [✗]/[↗] + group-header toggle · queue [cancel]/[Send now]
//               (backend seams absent → honest M46c toasts) · todo row select
//   dropdowns   row click = cursor + accept (loop's overlaySelect) · right
//               scrollbar column proportional jump
//   links       Ctrl+click arms, up on the same cell opens (seam/tosta, M46c)
//
// THE TEST CONTRACT: everything mutates `app` (TuiAppState) + `engine` +
// `clipboard` (injected — the ONLY copy path). G1's hover engine lives on
// `app.mouse.engine` (the loop wires it); the router dispatches on ITS OWN
// layout walk (views' HitArea rects serve the hover VISUALS — the click
// semantics target the same geometry via layoutAgent, so the two never drift
// materially; harmonization may hand the router G1's hitAt for the areas'
// id/label semantics later).

import type { GlyphSet } from "@i-harness/tui-core"
import type { ScrollbackEngine } from "../contracts.ts"
import type { TaskGroup } from "../views/tasks-pane.ts"
import type { AgentLayout, AgentViewState, Rect } from "../views/agent.ts"
import { layoutAgent, SCROLLBACK_PAD_W, SCROLLBACK_RAIL_W } from "../views/agent.ts"
import { SLASH_MAX_ROWS } from "../views/slash-dropdown.ts"
import { COMPLETION_MAX_ROWS } from "../views/completion-dropdown.ts"
import { flattenSessions } from "../views/session-picker.ts"
import { statusChipsOf, statusPathSpan, strWidth } from "../views/status.ts"
import { promptCursorAtCell, promptLineAtRow } from "../views/prompt.ts"
import type { TuiAppState } from "./present.ts"
import type { Clipboard } from "./clipboard.ts"
import {
  CLIPBOARD_TOAST_DEBOUNCE,
  CONTEXT_CLICK_DEBOUNCE,
  DEFAULT_SELECTION_HIGHLIGHT_DURATION_MS,
  MULTI_CLICK_TIMEOUT_MS,
} from "./mouse-consts.ts"

// ------------------------------------------------------------------ normalised cell event

export interface MouseCellEvent {
  x: number
  y: number
  button: "left" | "middle" | "right"
  kind: "down" | "up" | "motion"
  drag: boolean
  mods: { ctrl: boolean; shift: boolean; alt: boolean }
}

// ------------------------------------------------------------------ host hooks

/** Loop-bound behaviors; every member is optional and degrades to an honest
 * toast (never a crash) — the router is host-independent and testable against
 * a plain TuiAppState + injected clipboard. */
export interface MouseHooks {
  focus?(target: "prompt" | "scrollback"): void
  /** Accept the open dropdown's row at `index` (the loop's overlaySelect). */
  overlaySelectRow?(index: number): void
  openLineViewer?(file: string, line?: number): void
  openGoalDetail?(): void
  openUsagePanel?(): void
  openPlanView?(): void
  sendBackgroundTaskCancel?(label: string): void
  openSubagentViewer?(label: string): void
  queueCancel?(n: number): void
  queueSendNow?(n: number): void
  openPasteChip?(nLines: number): void
  openLink?(url: string): void
  /** A repaint was requested (the loop arms a frame). */
  onChanged?(): void
}

// ------------------------------------------------------------------ constants (local semantics)

const DROPDOWN_BAR_W = 1 // the 1-col scrollbar column (slash/completion)

// ------------------------------------------------------------------ helpers

/** The dropdown desc — present.ts's dropdownDescOf (the mouse layer computes
 * the same layout the frame draws; copy-side parity is a comment here. */
function dropdownDesc(app: TuiAppState): AgentViewState["dropdown"] {
  if (app.sessions !== undefined) {
    const g = flattenSessions(app.sessions).length + app.sessions.groups.length
    return { kind: "sessions", rows: Math.min(3 + g, 14) }
  }
  if (app.historyPanel !== undefined) return { kind: "history", rows: 2 + Math.min(app.historyPanel.entries.length, 10) }
  if (app.lightPanel !== undefined) return { kind: "light", rows: 2 + Math.min(app.lightPanel.rows.length, 10) }
  if (app.fileSearch !== undefined) return { kind: "file-search", rows: 2 + Math.min(app.fileSearch.files.length, 10) }
  if (app.completion !== undefined) return { kind: "completion", rows: Math.min(app.completion.entries.length, COMPLETION_MAX_ROWS) }
  if (app.slash !== undefined) return { kind: "slash", rows: Math.min(app.slash.entries.length, SLASH_MAX_ROWS) }
  return undefined
}

function inRect(x: number, y: number, r: Rect | undefined): boolean {
  return r !== undefined && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

function toStringsFromRuns(runs: Array<{ text: string }>): string {
  return runs.map((r) => r.text).join("")
}

// ------------------------------------------------------------------ the router

interface PressState {
  x: number
  y: number
  region: "scrollback" | "prompt" | "none"
  line?: number
  char?: number
  moved: boolean
  button: string
}

interface DragState {
  region: "scrollback" | "prompt"
  anchorLine?: number
  pointerLine?: number
  anchorChar?: number
  pointerChar?: number
}

export interface MouseRouterOptions {
  app: TuiAppState
  engine: ScrollbackEngine
  size(): { cols: number; rows: number }
  now(): number
  clipboard: Clipboard
  glyphs: GlyphSet
  compact?: boolean
  hooks?: MouseHooks
}

export class MouseRouter {
  private readonly app: TuiAppState
  private readonly engine: ScrollbackEngine
  private readonly size: () => { cols: number; rows: number }
  private readonly now: () => number
  private readonly clipboard: Clipboard
  private readonly glyphs: GlyphSet
  private readonly compact: boolean
  private readonly hooks: MouseHooks

  private press: PressState | undefined
  private drag: DragState | undefined
  private scrollbarLatchY: number | undefined
  private linkArm: { url: string; x: number; y: number } | undefined
  private lastGesture: { at: number; key: string; count: number } | undefined
  private contextTimer: ReturnType<typeof setTimeout> | undefined
  private lastCopyToastAt: number | undefined
  private autoscrollDir: 0 | -1 | 1 = 0
  private autoscrollDist = 0

  constructor(opts: MouseRouterOptions) {
    this.app = opts.app
    this.engine = opts.engine
    this.size = opts.size
    this.now = opts.now
    this.clipboard = opts.clipboard
    this.glyphs = opts.glyphs
    this.compact = opts.compact === true
    this.hooks = opts.hooks ?? {}
  }

  /* ------------------------------------------------------------- public */

  /** Wire mouse event → cell dispatch (the loop converts parser coords). */
  handle(ev: MouseCellEvent): void {
    if (ev.mods.alt) return // alt clicks: no click semantics (terminal ops)
    switch (ev.kind) {
      case "down": this.onDown(ev); break
      case "motion": this.onMotion(ev); break
      case "up": this.onUp(ev); break
    }
  }

  /** Per-frame tick (the loop's 30fps anim pump): drag autoscroll (band rows
   * per tick while the pointer is near the scrollback edge) + flash expiry. */
  frame(now: number): void {
    const flashUntil = this.app.selectionFlashUntil
    if (flashUntil !== undefined && now >= flashUntil) {
      this.app.selectionFlashUntil = undefined
      if (this.app.keepTextSelection !== "hold" && this.app.keepTextSelection !== "word_select") {
        this.engine.clearSelection?.()
      }
      this.changed()
    }
    if (this.drag !== undefined && this.drag.region === "scrollback" && this.autoscrollDir !== 0) {
      this.autoscrollStep()
    }
  }

  /** Reset all in-flight click/drag/scrollbar/latch/link state (the loop's
   * mouse-capture toggle calls it — G1's optional seam on the router). */
  cancel(): void {
    this.press = undefined
    this.drag = undefined
    this.scrollbarLatchY = undefined
    this.linkArm = undefined
    this.autoscrollDir = 0
    this.autoscrollDist = 0
    if (this.contextTimer !== undefined) clearTimeout(this.contextTimer)
    this.contextTimer = undefined
  }

  /* ------------------------------------------------------------- layout */

  private layout(): AgentLayout | undefined {
    const screen = this.app.screen ?? "agent"
    if (screen !== "agent") return undefined // welcome/minimal: no click surface
    const area = this.size()
    if (area.cols < 4 || area.rows < 4) return undefined
    return layoutAgent(area, { ...this.app, dropdown: dropdownDesc(this.app) }, { compact: this.compact })
  }

  private scrollOff(layout: AgentLayout, total: number): number {
    return this.app.scroll.follow ? Math.max(0, total - layout.scrollback.h + 1) : Math.max(0, this.app.scroll.offset)
  }

  private textStartOf(layout: AgentLayout): number {
    return layout.scrollback.x + SCROLLBACK_RAIL_W + SCROLLBACK_PAD_W + 1
  }

  /** The display line under a scrollback cell (absolute index). */
  private lineAt(layout: AgentLayout, row: number, total: number): number {
    const off = this.scrollOff(layout, total)
    return Math.max(0, Math.min(total - 1, off + (row - layout.scrollback.y)))
  }

  private changeScroll(offset: number, follow: boolean): void {
    this.app.scroll = { offset: Math.max(0, offset), follow }
    this.changed()
  }

  private toast(text: string): void {
    const until = this.now() + 3000
    this.app.toasts.push({ text, until })
    if (this.app.toasts.length > 3) this.app.toasts.shift()
    this.changed()
  }

  private changed(): void {
    this.hooks.onChanged?.()
  }

  private focus(target: "prompt" | "scrollback"): void {
    if (this.hooks.focus !== undefined) this.hooks.focus(target)
    else this.app.focused = target
  }

  private copyToClipboard(text: string): void {
    if (text.length === 0) return
    this.clipboard.copy(text)
    this.changed()
  }

  private toastCopied(): void {
    const t = this.now()
    if (this.lastCopyToastAt !== undefined && t - this.lastCopyToastAt < CLIPBOARD_TOAST_DEBOUNCE) return
    this.lastCopyToastAt = t
    this.toast("Copied!")
  }

  /* ----------------------------------------------------------- click count */

  /** Multi-click window: a gesture with the same key within MULTI_CLICK_TIMEOUT
   * ms of the previous one increments; otherwise resets to 1. */
  private nextClick(key: string): number {
    const t = this.now()
    const prev = this.lastGesture
    const count = prev !== undefined && prev.key === key && t - prev.at < MULTI_CLICK_TIMEOUT_MS ? prev.count + 1 : 1
    this.lastGesture = { at: t, key, count }
    return count
  }

  /* ---------------------------------------------------------------- down */

  private onDown(ev: MouseCellEvent): void {
    const layout = this.layout()
    if (layout === undefined) return
    // A fresh press while a drag is still open → the button-up was LOST:
    // finalise the previous drag (auto-copy) before the new press.
    if (this.drag !== undefined) this.finalizeDrag()
    this.linkArm = undefined
    this.drag = undefined
    this.press = undefined
    this.scrollbarLatchY = undefined

    const dd = layout.dropdown
    if (dd.h > 0 && inRect(ev.x, ev.y, dd)) {
      this.dropdownDown(ev, dd)
      return
    }
    const ov = this.app.overlay
    if (ov !== undefined && inRect(ev.x, ev.y, layout.prompt)) {
      this.overlayDown(ev, ov, layout.prompt)
      return
    }
    const tasks = layout.tasks
    if (tasks !== undefined && inRect(ev.x, ev.y, tasks)) {
      this.tasksDown(ev, tasks)
      return
    }
    const todo = layout.todo
    if (todo !== undefined && inRect(ev.x, ev.y, todo)) {
      this.todoDown(ev, todo)
      return
    }
    const queue = layout.queue
    if (queue !== undefined && inRect(ev.x, ev.y, queue)) {
      this.queueDown(ev, queue)
      return
    }
    if (ev.y === layout.status.y && inRect(ev.x, ev.y, layout.status)) {
      this.statusDown(ev, layout.status)
      return
    }
    if (inRect(ev.x, ev.y, layout.prompt)) {
      this.promptDown(ev, layout.prompt)
      return
    }
    if (inRect(ev.x, ev.y, layout.scrollback)) {
      this.scrollbackDown(ev, layout)
      return
    }
    // shortcuts/welcome/btw rows — no click semantics
  }

  private overlayDown(ev: MouseCellEvent, ov: NonNullable<TuiAppState["overlay"]>, ctx: Rect): void {
    if (typeof ov.kind === "string" && ov.kind !== "permission" && ov.kind !== "question" && ov.kind !== "cancel-turn") return
    const ys = ov.rowYs?.(ctx)
    if (ys === undefined) return // rewind/provider/settings modals: no row map
    const idx = ys.indexOf(ev.y)
    const freeY = ov.freeformY?.(ctx)
    if (idx === -1) {
      // question freeform tail row → focus the freeform input.
      if (freeY !== undefined && ev.y === freeY) {
        ov.act?.("overlay-tab")
      }
      return
    }
    const count = this.nextClick(`${ov.kind}:${idx}`)
    switch (ov.kind) {
      case "permission": {
        if (count === 1) {
          ov.setCursor?.(idx) // single click: active row
        } else {
          ov.act?.({ type: "overlay-accept", index: idx + 1 }) // double ≤300ms same idx: fire
        }
        break
      }
      case "question": {
        if (count === 1) {
          if (ov.multi === true) ov.act?.({ type: "overlay-accept", index: idx + 1 }) // toggle + cursor
          else ov.setCursor?.(idx) // single-select radio: single = cursor (accept would ANSWER — honest deviation, see report)
        } else {
          if (ov.multi === true) ov.act?.("overlay-select") // select + answer (advance is the host's step)
          else ov.act?.({ type: "overlay-accept", index: idx + 1 })
        }
        break
      }
      case "cancel-turn": {
        // click fires the choice (single).
        ov.setCursor?.(idx)
        ov.act?.({ type: "overlay-accept", index: idx + 1 })
        ov.act?.("overlay-select")
        break
      }
    }
  }

  private promptDown(ev: MouseCellEvent, ctx: Rect): void {
    const p = this.app.prompt
    // Double-click (≤300ms, same cell) on a file-ref / paste chip row. ONE
    // gesture probe per click (a ref+chip double-probe would consume the
    // multi-click slot twice and HIDE the second click — count logic below
    // keys on the resolved target kind).
    const line = promptLineAtRow(ctx, p.text, ev.y)
    if (line !== undefined) {
      const colInLine = ev.x - (ctx.x + 1)
      const ref = fileRefAt(line.text, colInLine)
      const chip = ref === undefined ? pasteChipAt(line.text, colInLine) : undefined
      const target = ref !== undefined
        ? { key: "ref" as const, fn: () => this.hookOr(this.hooks.openLineViewer, "line viewer (M46c)", ref.file, ref.line) }
        : chip !== undefined
          ? { key: "chip" as const, fn: () => this.hookOr(this.hooks.openPasteChip, "paste chip (M46c)", chip.lines) }
          : undefined
      if (target !== undefined && this.nextClick(`prompt:${target.key}:${ev.x}:${ev.y}`) === 2) {
        target.fn()
        return
      }
    }
    // Click → cursor at that cell (approximate column mapping).
    p.cursor = promptCursorAtCell(ctx, p, ev.x, ev.y)
    this.changed()
    this.press = { x: ev.x, y: ev.y, region: "prompt", char: p.cursor, moved: false, button: ev.button }
    // Drag-selection arm: on motion ≥1 cell the press promotes.
    this.drag = undefined
  }

  private scrollbackDown(ev: MouseCellEvent, layout: AgentLayout): void {
    const total = this.engine.lineCount()
    const sb = layout.scrollback
    if (ev.x === sb.x + sb.w - 1) {
      // SCROLLBAR column: latch + fraction jump (grok thumb math). Latched
      // even with few lines — the jump clamps to 0.
      this.scrollbarLatchY = ev.y
      this.jumpToFraction(ev.y, sb)
      return
    }
    const line = this.lineAt(layout, ev.y, total)
    if (total <= 0) return
    // Ctrl+click → link arm (opens on UP on the same cell).
    if (ev.mods.ctrl) {
      const visible = this.engine.viewport(this.scrollOff(layout, total), sb.h)
      const rowText = visible[ev.y - sb.y] ?? this.engine.viewport(line, 1)[0]
      const text = rowText === undefined ? "" : toStringsFromRuns(rowText.runs)
      const url = urlAt(text, ev.x - this.textStartOf(layout))
      if (url !== undefined) {
        this.linkArm = { url, x: ev.x, y: ev.y }
        return
      }
    }
    // Selection entry (single) — then multi-click (double/triple) semantics
    // and the word_select 1/2/3 cycle.
    const mode = this.app.keepTextSelection ?? "flash"
    const count = this.nextClick(`sb:${ev.x}:${ev.y}`)
    const block = this.engine.lineBlock(line)
    const title = block?.title ?? ""
    if (mode === "word_select") {
      if (count === 1) {
        this.engine.setSelection(line, line)
      } else if (count === 2) {
        this.wordSelect(line, ev.x, layout)
      } else {
        this.selectAt(line, mode)
      }
    } else if (count === 2) {
      this.doubleClickBlock(line, title, false)
    } else if (count >= 3) {
      // triple: fold + scroll-to-top — the double-click at down2 already
      // unfolded/mutated per class; the third press completes the sequence.
      this.doubleClickBlock(line, title, true)
    } else {
      this.engine.setSelection(line, line)
      this.app.selectionFlashUntil = undefined
    }
    this.focus("scrollback")
    this.press = { x: ev.x, y: ev.y, region: "scrollback", line, moved: false, button: ev.button }
    this.drag = undefined
    this.autoscrollDir = 0
    this.changed()
  }

  /** Multi-click semantic per block class (spec §3): bg-task/subagent → open
   * their viewer/fullscreen (absent → honest no-op+toast); prompt entry
   * (User/Edit) → fold + scroll-top (inline edit gated); everything else →
   * fold-toggle (group headers fold the WHOLE group — the engine's
   * toggleFoldAt handles the group unit). `third` = the triple-click completes
   * the sequence: fold + to-top — re-toggling a fold the d2 already applied
   * would UNDO it, so the fold re-fires only for the subagent class (which d2
   * left unfolded) and the scroll-top always runs. */
  private doubleClickBlock(line: number, title: string, third: boolean): void {
    const subagentClass = title.startsWith("Started ") || title.startsWith("Completed ") || title.startsWith("Failed ")
    if (third) {
      if (subagentClass) this.engine.toggleFoldAt(line)
      this.changeScroll(0, false)
      return
    }
    if (subagentClass) {
      this.hookOr(this.hooks.openSubagentViewer, "viewer (M46c)", title)
      return
    }
    if (title === "User" || title === "Edit") {
      // prompt entry — fold + scroll-top (inline edit gated: M46c).
      this.engine.toggleFoldAt(line)
      this.changeScroll(0, false)
      this.toast("inline edit (M46c) — folded + scrolled to top")
      return
    }
    this.engine.toggleFoldAt(line)
  }

  private statusDown(ev: MouseCellEvent, ctx: Rect): void {
    // Left cwd/path → copy.
    const span = statusPathSpan(this.app.status)
    const pathStart = ctx.x + span.start
    if (ev.x >= pathStart && ev.x < ctx.x + span.end) {
      this.copyToClipboard(this.app.status.path)
      this.toastCopied()
      return
    }
    // Right chips → per-chip behavior.
    const kind = statusChipAt(this.app, this.glyphs, ctx, ev.x)
    if (kind === undefined) return
    switch (kind) {
      case "tasks": {
        // tasks chip → pane toggle (the app's own Set — the loop's toggle).
        if (this.app.panes.has("tasks")) this.app.panes.delete("tasks")
        else this.app.panes.add("tasks")
        this.changed()
        break
      }
      case "context": {
        // 300ms-debounced usage panel (double-click storm → one open).
        if (this.contextTimer !== undefined) clearTimeout(this.contextTimer)
        this.contextTimer = setTimeout(() => {
          this.hookOr(this.hooks.openUsagePanel, "usage panel (M46c)")
        }, CONTEXT_CLICK_DEBOUNCE)
        break
      }
      case "goal": this.hookOr(this.hooks.openGoalDetail, "goal detail: no active goal"); break
      case "plan": this.hookOr(this.hooks.openPlanView, "plan view (M46c)"); break
      case "mcp":
      case "queue":
      case "todo": break // chips without click semantics: informative only
    }
  }

  private tasksDown(ev: MouseCellEvent, ctx: Rect): void {
    const groups = this.app.paneData?.tasks
    if (groups === undefined) return
    const rows = flattenTasks(groups)
    const idx = ev.y - ctx.y
    const row = rows[idx]
    if (row === undefined) return
    if (row.header) {
      // Group header → toggle the group's collapsed state (real state delta).
      const g = groups[row.group]
      groups[row.group] = { ...g, collapsed: !g.collapsed }
      this.changed()
      return
    }
    const rightW = row.right === undefined ? 0 : strWidth(row.right) + 1
    if (rightW > 0 && ev.x >= ctx.x + ctx.w - rightW + 1 && ev.x < ctx.x + ctx.w) {
      if (row.right === "[✗]") this.hookOr(this.hooks.sendBackgroundTaskCancel, "cancel task (M46c)", row.label)
      else this.hookOr(this.hooks.openSubagentViewer, "viewer (M46c)", row.label)
      return
    }
    // body click — no row action semantics (spec: the per-row BUTTONS are the
    // interactive parts).
  }

  private todoDown(ev: MouseCellEvent, ctx: Rect): void {
    const pane = this.app.paneData
    if (pane?.todo === undefined) return
    const idx = ev.y - ctx.y
    const item = pane.todo[Math.min(idx, pane.todo.length - 1)]
    if (item === undefined) return
    const itemIdx = Math.min(idx, pane.todo.length - 1)
    this.app.paneData = { ...pane, todoSelect: itemIdx }
    this.changed()
  }

  private queueDown(ev: MouseCellEvent, ctx: Rect): void {
    const pane = this.app.paneData
    const rows = pane?.queue
    if (rows === undefined) return
    const idx = ev.y - ctx.y
    const row = rows[Math.min(idx, rows.length - 1)]
    if (row === undefined) return
    const right = row.action === "cancel" ? "[cancel]" : row.action === "send" ? "[Send now]" : undefined
    const rightW = right === undefined ? 0 : strWidth(right) + 1
    if (rightW > 0 && ev.x >= ctx.x + ctx.w - rightW + 1 && ev.x < ctx.x + ctx.w) {
      if (row.action === "cancel") this.hookOr(this.hooks.queueCancel, "queue cancel (M46c)", row.n)
      else this.hookOr(this.hooks.queueSendNow, "queue send-now (M46c)", row.n)
    }
  }

  private dropdownDown(ev: MouseCellEvent, dd: Rect): void {
    const total = dropdownTotal(this.app)
    if (total <= 0) return
    // Right scrollbar column (slash/completion draw one) → proportional jump.
    if (ev.x === dd.x + dd.w - DROPDOWN_BAR_W && dropdownHasBar(this.app)) {
      const frac = (ev.y - dd.y) / Math.max(1, dd.h - 1)
      this.setDropdownCursor(Math.trunc(frac * Math.max(0, total - dd.h)))
      return
    }
    const idx = Math.max(0, ev.y - dd.y)
    this.setDropdownCursor(Math.min(Math.max(0, total - 1), idx))
    this.hooks.overlaySelectRow?.(Math.min(Math.max(0, total - 1), idx))
  }

  /* -------------------------------------------------------------- motion */

  private onMotion(ev: MouseCellEvent): void {
    if (this.scrollbarLatchY !== undefined) {
      const layout = this.layout()
      if (layout !== undefined) this.jumpToFraction(ev.y, layout.scrollback)
      return
    }
    if (this.linkArm !== undefined && ev.drag) this.linkArm = undefined
    const press = this.press
    if (press === undefined) return
    const moved = press.moved || Math.abs(ev.x - press.x) + Math.abs(ev.y - press.y) >= 1
    if (!moved) return
    press.moved = true

    if (press.region === "prompt") {
      if (this.drag === undefined) {
        this.drag = { region: "prompt", anchorChar: press.char ?? 0, pointerChar: press.char ?? 0 }
      }
      const layout = this.layout()
      if (layout === undefined) return
      const c = promptCursorAtCell(layout.prompt, this.app.prompt, ev.x, ev.y)
      const d = this.drag
      if (d !== undefined && d.region === "prompt") {
        d.pointerChar = c
        this.app.promptSelect = { a: Math.min(d.anchorChar ?? 0, c), b: Math.max(d.anchorChar ?? 0, c) }
        this.changed()
      }
      return
    }

    if (press.region === "scrollback") {
      const layout = this.layout()
      if (layout === undefined) return
      const total = this.engine.lineCount()
      // Lost-up recovery: the button is ALREADY up (drag=false) while a moved
      // press still looks active — the release was LOST; finalise the drag
      // NOW (the auto-copy still runs).
      if (!ev.drag && this.drag !== undefined) {
        this.finalizeDrag()
        return
      }
      const ptr = this.lineAt(layout, ev.y, total)
      if (this.drag === undefined) {
        // Promote: the first ≥1-cell movement leaves the STICKY tail — the
        // drag is an explicit scroll-back (mirrors scrollBy's follow-off).
        if (this.app.scroll.follow) this.app.scroll = { offset: this.scrollOff(layout, total), follow: false }
        this.drag = { region: "scrollback", anchorLine: press.line ?? ptr, pointerLine: ptr }
      } else {
        this.drag.pointerLine = ptr
      }
      this.engine.setSelection(Math.min(this.drag.anchorLine ?? ptr, ptr), Math.max(this.drag.anchorLine ?? ptr, ptr))
      this.updateAutoscroll(ev.y, layout.scrollback)
      this.changed()
      return
    }

    // Lost-up recovery (prompt drags): a no-button motion while a prompt drag
    // is still open finalises it (copy-on-up parity).
    if (press.moved && !ev.drag && this.drag !== undefined) this.finalizeDrag()
  }

  private updateAutoscroll(row: number, sb: Rect): void {
    const top = row - sb.y
    const bottom = sb.h - 1 - top
    if (top >= 0 && top <= 3) {
      this.autoscrollDir = -1
      this.autoscrollDist = top
    } else if (bottom >= 0 && bottom <= 3) {
      this.autoscrollDir = 1
      this.autoscrollDist = bottom
    } else {
      this.autoscrollDir = 0
      this.autoscrollDist = 0
    }
  }

  private autoscrollStep(): void {
    const layout = this.layout()
    if (layout === undefined || this.drag === undefined || this.drag.region !== "scrollback" || this.autoscrollDir === 0) return
    const total = this.engine.lineCount()
    const sb = layout.scrollback
    const max = Math.max(0, total - sb.h + 1)
    const rows = [5, 3, 2, 1][this.autoscrollDist] ?? 1 // distance bands 0/1/2/3
    const cur = this.scrollOff(layout, total)
    const next = Math.max(0, Math.min(max, cur + this.autoscrollDir * rows))
    this.app.scroll = { offset: next, follow: false }
    // Follow the pointer line into the newly revealed rows.
    const anchor = this.drag.anchorLine ?? cur
    const pointer = this.drag.pointerLine ?? anchor
    const ptrNow = next + (pointer - cur)
    this.drag.pointerLine = Math.max(0, Math.min(total - 1, ptrNow))
    const a = Math.min(anchor, this.drag.pointerLine)
    const b = Math.max(anchor, this.drag.pointerLine)
    this.engine.setSelection(a, b)
    this.changed()
  }

  /* ----------------------------------------------------------------- up */

  private onUp(ev: MouseCellEvent): void {
    if (this.linkArm !== undefined) {
      if (ev.x === this.linkArm.x && ev.y === this.linkArm.y) {
        this.hookOr(this.hooks.openLink, "open link (M46c)", this.linkArm.url)
      }
      this.linkArm = undefined
      return
    }
    if (this.scrollbarLatchY !== undefined) {
      this.scrollbarLatchY = undefined // drag-continuous during motion; up ends
      return
    }
    if (this.drag !== undefined) this.finalizeDrag()
    this.press = undefined
  }

  private finalizeDrag(): void {
    const d = this.drag
    this.drag = undefined
    this.press = undefined
    this.autoscrollDir = 0
    this.autoscrollDist = 0
    if (d === undefined) return
    if (d.region === "prompt") {
      const p = this.app.prompt
      const a = Math.min(d.anchorChar ?? p.cursor, d.pointerChar ?? p.cursor)
      const b = Math.max(d.anchorChar ?? p.cursor, d.pointerChar ?? p.cursor)
      const text = p.text.slice(a, b)
      this.app.promptSelect = undefined
      if (text.length > 0) {
        this.copyToClipboard(text)
        this.toastCopied()
      }
      this.changed()
      return
    }
    // scrollback: selected display lines → auto-copy + flash.
    const total = this.engine.lineCount()
    const a = Math.min(d.anchorLine ?? 0, d.pointerLine ?? 0)
    const b = Math.max(d.anchorLine ?? 0, d.pointerLine ?? 0)
    const text = this.selectedText(a, b, total)
    if (text.length > 0) {
      this.copyToClipboard(text)
      this.toastCopied()
    }
    this.app.selectionFlashUntil = this.now() + DEFAULT_SELECTION_HIGHLIGHT_DURATION_MS
    this.changed()
  }

  /** Display-line selection text (lines a..b inclusive, newline-joined). */
  private selectedText(a: number, b: number, total: number): string {
    const lo = Math.max(0, Math.min(total - 1, a))
    const hi = Math.max(lo, Math.min(total - 1, b))
    const lines = this.engine.viewport(0, total)
    return lines.slice(lo, hi + 1).map((l) => toStringsFromRuns(l.runs)).join("\n")
  }

  /* ---------------------------------------------------------- word_select */

  private wordSelect(line: number, x: number, layout: AgentLayout): void {
    const total = this.engine.lineCount()
    const lines = this.engine.viewport(0, total)
    const dl = lines[line]
    const text = dl === undefined ? "" : toStringsFromRuns(dl.runs)
    const col = x - this.textStartOf(layout)
    const url = urlAt(text, col)
    const word = url ?? wordAt(text, col)
    const sel = word ?? text
    this.engine.setSelection(line, line)
    this.app.selectionFlashUntil = undefined
    this.copyToClipboard(sel)
    this.toastCopied()
  }

  /** Paragraph (simplified: display lines delimited by blank lines, table-cell
   * detection per spec simplified to paragraph). */
  private selectAt(line: number, _mode: string): void {
    const total = this.engine.lineCount()
    const lines = this.engine.viewport(0, total)
    const isEmpty = (i: number): boolean => {
      const l = lines[i]
      return l === undefined || toStringsFromRuns(l.runs).trim() === ""
    }
    let a = line
    while (a - 1 >= 0 && !isEmpty(a - 1)) a--
    let b = line
    while (b + 1 < lines.length && !isEmpty(b + 1)) b++
    // If the click sits ON a blank line: anchor at the line itself.
    if (isEmpty(line)) {
      this.engine.setSelection(line, line)
      return
    }
    this.engine.setSelection(Math.max(a, 0), Math.min(b, total - 1))
  }

  /* ------------------------------------------------------------ scrollbar */

  private jumpToFraction(row: number, sb: Rect): void {
    const total = this.engine.lineCount()
    const max = Math.max(0, total - sb.h + 1)
    const frac = (row - sb.y) / Math.max(1, sb.h - 1)
    const offset = Math.round(Math.max(0, Math.min(1, frac)) * max)
    this.changeScroll(offset, false)
  }

  /* ----------------------------------------------------------- dropdowns */

  private setDropdownCursor(index: number): void {
    const app = this.app
    if (app.slash !== undefined) app.slash.cursor = index
    else if (app.completion !== undefined) app.completion.cursor = index
    else if (app.fileSearch !== undefined) app.fileSearch.cursor = index
    else if (app.historyPanel !== undefined) app.historyPanel.cursor = index
    else if (app.sessions !== undefined) app.sessions.cursor = index
    else if (app.lightPanel !== undefined) app.lightPanel.cursor = index
    this.changed()
  }

  /* -------------------------------------------------------------- helpers */

  /** Router-host bridge: call the hook with the args, else honest toast. */
  private hookOr<T extends unknown[]>(fn: ((...a: T) => void) | undefined, fallbackText: string, ...args: T): void {
    if (fn !== undefined) {
      fn(...args)
      return
    }
    this.toast(fallbackText)
  }
}

// ------------------------------------------------------------------ pure helpers (exported for tests)

/** URL at the given in-line column (regex `https?://` / `www.` runs). */
export function urlAt(text: string, col: number): string | undefined {
  const re = /(?:https?:\/\/|www\.)[^\s"'<>(),;]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    if (col >= start && col < start + m[0].length) return m[0]
  }
  return undefined
}

/** Word at the given in-line column (letters/digits/underscore + CJK runs). */
export function wordAt(text: string, col: number): string | undefined {
  const re = /[\p{L}\p{N}_]+/gu
  for (const m of text.matchAll(re)) {
    const start = m.index
    const len = m[0].length
    if (col >= start && col < start + len) return m[0]
  }
  return undefined
}

/** `path/file.ext[:line]` / `file.xyz` reference at an in-line column
 * (approximate: the longest dotted path run ending at a known extension). */
export function fileRefAt(text: string, col: number): { file: string; line?: number } | undefined {
  const re = /([\w][\w./\\-]*\.[A-Za-z0-9]{1,8})(?::(\d+))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const len = m[0].length
    if (col >= start && col < start + len) {
      const file = m[1]
      const line = m[2] !== undefined ? Number(m[2]) : undefined
      return { file, ...(line !== undefined && line > 0 ? { line } : {}) }
    }
  }
  return undefined
}

/** `[Pasted: N lines]` chip at an in-line column. */
export function pasteChipAt(text: string, col: number): { lines: number } | undefined {
  const re = /\[Pasted:\s*(\d+)\s*lines?\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const len = m[0].length
    if (col >= start && col < start + len) return { lines: Number(m[1]) }
  }
  return undefined
}

/** Status chip hit-testing: right chip under the column (or undefined). */
export function statusChipAt(app: TuiAppState, glyphs: GlyphSet, ctx: Rect, col: number): "tasks" | "plan" | "goal" | "mcp" | "context" | "queue" | "todo" | undefined {
  const pieces = statusChipsOf(app.status, glyphs)
  let totalW = 0
  for (const p of pieces) totalW += (p.sepBefore ? 3 : 0) + strWidth(p.text)
  let x = ctx.x + ctx.w - totalW
  for (const p of pieces) {
    const w = (p.sepBefore ? 3 : 0) + strWidth(p.text)
    if (col >= x && col < x + w) return p.kind
    x += w
  }
  return undefined
}

/** Flattened tasks pane rows (header + entries) for click mapping — same order
 * as renderTasksPane's flatten. */
export interface TasksHitRow {
  header: boolean
  group: number
  label: string
  right?: string
}

export function flattenTasks(groups: TaskGroup[]): TasksHitRow[] {
  const rows: TasksHitRow[] = []
  groups.forEach((g, gi) => {
    rows.push({ header: true, group: gi, label: g.label, right: undefined })
    for (const e of g.entries) {
      rows.push({
        header: false,
        group: gi,
        label: e.label,
        right: e.action === "cancel" ? "[✗]" : e.action === "expand" ? "[↗]" : undefined,
      })
    }
  })
  return rows
}

/** Total row count of the open dropdown (for the scrollbar-column jump). */
export function dropdownTotal(app: TuiAppState): number {
  if (app.slash !== undefined) return app.slash.entries.length
  if (app.completion !== undefined) return app.completion.entries.length
  if (app.fileSearch !== undefined) return app.fileSearch.files.length
  if (app.historyPanel !== undefined) return app.historyPanel.entries.length
  if (app.sessions !== undefined) return flattenSessions(app.sessions).length
  if (app.lightPanel !== undefined) return app.lightPanel.rows.length
  return 0
}

/** Does the open dropdown draw a 1-col scrollbar (slash/completion only —
 * the two renderers with a bar column; the cap is the renderer's MAX_ROWS —
 * the bar appears when rows exceed the cap at a box ≥ the cap). */
export function dropdownHasBar(app: TuiAppState): boolean {
  if (app.slash !== undefined) return app.slash.entries.length > SLASH_MAX_ROWS
  if (app.completion !== undefined) return app.completion.entries.length > COMPLETION_MAX_ROWS
  return false
}
