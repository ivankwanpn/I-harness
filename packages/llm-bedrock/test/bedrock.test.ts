import { afterEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import { createBedrockClient, resolveBedrockRegion, translateReasoning, type BedrockRuntimeFace } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"

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

  it("ignores the metadata/usage member (no usage event in the seam vocabulary)", async () => {
    const { fake } = fakeRuntime([
      { metadata: { usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, metrics: { latencyMs: 10 } } },
      { messageStop: { stopReason: "end_turn" } },
    ])
    const client = createBedrockClient({ model: "m" }, fake)
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "end") events.push("end")
      if (ev.type === "text/chunk") events.push(`t:${ev.text}`)
    }
    expect(events).toEqual(["end"])
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
