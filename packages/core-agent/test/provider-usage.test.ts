import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import type { Telemetry, TelemetryEvent } from "@i-harness/telemetry"
import type { ModelClient } from "@i-harness/llm-seam"
import { createAgent } from "../src/index.ts"

// M5 / T2, half one: "以 provider 回報為事實".
//
// The roadmap's completion definition asks that cache continuity be observable
// "從 provider 回報與自己的前綴比對兩方面". This file is the first half — the
// point where what the model SAID becomes something the host can SEE.
//
// Measured before writing any of it: the seam's union had five members and none
// of them carried usage, while three adapters already documented the hole in
// their own comments (llm-gemini:237-241 calls it "a future usage seam slot").
// So the contract is not invented here; it is the slot they named.
//
// THE FAILURE THIS FILE EXISTS TO CATCH. core-agent's stream loop is a
// `switch (ev.type)` with no default and no exhaustiveness assert. A new union
// member is therefore SILENTLY IGNORED — not a type error, not a runtime error.
// It looks exactly like success: the run is fine, the numbers are simply never
// there. Asserting on telemetry (not on the switch) is the only thing that can
// tell those two apart.

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

/**
 * The seam variant this file drives does not exist yet — that absence IS the
 * RED. It is typed locally and cast so the failure is a BEHAVIOUR failure
 * (core-agent ignores the event) rather than a compile error, which would prove
 * nothing about the runtime.
 */
type UsageEvent = {
  type: "usage"
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number }
}
type WireEvent = UsageEvent | { type: "text/chunk"; text: string } | { type: "end" }

const client = (events: WireEvent[]): ModelClient =>
  ({
    async *stream() {
      for (const ev of events) yield ev
    },
  }) as unknown as ModelClient

async function runWith(events: WireEvent[]): Promise<TelemetryEvent[]> {
  const ctx = createContext()
  const { telemetry, events: emitted } = spyTelemetry()
  const agent = createAgent(ctx, {
    session: createSession(),
    tools: createToolRegistry(ctx),
    model: client(events),
    systemPrompt: "p",
    telemetry,
  })
  await agent.run("hello")
  return emitted
}

const usageEvents = (emitted: TelemetryEvent[]): TelemetryEvent[] =>
  emitted.filter((e) => e.type === "provider/usage")

describe("core-agent provider usage (M5 T2)", () => {
  it("turns a reported usage into exactly ONE provider/usage, carrying only what was reported", async () => {
    const emitted = await runWith([
      { type: "usage", usage: { inputTokens: 12, cacheReadTokens: 400, cacheCreationTokens: 0 } },
      { type: "text/chunk", text: "hi" },
      { type: "end" },
    ])
    const reports = usageEvents(emitted)
    expect(reports).toHaveLength(1)
    // `toEqual` is deliberate: it fails on EXTRA keys too. A `step` field would
    // be summed by the metrics sink as if it were a token count, and those
    // fields are summed precisely because they are all measurements.
    expect(reports[0]!.data).toEqual({ inputTokens: 12, cacheReadTokens: 400, cacheCreationTokens: 0 })
  })

  it("merges two reports in one request into ONE event — the count is the denominator", async () => {
    // Anthropic's shape: input-side usage arrives on message_start, output-side
    // on message_delta. Two wire reports, one round-trip. If they were emitted
    // separately, the metrics sink would count two reported requests where there
    // was one, and every rate derived from it would be wrong.
    const emitted = await runWith([
      { type: "usage", usage: { inputTokens: 12, cacheReadTokens: 400 } },
      { type: "text/chunk", text: "hi" },
      { type: "usage", usage: { outputTokens: 7 } },
      { type: "end" },
    ])
    const reports = usageEvents(emitted)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.data).toEqual({ inputTokens: 12, cacheReadTokens: 400, outputTokens: 7 })
  })

  it("a provider that reports nothing emits NO provider/usage at all", async () => {
    // Not "emits a zero". The denominator has to stay honest: a run whose
    // provider never reported must be distinguishable from a run that reported
    // zero cache reads, or `cacheReadTokens: 0` means nothing.
    const emitted = await runWith([{ type: "text/chunk", text: "hi" }, { type: "end" }])
    expect(usageEvents(emitted)).toHaveLength(0)
  })

  it("an unreported field is ABSENT, never fabricated as 0", async () => {
    // The provider said nothing about the cache. "0" would be our invention,
    // and it would read as a measurement.
    const emitted = await runWith([
      { type: "usage", usage: { inputTokens: 5 } },
      { type: "end" },
    ])
    const reports = usageEvents(emitted)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.data).toEqual({ inputTokens: 5 })
    expect("cacheReadTokens" in reports[0]!.data).toBe(false)
  })
})
