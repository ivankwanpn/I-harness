import { expect, it, vi } from "vitest"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"
import { createBedrockClient, type BedrockConfig, type BedrockRuntimeFace } from "../src/index.ts"

const sdk = vi.hoisted(() => ({ construct: vi.fn(), send: vi.fn(async () => ({ stream: [] })), destroy: vi.fn() }))
vi.mock("@aws-sdk/client-bedrock-runtime", async importOriginal => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-bedrock-runtime")>()
  return { ...actual, BedrockRuntimeClient: class {
    send = sdk.send
    destroy = sdk.destroy
    constructor(options: unknown) { sdk.construct(options) }
  } }
})

function trackedStream(members: unknown[], failure?: { error: Error }): {
  stream: AsyncIterable<unknown>; returned: ReturnType<typeof vi.fn>
} {
  const returned = vi.fn(async () => ({ done: true as const, value: undefined }))
  return { returned, stream: { [Symbol.asyncIterator]() {
    let index = 0
    return { return: returned, next: async () => {
      if (index < members.length) return { done: false, value: members[index++] }
      if (failure) throw failure.error
      return { done: true, value: undefined }
    } }
  } } }
}

function runtimeFor(streams: AsyncIterable<unknown>[]) {
  const send = vi.fn(async (_command: unknown, _options?: unknown) => ({ stream: streams.shift() }))
  const destroy = vi.fn()
  return { send, destroy, runtime: { send, destroy } as unknown as BedrockRuntimeFace }
}

const request: LLMRequest = { messages: [], tools: [], systemPrompt: "" }
async function drain(events: AsyncIterable<LLMStreamEvent>) {
  const result: LLMStreamEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

it("isolates overlapping streams with reused tool/reasoning indices, usage and stop flags", async () => {
  const members = (name: string, reason: string, count: number) => [
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: name, name } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"value":' } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { reasoningContent: { text: name, signature: `sig-${name}` } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { reasoningContent: { redactedContent: new Uint8Array([count]) } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { reasoningContent: { redactedContent: new Uint8Array([count + 1]) } } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: `${count}}` } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { metadata: { usage: { inputTokens: count, cacheReadInputTokens: count + 10 } } },
    { messageStop: { stopReason: reason } },
  ]
  const first = trackedStream(members("first", "max_tokens", 1)), second = trackedStream(members("second", "guardrail_intervened", 2))
  const fixture = runtimeFor([first.stream, second.stream])
  const client = createBedrockClient({ model: "fixture", providerId: "route" }, fixture.runtime)
  const activityA: string[] = [], activityB: string[] = []
  const a = client.stream({ ...request, onStreamActivity: kind => activityA.push(kind) })[Symbol.asyncIterator]()
  const b = client.stream({ ...request, onStreamActivity: kind => activityB.push(kind) })[Symbol.asyncIterator]()
  expect((await a.next()).value).toEqual({ type: "reasoning", blockId: "1", text: "first" })
  expect((await b.next()).value).toEqual({ type: "reasoning", blockId: "1", text: "second" })
  const remainingA: LLMStreamEvent[] = [], remainingB: LLMStreamEvent[] = []
  for (;;) {
    const [left, right] = await Promise.all([a.next(), b.next()])
    if (!left.done) remainingA.push(left.value)
    if (!right.done) remainingB.push(right.value)
    if (left.done && right.done) break
  }
  for (const [events, name, count, flag] of [[remainingA, "first", 1, "truncated"], [remainingB, "second", 2, "refused"]] as const) {
    expect(events).toEqual([
      { type: "tool_call", call: { id: name, name, args: { value: count } } },
      { type: "usage", usage: { inputTokens: count, cacheReadTokens: count + 10, inputTokenSemantics: "excludes-cache" } },
      { type: "end", [flag]: true, providerContinuation: {
        kind: "bedrock", model: "fixture", providerId: "route",
        reasoningBlocks: [{ redactedContentBase64: Buffer.from([count, count + 1]).toString("base64") }, { reasoningText: { text: name, signature: `sig-${name}` } }],
        contentOrder: [{ kind: "tool", index: 0 }, { kind: "reasoning", index: 1 }],
      } },
    ])
  }
  expect(activityA).toEqual(["response-start", "tool-arguments", "tool-arguments"])
  expect(activityB).toEqual(activityA)
  expect(first.returned).not.toHaveBeenCalled()
  expect(second.returned).not.toHaveBeenCalled()
  expect(fixture.destroy).not.toHaveBeenCalled()
})

it("closes the SDK iterator once on early consumer return without destroying the runtime", async () => {
  const fixture = trackedStream([{ contentBlockDelta: { delta: { text: "first" } } }, { contentBlockDelta: { delta: { text: "unread" } } }])
  const runtime = runtimeFor([fixture.stream])
  const iterator = createBedrockClient({ model: "fixture" }, runtime.runtime).stream(request)[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual({ type: "text/chunk", text: "first" })
  await iterator.return?.()
  expect(fixture.returned).toHaveBeenCalledTimes(1)
  expect(runtime.destroy).not.toHaveBeenCalled()
})

it.each([
  [{ validationException: { message: "invalid" } }],
  [{ contentBlockStart: { start: { toolUse: { name: "broken" } } } }, { contentBlockDelta: { delta: { toolUse: { input: "{" } } } }, { contentBlockStop: {} }],
])("closes the SDK iterator on a terminal error and suppresses end", async (...members) => {
  const fixture = trackedStream([...members, { contentBlockDelta: { delta: { text: "unread" } } }])
  const runtime = runtimeFor([fixture.stream])
  const events = await drain(createBedrockClient({ model: "fixture" }, runtime.runtime).stream(request))
  expect(events.map(event => event.type)).toEqual(["error"])
  expect(fixture.returned).toHaveBeenCalledTimes(1)
  expect(runtime.destroy).not.toHaveBeenCalled()
})

it("preserves SDK next rejection cleanup and aborted-read throw behavior", async () => {
  const controller = new AbortController()
  const error = new Error("read aborted")
  const fixture = trackedStream([{ contentBlockDelta: { delta: { text: "first" } } }], { error })
  const runtime = runtimeFor([fixture.stream])
  const iterator = createBedrockClient({ model: "fixture" }, runtime.runtime).stream({ ...request, signal: controller.signal })[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual({ type: "text/chunk", text: "first" })
  controller.abort()
  await expect(iterator.next()).rejects.toBe(error)
  expect(fixture.returned).not.toHaveBeenCalled()
  expect(runtime.destroy).not.toHaveBeenCalled()
  expect(runtime.send.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal })
})

it("keeps injected construction lazy and freezes input config/callbacks at preparation", async () => {
  const reads: string[] = []
  let model = "anthropic.claude-sonnet-4-6", providerId = "initial"
  const config: BedrockConfig = {
    get model() { reads.push(`model:${model}`); return model },
    get providerId() { reads.push(`provider:${providerId}`); return providerId },
    get region() { reads.push("region"); return "eu-west-1" },
    get profile() { reads.push("profile"); return "fixture-profile" },
    get inputModalities(): ("text" | "image")[] { reads.push("modalities"); return ["text"] },
    get options() { reads.push("options"); return { custom: 1 } },
  }
  const fixture = trackedStream([
    { contentBlockDelta: { delta: { reasoningContent: { text: "plan", signature: "sig" } } } },
    { contentBlockStop: {} },
  ])
  const runtime = runtimeFor([fixture.stream])
  const client = createBedrockClient(config, runtime.runtime)
  expect(reads).toEqual([])
  const activities: string[] = []
  let observer = (kind: string) => { activities.push(`initial:${kind}`) }
  const lazyRequest: LLMRequest = { ...request, get onStreamActivity() { reads.push("callback"); return observer } }
  const iterator = client.stream(lazyRequest)[Symbol.asyncIterator]()
  expect(reads).toEqual([])
  observer = kind => { activities.push(`current:${kind}`) }
  await iterator.next()
  expect(reads).toEqual(["callback", "model:anthropic.claude-sonnet-4-6", "provider:initial", "modalities", "options"])
  expect(activities).toEqual(["current:response-start"])
  const command = runtime.send.mock.calls[0]?.[0] as unknown as { input: Record<string, unknown> }
  expect(command.input.modelId).toBe("anthropic.claude-sonnet-4-6")
  expect(command.input).not.toHaveProperty("onStreamActivity")
  model = "terminal-model"; providerId = "terminal-route"
  expect((await iterator.next()).value).toEqual({ type: "end", providerContinuation: {
    kind: "bedrock", model: "anthropic.claude-sonnet-4-6", providerId: "initial", reasoningBlocks: [{ reasoningText: { text: "plan", signature: "sig" } }],
    contentOrder: [{ kind: 'reasoning', index: 0 }], producerWitness: { version: 1, messagesPrefixId: expect.stringMatching(/^[a-f0-9]{64}$/), inputSurfaceId: expect.stringMatching(/^[a-f0-9]{64}$/), callsId: expect.stringMatching(/^[a-f0-9]{64}$/), callCount: 0 },
  } })
  expect(reads).toHaveLength(5)
  await iterator.next()
})

it("constructs one default SDK runtime and retains it for later requests", async () => {
  sdk.construct.mockClear(); sdk.send.mockClear(); sdk.destroy.mockClear()
  const reads: string[] = []
  const client = createBedrockClient({ model: "fixture", get region() { reads.push("region"); return "eu-west-1" }, get profile() { reads.push("profile"); return "fixture-profile" } })
  expect(reads).toEqual(["region", "profile", "profile"])
  expect(sdk.construct).toHaveBeenCalledExactlyOnceWith({ region: "eu-west-1", profile: "fixture-profile" })
  await drain(client.stream(request)); await drain(client.stream(request))
  expect(sdk.construct).toHaveBeenCalledTimes(1)
  expect(sdk.send).toHaveBeenCalledTimes(2)
  expect(reads).toEqual(["region", "profile", "profile"])
  expect(sdk.destroy).not.toHaveBeenCalled()
})
