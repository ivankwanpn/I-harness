// M39 G2: scrollback bench — measured duration asserts with GENEROUS
// thresholds (CI noise tolerant) + console.table so the machine's numbers
// land in the docs. Mirrors what real usage does: appends, lineCount,
// viewport, page-nav (viewport at page offsets), fold toggles, search, and
// the M39 retain (display-trunk trim).

import { describe, expect, it } from "vitest"
import type { TuiEvent } from "../src/contracts.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"

const WIDTH = 90
const INNER = WIDTH - 6 // 84

const pairs = (n: number, opt: { wide: number } = { wide: 420 }): TuiEvent[] => {
  const evs: TuiEvent[] = []
  for (let i = 0; i < n; i++) {
    evs.push({ type: "user", text: `u${i}`, seq: 2 * i + 1, ts: 0 })
    evs.push({ type: "assistant", text: "x".repeat(opt.wide), seq: 2 * i + 2, ts: 0 })
  }
  // the last assistant stays open (streaming) — real-world tail.
  evs.push({ type: "user", text: "tail", seq: 2 * n + 1, ts: 0 })
  evs.push({ type: "assistant", text: "y".repeat(opt.wide), seq: 2 * n + 2, ts: 0 })
  return evs
}

const build = (pairsN: number, wide: number): ReturnType<typeof createScrollbackEngine> => {
  const e = createScrollbackEngine({ width: WIDTH })
  const evs = pairs(pairsN, { wide })
  for (const ev of evs) e.append(ev)
  return e
}

describe("bench — scrollback engine (thresholds generous for CI noise)", () => {
  it("append-rate: 5000 events (< 2000ms)", () => {
    const e = createScrollbackEngine({ width: WIDTH })
    const evs = pairs(2499, { wide: 340 }) // 5000 events (2499 pairs + tail pair)
    expect(evs.length).toBe(5000)
    const t0 = performance.now()
    for (const ev of evs) e.append(ev)
    const ms = performance.now() - t0
    console.table([{ op: "append 5k events", ms: +ms.toFixed(1) }])
    expect(ms).toBeLessThan(2000)
  })

  it("20k lines: lineCount, viewport, page nav, fold ×100, search, retain", () => {
    const e = build(3334, 420) // 3335 × (1+5) ≈ 20,010 lines
    const total = e.lineCount()
    expect(total).toBeGreaterThan(20_000)

    // lineCount over the whole buffer.
    let t0 = performance.now()
    for (let i = 0; i < 50; i++) e.lineCount()
    const lineCount50 = performance.now() - t0

    // viewport(h): a 40-row window at scattered offsets (50 calls, < 150ms).
    const step = Math.floor(total / 50)
    t0 = performance.now()
    for (let i = 0; i < 50; i++) e.viewport(i * step, 40)
    const viewport50 = performance.now() - t0

    // page nav: half-page jumps across the buffer (100 viewport windows).
    const page = 12
    t0 = performance.now()
    for (let i = 0; i < 100; i++) e.viewport((i * page) % total, page * 2)
    const pageNav100 = performance.now() - t0

    // fold toggles ×100 on live lines (< 100ms).
    t0 = performance.now()
    for (let i = 0; i < 100; i++) e.toggleFoldAt(Math.floor((i * 37) % e.lineCount()))
    const fold100 = performance.now() - t0

    // search over the display lines.
    t0 = performance.now()
    const hits = e.search("xxx")
    const searchMs = performance.now() - t0
    expect(hits).toBeGreaterThan(0)

    // M39 retain: trim a 23k-line scrollback to 1500 (block-granular + marker).
    t0 = performance.now()
    const r = e.retain !== undefined ? e.retain({ maxLines: 1500 }) : { trimmedBlocks: 0 }
    const retainMs = performance.now() - t0
    const after = { lineCount: e.lineCount(), trimmed: r.trimmedBlocks }

    console.table([
      { op: "lineCount ×50 (23k lines)", ms: +lineCount50.toFixed(1) },
      { op: "viewport 40-row ×50", ms: +viewport50.toFixed(1) },
      { op: "page nav ×100", ms: +pageNav100.toFixed(1) },
      { op: "toggleFoldAt ×100", ms: +fold100.toFixed(1) },
      { op: "search 'xxx' 23k lines", ms: +searchMs.toFixed(1) },
      { op: `retain → 1500 (${after.trimmed} blocks)`, ms: +retainMs.toFixed(1) },
      { op: "lineCount after retain", lines: after.lineCount },
    ])

    expect(viewport50).toBeLessThan(150)
    expect(fold100).toBeLessThan(100)
    expect(retainMs).toBeLessThan(500)
    expect(searchMs).toBeLessThan(250)
    expect(after.lineCount).toBeLessThanOrEqual(1501 + INNER)
    // marker pinned on top; the semantics hold after the trim.
    expect(e.viewport(0, 1)[0].runs[0].text).toContain("earlier")
  })

  it("search over a 5k-line buffer (< 250ms)", () => {
    const e = build(699, 510) // 700 × (1 + ceil(510/84)=7) ≈ 5600 lines
    const total = e.lineCount()
    expect(total).toBeGreaterThan(5000)
    const t0 = performance.now()
    const hits = e.search("u-steal") // 0 matches — full scan worst case
    const ms = performance.now() - t0
    console.table([{ op: `search miss over ${total} lines`, ms: +ms.toFixed(1) }])
    expect(hits).toBe(0)
    expect(ms).toBeLessThan(250)
  })
})
