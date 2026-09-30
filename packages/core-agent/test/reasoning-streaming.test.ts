import { afterEach, describe, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, deriveMessages, subscribe, type SessionEvent } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import type { ModelClient } from "@i-harness/llm-seam"
import { createAgent } from "../src/index.ts"

afterEach(() => vi.useRealTimers())

function setup(model: ModelClient) {
  const ctx = createContext()
  const session = createSession()
  const tools = createToolRegistry(ctx)
  tools.register({ name: "read", description: "read", inputSchema: { type: "object" }, execute: async () => "contents" })
  const seen: SessionEvent[] = []
  subscribe(session, (event) => seen.push(event))
  return { session, seen, agent: createAgent(ctx, { session, tools, model, systemPrompt: "p" }) }
}

describe("live provider reasoning", () => {
  it("publishes the first delta immediately and batches more while the same block is still running", async () => {
    vi.useFakeTimers()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const { agent, session, seen } = setup({ async *stream() {
      yield { type: "reasoning", blockId: "0", text: "inspect " }
      yield { type: "reasoning", blockId: "0", text: "the file" }
      await waiting
      yield { type: "text/chunk", text: "done" }
      yield { type: "end" }
    } })
    const run = agent.run("task")
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(seen.filter((event) => event.type === "reasoning/chunk")).toEqual([
        expect.objectContaining({ text: "inspect ", blockId: "0", offset: 0, atSeq: 3 }),
      ])
      expect(session.events.filter((event) => event.type === "reasoning")).toEqual([])
      await vi.advanceTimersByTimeAsync(50)
      expect(seen.filter((event) => event.type === "reasoning/chunk")).toEqual([
        expect.objectContaining({ text: "inspect ", offset: 0 }),
        expect.objectContaining({ text: "the file", offset: 8 }),
      ])
    } finally {
      release()
      await run
    }
    const chunks = seen.filter((event) => event.type === "reasoning/chunk")
    const canonical = session.events.filter((event) => event.type === "reasoning")
    expect(canonical).toEqual([expect.objectContaining({ text: "inspect the file", streamId: chunks[0]?.streamId })])
    expect(session.events.some((event) => event.type === "reasoning/chunk")).toBe(false)
    expect(deriveMessages(session).map((message) => message.content)).toEqual(["task", "done"])
  })

  it("uses separate identities for adjacent blocks, tool rounds and followup turns", async () => {
    let round = 0
    const { agent, session, seen } = setup({ async *stream() {
      round++
      yield { type: "reasoning", blockId: "0", text: `round ${round} first` }
      yield { type: "reasoning", blockId: "1", text: `round ${round} second` }
      if (round === 1) yield { type: "tool_call", call: { id: "read-1", name: "read", args: {} } }
      else yield { type: "text/chunk", text: "done" }
      yield { type: "end" }
    } })
    await agent.run("task")
    await agent.followup("again")
    const canonical = session.events.filter((event) => event.type === "reasoning")
    expect(canonical.map((event) => event.text)).toEqual([
      "round 1 first", "round 1 second", "round 2 first", "round 2 second", "round 3 first", "round 3 second",
    ])
    expect(new Set(canonical.map((event) => event.streamId)).size).toBe(6)
    expect(seen.filter((event) => event.type === "reasoning/chunk").map((event) => event.streamId))
      .toEqual(canonical.map((event) => event.streamId))
    expect(session.events.findIndex((event) => event.type === "reasoning" && event.text === "round 1 second"))
      .toBeLessThan(session.events.findIndex((event) => event.type === "tool/call"))
  })

  it("settles the visible prefix on cancellation and clears pending batch timers before retry", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let round = 0
    const { agent, session, seen } = setup({ async *stream() {
      if (++round === 1) {
        yield { type: "reasoning", blockId: "0", text: "partial " }
        yield { type: "reasoning", blockId: "0", text: "thought" }
        controller.abort()
        yield { type: "end" }
      } else {
        yield { type: "reasoning", blockId: "0", text: "new thought" }
        yield { type: "text/chunk", text: "recovered" }
        yield { type: "end" }
      }
    } })
    await expect(agent.run("task", controller.signal)).rejects.toThrow("agent aborted")
    await agent.followup("retry")
    const beforeTimers = [...seen]
    await vi.advanceTimersByTimeAsync(500)
    expect(seen).toEqual(beforeTimers)
    expect(session.events.filter((event) => event.type === "reasoning").map((event) => event.text))
      .toEqual(["partial thought", "new thought"])
    expect(session.events.some((event) => event.type === "step/failed")).toBe(true)
    expect(new Set(seen.filter((event) => event.type === "reasoning/chunk").map((event) => event.streamId)).size).toBe(2)
  })

  it("stops publishing pending progress as soon as cancellation arrives while the provider is waiting", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const { agent, session, seen } = setup({ async *stream() {
      yield { type: "reasoning", text: "received " }
      yield { type: "reasoning", text: "prefix" }
      await waiting
      yield { type: "end" }
    } })
    const run = agent.run("task", controller.signal)
    try {
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      await vi.advanceTimersByTimeAsync(100)
      expect(seen.filter((event) => event.type === "reasoning/chunk")).toHaveLength(1)
    } finally {
      release()
      await expect(run).rejects.toThrow("agent aborted")
    }
    expect(session.events.filter((event) => event.type === "reasoning")).toEqual([
      expect.objectContaining({ text: "received prefix" }),
    ])
  })

  it("does not split a provider reasoning block around a usage report", async () => {
    const { agent, session } = setup({ async *stream() {
      yield { type: "reasoning", blockId: "0", text: "Inspect " }
      yield { type: "usage", usage: { outputTokens: 2 } }
      yield { type: "reasoning", blockId: "0", text: "files" }
      yield { type: "text/chunk", text: "done" }
      yield { type: "end" }
    } })
    await agent.run("task")
    expect(session.events.filter((event) => event.type === "reasoning")).toEqual([
      expect.objectContaining({ text: "Inspect files", blockId: "0" }),
    ])
  })
})
