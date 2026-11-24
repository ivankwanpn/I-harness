import { describe, expect, it } from "vitest"
import type { HistoryRange } from "@i-harness/sdk"
import {
  applyHistory,
  applyNotification,
  createHistoryPreviewCache,
  emptyEventWindow,
  MAX_RETAINED_EVENTS,
  MAX_RETAINED_LIVE,
  markDisconnected,
  timelineEvents,
} from "../src/renderer/session/event-window.ts"

type WireEvent = HistoryRange["events"][number]

function event(seq: number | undefined, text: string): WireEvent {
  return { type: "assistant/message", text, ...(seq === undefined ? {} : { seq }) }
}

function page(events: WireEvent[], nextSeq: number): HistoryRange {
  return { events, nextSeq }
}

describe("Desktop event window", () => {
  it("retains one recent page of durable events per preview and evicts the least recently used session", () => {
    const cache = createHistoryPreviewCache()
    const events = Array.from({ length: 1200 }, (_, i) => event(i, String(i)))
    const active = { ...emptyEventWindow(), events, live: [event(undefined, "streaming")], cursor: 1200 }
    for (const key of ["a", "b", "c", "d"]) cache.set(key, active)
    expect(cache.get("a")).toMatchObject({ cursor: 1200, live: [] })
    cache.set("e", active)
    expect(cache.get("b")).toBeUndefined()
    expect(cache.get("a")!.events).toEqual(events.slice(700))
    expect(active.events).toHaveLength(1200)
    expect(active.live).toHaveLength(1)
  })

  it("drops a cached preview when its newest page includes an image and retains the active message", () => {
    const cache = createHistoryPreviewCache()
    const original = applyHistory(emptyEventWindow(), page([event(0, "hello")], 1))
    cache.set("a", original)
    expect(cache.get("a")).toBeDefined()

    const imageMessage: WireEvent = { type: "user/message", seq: 1, text: "image", images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=" }] }
    const withImage = applyHistory(original, page([imageMessage], 2))
    cache.set("a", withImage)
    expect(cache.get("a")).toBeUndefined()
    expect(withImage.events.at(-1)).toEqual(imageMessage)

    const text = Array.from({ length: 500 }, (_, index) => event(index + 2, "later text"))
    cache.set("a", applyHistory(withImage, page(text, 502)))
    expect(cache.get("a")?.events).toEqual(text)
  })

  it("keeps stable rows on empty replay and prefers the last durable record in an unordered page", () => {
    const original = applyHistory(emptyEventWindow(), page([event(0, "zero"), event(2, "old"), event(4, "four")], 5))
    expect(applyHistory(original, page([], 6)).events).toBe(original.events)
    const incoming = [event(3, "three"), event(2, "first"), event(undefined, "unsequenced"), event(2, "replacement")]
    expect(applyHistory(original, page(incoming, 5)).events).toEqual([original.events[0], incoming[3], incoming[0], original.events[2]])
  })

  it("drops a disjoint cached prefix while keeping newer notifications beyond a refreshed tail", () => {
    const cached = applyHistory(emptyEventWindow(), page([event(9, "cached")], 10))
    const withArrival = applyNotification(cached, event(51, "newer live arrival"))
    const fresh = applyHistory(withArrival, { startSeq: 50, events: [event(50, "fresh")], nextSeq: 51 })
    expect(fresh.events.map(row => row.seq)).toEqual([50, 51])
    expect(fresh.cursor).toBe(51)
    expect(applyHistory(cached, { startSeq: 10, events: [event(10, "adjacent")], nextSeq: 11 }).events).toHaveLength(2)
  })

  it("coalesces live assistant text and drops delayed chunks once its durable reply arrives", () => {
    let state = applyHistory(emptyEventWindow(), page([{ type: "step/start", seq: 5 }], 6))
    const history = state.events
    for (const [offset, text] of [[0, "start "], [6, "answer"], [4, "t answer"]] as const) {
      state = applyNotification(state, { type: "assistant/chunk", stepStartSeq: 5, offset, text })
    }
    expect(state.assistantPreview).toEqual({ type: "assistant/chunk", stepStartSeq: 5, offset: 0, text: "start answer" })
    expect(state.events).toBe(history)
    expect(state.live).toEqual([])
    expect(state.cursor).toBe(6)
    const completed = event(6, "start answer")
    state = applyNotification(state, completed)
    expect(state.assistantPreview).toBeUndefined()
    expect(applyNotification(state, { type: "assistant/chunk", stepStartSeq: 5, offset: 12, text: "late" })).toBe(state)
    expect(timelineEvents(state).at(-1)).toEqual(completed)
  })

  it("retires a failed assistant preview while admitting the new attempt on the same session", () => {
    let state = applyHistory(emptyEventWindow(), page([{ type: "step/start", seq: 5 }], 6))
    state = applyNotification(state, { type: "assistant/chunk", stepStartSeq: 5, offset: 0, text: "old" })
    state = applyHistory(state, page([{ type: "step/failed", seq: 6 }, { type: "step/start", seq: 7 }], 8))
    state = applyNotification(state, { type: "assistant/chunk", stepStartSeq: 5, offset: 3, text: "stale" })
    state = applyNotification(state, { type: "assistant/chunk", stepStartSeq: 7, offset: 0, text: "retry" })
    expect(state.assistantPreview).toEqual({ type: "assistant/chunk", stepStartSeq: 7, offset: 0, text: "retry" })
    state = markDisconnected(state)
    expect(state.assistantPreview).toBeUndefined()
    expect(applyNotification(state, { type: "assistant/chunk", stepStartSeq: 7, offset: 5, text: "late" })).toBe(state)
  })

  it("coalesces long live reasoning blocks without losing their prefix or advancing the durable cursor", () => {
    let state = applyHistory(emptyEventWindow(), page([{ type: "step/start", seq: 0 }], 1))
    for (let offset = 0; offset < MAX_RETAINED_LIVE + 25; offset++) {
      state = applyNotification(state, { type: "reasoning/chunk", streamId: "a", blockId: "0", text: "x", offset, atSeq: 1 })
    }
    expect(state.live).toEqual([{ type: "reasoning/chunk", streamId: "a", blockId: "0", text: "x".repeat(225), offset: 0, atSeq: 1 }])
    expect(state.events).toEqual([{ type: "step/start", seq: 0 }])
    expect(state.cursor).toBe(1)
  })

  it("settles live reasoning on replay and ignores a late animation-frame chunk for that completed stream", () => {
    let state = applyNotification(emptyEventWindow(), { type: "reasoning/chunk", streamId: "a", text: "partial", offset: 0, atSeq: 0 })
    const completed: WireEvent = { type: "reasoning", streamId: "a", text: "partial thought", seq: 0 }
    state = applyHistory(state, page([completed], 1))
    expect(state.live).toEqual([])
    state = applyNotification(state, { type: "reasoning/chunk", streamId: "a", text: " thought", offset: 7, atSeq: 0 })
    expect(state.live).toEqual([])
    expect(state.events).toEqual([completed])
  })

  it("settles only the canonical block and orders a later live block before tools received after it", () => {
    let state = applyHistory(emptyEventWindow(), page([{ type: "step/start", seq: 0 }], 1))
    state = applyNotification(state, { type: "reasoning/chunk", streamId: "a", text: "first", offset: 0, atSeq: 1 })
    state = applyNotification(state, { type: "reasoning", streamId: "a", text: "first", seq: 1 })
    state = applyNotification(state, { type: "reasoning/chunk", streamId: "b", text: "second", offset: 0, atSeq: 2 })
    state = applyNotification(state, { type: "tool/call", callId: "r", name: "read", args: {}, seq: 2 })
    expect(state.live).toHaveLength(1)
    expect(timelineEvents(state).map((event) => event.type)).toEqual(["step/start", "reasoning", "reasoning/chunk", "tool/call"])
  })

  it("deduplicates overlapping progress delivery using the text offset", () => {
    let state = applyNotification(emptyEventWindow(), { type: "reasoning/chunk", streamId: "a", text: "Inspect ", offset: 0, atSeq: 0 })
    state = applyNotification(state, { type: "reasoning/chunk", streamId: "a", text: "Inspect ", offset: 0, atSeq: 0 })
    state = applyNotification(state, { type: "reasoning/chunk", streamId: "a", text: "files", offset: 8, atSeq: 0 })
    expect(state.live).toEqual([{ type: "reasoning/chunk", streamId: "a", text: "Inspect files", offset: 0, atSeq: 0 }])
  })

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
