import { describe, expect, it, vi } from "vitest"
import type { HistoryRange } from "@i-harness/sdk"
import { loadHistory } from "../src/renderer/session/history.ts"

type WireEvent = HistoryRange["events"][number]

function event(seq: number): WireEvent {
  return { type: "user/message", text: `m${seq}`, seq }
}

function page(from: number, count: number, nextSeq: number): HistoryRange {
  return { events: Array.from({ length: count }, (_, index) => event(from + index)), nextSeq }
}

describe("loadHistory", () => {
  it("pages from the cursor until the durable log is exhausted", async () => {
    const pages = [page(0, 500, 500), page(500, 500, 1000), page(1000, 120, 1120)]
    const request = vi.fn(async (params: { afterSeq: number; limit: number }) => {
      const found = pages.find((candidate) => candidate.events[0]?.seq === params.afterSeq)
      return found ?? { events: [], nextSeq: params.afterSeq }
    })

    const result = await loadHistory(request, { afterSeq: 0, limit: 500 })

    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls.map(([params]) => params.afterSeq)).toEqual([0, 500, 1000])
    expect(result.cursor).toBe(1120)
    expect(result.events).toHaveLength(1120)
    expect(result.exhausted).toBe(true)
  })

  it("stops on an empty page and reports that the window was truncated", async () => {
    const request = vi.fn(async (params: { afterSeq: number }) => params.afterSeq === 0
      ? page(0, 500, 500)
      : { events: [], nextSeq: params.afterSeq })

    const result = await loadHistory(request, { afterSeq: 0, limit: 500, maxPages: 1 })

    expect(request).toHaveBeenCalledTimes(1)
    expect(result.cursor).toBe(500)
    expect(result.exhausted).toBe(false)
  })
})
