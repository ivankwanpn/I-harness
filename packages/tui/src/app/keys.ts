// @i-harness/tui — G2: keymap dispatch (UI spec §4, M37a subset + M37b full).
// Pure table — no mutation; the loop turns AppActions into behavior. Routing
// priority (spec §4 modal/picker/dropdown): welcome screen > overlay/panel
// (permission/question/cancel-turn/history/sessions/dropdown — `overlayKeys`)
// > scrollback focus > prompt focus. ACTION-NAME CONVENTION with G1: the
// overlay actions here are the string names G1's own key fns must reuse
// (overlay-dismiss/select/nav-*/accept — per the harmonization contract).

import type { Shortcut } from "../views/shortcuts.ts"

export type AppAction =
  // scrollback (spec §4)
  | "scroll-up" | "scroll-down" | "page-up" | "page-down"
  | "goto-top" | "goto-bottom" | "prev-turn" | "next-turn"
  | "toggle-fold" | "toggle-expand-all" | "copy-block"
  | "focus-scrollback" | "focus-prompt"
  // prompt (spec §4)
  | "submit" | "newline" | "interject" | "cancel-turn"
  | "toggle-multiline" | "cycle-mode"
  // global / panes / sessions (spec §4 · Ctrl-T/B/;/S/N/Q/P)
  | "toggle-todo-pane" | "toggle-tasks-pane" | "toggle-queue-pane"
  | "sessions" | "sessions-new"
  | "quit" | "quit-arm1"
  | "history-prev" | "history-next"
  | "open-command-palette"
  | "none"
  // overlay / modal / dropdown / picker (spec §4 modal & dropdown keys)
  | "overlay-select"                 // Enter / Tab accept
  | "overlay-nav-prev" | "overlay-nav-next"          // ↑↓/j k / Ctrl-P N
  | "overlay-page-prev" | "overlay-page-next"        // PgUp PgDn
  | "overlay-dismiss"                // Esc
  | "overlay-copy"                   // y
  | "overlay-expand" | "overlay-collapse"            // e / E (Ctrl-F on permission)
  | "overlay-toggle"                 // Space
  | "overlay-tab" | "overlay-tab-back"               // Tab / Shift-Tab
  | "overlay-search"                 // / i (history/sessions)
  | "overlay-filter"                 // f (history/sessions)
  | "overlay-range-left" | "overlay-range-right"     // ←/→ permission scope
  | "overlay-question-prev" | "overlay-question-next" // [ ] question
  | { type: "overlay-accept"; index: number }        // digits 1-9
  // welcome (spec §2a)
  | "menu-up" | "menu-down" | "menu-top" | "menu-bottom"
  | "menu-activate"

/** The keymap sees a normalized key event (mirrors tui-core KeyEvent). */
export interface Kbd {
  /** "Enter" | "Esc" | "Tab" | "ShiftTab" | "Up"/"Down" | "char" | "PageUp"… */
  code: string
  /** Payload: the character for `code: "char"` events ("k", "c", "\t"…). */
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export type OverlayKind =
  | "permission" | "question" | "cancel-turn"
  | "dropdown" | "history" | "sessions"

export interface KeymapState {
  focused: "prompt" | "scrollback"
  promptText: string
  multiLine: boolean
  turnRunning: boolean
  /** Ctrl-C/Esc arming state of the double-arm quit (spec §4). */
  armedQuit: boolean
  searchActive: boolean
  /** Open overlay/panel that preempts the base keymap (spec §4). */
  overlay?: OverlayKind
  /** Dropdown flavor while overlay === "dropdown". */
  dropdown?: "slash" | "completion" | "file-search"
  /** True on the welcome screen (spec §2a). */
  welcome?: boolean
  /** True in minimal mode (M38a — spec §1.1): the prompt is ALWAYS focused
   * and there is no scrollback surface; Esc is a no-op guard. */
  minimal?: boolean
}

const isShiftTab = (ev: Kbd): boolean =>
  ev.code === "ShiftTab" || // CSI Z / kitty CSI-u encoding
  (ev.code === "Tab" && ev.shift) || // legacy tab+shift combo
  (ev.code === "Tab" && ev.key === "Z") // xterm shifted-tab fallback

export function dispatchKey(ev: Kbd, state: KeymapState): AppAction {
  // Welcome screen routes everything through its own table (spec §2a).
  if (state.welcome === true) return welcomeKey(ev)
  // Overlay/panel/dropdown preempts the base keymap (spec §4) — an open
  // slash dropdown still gets its accept/nav keys in minimal mode.
  if (state.overlay !== undefined) return overlayKeys(ev, state.overlay)
  // Minimal mode (M38a): quick-prompt table — Enter submits, Esc is a
  // no-op guard (no scrollback surface, no quit-arming on the quick prompt;
  // `/minimal`/`/fullscreen` relay lives in the loop's submit path).
  if (state.minimal === true) return minimalKey(ev)

  if (state.focused === "scrollback") {
    switch (ev.code) {
      case "Down": return "scroll-down"
      case "Up": return "scroll-up"
      case "PageUp": return "page-up"
      case "PageDown": return "page-down"
      // spec: l/→ = unfold — the engine fold API toggles at a line, so M37a
      // routes both directions through toggle-fold (explicit unfold: M38).
      case "Left": case "Right": return "toggle-fold"
      case "Tab": return "focus-prompt"
      case "Esc": return "none" // M37b: unselect / close search
    }
    if (ev.code === "char" && !ev.ctrl && !ev.alt) {
      switch (ev.key) {
        case "j": return "scroll-down"
        case "k": return "scroll-up"
        case "g": return "goto-top"
        case "G": return "goto-bottom"
        case "L": return "next-turn"
        case "H": return "prev-turn"
        case "h": case "l": case "e": return "toggle-fold"
        case "E": return "toggle-expand-all"
        case "y": return "copy-block" // handler shows the toast; clipboard M38
      }
    }
    return "none"
  }

  // ---- prompt focused
  if (ev.code === "Enter") {
    if (ev.ctrl) return "interject" // send-now: cancel + send
    if (ev.shift || ev.alt) return "newline"
    return state.multiLine ? "newline" : "submit"
  }
  if (ev.code === "Esc") {
    if (state.promptText.length > 0) return "cancel-turn" // loop clears the draft
    return state.armedQuit ? "quit" : "quit-arm1"
  }
  if (ev.code === "Tab") {
    if (isShiftTab(ev)) return "cycle-mode" // Normal → Plan → Always-Approve
    return "focus-scrollback"
  }
  if (ev.code === "ShiftTab") return "cycle-mode"
  if (ev.code === "Up") return state.promptText.length === 0 ? "history-prev" : "none"
  if (ev.code === "Down") return state.promptText.length === 0 ? "history-next" : "none"
  if (ev.code === "char" && ev.ctrl) {
    switch (ev.key) {
      case "c":
        // non-empty: clear draft; empty: cancel the turn and arm the quit;
        // the SECOND empty Ctrl-C (armed) goes through quit-arm1 → quit.
        if (state.promptText.length > 0) return "cancel-turn"
        return state.armedQuit ? "quit-arm1" : "cancel-turn"
      case "m": return "toggle-multiline"
      case "q": return "quit"
      case "t": return "toggle-todo-pane"
      case "b": return "toggle-tasks-pane"
      case ";": return "toggle-queue-pane" // spec §4: Ctrl+; queue pane
      case "s": return "sessions"
      case "n": return "sessions-new" // spec §4: Ctrl+N new session
      case "p": return "open-command-palette"
      default: return "none"
    }
  }
  if (ev.code === "char" && !ev.alt) {
    // spec §4: `?` (with a prompt open… on an empty editor) opens the palette.
    if (ev.key === "?" && state.promptText.length === 0) return "open-command-palette"
  }
  // M37b: emacs motion, paste, char editing (the loop edits text directly).
  return "none"
}

/**
 * Minimal-mode keys (M38a, spec §1.1): the quick prompt is the only surface.
 * Enter submits (Ctrl+Enter interjects); Esc is a no-op GUARD — the draft
 * is not cleared and there is no quit-arming (Ctrl+C on an empty prompt is
 * also a no-op); Ctrl+Q quits; Ctrl+S opens the session picker. Slash
 * commands route through the loop's submit text match (ModeSwitch relay).
 */
export function minimalKey(ev: Kbd): AppAction {
  if (ev.code === "Enter") {
    if (ev.ctrl) return "interject"
    if (ev.shift || ev.alt) return "newline"
    return "submit"
  }
  if (ev.code === "Esc") return "none"
  if (ev.code === "char" && ev.ctrl) {
    switch (ev.key) {
      case "q": return "quit"
      case "s": return "sessions"
      case "m": return "toggle-multiline"
      default: return "none"
    }
  }
  return "none"
}

/**
 * Overlay keys (spec §4 — modal/picker/dropdown). G1's rendering fns keep
 * their own view logic; this table is the shared action seam (G1 reuses the
 * same action strings — harmonization contract).
 */
export function overlayKeys(ev: Kbd, kind: OverlayKind): AppAction {
  // Digits: permission 1-9 / question 1-9 / cancel-turn 1-4 (spec §4).
  if (ev.code === "char" && !ev.ctrl && !ev.alt && /^[1-9]$/.test(ev.key)) {
    if (kind === "permission" || kind === "question" || kind === "cancel-turn") {
      return { type: "overlay-accept", index: Number(ev.key) }
    }
  }

  switch (ev.code) {
    case "Esc": return "overlay-dismiss"
    case "Enter": return "overlay-select"
    case "Up": return "overlay-nav-prev"
    case "Down": return "overlay-nav-next"
    case "PageUp": return "overlay-page-prev"
    case "PageDown": return "overlay-page-next"
    case "Left": return kind === "permission" ? "overlay-range-left" : "overlay-collapse"
    case "Right": return kind === "permission" ? "overlay-range-right" : "overlay-expand"
    case "Tab": return isShiftTab(ev) ? "overlay-tab-back" : "overlay-tab"
    case "ShiftTab": return "overlay-tab-back"
  }

  if (ev.code === "char") {
    if (ev.ctrl) {
      switch (ev.key) {
        case "f": return "overlay-expand" // permission: expand args (spec §4)
        case "p": return "overlay-nav-prev" // dropdown Ctrl-P/Ctrl-N (spec §4)
        case "n": return "overlay-nav-next"
        case "y": return "overlay-copy" // question Ctrl+Y close → G1 handles
        case "c": return "overlay-dismiss" // question submit/cancel → G1 handles
      }
      return "none"
    }
    if (ev.alt) return "none"
    switch (ev.key) {
      case "j": return "overlay-nav-prev"
      case "k": return "overlay-nav-next"
      case "y": return "overlay-copy"
      case "e": return "overlay-expand"
      case "E": return "overlay-collapse"
      case " ": return "overlay-toggle"
      case "/":
      case "i":
        return kind === "history" || kind === "sessions" ? "overlay-search" : "none"
      case "f":
        return kind === "history" || kind === "sessions" ? "overlay-filter" : "none"
      case "]": return kind === "question" ? "overlay-question-next" : "none"
      case "[": return kind === "question" ? "overlay-question-prev" : "none"
    }
  }
  return "none"
}

/** Welcome screen keys (spec §2a/§4): ↑/↓ (j/k) navigate, Enter activate,
 * g/l top/bottom, q quits; ctrl+s/n activate the matching menu row. */
export function welcomeKey(ev: Kbd): AppAction {
  if (ev.code === "Enter" || ev.code === "Tab") return "menu-activate"
  if (ev.code === "Up") return "menu-up"
  if (ev.code === "Down") return "menu-down"
  if (ev.code === "char") {
    if (ev.ctrl) {
      return "menu-activate" // ctrl+s/N/q/key → the loop activates the cursor row
    }
    if (ev.alt) return "none"
    switch (ev.key) {
      case "j": return "menu-down"
      case "k": return "menu-up"
      case "g": return "menu-top"
      case "G": case "l": return "menu-bottom"
      case "q": return "quit"
    }
  }
  return "none"
}

export interface ShortcutStateFor {
  focused: "prompt" | "scrollback"
  multiLine: boolean
  turnRunning: boolean
  mode: "normal" | "plan"
}

/** ShortcutsBar content (spec §3.5) for the current focus/state. */
export function shortcutsFor(state: ShortcutStateFor): Shortcut[] {
  if (state.focused === "scrollback") {
    return [
      { key: "j/k", label: "scroll" },
      { key: "g/G", label: "top/bottom" },
      { key: "L/H", label: "turn" },
      { key: "h/l", label: "fold" },
      { key: "e/E", label: "fold/all" },
      { key: "y", label: "copy" },
      { key: "Tab", label: "prompt" },
      { key: "Ctrl+Q", label: "quit" },
    ]
  }
  const items: Shortcut[] = [
    { key: "Enter", label: state.multiLine ? "newline" : "submit" },
    { key: "Ctrl+Enter", label: "interject" },
    { key: "Ctrl+M", label: "multiline" },
    { key: "Shift+Tab", label: "mode" },
    { key: "Esc", label: "clear" },
  ]
  if (state.turnRunning) items.push({ key: "Ctrl+C", label: "stop" })
  items.push({ key: "Ctrl+S", label: "sessions" })
  items.push({ key: "Ctrl+Q", label: "quit" })
  return items
}
