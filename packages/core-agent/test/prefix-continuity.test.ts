import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createMetricsSink } from "@i-harness/telemetry"
import type { Telemetry, TelemetryEvent } from "@i-harness/telemetry"
import { createAgent } from "../src/index.ts"

// M5 / T2, half two: "以自己的位元組為偵測".
//
// The roadmap's completion definition asks that cache continuity be observable
// "從 provider 回報與自己的前綴比對兩方面". `provider-usage.test.ts` is the first
// half — what the wire SAID. This file is the second: OUR OWN bytes, compared
// against the previous request's.
//
// THE SHAPE THIS FILE EXISTS TO PIN, and it is the same honesty rule the first
// half is built on: a request that had nothing to compare against reports
// NEITHER field. `prefixKept: 0` is a MEASUREMENT ("nothing survived"), so a
// session resumed with no predecessor in this process must not produce one — it
// would read as a regression that never happened. Absent is not zero.
//
// The second shape: the comparison state lives in the agent closure
// (`createAgent`'s scope, beside `steps`/`callSeq`), NOT inside `runTurn`. A
// followup continues the same conversation, so its first request is compared
// against the previous turn's LAST request — the same reason `steps` survives
// across turns. `runTurn`-local state would silently restart the comparison
// every turn, which the "followup" case below catches.

/** The existing spy, plus the real sink: the comparison must be visible BOTH as
 * an event field and as the number the `[metrics]` line is built from. Nothing
 * new is faked here — `createMetricsSink` is the shipped accumulator. */
function harness() {
  const events: TelemetryEvent[] = []
  const sink = createMetricsSink()
  const telemetry: Telemetry = {
    emit: (ev) => {
      events.push(ev)
      sink.onEvent(ev)
    },
    close: () => {},
  }
  return { telemetry, events, sink }
}

const noop: Tool = { name: "noop", description: "does nothing", inputSchema: {}, execute: async () => ({ ok: true }) }

describe("core-agent prefix continuity (M5 T2, second half)", () => {
  it("a pure append is not a break — every later request extends the previous one", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    tools.register(noop)
    const { telemetry, events, sink } = harness()
    const agent = createAgent(ctx, {
      session: createSession(),
      tools,
      model: createMockClient([
        { role: "assistant", toolCalls: [{ name: "noop", args: {} }] },
        { role: "assistant", toolCalls: [{ name: "noop", args: {} }] },
        { role: "assistant", text: "done" },
      ]),
      systemPrompt: "p",
      telemetry,
    })
    await agent.run("go")

    const calls = events.filter((e) => e.type === "provider/call")
    expect(calls).toHaveLength(3)
    // The process's first request has nothing to compare against: it claims
    // nothing at all — not `shared: 0`, which would read as a full break.
    expect("prefixKept" in calls[0]!.data).toBe(false)
    expect("prefixBroke" in calls[0]!.data).toBe(false)
    // Every later request extends the earlier one byte for byte, so `prefixKept`
    // IS the previous request's message count: every one of those messages is
    // still the identical head of this request.
    expect(calls[1]!.data).toMatchObject({ prefixKept: calls[0]!.data.messages, prefixBroke: false })
    expect(calls[2]!.data).toMatchObject({ prefixKept: calls[1]!.data.messages, prefixBroke: false })
    // The tail really did grow — otherwise "kept" would be the vacuous truth of
    // a request that was never re-sent.
    expect(calls[2]!.data.messages as number).toBeGreaterThan(calls[1]!.data.messages as number)
    // The accumulator behind `[metrics]`: 2 of the 3 requests could be compared,
    // and neither was a break.
    expect(sink.snapshot().prefix).toEqual({ requests: 3, rewritten: 0, observed: 2, kept: 2, broke: 0 })
  })

  it("a compaction rewrites the head of the projection — the next request says it broke", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    let compacted = false
    tools.register({
      name: "compact-now",
      description: "rewrites the model-visible projection, the way a compaction does",
      inputSchema: {},
      execute: async () => {
        if (!compacted) {
          compacted = true
          // Stands in for the compactor: the real engine shadows a PREFIX of the
          // log (`compaction/src/region.ts` walks it front-first) and appends
          // exactly this marker — so the summary becomes message 0 and no
          // leading message survives.
          append(session, {
            type: "compaction/summary",
            text: "summary of earlier work",
            shadowedSeqs: session.events.flatMap((ev) => (ev.seq === undefined ? [] : [ev.seq])),
          })
        }
        return { ok: true }
      },
    })
    const { telemetry, events, sink } = harness()
    const agent = createAgent(ctx, {
      session,
      tools,
      model: createMockClient([
        { role: "assistant", toolCalls: [{ name: "compact-now", args: {} }] },
        { role: "assistant", text: "done" },
      ]),
      systemPrompt: "p",
      telemetry,
    })
    await agent.run("go")

    const calls = events.filter((e) => e.type === "provider/call")
    expect(calls).toHaveLength(2)
    // Nothing of the previous request survived the rewrite — the summary took
    // its head — and that IS a measurement, so both fields are here.
    expect(calls[1]!.data).toMatchObject({ prefixKept: 0, prefixBroke: true })
    // D3's derived half and this measured half agree on the same pair of
    // requests: the marker landed between them.
    expect(calls[1]!.data).toMatchObject({ prefixRewritten: true })
    expect(sink.snapshot().prefix).toEqual({ requests: 2, rewritten: 1, observed: 1, kept: 0, broke: 1, lastCause: "compaction/summary" })
  })

  it("a fresh process over an existing session claims nothing on its first request", async () => {
    // `--resume`: the log carries the whole conversation, but THIS process has
    // sent nothing yet, so there is no previous request to compare against.
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    tools.register(noop)
    const first = harness()
    await createAgent(ctx, {
      session,
      tools,
      model: createMockClient([
        { role: "assistant", toolCalls: [{ name: "noop", args: {} }] },
        { role: "assistant", text: "first" },
      ]),
      systemPrompt: "p",
      telemetry: first.telemetry,
    }).run("go")

    const second = harness()
    await createAgent(ctx, {
      session,
      tools,
      model: createMockClient([{ role: "assistant", text: "second" }]),
      systemPrompt: "p",
      telemetry: second.telemetry,
    }).run("again")

    const calls = second.events.filter((e) => e.type === "provider/call")
    expect(calls).toHaveLength(1)
    // The log really did carry history — otherwise "nothing to compare" would be
    // vacuous and this case would pass with the whole comparison deleted.
    expect(calls[0]!.data.messages as number).toBeGreaterThan(1)
    expect("prefixKept" in calls[0]!.data).toBe(false)
    expect("prefixBroke" in calls[0]!.data).toBe(false)
    // And the accumulator says "nothing was observed", not "0 of N kept".
    expect(second.sink.snapshot().prefix).toEqual({ requests: 1, rewritten: 0, observed: 0, kept: 0, broke: 0 })
  })

  it("a followup is compared against the previous turn's last request", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const { telemetry, events } = harness()
    const agent = createAgent(ctx, {
      session: createSession(),
      tools,
      model: createMockClient([
        { role: "assistant", text: "first" },
        { role: "assistant", text: "second" },
      ]),
      systemPrompt: "p",
      telemetry,
    })
    await agent.run("one")
    await agent.followup("two")

    const calls = events.filter((e) => e.type === "provider/call")
    expect(calls).toHaveLength(2)
    // If the comparison state lived inside `runTurn`, this request would claim
    // nothing — the same shape as a process restart, which is exactly the
    // confusion the closure's placement prevents.
    expect(calls[1]!.data).toMatchObject({ prefixKept: calls[0]!.data.messages, prefixBroke: false })
  })
})
