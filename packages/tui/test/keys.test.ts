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

  it("Ctrl-M toggles multiline, Ctrl-Q quits, Ctrl-T/B/S/P dispatch panes/sessions/palette", () => {
    const c = (key: string): Kbd => kbd({ code: "char", key, ctrl: true })
    expect(dispatchKey(c("m"), promptState())).toBe("toggle-multiline")
    expect(dispatchKey(c("q"), promptState())).toBe("quit")
    expect(dispatchKey(c("t"), promptState())).toBe("toggle-todo-pane")
    expect(dispatchKey(c("b"), promptState())).toBe("toggle-tasks-pane")
    expect(dispatchKey(c("s"), promptState())).toBe("sessions")
    expect(dispatchKey(c("p"), promptState())).toBe("open-command-palette")
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
    expect(dispatchKey(kbd({ code: "F2", key: "F2" }), promptState())).toBe("none")
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
