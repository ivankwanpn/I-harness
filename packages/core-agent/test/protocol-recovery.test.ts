import { checkpointOfLength } from '../../compaction/test/fixtures/checkpoint.ts'
import { afterEach, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, deriveContextRecovery, deriveMessages, fromJSONL, toJSONL } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { wrapPreparedRequest, type ModelClient, type LLMMessage, type PreparedRequestMeasurement } from "@i-harness/llm-seam"
import { summarizeFixture } from '../../compaction/test/fixtures/summary.ts'
import { createOpenAICompatibleClient } from "../../llm-openai-compatible/src/index.ts"
import { createOpenAIClient } from "../../llm-openai/src/index.ts"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"
import { createGeminiClient } from "../../llm-gemini/src/index.ts"
import { createBedrockClient, type BedrockRuntimeFace } from "../../llm-bedrock/src/index.ts"
import { systemFetch } from "../../http-transport/src/index.ts"
import { createAgentWithSummary } from './fixtures/agent.ts'
vi.mock("../../http-transport/src/index.ts", () => ({ systemFetch: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())
const variants = ["chat", "responses", "subscription", "anthropic", "gemini", "bedrock"] as const
type Variant = typeof variants[number]
const checkpoint = checkpointOfLength(600)
function frames(variant: Variant, text: string, tool = false): object[] {
  if (variant === "chat") return [{ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: "effect-1", type: "function", function: { name: "effect", arguments: "{}" } }] } : { content: text }, finish_reason: tool ? "tool_calls" : "stop" }] }]
  if (variant === "responses" || variant === "subscription") return tool ? [
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc", call_id: "effect-1", name: "effect", arguments: "{}" } }, { type: "response.completed", response: { status: "completed" } },
  ] : [{ type: "response.output_text.delta", delta: text }, { type: "response.completed", response: { status: "completed" } }]
  if (variant === "anthropic") return tool ? [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "effect-1", name: "effect", input: {} } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" },
  ] : [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, { type: "message_stop" }]
  if (variant === "gemini") return [{ candidates: [{ content: { role: "model", parts: tool ? [{ functionCall: { id: "effect-1", name: "effect", args: {} } }] : [{ text }] }, finishReason: "STOP" }] }]
  return tool ? [{ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "effect-1", name: "effect" } } } }, { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "{}" } } } }, { contentBlockStop: { contentBlockIndex: 0 } }, { messageStop: { stopReason: "tool_use" } }]
    : [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text } } }, { contentBlockStop: { contentBlockIndex: 0 } }, { messageStop: { stopReason: "end_turn" } }]
}
function setup(variant: Variant, mode: "success" | "repeat" | "stop" | "storage") {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let effects = 0, stage: "seed" | "reject" | "accepted" | "schema" = "seed", seedCalls = 0
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const wire: { summary: boolean; body: any }[] = [], measured: { summary: boolean; facts: PreparedRequestMeasurement }[] = []
  tools.register({ name: "effect", description: "controlled authorized effect", inputSchema: { type: "object" }, execute: async () => { effects++; return "completed outcome ".repeat(400) } })
  async function dispatch(body: any) {
    const summary = JSON.stringify(body).includes("You are now acting as a compaction engine")
    wire.push({ summary, body })
    if (summary && mode === "stop") { held.resolve(); await release.promise }
    if (!summary && stage !== "seed" && (stage === "reject" || stage === "schema" || mode === "repeat")) {
      const schema = stage === "schema"; stage = "accepted"
      if (variant === "bedrock") throw Object.assign(new Error(schema ? "Invalid tool schema" : "Input is too long for requested model"), { name: "ValidationException", $metadata: { httpStatusCode: 400 } })
      return new Response(JSON.stringify({ error: { code: schema ? "invalid_schema" : "context_length_exceeded", type: "invalid_request_error", message: schema ? "Invalid tool schema" : "Input is too long for requested model" } }), { status: 400 })
    }
    const output = frames(variant, summary ? checkpoint : "accepted", !summary && stage === "seed" && seedCalls++ === 0)
    return variant === "bedrock" ? { stream: (async function*() { yield* output })() }
      : new Response(output.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + (variant === "chat" ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } })
  }
  const fetcher = async (_url: unknown, init: RequestInit) => dispatch(JSON.parse(String(init.body))) as Promise<Response>
  vi.stubGlobal("fetch", fetcher); vi.mocked(systemFetch).mockImplementation(fetcher as typeof systemFetch)
  const config = { model: "fixture", apiKey: "controlled", providerId: "fixture" }
  const actual = variant === "chat" ? createOpenAICompatibleClient(config)
    : variant === "responses" || variant === "subscription" ? createOpenAIClient({ ...config, ...(variant === "subscription" ? { codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: "controlled", accountId: "synthetic" }) } : {}) })
      : variant === "anthropic" ? createAnthropicClient(config) : variant === "gemini" ? createGeminiClient(config)
        : createBedrockClient(config, { send: (command: { input: any }) => dispatch(command.input), destroy() {} } as unknown as BedrockRuntimeFace)
  const model: ModelClient = { stream: request => actual.stream(request), async prepare(request) {
    const candidate = await actual.prepare!(request), summary = JSON.stringify(request.messages.at(-1)).includes("You are now acting as a compaction engine")
    return wrapPreparedRequest(candidate, (stream, control) => (async function*() {
      yield* stream({ ...control, validateBeforeTransport() { control?.validateBeforeTransport?.(); measured.push({ summary, facts: candidate.measurement }) } })
    })())
  } }
  const deps = { session, sessionId: "owner", tools, model, systemPrompt: "Preserve the current task and authorized scope", maxOutputTokens: 20000, budget: { contextWindow: 200000 },
    compact: { contextWindow: 200000, auto: false, retainTokens: 100, prune: false as const },
    flush: async () => { if (mode === "storage" && deriveContextRecovery(session, "owner")?.state === "required") throw new Error("controlled storage failure") } }
  return { ctx, deps, session, tools, wire, measured, held, release, setStage(value: typeof stage) { stage = value }, get effects() { return effects } }
}
it.each(variants.flatMap(variant => (["success", "repeat", "stop", "storage"] as const).map(mode => [variant, mode] as const)))("%s actual pipeline preserves recovery/authority/effects in %s", async (variant, mode) => {
  const f = setup(variant, mode), agent = createAgentWithSummary(f.ctx, f.deps)
  await agent.run("Original task and authorization. ".repeat(800))
  expect(f.effects).toBe(1)
  const original = f.session.events.find(e => e.type === "tool/result")
  f.setStage("reject")
  const abort = new AbortController(), pending = agent.followup("continue", abort.signal)
  void pending.catch(() => {})
  if (mode === "stop") { await f.held.promise; abort.abort(); f.release.resolve() }
  if (mode === "success") expect((await pending).finalText).toBe("accepted")
  else await expect(pending).rejects.toThrow()
  expect(f.effects).toBe(1); expect(f.session.events).toContain(original)
  const recovery = deriveContextRecovery(f.session, "owner")!
  expect(recovery).toBeDefined()
  const main = f.measured.filter(item => !item.summary), summaries = f.measured.filter(item => item.summary)
  expect(main).toHaveLength(mode === "success" || mode === "repeat" ? 4 : 3)
  expect(summaries).toHaveLength(mode === "storage" ? 0 : 1)
  const cost = (facts: PreparedRequestMeasurement) => Object.values(facts.input.components).reduce((sum, c) => sum + c.heuristicTokens, 0)
  if (main.length === 4) {
    expect(main[3]!.facts.input.inputFingerprint).not.toBe(main[2]!.facts.input.inputFingerprint)
    expect(cost(main[3]!.facts)).toBeLessThan(cost(main[2]!.facts))
  }
  for (const item of f.wire.filter(item => item.summary)) {
    const cap = variant === "chat" || variant === "anthropic" ? item.body.max_tokens : variant === "gemini" ? item.body.generationConfig.maxOutputTokens : variant === "bedrock" ? item.body.inferenceConfig.maxTokens : item.body.max_output_tokens
    expect(cap).toBe(variant === "subscription" ? undefined : 4096)
  }
  const restored = fromJSONL(toJSONL(f.session))
  expect(deriveContextRecovery(restored, "owner")?.state).toBe(recovery.state)
  expect(deriveMessages(restored).some(m => m.role === "user" && m.content === "continue")).toBe(true)
  if (mode === "repeat") {
    const count = f.wire.length
    await expect(createAgentWithSummary(f.ctx, { ...f.deps, session: restored }).followup("continue")).rejects.toMatchObject({ recoveryBlocked: true })
    expect(f.wire).toHaveLength(count)
    expect(recovery).toMatchObject({ state: "blocked", retryConsumed: true })
  }
  if (mode === "success") {
    expect(recovery.state).toBe("resolved")
    f.setStage("schema")
    const count = f.wire.filter(item => item.summary).length
    await expect(createAgentWithSummary(f.ctx, { ...f.deps, session: restored }).followup("schema check")).rejects.toThrow()
    expect(f.wire.filter(item => item.summary)).toHaveLength(count)
    expect(deriveContextRecovery(restored, "owner")?.state).toBe("resolved")
  }
  if (mode === "stop") expect(f.session.events.some(e => e.type === "compaction/summary")).toBe(false)
})

it.each(variants)("%s prepares legal standalone summary slices for balanced autonomous tool rounds", async variant => {
  const f = setup(variant, "success"), messages: LLMMessage[] = [{ role: "user", content: "Original task and authorized scope" }]
  for (let i = 0; i < 6; i++) messages.push({ role: "assistant", content: "", toolCalls: [{ id: `round-${i}`, name: "effect", args: {} }] }, { role: "tool", toolCallId: `round-${i}`, content: `result-${i}:` + "資料".repeat(1000) })
  const original = JSON.stringify(messages), facts: { inputTokens: number; outputReserve: number }[] = []
  expect((await summarizeFixture(f.deps.model, "Synthetic retained transcript", 1024, undefined, undefined, 500, undefined,
    { systemPrompt: f.deps.systemPrompt, tools: f.tools.schemas(), messages }, { contextWindow: 20000, onMeasurement: value => facts.push(value) })).text).toBe(checkpoint.trim())
  expect(f.wire.length).toBeGreaterThan(1); expect(f.wire.length).toBeLessThanOrEqual(8)
  expect(f.effects).toBe(0); expect(f.session.events).toEqual([])
  expect(JSON.stringify(messages)).toBe(original)
  const replayed: string[] = []
  for (const { body } of f.wire) {
    const wireMessages = variant === "chat" ? body.messages.filter((m: any) => m.role !== "system")
      : variant === "responses" || variant === "subscription" ? body.input : variant === "gemini" ? body.contents : body.messages
    expect(wireMessages[0].role).toBe("user")
    const bodyText = JSON.stringify(body)
    for (let i = 0; i < 6; i++) if (bodyText.includes(`result-${i}:`)) {
      expect(bodyText).toContain(`round-${i}`)
      replayed.push(`result-${i}`)
    }
  }
  expect(replayed).toEqual(Array.from({ length: 6 }, (_, i) => `result-${i}`))
  expect(facts).toHaveLength(f.wire.length)
  expect(facts.every(value => value.inputTokens + value.outputReserve + 1000 <= 20000)).toBe(true)
  expect(f.wire.some(({ body }) => JSON.stringify(body).includes("source-record framing"))).toBe(true)
})
