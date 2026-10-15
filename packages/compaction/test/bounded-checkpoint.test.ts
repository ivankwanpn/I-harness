import { afterEach, describe, expect, it, vi } from "vitest"
import { append, createSession, deriveMessages } from "@i-harness/core-session"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { createOpenAIClient } from "../../llm-openai/src/index.ts"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"
import { createCompactionEngine, activeTokens } from "../src/index.ts"
import { planPrune, surfaceTokensAfterPrune } from "../src/engine/prune.ts"

const checkpoint = "## Objective\n- " + "completed result; preserve instructions. ".repeat(20)
function session(turns = 1) {
  const s = createSession()
  for (let i = 0; i < turns; i++) append(s, { type: "user/message", text: `segment ${i} ` + "word ".repeat(60) })
  return s
}
function capture(text = checkpoint) {
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) { requests.push(request); yield { type: "text/chunk", text }; yield { type: "end" } } }
  return { model, requests }
}
afterEach(() => vi.unstubAllGlobals())

describe("bounded durable checkpoints", () => {
  it("uses an independent summary ceiling for a distinct binding with unknown limits", async () => {
    const main = capture(), summary = capture()
    const engine = createCompactionEngine({ model: main.model, maxOutputTokens: 384000, config: { contextWindow: 500000, summarizationModel: summary.model } })
    expect((await engine.compact(session())).compacted).toBe(true)
    expect(summary.requests[0]!.maxOutputTokens).toBe(4096)
    expect(main.requests).toHaveLength(0)
  })

  it("admits actual Responses fixed policy/directive and honors its floor before transport", async () => {
    let calls = 0
    vi.stubGlobal("fetch", async () => { calls++; return new Response("") })
    const summary = createOpenAIClient({ apiKey: "controlled", model: "fixture", options: { instructions: "fixed ".repeat(3000) } })
    const engine = createCompactionEngine({ model: capture().model, config: { contextWindow: 500000, summarizationModel: summary, summaryMaxOutputTokens: 16, summaryLimits: { contextWindow: 1000 } } })
    const result = await engine.compact(session())
    expect(result.compacted).toBe(false)
    expect(result.blockedReason).toContain("fixed summary input cannot fit")
    expect(calls).toBe(0)
  })

  it("blocks a raw Claude thinking floor conflict without changing effort", async () => {
    let calls = 0
    vi.stubGlobal("fetch", async () => { calls++; return new Response("") })
    const model = createAnthropicClient({ apiKey: "controlled", model: "claude-3-7-sonnet", options: { thinking: { type: "enabled", budget_tokens: 8192 } } })
    expect((await createCompactionEngine({ model, config: { contextWindow: 100000, summaryMaxOutputTokens: 4096 } }).compact(session())).compacted).toBe(false)
    expect(calls).toBe(0)
  })

  it("flushes before manual summary transport and propagates persistence refusal", async () => {
    const captured = capture(), failure = new Error("checkpoint refused")
    const engine = createCompactionEngine({ model: captured.model, config: { contextWindow: 10000 }, flush: async () => { throw failure } })
    await expect(engine.compact(session())).rejects.toBe(failure)
    expect(captured.requests).toHaveLength(0)
  })

  it("passes Stop to held transport and prevents replacement after cancellation", async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController()
    let received: AbortSignal | undefined
    const model: ModelClient = { async *stream(request): AsyncIterable<LLMStreamEvent> {
      received = request.signal; entered.resolve(); await release.promise
      yield { type: "text/chunk", text: checkpoint }; yield { type: "end" }
    } }
    const s = session(), engine = createCompactionEngine({ model, config: { contextWindow: 10000 } })
    const pending = engine.compact(s, undefined, { signal: controller.signal })
    await entered.promise
    controller.abort(new Error("held Stop")); release.resolve()
    await expect(pending).rejects.toThrow("held Stop")
    expect(received).toBe(controller.signal)
    expect(s.events.some(e => e.type === "compaction/summary")).toBe(false)
  })

  it.each(["refused", "incomplete", "oversize"])("rejects %s output before replacement", async kind => {
    const model: ModelClient = { async *stream() {
      yield { type: "text/chunk", text: kind === "oversize" ? "x".repeat(10000) : checkpoint }
      if (kind !== "incomplete") yield { type: "end", ...(kind === "refused" ? { refused: true } : {}) }
    } }
    const s = session()
    expect((await createCompactionEngine({ model, config: { contextWindow: 20000 } }).compact(s)).compacted).toBe(false)
    expect(s.events.some(e => e.type === "compaction/summary")).toBe(false)
  })

  it("shadows only incorporated active anchors across repeated rounds", async () => {
    const s = session(), captured = capture()
    const engine = createCompactionEngine({ model: captured.model, config: { contextWindow: 20000 } })
    await engine.compact(s)
    const first = s.events.find(e => e.type === "compaction/summary")!
    append(s, { type: "user/message", text: "new completed outcome" })
    await engine.compact(s)
    const summaries = s.events.filter(e => e.type === "compaction/summary")
    expect(summaries).toHaveLength(2)
    expect(summaries[1]!.shadowedSeqs).toContain(first.seq)
    expect(deriveMessages(s).filter(m => m.content === checkpoint.trim())).toHaveLength(1)
  })

  it("adapts the default to raw Claude thinking plus retention on the actual wire", async () => {
    let sent: Record<string, unknown> = {}, budget: Record<string, unknown> = {}
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response([
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: checkpoint } },
        { type: "message_stop" },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))
    })
    const model = createAnthropicClient({ apiKey: "controlled", model: "claude-3-7-sonnet", options: { thinking: { type: "enabled", budget_tokens: 8192 } } })
    const engine = createCompactionEngine({ model, maxOutputTokens: 384000, config: { contextWindow: 500000 }, telemetry: { emit(event) { if (event.type === "provider/context" && event.data.operation === "summary") budget = event.data }, close() {} } })
    expect((await engine.compact(session())).compacted).toBe(true)
    expect(sent.max_tokens).toBe(9216)
    expect(sent.thinking).toEqual({ type: "enabled", budget_tokens: 8192 })
    expect(budget).toMatchObject({ effectiveCap: 9216, outputReserve: 9216, minimumCap: 8193, defaultFloorAdjusted: true })
  })

  it("balances only confirmed overflow and preserves every pending segment", async () => {
    const requests: LLMRequest[] = []
    const model: ModelClient = { async *stream(request) {
      requests.push(request)
      if (requests.length === 1) throw Object.assign(new Error("confirmed full"), { code: "CONTEXT_WINDOW_EXCEEDED" })
      yield { type: "text/chunk", text: checkpoint }; yield { type: "end" }
    } }
    const s = session(8)
    expect((await createCompactionEngine({ model, config: { contextWindow: 100000 } }).recover(s)).compacted).toBe(true)
    expect(requests).toHaveLength(3)
    const pieces = requests.slice(1).map(request => String(request.messages[0]!.content))
    for (let i = 0; i < 8; i++) expect(pieces.filter(piece => piece.includes(`segment ${i} `))).toHaveLength(1)
    expect(pieces.every(piece => piece.length < String(requests[0]!.messages[0]!.content).length)).toBe(true)
  })

  it("keeps tool names/arguments/outcomes and image descriptors when reslicing a distinct text summary", async () => {
    const s = createSession(), requests: LLMRequest[] = []
    for (let i = 0; i < 8; i++) {
      append(s, { type: "user/message", text: `segment ${i} ` + "word ".repeat(60), ...(i === 0 ? { images: [{ mediaType: "image/png" as const, dataBase64: "YWJjZGVm" }] } : {}) })
      append(s, { type: "tool/call", callId: `c${i}`, name: "read_file", args: { path: `FILE-${i}.ts` } })
      append(s, { type: "tool/result", callId: `c${i}`, name: "read_file", output: { outcome: `DONE-${i}` } })
    }
    const model: ModelClient = { async *stream(request) {
      requests.push(request)
      if (requests.length === 1) throw Object.assign(new Error("full"), { code: "CONTEXT_WINDOW_EXCEEDED" })
      yield { type: "text/chunk", text: checkpoint }; yield { type: "end" }
    } }
    expect((await createCompactionEngine({ model: capture().model, config: { contextWindow: 100000, summarizationModel: model } }).compact(s)).compacted).toBe(true)
    const pieces = requests.slice(1).map(request => String(request.messages[0]!.content))
    for (let i = 0; i < 8; i++) {
      expect(pieces.filter(piece => piece.includes(`FILE-${i}.ts`))).toHaveLength(1)
      expect(pieces.filter(piece => piece.includes(`DONE-${i}`))).toHaveLength(1)
    }
    expect(pieces.some(piece => piece.includes("read_file"))).toBe(true)
    expect(pieces.some(piece => piece.includes("[image:"))).toBe(true)
    expect(pieces.every(piece => !piece.includes("YWJjZGVm"))).toBe(true)
    expect(s.events.filter(event => event.type === "tool/result")).toHaveLength(8)
  })

  it("does not incorporate an active anchor outside a protected prefix cut", async () => {
    const s = session(), captured = capture()
    append(s, { type: "user/message", text: "protected current authority" })
    append(s, { type: "compaction/summary", text: "later checkpoint retained outside cut", shadowedSeqs: [] })
    const result = await createCompactionEngine({ model: captured.model, config: { contextWindow: 10000 } }).recover(s, { protectedSeqs: [1] })
    expect(result.shadowedSeqs).toEqual([0])
    expect(String(captured.requests[0]!.messages[0]!.content)).not.toContain("later checkpoint retained outside cut")
    expect(deriveMessages(s).some(message => message.content === "later checkpoint retained outside cut")).toBe(true)
  })

  it("shares call bounds between overflow pieces and quality retry", async () => {
    let calls = 0
    const model: ModelClient = { async *stream() {
      calls++
      if (calls === 1) throw Object.assign(new Error("confirmed full"), { code: "CONTEXT_WINDOW_EXCEEDED" })
      yield { type: "text/chunk", text: calls === 2 ? "short" : checkpoint }; yield { type: "end" }
    } }
    const s = session(8)
    const result = await createCompactionEngine({ model, config: { contextWindow: 100000 } }).recover(s, { maxSummaryCalls: 3 })
    expect(result.compacted).toBe(false)
    expect(calls).toBe(3)
    expect(s.events.some(event => event.type === "compaction/summary")).toBe(false)
  })

  it("does not reslice untyped failures or retry an indivisible confirmed overflow", async () => {
    for (const error of [new Error("context window exceeded"), Object.assign(new Error("full"), { code: "CONTEXT_WINDOW_EXCEEDED" })]) {
      let calls = 0
      const model: ModelClient = { async *stream(): AsyncIterable<LLMStreamEvent> { calls++; throw error } }
      const result = await createCompactionEngine({ model, config: { contextWindow: 100000 } }).recover(session())
      expect(result.compacted).toBe(false)
      expect(calls).toBe(1)
    }
  })

  it("never reslices a plain error string on a divisible history", async () => {
    let calls = 0
    const model: ModelClient = { async *stream(): AsyncIterable<LLMStreamEvent> { calls++; throw new Error("context window exceeded") } }
    expect((await createCompactionEngine({ model, config: { contextWindow: 100000 } }).recover(session(8))).compacted).toBe(false)
    expect(calls).toBe(1)
  })

  it("reserves the full preferred output when a subscription cannot apply a cap", async () => {
    let auth = 0, transports = 0
    vi.stubGlobal("fetch", async () => { transports++; return new Response("") })
    const model = createOpenAIClient({ apiKey: "", model: "fixture", codexSubscription: true, resolveCodexAuth: async () => { auth++; return { accessToken: "controlled", accountId: "fixture" } } })
    expect((await createCompactionEngine({ model, config: { contextWindow: 1500 } }).compact(session())).compacted).toBe(false)
    expect(auth).toBe(0)
    expect(transports).toBe(0)
  })

  it("does not globally discard earlier legacy summaries that were not incorporated", async () => {
    const s = createSession()
    append(s, { type: "compaction/summary", text: "legacy checkpoint A", shadowedSeqs: [] })
    append(s, { type: "compaction/summary", text: "active anchor B", shadowedSeqs: [] })
    append(s, { type: "user/message", text: "new result" })
    expect((await createCompactionEngine({ model: capture().model, config: { contextWindow: 10000 } }).compact(s)).shadowedSeqs).toEqual([1, 2])
    expect(deriveMessages(s).map(message => message.content)).toEqual(["legacy checkpoint A", checkpoint.trim()])
  })

  it("protects the current task and paired results during forced recovery", async () => {
    const s = session()
    append(s, { type: "tool/call", callId: "protected", name: "read", args: {} })
    append(s, { type: "tool/result", callId: "protected", name: "read", output: { value: "outcome" } })
    append(s, { type: "user/message", text: "current task authority" })
    const result = await createCompactionEngine({ model: capture().model, config: { contextWindow: 10000 } }).recover(s, { protectedSeqs: [2, 3] })
    expect(result.shadowedSeqs).toEqual([0])
    const projected = deriveMessages(s)
    expect(projected.some(message => message.role === "assistant" && message.toolCalls?.[0]?.id === "protected")).toBe(true)
    expect(projected.some(message => message.role === "tool" && message.toolCallId === "protected")).toBe(true)
    expect(projected.some(message => message.content === "current task authority")).toBe(true)
    expect(s.events.some(event => event.type === "compaction/reset")).toBe(false)
  })

  it("protects the full paired result when the protected seq names its call", async () => {
    const s = session(), output = "outcome ".repeat(3000)
    append(s, { type: "tool/call", callId: "protected", name: "read", args: {} })
    append(s, { type: "tool/result", callId: "protected", name: "read", output })
    const result = await createCompactionEngine({ model: capture().model, config: { contextWindow: 100000 } }).recover(s, { protectedSeqs: [1] })
    expect(result.compacted).toBe(true)
    expect(deriveMessages(s).find(message => message.role === "tool")?.content).toContain(output)
    expect(s.events.some(event => event.type === "compaction/prune")).toBe(false)
  })

  it("bounds always-overflowing divisible input to two shrink retries", async () => {
    let calls = 0
    const model: ModelClient = { async *stream(): AsyncIterable<LLMStreamEvent> { calls++; throw Object.assign(new Error("full"), { code: "CONTEXT_WINDOW_EXCEEDED" }) } }
    expect((await createCompactionEngine({ model, config: { contextWindow: 100000 } }).recover(session(32))).compacted).toBe(false)
    expect(calls).toBe(3)
  })

  it("stops at eight shared calls by default when pieces also need quality retries", async () => {
    let calls = 0
    const model: ModelClient = { async *stream(request) {
      calls++
      const segments = String(request.messages[0]!.content).match(/segment \d+ /g)?.length ?? 0
      if (segments > 4) throw Object.assign(new Error("full"), { code: "CONTEXT_WINDOW_EXCEEDED" })
      yield { type: "text/chunk", text: calls === 3 || calls === 5 ? "short" : checkpoint }; yield { type: "end" }
    } }
    const s = session(16), result = await createCompactionEngine({ model, config: { contextWindow: 100000 } }).recover(s)
    expect(result).toMatchObject({ compacted: false, blockedReason: "compaction: shared summary call limit exhausted (8)" })
    expect(calls).toBe(8)
    expect(s.events.some(event => event.type === "compaction/summary")).toBe(false)
  })

  it("prunes the active substituted projection once and safely ignores undefined output", () => {
    const s = createSession(), output = { content: "a".repeat(20000) }
    append(s, { type: "tool/call", callId: "c", name: "read", args: {} })
    append(s, { type: "tool/result", callId: "c", name: "read", output })
    append(s, { type: "tool/result", callId: "absent", name: "read", output: undefined })
    const prune = { enabled: true, thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
    const plan = planPrune(s, prune), candidate = surfaceTokensAfterPrune(s, plan)
    append(s, { type: "compaction/prune", version: 1, pruned: plan })
    expect(candidate).toBe(activeTokens(s))
    expect(planPrune(s, prune)).toEqual([])
    expect(s.events.find(e => e.type === "tool/result" && e.callId === "c")).toMatchObject({ output })
  })
})
