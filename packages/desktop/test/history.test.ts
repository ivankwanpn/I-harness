import { describe, expect, it, vi } from "vitest"
import type { HistoryRange } from "@i-harness/sdk"
import { loadHistory, loadRecentHistory } from "../src/renderer/session/history.ts"

type WireEvent = HistoryRange["events"][number]

function event(seq: number): WireEvent {
  return { type: "user/message", text: `m${seq}`, seq }
}

function page(from: number, count: number, nextSeq: number): HistoryRange {
  return { events: Array.from({ length: count }, (_, index) => event(from + index)), nextSeq }
}

describe("loadHistory", () => {
  it("opens the newest bounded tail in one request", async () => {
    const size = 100_000
    const request = vi.fn(async ({ beforeSeq, limit }: { afterSeq: number; beforeSeq?: number; limit: number }) => {
      const end = Math.min(size, beforeSeq ?? 0)
      const start = Math.max(0, end - limit)
      return { ...page(start, end - start, end), startSeq: start, headSeq: size }
    })
    const result = await loadRecentHistory(request, { limit: 500 })
    expect(request.mock.calls[0]![0]).toEqual({ afterSeq: 0, beforeSeq: Number.MAX_SAFE_INTEGER, limit: 500 })
    expect(result.startSeq).toBe(99_500)
    expect(result.events[0]?.seq).toBe(99_500)
    expect(result.events.at(-1)?.seq).toBe(99_999)
    expect(result.cursor).toBe(100_000)
    expect(result.events).toHaveLength(500)
    expect(request).toHaveBeenCalledTimes(1)
  })
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