// @i-harness/tui — G2: keymap dispatch (UI spec §4, M37a subset).
// Pure table — no mutation; the loop turns AppActions into behavior. M37b
// completes the table: emacs text motion (Ctrl-A/E/W/U/K/Y/Z), scrollback
// search nav (n/N/↕), Ctrl-O always-approve, model picker, modals.

import type { Shortcut } from "../views/shortcuts.ts"

export type AppAction =
  | "scroll-up" | "scroll-down" | "page-up" | "page-down"
  | "goto-top" | "goto-bottom" | "prev-turn" | "next-turn"
  | "toggle-fold" | "toggle-expand-all" | "copy-block"
  | "focus-scrollback" | "focus-prompt"
  | "submit" | "newline" | "interject" | "cancel-turn"
  | "toggle-multiline" | "cycle-mode"
  | "toggle-todo-pane" | "toggle-tasks-pane" | "sessions"
  | "quit" | "quit-arm1" | "history-prev" | "history-next"
  | "open-command-palette" | "none"

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

export interface KeymapState {
  focused: "prompt" | "scrollback"
  promptText: string
  multiLine: boolean
  turnRunning: boolean
  /** Ctrl-C/Esc arming state of the double-arm quit (spec §4). */
  armedQuit: boolean
  searchActive: boolean
}

const isShiftTab = (ev: Kbd): boolean =>
  ev.code === "ShiftTab" || // CSI Z / kitty CSI-u encoding
  (ev.code === "Tab" && ev.shift) || // legacy tab+shift combo
  (ev.code === "Tab" && ev.key === "Z") // xterm shifted-tab fallback

export function dispatchKey(ev: Kbd, state: KeymapState): AppAction {
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
      case "s": return "sessions"
      case "p": return "open-command-palette"
      default: return "none"
    }
  }
  // M37b: emacs motion, paste, char editing (the loop edits text directly).
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
