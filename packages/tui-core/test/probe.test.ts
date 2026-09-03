// G2 probe — per-response parsing (XTVERSION kitty/xterm/WT, DECRPM 27,
// OSC 11 dark/light luminance), env-derived fields, total-timeout fallback,
// and the probeCapabilities convenience wrapper.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProbeClient, probeCapabilities } from "../src/probe/index.ts"
import type { TerminalCapabilityContext } from "../src/types.ts"

const ENV_KEYS = ["COLORTERM", "TERM", "WT_SESSION", "ZELLIJ", "TMUX", "TERM_PROGRAM"] as const
let savedEnv: Record<string, string | undefined> = {}

function withEnv(env: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
}

function mockStream(): { writes: string[]; write(s: string): boolean } {
  return {
    writes: [],
    write(s) {
      this.writes.push(s)
      return true
    },
  }
}

const ALL_REPLIES = (brand: string): string[] => [
  `\x1bP>|${brand}\x1b\\`,
  "\x1b[?27;1$p",
  "\x1b]11;rgb:ee/ee/ee\x07",
]

async function probeWith(env: Record<string, string | undefined>, feeds: string[]): Promise<{ writes: string[]; cap: TerminalCapabilityContext }> {
  const stream = mockStream()
  const client = new ProbeClient(stream)
  withEnv(env)
  const p = client.probe()
  for (const feed of feeds) client.feed(feed)
  return { writes: stream.writes, cap: await p }
}

describe("ProbeClient", () => {
  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  })
  afterEach(() => {
    withEnv(savedEnv)
    vi.useRealTimers()
  })

  it("sends XTVERSION, kitty and OSC11 queries in order", async () => {
    const { writes } = await probeWith({ TERM: "xterm-256color" }, ALL_REPLIES("xterm-378"))
    expect(writes).toEqual(["\x1b[>0q", "\x1b[?27u", "\x1b]11;?\x07"])
  })

  it("parses the XTVERSION DCS brand heuristics", async () => {
    const kitty = await probeWith({}, ALL_REPLIES("kitty-0.29.0"))
    expect(kitty.cap.brand).toBe("kitty")
    const xterm = await probeWith({}, ALL_REPLIES("xterm-378"))
    expect(xterm.cap.brand).toBe("xterm")
    const wezterm = await probeWith({}, ALL_REPLIES("wezterm-20230712-072601-f4abf8fd"))
    expect(wezterm.cap.brand).toBe("wezterm")
    const iterm = await probeWith({}, ALL_REPLIES("iTerm2 3.4.19"))
    expect(iterm.cap.brand).toBe("iTerm2")
  })

  it("recognizes the Windows Terminal DA reply (\\x1b[>1;95…c)", async () => {
    const { cap } = await probeWith({}, ["\x1b[>1;95;0c", "\x1b[?27;1$p", "\x1b]11;rgb:ee/ee/ee\x07"])
    expect(cap.brand).toBe("WindowsTerminal")
  })

  it("parses the kitty DECRPM 27 reply (standard and variant forms)", async () => {
    const std = await probeWith({}, ["\x1bP>|kitty-0.29.0\x1b\\", "\x1b[?27;1$p", "\x1b]11;rgb:ee/ee/ee\x07"])
    expect(std.cap.kitty).toBe(true)
    const variant = await probeWith({}, ["\x1bP>|kitty-0.29.0\x1b\\", "\x1b[?27u;1;2;3u", "\x1b]11;rgb:ee/ee/ee\x07"])
    expect(variant.cap.kitty).toBe(true)
  })

  it("computes dark from OSC 11 luminance (2- and 4-digit hex)", async () => {
    const dark = await probeWith({}, ["\x1bP>|xterm-378\x1b\\", "\x1b[?27;0$p", "\x1b]11;rgb:3232/3838/3535\x07"])
    expect(dark.cap.dark).toBe(true)
    const light = await probeWith({}, ["\x1bP>|xterm-378\x1b\\", "\x1b[?27;0$p", "\x1b]11;rgb:ee/ee/ee\x07"])
    expect(light.cap.dark).toBe(false)
  })

  it("derives color level from COLORTERM/TERM", async () => {
    expect((await probeWith({ COLORTERM: "truecolor" }, ALL_REPLIES("xterm-378"))).cap.colorLevel).toBe("truecolor")
    expect((await probeWith({ COLORTERM: "24bit" }, ALL_REPLIES("xterm-378"))).cap.colorLevel).toBe("truecolor")
    expect((await probeWith({ TERM: "xterm-256color" }, ALL_REPLIES("xterm-378"))).cap.colorLevel).toBe("ansi256")
    expect((await probeWith({ TERM: "ansi" }, ALL_REPLIES("xterm-378"))).cap.colorLevel).toBe("ansi16")
  })

  it("derives multiplexer from ZELLIJ/TMUX env", async () => {
    expect((await probeWith({ ZELLIJ: "1" }, ALL_REPLIES("xterm-378"))).cap.multiplexer).toBe("zellij")
    expect((await probeWith({ TMUX: "/tmp/socket" }, ALL_REPLIES("xterm-378"))).cap.multiplexer).toBe("tmux")
    expect((await probeWith({}, ALL_REPLIES("xterm-378"))).cap.multiplexer).toBe("none")
  })

  it("braves mouse/paste/focus/sync ON for modern color levels", async () => {
    const modern = await probeWith({ COLORTERM: "truecolor" }, ALL_REPLIES("xterm-378"))
    expect(modern.cap.mouse).toBe(true)
    expect(modern.cap.bracketedPaste).toBe(true)
    expect(modern.cap.focusEvents).toBe(true)
    expect(modern.cap.synchronizedOutput).toBe(true)
    const legacy = await probeWith({ TERM: "ansi" }, ALL_REPLIES("xterm-378"))
    expect(legacy.cap.mouse).toBe(false)
    expect(legacy.cap.bracketedPaste).toBe(false)
  })

  it("never throws: total timeout resolves with per-field defaults", async () => {
    vi.useFakeTimers()
    const stream = mockStream()
    const client = new ProbeClient(stream)
    withEnv({ TERM: "ansi" })
    const p = client.probe()
    await vi.advanceTimersByTimeAsync(501)
    const cap = await p
    expect(cap.colorLevel).toBe("ansi16")
    expect(cap.dark).toBe(true)
    expect(cap.kitty).toBe(false)
    expect(cap.mouse).toBe(false)
    expect(cap.multiplexer).toBe("none")
    expect(cap.brand).toBe("unknown")
    expect(cap.legacyConsole).toBe(true) // brand unknown → conservative legacy
  })

  it("probeCapabilities wraps the flow lazily", async () => {
    vi.useFakeTimers()
    const stream = mockStream()
    const p = probeCapabilities(() => stream)
    await vi.advanceTimersByTimeAsync(501)
    const cap = await p
    expect(stream.writes).toEqual(["\x1b[>0q", "\x1b[?27u", "\x1b]11;?\x07"])
    expect(cap.multiplexer).toBe("none")
  })
})
