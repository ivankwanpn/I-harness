import { afterEach, expect, it, vi } from "vitest"
import { createOpenAIClient } from "@i-harness/llm-openai"
import type { LLMMessage, LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"
import { append, createSession, deriveMessages, fromJSONL, toJSONL } from "../../core-session/src/index.ts"
import { toWireMessages } from "../../llm-anthropic/src/request/messages.ts"
import { toConverseMessages } from "../../llm-bedrock/src/request/messages.ts"
import { toGeminiContents } from "../../llm-gemini/src/request/messages.ts"
import { mapMessages } from "../../llm-openai/src/request/messages.ts"

afterEach(() => vi.unstubAllGlobals())
const source = { model: "source-model", providerId: "source-route", apiKey: "local-only" }
const target = { ...source, model: "target-model", providerId: "target-route" }
const before = "I will read the file. ", after = "The next step follows."
const callId = "call-order-1", name = "read", args = { file: "資料🙂.txt", line: 2 }
const request: LLMRequest = { systemPrompt: "", messages: [{ role: "user", content: "Read it." }], tools: [{ name, description: "read", inputSchema: { type: "object" } }] }

async function recordedSession(signed: boolean) {
  const frames: object[] = []
  const message = (index: number, text: string) => {
    frames.push({ type: "response.output_text.delta", delta: text },
      { type: "response.output_item.done", output_index: index, item: { type: "message", role: "assistant",
        ...(signed ? { phase: "commentary" } : {}), content: [{ type: "output_text", text }] } })
  }
  const offset = signed ? 1 : 0
  if (signed) frames.push({ type: "response.output_item.done", output_index: 0,
    item: { type: "reasoning", id: "rs-local", summary: [], encrypted_content: "private-local-signature" } })
  message(offset, before)
  const item = { type: "function_call", id: "fc-local", call_id: callId, name, arguments: JSON.stringify(args) }
  frames.push({ type: "response.output_item.added", output_index: offset + 1, item }, { type: "response.output_item.done", output_index: offset + 1, item })
  message(offset + 2, after)
  frames.push({ type: "response.completed", response: { status: "completed" } })
  vi.stubGlobal("fetch", async () => new Response(frames.map(value => "data: " + JSON.stringify(value) + "\n\n").join("")))
  const session = createSession()
  append(session, { type: "turn/start" }); append(session, { type: "user/message", text: "Read it." }); append(session, { type: "step/start" })
  let text = "", ending: Extract<LLMStreamEvent, { type: "end" }> | undefined
  for await (const event of createOpenAIClient(source).stream(request)) {
    if (event.type === "error") throw event.error
    if (event.type === "text/chunk") text += event.text
    if (event.type === "tool_call") append(session, { type: "tool/call", callId: event.call.id!, name: event.call.name, args: event.call.args })
    if (event.type === "end") ending = event
  }
  expect(ending?.providerContinuation?.kind).toBe("openai-responses")
  append(session, { type: "assistant/message", text, providerContinuation: ending!.providerContinuation })
  append(session, { type: "tool/result", callId, name, output: "file contents" }); append(session, { type: "step/end" })
  return session
}

function checkWire(message: Extract<LLMMessage, { role: "assistant" }>, head: string, callArgs: typeof args, tail?: string) {
  const order = (text: (value: string) => unknown, tool: unknown) => [text(head), tool, ...(tail === undefined ? [] : [text(tail)])]
  expect(mapMessages([message], target, false)).toEqual(order(content => ({ role: "assistant", content }),
    { type: "function_call", call_id: callId, name, arguments: JSON.stringify(callArgs) }))
  expect(toWireMessages(target, request, [message], [])).toEqual([{ role: "assistant",
    content: order(text => ({ type: "text", text }), { type: "tool_use", id: callId, name, input: callArgs }) }])
  expect(toGeminiContents([message], target)).toEqual([{ role: "model",
    parts: order(text => ({ text }), { functionCall: { id: callId, name, args: callArgs } }) }])
  expect(toConverseMessages(target, [message])).toEqual([{ role: "assistant",
    content: order(text => ({ text }), { toolUse: { toolUseId: callId, name, input: callArgs } }) }])
}

it.each([false, true])("replays only the ordered public blocks before and after JSONL with native reasoning/phase=%s", async signed => {
  const session = await recordedSession(signed)
  for (const view of [session, fromJSONL(toJSONL(session))]) {
    const message = deriveMessages(view).find(m => m.role === "assistant")
    if (message?.role !== "assistant") throw Error("Missing recorded assistant message")
    expect(message.content).toBe(before + after)
    checkWire(message, before, args, after)
    const editedArgs = { ...args, line: 3 }
    checkWire({ ...message, content: "Edited narration.", toolCalls: [{ id: callId, name, args: editedArgs }] }, "Edited narration.", editedArgs)
  }
})
