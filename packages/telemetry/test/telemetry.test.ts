// packages/telemetry/test/telemetry.test.ts — TDD 核心（多播 + JSONL + 錯誤隔離）
import { expect, it, vi } from "vitest"
import { createTelemetry, createJsonlSink, type TelemetryEvent } from "../src/index.ts"

it("emit multicasts to all sinks", () => {
  const a: TelemetryEvent[] = []; const b: TelemetryEvent[] = []
  const tele = createTelemetry([{ onEvent: (e) => a.push(e) }, { onEvent: (e) => b.push(e) }])
  tele.emit({ type: "turn/start", ts: 1, data: {} })
  expect(a).toHaveLength(1); expect(b).toHaveLength(1)
})

it("sink errors fail-visible (warn) without breaking others", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const good: TelemetryEvent[] = []
  const tele = createTelemetry([{ onEvent: () => { throw new Error("sink boom") } }, { onEvent: (e) => good.push(e) }])
  tele.emit({ type: "turn/start", ts: 1, data: {} })
  expect(warn).toHaveBeenCalled(); expect(good).toHaveLength(1)
})

it("jsonl sink writes one JSON line per event to the stream", () => {
  const chunks: string[] = []
  const stream = { write: (s: string) => { chunks.push(s); return true } } as NodeJS.WritableStream
  const sink = createJsonlSink(stream)
  sink.onEvent({ type: "mcp/server-status", ts: 123, data: { server: "alpha" } })
  expect(chunks).toHaveLength(1)
  expect(JSON.parse(chunks[0]!)).toMatchObject({ ts: 123, type: "mcp/server-status", data: { server: "alpha" } })
})
