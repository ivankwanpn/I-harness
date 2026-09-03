// @i-harness/tui — G2: the app event loop (M37a).
// Three sources merge per tick: injected input (host wires tui-core
// attachInput → InputSource), backend.events() (live stream, 16ms-batched by
// the backend bridge), and the 30fps animation pump — scheduled ONLY while a
// turn is running or a toast is live ("needs repaint" polling, spec §7).
// Painting is coalesced to one frame per tick; identical frames flush "" to
// the write sink (zero-byte idle, M36).

import type {
  GlyphSet,
  InputEvent,
  Palette,
  Renderer,
  TerminalCapabilityContext,
} from "@i-harness/tui-core"
import type { BackendClient, ScrollbackEngine, TuiEvent } from "../contracts.ts"
import { dispatchKey, shortcutsFor } from "./keys.ts"
import type { AppAction, Kbd, KeymapState } from "./keys.ts"
import { present } from "./present.ts"
import type { TuiAppState } from "./present.ts"
import type { TurnPhase } from "../views/turn-status.ts"

export interface InputSource {
  next(): AsyncIterable<InputEvent>
}

export interface TuiAppOptions {
  renderer: Renderer
  backend: BackendClient
  engine: ScrollbackEngine
  capabilities: TerminalCapabilityContext
  palette: Palette
  glyphs: GlyphSet
  /** Sink for flush bytes ("", when a frame is identical, writes nothing). */
  write?: (s: string) => void
  input?: InputSource
  compact?: boolean
  /** Test clock — defaults to Date.now(). */
  now?: () => number
}

const ANIM_MS = 33 // 30fps pump

export class TuiApp {
  private readonly opts: TuiAppOptions
  private readonly app: TuiAppState
  private stopped = false
  private frameQueued = false
  private animTimer: ReturnType<typeof setInterval> | null = null
  private runP: Promise<unknown> = Promise.resolve()
  private armedQuit = false
  private turnStartedAt = 0
  private phaseStartedAt = 0

  constructor(opts: TuiAppOptions) {
    this.opts = opts
    const model = "mock-model"
    this.app = {
      title: "untitled",
      mode: "normal",
      engine: opts.engine,
      prompt: { text: "", cursor: 0, multiLine: false, focused: true, model, plan: false, title: "untitled" },
      promptCursor: 0,
      history: [],
      historyIndex: 0,
      scroll: { offset: 0, follow: true },
      focused: "prompt",
      search: undefined,
      status: {
        branch: undefined,
        path: "~/workspace",
        tickMs: 0,
        model,
        plan: false,
        contextUsed: undefined,
        contextTotal: undefined,
        todo: { done: 0, total: 0 },
        tasks: { running: 0, labels: [] },
        queue: 0,
        mcp: null,
      },
      turn: undefined,
      toasts: [],
      panes: new Set<string>(),
      shortcuts: { items: shortcutsFor({ focused: "prompt", multiLine: false, turnRunning: false, mode: "normal" }) },
    }
  }

  /** Coordinator state (the loop mutates; tests/host read). */
  state(): TuiAppState {
    return this.app
  }

  /** Launch the pumps; resolves when the input/backend iterators finish. */
  async start(): Promise<void> {
    this.stopped = false
    this.app.engine.setWidth(this.opts.renderer.buffer.width)
    this.animTimer = setInterval(() => this.animPump(), ANIM_MS)
    this.runP = Promise.all([this.pumpInput(), this.pumpBackend()])
    await this.runP
  }

  /** Idempotent: stops the pumps/timer (a pending IO iterator ends the run). */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.animTimer !== null) {
      clearInterval(this.animTimer)
      this.animTimer = null
    }
    await this.runP
  }

  /** One repaint (coalesced) — present + flush; flush("") = zero-byte idle. */
  frame(): void {
    if (this.stopped) return
    const t = this.opts.now?.() ?? Date.now()
    this.app.toasts = this.app.toasts.filter((toast) => toast.until > t)
    if (this.app.turn !== undefined) {
      const turn = this.app.turn
      turn.nowMs = t
      turn.phaseMs = t - this.phaseStartedAt
      turn.turnMs = t - this.turnStartedAt
    }
    present(this.app, this.opts.renderer, this.opts.palette, this.opts.glyphs, {
      compact: this.opts.compact,
      cap: this.opts.capabilities,
    })
    this.opts.renderer.flush((s) => this.opts.write?.(s))
  }

  /** Keymap/backend/anim results funnel here; the loop paints after. */
  dispatch(action: AppAction): void {
    switch (action) {
      case "scroll-up": this.scrollBy(-3); break
      case "scroll-down": this.scrollBy(3); break
      case "page-up": this.scrollBy(-this.pageStep()); break
      case "page-down": this.scrollBy(this.pageStep()); break
      case "goto-top": this.app.scroll = { offset: 0, follow: false }; break
      case "goto-bottom": this.app.scroll = { offset: 0, follow: true }; break
      case "prev-turn":
      case "next-turn":
        // Turn navigation needs the engine's turn index — M38.
        break
      case "toggle-fold": {
        if (this.app.search?.active === true) break
        const y = this.app.scroll.follow
          ? Math.max(0, this.opts.engine.lineCount() - this.opts.renderer.buffer.height)
          : this.app.scroll.offset
        this.opts.engine.toggleFoldAt(y)
        break
      }
      case "toggle-expand-all": this.opts.engine.toggleExpandAll(); break
      case "copy-block": this.toast("Copied!"); break // clipboard: M38
      case "focus-scrollback": this.focus("scrollback"); break
      case "focus-prompt": this.focus("prompt"); break
      case "submit": this.submitPrompt(); break
      case "newline": {
        const p = this.app.prompt
        p.text += "\n"
        p.cursor = p.text.length
        p.multiLine = true
        this.refreshShortcuts()
        break
      }
      case "interject": {
        const text = this.app.prompt.text.trim()
        if (text.length > 0) {
          void this.opts.backend.steer(text)
          this.clearPrompt()
        }
        break
      }
      case "cancel-turn": {
        if (this.app.prompt.text.trim().length > 0) {
          this.clearPrompt() // Ctrl-C / Esc on a non-empty draft clears it
          break
        }
        if (this.app.turn !== undefined) void this.opts.backend.cancel()
        this.armedQuit = true
        this.toast("Press again to quit")
        break
      }
      case "toggle-multiline": {
        this.app.prompt.multiLine = !this.app.prompt.multiLine
        this.refreshShortcuts()
        break
      }
      case "cycle-mode": {
        // Normal → Plan → Always-Approve; M37a cycles the first two.
        this.app.mode = this.app.mode === "normal" ? "plan" : "normal"
        this.app.status.plan = this.app.mode === "plan"
        this.app.prompt.plan = this.app.mode === "plan"
        this.toast(`Switched to mode: ${this.app.mode.toLowerCase()}`)
        this.refreshShortcuts()
        break
      }
      case "toggle-todo-pane": this.toast("todo pane: M38"); break
      case "toggle-tasks-pane": this.toast("tasks pane: M38"); break
      case "sessions": this.toast("session picker: M38"); break
      case "open-command-palette": this.toast("command palette: M38"); break
      case "quit": void this.quitNow(); break
      case "quit-arm1":
        // First press (Esc-empty / unarmed) arms; a later press quits.
        if (this.armedQuit) void this.quitNow()
        else {
          this.armedQuit = true
          this.toast("Press again to quit")
        }
        break
      case "history-prev": this.historyStep(-1); break
      case "history-next": this.historyStep(1); break
      case "none": break
    }
    this.requestFrame()
  }

  // ------------------------------------------------------------------ input

  private async pumpInput(): Promise<void> {
    const src = this.opts.input
    if (src === undefined) return
    for await (const ev of src.next()) {
      if (this.stopped) break
      this.onInput(ev)
    }
  }

  private async pumpBackend(): Promise<void> {
    for await (const ev of this.opts.backend.events()) {
      if (this.stopped) break
      this.onBackend(ev)
    }
  }

  private animPump(): void {
    if (this.stopped) return
    const t = this.opts.now?.() ?? Date.now()
    this.app.status.tickMs = t
    if (this.needsAnim(t)) this.requestFrame()
  }

  /** "Needs repaint" polling (spec §7): turn running or a live toast. */
  private needsAnim(t: number): boolean {
    if (this.app.turn !== undefined) return true
    for (const toast of this.app.toasts) if (toast.until > t) return true
    return false
  }

  private onInput(ev: InputEvent): void {
    if (ev.type === "paste") {
      if (this.app.focused === "prompt") {
        const p = this.app.prompt
        p.text = p.text.slice(0, p.cursor) + ev.text + p.text.slice(p.cursor)
        p.cursor += ev.text.length
      }
      this.requestFrame()
      return
    }
    if (ev.type !== "key") return
    // Text editing for the prompt comes BEFORE the keymap — M37a subset:
    // printable chars + Backspace/Delete; emacs motion lands M37b.
    if (this.app.focused === "prompt") {
      if (ev.code === "char" && !ev.ctrl && !ev.alt) {
        this.insertText(ev.key)
        return
      }
      if (ev.code === "Backspace") {
        this.backspace()
        return
      }
      if (ev.code === "Delete") {
        const p = this.app.prompt
        p.text = p.text.slice(0, p.cursor) + p.text.slice(p.cursor + 1)
        this.requestFrame()
        return
      }
    }
    const kbd: Kbd = { code: ev.code, key: ev.key, ctrl: ev.ctrl, alt: ev.alt, shift: ev.shift }
    this.dispatch(dispatchKey(kbd, this.keymapState()))
  }

  private keymapState(): KeymapState {
    return {
      focused: this.app.focused,
      promptText: this.app.prompt.text,
      multiLine: this.app.prompt.multiLine,
      turnRunning: this.app.turn !== undefined,
      armedQuit: this.armedQuit,
      searchActive: this.app.search?.active === true,
    }
  }

  private onBackend(ev: TuiEvent): void {
    this.opts.engine.append(ev)
    const now = this.opts.now?.() ?? Date.now()
    switch (ev.type) {
      case "turn":
        if (ev.phase === "start") this.beginTurn("thinking", now)
        else this.app.turn = undefined // finish() → row hides (spec §7)
        break
      case "thinking": {
        const t = this.ensureTurn(now)
        t.phase = "thinking"
        this.phaseStartedAt = now
        break
      }
      case "assistant": {
        const t = this.ensureTurn(now)
        t.phase = "responding"
        this.phaseStartedAt = now
        break
      }
      case "tool": {
        const t = this.ensureTurn(now)
        t.phase = "responding"
        break
      }
      case "compaction":
        if (ev.phase === "start") {
          const t = this.ensureTurn(now)
          t.phase = "compacting"
          this.phaseStartedAt = now
        }
        break
      case "todo": {
        let done = 0
        for (const item of ev.items) if (item.status === "completed") done++
        this.app.status.todo = { done, total: ev.items.length }
        break
      }
      case "goal":
        if (ev.label !== undefined) this.app.status.goal = ev.label
        break
      case "title":
        this.app.title = ev.title
        this.app.prompt.title = ev.title
        break
      case "plan": {
        this.app.mode = ev.phase === "on" ? "plan" : "normal"
        this.app.status.plan = this.app.mode === "plan"
        this.app.prompt.plan = this.app.mode === "plan"
        break
      }
      case "user":
      case "user/edit":
      case "system":
        break // engine.append handled the visible surface
    }
    this.requestFrame()
  }

  private ensureTurn(now: number): NonNullable<TuiAppState["turn"]> {
    if (this.app.turn === undefined) this.beginTurn("thinking", now)
    return this.app.turn!
  }

  private beginTurn(phase: TurnPhase, at: number): void {
    this.turnStartedAt = at
    this.phaseStartedAt = at
    this.app.turn = {
      phase,
      attempts: 1,
      phaseMs: 0,
      turnMs: 0,
      tokens: 0,
      nowMs: at,
      canStop: true,
    }
    this.refreshShortcuts()
  }

  // ------------------------------------------------------------------ behaviors

  private focus(target: "prompt" | "scrollback"): void {
    this.app.focused = target
    this.refreshShortcuts()
  }

  private scrollBy(dy: number): void {
    const total = this.opts.engine.lineCount()
    const page = this.opts.renderer.buffer.height
    const max = Math.max(0, total - page + 1)
    this.app.scroll.follow = false
    this.app.scroll.offset = Math.max(0, Math.min(max, this.app.scroll.offset + dy))
  }

  private pageStep(): number {
    return Math.max(1, Math.floor(this.opts.renderer.buffer.height / 2))
  }

  private submitPrompt(): void {
    const text = this.app.prompt.text.trim()
    if (text.length === 0) return // queue-top force-send lands M38 (spec §4)
    this.app.history.push(this.app.prompt.text)
    this.app.historyIndex = this.app.history.length
    this.clearPrompt()
    void this.opts.backend.submit(text)
  }

  private insertText(s: string): void {
    const p = this.app.prompt
    p.text = p.text.slice(0, p.cursor) + s + p.text.slice(p.cursor)
    p.cursor += s.length
    this.requestFrame()
  }

  private backspace(): void {
    const p = this.app.prompt
    if (p.cursor <= 0) return
    p.text = p.text.slice(0, p.cursor - 1) + p.text.slice(p.cursor)
    p.cursor -= 1
    this.requestFrame()
  }

  private clearPrompt(): void {
    this.app.prompt.text = ""
    this.app.prompt.cursor = 0
    this.refreshShortcuts()
  }

  private historyStep(dir: 1 | -1): void {
    const h = this.app.history
    if (h.length === 0) return
    if (dir === 1) {
      if (this.app.historyIndex >= h.length - 1) {
        this.app.historyIndex = h.length
        this.app.prompt.text = ""
        this.app.prompt.cursor = 0
        return
      }
    }
    let i = Math.max(0, Math.min(h.length, this.app.historyIndex + dir))
    if (i >= h.length) i = h.length - 1
    this.app.historyIndex = i
    this.app.prompt.text = h[i]
    this.app.prompt.cursor = h[i].length
  }

  private refreshShortcuts(): void {
    this.app.shortcuts = {
      items: shortcutsFor({
        focused: this.app.focused,
        multiLine: this.app.prompt.multiLine,
        turnRunning: this.app.turn !== undefined,
        mode: this.app.mode,
      }),
    }
  }

  private toast(text: string): void {
    const until = (this.opts.now?.() ?? Date.now()) + 3000
    this.app.toasts.push({ text, until })
    if (this.app.toasts.length > 3) this.app.toasts.shift()
    this.requestFrame()
  }

  private async quitNow(): Promise<void> {
    this.armedQuit = false
    try {
      await this.opts.backend.close()
    } finally {
      await this.stop()
    }
  }

  private requestFrame(): void {
    if (this.frameQueued || this.stopped) return
    this.frameQueued = true
    queueMicrotask(() => {
      this.frameQueued = false
      if (!this.stopped) this.frame()
    })
  }
}
