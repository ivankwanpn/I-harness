import { describe, expect, it } from "vitest"
import type { HistoryRange } from "@i-harness/sdk"
import {
  applyHistory,
  applyNotification,
  emptyEventWindow,
  MAX_RETAINED_EVENTS,
  MAX_RETAINED_LIVE,
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
  it("keeps an old gateway's admission bytes out of the retained renderer window", () => {
    const image = { mediaType: "image/png" as const, dataBase64: "aGVsbG8=" }
    const admission: WireEvent = { type: "agent/input/admitted", version: 1, inputId: "q1", text: "inspect", delivery: "queue", intent: "user", images: [image], seq: 0 }
    const user: WireEvent = { type: "user/message", text: "inspect", images: [image], seq: 1 }
    let state = applyNotification(emptyEventWindow(), admission)
    expect(state.events[0]).not.toHaveProperty("images")
    state = applyHistory(state, page([admission, user], 2))
    expect(state.events[0]).not.toHaveProperty("images")
    expect(state.events[1]).toMatchObject({ images: [image] })
    expect(admission).toHaveProperty("images", [image])
  })
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

  it("appends a strictly newer notification in order without re-sorting", () => {
    let state = applyHistory(emptyEventWindow(), page([event(0, "a")], 1))
    state = applyNotification(state, event(5, "later"))
    state = applyNotification(state, event(6, "latest"))

    expect(state.events.map((row) => row.seq)).toEqual([0, 5, 6])
    expect(state.cursor).toBe(1) // live appends never move the durable cursor
  })

  it("caps the retained window instead of growing without bound", () => {
    const events = Array.from({ length: MAX_RETAINED_EVENTS + 5_000 }, (_, index) => event(index, `m${index}`))
    const state = applyHistory(emptyEventWindow(), page(events, events.length))

    expect(state.events).toHaveLength(MAX_RETAINED_EVENTS)
    expect(state.events[0]?.seq).toBe(5_000)
    expect(state.events.at(-1)?.seq).toBe(events.length - 1)
    expect(state.cursor).toBe(events.length)
  })

  it("caps unsequenced live rows too", () => {
    let state = emptyEventWindow()
    for (let index = 0; index < MAX_RETAINED_LIVE + 25; index += 1) {
      state = applyNotification(state, event(undefined, `t${index}`))
    }

    expect(state.live).toHaveLength(MAX_RETAINED_LIVE)
    expect((state.live.at(-1) as { text: string }).text).toBe(`t${MAX_RETAINED_LIVE + 24}`)
  })
})
