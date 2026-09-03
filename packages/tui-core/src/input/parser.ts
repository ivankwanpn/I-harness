// G2 input parser — incremental byte stream → InputEvent stream.
//
// Covers the codepaths a TUI actually needs: C0 controls (\r\n/ctrl-char/
// backspace/tab), 2-byte Alt combos, CSI (`\x1b[`) finals (arrows / Home-End /
// PageUp-Down / Insert-Delete / F-keys / ShiftTab / focus / kitty CSI-u), SS3
// (`\x1bO`), bracketed paste (200~/201~ raw passthrough), SGR 1006 mouse,
// OSC/DCS swallowing (the probe intercepts raw replies BEFORE the parser in
// production; onOsc/onDcs hooks keep the parser self-sufficient), UTF-8
// streaming decode split across chunks.
//
// Robustness contract: unknown CSI → one {type:"unknown"} event (raw bytes),
// resync at the next byte; escape length capped at 64 bytes (OSC/DCS 512);
// never throws, never drops datastream outside the caps. Mouse is decoded
// unconditionally — the APP gates by capability.
import type { TerminalCapabilityContext } from "../types.ts"

export type KeyCode =
  | "Enter" | "Esc" | "Backspace" | "Delete" | "Tab" | "ShiftTab"
  | "Up" | "Down" | "Left" | "Right" | "Home" | "End" | "PageUp" | "PageDown"
  | "Insert"
  | "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9" | "F10" | "F11" | "F12"
  | "pasted" | "char"

export interface KeyEvent {
  type: "key"
  code: KeyCode
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** Emitted from a kitty CSI-u sequence (progressive keyboard protocol). */
  kitty?: boolean
}

export type InputEvent =
  | KeyEvent
  | { type: "paste"; text: string }
  | {
      type: "mouse"
      x: number
      y: number
      button: "left" | "middle" | "right" | "wheel-up" | "wheel-down"
      drag: boolean
      mods: { ctrl: boolean; shift: boolean; alt: boolean }
    }
  | { type: "focus"; gained: boolean }
  | { type: "unknown"; bytes: number[] }

export interface InputParserOptions {
  /** OSC payload (without terminator) — probe interception hook. */
  onOsc?: (osc: string) => void
  /** DCS payload (without ST) — XTVERSION replies arrive here. */
  onDcs?: (payload: string) => void
}

const ESC = 0x1b
const ESC_MAX = 64
const OSC_MAX = 512

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: false })
const pasteDecoder = new TextDecoder("utf-8", { fatal: false })

type State =
  | "ground" | "esc" | "esc-int" | "csi" | "ss3" | "osc" | "dcs"
  | "paste" | "paste-trail"

const F_ALL_KEYS: Record<number, KeyCode> = {
  11: "F1", 12: "F2", 13: "F3", 14: "F4", 15: "F5",
  17: "F6", 18: "F7", 19: "F8", 20: "F9", 21: "F10", 23: "F11", 24: "F12",
}
const TILDE_KEYS: Record<number, KeyCode> = {
  1: "Home", 2: "Insert", 3: "Delete", 4: "End", 5: "PageUp", 6: "PageDown",
  7: "Home", 8: "End",
}
const TILDE_KEYLABEL: Record<string, string> = {
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Insert: "Insert", Delete: "Delete",
}
const SS3_KEYS: Record<number, KeyCode> = {
  65: "Up", 66: "Down", 67: "Right", 68: "Left",
  80: "F1", 81: "F2", 82: "F3", 83: "F4", 72: "Home", 70: "End",
}
const SS3_KEYLABEL: Record<string, string> = {
  Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight",
  Home: "Home", End: "End",
}

/** xterm CSI modifier parameter (2→shift, 3→alt, 5→ctrl, …). */
function modsFromXterm(p: number): { ctrl: boolean; alt: boolean; shift: boolean } {
  const m = Math.max(0, p - 1)
  return { ctrl: (m & 4) !== 0, alt: (m & 2) !== 0, shift: (m & 1) !== 0 }
}

export class InputParser {
  private readonly onOsc?: (osc: string) => void
  private readonly onDcs?: (payload: string) => void
  private state: State = "ground"
  private out: InputEvent[] = []
  private escBuf: number[] = []
  private crSeen = false
  private altChar = false
  private utf8Buf: number[] = []
  private utf8Len = 0
  private oscBuf: number[] = []
  private oscEsc = false
  private oscOverflow = false
  private dcsBuf: number[] = []
  private dcsEsc = false
  private dcsOverflow = false
  private pasteBuf: number[] = []
  private pasteTrail: number[] = []

  constructor(opts: InputParserOptions = {}) {
    this.onOsc = opts.onOsc
    this.onDcs = opts.onDcs
  }

  /** Feed a chunk (string or raw bytes) → events produced by it. */
  push(chunk: Uint8Array | string, cap?: Partial<TerminalCapabilityContext>): InputEvent[] {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk
    for (const b of bytes) this.step(b, cap)
    return this.out.splice(0)
  }

  /** Returns anything still queued and flushes a lone pending ESC → Esc event
   * (the one ambiguous state that can only be resolved by time). Incomplete
   * multi-byte sequences (CSI tails, UTF-8) are left pending for the next push. */
  drain(): InputEvent[] {
    if (this.state === "esc" || this.state === "esc-int") {
      if (this.state === "esc") this.emitKey("Esc", "Esc")
      else this.emitUnknown(this.escBuf)
      this.state = "ground"
      this.escBuf = []
    }
    return this.out.splice(0)
  }

  // ------------------------------------------------------------------ step
  private step(b: number, cap?: Partial<TerminalCapabilityContext>): void {
    switch (this.state) {
      case "ground": return this.ground(b)
      case "esc": return this.afterEsc(b)
      case "esc-int": return this.intermediate(b)
      case "csi": return this.csi(b, cap)
      case "ss3": return this.ss3(b)
      case "osc": return this.osc(b)
      case "dcs": return this.dcs(b)
      case "paste": return this.paste(b)
      case "paste-trail": return this.pasteTrailByte(b)
    }
  }

  private emit(ev: InputEvent): void {
    this.out.push(ev)
  }

  private emitKey(
    code: KeyCode,
    key: string,
    mods: { ctrl: boolean; alt: boolean; shift: boolean } = { ctrl: false, alt: false, shift: false },
    kitty?: boolean,
  ): void {
    this.emit({ type: "key", code, key, ctrl: mods.ctrl, alt: mods.alt, shift: mods.shift, ...(kitty === undefined ? {} : { kitty }) })
  }

  private emitChar(cp: number, alt: boolean): void {
    this.emitKey("char", String.fromCodePoint(cp), { ctrl: false, alt, shift: false })
  }

  private emitUnknown(bytes: number[]): void {
    if (bytes.length > 0) this.emit({ type: "unknown", bytes: [...bytes] })
  }

  // ------------------------------------------------------------------ ground
  private ground(b: number): void {
    // pending UTF-8 continuation?
    if (this.utf8Len > 0) {
      if ((b & 0xc0) === 0x80) {
        this.utf8Buf.push(b)
        if (this.utf8Buf.length >= this.utf8Len) {
          const buf = this.utf8Buf
          this.utf8Len = 0
          this.utf8Buf = []
          let cp = 0
          if (buf.length === 2) cp = ((buf[0] & 0x1f) << 6) | (buf[1] & 0x3f)
          else if (buf.length === 3) cp = ((buf[0] & 0x0f) << 12) | ((buf[1] & 0x3f) << 6) | (buf[2] & 0x3f)
          else cp = ((buf[0] & 0x07) << 18) | ((buf[1] & 0x3f) << 12) | ((buf[2] & 0x3f) << 6) | (buf[3] & 0x3f)
          const alt = this.altChar
          this.altChar = false
          if (cp >= 0x20 && cp !== 0x7f) this.emitChar(cp, alt)
          else this.emitUnknown(buf)
        }
        return
      }
      this.emitUnknown(this.utf8Buf) // malformed: report held bytes, reprocess b
      this.utf8Len = 0
      this.utf8Buf = []
      this.altChar = false
    }
    if (b === 0x0a) {
      if (this.crSeen) {
        this.crSeen = false
        return // \r\n pair — ONE Enter, the LF is swallowed
      }
      this.emitKey("Enter", "Enter")
      return
    }
    if (this.crSeen) this.crSeen = false
    if (b === 0x0d) {
      this.crSeen = true
      this.emitKey("Enter", "Enter")
      return
    }
    if (b === ESC) {
      this.state = "esc"
      this.escBuf = [ESC]
      return
    }
    if (b === 0x00) {
      this.emitKey("char", " ", { ctrl: true, alt: false, shift: false }) // NUL = Ctrl+Space
      return
    }
    if (b === 0x08 || b === 0x7f) {
      this.emitKey("Backspace", "Backspace")
      return
    }
    if (b === 0x09) {
      this.emitKey("Tab", "\t")
      return
    }
    if (b >= 0x01 && b <= 0x1a) {
      this.emitKey("char", String.fromCharCode(96 + b), { ctrl: true, alt: false, shift: false })
      return
    }
    if (b < 0x20) return // stray C0 (0x0b–0x1f) — not a TUI key
    if (b < 0x80) {
      this.emitChar(b, false)
      return
    }
    if (b >= 0xc2 && b <= 0xf4) {
      this.utf8Len = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2
      this.utf8Buf = [b]
      return
    }
    this.emitUnknown([b]) // stray continuation / overlong lead
  }

  // ------------------------------------------------------------------ escape
  private afterEsc(b: number): void {
    this.escBuf.push(b)
    if (b === ESC) {
      this.emitKey("Esc", "Esc") // doubled ESC resolves the pending ESC
      this.escBuf = [ESC]
      return
    }
    if (b === 0x5b) { // `[` → CSI
      this.state = "csi"
      return
    }
    if (b === 0x4f) { // `O` → SS3
      this.state = "ss3"
      return
    }
    if (b === 0x5d) { // `]` → OSC
      this.state = "osc"
      this.oscBuf = []
      this.oscEsc = false
      this.oscOverflow = false
      return
    }
    if (b === 0x50) { // `P` → DCS
      this.state = "dcs"
      this.dcsBuf = []
      this.dcsEsc = false
      this.dcsOverflow = false
      return
    }
    if (b >= 0x20 && b <= 0x2f) { // ESC + intermediate
      this.state = "esc-int"
      return
    }
    if (b >= 0xc2 && b <= 0xf4) { // ALT + UTF-8 char (reuse ground machinery)
      this.state = "ground"
      this.altChar = true
      this.ground(b)
      return
    }
    if (b >= 0x20 && b < 0x7f) { // 2-byte alt: ESC + printable
      this.emitChar(b, true)
      this.state = "ground"
      return
    }
    this.emitUnknown(this.escBuf) // unknown ESC tail
    this.escBuf = []
    this.state = "ground"
  }

  private intermediate(b: number): void {
    if (this.escBuf.length >= ESC_MAX) {
      this.emitUnknown(this.escBuf)
      this.escapeResync(b)
      return
    }
    this.escBuf.push(b)
    if (b >= 0x30 && b <= 0x7e) {
      this.emitUnknown(this.escBuf) // final of an intermediate escape — unsupported
      this.escBuf = []
      this.state = "ground"
    }
  }

  private escapeResync(b: number): void {
    this.escBuf = []
    this.state = "ground"
    this.ground(b)
  }

  // ------------------------------------------------------------------ CSI
  private csi(b: number, cap?: Partial<TerminalCapabilityContext>): void {
    if (this.escBuf.length >= ESC_MAX) {
      this.emitUnknown(this.escBuf)
      this.escapeResync(b)
      return
    }
    if (b >= 0x40 && b <= 0x7e) {
      this.escBuf.push(b)
      const text = String.fromCharCode(...this.escBuf.slice(2))
      const raw = [...this.escBuf]
      this.escBuf = []
      this.state = "ground"
      this.csiFinal(text, b, raw, cap)
      return
    }
    this.escBuf.push(b) // param / intermediate byte
  }

  private csiFinal(text: string, final: number, raw: number[], cap?: Partial<TerminalCapabilityContext>): void {
    const stripped = text.replace(/[?<>=\x20-\x2f]/g, "")
    const parts = stripped.split(";")
    const p0 = parseInt(parts[0] ?? "", 10)
    const p1 = parseInt(parts[1] ?? "", 10)
    const f = String.fromCharCode(final)

    if (text.startsWith("<") && (f === "M" || f === "m")) {
      const ev = this.decodeMouse(text.slice(1), f === "m")
      if (ev !== null) this.emit(ev)
      else this.emitUnknown(raw)
      return
    }
    if (f === "u") {
      const ev = cap?.kitty === true ? this.decodeKitty(text) : null
      if (ev !== null) this.emit(ev)
      else this.emitUnknown(raw) // not kitty-capable → unknown  (resync below)
      return
    }
    switch (f) {
      case "A": return this.emitKey("Up", "ArrowUp", this.csiMods(p1))
      case "B": return this.emitKey("Down", "ArrowDown", this.csiMods(p1))
      case "C": return this.emitKey("Right", "ArrowRight", this.csiMods(p1))
      case "D": return this.emitKey("Left", "ArrowLeft", this.csiMods(p1))
      case "H": return this.emitKey("Home", "Home", this.csiMods(p1))
      case "F": return this.emitKey("End", "End", this.csiMods(p1))
      case "Z": return this.emitKey("ShiftTab", "Tab", { ctrl: false, alt: false, shift: true })
      case "I": return this.emit({ type: "focus", gained: true })
      case "O": return this.emit({ type: "focus", gained: false })
      case "~": return this.csiTilde(p0, p1, raw)
      default: return this.emitUnknown(raw)
    }
  }

  private csiMods(p: number): { ctrl: boolean; alt: boolean; shift: boolean } {
    if (Number.isFinite(p) && p >= 2 && p <= 8) return modsFromXterm(p)
    return { ctrl: false, alt: false, shift: false }
  }

  private csiTilde(p0: number, p1: number, raw: number[]): void {
    const mods = this.csiMods(p1)
    if (p0 === 200) {
      this.state = "paste" // bracketed paste start — raw passthrough until 201~
      this.pasteBuf = []
      this.pasteTrail = []
      return
    }
    if (p0 === 201) {
      this.state = "ground" // stray end (defensive)
      return
    }
    const code = TILDE_KEYS[p0]
    if (code !== undefined) {
      this.emitKey(code, TILDE_KEYLABEL[code] ?? code, mods)
      return
    }
    const fcode = F_ALL_KEYS[p0]
    if (fcode !== undefined) {
      this.emitKey(fcode, fcode, mods)
      return
    }
    this.emitUnknown(raw) // unknown ~ sequence
  }

  // ------------------------------------------------------------------ SS3
  private ss3(b: number): void {
    if (this.escBuf.length >= ESC_MAX) {
      this.emitUnknown(this.escBuf)
      this.escapeResync(b)
      return
    }
    this.escBuf.push(b)
    if (b >= 0x40 && b <= 0x7e) {
      const raw = [...this.escBuf]
      this.escBuf = []
      this.state = "ground"
      const code = SS3_KEYS[b]
      if (code !== undefined) this.emitKey(code, SS3_KEYLABEL[code] ?? code)
      else this.emitUnknown(raw)
    }
  }

  // ------------------------------------------------------------------ OSC/DCS
  private osc(b: number): void {
    if (b === 0x07) {
      this.finishOsc()
      return
    }
    if (b === ESC) {
      this.oscEsc = true // ST lookahead: \x1b\x5c
      return
    }
    if (this.oscEsc) {
      if (b === 0x5c) {
        this.finishOsc()
        return
      }
      this.oscEsc = false
      if (!this.oscOverflow) {
        if (this.oscBuf.length >= OSC_MAX) this.oscOverflow = true
        else this.oscBuf.push(ESC) // ESC was payload
      }
    }
    if (!this.oscOverflow) {
      if (this.oscBuf.length >= OSC_MAX) this.oscOverflow = true
      else this.oscBuf.push(b)
    }
  }

  private finishOsc(): void {
    if (!this.oscOverflow) this.onOsc?.(decoder.decode(new Uint8Array(this.oscBuf)))
    this.oscBuf = []
    this.oscEsc = false
    this.oscOverflow = false
    this.state = "ground"
  }

  private dcs(b: number): void {
    if (b === ESC) {
      this.dcsEsc = true // ST lookahead
      return
    }
    if (this.dcsEsc) {
      if (b === 0x5c) {
        this.finishDcs()
        return
      }
      this.dcsEsc = false
      if (!this.dcsOverflow) {
        if (this.dcsBuf.length >= OSC_MAX) this.dcsOverflow = true
        else this.dcsBuf.push(ESC)
      }
    }
    if (!this.dcsOverflow) {
      if (this.dcsBuf.length >= OSC_MAX) this.dcsOverflow = true
      else this.dcsBuf.push(b)
    }
  }

  private finishDcs(): void {
    if (!this.dcsOverflow) this.onDcs?.(decoder.decode(new Uint8Array(this.dcsBuf)))
    this.dcsBuf = []
    this.dcsEsc = false
    this.dcsOverflow = false
    this.state = "ground"
  }

  // ------------------------------------------------------------------ mouse
  private decodeMouse(p: string, released: boolean): InputEvent | null {
    const parts = p.split(";")
    const b = parseInt(parts[0] ?? "", 10)
    if (!Number.isFinite(b)) return null
    const x = parseInt(parts[1] ?? "0", 10)
    const y = parseInt(parts[2] ?? "0", 10)
    let button: "left" | "middle" | "right" | "wheel-up" | "wheel-down"
    if ((b & 64) !== 0) button = (b & 1) === 1 ? "wheel-down" : "wheel-up"
    else {
      const core = b & 3
      button = core === 1 ? "middle" : core === 2 ? "right" : "left"
    }
    return {
      type: "mouse",
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      button,
      drag: !released && (b & 32) !== 0,
      mods: { ctrl: (b & 16) !== 0, shift: (b & 4) !== 0, alt: (b & 8) !== 0 },
    }
  }

  // ------------------------------------------------------------------ kitty
  private decodeKitty(params: string): KeyEvent | null {
    let code = 0x75
    let mods = 0
    let event = 1
    if (params !== "") {
      const fields = params.split(":")
      const nums = fields.flatMap((f) => f.split(";").map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n)))
      if (fields.length === 1) {
        const v = nums[0] ?? 0
        // shorthand: single number ≤ 63 = modifiers applied to the key char
        // in the sequence; larger single number = a key codepoint.
        if (v <= 63) mods = v
        else code = v
      } else {
        code = nums[0] ?? 0x75
        // colon field 2 is shifted-code, but optional code;mods;event
        // variations appear in the wild: 2-field = code;mods;event.
        if (fields[1] !== undefined && fields[1].includes(";")) {
          mods = nums[1] ?? 0
          event = nums[2] ?? 1
        } else if (fields[2] !== undefined) {
          const [m, e] = (fields[2] ?? "").split(";")
          mods = parseInt(m, 10) || 0
          if (e !== undefined) event = parseInt(e, 10) || 1
          if (fields[3] !== undefined) event = parseInt(fields[3], 10) || 1
        }
      }
    }
    if (event === 3) return null // releases: apps count presses/repeats only
    // kitty encodes modifiers in the xterm convention (1 none, 2 shift, 3 alt,
    // 4 shift+alt, 5 ctrl, …) — the same scale as CSI modifier params.
    const mod = mods >= 1 ? modsFromXterm(mods) : { ctrl: false, alt: false, shift: false }
    const special = (
      code === 0x7f ? { code: "Delete" as const, key: "Delete" }
      : code === 0x08 ? { code: "Backspace" as const, key: "Backspace" }
      : code === 0x09 ? { code: "Tab" as const, key: "\t" }
      : code === 0x0d || code === 0x0a ? { code: "Enter" as const, key: "Enter" }
      : code === 0x1b ? { code: "Esc" as const, key: "Esc" }
      : null)
    if (special !== null) {
      const c = mod.shift && code === 0x09 ? "ShiftTab" : special.code
      return { type: "key", code: c, key: special.key, ...mod, kitty: true }
    }
    if (code < 0x20 || code > 0x10ffff) return null
    let ch: string
    try {
      ch = String.fromCodePoint(code)
    } catch {
      return null
    }
    if (mod.ctrl && ch.length === 1 && /[a-zA-Z]/.test(ch)) ch = ch.toLowerCase()
    return { type: "key", code: "char", key: ch, ...mod, kitty: true }
  }

  // ------------------------------------------------------------------ paste
  private paste(b: number): void {
    if (b === ESC) {
      this.pasteTrail = [ESC]
      this.state = "paste-trail"
      return
    }
    this.pasteBuf.push(b)
  }

  private pasteTrailByte(b: number): void {
    // trail must match the terminator ESC [ 2 0 1 ~
    const expected = [0x5b, 0x32, 0x30, 0x31, 0x7e]
    const idx = this.pasteTrail.length - 1
    if (b === expected[idx]) {
      this.pasteTrail.push(b)
      if (this.pasteTrail.length === 6) {
        const text = pasteDecoder.decode(new Uint8Array(this.pasteBuf))
        this.pasteBuf = []
        this.pasteTrail = []
        this.state = "ground"
        this.emit({ type: "paste", text })
      }
      return
    }
    for (const tb of this.pasteTrail) this.pasteBuf.push(tb) // trail was literal content
    this.pasteTrail = []
    this.state = "paste"
    this.paste(b)
  }
}
