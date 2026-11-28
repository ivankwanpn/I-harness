import { afterEach, expect, it, vi } from "vitest"
import { createAnthropicClient } from "@i-harness/llm-anthropic"
import { createBedrockClient, type BedrockRuntimeFace } from "@i-harness/llm-bedrock"
import { createOpenAIClient } from "@i-harness/llm-openai"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { append, createSession, deriveMessages, fromJSONL, toJSONL } from "../../core-session/src/index.ts"
import { mapMessages } from "../../llm-openai/src/request/messages.ts"
import { toGeminiContents } from "../../llm-gemini/src/request/messages.ts"

const source = { model: "fixture", apiKey: "local-only", providerId: "source" }
const target = { ...source, providerId: "foreign" }
const request: LLMRequest = { messages: [{ role: "user", content: "read both" }], systemPrompt: "", tools: [] }
const ids = ["call_a", "call_b"]
const argumentsFor = (id: string) => ({ path: id + ".txt" })
afterEach(() => vi.unstubAllGlobals())

function responsesFrames() {
  const items = ids.map((call_id, i) => ({ type: "function_call", id: "fc_" + i, call_id, name: "read", arguments: "" }))
  return [
    ...items.map((item, output_index) => ({ type: "response.output_item.added", output_index, item })),
    ...[1, 0].flatMap(i => [
      { type: "response.function_call_arguments.done", item_id: items[i]!.id, arguments: JSON.stringify(argumentsFor(ids[i]!)) },
      { type: "response.output_item.done", output_index: i, item: { ...items[i], arguments: JSON.stringify(argumentsFor(ids[i]!)) } },
    ]),
    { type: "response.completed", response: { status: "completed" } },
  ]
}
function messagesFrames(signed: boolean) {
  const offset = Number(signed)
  return [
    ...(signed ? [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "private", signature: "source-signature" } },
      { type: "content_block_stop", index: 0 },
    ] : []),
    ...ids.map((id, i) => ({ type: "content_block_start", index: i + offset, content_block: { type: "tool_use", id, name: "read", input: {} } })),
    ...[1, 0].flatMap(index => [
      { type: "content_block_delta", index: index + offset, delta: { type: "input_json_delta", partial_json: JSON.stringify(argumentsFor(ids[index]!)) } },
      { type: "content_block_stop", index: index + offset },
    ]),
    { type: "message_stop" },
  ]
}
function bedrockFrames(signed: boolean) {
  const offset = Number(signed)
  return [
    ...(signed ? [
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "private", signature: "source-signature" } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
    ] : []),
    ...ids.map((id, i) => ({ contentBlockStart: { contentBlockIndex: i + offset, start: { toolUse: { toolUseId: id, name: "read" } } } })),
    ...[1, 0].flatMap(i => [
      { contentBlockDelta: { contentBlockIndex: i + offset, delta: { toolUse: { input: JSON.stringify(argumentsFor(ids[i]!)) } } } },
      { contentBlockStop: { contentBlockIndex: i + offset } },
    ]),
    { messageStop: { stopReason: "tool_use" } },
  ]
}
function sourceClient(protocol: "responses" | "messages" | "bedrock", signed: boolean): ModelClient {
  if (protocol === "bedrock") {
    const transport = { send: async () => ({ stream: bedrockFrames(signed) }), destroy() {} }
    return createBedrockClient(source, transport as unknown as BedrockRuntimeFace)
  }
  const frames = protocol === "messages" ? messagesFrames(signed) : responsesFrames()
  vi.stubGlobal("fetch", async () => new Response(frames.map(f => "data: " + JSON.stringify(f) + "\n\n").join("")))
  return protocol === "messages" ? createAnthropicClient(source) : createOpenAIClient(source)
}

it.each([
  ["responses", false], ["messages", false], ["messages", true], ["bedrock", false], ["bedrock", true],
] as const)("replays indexed %s calls in provider order after opposite completion and journal reload (signed=%s)", async (protocol, signed) => {
  const client = sourceClient(protocol, signed), session = createSession(), emitted: string[] = []
  append(session, { type: "user/message", text: "read both" })
  append(session, { type: "step/start" })
  for await (const event of client.stream(request)) {
    if (event.type === "error") throw event.error
    if (event.type === "tool_call") {
      const { id, name, args } = event.call
      if (!id) throw Error("Missing provider call ID")
      expect(args).toEqual(argumentsFor(id))
      emitted.push(id)
      append(session, { type: "tool/call", callId: id, name, args })
    }
    if (event.type === "end") append(session, { type: "assistant/message", text: "", providerContinuation: event.providerContinuation, ...(event.thinkingBlocks ? { thinkingBlocks: event.thinkingBlocks } : {}) })
  }
  expect(emitted).toEqual(["call_b", "call_a"])
  for (const callId of emitted) append(session, { type: "tool/result", callId, name: "read", output: callId })
  append(session, { type: "step/end" })
  for (const saved of [session, fromJSONL(toJSONL(session))]) {
    const messages = deriveMessages(saved)
    expect(messages.find(m => m.role === "assistant")?.toolCalls?.map(c => c.id)).toEqual(emitted)
    expect(messages.filter(m => m.role === "tool").map(m => m.toolCallId)).toEqual(emitted)
    expect(mapMessages(messages, target, false).slice(1, 3)).toEqual(ids.map(call_id => ({
      type: "function_call", call_id, name: "read", arguments: JSON.stringify(argumentsFor(call_id)),
    })))
    expect(toGeminiContents(messages, target).find(m => m.role === "model")?.parts).toEqual(ids.map(id => ({
      functionCall: { id, name: "read", args: argumentsFor(id) },
    })))
    const replay = await client.prepare!({ ...request, messages })
    if (signed) expect(replay.validation?.native).toBe("preserved")
  }
})
