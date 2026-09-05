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
  // global / panes / sessions (spec §4 · Ctrl-T/G/;/N/Q/P — M46a keys truth:
  // Ctrl+S is the DRAFT STASH now, F3 is the session picker, Ctrl+B is the
  // send-to-background slot, Ctrl+R is the mouse-reporting opt-in slot)
  | "toggle-todo-pane" | "toggle-tasks-pane" | "toggle-queue-pane"
  | "sessions" | "sessions-new"
  | "quit" | "quit-arm1"
  | "history-prev" | "history-next"
  | "stash-draft" | "send-background" | "edit-prompt-editor"
  | "open-command-palette"
  // M46b G1: mouse-reporting opt-in — Ctrl+R (scrollback only) toggles mouse
  // capture/hover. Registered ONLY when the feature knob is on (default off).
  | "toggle-mouse-reporting"
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
  // M43 rewind overlay keys (spec §3.9: y/n/a/b/f/bksp via the rewind view's
  // semantics — the seam's act switch is phase-driven, so the action names are
  // phase-agnostic: "rewind-y" = the yes answer, cancel-offer's "Cancel turn
  // and rewind" OR confirm's "Confirm rewind").
  | "rewind-y" | "rewind-n" | "rewind-a" | "rewind-b" | "rewind-f" | "rewind-back"
  // M43 Esc-Esc opening (spec §4: `Esc` empty + ≥1 turn = rewind picker):
  // `rewind-arm1` = first empty-Esc (toast), `rewind-open` = the armed second.
  | "rewind-arm1" | "rewind-open"
  // welcome (spec §2a)
  | "menu-up" | "menu-down" | "menu-top" | "menu-bottom"
  | "menu-activate"
  // M46a G1 (provider/model): F2/Ctrl+, = the settings modal (grok parity);
  // Ctrl+M on the SCROLLBACK screen (agent screen non-prompt) = the model
  // picker — the prompt-focused Ctrl+M keeps multiline (grok's collision
  // resolution precedent).
  | "open-settings" | "open-model-picker"

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
  | "rewind" // M43 (§3.9) — the runtime kind string from the seam's closed-union cast
  | "provider" | "settings" | "model-picker" // M46a G1 — runtime kind strings (closed-union cast)
  | "light" // M46a G2 — light panels (skills/mcps/hooks/plugins/...) in the dropdown slot

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
  /** M43: the empty-prompt Esc means REWIND arming (spec §4 — `Esc` empty +
   * ≥1 turn opens the rewind picker) when the backend exposes the rewind
   * bridge AND history exists; absent/false → Esc keeps the quit arm. */
  rewindAvailable?: boolean
  /** M43: the previous empty-Esc armed the rewind (toast) — the next opens. */
  rewindArmed?: boolean
  /** M46b G1: the mouse-reporting-toggle feature is ON (settings
   * `[ui] mouse_reporting_toggle` / env GROK_MOUSE_REPORTING_TOGGLE) — the
   * Ctrl+R scrollback binding now toggles capture (off → the default "none"). */
  mouseToggle?: boolean
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
      case "F2": return "open-settings" // M46a G1: settings modal (grok F2)
      case "F3": return "sessions" // M46a keys truth: F3 = session picker (was Ctrl+S)
    }
    if (ev.code === "char" && ev.ctrl) {
      // M46a G1: Ctrl+M on the agent screen (scrollback focused) = the model
      // picker — the prompt-focused Ctrl+M keeps multiline (grok collision
      // resolution); Ctrl+, = the settings modal.
      switch (ev.key) {
        case "m": return "open-model-picker"
        case ",": return "open-settings"
        // M46a G2 (keys truth): Ctrl+G tasks pane, Ctrl+B send-to-background
        // slot, Ctrl+R mouse-reporting opt-in (M46b G1: bound ONLY when the
        // feature knob is on — else the default 'none'); sessions moved to F3.
        case "g": return "toggle-tasks-pane"
        case "b": return "send-background"
        case "r": return state.mouseToggle === true ? "toggle-mouse-reporting" : "none"
      }
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
    // M43 (spec §4): empty prompt + ≥1 turn → Esc-Esc arms/opens the rewind
    // picker. The rewind gate takes precedence over the quit arm (Ctrl+Q/
    // Ctrl+C stay the quit paths); when the backend has no rewind bridge the
    // quit arm is unchanged.
    if (state.rewindAvailable === true) {
      return state.rewindArmed === true ? "rewind-open" : "rewind-arm1"
    }
    return state.armedQuit ? "quit" : "quit-arm1"
  }
  if (ev.code === "Tab") {
    if (isShiftTab(ev)) return "cycle-mode" // Normal → Plan → Always-Approve
    return "focus-scrollback"
  }
  if (ev.code === "F2") return "open-settings" // M46a G1: settings modal (grok F2)
  if (ev.code === "F3") return "sessions" // M46a keys truth: F3 = session picker
  if (ev.code === "ShiftTab") return "cycle-mode"
  if (ev.code === "Up") return state.promptText.length === 0 ? "history-prev" : "none"
  if (ev.code === "Down") return state.promptText.length === 0 ? "history-next" : "none"
  // M46a keys truth (grok): Alt+S = the draft stash too (Alt+S same as Ctrl+S).
  if (ev.code === "char" && !ev.ctrl && ev.alt && ev.key === "s") return "stash-draft"
  if (ev.code === "char" && ev.ctrl) {
    switch (ev.key) {
      case "c":
        // non-empty: clear draft; empty: cancel the turn and arm the quit;
        // the SECOND empty Ctrl-C (armed) goes through quit-arm1 → quit.
        if (state.promptText.length > 0) return "cancel-turn"
        return state.armedQuit ? "quit-arm1" : "cancel-turn"
      case "m": return "toggle-multiline" // M46a: prompt-focused Ctrl+M keeps multiline
      case "q": return "quit"
      case "t": return "toggle-todo-pane"
      // M46a keys truth: Ctrl+G tasks pane (agent screen), Ctrl+B the
      // send-to-background slot, Ctrl+R mouse-reporting (M46b G1: the binding
      // is SCROLLBACK-only per grok — prompt Ctrl+R stays the history-reverse
      // slot, i.e. 'none' here), Ctrl+S the DRAFT STASH.
      case "g": return "toggle-tasks-pane"
      case "b": return "send-background"
      case ";": return "toggle-queue-pane" // spec §4: Ctrl+; queue pane
      case "s": return "stash-draft" // keys truth: Ctrl+S = stash/pop the draft
      case "n": return "sessions-new" // spec §4: Ctrl+N new session
      case "p": return "open-command-palette"
      case ",": return "open-settings" // M46a G1: Ctrl+, = settings modal (grok parity)
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
 * Minimal-mode keys (M38a, spec §1.1 + M46a keys truth): the quick prompt is
 * the only surface. Enter submits (Ctrl+Enter interjects); Esc is a no-op
 * GUARD; Ctrl+Q quits; Ctrl+S = the DRAFT STASH (quick-prompt focus — the
 * session picker moved to F3); Ctrl+G = edit the quick prompt in $EDITOR.
 * Slash commands route through the loop's submit (registry run).
 */
export function minimalKey(ev: Kbd): AppAction {
  if (ev.code === "Enter") {
    if (ev.ctrl) return "interject"
    if (ev.shift || ev.alt) return "newline"
    return "submit"
  }
  if (ev.code === "Esc") return "none"
  if (ev.code === "F3") return "sessions" // keys truth: F3 = session picker
  if (ev.code === "char" && ev.ctrl) {
    switch (ev.key) {
      case "q": return "quit"
      case "s": return "stash-draft" // keys truth: Ctrl+S = stash/pop the draft
      case "g": return "edit-prompt-editor" // keys truth: minimal Ctrl+G = $EDITOR
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
    // M43: Bksp = the rewind Back (§3.9 confirm `Bksp Back` / mode-select back).
    case "Backspace": return kind === "rewind" ? "rewind-back" : "none"
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
    // M43 §3.9 rewind keys: y/n/a/b/f — the rewind view's own letters; they
    // preempt the generic overlay letters (y=copy, f=filter, a/b unhandled).
    if (kind === "rewind") {
      switch (ev.key) {
        case "y": return "rewind-y"
        case "n": return "rewind-n"
        case "a": return "rewind-a"
        case "b": return "rewind-b"
        case "f": return "rewind-f"
      }
    }
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
  /** M40 G2 (C13): plan review active — plan mode on AND the last assistant
   * block is the plan (the loop's detection); the bar shows the plan actions
   * FIRST (`a approve / c comment / q quit plan`). */
  planReview?: boolean
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
  const items: Shortcut[] = []
  if (state.planReview === true) {
    items.push(
      { key: "a", label: "approve" },
      { key: "c", label: "comment" },
      { key: "q", label: "quit plan" },
    )
  }
  items.push(
    { key: "Enter", label: state.multiLine ? "newline" : "submit" },
    { key: "Ctrl+Enter", label: "interject" },
    { key: "Ctrl+M", label: "multiline" },
    { key: "Shift+Tab", label: "mode" },
    { key: "Esc", label: "clear" },
  )
  if (state.turnRunning) items.push({ key: "Ctrl+C", label: "stop" })
  items.push({ key: "Ctrl+S", label: "stash" }) // M46a keys truth: draft stash/pop
  items.push({ key: "F3", label: "sessions" }) // M46a keys truth: the picker trigger
  items.push({ key: "Ctrl+Q", label: "quit" })
  return items
}
