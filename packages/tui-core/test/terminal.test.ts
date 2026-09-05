// G2 terminal init/teardown — golden byte sequences for full/minimal caps and
// TeardownGuard one-shot semantics (idempotent, panic-safe, registry install).
import { describe, expect, it } from "vitest"
import { initSequence, teardownSequence, TeardownGuard, MOUSE_DISABLE_SEQ, MOUSE_ENABLE_SEQ } from "../src/terminal/index.ts"
import { createUnknownCapabilities, type TerminalCapabilityContext } from "../src/types.ts"

const fullCap: TerminalCapabilityContext = {
  colorLevel: "truecolor",
  dark: false,
  kitty: true,
  mouse: true,
  bracketedPaste: true,
  focusEvents: true,
  synchronizedOutput: true,
  brand: "kitty",
  multiplexer: "none",
  legacyConsole: false,
}

describe("initSequence", () => {
  it("emits the exact byte order for a full capability terminal", () => {
    expect(initSequence(fullCap)).toBe(
      "\x1b[?2026h\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h\x1b[?1004h",
    )
  })

  it("emits only the unconditional core for a minimal (unknown) capability terminal", () => {
    expect(initSequence(createUnknownCapabilities())).toBe("\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l")
  })

  it("appends the OSC 12 cursor color when a palette rgb is supplied", () => {
    expect(initSequence(fullCap, "3333/4444/5555")).toBe(
      "\x1b[?2026h\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h\x1b[?1004h\x1b]12;rgb:3333/4444/5555\x07",
    )
  })

  it("the mouse enable set is the crossterm five-mode sequence (1000h 1002h 1003h 1015h 1006h)", () => {
    // The exact order crossterm 0.28.1's EnableMouseCapture writes — pinned
    // so an accidental reorder/reduction (e.g. 1015 skipped) is caught.
    expect(MOUSE_ENABLE_SEQ).toBe("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h")
    expect(MOUSE_DISABLE_SEQ).toBe("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1015l\x1b[?1006l")
  })
})

describe("teardownSequence", () => {
  it("emits the canonical reset in the fixed order regardless of cap", () => {
    const expected = "\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1015l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[?1049l"
    expect(teardownSequence(fullCap)).toBe(expected)
    expect(teardownSequence(createUnknownCapabilities())).toBe(expected)
  })
})

describe("TeardownGuard", () => {
  it("is a one-shot: first invoke true, later invokes false", () => {
    const guard = new TeardownGuard(teardownSequence(fullCap))
    expect(guard.invoke()).toBe(true)
    expect(guard.invoke()).toBe(false)
    expect(guard.invoke()).toBe(false)
  })

  it("is panic-safe: callable twice from different paths without double fire", () => {
    const guard = new TeardownGuard("RESET")
    const fromSignal = guard.invoke()
    const fromExitHook = guard.invoke()
    expect(fromSignal).toBe(true)
    expect(fromExitHook).toBe(false)
  })

  it("never mutates the sequence and installs through a registry", () => {
    const seq = teardownSequence(fullCap)
    const guard = new TeardownGuard(seq)
    expect(guard.sequence).toBe(seq)
    const registered: Array<() => void> = []
    guard.install([(fn) => registered.push(fn), (fn) => registered.push(fn)])
    expect(registered).toHaveLength(2)
    registered.forEach((fn) => fn())
    expect(guard.invoke()).toBe(false) // registry firing consumed the one-shot
  })
})
