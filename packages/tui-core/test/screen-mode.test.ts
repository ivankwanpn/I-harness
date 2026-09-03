// G2 screen-mode policy — decision table: cli > config > auto (zellij/tmux →
// inline, legacy → minimal, else fullscreen), M36 pending-engine downgrade.
import { describe, expect, it } from "vitest"
import { resolveScreenMode } from "../src/screen-mode/index.ts"
import { createUnknownCapabilities, type TerminalCapabilityContext } from "../src/types.ts"

const base: TerminalCapabilityContext = createUnknownCapabilities()
const zellij: TerminalCapabilityContext = { ...base, multiplexer: "zellij" }
const tmux: TerminalCapabilityContext = { ...base, multiplexer: "tmux" }
const legacy: TerminalCapabilityContext = { ...base, legacyConsole: true }

const PENDING = "pending-inline-engine (M37)"

describe("resolveScreenMode", () => {
  it("cli wins over config", () => {
    const r = resolveScreenMode({ cli: "minimal", config: "fullscreen", cap: base })
    expect(r.mode).toBe("minimal")
    expect(r.fallback).toBe("fullscreen")
    expect(r.reason).toBe(PENDING)
  })

  it("explicit cli fullscreen beats auto zellij with no fallback", () => {
    const r = resolveScreenMode({ cli: "fullscreen", cap: zellij })
    expect(r.mode).toBe("fullscreen")
    expect(r.fallback).toBe("fullscreen")
    expect(r.reason).toBe("cli")
  })

  it("config wins over auto", () => {
    const r = resolveScreenMode({ config: "fullscreen", cap: zellij })
    expect(r.mode).toBe("fullscreen")
    expect(r.fallback).toBe("fullscreen")
    expect(r.reason).toBe("config")
  })

  it("config inline still downgrades via the pending fallback", () => {
    const r = resolveScreenMode({ config: "inline", cap: zellij })
    expect(r.mode).toBe("inline")
    expect(r.fallback).toBe("fullscreen")
    expect(r.reason).toBe(PENDING)
  })

  it("auto: zellij → inline w/ fallback fullscreen (no inline engine in M36)", () => {
    const r = resolveScreenMode({ cap: zellij })
    expect(r.mode).toBe("inline")
    expect(r.fallback).toBe("fullscreen")
    expect(r.reason).toBe(PENDING)
  })

  it("auto: tmux → inline w/ fallback fullscreen", () => {
    const r = resolveScreenMode({ cap: tmux })
    expect(r.mode).toBe("inline")
    expect(r.fallback).toBe("fullscreen")
    expect(r.reason).toBe(PENDING)
  })

  it("auto: legacy console → minimal w/ fallback fullscreen", () => {
    const r = resolveScreenMode({ cap: legacy })
    expect(r.mode).toBe("minimal")
    expect(r.fallback).toBe("fullscreen")
    expect(r.reason).toBe(PENDING)
  })

  it("auto: default → fullscreen, no fallback", () => {
    const r = resolveScreenMode({ cap: base })
    expect(r.mode).toBe("fullscreen")
    expect(r.fallback).toBe("fullscreen")
    expect(r.reason).toBe("auto:default")
  })
})
