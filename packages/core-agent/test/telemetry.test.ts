import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import type { Telemetry, TelemetryEvent } from "@i-harness/telemetry"
import type { ModelClient } from "@i-harness/llm-seam"
import { createAgent } from "../src/index.ts"

// M25: telemetry is an independent HOST event stream (separate from the session
// log; agent-invisible). AgentDeps.telemetry is OPTIONAL — absent = no events
// (backward compat). A spy sink records every emitted event for assertion.
function spyTelemetry(): { telemetry: Telemetry; events: TelemetryEvent[] } {
  const events: TelemetryEvent[] = []
  const telemetry: Telemetry = {
    emit: (ev) => {
      events.push(ev)
    },
    close: () => {},
  }
  return { telemetry, events }
}

function makeTools(ctx: ReturnType<typeof createContext>): Tool[] {
  const readTool: Tool = {
    name: "read",
    description: "read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    execute: async ({ path }: { path: string }) => ({ content: `content-of-${path}` }),
  }
  const tools = createToolRegistry(ctx)
  tools.register(readTool)
  return [readTool]
}

describe("core-agent telemetry emit (M25)", () => {
  it("emits turn/provider/tool/token events around the loop", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    for (const t of makeTools(ctx)) tools.register(t)
    const { telemetry, events } = spyTelemetry()
    const agent = createAgent(ctx, {
      session,
      tools,
      model: createMockClient([
        { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
        { role: "assistant", text: "Report: done" },
      ]),
      systemPrompt: "p",
      telemetry,
    })
    const result = await agent.run("read a.txt")
    expect(result.finalText).toBe("Report: done")
    // Exact ordering locks the emit points: turn/start at the turn boundary,
    // provider/call around each model.stream, tool/start|end around execution
    // (end beside the tool/result commit), turn/end + token/usage at turn end.
    expect(events.map((e) => e.type)).toEqual([
      "turn/start",
      "provider/call",
      "tool/start",
      "tool/end",
      "provider/call",
      "turn/end",
      "token/usage",
    ])
    expect(events[0]!.data).toMatchObject({ message: "read a.txt" })
    expect(events[2]!.data).toMatchObject({ tool: "read", callId: "call_1" })
    expect(events[3]!.data).toMatchObject({ tool: "read", callId: "call_1" })
    expect((events[6]!.data as { tokens: number }).tokens).toBeGreaterThan(0)
    // telemetry is host-side: the session log carries NO telemetry events.
    expect(session.events.some((e) => e.type === "turn/start" && "message" in e)).toBe(false)
  })

  it("emits tool/error when a tool body fails", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    tools.register({
      name: "read",
      description: "read a file",
      inputSchema: {},
      execute: async () => {
        throw new Error("disk exploded")
      },
    })
    const { telemetry, events } = spyTelemetry()
    const agent = createAgent(ctx, {
      session,
      tools,
      model: createMockClient([
        { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
      ]),
      systemPrompt: "p",
      telemetry,
    })
    await expect(agent.run("read a.txt")).rejects.toThrow(/disk exploded/)
    const types = events.map((e) => e.type)
    expect(types).toContain("tool/start")
    expect(types).toContain("tool/error")
    const err = events.find((e) => e.type === "tool/error")!
    expect(err.data).toMatchObject({ tool: "read", error: "disk exploded" })
    // a failed tool never commits → no tool/end for it
    expect(types).not.toContain("tool/end")
  })

  it("emits provider/error when the model stream errors", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    for (const t of makeTools(ctx)) tools.register(t)
    const { telemetry, events } = spyTelemetry()
    const agent = createAgent(ctx, {
      session,
      tools,
      model: {
        // eslint-disable-next-line require-yield
        async *stream() {
          yield { type: "error" as const, error: new Error("boom") }
        },
      } as unknown as ModelClient,
      systemPrompt: "p",
      telemetry,
    })
    await expect(agent.run("read a.txt")).rejects.toThrow(/model stream error: boom/)
    expect(events.map((e) => e.type)).toEqual(["turn/start", "provider/call", "provider/error"])
    expect(events[2]!.data).toMatchObject({ error: "boom" })
  })

  it("absent telemetry → no events, behavior unchanged (backward compat)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    for (const t of makeTools(ctx)) tools.register(t)
    const agent = createAgent(ctx, {
      session,
      tools,
      model: createMockClient([{ role: "assistant", text: "all done" }]),
      systemPrompt: "p",
      // no telemetry field at all
    })
    const result = await agent.run("nothing")
    expect(result.finalText).toBe("all done")
    expect(result.turns).toBe(1)
  })
})
