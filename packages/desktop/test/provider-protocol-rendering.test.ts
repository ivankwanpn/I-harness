import { expect, it, vi } from "vitest"
import { createContext } from "../../core-plugin/src/index.ts"
import { createSession, deriveMessages, Inbox, subscribe, type Session, type SessionEvent } from "../../core-session/src/index.ts"
import { createToolRegistry } from "../../core-tools/src/index.ts"
import type { LLMStreamEvent, ModelClient } from "../../llm-seam/src/index.ts"
import { createAgent } from "../../core-agent/src/index.ts"
import { createOpenAICompatibleClient } from "../../llm-openai-compatible/src/index.ts"
import { createOpenAIClient } from "../../llm-openai/src/index.ts"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"
import { createGeminiClient } from "../../llm-gemini/src/index.ts"
import { createBedrockClient, type BedrockRuntimeFace } from "../../llm-bedrock/src/index.ts"
import { createLoopbackProvider, deferred, writeSplitSse, type ProviderEvent } from "../../core-agent/test/helpers/provider-loopback.ts"
import { applyHistory, applyNotification, emptyEventWindow, timelineEvents } from "../src/renderer/session/event-window.ts"
import { projectHistoryTimeline, projectTimeline, type TimelineRow, type WireEvent } from "../src/renderer/session/project.ts"
import { groupActivities } from "../src/renderer/session/activity-groups.ts"
import { workStages, type WorkItem } from "../src/renderer/session/work-stages.ts"

type Protocol = "openai-completions" | "openai-responses" | "anthropic-messages" | "gemini" | "bedrock"
const protocols: Protocol[] = ["openai-completions", "openai-responses", "anthropic-messages", "gemini", "bedrock"]
const FIRST = "Inspect 工具 🔎", SECOND = "Choose read", THIRD = "Use result"
const COMMENTARY = "Checking tools.", FINAL = "Done.", FOLLOWUP = "Followup done."
const HUMAN = '<task id="human"><task_error>literal human XML</task_error></task>'
const NOTICE = '<task id="child" state="completed"><task_result>fixture ready</task_result></task>'
const CALL = "fixture-read", ARGS = { path: "fixture.txt" }, RESULT = { contents: "fixture contents" }
const RESULT_JSON = '{"contents":"fixture contents"}'
const presentation = { description: "Fixture child result", scope: "turn" as const,
  display: { kind: "task" as const, title: "Child completed: Inspect", body: "Fixture is ready" } }

interface Frames { prefix: ProviderEvent[]; rest: ProviderEvent[]; final: ProviderEvent[]; empty: ProviderEvent[] }
interface Fixture {
  client: ModelClient
  release(): void
  close(): Promise<void>
  requests: Record<string, unknown>[]
  errors: unknown[]
}
const chat = (delta: Record<string, unknown>, finish_reason?: string): ProviderEvent => ({ choices: [{ delta, ...(finish_reason ? { finish_reason } : {}) }] })
const gem = (part: Record<string, unknown>): ProviderEvent => ({ candidates: [{ content: { parts: [part] } }] })
const gemEnd: ProviderEvent = { candidates: [{ finishReason: "STOP", content: { parts: [] } }] }
const start = (index: number, content_block: Record<string, unknown>): ProviderEvent => ({ type: "content_block_start", index, content_block })
const delta = (index: number, value: Record<string, unknown>): ProviderEvent => ({ type: "content_block_delta", index, delta: value })
const stop = (index: number): ProviderEvent => ({ type: "content_block_stop", index })
const thought = (index: number, thinking: string): ProviderEvent => delta(index, { type: "thinking_delta", thinking })
const signature = (index: number, value: string): ProviderEvent => delta(index, { type: "signature_delta", signature: value })
const anthEnd = (stop_reason: string): ProviderEvent[] => [{ type: "message_delta", delta: { stop_reason } }, { type: "message_stop" }]
const anthText = (index: number, text: string): ProviderEvent[] => [start(index, { type: "text", text: "" }), delta(index, { type: "text_delta", text }), stop(index)]
const opaque = (id: string): ProviderEvent => ({ type: "reasoning", id, summary: [], encrypted_content: `opaque-${id}` })
const summary = (item_id: string, value: string): ProviderEvent => ({ type: "response.reasoning_summary_text.delta", item_id, summary_index: 0, delta: value })
const itemDone = (output_index: number, item: ProviderEvent): ProviderEvent => ({ type: "response.output_item.done", output_index, item })
const responseText = (output_index: number, text: string, phase: string): ProviderEvent[] => [
  { type: "response.output_text.delta", output_index, item_id: `message-${output_index}`, delta: text },
  itemDone(output_index, { type: "message", role: "assistant", phase, content: [{ type: "output_text", text }] }),
]

function httpFrames(protocol: Exclude<Protocol, "bedrock">): Frames {
  if (protocol === "openai-completions") return {
    prefix: [chat({ reasoning_content: "" }), chat({ reasoning_content: "Inspect " }), chat({ reasoning_content: "工具 🔎" })],
    rest: [chat({ content: COMMENTARY }), chat({ reasoning_content: "Choose " }), chat({ reasoning_content: "read" }),
      chat({ tool_calls: [{ index: 0, id: CALL, function: { name: "read", arguments: '{"path":' } }] }),
      chat({ tool_calls: [{ index: 0, function: { arguments: '"fixture.txt"}' } }] }, "tool_calls")],
    final: [chat({ reasoning_content: "Use " }), chat({ reasoning_content: "result" }), chat({ content: FINAL }, "stop")],
    empty: [chat({ reasoning_content: "" }), chat({ content: FOLLOWUP }, "stop")],
  }
  if (protocol === "openai-responses") return {
    prefix: [summary("rs_empty", ""), itemDone(0, opaque("rs_empty")), summary("rs_first", "Inspect "), summary("rs_first", "工具 🔎")],
    rest: [itemDone(1, opaque("rs_first")), ...responseText(2, COMMENTARY, "commentary"),
      summary("rs_second", "Choose "), summary("rs_second", "read"), itemDone(3, opaque("rs_second")),
      { type: "response.output_item.added", output_index: 4, item: { type: "function_call", id: "fc_fixture", call_id: CALL, name: "read", arguments: '{"path":"fixture.txt"}' } },
      { type: "response.completed" }],
    final: [summary("rs_after", "Use "), summary("rs_after", "result"), itemDone(0, opaque("rs_after")), ...responseText(1, FINAL, "final_answer"), { type: "response.completed" }],
    empty: [summary("rs_followup_empty", ""), itemDone(0, opaque("rs_followup_empty")), ...responseText(1, FOLLOWUP, "final_answer"), { type: "response.completed" }],
  }
  if (protocol === "anthropic-messages") return {
    prefix: [{ type: "message_start", message: {} }, start(0, { type: "thinking", thinking: "" }), signature(0, "anth-empty"), stop(0),
      start(1, { type: "thinking", thinking: "" }), thought(1, "Inspect "), thought(1, "工具 🔎")],
    rest: [signature(1, "anth-"), signature(1, "first"), stop(1), start(2, { type: "redacted_thinking", data: "opaque-redacted" }), stop(2),
      ...anthText(3, COMMENTARY), start(4, { type: "thinking", thinking: "" }), thought(4, "Choose "), thought(4, "read"), signature(4, "anth-second"), stop(4),
      start(5, { type: "tool_use", id: CALL, name: "read", input: {} }), delta(5, { type: "input_json_delta", partial_json: '{"path":' }),
      delta(5, { type: "input_json_delta", partial_json: '"fixture.txt"}' }), stop(5), ...anthEnd("tool_use")],
    final: [start(0, { type: "thinking", thinking: "" }), thought(0, "Use "), thought(0, "result"), signature(0, "anth-after"), stop(0), ...anthText(1, FINAL), ...anthEnd("end_turn")],
    empty: [start(0, { type: "thinking", thinking: "" }), signature(0, "anth-followup-empty"), stop(0), ...anthText(1, FOLLOWUP), ...anthEnd("end_turn")],
  }
  return {
    prefix: [gem({ thought: true, text: "", thoughtSignature: "gem-empty" }), gem({ thought: true, text: "Inspect " }), gem({ thought: true, text: "工具 🔎" })],
    rest: [gem({ thought: true, text: "", thoughtSignature: "gem-first" }), gem({ text: COMMENTARY, thoughtSignature: "gem-text" }),
      gem({ thought: true, text: "Choose " }), gem({ thought: true, text: "read", thoughtSignature: "gem-second" }),
      gem({ functionCall: { id: CALL, name: "read", args: ARGS }, thoughtSignature: "gem-call" }), gemEnd],
    final: [gem({ thought: true, text: "Use " }), gem({ thought: true, text: "result", thoughtSignature: "gem-after" }), gem({ text: FINAL, thoughtSignature: "gem-final" }), gemEnd],
    empty: [gem({ thought: true, text: "", thoughtSignature: "gem-followup-empty" }), gem({ text: FOLLOWUP, thoughtSignature: "gem-followup" }), gemEnd],
  }
}

async function httpFixture(protocol: Exclude<Protocol, "bedrock">): Promise<Fixture> {
  const release = deferred(), frames = httpFrames(protocol)
  const paths = { "openai-completions": "/v1/chat/completions", "openai-responses": "/v1/responses", "anthropic-messages": "/v1/messages", gemini: "/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse" }
  const server = await createLoopbackProvider(paths[protocol], [
    async (response) => { await writeSplitSse(response, frames.prefix); await release.promise; await writeSplitSse(response, frames.rest) },
    async (response) => writeSplitSse(response, frames.final),
    async (response) => writeSplitSse(response, frames.empty),
  ])
  const config = { apiKey: "local-fixture", baseUrl: server.baseUrl, model: protocol === "gemini" ? "gemini-fixture" : "fixture-model" }
  const client = protocol === "openai-completions" ? createOpenAICompatibleClient(config)
    : protocol === "openai-responses" ? createOpenAIClient(config)
      : protocol === "anthropic-messages" ? createAnthropicClient(config) : createGeminiClient(config)
  return { client, release: release.resolve, close: server.close, get requests() { return server.requests.map((request) => request.body) }, errors: server.errors }
}

const bedDelta = (contentBlockIndex: number, value: Record<string, unknown>): ProviderEvent => ({ contentBlockDelta: { contentBlockIndex, delta: value } })
const bedReason = (index: number, value: Record<string, unknown>): ProviderEvent => bedDelta(index, { reasoningContent: value })
const bedStop = (contentBlockIndex: number): ProviderEvent => ({ contentBlockStop: { contentBlockIndex } })
function bedrockFixture(): Fixture {
  const release = deferred(), requests: Record<string, unknown>[] = []
  const frames: Frames = {
    prefix: [bedReason(0, { text: "" }), bedReason(0, { signature: "bed-empty" }), bedStop(0), bedReason(1, { text: "Inspect " }), bedReason(1, { text: "工具 🔎" })],
    rest: [bedReason(1, { signature: "bed-" }), bedReason(1, { signature: "first" }), bedStop(1),
      bedReason(2, { redactedContent: Uint8Array.from([1, 2]) }), bedReason(2, { redactedContent: Uint8Array.from([3, 4]) }), bedStop(2),
      bedDelta(3, { text: COMMENTARY }), bedStop(3), bedReason(4, { text: "Choose " }), bedReason(4, { text: "read" }), bedReason(4, { signature: "bed-second" }), bedStop(4),
      { contentBlockStart: { contentBlockIndex: 5, start: { toolUse: { toolUseId: CALL, name: "read" } } } },
      bedDelta(5, { toolUse: { input: '{"path":' } }), bedDelta(5, { toolUse: { input: '"fixture.txt"}' } }), bedStop(5), { messageStop: { stopReason: "tool_use" } }],
    final: [bedReason(0, { text: "Use " }), bedReason(0, { text: "result" }), bedReason(0, { signature: "bed-after" }), bedStop(0), bedDelta(1, { text: FINAL }), bedStop(1), { messageStop: { stopReason: "end_turn" } }],
    empty: [bedReason(0, { text: "" }), bedReason(0, { signature: "bed-followup-empty" }), bedStop(0), bedDelta(1, { text: FOLLOWUP }), bedStop(1), { messageStop: { stopReason: "end_turn" } }],
  }
  // Only this documented SDK transport face is injected. The production
  // adapter still constructs ConverseStreamCommand and normalizes SDK events;
  // no BedrockRuntimeClient or ambient credential chain is constructed.
  const runtime = { async send(command: { input: Record<string, unknown> }) {
    const round = requests.length
    requests.push(command.input)
    if (round > 2) throw new Error("unexpected Bedrock fixture round")
    return { $metadata: {}, stream: (async function* () {
      if (round === 0) { for (const event of frames.prefix) yield event; await release.promise; for (const event of frames.rest) yield event }
      else for (const event of round === 1 ? frames.final : frames.empty) yield event
    })() }
  }, destroy() {} } as unknown as BedrockRuntimeFace
  return { client: createBedrockClient({ model: "anthropic.claude-sonnet-4-5", region: "fixture-region" }, runtime),
    release: release.resolve, close: async () => { release.resolve() }, requests, errors: [] }
}

function expectReplay(protocol: Protocol, request: Record<string, unknown>) {
  if (protocol === "openai-completions") expect(request.messages).toEqual([
    { role: "system", content: "Fixture system" }, { role: "user", content: HUMAN }, { role: "user", content: NOTICE },
    { role: "assistant", content: COMMENTARY, reasoning_content: "Inspect 工具 🔎Choose read", tool_calls: [{ id: CALL, type: "function", function: { name: "read", arguments: '{"path":"fixture.txt"}' } }] },
    { role: "tool", tool_call_id: CALL, content: RESULT_JSON },
  ])
  else if (protocol === "openai-responses") expect(request.input).toEqual([
    { role: "user", content: HUMAN }, { role: "user", content: NOTICE },
    { type: "reasoning", id: "rs_empty", summary: [], encrypted_content: "opaque-rs_empty" },
    { type: "reasoning", id: "rs_first", summary: [], encrypted_content: "opaque-rs_first" },
    { role: "assistant", content: COMMENTARY, phase: "commentary" },
    { type: "reasoning", id: "rs_second", summary: [], encrypted_content: "opaque-rs_second" },
    { type: "function_call", call_id: CALL, name: "read", arguments: '{"path":"fixture.txt"}' },
    { type: "function_call_output", call_id: CALL, output: RESULT_JSON },
  ])
  else if (protocol === "anthropic-messages") expect(request.messages).toEqual([
    { role: "user", content: HUMAN }, { role: "user", content: NOTICE }, { role: "assistant", content: [
      { type: "thinking", thinking: "", signature: "anth-empty" }, { type: "thinking", thinking: FIRST, signature: "anth-first" },
      { type: "redacted_thinking", data: "opaque-redacted" }, { type: "text", text: COMMENTARY },
      { type: "thinking", thinking: SECOND, signature: "anth-second" }, { type: "tool_use", id: CALL, name: "read", input: ARGS },
    ] }, { role: "user", content: [{ type: "tool_result", tool_use_id: CALL, content: RESULT_JSON }] },
  ])
  else if (protocol === "gemini") expect(request.contents).toEqual([
    { role: "user", parts: [{ text: HUMAN }] }, { role: "user", parts: [{ text: NOTICE }] }, { role: "model", parts: [
      { text: "", thought: true, thoughtSignature: "gem-empty" }, { text: FIRST, thought: true, thoughtSignature: "gem-first" },
      { text: COMMENTARY, thoughtSignature: "gem-text" }, { text: SECOND, thought: true, thoughtSignature: "gem-second" },
      { functionCall: { id: CALL, name: "read", args: ARGS }, thoughtSignature: "gem-call" },
    ] }, { role: "user", parts: [{ functionResponse: { id: CALL, name: "read", response: RESULT } }] },
  ])
  else expect(request.messages).toEqual([
    { role: "user", content: [{ text: HUMAN }] }, { role: "user", content: [{ text: NOTICE }] }, { role: "assistant", content: [
      { reasoningContent: { reasoningText: { text: "", signature: "bed-empty" } } },
      { reasoningContent: { reasoningText: { text: FIRST, signature: "bed-first" } } },
      { reasoningContent: { redactedContent: Buffer.from([1, 2, 3, 4]) } }, { text: COMMENTARY },
      { reasoningContent: { reasoningText: { text: SECOND, signature: "bed-second" } } },
      { toolUse: { toolUseId: CALL, name: "read", input: ARGS } },
    ] }, { role: "user", content: [{ toolResult: { toolUseId: CALL, content: [{ json: RESULT }] } }] },
  ])
}

function setup(model: ModelClient, session: Session = createSession()) {
  const ctx = createContext(), inbox = new Inbox(session), tools = createToolRegistry(ctx)
  tools.register({ name: "read", description: "Read in-memory fixture", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, isReadOnly: true, execute: async () => RESULT })
  const seen: SessionEvent[] = []
  let window = emptyEventWindow()
  subscribe(session, (event) => { seen.push(event); window = applyNotification(window, event as WireEvent) })
  return { session, inbox, seen, get window() { return window }, agent: createAgent(ctx, { session, tools, model, systemPrompt: "Fixture system", stepInputs: inbox }) }
}
function content(row: WorkItem): string {
  if (row.kind === "work-stage") return "work"
  if (row.kind === "message") return `${row.role}:${row.text}`
  if (row.kind === "tool") return `tool:${row.name}`
  if (row.kind === "other") return `${row.label}:${row.detail}`
  return row.kind
}
function withoutHistoryRefs(rows: TimelineRow[]) { return rows.map(({ seqs: _seqs, ...row }) => row) }

it.each(protocols)("%s preserves live reasoning, canonical replay, Work Process and opaque continuation", async (protocol) => {
  const fixture = protocol === "bedrock" ? bedrockFixture() : await httpFixture(protocol)
  const raw: LLMStreamEvent[] = []
  const model: ModelClient = { async *stream(request) { for await (const event of fixture.client.stream(request)) { raw.push(event); yield event } } }
  const f = setup(model)
  f.inbox.admit({ inputId: "background-1", text: NOTICE, delivery: "steer", intent: "system", synthetic: presentation })
  const run = f.agent.run(HUMAN)
  void run.catch(() => undefined)
  try {
    await vi.waitFor(() => expect(f.seen.filter((event) => event.type === "reasoning/chunk")).toHaveLength(2), { timeout: 2_000, interval: 10 })
    const prefix = f.seen.filter((event) => event.type === "reasoning/chunk")
    expect(prefix).toMatchObject([{ text: "Inspect ", offset: 0 }, { text: "工具 🔎", offset: 8 }])
    expect(prefix[1]!.streamId).toBe(prefix[0]!.streamId)
    const firstId = `reasoning:${prefix[0]!.streamId}`
    expect(projectTimeline(timelineEvents(f.window)).filter((row) => row.kind === "other" && row.label === "reasoning")).toMatchObject([{ id: firstId, detail: FIRST, transient: true }])
    expect(f.session.events.filter((event) => event.type === "reasoning")).toEqual([])
    fixture.release()
    expect((await run).finalText).toBe(FINAL)
    expect(fixture.errors).toEqual([])
    expect(fixture.requests).toHaveLength(2)
    expectReplay(protocol, fixture.requests[1]!)

    const canonical = f.session.events.filter((event) => event.type === "reasoning")
    expect(canonical.map((event) => event.text)).toEqual([FIRST, SECOND, THIRD])
    expect(new Set(canonical.map((event) => event.streamId)).size).toBe(3)
    expect(canonical[0]!.streamId).toBe(prefix[0]!.streamId)
    const blockIds = { "openai-completions": [undefined, undefined, undefined], "openai-responses": ["rs_first:0", "rs_second:0", "rs_after:0"], "anthropic-messages": ["1", "4", "0"], gemini: ["1", "2", "0"], bedrock: ["1", "4", "0"] }
    expect(canonical.map((event) => event.blockId)).toEqual(blockIds[protocol])
    expect(f.session.events.some((event) => event.type === "reasoning/chunk")).toBe(false)
    expect(f.seen.filter((event) => event.type === "reasoning/chunk").every((event) => event.text !== "" && event.seq === undefined)).toBe(true)
    expect(raw.filter((event): event is Extract<LLMStreamEvent, { type: "reasoning" }> => event.type === "reasoning" && event.text !== "").map((event) => event.text)).toEqual(["Inspect ", "工具 🔎", "Choose ", "read", "Use ", "result"])

    const user = f.session.events.find((event) => event.type === "user/message" && event.text === HUMAN)!
    const machine = f.session.events.find((event) => event.type === "user/message" && event.text === NOTICE)!
    expect(user).not.toHaveProperty("input")
    expect(machine).toMatchObject({ input: { inputId: "background-1", intent: "system", synthetic: presentation } })
    const live = projectTimeline(timelineEvents(f.window))
    expect(live.find((row) => row.id === firstId)).toMatchObject({ detail: FIRST })
    expect(live.filter((row) => row.id === firstId)).toHaveLength(1)
    expect(live.find((row) => row.id === `message:${user.seq}`)).toMatchObject({ kind: "message", role: "user", text: HUMAN })
    expect(live.find((row) => row.id === `message:${machine.seq}`)).toMatchObject({ kind: "other", label: "agent/input/system", title: "Child completed: Inspect", detail: "Fixture is ready" })
    const stageId = `work:${live[0]!.turn!.id}`
    const collapsed = workStages(groupActivities(live), new Map())
    expect(collapsed.map((row) => row.kind)).toEqual(["message", "work-stage", "message"])
    expect(collapsed[1]).toMatchObject({ id: stageId, count: 6, active: false })
    expect(content(collapsed[2]!)).toBe(`assistant:${FINAL}`)
    // Core currently persists accumulated commentary after the streamed tool
    // call. Preserve that actual durable order rather than inventing UI order.
    expect(workStages(groupActivities(live), new Map([[stageId, true]])).map(content)).toEqual([
      `user:${HUMAN}`, "work", "agent/input/system:Fixture is ready", `reasoning:${FIRST}`, `reasoning:${SECOND}`,
      "tool:read", `assistant:${COMMENTARY}`, `reasoning:${THIRD}`, `assistant:${FINAL}`,
    ])

    const cold = JSON.parse(JSON.stringify(f.session)) as Session
    expect(deriveMessages(cold)).toEqual(deriveMessages(f.session))
    expect(withoutHistoryRefs(projectHistoryTimeline(cold.events as WireEvent[]))).toEqual(live)
    let replay = applyHistory(f.window, { events: cold.events as WireEvent[], nextSeq: cold.events.length })
    for (const chunk of prefix) replay = applyNotification(replay, chunk as WireEvent)
    replay = applyHistory(replay, { events: cold.events as WireEvent[], nextSeq: cold.events.length })
    expect(projectTimeline(timelineEvents(replay))).toEqual(live)
    expect(new Set(live.map((row) => row.id)).size).toBe(live.length)

    // Resume an actual agent from the JSON log to exercise the adapters again.
    // The third transport round has a signed/native empty thought but no
    // visible thought, which must not produce a fourth reasoning row.
    const resumed = setup(model, cold)
    expect((await resumed.agent.run("Followup")).finalText).toBe(FOLLOWUP)
    expect(fixture.requests).toHaveLength(3)
    expect(fixture.errors).toEqual([])
    expect(cold.events.filter((event) => event.type === "reasoning").map((event) => event.text)).toEqual([FIRST, SECOND, THIRD])
    expect(projectHistoryTimeline(cold.events as WireEvent[]).filter((row) => row.kind === "other" && row.label === "reasoning")).toHaveLength(3)
    expect(cold.events.find((event) => event.type === "user/message" && event.text === NOTICE)).toMatchObject({ input: { synthetic: presentation } })
    expect(deriveMessages(cold).filter((message) => message.role === "user").map((message) => message.content)).toEqual([HUMAN, NOTICE, "Followup"])
  } finally { fixture.release(); await run.catch(() => undefined); await fixture.close() }
})
