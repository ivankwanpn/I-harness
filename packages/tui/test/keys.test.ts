// M37a G2: the keymap dispatch table (spec §4 subset) — pure fn, no loop.
// Event shape matches tui-core KeyEvent: letters arrive as code:"char" with
// the character in `key` (shifted letters keep their uppercase key: "G").

import { describe, expect, it } from "vitest"
import { dispatchKey, shortcutsFor } from "../src/app/keys.ts"
import type { Kbd, KeymapState } from "../src/app/keys.ts"

const kbd = (partial: Partial<Kbd>): Kbd => ({
  code: "char",
  key: "",
  ctrl: false,
  alt: false,
  shift: false,
  ...partial,
})

/** A plain (unmodified) letter as the parser emits it. */
const letter = (key: string): Kbd => kbd({ code: "char", key })

const promptState = (partial: Partial<KeymapState> = {}): KeymapState => ({
  focused: "prompt",
  promptText: "",
  multiLine: false,
  turnRunning: false,
  armedQuit: false,
  searchActive: false,
  ...partial,
})

const scrollState = (partial: Partial<KeymapState> = {}): KeymapState =>
  promptState({ focused: "scrollback", ...partial })

describe("dispatchKey — scrollback focus", () => {
  it("j/Down → scroll-down, k/Up → scroll-up", () => {
    expect(dispatchKey(letter("j"), scrollState())).toBe("scroll-down")
    expect(dispatchKey(kbd({ code: "Down", key: "ArrowDown" }), scrollState())).toBe("scroll-down")
    expect(dispatchKey(letter("k"), scrollState())).toBe("scroll-up")
    expect(dispatchKey(kbd({ code: "Up", key: "ArrowUp" }), scrollState())).toBe("scroll-up")
  })

  it("g/G top/bottom, PageUp/PageDown page, L/H next/prev turn", () => {
    expect(dispatchKey(letter("g"), scrollState())).toBe("goto-top")
    expect(dispatchKey(letter("G"), scrollState())).toBe("goto-bottom")
    expect(dispatchKey(kbd({ code: "PageUp", key: "PageUp" }), scrollState())).toBe("page-up")
    expect(dispatchKey(kbd({ code: "PageDown", key: "PageDown" }), scrollState())).toBe("page-down")
    expect(dispatchKey(letter("L"), scrollState())).toBe("next-turn")
    expect(dispatchKey(letter("H"), scrollState())).toBe("prev-turn")
  })

  it("h/Left/e → toggle-fold, l/Right → toggle-fold (M37a), E → expand-all, y → copy", () => {
    expect(dispatchKey(letter("h"), scrollState())).toBe("toggle-fold")
    expect(dispatchKey(kbd({ code: "Left", key: "ArrowLeft" }), scrollState())).toBe("toggle-fold")
    expect(dispatchKey(letter("e"), scrollState())).toBe("toggle-fold")
    expect(dispatchKey(letter("l"), scrollState())).toBe("toggle-fold")
    expect(dispatchKey(kbd({ code: "Right", key: "ArrowRight" }), scrollState())).toBe("toggle-fold")
    expect(dispatchKey(letter("E"), scrollState())).toBe("toggle-expand-all")
    expect(dispatchKey(letter("y"), scrollState())).toBe("copy-block")
  })

  it("Tab focuses the prompt; Enter here is unbound → none", () => {
    expect(dispatchKey(kbd({ code: "Tab", key: "\t" }), scrollState())).toBe("focus-prompt")
    expect(dispatchKey(kbd({ code: "Enter", key: "Enter" }), scrollState())).toBe("none")
  })
})

describe("dispatchKey — prompt focus: Enter & friends", () => {
  it("Enter submits (newline when multiline); Shift/Alt+Enter newline; Ctrl+Enter interject", () => {
    const st = promptState({ promptText: "hi" })
    expect(dispatchKey(kbd({ code: "Enter", key: "Enter" }), st)).toBe("submit")
    expect(dispatchKey(kbd({ code: "Enter", key: "Enter" }), { ...st, multiLine: true })).toBe("newline")
    expect(dispatchKey(kbd({ code: "Enter", key: "Enter", shift: true }), st)).toBe("newline")
    expect(dispatchKey(kbd({ code: "Enter", key: "Enter", alt: true }), st)).toBe("newline")
    expect(dispatchKey(kbd({ code: "Enter", key: "Enter", ctrl: true }), st)).toBe("interject")
  })

  it("Ctrl-C: non-empty clears the draft (cancel-turn); empty → cancel-turn, then quit-arm1 (armed)", () => {
    const ctrlC = kbd({ code: "char", key: "c", ctrl: true })
    expect(dispatchKey(ctrlC, promptState({ promptText: "draft" }))).toBe("cancel-turn")
    expect(dispatchKey(ctrlC, promptState({ turnRunning: true }))).toBe("cancel-turn")
    expect(dispatchKey(ctrlC, promptState({ armedQuit: true }))).toBe("quit-arm1")
  })

  it("Esc: non-empty → cancel-turn (loop clears draft); empty → quit-arm1, then quit when armed", () => {
    const esc = kbd({ code: "Esc", key: "Esc" })
    expect(dispatchKey(esc, promptState({ promptText: "draft" }))).toBe("cancel-turn")
    expect(dispatchKey(esc, promptState())).toBe("quit-arm1")
    expect(dispatchKey(esc, promptState({ armedQuit: true }))).toBe("quit")
  })

  it("Ctrl-M toggles multiline, Ctrl-Q quits, Ctrl-T/P dispatch panes/palette", () => {
    const c = (key: string): Kbd => kbd({ code: "char", key, ctrl: true })
    expect(dispatchKey(c("m"), promptState())).toBe("toggle-multiline")
    expect(dispatchKey(c("q"), promptState())).toBe("quit")
    expect(dispatchKey(c("t"), promptState())).toBe("toggle-todo-pane")
    expect(dispatchKey(c("p"), promptState())).toBe("open-command-palette")
  })

  it("M46a keys truth: Ctrl+S = stash/pop draft (NOT sessions), Alt+S same", () => {
    const c = (key: string): Kbd => kbd({ code: "char", key, ctrl: true })
    const altS = kbd({ code: "char", key: "s", alt: true })
    expect(dispatchKey(c("s"), promptState({ promptText: "draft" }))).toBe("stash-draft")
    expect(dispatchKey(altS, promptState({ promptText: "draft" }))).toBe("stash-draft")
    // the OLD Ctrl+S sessions binding is gone
    expect(dispatchKey(c("s"), promptState())).not.toBe("sessions")
  })

  it("M46a keys truth: F3 = session picker (prompt + scrollback focus)", () => {
    const f3 = kbd({ code: "F3", key: "F3" })
    expect(dispatchKey(f3, promptState())).toBe("sessions")
    expect(dispatchKey(f3, scrollState())).toBe("sessions")
  })

  it("M46a keys truth: Ctrl+G tasks pane (agent screen), Ctrl+B send-background, Ctrl+R slot", () => {
    const c = (key: string): Kbd => kbd({ code: "char", key, ctrl: true })
    expect(dispatchKey(c("g"), promptState())).toBe("toggle-tasks-pane")
    expect(dispatchKey(c("g"), scrollState())).toBe("toggle-tasks-pane")
    expect(dispatchKey(c("b"), promptState())).toBe("send-background")
    expect(dispatchKey(c("b"), scrollState())).toBe("send-background")
    // mouse-reporting opt-in slot: registered 'none' (inert until M46b)
    expect(dispatchKey(c("r"), promptState())).toBe("none")
    expect(dispatchKey(c("r"), scrollState())).toBe("none")
  })

  it("Shift-Tab cycles mode in all three encodings (ShiftTab / Tab+shift / Tab+key Z)", () => {
    expect(dispatchKey(kbd({ code: "ShiftTab", key: "Tab", shift: true }), promptState())).toBe("cycle-mode")
    expect(dispatchKey(kbd({ code: "Tab", key: "Tab", shift: true }), promptState())).toBe("cycle-mode")
    expect(dispatchKey(kbd({ code: "Tab", key: "Z", shift: true }), promptState())).toBe("cycle-mode")
  })

  it("Tab flips to scrollback; Up/Down on empty → history nav", () => {
    expect(dispatchKey(kbd({ code: "Tab", key: "\t" }), promptState())).toBe("focus-scrollback")
    expect(dispatchKey(kbd({ code: "Up", key: "ArrowUp" }), promptState())).toBe("history-prev")
    expect(dispatchKey(kbd({ code: "Down", key: "ArrowDown" }), promptState())).toBe("history-next")
    expect(dispatchKey(kbd({ code: "Up", key: "ArrowUp" }), promptState({ promptText: "x" }))).toBe("none")
  })

  it("typing chars and unbound keys → none (M37b completes the table)", () => {
    expect(dispatchKey(letter("a"), promptState())).toBe("none")
    // M46a G1: F2 = the settings modal (grok parity) — no longer unbound.
    expect(dispatchKey(kbd({ code: "F2", key: "F2" }), promptState())).toBe("open-settings")
  })
})

describe("dispatchKey — overlay routing (spec §4)", () => {
  const digit = (key: string): Kbd => kbd({ code: "char", key })

  it("Esc/Enter/arrows/Tab/PageUp-PageDown route to overlay actions", () => {
    const st = promptState({ overlay: "permission" })
    expect(dispatchKey(kbd({ code: "Esc", key: "Esc" }), st)).toBe("overlay-dismiss")
    expect(dispatchKey(kbd({ code: "Enter", key: "Enter" }), st)).toBe("overlay-select")
    expect(dispatchKey(kbd({ code: "Up", key: "ArrowUp" }), st)).toBe("overlay-nav-prev")
    expect(dispatchKey(kbd({ code: "Down", key: "ArrowDown" }), st)).toBe("overlay-nav-next")
    expect(dispatchKey(kbd({ code: "PageUp", key: "PageUp" }), st)).toBe("overlay-page-prev")
    expect(dispatchKey(kbd({ code: "PageDown", key: "PageDown" }), st)).toBe("overlay-page-next")
    expect(dispatchKey(kbd({ code: "Tab", key: "\t" }), st)).toBe("overlay-tab")
    expect(dispatchKey(kbd({ code: "ShiftTab", key: "Tab", shift: true }), st)).toBe("overlay-tab-back")
  })

  it("number keys select rows in permission/question/cancel-turn (index-carrying)", () => {
    const p = promptState({ overlay: "permission" })
    expect(dispatchKey(digit("3"), p)).toEqual({ type: "overlay-accept", index: 3 })
    expect(dispatchKey(digit("1"), promptState({ overlay: "cancel-turn" }))).toEqual({ type: "overlay-accept", index: 1 })
    expect(dispatchKey(digit("9"), promptState({ overlay: "question" }))).toEqual({ type: "overlay-accept", index: 9 })
  })

  it("number keys with NO overlay keep the scrollback table (none); digits don't leak into dropdrops", () => {
    expect(dispatchKey(digit("1"), scrollState())).toBe("none")
    expect(dispatchKey(digit("1"), promptState({ overlay: "dropdown" }))).toBe("none")
    expect(dispatchKey(digit("1"), promptState({ overlay: "permission" }))).not.toBe("none")
  })

  it("picker keys: j/k nav, y copy, e/E expand, Space toggle, /,i search, f filter", () => {
    const st = promptState({ overlay: "sessions" })
    expect(dispatchKey(digit("j"), st)).toBe("overlay-nav-prev")
    expect(dispatchKey(digit("k"), st)).toBe("overlay-nav-next")
    expect(dispatchKey(digit("y"), st)).toBe("overlay-copy")
    expect(dispatchKey(digit("e"), st)).toBe("overlay-expand")
    expect(dispatchKey(digit("E"), st)).toBe("overlay-collapse")
    expect(dispatchKey(digit(" "), st)).toBe("overlay-toggle")
    expect(dispatchKey(digit("/"), st)).toBe("overlay-search")
    expect(dispatchKey(digit("i"), st)).toBe("overlay-search")
    expect(dispatchKey(digit("f"), st)).toBe("overlay-filter")
    // same keys on the permission overlay: search/filter don't apply
    expect(dispatchKey(digit("f"), promptState({ overlay: "permission" }))).toBe("none")
  })

  it("permission ←/→ scope; question [ ] prev/next; Ctrl-P/Ctrl-N dropdown nav", () => {
    const right = kbd({ code: "Right", key: "ArrowRight" })
    const left = kbd({ code: "Left", key: "ArrowLeft" })
    expect(dispatchKey(right, promptState({ overlay: "permission" }))).toBe("overlay-range-right")
    expect(dispatchKey(left, promptState({ overlay: "permission" }))).toBe("overlay-range-left")
    expect(dispatchKey(right, promptState({ overlay: "sessions" }))).toBe("overlay-expand")
    expect(dispatchKey(left, promptState({ overlay: "sessions" }))).toBe("overlay-collapse")
    expect(dispatchKey(kbd({ code: "char", key: "]", ctrl: false }), promptState({ overlay: "question" }))).toBe("overlay-question-next")
    expect(dispatchKey(kbd({ code: "char", key: "[", ctrl: false }), promptState({ overlay: "question" }))).toBe("overlay-question-prev")
    expect(dispatchKey(kbd({ code: "char", key: "p", ctrl: true }), promptState({ overlay: "dropdown" }))).toBe("overlay-nav-prev")
    expect(dispatchKey(kbd({ code: "char", key: "n", ctrl: true }), promptState({ overlay: "dropdown" }))).toBe("overlay-nav-next")
  })

  it("Ctrl-F expands (permission args); Ctrl-Y closes the question", () => {
    expect(dispatchKey(kbd({ code: "char", key: "f", ctrl: true }), promptState({ overlay: "permission" }))).toBe("overlay-expand")
    expect(dispatchKey(kbd({ code: "char", key: "y", ctrl: true }), promptState({ overlay: "question" }))).toBe("overlay-copy")
  })
})

describe("dispatchKey — welcome menu (spec §2a)", () => {
  const letter = (key: string): Kbd => kbd({ code: "char", key })

  it("↑/↓/j/k navigate, Enter activates, g/l top/bottom, q quits", () => {
    const w = promptState({ welcome: true })
    expect(dispatchKey(kbd({ code: "Up", key: "ArrowUp" }), w)).toBe("menu-up")
    expect(dispatchKey(kbd({ code: "Down", key: "ArrowDown" }), w)).toBe("menu-down")
    expect(dispatchKey(letter("j"), w)).toBe("menu-down")
    expect(dispatchKey(letter("k"), w)).toBe("menu-up")
    expect(dispatchKey(kbd({ code: "Enter", key: "Enter" }), w)).toBe("menu-activate")
    expect(dispatchKey(letter("g"), w)).toBe("menu-top")
    expect(dispatchKey(letter("G"), w)).toBe("menu-bottom")
    expect(dispatchKey(letter("l"), w)).toBe("menu-bottom")
    expect(dispatchKey(letter("q"), w)).toBe("quit")
    expect(dispatchKey(letter("x"), w)).toBe("none")
  })
})

describe("dispatchKey — pane/global additions (spec §4)", () => {
  it("Ctrl-; queue pane, Ctrl+N new session; Ctrl-T unchanged; Ctrl-B send-background", () => {
    const c = (key: string): Kbd => kbd({ code: "char", key, ctrl: true })
    expect(dispatchKey(c(";"), promptState())).toBe("toggle-queue-pane")
    expect(dispatchKey(c("n"), promptState())).toBe("sessions-new")
    expect(dispatchKey(c("t"), promptState())).toBe("toggle-todo-pane")
    expect(dispatchKey(c("b"), promptState())).toBe("send-background")
  })

  it("`?` on an empty prompt opens the palette (only when no text)", () => {
    expect(dispatchKey(kbd({ code: "char", key: "?" }), promptState())).toBe("open-command-palette")
    expect(dispatchKey(kbd({ code: "char", key: "?" }), promptState({ promptText: "h" }))).toBe("none")
  })
})

describe("shortcutsFor — the bar content", () => {
  it("prompt focus shows the submit/interject/multiline/mode group", () => {
    const items = shortcutsFor({ focused: "prompt", multiLine: false, turnRunning: true, mode: "normal" })
    expect(items.some((s) => s.key === "Enter" && s.label === "submit")).toBe(true)
    expect(items.some((s) => s.key === "Ctrl+C" && s.label === "stop")).toBe(true)
    expect(items.some((s) => s.key === "Ctrl+M")).toBe(true)
  })

  it("scrollback focus shows j/k scroll + Tab prompt", () => {
    const items = shortcutsFor({ focused: "scrollback", multiLine: false, turnRunning: false, mode: "normal" })
    expect(items.some((s) => s.key === "j/k" && s.label === "scroll")).toBe(true)
    expect(items.some((s) => s.key === "Tab" && s.label === "prompt")).toBe(true)
  })
})

describe("shortcutsFor — plan review (M40 G2 / C13)", () => {
  it("plan review active → the bar opens with `a approve / c comment / q quit plan`", () => {
    const items = shortcutsFor({ focused: "prompt", multiLine: false, turnRunning: false, mode: "plan", planReview: true })
    expect(items.slice(0, 3)).toEqual([
      { key: "a", label: "approve" },
      { key: "c", label: "comment" },
      { key: "q", label: "quit plan" },
    ])
    // the normal group still follows
    expect(items.some((s) => s.key === "Enter" && s.label === "submit")).toBe(true)
  })

  it("no plan review (mode normal) → the bar stays the plain group", () => {
    const items = shortcutsFor({ focused: "prompt", multiLine: false, turnRunning: false, mode: "normal" })
    expect(items[0]).toEqual({ key: "Enter", label: "submit" })
  })
})
