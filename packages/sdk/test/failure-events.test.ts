import { expect, it } from "vitest"
import { boundedFailureEvents } from "../src/server.ts"
import type { SessionEvent } from "@i-harness/core-session"

const big = (seq: number, bytes: number) => ({ type: "assistant/message", text: "x".repeat(bytes), seq }) as unknown as SessionEvent

it("keeps the newest events within the failure budget, in order", () => {
  const events = [big(0, 100 * 1024), big(1, 100 * 1024), big(2, 100 * 1024)]
  const kept = boundedFailureEvents(events)
  expect(kept.map(event => event.seq)).toEqual([1, 2])
})

it("keeps a small history untouched", () => {
  const events = [big(0, 10), big(1, 10)]
  expect(boundedFailureEvents(events)).toEqual(events)
})

it("keeps a single oversized event instead of returning nothing", () => {
  const events = [big(0, 400 * 1024)]
  expect(boundedFailureEvents(events)).toHaveLength(1)
})
