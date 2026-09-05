// M46a G1: the keymap additions — F2/Ctrl+, → settings; Ctrl+M on the AGENT
// screen (scrollback focused) → the model picker; the prompt-focused Ctrl+M
// KEEPS multiline (the grok collision-resolution precedent).

import { describe, expect, it } from "vitest"
import { dispatchKey } from "../src/app/keys.ts"
import type { Kbd, KeymapState } from "../src/app/keys.ts"

const kbd = (partial: Partial<Kbd>): Kbd => ({
  code: "char",
  key: "",
  ctrl: false,
  alt: false,
  shift: false,
  ...partial,
})

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

describe("dispatchKey — M46a G1 provider/model bindings", () => {
  it("Ctrl+M: prompt-focused keeps multiline; scrollback-focused opens the model picker", () => {
    const ctrlM = kbd({ code: "char", key: "m", ctrl: true })
    expect(dispatchKey(ctrlM, promptState())).toBe("toggle-multiline")
    expect(dispatchKey(ctrlM, scrollState())).toBe("open-model-picker")
  })

  it("F2 and Ctrl+, open the settings modal from either focus", () => {
    const f2 = kbd({ code: "F2", key: "F2" })
    const ctrlComma = kbd({ code: "char", key: ",", ctrl: true })
    expect(dispatchKey(f2, promptState())).toBe("open-settings")
    expect(dispatchKey(f2, scrollState())).toBe("open-settings")
    expect(dispatchKey(ctrlComma, promptState())).toBe("open-settings")
    expect(dispatchKey(ctrlComma, scrollState())).toBe("open-settings")
  })

  it("an open overlay preempts the bindings (the seam's own keys win)", () => {
    const f2 = kbd({ code: "F2", key: "F2" })
    expect(dispatchKey(f2, promptState({ overlay: "settings" }))).toBe("none")
    const ctrlM = kbd({ code: "char", key: "m", ctrl: true })
    expect(dispatchKey(ctrlM, promptState({ overlay: "model-picker" }))).toBe("none")
  })
})
