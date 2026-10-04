import { expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, deriveMessages, Inbox, subscribe, type SessionEvent } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import type { LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"
import { createOpenAIClient } from "../../llm-openai/src/index.ts"
import { createAgent } from "../src/index.ts"
import { createLoopbackProvider, deferred, writeSplitSse, type ProviderEvent } from "./helpers/provider-loopback.ts"

const thinkingStart = (index: number): ProviderEvent => ({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } })
const thinkingDelta = (index: number, thinking: string): ProviderEvent => ({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } })
const signatureDelta = (index: number, signature: string): ProviderEvent => ({ type: "content_block_delta", index, delta: { type: "signature_delta", signature } })
const blockStop = (index: number): ProviderEvent => ({ type: "content_block_stop", index })
const textBlock = (index: number, text: string): ProviderEvent[] => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  blockStop(index),
]
const messageEnd: ProviderEvent[] = [
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
  { type: "message_stop" },
]

function setup(model: ModelClient) {
  const ctx = createContext(), session = createSession(), inbox = new Inbox(session)
  const tools = createToolRegistry(ctx)
  tools.register({ name: "read", description: "Read fixture", inputSchema: { type: "object" }, isReadOnly: true, execute: async () => "fixture contents" })
  const seen: SessionEvent[] = []
  subscribe(session, (event) => seen.push(event))
  return { session, inbox, seen, agent: createAgent(ctx, { session, tools, model, systemPrompt: "Fixture system", stepInputs: inbox }) }
}

it("keeps split Anthropic thinking as one visible block and resends exact signed and redacted blocks across tool rounds", async () => {
  const release = deferred()
  const server = await createLoopbackProvider("/v1/messages", [
    async (response) => {
      await writeSplitSse(response, [
        { type: "message_start", message: { usage: { input_tokens: 12 } } },
        thinkingStart(0), thinkingDelta(0, "Inspect "), thinkingDelta(0, "files "),
      ])
      await release.promise
      await writeSplitSse(response, [
        ...[..."與分支 🔎 0123456789abcdefghijklmnopqrstuvwxyz"].map((part) => thinkingDelta(0, part)),
        signatureDelta(0, "signed-"), signatureDelta(0, "first"), blockStop(0),
        { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque-redacted" } }, blockStop(1),
        ...textBlock(2, "Checking."),
        thinkingStart(3), thinkingDelta(3, "Choose "), thinkingDelta(3, "read"), signatureDelta(3, "signed-second"), blockStop(3),
        { type: "content_block_start", index: 4, content_block: { type: "tool_use", id: "loopback-read", name: "read", input: {} } },
        { type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: "{}" } }, blockStop(4),
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } }, { type: "message_stop" },
      ])
    },
    async (response) => writeSplitSse(response, [
      thinkingStart(0), thinkingDelta(0, "After "), thinkingDelta(0, "read"), blockStop(0),
      ...textBlock(1, "Done."), ...messageEnd,
    ]),
    async (response) => writeSplitSse(response, [
      thinkingStart(0), blockStop(0),
      thinkingStart(1), thinkingDelta(1, "Followup "), thinkingDelta(1, "plan"), signatureDelta(1, "signed-followup"), blockStop(1),
      ...textBlock(2, "Followup done."), ...messageEnd,
    ]),
  ])
  const raw: LLMStreamEvent[] = []
  const client = createAnthropicClient({ apiKey: "local-fixture", baseUrl: server.baseUrl, model: "deepseek-fixture" })
  const model: ModelClient = { async *stream(request) { for await (const event of client.stream(request)) { raw.push(event); yield event } } }
  const f = setup(model)
  const notice = '<task id="child" state="error"><task_error>read failed</task_error></task>'
  f.inbox.admit({ inputId: "notice-1", text: notice, delivery: "steer", intent: "system", synthetic: { description: "Inspect source", scope: "turn" } })
  const run = f.agent.run("Human prompt")
  void run.catch(() => undefined)
  try {
    await vi.waitFor(() => expect(f.seen.filter((event) => event.type === "reasoning/chunk")).toHaveLength(2), { timeout: 2_000, interval: 10 })
    expect(f.seen.filter((event) => event.type === "reasoning/chunk")).toEqual([
      expect.objectContaining({ text: "Inspect ", offset: 0 }),
      expect.objectContaining({ text: "files ", offset: 8 }),
    ])
    expect(f.session.events.filter((event) => event.type === "reasoning")).toEqual([])
    release.resolve()
    expect((await run).finalText).toBe("Done.")
    await f.agent.followup("Followup")
    expect(server.errors).toEqual([])
    expect(server.requests).toHaveLength(3)
    expect(raw.filter((event) => event.type === "reasoning" && event.text === "")).toHaveLength(5)
    expect(raw.filter((event) => event.type === "reasoning" && event.text !== "").length).toBeGreaterThan(40)
    const canonical = f.session.events.filter((event) => event.type === "reasoning")
    expect(canonical.map((event) => event.text)).toEqual([
      "Inspect files 與分支 🔎 0123456789abcdefghijklmnopqrstuvwxyz", "Choose read", "After read", "Followup plan",
    ])
    expect(new Set(canonical.map((event) => event.streamId)).size).toBe(4)
    expect(canonical.map((event) => event.blockId)).toEqual(["0", "3", "0", "1"])
    expect(f.session.events.some((event) => event.type === "reasoning/chunk")).toBe(false)
    const chunks = f.seen.filter((event) => event.type === "reasoning/chunk")
    expect(chunks.every((event) => event.text !== "" && event.seq === undefined)).toBe(true)
    for (const event of canonical) {
      let offset = 0
      for (const chunk of chunks.filter((chunk) => chunk.streamId === event.streamId)) {
        expect(chunk.offset).toBe(offset)
        expect(event.text.slice(offset, offset + chunk.text.length)).toBe(chunk.text)
        offset += chunk.text.length
      }
    }
    expect(server.requests[1]!.body.messages).toEqual([
      { role: "user", content: "Human prompt" }, { role: "user", content: notice },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Inspect files 與分支 🔎 0123456789abcdefghijklmnopqrstuvwxyz", signature: "signed-first" },
        { type: "redacted_thinking", data: "opaque-redacted" },
        { type: "text", text: "Checking." },
        { type: "thinking", thinking: "Choose read", signature: "signed-second" },
        { type: "tool_use", id: "loopback-read", name: "read", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "loopback-read", content: "\"fixture contents\"" }] },
    ])
    expect(f.session.events.find((event) => event.type === "assistant/message" && event.text === "Done.")).not.toHaveProperty("thinkingBlocks")
    expect(f.session.events.find((event) => event.type === "user/message" && event.text === notice)).toMatchObject({
      input: { inputId: "notice-1", intent: "system", synthetic: { description: "Inspect source", scope: "turn" } },
    })
    expect(deriveMessages(f.session).filter((message) => message.role === "user")).toEqual([
      { role: "user", content: "Human prompt" }, { role: "user", content: notice }, { role: "user", content: "Followup" },
    ])
    const cold = JSON.parse(JSON.stringify(f.session)) as typeof f.session
    expect(cold.events.filter((event) => event.type === "reasoning")).toEqual(canonical)
    expect(deriveMessages(cold)).toEqual(deriveMessages(f.session))
  } finally {
    release.resolve()
    await run.catch(() => undefined)
    await server.close()
  }
})

it("keeps Responses summary deltas in one block and resends the opaque reasoning item with its tool call", async () => {
  const opaque = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "opaque-encrypted" }
  const server = await createLoopbackProvider("/v1/responses", [
    async (response) => writeSplitSse(response, [
      { type: "response.reasoning_summary_text.delta", item_id: "rs_fixture", summary_index: 0, delta: "" },
      ...[..."Check files 🔎"].map((delta) => ({ type: "response.reasoning_summary_text.delta", item_id: "rs_fixture", summary_index: 0, delta })),
      { type: "response.output_item.done", output_index: 0, item: opaque },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_fixture", call_id: "responses-read", name: "read", arguments: "{}" } },
      { type: "response.completed" },
    ]),
    async (response) => writeSplitSse(response, [
      { type: "response.reasoning_summary_text.delta", item_id: "rs_second", summary_index: 0, delta: "Use " },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_second", summary_index: 0, delta: "result" },
      { type: "response.output_text.delta", item_id: "answer", output_index: 1, delta: "Done." },
      { type: "response.completed" },
    ]),
  ])
  const f = setup(createOpenAIClient({ apiKey: "local-fixture", baseUrl: server.baseUrl, model: "responses-fixture" }))
  try {
    expect((await f.agent.run("Human prompt")).finalText).toBe("Done.")
    expect(server.errors).toEqual([])
    expect(server.requests).toHaveLength(2)
    const canonical = f.session.events.filter((event) => event.type === "reasoning")
    expect(canonical.map((event) => event.text)).toEqual(["Check files 🔎", "Use result"])
    expect(canonical.map((event) => event.blockId)).toEqual(["rs_fixture:0", "rs_second:0"])
    expect(new Set(canonical.map((event) => event.streamId)).size).toBe(2)
    expect(f.session.events.some((event) => event.type === "reasoning/chunk")).toBe(false)
    expect(server.requests[1]!.body.input).toEqual([
      { role: "user", content: "Human prompt" }, opaque,
      { type: "function_call", call_id: "responses-read", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "responses-read", output: "\"fixture contents\"" },
    ])
  } finally { await server.close() }
})
