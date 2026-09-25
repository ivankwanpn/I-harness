import { describe, expect, it } from "vitest"
import type { HistoryRange } from "@i-harness/sdk"
import {
  applyHistory,
  applyNotification,
  emptyEventWindow,
  markDisconnected,
} from "../src/renderer/session/event-window.ts"

type WireEvent = HistoryRange["events"][number]

function event(seq: number | undefined, text: string): WireEvent {
  return { type: "assistant/message", text, ...(seq === undefined ? {} : { seq }) }
}

function page(events: WireEvent[], nextSeq: number): HistoryRange {
  return { events, nextSeq }
}

describe("Desktop event window", () => {
  it("keeps seq 0 from the first page and advances the cursor to nextSeq", () => {
    const state = applyHistory(emptyEventWindow(), page([event(0, "a"), event(1, "b")], 2))

    expect(state.events.map((row) => row.seq)).toEqual([0, 1])
    expect(state.cursor).toBe(2) // next unread seq, not the last displayed one
    expect(state.connection).toBe("online")
  })

  it("merges an overlapping live event and a replayed duplicate exactly once", () => {
    let state = applyHistory(emptyEventWindow(), page([event(0, "a"), event(1, "b")], 2))
    state = applyNotification(state, event(2, "live"))

    expect(state.cursor).toBe(2) // a live event never advances the durable cursor

    state = applyHistory(state, page([event(2, "replayed"), event(3, "c")], 4))

    expect(state.events.map((row) => row.seq)).toEqual([0, 1, 2, 3])
    expect(state.events.find((row) => row.seq === 2)).toEqual(event(2, "replayed"))
    expect(state.cursor).toBe(4)
  })

  it("never moves the cursor backwards on a stale page", () => {
    let state = applyHistory(emptyEventWindow(), page([event(0, "a")], 3))
    state = applyHistory(state, page([event(1, "b")], 2))

    expect(state.cursor).toBe(3)
    expect(state.events.map((row) => row.seq)).toEqual([0, 1])
  })

  it("keeps loaded rows while offline and returns online on the next page", () => {
    let state = applyHistory(emptyEventWindow(), page([event(0, "a")], 1))
    state = markDisconnected(state)

    expect(state.connection).toBe("offline")
    expect(state.events.map((row) => row.seq)).toEqual([0])

    state = applyHistory(state, page([event(1, "b")], 2))
    expect(state.connection).toBe("online")
  })

  it("keeps an unsequenced event in live only and never as a checkpoint", () => {
    const state = applyNotification(emptyEventWindow(), event(undefined, "transient"))

    expect(state.events).toEqual([])
    expect(state.live).toHaveLength(1)
    expect(state.cursor).toBe(0)
  })

  it("does not mutate the state it was given", () => {
    const before = applyHistory(emptyEventWindow(), page([event(0, "a")], 1))
    const snapshot = structuredClone(before)

    applyNotification(before, event(1, "b"))
    applyHistory(before, page([event(1, "b")], 2))
    markDisconnected(before)

    expect(before).toEqual(snapshot)
  })
})
