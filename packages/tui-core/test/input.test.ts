// G2 input parser — byte matrix: C0 controls, UTF-8 streaming, CSI/SS3 finals,
// kitty CSI-u, bracketed paste (escape-looking content inside is raw), SGR
// mouse, focus, OSC/DCS hook fire, garbage resync.
import { describe, expect, it } from "vitest"
import { InputParser, type KeyEvent } from "../src/input/index.ts"

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

function ev(p: Partial<KeyEvent> & { code: KeyEvent["code"] }): KeyEvent {
  return { type: "key", key: "", ctrl: false, alt: false, shift: false, ...p }
}

describe("InputParser — ground", () => {
  it("emits one char per printable byte", () => {
    const p = new InputParser()
    const events = p.push("abc")
    expect(events).toHaveLength(3)
    expect(events[0]).toEqual(ev({ code: "char", key: "a" }))
    expect(events[1]).toEqual(ev({ code: "char", key: "b" }))
    expect(events[2]).toEqual(ev({ code: "char", key: "c" }))
  })

  it("stream-decodes UTF-8 split across two pushes", () => {
    const p = new InputParser()
    expect(p.push(bytes("é"))).toHaveLength(1)
    const split = new InputParser()
    expect(split.push(new Uint8Array([0xc3]))).toHaveLength(0)
    const events = split.push(new Uint8Array([0xa9]))
    expect(events[0]).toEqual(ev({ code: "char", key: "é" }))
  })

  it("collapses \\r\\n into ONE Enter and tolerates the pair split across chunks", () => {
    const p = new InputParser()
    expect(p.push(bytes("\r\n"))).toEqual([ev({ code: "Enter", key: "Enter" })])
    const split = new InputParser()
    expect(split.push(bytes("\r"))).toEqual([ev({ code: "Enter", key: "Enter" })])
    expect(split.push(bytes("\n"))).toEqual([])
    const bare = new InputParser()
    expect(bare.push(bytes("\n"))).toEqual([ev({ code: "Enter", key: "Enter" })])
  })

  it("maps C0 controls: Ctrl+C / Ctrl+D / backspace / tab", () => {
    const p = new InputParser()
    const events = p.push(bytes("\x03\x04\x08\x7f\x09"))
    expect(events[0]).toEqual(ev({ code: "char", key: "c", ctrl: true }))
    expect(events[1]).toEqual(ev({ code: "char", key: "d", ctrl: true }))
    expect(events[2]).toEqual(ev({ code: "Backspace", key: "Backspace" }))
    expect(events[3]).toEqual(ev({ code: "Backspace", key: "Backspace" }))
    expect(events[4]).toEqual(ev({ code: "Tab", key: "\t" }))
  })

  it("resolves 2-byte alt (ESC + printable)", () => {
    const p = new InputParser()
    const events = p.push(bytes("\x1ba"))
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(ev({ code: "char", key: "a", alt: true }))
  })
})

describe("InputParser — CSI/SS3", () => {
  it("decodes arrows from CSI and SS3", () => {
    const p = new InputParser()
    const events = p.push(bytes("\x1b[A\x1b[B\x1b[C\x1b[D\x1bOA"))
    expect(events[0]).toEqual(ev({ code: "Up", key: "ArrowUp" }))
    expect(events[1]).toEqual(ev({ code: "Down", key: "ArrowDown" }))
    expect(events[2]).toEqual(ev({ code: "Right", key: "ArrowRight" }))
    expect(events[3]).toEqual(ev({ code: "Left", key: "ArrowLeft" }))
    expect(events[4]).toEqual(ev({ code: "Up", key: "ArrowUp" }))
  })

  it("decodes ShiftTab", () => {
    const p = new InputParser()
    const events = p.push(bytes("\x1b[Z"))
    expect(events[0]).toEqual(ev({ code: "ShiftTab", key: "Tab", shift: true }))
  })

  it("decodes Home/End/PageUp/PageDown", () => {
    const p = new InputParser()
    const events = p.push(bytes("\x1b[H\x1b[F\x1bOH\x1bOF\x1b[5~\x1b[6~"))
    expect(events[0]).toEqual(ev({ code: "Home", key: "Home" }))
    expect(events[1]).toEqual(ev({ code: "End", key: "End" }))
    expect(events[2]).toEqual(ev({ code: "Home", key: "Home" }))
    expect(events[3]).toEqual(ev({ code: "End", key: "End" }))
    expect(events[4]).toEqual(ev({ code: "PageUp", key: "PageUp" }))
    expect(events[5]).toEqual(ev({ code: "PageDown", key: "PageDown" }))
  })

  it("decodes Insert/Delete and first-class F-keys", () => {
    const p = new InputParser()
    const events = p.push(bytes("\x1b[2~\x1b[3~\x1b[11~\x1b[14~\x1b[15~\x1b[17~\x1b[21~\x1b[23~\x1b[24~"))
    expect(events[0]).toEqual(ev({ code: "Insert", key: "Insert" }))
    expect(events[1]).toEqual(ev({ code: "Delete", key: "Delete" }))
    const fkeys = events.slice(2).map((e) => (e as KeyEvent).code)
    expect(fkeys).toEqual(["F1", "F4", "F5", "F6", "F10", "F11", "F12"])
  })

  it("decodes SS3 F1-F4", () => {
    const p = new InputParser()
    const events = p.push(bytes("\x1bOP\x1bOQ\x1bOR\x1bOS"))
    expect(events.map((e) => (e as KeyEvent).code)).toEqual(["F1", "F2", "F3", "F4"])
  })

  it("applies xterm modifier params to arrows", () => {
    const p = new InputParser()
    const events = p.push(bytes("\x1b[1;5A")) // 5 = ctrl
    expect(events[0]).toEqual(ev({ code: "Up", key: "ArrowUp", ctrl: true }))
  })

  it("resyncs on unknown CSI and parses the next byte fine", () => {
    const p = new InputParser()
    const a = p.push(bytes("\x1b[99z"))
    expect(a).toHaveLength(1)
    const u = a[0] as { type: string; bytes: number[] }
    expect(u.type).toBe("unknown")
    expect(u.bytes).toEqual([0x1b, 0x5b, 0x39, 0x39, 0x7a])
    const b = p.push(bytes("z"))
    expect(b[0]).toEqual(ev({ code: "char", key: "z" }))
  })
})

describe("InputParser — kitty CSI-u", () => {
  it("decodes shorthand mods only when cap.kitty is set", () => {
    const p = new InputParser()
    // shorthand: single param ≤ 63 = xterm-style modifiers (5 = ctrl) applied
    // to the key char in the sequence ('u') → Ctrl+u
    const events = p.push(bytes("\x1b[5u"), { kitty: true })
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(ev({ code: "char", key: "u", ctrl: true, kitty: true }))
  })

  it("leaves CSI-u unknown when kitty is not in the capability context", () => {
    const p = new InputParser()
    const events = p.push(bytes("\x1b[5u"))
    expect(events[0]).toEqual({ type: "unknown", bytes: [0x1b, 0x5b, 0x35, 0x75] })
  })

  it("decodes the full colon form code:shifted:mods u (xterm-style mods: 5 = ctrl)", () => {
    const p = new InputParser()
    const events = p.push(bytes("\x1b[97:65:5u"), { kitty: true }) // Ctrl+A
    expect(events[0]).toEqual(ev({ code: "char", key: "a", ctrl: true, kitty: true }))
    const shifted = p.push(bytes("\x1b[97:65:6u"), { kitty: true }) // Ctrl+Shift+A
    expect(shifted[0]).toEqual(ev({ code: "char", key: "a", ctrl: true, shift: true, kitty: true }))
  })

  it("decodes the plain ESC[u", () => {
    const p = new InputParser()
    const events = p.push(bytes("\x1b[u"), { kitty: true })
    expect(events[0]).toEqual(ev({ code: "char", key: "u", kitty: true }))
  })
})

describe("InputParser — paste / mouse / focus", () => {
  it("passes bracketed paste through verbatim (escape-looking content raw)", () => {
    const p = new InputParser()
    const events = p.push(bytes("\x1b[200~1;2;3\x1b[31m\x1b[201~"))
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: "paste", text: "1;2;3\x1b[31m" })
  })

  it("decodes SGR mouse press/release/wheel/drag", () => {
    const p = new InputParser()
    const a = p.push(bytes("\x1b[<0;10;5M"))
    expect(a[0]).toEqual({ type: "mouse", x: 10, y: 5, button: "left", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    const b = p.push(bytes("\x1b[<0;10;5m"))
    expect(b[0]).toEqual({ type: "mouse", x: 10, y: 5, button: "left", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    const c = p.push(bytes("\x1b[<64;10;5M"))
    expect(c[0]).toEqual({ type: "mouse", x: 10, y: 5, button: "wheel-up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    const d = p.push(bytes("\x1b[<65;10;5M"))
    expect(d[0]).toEqual({ type: "mouse", x: 10, y: 5, button: "wheel-down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    const e = p.push(bytes("\x1b[<32;10;5M")) // motion
    expect((e[0] as { drag: boolean }).drag).toBe(true)
  })

  it("emits focus gained/lost (1004)", () => {
    const p = new InputParser()
    expect(p.push(bytes("\x1b[I"))).toEqual([{ type: "focus", gained: true }])
    expect(p.push(bytes("\x1b[O"))).toEqual([{ type: "focus", gained: false }])
  })
})

describe("InputParser — OSC/DCS hooks", () => {
  it("fires onOsc with the payload and emits no events (BEL and ST)", () => {
    const oscs: string[] = []
    const p = new InputParser({ onOsc: (osc) => oscs.push(osc) })
    const a = p.push(bytes("\x1b]11;rgb:1234/5678/9abc\x07"))
    expect(a).toHaveLength(0)
    const b = p.push(bytes("\x1b]12;rgb:ee/ee/ee\x1b\\"))
    expect(b).toHaveLength(0)
    expect(oscs).toEqual(["11;rgb:1234/5678/9abc", "12;rgb:ee/ee/ee"])
  })

  it("fires onDcs with the XTVERSION payload (DCS … ST)", () => {
    const dcs: string[] = []
    const p = new InputParser({ onDcs: (payload) => dcs.push(payload) })
    const a = p.push(bytes("\x1bP>|kitty-0.29.0\x1b\\"))
    expect(a).toHaveLength(0)
    expect(dcs).toEqual([">|kitty-0.29.0"])
  })
})
