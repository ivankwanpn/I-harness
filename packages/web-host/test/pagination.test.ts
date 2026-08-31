import { describe, expect, it } from "vitest"
import { createSession, type Session, type SessionEvent } from "@i-harness/core-session"
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, paginateEvents } from "../src/pagination.ts"

// `append` overwrites the caller's seq with the 0-indexed log position
// (`{ ...event, seq: session.events.length }` in core-session — its own tests
// assert `seq === 0` for the first event). paginateEvents operates over
// persisted-log seqs (what the web-host serves via fromJSONL), so the fixture
// writes the log directly to control seqs exactly (1..n) instead of routing
// through append.
function sessionOf(events: SessionEvent[]): Session {
  const s = createSession()
  for (const e of events) s.events.push(e)
  return s
}

function evs(n: number): SessionEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "user/message" as const,
    text: `m${i}`,
    seq: i + 1,
  }))
}

describe("paginateEvents", () => {
  it("returns newest page when beforeSeq omitted (limit 3 of 10)", () => {
    const s = sessionOf(evs(10))
    const page = paginateEvents(s, { limit: 3 })
    expect(page.events.length).toBe(3)
    expect(page.events.map(e => (e as any).seq)).toEqual([8, 9, 10])
    expect(page.hasMore).toBe(true)
    expect(page.nextBeforeSeq).toBe(8)
  })

  it("returns page before beforeSeq (limit 3, beforeSeq 8 → seq 5,6,7)", () => {
    const s = sessionOf(evs(10))
    const page = paginateEvents(s, { beforeSeq: 8, limit: 3 })
    expect(page.events.map(e => (e as any).seq)).toEqual([5, 6, 7])
    expect(page.hasMore).toBe(true)
    expect(page.nextBeforeSeq).toBe(5)
  })

  it("hasMore false at the oldest page", () => {
    const s = sessionOf(evs(5))
    const page = paginateEvents(s, { beforeSeq: 2, limit: 5 })
    expect(page.events.map(e => (e as any).seq)).toEqual([1])
    expect(page.hasMore).toBe(false)
    expect(page.nextBeforeSeq).toBe(1)
  })

  // Review MUST-FIX: `Math.max(1, NaN)` is NaN and `slice(-NaN)` ===
  // `slice(0)` — a non-numeric `?limit=abc` used to return the ENTIRE session.
  it("non-finite limit falls back to the default page, not the whole log", () => {
    const s = sessionOf(evs(DEFAULT_PAGE_LIMIT + 50))
    const page = paginateEvents(s, { limit: Number.NaN })
    expect(page.events.length).toBe(DEFAULT_PAGE_LIMIT)
    expect(page.hasMore).toBe(true)
    expect(page.nextBeforeSeq).toBe(51) // tail = seqs 51..250
  })

  it("limit is clamped to the max page size", () => {
    const s = sessionOf(evs(MAX_PAGE_LIMIT + 100))
    const page = paginateEvents(s, { limit: 100_000 })
    expect(page.events.length).toBe(MAX_PAGE_LIMIT)
  })

  it("non-finite beforeSeq is treated as absent", () => {
    const s = sessionOf(evs(10))
    const page = paginateEvents(s, { limit: 3, beforeSeq: Number.NaN })
    expect(page.events.map(e => (e as any).seq)).toEqual([8, 9, 10])
    expect(page.hasMore).toBe(true)
  })
})

it("afterSeq replays forward and pages to exhaustion", () => {
  const s = sessionOf(evs(5))
  const page1 = paginateEvents(s, { afterSeq: 0, limit: 2 })
  expect(page1.events.map((e) => e.seq)).toEqual([1, 2])
  expect(page1.hasMore).toBe(true)
  expect(page1.nextAfterSeq).toBe(2)
  const page2 = paginateEvents(s, { afterSeq: page1.nextAfterSeq, limit: 2 })
  expect(page2.events.map((e) => e.seq)).toEqual([3, 4])
  expect(page2.hasMore).toBe(true)
  expect(page2.nextAfterSeq).toBe(4)
  const page3 = paginateEvents(s, { afterSeq: page2.nextAfterSeq, limit: 2 })
  expect(page3.events.map((e) => e.seq)).toEqual([5])
  expect(page3.hasMore).toBe(false)
  expect(page3.nextAfterSeq).toBe(5)
})

it("afterSeq beyond the log is an empty page", () => {
  const s = sessionOf(evs(3))
  const page = paginateEvents(s, { afterSeq: 999 })
  expect(page.events).toEqual([])
  expect(page.hasMore).toBe(false)
  expect(page.nextAfterSeq).toBeUndefined()
})
