import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import type { Telemetry, TelemetryEvent } from "@i-harness/telemetry"
import { createAgent } from "../src/index.ts"

// M5 / D3, consumer side. The derivation lives in core-session; this is where it
// becomes a fact the host can see, sitting next to T2-1's provider numbers so
// that CAUSE and COST are read together.
//
// THE FAILURE THIS PINS, and it is the whole reason the derivation counts
// markers instead of returning a boolean: once a session has been compacted,
// "has this projection been rewritten?" is permanently true. A boolean would
// report a cache break on EVERY later request, which is worse than saying
// nothing — it is a false alarm that never stops.

function spyTelemetry(): { telemetry: Telemetry; events: TelemetryEvent[] } {
  const events: TelemetryEvent[] = []
  return { telemetry: { emit: (ev) => { events.push(ev) }, close: () => {} }, events }
}

describe("core-agent projection rewrite (M5 D3)", () => {
  it("reports a rewrite ONCE, on the next request, with its cause — never as a standing alarm", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    let rewritten = false
    // Stands in for the compactor: the real one appends exactly this marker.
    const compactor: Tool = {
      name: "step-tool",
      description: "does nothing, except once rewrites the projection",
      inputSchema: {},
      execute: async () => {
        if (!rewritten) {
          rewritten = true
          append(session, { type: "compaction/summary", text: "summary of earlier work", shadowedSeqs: [1, 2] })
        }
        return { ok: true }
      },
    }
    tools.register(compactor)
    const { telemetry, events } = spyTelemetry()
    const agent = createAgent(ctx, {
      session,
      tools,
      model: createMockClient([
        { role: "assistant", toolCalls: [{ name: "step-tool", args: {} }] },
        { role: "assistant", toolCalls: [{ name: "step-tool", args: {} }] },
        { role: "assistant", text: "done" },
      ]),
      systemPrompt: "p",
      telemetry,
    })
    await agent.run("go")

    const calls = events.filter((e) => e.type === "provider/call")
    expect(calls).toHaveLength(3)
    // 1. Before anything was rewritten: no claim at all.
    expect("prefixRewritten" in calls[0]!.data).toBe(false)
    // 2. The rewrite lands between step 1 and step 2 → the next request says so,
    //    and says WHO did it.
    expect(calls[1]!.data).toMatchObject({ prefixRewritten: true, prefixCause: "compaction/summary" })
    // 3. The steady state is NOT a break. This is the assertion that a boolean
    //    would fail, and it is the reason the derivation counts markers.
    expect("prefixRewritten" in calls[2]!.data).toBe(false)
  })

  it("a session nobody rewrote never claims one", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    tools.register({ name: "noop", description: "d", inputSchema: {}, execute: async () => ({ ok: true }) })
    const { telemetry, events } = spyTelemetry()
    const agent = createAgent(ctx, {
      session: createSession(),
      tools,
      model: createMockClient([
        { role: "assistant", toolCalls: [{ name: "noop", args: {} }] },
        { role: "assistant", text: "done" },
      ]),
      systemPrompt: "p",
      telemetry,
    })
    await agent.run("go")
    const calls = events.filter((e) => e.type === "provider/call")
    expect(calls).toHaveLength(2)
    expect(calls.some((c) => "prefixRewritten" in c.data)).toBe(false)
  })
})
