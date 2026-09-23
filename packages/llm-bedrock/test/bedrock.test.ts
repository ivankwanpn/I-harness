import { afterEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import { createBedrockClient, resolveBedrockRegion, translateReasoning, type BedrockRuntimeFace } from "../src/index.ts"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

// The stream fixture speaks the CURRENT AWS SDK ConverseStream wire shape
// (discriminated members: contentBlockStart.start.toolUse,
// contentBlockDelta.delta.toolUse.input / delta.text, …). The fake runtime is
// a type-level fixture only — no network, no AWS credential chain.
function fakeRuntime(events: unknown[]): { fake: BedrockRuntimeFace; sent: unknown[] } {
  const sent: unknown[] = []
  const fake = {
    send: vi.fn(async (command: unknown) => {
      sent.push(command)
      return { stream: events }
    }),
    destroy: vi.fn(),
  }
  return { fake: fake as unknown as BedrockRuntimeFace, sent }
}

async function lastCommandSent(fake: BedrockRuntimeFace): Promise<{ input: Record<string, unknown> }> {
  const send = fake.send as unknown as Mock
  const cmd = send.mock.calls.at(-1)![0]
  return cmd as { input: Record<string, unknown> }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("llm-bedrock protocol (Converse wire)", () => {
  it("translates an LLMRequest to a ConverseStreamCommand (modelId/system/messages/toolConfig)", async () => {
    const { fake } = fakeRuntime([])
    const client = createBedrockClient({ model: "claude-x" }, fake)
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "read", description: "d", inputSchema: { type: "object" } }], systemPrompt: "sys" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const { input } = await lastCommandSent(fake)
    expect(input.modelId).toBe("claude-x")
    expect(input.system).toEqual([{ text: "sys" }])
    expect(input.messages).toEqual([{ role: "user", content: [{ text: "hi" }] }])
    expect(input.toolConfig).toEqual({
      tools: [{ toolSpec: { name: "read", description: "d", inputSchema: { json: { type: "object" } } } }],
    })
    expect(input.additionalModelRequestFields).toBeUndefined()
  })

  it("omits system/toolConfig when empty and forwards options as additionalModelRequestFields", async () => {
    const { fake } = fakeRuntime([])
    const client = createBedrockClient({ model: "m", options: { reasoning_effort: "high" } }, fake)
    const it = client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const { input } = await lastCommandSent(fake)
    expect(input.system).toBeUndefined()
    expect(input.toolConfig).toBeUndefined()
    expect(input.additionalModelRequestFields).toEqual({ reasoning_effort: "high" })
  })

  it("translates tool round-trip messages (assistant toolCalls → toolUse; tool result → toolResult)", async () => {
    const { fake } = fakeRuntime([])
    const client = createBedrockClient({ model: "m" }, fake)
    const request: LLMRequest = {
      messages: [
        { role: "user", content: "read a.txt" },
        { role: "assistant", content: "lets use the tool", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
        { role: "tool", toolCallId: "call_1", content: '{"content":"ok"}' },
        { role: "tool", toolCallId: "call_1", content: "plain text" },
      ],
      tools: [],
      systemPrompt: "sys",
    }
    const it = client.stream(request)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const { input } = await lastCommandSent(fake)
    expect(input.messages).toEqual([
      { role: "user", content: [{ text: "read a.txt" }] },
      {
        role: "assistant",
        content: [
          { text: "lets use the tool" },
          { toolUse: { toolUseId: "call_1", name: "read", input: { path: "a.txt" } } },
        ],
      },
      { role: "user", content: [{ toolResult: { toolUseId: "call_1", content: [{ json: { content: "ok" } }] } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "call_1", content: [{ text: "plain text" }] } }] },
    ])
  })

  it("maps the stream to events in order (text delta, toolUse accumulation, tool_call, end)", async () => {
    const { fake } = fakeRuntime([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hel" } } },
      { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tu_1", name: "write" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: "{\"path\"" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: ":\"a.txt\"}" } } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "end_turn" } },
    ])
    const client = createBedrockClient({ model: "m" }, fake)
    const events: string[] = []
    let args: unknown
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "text/chunk") events.push(`t:${ev.text}`)
      if (ev.type === "tool_call") { events.push(`c:${ev.call.name}`); args = ev.call.args }
      if (ev.type === "end") events.push("end")
    }
    expect(events).toEqual(["t:hel", "c:write", "end"])
    expect(args).toEqual({ path: "a.txt" })
  })

  it("carries reasoning deltas as reasoning events", async () => {
    const { fake } = fakeRuntime([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "pondering" } } } },
      { messageStop: { stopReason: "end_turn" } },
    ])
    const client = createBedrockClient({ model: "m" }, fake)
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "reasoning") events.push(`r:${ev.text}`)
      if (ev.type === "end") events.push("end")
    }
    expect(events).toEqual(["r:pondering", "end"])
  })

  it("yields an error event and stops on malformed tool args", async () => {
    const { fake } = fakeRuntime([
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tu_1", name: "write" } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "{not-json" } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
    ])
    const client = createBedrockClient({ model: "m" }, fake)
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "error") events.push("error")
      if (ev.type === "end") events.push("end")
      if (ev.type === "tool_call") events.push("tool")
    }
    expect(events).toEqual(["error"]) // error, and NO end, NO tool_call
  })

  it("yields an error event on SDK stream exception members", async () => {
    const { fake } = fakeRuntime([
      { internalServerException: { message: "boom" } },
    ])
    const client = createBedrockClient({ model: "m" }, fake)
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "error") events.push(`error:${ev.error.message}`)
      if (ev.type === "end") events.push("end")
    }
    expect(events).toEqual(["error:bedrock stream failed: boom"])
  })

  it("M72 Ⅲ: maps the metadata/usage member onto the seam's usage event", async () => {
    const { fake } = fakeRuntime([
      { metadata: { usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, metrics: { latencyMs: 10 } } },
      { messageStop: { stopReason: "end_turn" } },
    ])
    const client = createBedrockClient({ model: "m" }, fake)
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "end") events.push("end")
      if (ev.type === "text/chunk") events.push(`t:${ev.text}`)
      if (ev.type === "usage") events.push(`u:${ev.usage.inputTokens}/${ev.usage.outputTokens}`)
    }
    expect(events).toEqual(["u:5/3", "end"])
  })

  it("M72 Ⅲ: a metadata member without a recognisable number emits no usage event", async () => {
    const { fake } = fakeRuntime([
      { metadata: { metrics: { latencyMs: 10 } } },
      { messageStop: { stopReason: "end_turn" } },
    ])
    const client = createBedrockClient({ model: "m" }, fake)
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "end") events.push("end")
      if (ev.type === "usage") events.push(`u:${ev.usage.inputTokens}/${ev.usage.outputTokens}`)
    }
    expect(events).toEqual(["end"])
  })

  // The OTHER exit of the "no recognisable number ⇒ undefined" rule. The test
  // above never reaches the mapper's tail — its fixture carries no `usage` at
  // all, so it exits at the non-object guard. THIS is the fixture that reaches
  // the tail with an empty result, which is what makes the rule's second exit
  // load-bearing: an always-returning tail would emit `{ type: "usage", usage: {} }`
  // — an event that reads as a measurement nobody made, precisely what the
  // seam's absent-is-not-zero contract forbids.
  it("M72 Ⅲ: a usage object with no recognisable number emits no usage event", async () => {
    const { fake } = fakeRuntime([
      { metadata: { usage: {} } },
      { messageStop: { stopReason: "end_turn" } },
    ])
    const client = createBedrockClient({ model: "m" }, fake)
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "end") events.push("end")
      if (ev.type === "usage") events.push(`u:${ev.usage.inputTokens}/${ev.usage.outputTokens}`)
    }
    expect(events).toEqual(["end"])
  })

  // Iron law ① — the mapper takes only `typeof v === "number" &&
  // Number.isFinite(v)`. A STRING that merely spells a count ("5") is not a
  // number the provider measured; coercing it would write an unvalidated value
  // straight into `LLMUsage` — the "number nobody made" this phase exists to
  // forbid. Every other fixture in this file hands the mapper either a real
  // number or nothing at all, so this is the one that pins the guard: it is the
  // fixture a coercion regression has to break.
  it("M72 Ⅲ: a token count the wire sent as a string is not taken", async () => {
    const { fake } = fakeRuntime([
      { metadata: { usage: { inputTokens: "5" } } },
      { messageStop: { stopReason: "end_turn" } },
    ])
    const client = createBedrockClient({ model: "m" }, fake)
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "end") events.push("end")
      if (ev.type === "usage") events.push(`u:${ev.usage.inputTokens}/${ev.usage.outputTokens}`)
    }
    expect(events).toEqual(["end"])
  })

  // Measured, not assumed: the installed @aws-sdk/client-bedrock-runtime's
  // `TokenUsage` (dist-types/models/models_0.d.ts) declares inputTokens,
  // outputTokens, totalTokens, cacheReadInputTokens, cacheWriteInputTokens and
  // cacheDetails — so the two cache counts are mapped too, onto the same seam
  // names anthropic's cache_read/creation_input_tokens take. `totalTokens` has
  // no home in `LLMUsage` (it is the wire's own sum of the two counts, not a
  // new measurement) and is deliberately NOT mapped.
  it("M72 Ⅲ: the cache counts the Converse TokenUsage declares are mapped; totalTokens is not", async () => {
    const { fake } = fakeRuntime([
      { metadata: { usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, cacheReadInputTokens: 7, cacheWriteInputTokens: 2 } } },
      { messageStop: { stopReason: "end_turn" } },
    ])
    const client = createBedrockClient({ model: "m" }, fake)
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) events.push(ev)
    const usage = events.filter((e) => e.type === "usage")
    expect(usage).toEqual([
      { type: "usage", usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 7, cacheCreationTokens: 2 } },
    ])
    expect("totalTokens" in usage[0]!.usage).toBe(false)
  })
})

describe("M14 bedrock wire (image modality)", () => {
  it("shapes image parts as image blocks with format + base64-decoded bytes", async () => {
    const { fake } = fakeRuntime([])
    const client = createBedrockClient({ model: "m", inputModalities: ["text", "image"] }, fake)
    const it = client.stream({
      systemPrompt: "s",
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] }],
    } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const { input } = await lastCommandSent(fake)
    const user = (input.messages as { content: unknown[] }[])[0]!
    expect(user.content).toEqual([
      { text: "look" },
      { image: { format: "png", source: { bytes: Buffer.from(PNG, "base64") } } },
    ])
  })

  it("projects images out when the route lacks the image modality", async () => {
    const { fake } = fakeRuntime([])
    const client = createBedrockClient({ model: "m", inputModalities: ["text"] }, fake)
    const it = client.stream({
      systemPrompt: "s",
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] }],
    } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const { input } = await lastCommandSent(fake)
    const user = (input.messages as { content: unknown[] }[])[0]!
    expect(user.content).toEqual([
      { text: "look" },
      { text: "[image omitted: model is text-only; base64:iVBORw0K]" },
    ])
  })
})

describe("bedrock region resolution", () => {
  it("options.region → AWS_REGION → AWS_DEFAULT_REGION → us-east-1", () => {
    expect(resolveBedrockRegion("eu-west-1", {})).toBe("eu-west-1")
    expect(resolveBedrockRegion(undefined, { AWS_REGION: "ap-southeast-2" })).toBe("ap-southeast-2")
    expect(resolveBedrockRegion(undefined, { AWS_DEFAULT_REGION: "us-west-2" })).toBe("us-west-2")
    expect(resolveBedrockRegion(undefined, {})).toBe("us-east-1")
  })
})

describe("M32 reasoning effort (bedrock Converse)", () => {
  it("maps claude 4.6+ to adaptive reasoningConfig + adaptive thinking (effort verbatim)", () => {
    expect(translateReasoning("anthropic.claude-sonnet-4-6", "high")).toEqual({
      reasoningConfig: { type: "adaptive", maxReasoningEffort: "high" },
      thinking: { type: "adaptive" },
    })
    expect(translateReasoning("anthropic.claude-opus-4-7", "max")).toEqual({
      reasoningConfig: { type: "adaptive", maxReasoningEffort: "max" },
      thinking: { type: "adaptive" },
    })
    expect(translateReasoning("anthropic.claude-sonnet-4-6-v1:0", "xhigh")).toEqual({
      reasoningConfig: { type: "adaptive", maxReasoningEffort: "xhigh" },
      thinking: { type: "adaptive" },
    })
  })

  it("maps claude ≤4.5 to thinkingConfig budgetTokens table (no effort)", () => {
    expect(translateReasoning("anthropic.claude-3-5-sonnet-20240620", "low")).toEqual({ thinkingConfig: { type: "enabled", budgetTokens: 2048 } })
    expect(translateReasoning("anthropic.claude-sonnet-4-5", "medium")).toEqual({ thinkingConfig: { type: "enabled", budgetTokens: 8192 } })
    expect(translateReasoning("anthropic.claude-3-5-sonnet-20240620", "high")).toEqual({ thinkingConfig: { type: "enabled", budgetTokens: 16384 } })
    expect(translateReasoning("anthropic.claude-sonnet-4-5", "xhigh")).toEqual({ thinkingConfig: { type: "enabled", budgetTokens: "xhigh" } })
  })

  it("maps amazon nova effort verbatim via adaptive reasoningConfig", () => {
    expect(translateReasoning("amazon.nova-premier-v1:0", "low")).toEqual({ reasoningConfig: { type: "adaptive", maxReasoningEffort: "low" } })
    expect(translateReasoning("amazon.nova-pro-v1:0", "medium")).toEqual({ reasoningConfig: { type: "adaptive", maxReasoningEffort: "medium" } })
    expect(translateReasoning("amazon.nova-pro-v1:0", "high")).toEqual({ reasoningConfig: { type: "adaptive", maxReasoningEffort: "high" } })
    expect(translateReasoning("amazon.nova-pro-v1:0", "max")).toEqual({ reasoningConfig: { type: "adaptive", maxReasoningEffort: "max" } })
  })

  it("sends nothing on off (all families) and when unset", () => {
    expect(translateReasoning("anthropic.claude-sonnet-4-6", "off")).toBeUndefined()
    expect(translateReasoning("anthropic.claude-3-5-sonnet-20240620", "off")).toBeUndefined()
    expect(translateReasoning("amazon.nova-pro-v1:0", "off")).toBeUndefined()
    expect(translateReasoning("anthropic.claude-sonnet-4-6", undefined)).toBeUndefined()
  })

  it("merges translated fields into additionalModelRequestFields; unset → absent", async () => {
    const { fake } = fakeRuntime([])
    const client = createBedrockClient({ model: "anthropic.claude-sonnet-4-6" }, fake)
    const it = client.stream({ messages: [], tools: [], systemPrompt: "", reasoningEffort: "high" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const { input } = await lastCommandSent(fake)
    expect(input.additionalModelRequestFields).toEqual({
      reasoningConfig: { type: "adaptive", maxReasoningEffort: "high" },
      thinking: { type: "adaptive" },
    })

    const { fake: fake2 } = fakeRuntime([])
    const client2 = createBedrockClient({ model: "anthropic.claude-sonnet-4-6" }, fake2)
    const it2 = client2.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)[Symbol.asyncIterator]()
    await it2.next()
    await it2.return?.()
    const { input: input2 } = await lastCommandSent(fake2)
    expect(input2.additionalModelRequestFields).toBeUndefined()
  })

  it("merges without clobbering existing config.options", async () => {
    const { fake } = fakeRuntime([])
    const client = createBedrockClient({ model: "anthropic.claude-sonnet-4-6", options: { max_tokens: 100 } }, fake)
    const it = client.stream({ messages: [], tools: [], systemPrompt: "", reasoningEffort: "low" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const { input } = await lastCommandSent(fake)
    expect(input.additionalModelRequestFields).toEqual({
      max_tokens: 100,
      reasoningConfig: { type: "adaptive", maxReasoningEffort: "low" },
      thinking: { type: "adaptive" },
    })
  })
})

// M72 Ⅰ. `await client.send(...)` (the Converse request itself) had no
// try/catch, so every request-level failure — auth, throttling, network —
// escaped as a raw SDK throw and bypassed the seam's `error` event channel
// that the other four adapters route through. Abort is NOT a provider
// failure: it keeps today's behaviour (a throw out of the generator).
describe("M72 Ⅰ request-level failures (bedrock)", () => {
  it("M72 Ⅰ: a request-level failure is an error event with a diagnosis, not a raw throw", async () => {
    const { fake } = fakeRuntime([])
    ;(fake.send as unknown as Mock).mockRejectedValueOnce(new Error("AccessDeniedException: nope"))
    const client = createBedrockClient({ model: "m" }, fake)
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(["error"])
    expect((events[0] as { error: Error }).error.message).toContain("AccessDeniedException")
  })

  // Fix 3's other half: THIS path is the one the review measured. An AWS
  // `AccessDeniedException` is an auth failure on the SDK's transport — Node's
  // NODE_USE_ENV_PROXY / NODE_EXTRA_CA_CERTS are not read by the AWS SDK at
  // all, so the fetch tail the helper used to append unconditionally was
  // unhookable advice. The resolved region rides in the locator slot.
  it("M72 Ⅰ: the request-level diagnosis carries no fetch-specific remediation advice", async () => {
    const { fake } = fakeRuntime([])
    ;(fake.send as unknown as Mock).mockRejectedValueOnce(new Error("AccessDeniedException: nope"))
    const client = createBedrockClient({ model: "m", region: "eu-west-1" }, fake)
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(["error"])
    const message = (events[0] as { error: Error }).error.message
    expect(message).toContain("bedrock request failed (eu-west-1)")
    expect(message).not.toContain("transport")
    expect(message).not.toContain("NODE_USE_ENV_PROXY")
  })

  // The constraint the case above makes easy to break: abort is NOT a provider
  // failure. A cancelled request must keep rejecting out of the generator
  // (M61's cancel contract) — never turn the caller's own abort into an
  // `error` event that reads as a provider fault.
  it("M72 Ⅰ: an aborted request rejects instead of yielding an error event", async () => {
    const { fake } = fakeRuntime([])
    ;(fake.send as unknown as Mock).mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    )
    const controller = new AbortController()
    controller.abort()
    const client = createBedrockClient({ model: "m" }, fake)
    const events: { type: string }[] = []
    const drain = async (): Promise<void> => {
      for await (const ev of client.stream({
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        systemPrompt: "s",
        signal: controller.signal,
      } as LLMRequest)) events.push(ev)
    }
    await expect(drain()).rejects.toThrow("aborted")
    // No event at all — an aborted request is not a provider failure.
    expect(events).toEqual([])
  })
})

// M72 Ⅰ. Task 4 (two commits after the Task-3 ruling) gave the four SSE
// adapters' read loops a catch; bedrock's `for await (const member of
// output.stream ?? [])` stayed bare, so a failure AFTER the 200 — a dropped
// connection, an SDK-level stream error — remained the last one that bypassed
// both `describeTransportError` and the seam's `error` channel. Abort is NOT a
// provider failure: a cancelled request keeps today's behaviour (a throw out of
// the generator).
describe("M72 Ⅰ mid-stream failures (bedrock)", () => {
  /** Hand over the members, then REJECT the next read — the mid-stream shape. */
  function streamThenReject(members: unknown[], err: unknown): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        let index = 0
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            if (index < members.length) return { done: false, value: members[index++] }
            throw err
          },
        }
      },
    }
  }

  /** The fakeRuntime idiom, for a stream that is not a plain array. */
  function runtimeWithStream(stream: AsyncIterable<unknown>): BedrockRuntimeFace {
    return { send: vi.fn(async () => ({ stream })), destroy: vi.fn() } as unknown as BedrockRuntimeFace
  }

  it("M72 Ⅰ: a mid-stream rejection is an error event with a diagnosis, not a raw throw", async () => {
    const stream = streamThenReject(
      [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hel" } } }],
      new Error("socket hang up"),
    )
    const client = createBedrockClient({ model: "m", region: "us-east-1" }, runtimeWithStream(stream))
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(["text/chunk", "error"]) // error is terminal — no `end`
    const message = (events[1] as { error: Error }).error.message
    expect(message).toContain("socket hang up")
    expect(message).toContain("bedrock request failed (us-east-1)")
    // This also pins the ADAPTER-side half of the remediation fix: bedrock asks
    // for `remediation: "none"`, so fetch-specific proxy advice never rides on
    // an AWS fault.
    expect(message).not.toContain("NODE_USE_ENV_PROXY")
  })

  it("M72 Ⅰ: an aborted mid-stream read rejects instead of yielding an error event", async () => {
    const stream = streamThenReject(
      [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hel" } } }],
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    )
    const controller = new AbortController()
    controller.abort()
    const client = createBedrockClient({ model: "m", region: "us-east-1" }, runtimeWithStream(stream))
    const events: { type: string }[] = []
    const drain = async (): Promise<void> => {
      for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s", signal: controller.signal } as LLMRequest)) events.push(ev)
    }
    await expect(drain()).rejects.toThrow("aborted")
    // The pre-abort delta was already delivered; NO error event follows it.
    expect(events.map((e) => e.type)).toEqual(["text/chunk"])
  })
})

// M72 Ⅱ. Converse accepts `maxTokens` ONLY inside `inferenceConfig` (this
// adapter's own header comment records that) — yet the parent object has never
// been built here: every option went to `additionalModelRequestFields`, which
// the wire does not read for the cap. The parent is optional on the wire, so an
// unresolved cap must stay absence.
describe("M72 Ⅱ: the output cap on the bedrock wire", () => {
  it("M72 Ⅱ: the cap lives in inferenceConfig.maxTokens", async () => {
    const { fake } = fakeRuntime([])
    const client = createBedrockClient({ model: "claude-x" }, fake)
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "sys", maxOutputTokens: 4096 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const { input } = await lastCommandSent(fake)
    expect(input.inferenceConfig).toEqual({ maxTokens: 4096 })
  })

  it("M72 Ⅱ: no cap resolved → no inferenceConfig at all", async () => {
    const { fake } = fakeRuntime([])
    const client = createBedrockClient({ model: "claude-x" }, fake)
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "sys" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const { input } = await lastCommandSent(fake)
    expect("inferenceConfig" in input).toBe(false)
  })
})

// M72 Ⅱ. Converse states the ending on `messageStop.stopReason` — the member
// the handler used to skip as "no stream content". `max_tokens` is the
// truncation literal that decides the seam's `truncated?: true` bit (Task 1);
// `end_turn` (or any other reason) is a clean ending with NO field.
describe("M72 Ⅱ: the truncation bit (bedrock)", () => {
  it("M72 Ⅱ: messageStop stopReason max_tokens reaches the seam as truncated", async () => {
    const { fake } = fakeRuntime([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x" } } },
      { messageStop: { stopReason: "max_tokens" } },
    ])
    const client = createBedrockClient({ model: "claude-x" }, fake)
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end", truncated: true })
  })

  it("M72 Ⅱ: messageStop stopReason end_turn carries no truncated field", async () => {
    const { fake } = fakeRuntime([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x" } } },
      { messageStop: { stopReason: "end_turn" } },
    ])
    const client = createBedrockClient({ model: "claude-x" }, fake)
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end" })
    expect(events.at(-1)).not.toHaveProperty("truncated")
  })
})
