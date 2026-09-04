// G2 capabilities probe — one async sweep, ≤500ms total, never throws.
//
// Queries (in order): XTVERSION (\x1b[>0q → DCS reply \x1bP>|name-version\x1b\\),
// DA1 primary device attributes (\x1b[c → \x1b[?…c), kitty keyboard protocol
// (DECRPM 27: \x1b[?27u → \x1b[?27;1$p, or the \x1b[?27u;1… variant),
// OSC 11 background (\x1b]11;?\x07 → \x1b]11;rgb:…\x07). DA2-style \x1b[>…c
// heuristics map Windows Terminal (version 1.95+); DA1 replies (\x1b[?…c with
// a leading 1 — VT100+-class, or an xterm-ish 4) give a WEAK band "xterm"
// hint used only when DA2/XTVERSION are no better (they never outrank them).
//
// Replies reach the client through feed(data) — the app's raw reader routes
// bytes here BEFORE the InputParser (or wires parser onDcs/onOsc payloads into
// feed); the mock terminal in tests also uses feed(). Anything that never
// answers by the deadline simply keeps its per-field default.
//
// Env-derived fields (colorLevel/multiplexer/legacyConsole plus the braved
// default ON/OFF of mouse/paste/focus/sync) are read at buildResult() so tests
// can monkeypatch process.env. Failures never throw — the result merges
// partial answers into createUnknownCapabilities().
import type { ColorLevel, TerminalCapabilityContext } from "../types.ts"

export interface ProbeStream {
  write(data: string): boolean
}

const PROBE_DEADLINE_MS = 500

const decoder = new TextDecoder("utf-8", { fatal: false })

/** sRGB luminance (BT.709) of a 0-255 channel. */
function lin(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function sRGBLuminance(r: number, g: number, b: number): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Parses "rgb:RR/GG/BB" (2- or 4-digit hex per channel) → dark = luminance < 0.5. */
function parseOsc11(payload: string): boolean | null {
  const m = /^(?:\d+;)?rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})/.exec(payload)
  if (m === null) return null
  const parts = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h.slice(0, 2), 16))
  for (const v of parts) if (!Number.isFinite(v)) return null
  return sRGBLuminance(parts[0]!, parts[1]!, parts[2]!) < 0.5
}

function brandFromXtversion(payload: string): string | null {
  const name = payload.replace(/^>?\|/, "").toLowerCase()
  if (name.includes("kitty")) return "kitty"
  if (name.includes("wezterm")) return "wezterm"
  if (name.includes("iterm2")) return "iTerm2"
  if (name.includes("xterm")) return "xterm"
  return null
}

function brandFromDa(csi: string): string | null {
  if (csi.startsWith("\x1b[>1;95")) return "WindowsTerminal"
  return null
}

/** DA1 primary DA reply (\x1b[?…c) → the WEAK xterm-family hint. First param 1
 * = VT100+-class; a 4 (VT400-class claim) or a leading 1 is xterm-ish. NOT
 * brand-specific for Windows Terminal (also answers 1;2) — the DA2 95 row and
 * XTVERSION keep precedence, and WT_SESSION env outranks it too. */
function brandFromDa1(csi: string): string | null {
  const m = /^\x1b\[\?(\d+(?:;\d+)*)c$/.exec(csi)
  if (m === null) return null
  const params = m[1]!.split(";")
  if (params[0] === "1" || params.includes("4")) return "xterm"
  return null
}

export class ProbeClient {
  private readonly stream: ProbeStream
  private buffer = ""
  private got = { xtversion: false, kitty: false, osc11: false }
  private xtversionPayload = ""
  private daBrand: string | null = null
  private da1Brand: string | null = null
  private kitty = false
  private dark: boolean | null = null
  private doneResolve: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(stream: ProbeStream) {
    this.stream = stream
  }

  /** Send the sweep queries and await answers (or the overall 500ms deadline). */
  probe(): Promise<TerminalCapabilityContext> {
    this.buffer = ""
    this.got = { xtversion: false, kitty: false, osc11: false }
    this.xtversionPayload = ""
    this.daBrand = null
    this.da1Brand = null
    this.kitty = false
    this.dark = null
    this.stream.write("\x1b[>0q")
    this.stream.write("\x1b[c")
    this.stream.write("\x1b[?27u")
    this.stream.write("\x1b]11;?\x07")
    return new Promise<TerminalCapabilityContext>((resolve) => {
      this.doneResolve = () => resolve(this.buildResult())
      this.timer = setTimeout(() => {
        // deadline: hand over whatever has arrived
        this.timer = null
        if (this.doneResolve !== null) {
          const done = this.doneResolve
          this.doneResolve = null
          done()
        }
      }, PROBE_DEADLINE_MS)
      this.tryFinish()
    })
  }

  private tryFinish(): void {
    if (this.got.xtversion && this.got.kitty && this.got.osc11 && this.doneResolve !== null) {
      if (this.timer !== null) {
        clearTimeout(this.timer)
        this.timer = null
      }
      const done = this.doneResolve
      this.doneResolve = null
      done()
    }
  }

  /** Route raw terminal reply bytes (or a bare payload from parser hooks) here. */
  feed(data: Uint8Array | string): void {
    if (typeof data !== "string") data = decoder.decode(data)
    this.buffer += data
    this.scan()
  }

  private scan(): void {
    let guard = 0
    while (this.buffer.length > 0 && guard++ < 8) {
      const b = this.buffer
      if (b.startsWith("\x1bP")) {
        const end = b.indexOf("\x1b\\", 2)
        if (end === -1) return // wait for ST (deadline handles a hang)
        this.handleDcs(b.slice(2, end))
        this.buffer = b.slice(end + 2)
        continue
      }
      if (b.startsWith("\x1b]")) {
        const bel = b.indexOf("\x07", 2)
        const st = b.indexOf("\x1b\\", 2)
        const useBel = bel !== -1 && (st === -1 || bel < st)
        if (!useBel && st === -1) return
        this.handleOsc(b.slice(2, useBel ? bel : st))
        this.buffer = b.slice(useBel ? bel + 1 : st + 2)
        continue
      }
      if (b.startsWith("\x1b[")) {
        let end = -1
        for (let i = 2; i < b.length; i++) {
          const c = b.charCodeAt(i)
          if (c >= 0x40 && c <= 0x7e) {
            end = i + 1
            break
          }
        }
        if (end === -1) return
        this.handleCsi(b.slice(0, end))
        this.buffer = b.slice(end)
        continue
      }
      // bare payload from parser onDcs/onOsc hooks, or junk → skip to next ESC
      if (/^(>\|.*)/.test(b)) {
        const nextEsc = b.indexOf("\x1b")
        this.handleDcs(nextEsc === -1 ? b : b.slice(0, nextEsc))
        this.buffer = nextEsc === -1 ? "" : b.slice(nextEsc)
        continue
      }
      if (/^(?:\d+;)?rgb:/.test(b)) {
        const nextEsc = b.indexOf("\x1b")
        this.handleOsc(nextEsc === -1 ? b : b.slice(0, nextEsc))
        this.buffer = nextEsc === -1 ? "" : b.slice(nextEsc)
        continue
      }
      const escAt = b.indexOf("\x1b")
      this.buffer = escAt === -1 ? "" : b.slice(escAt)
    }
  }

  private handleDcs(payload: string): void {
    if (payload.startsWith(">|")) {
      this.xtversionPayload = payload
      this.got.xtversion = true
      this.tryFinish()
    }
  }

  private handleOsc(payload: string): void {
    const dark = parseOsc11(payload)
    if (dark !== null) {
      this.dark = dark
      this.got.osc11 = true
      this.tryFinish()
    }
  }

  private handleCsi(csi: string): void {
    // kitty DECRPM 27: \x1b[?27;1$p (standard). The progressive-enhancement
    // variant answers CSI-u style (\x1b[?27u;1;2;…; the scanner crops at 'u').
    const decrpm = /^\x1b\[\?27;?(\d+)\$p$/.exec(csi)
    if (decrpm !== null) {
      this.kitty = parseInt(decrpm[1]!, 10) >= 1 // value 1 = set
      this.got.kitty = true
      this.tryFinish()
      return
    }
    if (/^\x1b\[\?27u$/.test(csi)) {
      this.kitty = true
      this.got.kitty = true
      this.tryFinish()
      return
    }
    const brand = brandFromDa(csi)
    if (brand !== null) {
      this.daBrand = brand
      this.got.xtversion = true
      this.tryFinish()
      return
    }
    // DA1 (\x1b[?…c) — the weak xterm-family hint. It must NOT early-finish:
    // XTVERSION/DA2 carry the stronger brand, and a kitty/wezterm answers
    // DA1 with the same 1;2 params — finishing on DA1 would misbrand them.
    const da1 = brandFromDa1(csi)
    if (da1 !== null) {
      this.da1Brand = da1
    }
  }

  private buildResult(): TerminalCapabilityContext {
    const env = process.env
    const ct = (env.COLORTERM ?? "").toLowerCase()
    const term = (env.TERM ?? "").toLowerCase()
    const colorLevel: ColorLevel =
      ct.includes("truecolor") || ct.includes("24bit") ? "truecolor"
      : term.includes("256color") ? "ansi256"
      : "ansi16"
    const brand =
      (this.xtversionPayload !== "" ? brandFromXtversion(this.xtversionPayload) : null)
      ?? this.daBrand                       // DA2 (the strongest DA heuristic — WT 95)
      ?? (env.WT_SESSION !== undefined ? "WindowsTerminal" : null) // env beats the weak DA1 hint
      ?? this.da1Brand                      // DA1 xterm-ish hint — weakest identification
      ?? "unknown"
    const multiplexer: "zellij" | "tmux" | "none" =
      env.ZELLIJ !== undefined ? "zellij"
      : env.TMUX !== undefined ? "tmux"
      : "none"
    const modern = colorLevel === "truecolor" || colorLevel === "ansi256"
    const legacyConsole =
      (process.platform === "win32" && env.WT_SESSION === undefined && !term.startsWith("xterm"))
      || brand === "unknown"
    return {
      colorLevel,
      dark: this.dark ?? true,
      kitty: this.kitty,
      mouse: modern,
      bracketedPaste: modern,
      focusEvents: modern,
      synchronizedOutput: modern,
      brand,
      multiplexer,
      legacyConsole,
    }
  }
}

/** Convenience: lazily create the stream (fresh ProbeClient per call). */
export async function probeCapabilities(streamMaker: () => { write(s: string): boolean }): Promise<TerminalCapabilityContext> {
  const client = new ProbeClient(streamMaker())
  return client.probe()
}
