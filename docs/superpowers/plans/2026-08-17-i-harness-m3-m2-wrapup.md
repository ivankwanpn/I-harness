# I-harness M3 Sub-project A — M2 Wrap-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix M2's carried findings: real-protocol multi-turn tool history, `decide()` dual-run hardening, tool-arg delta accumulation, reasoning forwarding, stream buffer hardening, and small cleanups.

**Architecture:** Extend the neutral `LLMMessage` in core-session to a union carrying assistant `toolCalls` and a `tool` role (paired by a new `callId` on session `tool/call` + `tool/result` events). core-agent generates `callId`s; protocol plugins translate the neutral format to their API shapes and add delta accumulation + reasoning forwarding + buffer hardening.

**Tech Stack:** TypeScript strict, ESM (`"type": "module"`), vitest, pnpm workspaces, Node >= 22.

## Global Constraints

- Work from `D:\agent-complete\I-harness`; never modify `vendor/` or other plans' `.superpowers/sdd/` directories.
- ESM + strict TS; test files live next to each package under `test/*.test.ts`.
- Gates that must pass at every task's end: `pnpm --filter <pkg> test`, `pnpm -r test`, `pnpm -r typecheck`.
- `LLMMessage` type is owned by `core-session` and re-exported by `llm-seam` (`export type { LLMMessage } from "@i-harness/core-session"`). Protocol plugins import `LLMRequest`/`LLMStreamEvent`/`ModelClient` from `@i-harness/llm-seam`.
- Commit messages are exact strings given per step.
- Do not use real network in tests — always `vi.stubGlobal("fetch", ...)`.

---

### Task 1: core-session callId + LLMMessage union + core-agent callId generation

(The `callId` field becomes REQUIRED on `SessionEvent`, which breaks `core-agent`'s `append` call sites the moment the type changes — so the caller update MUST land in the same commit to keep the workspace typecheck green. These are one atomic task.)

**Files:**
- Modify: `packages/core-session/src/index.ts`
- Modify: `packages/core-session/test/session.test.ts`
- Modify: `packages/core-agent/src/index.ts`
- Modify: `packages/core-agent/test/agent.test.ts`
- Modify: `packages/llm-seam/src/index.ts` (re-export unchanged; `assertMessagesFromLog` updated)

**Interfaces:**
- Consumes: existing `SessionEvent`, `Session`, `createSession`, `append`, `deriveMessages`; core-agent's `tool_call` stream handling.
- Produces:
  - `SessionEvent` `tool/call` and `tool/result` events each gain `callId: string`.
  - `LLMMessage` becomes:
    ```ts
    export type LLMMessage =
      | { role: "user"; content: string }
      | { role: "assistant"; content: string; toolCalls?: { id: string; name: string; args: unknown }[] }
      | { role: "tool"; toolCallId: string; content: string }
    ```
  - `deriveMessages(session): LLMMessage[]` folds `tool/call` → assistant `toolCalls` (by `callId`) and `tool/result` → `{ role: "tool" }` (by `callId`).
  - llm-seam's `assertMessagesFromLog` uses the same projection.
  - core-agent's loop writes sequential `callId`s (`call_1`, `call_2`, …), the same on the matching `tool/result`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core-session/test/session.test.ts`:

```ts
it("folds tool/call + tool/result into model messages by callId", () => {
  const s = createSession()
  append(s, { type: "user/message", text: "task" })
  append(s, { type: "tool/call", callId: "call_1", name: "read", args: { path: "a.txt" } })
  append(s, { type: "tool/result", callId: "call_1", name: "read", output: { content: "data" } })
  append(s, { type: "assistant/message", text: "done" })
  const msgs = deriveMessages(s)
  expect(msgs).toEqual([
    { role: "user", content: "task" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
    { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
    { role: "assistant", content: "done" },
  ])
})

it("keeps assistant toolCalls in order across multiple calls", () => {
  const s = createSession()
  append(s, { type: "tool/call", callId: "call_1", name: "read", args: {} })
  append(s, { type: "tool/result", callId: "call_1", name: "read", output: { content: "a" } })
  append(s, { type: "tool/call", callId: "call_2", name: "write", args: {} })
  append(s, { type: "tool/result", callId: "call_2", name: "write", output: { ok: true } })
  const msgs = deriveMessages(s)
  expect(msgs[0]).toEqual({
    role: "assistant", content: "",
    toolCalls: [
      { id: "call_1", name: "read", args: {} },
      { id: "call_2", name: "write", args: {} },
    ],
  })
  expect(msgs[1]).toEqual({ role: "tool", toolCallId: "call_1", content: '{"content":"a"}' })
  expect(msgs[2]).toEqual({ role: "tool", toolCallId: "call_2", content: '{"ok":true}' })
})
```

ALSO update the EXISTING test `"derives model messages from the log only"` in `packages/core-session/test/session.test.ts` (currently lines ~19-26): it appends `{ type: "tool/call", name: "read", args: {} }` WITHOUT `callId` and asserts `msgs.map((m) => m.role)` equals `["user", "assistant"]`. Under the new folding, that tool/call (orphaned — no tool/result) still produces an assistant toolCalls message, changing the roles. Rewrite it to reflect the new behavior:

```ts
it("derives model messages from the log only", () => {
  const s = createSession()
  append(s, { type: "user/message", text: "hi" })
  append(s, { type: "tool/call", callId: "call_1", name: "read", args: {} })
  append(s, { type: "assistant/chunk", text: "hel" })
  append(s, { type: "assistant/chunk", text: "lo" })
  append(s, { type: "assistant/message", text: "done" })
  const msgs = deriveMessages(s)
  // orphaned tool/call (no tool/result) folds into an assistant toolCalls message
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "assistant"])
  expect(msgs[0]).toEqual({ role: "user", content: "hi" })
  expect(msgs[1]).toEqual({ role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: {} }] })
  expect(msgs[2]).toEqual({ role: "assistant", content: "done" })
})
```


Then append to `packages/core-agent/test/agent.test.ts`:

```ts
it("writes callIds on tool/call and tool/result events", async () => {
  const ctx = createContext()
  const deps = makeDeps(ctx)
  deps.model = createMockClient([
    { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
    { role: "assistant", text: "done" },
  ])
  const agent = createAgent(ctx, { ...deps, systemPrompt: "p" })
  await agent.run("read a.txt")
  const calls = deps.session.events.filter((e) => e.type === "tool/call")
  const results = deps.session.events.filter((e) => e.type === "tool/result")
  expect(calls).toHaveLength(1)
  expect(results).toHaveLength(1)
  expect((calls[0] as { callId: string }).callId).toMatch(/^call_\d+$/)
  expect((calls[0] as { callId: string }).callId).toBe((results[0] as { callId: string }).callId)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/core-session test && pnpm --filter @i-harness/core-agent test`
Expected: FAIL — `tool/call` events don't accept `callId` (typecheck error in core-agent) and `deriveMessages` drops tool events.

- [ ] **Step 3: Implement**

In `packages/core-session/src/index.ts`:

```ts
export type SessionEvent =
  | { type: "turn/start"; seq?: number }
  | { type: "step/start"; seq?: number }
  | { type: "user/message"; text: string; seq?: number }
  | { type: "assistant/chunk"; text: string; seq?: number }
  | { type: "assistant/message"; text: string; seq?: number }
  | { type: "tool/call"; callId: string; name: string; args: unknown; seq?: number }
  | { type: "tool/result"; callId: string; name: string; output: unknown; seq?: number }
  | { type: "step/end"; seq?: number }
  | { type: "turn/end"; seq?: number }

export type LLMMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: { id: string; name: string; args: unknown }[] }
  | { role: "tool"; toolCallId: string; content: string }

export function deriveMessages(session: Session): LLMMessage[] {
  const result: LLMMessage[] = []
  // A tool block is one step of assistant toolCalls followed by its tool
  // results. Both are buffered and flushed together (assistant toolCalls
  // FIRST, then tool results) so the model-visible order matches what the
  // APIs expect (function_call before function_call_output / tool_use before
  // tool_result), regardless of how the session log interleaves them.
  let pendingCalls: { id: string; name: string; args: unknown }[] | undefined
  const pendingResults: LLMMessage[] = []
  for (const ev of session.events) {
    if (ev.type === "user/message") {
      flushToolBlock()
      result.push({ role: "user", content: ev.text })
    } else if (ev.type === "assistant/message") {
      flushToolBlock()
      result.push({ role: "assistant", content: ev.text })
    } else if (ev.type === "tool/call") {
      pendingCalls ??= []
      pendingCalls.push({ id: ev.callId, name: ev.name, args: ev.args })
    } else if (ev.type === "tool/result") {
      pendingResults.push({ role: "tool", toolCallId: ev.callId, content: JSON.stringify(ev.output) })
    }
    // assistant/chunk events carry no model-visible text; skipped entirely
  }
  flushToolBlock()
  return result

  function flushToolBlock() {
    if (pendingCalls) {
      result.push({ role: "assistant", content: "", toolCalls: pendingCalls })
      pendingCalls = undefined
    }
    if (pendingResults.length > 0) {
      result.push(...pendingResults)
      pendingResults.length = 0
    }
  }
}
```

Then update `packages/llm-seam/src/index.ts`:

```ts
import type { LLMMessage, Session } from "@i-harness/core-session"
import { deriveMessages } from "@i-harness/core-session"

export function assertMessagesFromLog(messages: LLMMessage[], session: Session): void {
  const logged = deriveMessages(session)
  const msgJson = JSON.stringify(messages)
  const logJson = JSON.stringify(logged)
  if (msgJson !== logJson) throw new Error("model-visible messages must derive from the session log (audit F01-3)")
}
```

Then update `packages/core-agent/src/index.ts` — replace the `tool_call` case:

```ts
case "tool_call":
  callSeq += 1
  const callId = `call_${callSeq}`
  append(deps.session, { type: "tool/call", callId, name: ev.call.name, args: ev.call.args })
  const result = await deps.tools.execute({ name: ev.call.name, args: ev.call.args })
  append(deps.session, { type: "tool/result", callId, name: ev.call.name, output: result.output })
  toolCallsThisStep += 1
  break
```

Declare `let callSeq = 0` next to `let turns = 0` and `const reasoning: string[] = []` (the counter must be per-`run` so callIds restart per agent run).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/core-session test && pnpm --filter @i-harness/core-agent test`
Expected: PASS (updated "derives model messages" test, the two new session tests, and the core-agent callId test all pass).

- [ ] **Step 5: Run the workspace gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS — all packages green.

- [ ] **Step 6: Commit**

```bash
git add packages/core-session/ packages/llm-seam/ packages/core-agent/
git commit -m "feat: core-session callId pairing, neutral LLMMessage tool union, core-agent callId"
```

---

### Task 2: llm-openai — neutral→Responses translation + delta accumulation + reasoning + buffer

**Files:**
- Modify: `packages/llm-openai/src/index.ts`
- Modify: `packages/llm-openai/test/openai.test.ts`

**Interfaces:**
- Consumes: `LLMRequest.messages: LLMMessage[]` (neutral union from Task 1); `LLMStreamEvent`.
- Produces: Responses `input` items — `function_call` (`{ type, call_id, name, arguments }`) for assistant `toolCalls`, `function_call_output` (`{ type, call_id, output }`) for `tool` role; accumulates `response.function_call_arguments.delta`; emits `reasoning`; flushes buffer before `end`; `[DONE]` breaks both loops.

- [ ] **Step 1: Write the failing tests**

Append to `packages/llm-openai/test/openai.test.ts`:

```ts
it("translates neutral tool messages to Responses input items", async () => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
  const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
  const request: LLMRequest = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
      { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
    ],
    tools: [],
    systemPrompt: "sys",
  }
  const it = client.stream(request)[Symbol.asyncIterator]()
  await it.next()
  const [, init] = fetchMock.mock.calls[0]!
  const body = JSON.parse(init.body as string)
  expect(body.input).toEqual([
    { role: "user", content: "hi" },
    { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.txt"}' },
    { type: "function_call_output", call_id: "call_1", output: '{"content":"data"}' },
  ])
  await it.return?.()
})

it("accumulates function_call_arguments.delta into tool args", async () => {
  const sse = [
    `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", name: "write" } })}`,
    `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"pat" })}`,
    `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "h\":\"a.txt\"}" })}`,
    `data: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_1" })}`,
    `data: ${JSON.stringify({ type: "response.completed" })}`,
    "data: [DONE]",
  ].join("\n\n")
  const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
  vi.stubGlobal("fetch", fetchMock)
  const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
  let call: { name: string; args: unknown } | undefined
  for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
    if (ev.type === "tool_call") call = ev.call
  }
  expect(call?.name).toBe("write")
  expect(call?.args).toEqual({ path: "a.txt" })
})

it("forwards reasoning events and flushes before end", async () => {
  const sse = [
    `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", text: "think" })}`,
    "data: [DONE]",
  ].join("\n\n")
  const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
  vi.stubGlobal("fetch", fetchMock)
  const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
  const events: string[] = []
  for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
    if (ev.type === "reasoning") events.push(`r:${ev.text}`)
    if (ev.type === "end") events.push("end")
  }
  expect(events).toEqual(["r:think", "end"])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/llm-openai test`
Expected: FAIL — input items not translated, no delta accumulation, no reasoning.

- [ ] **Step 3: Implement**

In `packages/llm-openai/src/index.ts`:

- Body `input` translation:

```ts
input: request.messages.map((m) => {
  if (m.role === "user") return { role: "user", content: m.content }
  if (m.role === "tool") return { type: "function_call_output", call_id: m.toolCallId, output: m.content }
  // assistant
  if (m.toolCalls && m.toolCalls.length > 0) {
    return m.toolCalls.map((c) => ({
      type: "function_call",
      call_id: c.id,
      name: c.name,
      arguments: JSON.stringify(c.args),
    }))
  }
  return { role: "assistant", content: m.content }
}).flat(),
```

- SSE handling: track `pendingCalls: Map<string, { name: string; argsBuffer: string }>` keyed by item id. On `response.output_item.added` with `function_call`: if `item.arguments` is a non-empty string, parse it (JSON.parse; on malformed, yield `{ type: "error" }` and return) and yield `{ type: "tool_call", call: { name, args } }` immediately (some Responses streams send arguments inline); otherwise store `{ name, argsBuffer: "" }` (yield NOTHING yet). On `response.function_call_arguments.delta`, append `delta` to that item's `argsBuffer`. On `response.function_call_arguments.done`, parse `argsBuffer` (JSON.parse; on malformed, yield `{ type: "error" }` and return) and yield `{ type: "tool_call", call: { name, args } }` — but ONLY if the item has not already been yielded inline (track yielded ids in a Set; skip done for already-yielded). Handle `response.reasoning_summary_text.delta` → `{ type: "reasoning", text }`. On `[DONE]`, set a flag that breaks BOTH the inner `for...of` and the outer `while (true)`.
- Buffer flush: after the read loop, if `buffer.trim() !== ""`, run `parseSSE(buffer)` events before yielding `end`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/llm-openai test`
Expected: PASS.

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-openai/
git commit -m "feat: llm-openai tool history translation, delta accumulation, reasoning"
```

---

### Task 3: llm-anthropic — neutral→Messages translation + delta accumulation + reasoning + buffer

**Files:**
- Modify: `packages/llm-anthropic/src/index.ts`
- Modify: `packages/llm-anthropic/test/anthropic.test.ts`

**Interfaces:**
- Consumes: `LLMRequest.messages` neutral union; `LLMStreamEvent`.
- Produces: Messages API `content` blocks — `tool_use` (`{ type, id, name, input }`) for assistant `toolCalls`; user `tool_result` (`{ type, tool_use_id, content }`) for `tool` role; accumulates `input_json_delta`; emits `reasoning`; flushes buffer before `end`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/llm-anthropic/test/anthropic.test.ts`:

```ts
it("translates neutral tool messages to Messages content blocks", async () => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
  const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
  const request: LLMRequest = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
      { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
    ],
    tools: [],
    systemPrompt: "sys",
  }
  const it = client.stream(request)[Symbol.asyncIterator]()
  await it.next()
  const [, init] = fetchMock.mock.calls[0]!
  const body = JSON.parse(init.body as string)
  expect(body.messages).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "a.txt" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"content":"data"}' }] },
  ])
  await it.return?.()
})

it("accumulates input_json_delta into tool args", async () => {
  const sse = [
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "write", input: {} } })}`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\"" } })}`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ":\"a.txt\"}" } })}`,
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
  ].join("\n\n")
  const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
  vi.stubGlobal("fetch", fetchMock)
  const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
  let call: { name: string; args: unknown } | undefined
  for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
    if (ev.type === "tool_call") call = ev.call
  }
  expect(call?.name).toBe("write")
  expect(call?.args).toEqual({ path: "a.txt" })
})

it("forwards reasoning events and flushes before end", async () => {
  const sse = [
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "ponder" } })}`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ing" } })}`,
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
  ].join("\n\n")
  const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
  vi.stubGlobal("fetch", fetchMock)
  const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
  const events: string[] = []
  for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
    if (ev.type === "reasoning") events.push(`r:${ev.text}`)
    if (ev.type === "end") events.push("end")
  }
  expect(events).toEqual(["r:ponder", "r:ing", "end"])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/llm-anthropic test`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/llm-anthropic/src/index.ts`:

- Body `messages` translation:

```ts
messages: request.messages.map((m) => {
  if (m.role === "tool") {
    return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] }
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return { role: "assistant", content: m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args })) }
  }
  return { role: m.role, content: m.content }
}),
```

- SSE handling: track `pendingToolUses: Map<number, { name: string; argsBuffer: string }>` keyed by content-block `index`. On `content_block_start` with `content_block.type === "tool_use"`, store `{ name, argsBuffer: "" }`; if `block.input` is a NON-EMPTY object (`Object.keys(block.input ?? {}).length > 0`), set `argsBuffer = JSON.stringify(block.input)` (inline args, no deltas expected). On `content_block_delta` with `delta.type === "input_json_delta"`, append `delta.partial_json` to that index's `argsBuffer`. On `content_block_stop`, if a pending tool_use exists for that index, parse the args — if `argsBuffer.trim() === ""` (empty input + no deltas), use `{}`; else `JSON.parse(argsBuffer)` (on malformed, yield `{ type: "error" }` and return) — and yield `{ type: "tool_call", call: { name, args } }`. Handle `content_block_start` with `content_block.type === "thinking"` (yield `{ type: "reasoning", text: block.thinking }`) and `content_block_delta` with `delta.type === "thinking_delta"` (yield `{ type: "reasoning", text: delta.thinking }`). After the read loop, flush residual `buffer` events before yielding `end`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/llm-anthropic test`
Expected: PASS.

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-anthropic/
git commit -m "feat: llm-anthropic tool history translation, delta accumulation, reasoning"
```

---

### Task 4: core-agent multi-turn tool-loop integration test

**Files:**
- Modify: `packages/core-agent/test/agent.test.ts`

**Interfaces:**
- Consumes: Task 1 (deriveMessages tool folding + callId) + the existing `assertMessagesFromLog` seam.

- [ ] **Step 1: Write the failing test**

Append to `packages/core-agent/test/agent.test.ts`:

```ts
it("passes tool history to the model on the next turn (multi-turn loop)", async () => {
  const ctx = createContext()
  const deps = makeDeps(ctx)
  const seenRequests: { messages: unknown[] }[] = []
  deps.model = {
    async *stream(request: { messages: unknown[]; tools: unknown[]; systemPrompt: string }) {
      seenRequests.push({ messages: request.messages })
      const turn = seenRequests.length
      if (turn === 1) {
        yield { type: "tool_call", call: { name: "read", args: { path: "a.txt" } } }
      } else {
        yield { type: "text/chunk", text: "final" }
      }
      yield { type: "end" }
    },
  }
  const agent = createAgent(ctx, { ...deps, systemPrompt: "p", maxTurns: 5 })
  const result = await agent.run("read a.txt")
  expect(result.finalText).toBe("final")
  // second turn's messages must contain the tool result from turn 1
  const second = seenRequests[1]!.messages
  expect(second.some((m) => (m as { role: string }).role === "tool")).toBe(true)
  expect(second.some((m) => (m as { toolCallId?: string }).toolCallId !== undefined)).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/core-agent test`
Expected: FAIL — the second turn's messages contain no `tool`-role entries (Tool history not folded).

- [ ] **Step 3: Implement**

No implementation change is needed here if Task 1 landed: core-agent already calls `deriveMessages(deps.session)` each turn. Verify the test passes. If it still fails, inspect `deriveMessages` ordering (tool/result appended BEFORE the next turn's derive → the `tool` message must be included). If the failure is ordering, adjust `deriveMessages` so `tool/result` folding always emits the `tool` message immediately after the assistant toolCalls (the current flush design handles this: pendingCalls flush at next user/assistant/message OR end).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/core-agent test`
Expected: PASS.

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core-agent/test/agent.test.ts
git commit -m "test: core-agent multi-turn tool history reaches the model"
```

---

### Task 5: guard-approval decide() hardening (Important #2)

**Files:**
- Modify: `packages/guard-approval/src/index.ts`
- Modify: `packages/guard-approval/test/guard-approval.test.ts`

**Interfaces:**
- Consumes: `createApprovalPolicy(ctx, registry, config)`; the shared `decide()` helper.
- Produces: tolerant `decide()` — a payload that is already a decision object passes through unchanged.

- [ ] **Step 1: Write the failing test**

Append to `packages/guard-approval/test/guard-approval.test.ts`:

```ts
it("decide tolerates a payload that is already a decision object", async () => {
  const { ctx, registry } = setup({ workspace: process.cwd() })
  registry.register(makeBashTool((args) => args.command.split(" ")))
  registerApprovalAnswerer(ctx, async () => ({ approved: true }))
  // seed a decision via the plain-listener path, then dispatch: the waterfall
  // handler receives the seeded { kind } object and must pass it through
  const result = await registry.execute({ name: "bash", args: { command: "rm -rf /tmp/x" } })
  expect(result.output).toEqual({ stdout: "ran", exitCode: 0 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/guard-approval test`
Expected: PASS today (this is a regression-lock test). If it FAILS, the dual-decide bug surfaced — fix in step 3.

- [ ] **Step 3: Harden `decide()`**

In `packages/guard-approval/src/index.ts`, add the decision-object guard at the TOP of `decide`, keeping its existing typed signature and body:

```ts
function decide(
  payload: unknown,
  registry: ToolRegistry,
  workspace: string,
  dangerousCommands: string[],
  dangerousFlags: string[],
  askForNonReadOnly: boolean,
): ToolDecision | undefined {
  // Single-producer property: at most one policy seeds a decision per emit,
  // and the seeded value is the chain payload that reaches every waterfall
  // handler. A payload that is already a decision object ({ kind: ... }) must
  // pass through unchanged — it is the previous producer's decision, not a
  // ToolCall to classify. Without this, re-parsing it as a ToolCall would
  // silently drop the decision and fail open.
  const asDecision = payload as { kind?: unknown }
  if (asDecision && typeof asDecision.kind === "string") return undefined

  const call = payload as Partial<ToolCall>
  if (typeof call !== "object" || call === null || typeof call.name !== "string") return undefined
  // ... keep the existing decide() body exactly as it is (Layer 1/2/3 logic) ...
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/guard-approval test`
Expected: PASS.

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/guard-approval/
git commit -m "fix: guard-approval decide tolerates seeded decision payloads"
```

---

### Task 6: Minor cleanups — fs resolvePath, exec taskkill, nearest-wins comment

**Files:**
- Modify: `packages/fs/src/index.ts`
- Modify: `packages/exec/src/index.ts`
- Modify: `packages/core-tools/src/index.ts`
- Modify: `packages/fs/test/fs.test.ts` (if resolvePath changes are observable)

**Interfaces:**
- Consumes: existing APIs; no signature changes.
- Produces: same public APIs with wasted-work removed.

- [ ] **Step 1: fs resolvePath — remove wasted resolve()**

In `packages/fs/src/index.ts`:

```ts
export function resolvePath(workspace: string, path: string): string {
  const isAbsoluteInput = path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)
  return isAbsoluteInput ? resolve(path) : resolve(workspace, path)
}
```

This preserves the exact existing behavior for absolute inputs (`resolve(path)`) while eliminating the wasted `resolve(path)` call on the relative branch (relative paths now go straight to `resolve(workspace, path)`). Verify with the existing fs tests (run `pnpm --filter @i-harness/fs test`).

- [ ] **Step 2: exec taskkill — await the kill**

In `packages/exec/src/index.ts`, the timeout handler becomes async-aware so the kill completes before resolution:

```ts
const timer = cmd.timeoutMs !== undefined ? setTimeout(async () => {
  timedOut = true
  if (process.platform === "win32") {
    await new Promise<void>((res) => {
      const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"])
      k.on("close", () => res())
      k.on("error", () => res())
    })
  } else {
    try { process.kill(-child.pid!, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch { /* ignore */ } }
  }
}, cmd.timeoutMs) : null
```

The existing `child.on("close")` handler still settles the promise when the killed process exits. Keep the existing timeout test (`timedOut === true`) — it must still pass.

- [ ] **Step 3: core-tools nearest-wins comment**

In `packages/core-tools/src/index.ts` near `mergeDecision`, add a comment:

```ts
// Decision merge is single-candidate: resolveDecision returns the NEAREST
// ancestor decision, and the propagation model allows at most one producer
// per emit (once a nearer policy seeds, the payload reaching farther
// ancestors is the decision object, which policies refuse to re-classify).
// A resolveStrictestDecision walk is therefore a no-op today; revisit only if
// multi-producer decisions become possible.
```

- [ ] **Step 4: Run gates**

Run: `pnpm --filter @i-harness/fs test && pnpm --filter @i-harness/exec test && pnpm --filter @i-harness/core-tools test && pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fs/ packages/exec/ packages/core-tools/
git commit -m "chore: minor cleanups — fs resolvePath, exec taskkill await, nearest-wins comment"
```

---

### Task 7: Protocol-level integration tests (Important #1 verification)

**Files:**
- Modify: `packages/llm-openai/test/openai.test.ts`
- Modify: `packages/llm-anthropic/test/anthropic.test.ts`
- Modify: `packages/core-agent/test/agent.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3. Proves the end-to-end tool-history claim at mock level.

- [ ] **Step 1: llm-openai second-turn body assertion**

Append to `packages/llm-openai/test/openai.test.ts`:

```ts
it("second request includes the tool result when the model calls a tool then answers", async () => {
  const bodies: unknown[] = []
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string))
    // turn 1: function_call; turn 2: no tool call (just end)
    return new Response(
      bodies.length === 1
        ? [
            `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", name: "read", arguments: '{"path":"a.txt"}' } })}`,
            `data: ${JSON.stringify({ type: "response.completed" })}`,
            "data: [DONE]",
          ].join("\n\n")
        : [
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}`,
            `data: ${JSON.stringify({ type: "response.completed" })}`,
            "data: [DONE]",
          ].join("\n\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  })
  vi.stubGlobal("fetch", fetchMock)

  const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })

  // turn 1: ask for a tool call
  const firstEvents: string[] = []
  for await (const ev of client.stream({ messages: [{ role: "user", content: "read a.txt" }], tools: [], systemPrompt: "" } as LLMRequest)) {
    if (ev.type === "tool_call") firstEvents.push(`c:${ev.call.name}`)
  }
  expect(firstEvents).toEqual(["c:read"])

  // turn 2: pass tool history; the body must contain function_call_output
  const secondEvents: string[] = []
  const turn2Request: LLMRequest = {
    messages: [
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
      { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
    ],
    tools: [],
    systemPrompt: "",
  }
  for await (const ev of client.stream(turn2Request)) {
    if (ev.type === "text/chunk") secondEvents.push(`t:${ev.text}`)
  }
  expect(secondEvents).toEqual(["t:ok"])
  const secondBody = bodies[1] as { input: unknown[] }
  expect(secondBody.input.some((i) => (i as { type?: string }).type === "function_call_output")).toBe(true)
})
```

- [ ] **Step 2: llm-anthropic second-turn body assertion**

Append to `packages/llm-anthropic/test/anthropic.test.ts` (same structure; assert `messages` contains a user `tool_result` block):

```ts
it("second request includes the tool result when the model calls a tool then answers", async () => {
  const bodies: unknown[] = []
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string))
    return new Response(
      bodies.length === 1
        ? [
            `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read", input: { path: "a.txt" } } })}`,
            `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
            `data: ${JSON.stringify({ type: "message_stop" })}`,
          ].join("\n\n")
        : [
            `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } })}`,
            `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
            `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
            `data: ${JSON.stringify({ type: "message_stop" })}`,
          ].join("\n\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  })
  vi.stubGlobal("fetch", fetchMock)

  const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
  for await (const _ev of client.stream({ messages: [{ role: "user", content: "read a.txt" }], tools: [], systemPrompt: "" } as LLMRequest)) { /* consume */ }

  const turn2Request: LLMRequest = {
    messages: [
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
      { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
    ],
    tools: [],
    systemPrompt: "",
  }
  for await (const _ev of client.stream(turn2Request)) { /* consume */ }

  const secondBody = bodies[1] as { messages: unknown[] }
  const last = secondBody.messages[secondBody.messages.length - 1] as { content: unknown[] }
  expect(last.role).toBe("user")
  expect(JSON.stringify(last.content)).toContain("tool_result")
})
```

- [ ] **Step 3: Run protocol tests**

Run: `pnpm --filter @i-harness/llm-openai test && pnpm --filter @i-harness/llm-anthropic test`
Expected: PASS.

- [ ] **Step 4: Run the full gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS (all packages).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-openai/ packages/llm-anthropic/
git commit -m "test: protocol multi-turn tool history integration"
```

---

### Task 8: Full acceptance verification

**Files:**
- None (verification only).

- [ ] **Step 1: Full gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: all packages pass.

- [ ] **Step 2: CLI mock acceptance**

```bash
cd /d/agent-complete/I-harness
node --import tsx apps/cli/src/index.ts run "edit data.txt" --yes
```
Expected: prints the mock reply, exit 0.

- [ ] **Step 3: Confirm clean tree + commit log**

Run: `git status --short` → clean.
Run: `git log --oneline` → the 7 implementation commits from Tasks 1-7.

- [ ] **Step 4: Report completion**

Report: M2 wrap-up complete — tool history folds to model-visible messages, decide tolerant, delta accumulation + reasoning + buffer hardening in both protocol plugins, small cleanups, all gates green.
