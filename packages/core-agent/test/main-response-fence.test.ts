import { afterEach, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, deriveMessages } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createOpenAIClient } from "../../llm-openai/src/index.ts"
import { createOpenAICompatibleClient } from "../../llm-openai-compatible/src/index.ts"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"
import { createGeminiClient } from "../../llm-gemini/src/index.ts"
import { createBedrockClient, type BedrockRuntimeFace } from "../../llm-bedrock/src/index.ts"
import { createAgent } from "../src/index.ts"

afterEach(() => vi.unstubAllGlobals())
const response = (events: object[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })

it.each(["responses", "chat", "anthropic", "gemini", "bedrock"] as const)("%s native length/refusal mappings fence complete-looking calls and preserve prior effects", async protocol => {
  for (const refused of [false, true]) {
    const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
    let effects = 0, main = 0
    tools.register({ name: "write", description: "controlled effect", inputSchema: { type: "object" }, execute: async () => { effects++; return "prior effect" } })
    const id = "unexecuted"
    let events: object[]
    if (protocol === "responses") events = [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "item", call_id: id, name: "write", arguments: "" } },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: "item", name: "write", arguments: "{}" },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "item", call_id: id, name: "write", arguments: "{}" } },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: refused ? "content_filter" : "max_output_tokens" } } },
    ]
    else if (protocol === "chat") events = [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: "write", arguments: "{}" } }] }, finish_reason: refused ? "content_filter" : "length" }] }]
    else if (protocol === "anthropic") events = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "write", input: {} } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: refused ? "refusal" : "max_tokens" } }, { type: "message_stop" },
    ]
    else if (protocol === "gemini") events = [{ candidates: [{ content: { parts: [{ functionCall: { id, name: "write", args: {} } }] }, finishReason: refused ? "SAFETY" : "MAX_TOKENS" }] }]
    else events = [
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: id, name: "write" } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "{}" } } } },
      { contentBlockStop: { contentBlockIndex: 0 } }, { messageStop: { stopReason: refused ? "guardrail_intervened" : "max_tokens" } },
    ]
    vi.stubGlobal("fetch", async () => { main++; return response(events) })
    const config = { model: "fixture", apiKey: "controlled" }
    const model = protocol === "responses" ? createOpenAIClient(config) : protocol === "chat" ? createOpenAICompatibleClient(config) : protocol === "anthropic" ? createAnthropicClient(config) : protocol === "gemini" ? createGeminiClient(config)
      : createBedrockClient({ model: "fixture" }, { async send() { main++; return { stream: events } }, destroy() {} } as unknown as BedrockRuntimeFace)
    // Prior successful physical steps use the ordinary tool owner.
    await createAgent(ctx, { session, tools, systemPrompt: "", model: { async *stream() { if (!effects) yield { type: "tool_call", call: { id: "prior", name: "write", args: {} } }; else yield { type: "text/chunk", text: "prior answer" }; yield { type: "end" } } } }).run("prior task")
    await expect(createAgent(ctx, { session, sessionId: "owned", tools, model, systemPrompt: "" }).followup("continue")).rejects.toMatchObject({ code: refused ? "MODEL_REFUSED" : "MODEL_OUTPUT_TRUNCATED" })
    expect(main).toBe(1); expect(effects).toBe(1)
    expect(session.events.filter(event => event.type === "tool/call")).toHaveLength(2)
    expect(session.events.filter(event => event.type === "tool/dispatch")).toHaveLength(1)
    expect(session.events.filter(event => event.type === "tool/result").at(-1)).toMatchObject({ isError: true, output: { code: "TOOL_ABORTED_BEFORE_DISPATCH" } })
    expect(session.events.filter(event => event.type === "step/end").at(-1)).toMatchObject(refused ? { refused: true } : { truncated: true })
    expect(session.events.some(event => event.type === "context/usage" || event.type === "context/recovery")).toBe(false)
    expect(JSON.stringify(deriveMessages(session))).toContain("prior effect")
  }
})
