// M46b G1: the scroll-stream normalizer — the grok delta table (brand
// events-per-tick / lines-per-tick / speed multiplier math), the flush cap,
// wheel promotion, trackpad accel + carry, the direction flip cancel and the
// 80ms gap finalize (with the injected clock).

import { describe, expect, it } from "vitest"
import {
  ScrollStreamNormalizer,
  brandEventsPerTick,
  brandWheelLinesPerTick,
  brandTrackpadLinesPerTick,
  speedToMultiplier,
  flushCapOf,
  scrollStreamConfig,
} from "../src/app/scroll-stream.ts"

// ------------------------------------------------------------------ brand table (delta Area 1)

describe("brand profile math (delta table)", () => {
  it("events-per-tick: 3-brand family vs 1-brand family vs default", () => {
    expect(brandEventsPerTick("AppleTerminal", "none")).toBe(3)
    expect(brandEventsPerTick("WarpTerminal", "none")).toBe(3)
    expect(brandEventsPerTick("Alacritty", "none")).toBe(3)
    expect(brandEventsPerTick("Rio", "none")).toBe(3)
    expect(brandEventsPerTick("Foot", "none")).toBe(3)
    expect(brandEventsPerTick("Ghostty", "none")).toBe(3)
    expect(brandEventsPerTick("Kitty", "none")).toBe(3)
    expect(brandEventsPerTick("WezTerm", "none")).toBe(1)
    expect(brandEventsPerTick("Iterm2", "none")).toBe(1)
    expect(brandEventsPerTick("VsCode", "none")).toBe(1)
    expect(brandEventsPerTick("Cursor", "none")).toBe(1)
    expect(brandEventsPerTick("Windsurf", "none")).toBe(1)
    expect(brandEventsPerTick("Zed", "none")).toBe(1)
    expect(brandEventsPerTick("WindowsTerminal", "none")).toBe(3) // default
    expect(brandEventsPerTick("Unknown", "none")).toBe(3)
    // multiplexer re-encoding → conservative ept=1 shape.
    expect(brandEventsPerTick("Kitty", "tmux")).toBe(1)
    expect(brandEventsPerTick("WezTerm", "zellij")).toBe(1)
  })

  it("wheel/trackpad lines per tick: iTerm2+WezTerm 1 wheel, VS-family 15 trackpad", () => {
    expect(brandWheelLinesPerTick("Iterm2", "none")).toBe(1)
    expect(brandWheelLinesPerTick("WezTerm", "none")).toBe(1)
    expect(brandWheelLinesPerTick("Kitty", "none")).toBe(3)
    expect(brandWheelLinesPerTick("WindowsTerminal", "none")).toBe(3)
    expect(brandWheelLinesPerTick("Kitty", "screen")).toBe(1) // remux conservatism
    expect(brandTrackpadLinesPerTick("VsCode", "none")).toBe(15)
    expect(brandTrackpadLinesPerTick("Kitty", "none")).toBe(3)
  })

  it("speed multiplier: 1→0.1×, 50→1.0× (default), 100→6.0×, linear both sides", () => {
    expect(speedToMultiplier(1)).toBeCloseTo(0.1, 5)
    expect(speedToMultiplier(50)).toBeCloseTo(1.0, 5)
    expect(speedToMultiplier(100)).toBeCloseTo(6.0, 5)
    expect(speedToMultiplier(75)).toBeCloseTo(3.5, 5) // 1.0 + 25*(5/50)
    expect(speedToMultiplier(25)).toBeCloseTo(0.1 + (24 * 0.9) / 49, 5)
  })

  it("flush cap: max(viewport/2, 6)", () => {
    const cfg = scrollStreamConfig({ brand: "Kitty", multiplexer: "none" }, { speed: 50, mode: "auto", invert: false }, 24)
    expect(flushCapOf(cfg)).toBe(12)
    expect(flushCapOf({ ...cfg, viewportRows: 4 })).toBe(6)
  })
})

// ------------------------------------------------------------------ engine math

const winTerm = () => new ScrollStreamNormalizer(
  { brand: "WindowsTerminal", multiplexer: "none" },
  { speed: 50, mode: "auto", invert: false },
  { viewportRows: 24, now: () => 0 },
)
const iterm2 = () => new ScrollStreamNormalizer(
  { brand: "Iterm2", multiplexer: "none" },
  { speed: 50, mode: "auto", invert: false },
  { viewportRows: 24, now: () => 0 },
)

describe("ScrollStreamNormalizer — wheel", () => {
  it("one wheel event on an ept=3 brand delivers ONE line per event", () => {
    const n = winTerm()
    // 1 event = 1/3 of the 3-line notch — the delta pricing (old M40 ±3 is
    // superseded by the stream normalization).
    expect(n.push("up").lines).toBe(-1)
    expect(n.push("down").lines).toBe(1)
  })

  it("three events within the promotion window = the full 3-line notch (wheel promote)", () => {
    const n = new ScrollStreamNormalizer(
      { brand: "Kitty", multiplexer: "none" },
      { speed: 50, mode: "auto", invert: false },
      { viewportRows: 24, now: () => 0 },
    )
    let total = 0
    for (let i = 0; i < 3; i++) {
      const delta = n.push("down", i * 3) // 12ms window
      total += delta.lines
    }
    expect(total).toBe(3)
  })

  it("ept=1 brand prices ONE line per event (WezTerm wheel_lpt=1)", () => {
    const n = iterm2()
    expect(n.push("down").lines).toBe(1)
  })

  it("scroll_lines override scales both paths (6 lines/tick → 3 events = 6 lines)", () => {
    const n = new ScrollStreamNormalizer(
      { brand: "Kitty", multiplexer: "none" },
      { speed: 50, mode: "auto", invert: false, lines: 6 },
      { viewportRows: 24, now: () => 0 },
    )
    let total = 0
    for (let i = 0; i < 3; i++) total += n.push("down", i * 3).lines
    expect(total).toBe(6)
  })

  it("invert flips the sign", () => {
    const n = new ScrollStreamNormalizer(
      { brand: "Kitty", multiplexer: "none" },
      { speed: 50, mode: "auto", invert: true },
      { viewportRows: 24, now: () => 0 },
    )
    expect(n.push("down").lines).toBe(-1)
  })

  it("speed multiplier 100 (6×) scales the notch (3 events → 18 lines)", () => {
    const n = new ScrollStreamNormalizer(
      { brand: "Kitty", multiplexer: "none" },
      { speed: 100, mode: "auto", invert: false },
      { viewportRows: 24, now: () => 0 },
    )
    let total = 0
    for (let i = 0; i < 3; i++) total += n.push("down", i * 3).lines
    expect(total).toBe(18)
  })

  it("direction flip cancels the old backlog (no stale opposite jump)", () => {
    const n = winTerm()
    let total = 0
    for (let i = 0; i < 5; i++) total += n.push("down", i * 100).lines // 1 event flush each
    expect(total).toBe(5)
    // flip: the old stream's backlog is discarded; the fresh stream prices 1.
    const flip = n.push("up", 600)
    expect(flip.lines).toBe(-1)
  })
})

describe("ScrollStreamNormalizer — trackpad + gap", () => {
  it("forced trackpad mode accel-weights fast events (2.5×) with the ept=3 divisor", () => {
    const n = new ScrollStreamNormalizer(
      { brand: "AppleTerminal", multiplexer: "none" },
      { speed: 50, mode: "trackpad", invert: false },
      { viewportRows: 24, now: () => 0 },
    )
    let total = 0
    for (let i = 0; i < 3; i++) total += n.push("down", i * 8).lines // 8ms fast band
    // accelWeighted = 1 (ev1) + 2.5 (ev2) + 2.5 (ev3) = 6 → desired = 6 × (3/3) × 1
    // = 6.0 lines, delivered 1 + 2 + 3 in per-event flushes.
    expect(total).toBe(6)
  })

  it("slow trackpad stays at 1× (intervals above the medium band)", () => {
    const n = new ScrollStreamNormalizer(
      { brand: "AppleTerminal", multiplexer: "none" },
      { speed: 50, mode: "trackpad", invert: false },
      { viewportRows: 24, now: () => 0 },
    )
    let total = 0
    for (let i = 0; i < 3; i++) total += n.push("down", i * 40).lines // 40ms slow
    expect(total).toBe(3)
  })

  it("ept=1 auto detects trackpad when the avg interval < 30ms (per-frame flush)", () => {
    // VS-family ept=1 + rapid events → trackpad pricing (15 lines/tick).
    const n = new ScrollStreamNormalizer(
      { brand: "VsCode", multiplexer: "none" },
      { speed: 50, mode: "auto", invert: false },
      { viewportRows: 24, now: () => 0 },
    )
    let total = 0
    for (let i = 0; i < 4; i++) total += n.push("down", i * 12).lines // 12ms avg
    // Uneven: pre-promotion events price the wheel 1-line path; the promoted
    // tail reprices — the total is still positive and > the plain 1/event.
    expect(total).toBeGreaterThan(4)
  })

  it("80ms gap finalizes the stream; the onTick drain shows no leftover + carry", () => {
    const n = new ScrollStreamNormalizer(
      { brand: "AppleTerminal", multiplexer: "none" },
      { speed: 50, mode: "trackpad", invert: false },
      { viewportRows: 24, now: () => 0 },
    )
    n.push("down", 0) // 1 event × 1× = 1.0 → 1 line
    const tail = n.onTick(100) // 100ms later — past the 80ms gap
    expect(tail.active).toBe(false)
    expect(tail.lines).toBe(0)
    expect(n.hasActiveStream()).toBe(false)
  })

  it("sub-line remainder carries into the next same-direction stream", () => {
    const n = new ScrollStreamNormalizer(
      { brand: "AppleTerminal", multiplexer: "none" },
      { speed: 50, mode: "trackpad", invert: false },
      { viewportRows: 24, now: () => 0 },
    )
    // ev1: accel 1 → desired 1.0 → flush 1. ev2 (8ms): accel 2.5 → desired 3.5
    // → flush 2 (applied 3, remainder 0.5).
    expect(n.push("down", 0).lines).toBe(1)
    expect(n.push("down", 8).lines).toBe(2)
    expect(n.onTick(105).active).toBe(false) // gap finalizes, carry = 0.5
    // next same-direction stream: desired = 1×1 + carry 0.5 = 1.5 → 1 line.
    expect(n.push("down", 110).lines).toBe(1)
  })
})
