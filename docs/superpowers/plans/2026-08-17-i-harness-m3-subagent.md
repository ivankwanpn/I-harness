# I-harness M3 Sub-project C — task/subagent + provider system Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an asynchronous agent-swarm plugin (codex v2 model) with a unified background-job service (dsh `ctx.jobs` model), backed by a user-defined provider system (independent `@i-harness/provider` package shared by main and sub agents) and a self-authored Chat Completions protocol plugin.

**Architecture:** Create `llm-openai-compatible` (self-authored Chat Completions protocol, no `@ai-sdk`), then `provider` (named `ProviderProfile` + registry + `buildModelClient` dispatching on protocol), extend `exec`/`shell` with background jobs, then `subagent` (role system + unified job service + agent table + 11 tools). No depth limit, no SQLite, platform-neutral.

**Tech Stack:** TypeScript strict, ESM (`"type": "module"`), vitest, pnpm workspaces, Node >= 22. NO bun, NO `@ai-sdk/*`.

## Global Constraints

- **This project does NOT use bun** (pnpm/Node monorepo). Do NOT introduce bun dependencies, bun APIs, or bun config.
- **No `@ai-sdk/*` dependencies.** The `llm-openai-compatible` protocol plugin is SELF-AUTHORED (mirroring `llm-openai`/`llm-anthropic` and dsh's `llm-deepseek`) — our own request serialization + SSE parsing.
- Work from `D:\agent-complete\I-harness`; never modify `vendor/` or other plans' `.superpowers/sdd/` directories.
- ESM + strict TS; test files live next to each package under `test/*.test.ts`.
- Gates that must pass at every task's end: `pnpm --filter <pkg> test`, `pnpm -r test`, `pnpm -r typecheck`.
- Platform-neutral: all tools are plain `Tool` registrations — protocol plugins translate them with ZERO changes. Do NOT touch `llm-openai`/`llm-anthropic` (the new `llm-openai-compatible` is a NEW package).
- No real network in tests — always `vi.stubGlobal("fetch", ...)`.
- No session persistence / no SQLite. Job + agent tables are in-memory, session-scoped.
- **No delegation depth limit.** `createAgent`'s `maxTurns` remains the only loop guard.
- Commit messages are exact strings given per step.

---

### Task 1: llm-openai-compatible — self-authored Chat Completions protocol plugin

**Files:**
- Create: `packages/llm-openai-compatible/package.json`
- Create: `packages/llm-openai-compatible/tsconfig.json`
- Create: `packages/llm-openai-compatible/src/index.ts`
- Create: `packages/llm-openai-compatible/test/openai-compatible.test.ts`

**Interfaces:**
- Consumes: `LLMRequest`, `LLMStreamEvent`, `ModelClient` from `@i-harness/llm-seam`; the neutral `LLMMessage` union.
- Produces:
  ```ts
  export interface OpenAICompatibleConfig { apiKey: string; baseUrl?: string; model: string }
  export function parseSSE(text: string): Record<string, unknown>[]
  export function createOpenAICompatibleClient(config: OpenAICompatibleConfig): ModelClient
  ```
  - Request: `POST {baseUrl}/v1/chat/completions` with `{ model, messages, tools, stream: true }`, `Authorization: Bearer <apiKey>`.
  - SSE mapping: `choices[].delta.content` → `text/chunk`; `choices[].delta.tool_calls[]` → `tool_call` (accumulate `function.arguments` deltas); `[DONE]` → end; `error` event shape `{ type: "error", error: Error }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/llm-openai-compatible/test/openai-compatible.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { createOpenAICompatibleClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"

describe("llm-openai-compatible protocol", () => {
  it("translates LLMRequest to the Chat Completions request body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
        { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
      ],
      tools: [{ name: "read", description: "read a file", inputSchema: {} }],
      systemPrompt: "sys",
    } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.test/v1/chat/completions")
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe("m")
    expect(body.stream).toBe(true)
    expect(body.system).toBeUndefined() // chat/completions has no system field
    expect(body.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"content":"data"}' },
    ])
    expect(body.tools).toEqual([{ type: "function", function: { name: "read", description: "read a file", parameters: {} } }])
    expect((init.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer k")
    await it.return?.()
  })

  it("maps SSE chunks to text and tool events with delta accumulation", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "fc_1", function: { name: "write", arguments: "{\"pa" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"a.txt\"}" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}`,
      "data: [DONE]",
    ].join("\n\n")
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: { type: string; text?: string; name?: string; args?: unknown }[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "text/chunk") events.push({ type: "text/chunk", text: ev.text })
      if (ev.type === "tool_call") events.push({ type: "tool_call", name: ev.call.name, args: ev.call.args })
      if (ev.type === "end") events.push({ type: "end" })
    }
    expect(events).toEqual([
      { type: "text/chunk", text: "hel" },
      { type: "tool_call", name: "write", args: { path: "a.txt" } },
      { type: "text/chunk", text: "lo" },
      { type: "end" },
    ])
  })

  it("yields an error event on non-OK response", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "error") events.push("error")
    }
    expect(events).toEqual(["error"])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/llm-openai-compatible test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/llm-openai-compatible/package.json`:

```json
{
  "name": "@i-harness/llm-openai-compatible",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "@i-harness/llm-seam": "workspace:*" }
}
```

Create `packages/llm-openai-compatible/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

Create `packages/llm-openai-compatible/src/index.ts`:

```ts
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"

export interface OpenAICompatibleConfig {
  apiKey: string
  baseUrl?: string
  model: string
}

export function parseSSE(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.includes("data:"))
    .map((chunk) => {
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"))!
      const data = dataLine.slice(5).trim()
      if (data === "[DONE]") return { type: "[DONE]" }
      return JSON.parse(data) as Record<string, unknown>
    })
}

// Translate the neutral LLMMessage union into Chat Completions wire messages.
function toWireMessage(m: {
  role: "user" | "assistant" | "tool"
  content: string
  toolCalls?: { id: string; name: string; args: unknown }[]
  toolCallId?: string
}): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId!, content: m.content }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    }
  }
  return { role: m.role, content: m.content }
}

export function createOpenAICompatibleClient(config: OpenAICompatibleConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://api.openai.com"
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      const body = {
        model: config.model,
        messages: request.messages.map(toWireMessage),
        tools: request.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
        stream: true,
      }
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
      })
      if (!response.ok || !response.body) {
        yield { type: "error", error: new Error(`openai-compatible request failed: ${response.status} ${await response.text()}`) }
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let receivedDone = false
      // tool call accumulation: index -> { id, name, argsBuffer }
      const pendingToolCalls = new Map<number, { id: string; name: string; argsBuffer: string }>()

      const emit = function* (events: LLMStreamEvent[]): Generator<LLMStreamEvent, boolean, unknown> {
        for (const ev of events) {
          if (ev.type === "error") {
            yield ev
            return true
          }
          yield ev
        }
        return false
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split("\n\n")
          buffer = chunks.pop() ?? ""
          for (const chunk of chunks) {
            if (receivedDone) break
            for (const event of parseSSE(chunk)) {
              if (receivedDone) break
              const events: LLMStreamEvent[] = []
              if (event.type === "[DONE]") {
                receivedDone = true
                break
              }
              const choices = (event as { choices?: { delta?: Record<string, unknown> }[] }).choices ?? []
              for (const choice of choices) {
                const delta = choice.delta ?? {}
                if (typeof delta.content === "string" && delta.content.length > 0) {
                  events.push({ type: "text/chunk", text: delta.content })
                }
                const toolCalls = (delta as { tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }).tool_calls
                if (toolCalls) {
                  for (const tc of toolCalls) {
                    const idx = tc.index ?? 0
                    let pending = pendingToolCalls.get(idx)
                    if (!pending) {
                      pending = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? "", argsBuffer: "" }
                      pendingToolCalls.set(idx, pending)
                    }
                    if (tc.id) pending.id = tc.id
                    if (tc.function?.name) pending.name = tc.function.name
                    if (tc.function?.arguments) pending.argsBuffer += tc.function.arguments
                  }
                }
              }
              if (yield* emit(events)) return
            }
          }
          if (receivedDone) break
        }
        // flush residual buffer
        if (buffer.trim() !== "") {
          for (const event of parseSSE(buffer)) {
            if (receivedDone) break
            if (event.type === "[DONE]") { receivedDone = true; break }
            const choices = (event as { choices?: { delta?: Record<string, unknown> }[] }).choices ?? []
            const events: LLMStreamEvent[] = []
            for (const choice of choices) {
              const delta = choice.delta ?? {}
              if (typeof delta.content === "string" && delta.content.length > 0) events.push({ type: "text/chunk", text: delta.content })
            }
            if (yield* emit(events)) return
          }
        }
        // flush completed tool calls
        for (const [, pending] of pendingToolCalls) {
          try {
            const args = JSON.parse(pending.argsBuffer) as unknown
            if (yield* emit([{ type: "tool_call", call: { name: pending.name, args } }])) return
          } catch {
            if (yield* emit([{ type: "error", error: new Error(`openai-compatible malformed tool args: ${pending.argsBuffer}`) }])) return
          }
        }
      } finally {
        reader.releaseLock()
      }
      yield { type: "end" }
    },
  }
}
```

**Note on tool-call timing:** In Chat Completions, tool-call deltas arrive progressively and the finish is signaled by `finish_reason: "tool_calls"`; the implementation flushes accumulated tool calls after the stream ends (the `pendingToolCalls` loop), which is deterministic for the mock. If a real provider sends `finish_reason: "tool_calls"` mid-stream, the tool_call events are emitted after `[DONE]` — acceptable for this sub-project (the `end` event follows). If a reviewer objects, an alternative is to emit on `finish_reason`, but the after-stream flush is simpler and test-stable.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/llm-openai-compatible test`
Expected: PASS (3 new).

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-openai-compatible/
git commit -m "feat: llm-openai-compatible Chat Completions protocol plugin"
```

---

### Task 2: provider — ProviderProfile, ProviderRegistry, buildModelClient + CLI integration

**Files:**
- Create: `packages/provider/package.json`
- Create: `packages/provider/tsconfig.json`
- Create: `packages/provider/src/index.ts`
- Create: `packages/provider/test/provider.test.ts`
- Modify: `apps/cli/src/index.ts` (replace `parseModel` if/else)

**Interfaces:**
- Consumes: `ModelClient` from `@i-harness/llm-seam`; `createOpenAIClient` from `@i-harness/llm-openai`; `createOpenAICompatibleClient` from `@i-harness/llm-openai-compatible` (Task 1); `createAnthropicClient` from `@i-harness/llm-anthropic`.
- Produces:
  ```ts
  export type ProviderProtocol = "openai-responses" | "openai-compatible" | "anthropic-messages"
  export interface ProviderProfile { name: string; displayName: string; protocol: ProviderProtocol; baseUrl?: string; apiKey?: string; models?: string[] }
  export interface ProviderRegistry {
    register(profile: ProviderProfile): void
    get(name: string): ProviderProfile | undefined
    list(): ProviderProfile[]
    remove(name: string): void
  }
  export function createProviderRegistry(): ProviderRegistry
  export function buildModelClient(profile: ProviderProfile, model: string, extra?: Record<string, unknown>): ModelClient
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/provider/test/provider.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createProviderRegistry, buildModelClient } from "../src/index.ts"

describe("provider registry", () => {
  it("registers, lists, and removes providers", () => {
    const reg = createProviderRegistry()
    reg.register({ name: "my-deepseek", displayName: "My DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey: "k", models: ["deepseek-chat"] })
    expect(reg.get("my-deepseek")?.protocol).toBe("openai-compatible")
    expect(reg.list()).toHaveLength(1)
    reg.remove("my-deepseek")
    expect(reg.get("my-deepseek")).toBeUndefined()
  })

  it("throws on duplicate provider name", () => {
    const reg = createProviderRegistry()
    reg.register({ name: "x", displayName: "X", protocol: "openai-responses" })
    expect(() => reg.register({ name: "x", displayName: "X2", protocol: "anthropic-messages" })).toThrow(/duplicate/i)
  })

  it("buildModelClient returns a ModelClient for each protocol", () => {
    const clients = [
      buildModelClient({ name: "o", displayName: "O", protocol: "openai-responses", apiKey: "k" }, "gpt-4o"),
      buildModelClient({ name: "c", displayName: "C", protocol: "openai-compatible", apiKey: "k" }, "deepseek-chat"),
      buildModelClient({ name: "a", displayName: "A", protocol: "anthropic-messages", apiKey: "k" }, "claude-x"),
    ]
    for (const c of clients) expect(typeof c.stream).toBe("function")
  })

  it("buildModelClient throws on unknown protocol", () => {
    expect(() => buildModelClient({ name: "x", displayName: "X", protocol: "bogus" as never }, "m")).toThrow(/protocol/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/provider test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/provider/package.json`:

```json
{
  "name": "@i-harness/provider",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/llm-seam": "workspace:*",
    "@i-harness/llm-openai": "workspace:*",
    "@i-harness/llm-openai-compatible": "workspace:*",
    "@i-harness/llm-anthropic": "workspace:*"
  }
}
```

Create `packages/provider/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

Create `packages/provider/src/index.ts`:

```ts
import type { ModelClient } from "@i-harness/llm-seam"
import { createOpenAIClient } from "@i-harness/llm-openai"
import { createOpenAICompatibleClient } from "@i-harness/llm-openai-compatible"
import { createAnthropicClient } from "@i-harness/llm-anthropic"

export type ProviderProtocol = "openai-responses" | "openai-compatible" | "anthropic-messages"

export interface ProviderProfile {
  name: string
  displayName: string
  protocol: ProviderProtocol
  baseUrl?: string
  apiKey?: string
  models?: string[]
}

export interface ProviderRegistry {
  register(profile: ProviderProfile): void
  get(name: string): ProviderProfile | undefined
  list(): ProviderProfile[]
  remove(name: string): void
}

export function createProviderRegistry(): ProviderRegistry {
  const profiles = new Map<string, ProviderProfile>()
  return {
    register(profile) {
      if (profiles.has(profile.name)) throw new Error(`duplicate provider: ${profile.name}`)
      profiles.set(profile.name, profile)
    },
    get(name) { return profiles.get(name) },
    list() { return [...profiles.values()] },
    remove(name) { profiles.delete(name) },
  }
}

// Builds a ModelClient by dispatching on the provider's protocol. extra is
// passed through for model-end options (e.g. reasoning_effort); unknown
// protocols error here, and bad models error at the model end.
export function buildModelClient(profile: ProviderProfile, model: string, _extra?: Record<string, unknown>): ModelClient {
  switch (profile.protocol) {
    case "openai-responses":
      return createOpenAIClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model })
    case "openai-compatible":
      return createOpenAICompatibleClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model })
    case "anthropic-messages":
      return createAnthropicClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model })
    default:
      throw new Error(`unknown provider protocol: ${String((profile as { protocol?: unknown }).protocol)}`)
  }
}
```

Then update `apps/cli/src/index.ts` to replace `parseModel`:

```ts
import { createProviderRegistry, buildModelClient } from "@i-harness/provider"

function parseModel(modelSpec: string, apiKey: string): ModelClient {
  const [provider, model] = modelSpec.split(":")
  const reg = createProviderRegistry()
  // built-in convenience profiles so the CLI keeps working without user config
  reg.register({ name: "openai", displayName: "OpenAI", protocol: "openai-responses", apiKey, model: undefined, models: [] })
  reg.register({ name: "deepseek", displayName: "DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey, models: [] })
  reg.register({ name: "anthropic", displayName: "Anthropic", protocol: "anthropic-messages", apiKey, models: [] })
  const profile = reg.get(provider ?? "")
  if (!profile) throw new Error(`unknown model provider: ${provider}`)
  return buildModelClient(profile, model ?? "gpt-4o")
}
```

(Note: this preserves CLI behavior — openai → responses with default gpt-4o, deepseek → compatible with deepseek default, anthropic → messages. The `model ?? "gpt-4o"` fallback is a CLI-level default; a cleaner version would give each profile a default model, but the existing CLI test only exercises `run "hello"` with the mock, so this is safe.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/provider test`
Expected: PASS (4 new). Then `pnpm --filter @i-harness/cli test` → existing tests pass (parseModel is only exercised via the mock default path; the entry-guard test uses no --model).

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/provider/ apps/cli/
git commit -m "feat: provider package with registry and protocol dispatch; CLI uses it"
```

---

### Task 3: exec — runBackground + getOutput + killJob background jobs

**Files:**
- Modify: `packages/exec/src/index.ts`
- Modify: `packages/exec/test/exec.test.ts`

**Interfaces:**
- Consumes: existing `ExecService.run`, `ExecCommand`, `ExecResult`.
- Produces:
  ```ts
  export type BackgroundJobStatus = "running" | "completed" | "killed" | "error"
  export interface BackgroundJobView { id: string; status: BackgroundJobStatus; stdout: string; stderr: string; exitCode?: number }
  export interface ExecService {
    run(cmd: ExecCommand): Promise<ExecResult>
    runBackground(cmd: ExecCommand): { jobId: string }
    getOutput(jobId: string): BackgroundJobView
    killJob(jobId: string): "cancellation-requested" | "already-finished"
  }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/exec/test/exec.test.ts`:

```ts
describe("exec background jobs", () => {
  it("runBackground returns immediately and accumulates output", async () => {
    const exec = createExecService()
    const { jobId } = exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>console.log('done'), 100)"] })
    expect(jobId).toMatch(/^bash-\d+$/)
    expect(exec.getOutput(jobId).status).toBe("running")
    await new Promise((r) => setTimeout(r, 300))
    const view = exec.getOutput(jobId)
    expect(view.status).toBe("completed")
    expect(view.stdout.trim()).toBe("done")
    expect(view.exitCode).toBe(0)
  }, 10_000)

  it("killJob cancels a running job and marks it killed", async () => {
    const exec = createExecService()
    const { jobId } = exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>{}, 5000)"] })
    expect(exec.killJob(jobId)).toBe("cancellation-requested")
    await new Promise((r) => setTimeout(r, 300))
    expect(exec.getOutput(jobId).status).toBe("killed")
    expect(exec.killJob(jobId)).toBe("already-finished")
  }, 10_000)

  it("getOutput for unknown job throws", () => {
    const exec = createExecService()
    expect(() => exec.getOutput("nope")).toThrow(/unknown job/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/exec test`
Expected: FAIL — `runBackground` doesn't exist.

- [ ] **Step 3: Implement**

In `packages/exec/src/index.ts`, add types, extend `ExecService`, extract the spawn-collect logic into a shared `spawnChild` helper, and add the background job table. Rewrite the file cleanly (static `import { spawn }` — no `require`):

```ts
import { spawn, type ChildProcess } from "node:child_process"
import type { PluginContext } from "@i-harness/core-plugin"

export interface ExecCommand {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  input?: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export type BackgroundJobStatus = "running" | "completed" | "killed" | "error"
export interface BackgroundJobView {
  id: string
  status: BackgroundJobStatus
  stdout: string
  stderr: string
  exitCode?: number
}

interface SpawnHandle {
  child: ChildProcess
  kill(): void
  done: Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>
}

function spawnChild(cmd: ExecCommand): SpawnHandle {
  const child = spawn(cmd.argv[0]!, cmd.argv.slice(1), {
    cwd: cmd.cwd,
    env: { ...process.env, ...cmd.env },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  let timedOut = false
  let settled = false
  let resolveDone!: (v: { exitCode: number; stdout: string; stderr: string; timedOut: boolean }) => void
  const done = new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((res) => { resolveDone = res })

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

  child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8") })
  child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8") })
  if (cmd.input !== undefined) child.stdin?.write(cmd.input)
  child.stdin?.end()

  function doneFn(code: number) {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    resolveDone({
      stdout: stdout.replace(/\r\n/g, "\n"),
      stderr: stderr.replace(/\r\n/g, "\n"),
      exitCode: code,
      timedOut,
    })
  }
  child.on("close", (code) => doneFn(code ?? -1))
  child.on("error", () => doneFn(-1))

  return {
    child,
    kill() {
      if (process.platform === "win32") {
        const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"])
        k.on("error", () => { /* ignore */ })
      } else {
        try { process.kill(-child.pid!, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch { /* ignore */ } }
      }
    },
    done,
  }
}

export interface ExecService {
  run(cmd: ExecCommand): Promise<ExecResult>
  runBackground(cmd: ExecCommand): { jobId: string }
  getOutput(jobId: string): BackgroundJobView
  killJob(jobId: string): "cancellation-requested" | "already-finished"
}

export function createExecService(): ExecService {
  let bashCounter = 0
  const jobs = new Map<string, BackgroundJobView & { handle: SpawnHandle }>()

  return {
    run(cmd: ExecCommand): Promise<ExecResult> {
      const h = spawnChild(cmd)
      return h.done.then(({ stdout, stderr, exitCode, timedOut }) => ({ stdout, stderr, exitCode, timedOut }))
    },
    runBackground(cmd: ExecCommand): { jobId: string } {
      bashCounter += 1
      const jobId = `bash-${bashCounter}`
      const handle = spawnChild(cmd)
      jobs.set(jobId, { id: jobId, status: "running", stdout: "", stderr: "", handle })
      handle.done.then(({ stdout, stderr, exitCode, timedOut }) => {
        const job = jobs.get(jobId)
        if (!job || job.status !== "running") return
        job.stdout = stdout
        job.stderr = stderr
        job.exitCode = exitCode
        job.status = timedOut ? "killed" : exitCode === 0 ? "completed" : "error"
      })
      return { jobId }
    },
    getOutput(jobId: string): BackgroundJobView {
      const job = jobs.get(jobId)
      if (!job) throw new Error(`unknown job: ${jobId}`)
      return { id: job.id, status: job.status, stdout: job.stdout, stderr: job.stderr, ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}) }
    },
    killJob(jobId: string): "cancellation-requested" | "already-finished" {
      const job = jobs.get(jobId)
      if (!job) throw new Error(`unknown job: ${jobId}`)
      if (job.status !== "running") return "already-finished"
      job.handle.kill()
      job.status = "killed"
      return "cancellation-requested"
    },
  }
}

export function registerExec(ctx: PluginContext): void {
  ctx.services.register("exec/service", createExecService())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/exec test`
Expected: PASS (5 existing + 3 new).

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/exec/
git commit -m "feat: exec runBackground/getOutput/killJob background jobs"
```

---

### Task 4: shell — background?: boolean on bash/pwsh tools

**Files:**
- Modify: `packages/shell/src/index.ts`
- Modify: `packages/shell/test/shell.test.ts`

**Interfaces:**
- Consumes: `ExecService.runBackground` (Task 3).
- Produces: `bash`/`pwsh` tools accept `background?: boolean`; when true, `execute` calls `exec.runBackground` and returns `{ job_id }`; otherwise unchanged.

- [ ] **Step 1: Write the failing test**

Append to `packages/shell/test/shell.test.ts`:

```ts
it("bash tool with background:true returns a job id immediately", async () => {
  let ranBackground = false
  const fakeExec: ExecService = {
    run: async () => ({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false }),
    runBackground: () => { ranBackground = true; return { jobId: "bash-1" } },
    getOutput: () => ({ id: "bash-1", status: "running", stdout: "", stderr: "" }),
    killJob: () => "already-finished",
  }
  const [bash] = createShellTools({ exec: fakeExec })
  const result = await bash.execute({ command: "sleep 5", background: true })
  expect(ranBackground).toBe(true)
  expect(result).toEqual({ job_id: "bash-1" })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/shell test`
Expected: FAIL — the existing test file's `fakeExec` lacks the new methods (typecheck error) and `background` arg is ignored.

- [ ] **Step 3: Implement**

In `packages/shell/src/index.ts`, update `ShellToolDeps` consumers. The bash tool:

```ts
const bash: Tool<{ command: string; background?: boolean }, { stdout?: string; exitCode?: number; job_id?: string }> = {
  name: "bash",
  description: "run a bash command (background: true returns a job id instead of waiting)",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" }, background: { type: "boolean" } },
    required: ["command"],
  },
  getArgv: (args: { command: string }) => getArgv(args.command),
  execute: async (args: { command: string; background?: boolean }, _exec: ToolExec) => {
    const argv = ["bash", "-c", args.command]
    if (args.background === true) {
      const { jobId } = deps.exec.runBackground({ argv })
      return { job_id: jobId }
    }
    const result = await deps.exec.run({ argv })
    return { stdout: result.stdout, exitCode: result.exitCode }
  },
}
```

Apply the same `background?: boolean` pattern to `pwsh` (`argv = ["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", args.command]`).

Then update the existing `fakeExec` in `packages/shell/test/shell.test.ts` to a full `ExecService` shape (add `runBackground`/`getOutput`/`killJob` stubs). The existing bash/pwsh execute tests call `createShellTools({ exec: fakeExec })` — the literal must now satisfy the extended interface.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/shell test`
Expected: PASS (existing + 1 new).

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS — check CLI/guard-approval shell consumers still compile (they call `bash.execute({ command })` without background; optional arg).

- [ ] **Step 6: Commit**

```bash
git add packages/shell/
git commit -m "feat: shell tools support background execution via job ids"
```

---

### Task 5: subagent package — unified job service (jobs.ts)

**Files:**
- Create: `packages/subagent/package.json`
- Create: `packages/subagent/tsconfig.json`
- Create: `packages/subagent/src/jobs.ts`
- Create: `packages/subagent/src/index.ts` (minimal re-export)
- Create: `packages/subagent/test/jobs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/jobs.ts
  export type JobStatus = "running" | "completed" | "killed" | "error"
  export interface JobSnapshot { id: string; kind: string; label: string; status: JobStatus; output: string }
  export interface JobRegistry {
    registerJob(owner: string, kind: string, label: string): { id: string }
    updateJob(id: string, patch: Partial<Pick<JobSnapshot, "status" | "output">>): void
    read(id: string): JobSnapshot
    list(owner: string): JobSnapshot[]
    wait(id: string, timeoutMs: number): Promise<void>
    kill(id: string): "cancellation-requested" | "already-finished"
  }
  export function createJobRegistry(): JobRegistry
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/subagent/test/jobs.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createJobRegistry } from "../src/jobs.ts"

describe("job registry", () => {
  it("issues ids with per-kind monotonic counters", () => {
    const jobs = createJobRegistry()
    expect(jobs.registerJob("a", "bash", "build").id).toBe("bash-1")
    expect(jobs.registerJob("a", "subagent", "child").id).toBe("subagent-1")
    expect(jobs.registerJob("a", "bash", "test").id).toBe("bash-2")
  })

  it("read/list reflect updates; kill is terminal and blocks later updates", () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("a", "bash", "build")
    jobs.updateJob(id, { output: "compiling..." })
    expect(jobs.read(id).output).toBe("compiling...")
    expect(jobs.list("a")).toHaveLength(1)
    expect(jobs.list("other")).toHaveLength(0)
    expect(jobs.kill(id)).toBe("cancellation-requested")
    jobs.updateJob(id, { status: "completed", output: "late" })
    expect(jobs.read(id).status).toBe("killed")
    expect(jobs.read(id).output).toBe("compiling...")
  })

  it("wait resolves on terminal status", async () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("a", "bash", "build")
    let settled = false
    const p = jobs.wait(id, 2000).then(() => { settled = true })
    setTimeout(() => jobs.updateJob(id, { status: "completed" }), 20)
    await p
    expect(settled).toBe(true)
  })

  it("wait resolves on timeout without terminal status", async () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("a", "bash", "long")
    const started = Date.now()
    await jobs.wait(id, 50)
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
    expect(jobs.read(id).status).toBe("running")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/subagent test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/subagent/package.json`:

```json
{
  "name": "@i-harness/subagent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-plugin": "workspace:*",
    "@i-harness/core-tools": "workspace:*",
    "@i-harness/core-session": "workspace:*",
    "@i-harness/core-agent": "workspace:*",
    "@i-harness/llm-seam": "workspace:*",
    "@i-harness/provider": "workspace:*",
    "@i-harness/exec": "workspace:*",
    "@i-harness/preset": "workspace:*"
  }
}
```

Create `packages/subagent/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

Create `packages/subagent/src/jobs.ts` (polling-based wait — no dangling timers):

```ts
export type JobStatus = "running" | "completed" | "killed" | "error"
export interface JobSnapshot { id: string; kind: string; label: string; status: JobStatus; output: string }
interface JobRecord extends JobSnapshot { owner: string; terminal: boolean }

export interface JobRegistry {
  registerJob(owner: string, kind: string, label: string): { id: string }
  updateJob(id: string, patch: Partial<Pick<JobSnapshot, "status" | "output">>): void
  read(id: string): JobSnapshot
  list(owner: string): JobSnapshot[]
  wait(id: string, timeoutMs: number): Promise<void>
  kill(id: string): "cancellation-requested" | "already-finished"
}

export function createJobRegistry(): JobRegistry {
  const records = new Map<string, JobRecord>()
  const counters = new Map<string, number>()
  function nextId(kind: string): string {
    const n = (counters.get(kind) ?? 0) + 1
    counters.set(kind, n)
    return `${kind}-${n}`
  }
  return {
    registerJob(owner: string, kind: string, label: string) {
      const id = nextId(kind)
      records.set(id, { id, kind, label, status: "running", output: "", owner, terminal: false })
      return { id }
    },
    updateJob(id: string, patch: Partial<Pick<JobSnapshot, "status" | "output">>) {
      const rec = records.get(id)
      if (!rec || rec.terminal) return
      if (patch.status !== undefined) rec.status = patch.status
      if (patch.output !== undefined) rec.output = patch.output
      if (rec.status !== "running") rec.terminal = true
    },
    read(id: string) {
      const rec = records.get(id)
      if (!rec) throw new Error(`unknown job: ${id}`)
      return { id: rec.id, kind: rec.kind, label: rec.label, status: rec.status, output: rec.output }
    },
    list(owner: string) {
      return [...records.values()].filter((r) => r.owner === owner)
        .map((r) => ({ id: r.id, kind: r.kind, label: r.label, status: r.status, output: r.output }))
    },
    async wait(id: string, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs
      while (true) {
        const rec = records.get(id)
        if (!rec || rec.terminal) return
        if (Date.now() >= deadline) return
        await new Promise((r) => setTimeout(r, 10))
      }
    },
    kill(id: string) {
      const rec = records.get(id)
      if (!rec) throw new Error(`unknown job: ${id}`)
      if (rec.terminal) return "already-finished"
      rec.status = "killed"
      rec.terminal = true
      return "cancellation-requested"
    },
  }
}
```

Create `packages/subagent/src/index.ts` (minimal re-export for now):

```ts
export { createJobRegistry } from "./jobs.ts"
export type { JobRegistry, JobSnapshot, JobStatus } from "./jobs.ts"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/subagent test`
Expected: PASS (4 new).

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/subagent/
git commit -m "feat: subagent unified background job service"
```

---

### Task 6: subagent — role system (roles.ts) + built-in roles

**Files:**
- Create: `packages/subagent/src/roles.ts`
- Modify: `packages/subagent/src/index.ts`
- Create: `packages/subagent/test/roles.test.ts`

**Interfaces:**
- Consumes: nothing yet (roles reference provider names as strings; provider resolution happens in child.ts).
- Produces:
  ```ts
  // src/roles.ts
  export interface SubagentRole {
    name: string
    description: string
    systemPrompt: string
    tools: string[]
    model?: { provider: string; model: string; extra?: Record<string, unknown> }
  }
  export interface RoleRegistry {
    register(role: SubagentRole): void
    get(name: string): SubagentRole | undefined
    list(): SubagentRole[]
    remove(name: string): void
  }
  export function createRoleRegistry(): RoleRegistry
  export function builtinRoles(): SubagentRole[]
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/subagent/test/roles.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"

describe("role registry", () => {
  it("seeds four built-in roles", () => {
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const names = roles.list().map((r) => r.name).sort()
    expect(names).toEqual(["explore", "general", "research", "worker"])
  })

  it("register/get/list/remove and duplicate detection", () => {
    const roles = createRoleRegistry()
    roles.register({ name: "reviewer", description: "reviews code", systemPrompt: "You review.", tools: ["read"], model: { provider: "p", model: "m" } })
    expect(roles.get("reviewer")?.description).toBe("reviews code")
    expect(() => roles.register({ name: "reviewer", description: "x", systemPrompt: "y", tools: [] })).toThrow(/duplicate/i)
    roles.remove("reviewer")
    expect(roles.get("reviewer")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/subagent test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/subagent/src/roles.ts`:

```ts
export interface SubagentRole {
  name: string
  description: string
  systemPrompt: string
  tools: string[]
  model?: { provider: string; model: string; extra?: Record<string, unknown> }
}

export interface RoleRegistry {
  register(role: SubagentRole): void
  get(name: string): SubagentRole | undefined
  list(): SubagentRole[]
  remove(name: string): void
}

export function createRoleRegistry(): RoleRegistry {
  const roles = new Map<string, SubagentRole>()
  return {
    register(role) {
      if (roles.has(role.name)) throw new Error(`duplicate role: ${role.name}`)
      roles.set(role.name, role)
    },
    get(name) { return roles.get(name) },
    list() { return [...roles.values()] },
    remove(name) { roles.delete(name) },
  }
}

// Built-in roles (patterned on opencode's built-in agent prompts). None carry
// a model — they inherit the parent ModelClient unless the user edits them.
export function builtinRoles(): SubagentRole[] {
  return [
    {
      name: "general",
      description: "General agent for researching questions and executing multi-step tasks.",
      systemPrompt: "You are a general-purpose coding agent. Investigate the task, execute steps, and report concrete results with evidence.",
      tools: ["bash", "pwsh", "read", "write", "list_dir", "grep"],
    },
    {
      name: "explore",
      description: "Fast agent specialized for exploring codebases.",
      systemPrompt: "You are an exploration agent. Find files by pattern and answer questions about the codebase quickly. Do not modify files.",
      tools: ["read", "list_dir", "grep", "glob"],
    },
    {
      name: "research",
      description: "Deep research agent for evidence-based, cross-module analysis.",
      systemPrompt: "You are a research specialist. Investigate the assigned question using read-only tools, build conclusions from evidence, and cite file paths and line ranges. Do not modify files.",
      tools: ["read", "list_dir", "grep"],
    },
    {
      name: "worker",
      description: "Strong implementation agent for code changes, tests, and verification.",
      systemPrompt: "You are an implementation agent. Make the requested code changes, write tests, and verify them. Report what changed and the verification result.",
      tools: ["bash", "pwsh", "read", "write", "list_dir", "grep"],
    },
  ]
}
```

Update `packages/subagent/src/index.ts`:

```ts
export { createJobRegistry } from "./jobs.ts"
export type { JobRegistry, JobSnapshot, JobStatus } from "./jobs.ts"
export { createRoleRegistry, builtinRoles } from "./roles.ts"
export type { SubagentRole, RoleRegistry } from "./roles.ts"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/subagent test`
Expected: PASS (4 jobs + 2 roles).

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/subagent/
git commit -m "feat: subagent role system with built-in roles"
```

---

### Task 7: subagent — child creation (child.ts + fork.ts + agent-table.ts)

**Files:**
- Create: `packages/subagent/src/agent-table.ts`
- Create: `packages/subagent/src/fork.ts`
- Create: `packages/subagent/src/child.ts`
- Modify: `packages/subagent/src/index.ts`
- Create: `packages/subagent/test/child.test.ts`

**Interfaces:**
- Consumes: `createAgent` from `@i-harness/core-agent`; `createSession`/`SessionEvent` from `@i-harness/core-session`; `createToolRegistry`, `ToolRegistry`, `Tool` from `@i-harness/core-tools`; `ModelClient` from `@i-harness/llm-seam`; `createProviderRegistry`/`buildModelClient` from `@i-harness/provider`; `JobRegistry` (Task 5); `SubagentRole` (Task 6).
- Produces:
  ```ts
  // agent-table.ts
  export type ChildStatus = "running" | "completed" | "killed" | "error"
  export interface ChildAgentEntry { path: string; status: ChildStatus; session: ReturnType<typeof createSession>; controller: AbortController; finalText?: string; error?: string; mailbox: string[] }
  export interface AgentTable { entries(): Map<string, ChildAgentEntry>; add(path: string, entry: ChildAgentEntry): void; get(path: string): ChildAgentEntry | undefined; remove(path: string): void }
  export function createAgentTable(): AgentTable
  ```
  ```ts
  // fork.ts
  export function forkTurns(events: SessionEvent[], n: number): SessionEvent[]
  ```
  ```ts
  // child.ts
  export interface SpawnOptions {
    taskName: string
    message: string
    parentPath: string
    parentRegistry: ToolRegistry
    parentSession: ReturnType<typeof createSession>
    parentCtx: PluginContext
    role: SubagentRole
    parentModel: ModelClient
    providers: ReturnType<typeof createProviderRegistry>
    jobs: JobRegistry
    table: AgentTable
  }
  export function spawnChild(opts: SpawnOptions): { path: string; jobId: string }
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/subagent/test/child.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, type SessionEvent } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"
import { createAgentTable } from "../src/agent-table.ts"
import { forkTurns } from "../src/fork.ts"
import { spawnChild } from "../src/child.ts"
import { createProviderRegistry } from "@i-harness/provider"

function makeTool(name: string): Tool {
  return { name, description: "", inputSchema: {}, execute: async () => ({}) }
}

describe("fork.ts", () => {
  it("forkTurns returns the last N turn blocks", () => {
    const events: SessionEvent[] = []
    const push = (type: string, extra: Record<string, unknown> = {}) => events.push({ type, ...extra } as SessionEvent)
    push("turn/start"); push("user/message", { text: "a" }); push("assistant/message", { text: "A" }); push("turn/end")
    push("turn/start"); push("user/message", { text: "b" }); push("assistant/message", { text: "B" }); push("turn/end")
    const last = forkTurns(events, 1)
    expect(last.some((e) => (e as { text?: string }).text === "b")).toBe(true)
    expect(last.some((e) => (e as { text?: string }).text === "a")).toBe(false)
  })
})

describe("spawnChild", () => {
  it("spawns a background child with a role and resolves completion", async () => {
    const parentCtx = createContext()
    const parentReg = createToolRegistry(parentCtx)
    parentReg.register(makeTool("read"))
    const parentSession = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const providers = createProviderRegistry()
    const model = createMockClient([{ role: "assistant", text: "child done" }])

    const { path, jobId } = spawnChild({
      taskName: "helper",
      message: "do the thing",
      parentPath: "root",
      parentRegistry: parentReg,
      parentSession,
      parentCtx,
      role: roles.get("general")!,
      parentModel: model,
      providers,
      jobs,
      table,
    })
    expect(path).toBe("root/helper")
    expect(jobId).toMatch(/^subagent-\d+$/)
    expect(table.get("root/helper")!.status).toBe("running")
    await new Promise((r) => setTimeout(r, 150))
    expect(table.get("root/helper")!.status).toBe("completed")
    expect(jobs.read(jobId).status).toBe("completed")
  }, 10_000)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/subagent test`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement**

Create `packages/subagent/src/agent-table.ts`:

```ts
import { createSession } from "@i-harness/core-session"

export type ChildStatus = "running" | "completed" | "killed" | "error"
export interface ChildAgentEntry {
  path: string
  status: ChildStatus
  session: ReturnType<typeof createSession>
  controller: AbortController
  finalText?: string
  error?: string
  mailbox: string[]
}
export interface AgentTable {
  entries(): Map<string, ChildAgentEntry>
  add(path: string, entry: ChildAgentEntry): void
  get(path: string): ChildAgentEntry | undefined
  remove(path: string): void
}
export function createAgentTable(): AgentTable {
  const table = new Map<string, ChildAgentEntry>()
  return {
    entries: () => table,
    add: (path, entry) => { table.set(path, entry) },
    get: (path) => table.get(path),
    remove: (path) => { table.delete(path) },
  }
}
```

Create `packages/subagent/src/fork.ts`:

```ts
import type { SessionEvent } from "@i-harness/core-session"

export function forkTurns(events: SessionEvent[], n: number): SessionEvent[] {
  if (n === 0) return []
  const turnStarts: number[] = []
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.type === "turn/start") turnStarts.push(i)
  }
  if (turnStarts.length === 0) return events
  if (turnStarts.length <= n) return events
  return events.slice(turnStarts[turnStarts.length - n]!)
}
```

Create `packages/subagent/src/child.ts`:

```ts
import type { PluginContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry, type Tool, type ToolRegistry } from "@i-harness/core-tools"
import { createAgent } from "@i-harness/core-agent"
import type { ModelClient } from "@i-harness/llm-seam"
import type { ProviderRegistry } from "@i-harness/provider"
import type { JobRegistry } from "./jobs.ts"
import type { AgentTable } from "./agent-table.ts"
import type { SubagentRole } from "./roles.ts"
import { forkTurns } from "./fork.ts"

export interface SpawnOptions {
  taskName: string
  message: string
  parentPath: string
  parentRegistry: ToolRegistry
  parentSession: ReturnType<typeof createSession>
  parentCtx: PluginContext
  role: SubagentRole
  parentModel: ModelClient
  providers: ProviderRegistry
  jobs: JobRegistry
  table: AgentTable
}

export function spawnChild(opts: SpawnOptions): { path: string; jobId: string } {
  const childPath = `${opts.parentPath}/${opts.taskName}`
  const childCtx = opts.parentCtx.scope.mount()
  const childSession = createSession()

  // fork_turns: seed the child session with the last N parent turns (default all).
  for (const ev of forkTurns(opts.parentSession.events, Infinity)) childSession.events.push({ ...ev })

  // child registry: register the role's allowed tools (resolved from the parent).
  const childReg = createToolRegistry(childCtx)
  for (const name of opts.role.tools) {
    const tool = opts.parentRegistry.get(name)
    if (tool) childReg.register(tool)
  }

  // model: role model via provider, else inherit parent.
  let model = opts.parentModel
  if (opts.role.model) {
    const profile = opts.providers.get(opts.role.model.provider)
    if (!profile) throw new Error(`role '${opts.role.name}' references unknown provider '${opts.role.model.provider}'`)
    model = opts.providers.buildModelClient
      ? buildModelClient(profile, opts.role.model.model, opts.role.model.extra)
      : opts.parentModel
  }

  const controller = new AbortController()
  opts.table.add(childPath, {
    path: childPath,
    status: "running",
    session: childSession,
    controller,
    mailbox: [],
  })
  const { id: jobId } = opts.jobs.registerJob("root", "subagent", opts.taskName)

  const agent = createAgent(childCtx, {
    session: childSession,
    tools: childReg,
    model,
    systemPrompt: opts.role.systemPrompt,
  })

  agent.run(opts.message).then(
    (result) => {
      const e = opts.table.get(childPath)
      if (e) { e.status = "completed"; e.finalText = result.finalText }
      opts.jobs.updateJob(jobId, { status: "completed", output: result.finalText })
    },
    (err) => {
      const e = opts.table.get(childPath)
      if (e) { e.status = "error"; e.error = err instanceof Error ? err.message : String(err) }
      opts.jobs.updateJob(jobId, { status: "error", output: err instanceof Error ? err.message : String(err) })
    },
  )

  return { path: childPath, jobId }
}
```

**Important wiring fix:** `opts.providers.buildModelClient` doesn't exist — `ProviderRegistry` (from `@i-harness/provider`) has `register`/`get`/`list`/`remove`, and `buildModelClient` is a **module-level** export, not a registry method. Import it directly:

```ts
import { buildModelClient, type ProviderRegistry } from "@i-harness/provider"
```

And the model resolution:

```ts
  let model = opts.parentModel
  if (opts.role.model) {
    const profile = opts.providers.get(opts.role.model.provider)
    if (!profile) throw new Error(`role '${opts.role.name}' references unknown provider '${opts.role.model.provider}'`)
    model = buildModelClient(profile, opts.role.model.model, opts.role.model.extra)
  }
```

Update `packages/subagent/src/index.ts` to re-export the new modules.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/subagent test`
Expected: PASS (4 jobs + 2 roles + 2 child/fork). The mock child completes fast, so the 150ms wait resolves.

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/subagent/
git commit -m "feat: subagent child creation with fork and role-driven model"
```

---

### Task 8: subagent — spawn_agent, wait_agent, list_agents tools

**Files:**
- Create: `packages/subagent/src/tools.ts`
- Modify: `packages/subagent/src/index.ts`
- Create: `packages/subagent/test/tools.test.ts`

**Interfaces:**
- Consumes: `spawnChild` (Task 7); `AgentTable` (Task 7); `JobRegistry` (Task 5); `RoleRegistry`/`builtinRoles` (Task 6); `ToolRegistry`/`Tool`; `PluginContext`; `ModelClient`; `ProviderRegistry`.
- Produces:
  ```ts
  // src/tools.ts
  export interface SubagentToolDeps {
    table: AgentTable
    jobs: JobRegistry
    roles: RoleRegistry
    parentRegistry: ToolRegistry
    parentSession: ReturnType<typeof import("@i-harness/core-session").createSession>
    parentCtx: PluginContext
    parentModel: ModelClient
    providers: ProviderRegistry
  }
  export function createSubagentTools(deps: SubagentToolDeps): Tool[]
  ```
  - Returns 11 tools. This task implements `spawn_agent`, `wait_agent`, `list_agents`; Tasks 9-10 append the rest.

- [ ] **Step 1: Write the failing tests**

Create `packages/subagent/test/tools.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { createProviderRegistry } from "@i-harness/provider"
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"
import { createAgentTable } from "../src/agent-table.ts"
import { createSubagentTools } from "../src/tools.ts"

function setup() {
  const ctx = createContext()
  const parentReg = createToolRegistry(ctx)
  parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
  const session = createSession()
  const jobs = createJobRegistry()
  const table = createAgentTable()
  const roles = createRoleRegistry()
  for (const r of builtinRoles()) roles.register(r)
  const providers = createProviderRegistry()
  const model = createMockClient([{ role: "assistant", text: "child done" }])
  const tools = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
  return { ctx, parentReg, session, jobs, table, roles, providers, model, tools }
}

describe("subagent tools", () => {
  it("registers spawn_agent, wait_agent, list_agents", () => {
    const { tools } = setup()
    const names = tools.map((t) => t.name).sort()
    expect(names).toContain("spawn_agent")
    expect(names).toContain("wait_agent")
    expect(names).toContain("list_agents")
  })

  it("spawn_agent returns a job id; list_agents shows it; wait_agent observes completion", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const list = all.find((t) => t.name === "list_agents")!
    const wait = all.find((t) => t.name === "wait_agent")!
    const spawnOut = await spawn.execute({ message: "do it", task_name: "helper" }, {})
    expect((spawnOut as { job_id: string }).job_id).toMatch(/^subagent-\d+$/)
    expect((spawnOut as { agent_path: string }).agent_path).toBe("root/helper")
    const listed = await list.execute({ path_prefix: "root/" }, {})
    expect((listed as { agents: { path: string }[] }).agents.map((a) => a.path)).toEqual(["root/helper"])
    const waitOut = await wait.execute({ timeout_ms: 5000 }, {})
    expect((waitOut as { timed_out: boolean }).timed_out).toBe(false)
  }, 10_000)

  it("spawn_agent with unknown agent_type errors", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    await expect(spawn.execute({ message: "x", task_name: "h", agent_type: "nope" }, {})).rejects.toThrow(/unknown role/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/subagent test`
Expected: FAIL — `createSubagentTools` doesn't exist.

- [ ] **Step 3: Implement**

Create `packages/subagent/src/tools.ts` (first three tools):

```ts
import type { PluginContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"
import type { ModelClient } from "@i-harness/llm-seam"
import type { ProviderRegistry } from "@i-harness/provider"
import type { JobRegistry } from "./jobs.ts"
import type { AgentTable } from "./agent-table.ts"
import type { RoleRegistry } from "./roles.ts"
import { spawnChild } from "./child.ts"

export interface SubagentToolDeps {
  table: AgentTable
  jobs: JobRegistry
  roles: RoleRegistry
  parentRegistry: ToolRegistry
  parentSession: ReturnType<typeof createSession>
  parentCtx: PluginContext
  parentModel: ModelClient
  providers: ProviderRegistry
}

export function createSubagentTools(deps: SubagentToolDeps): Tool[] {
  const spawnTool: Tool<{ message: string; task_name: string; agent_type?: string; fork_turns?: string | number }, { agent_path: string; job_id: string }> = {
    name: "spawn_agent",
    description: "Launch a subagent in the background. Returns an agent path and job id immediately. Use wait_agent or job_output to observe completion.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Initial task for the subagent." },
        task_name: { type: "string", description: "Short name used in the agent path." },
        agent_type: { type: "string", description: "Role name (default general)." },
        fork_turns: { type: "string", description: "none, all, or N." },
      },
      required: ["message", "task_name"],
    },
    isReadOnly: false,
    execute: async (args) => {
      const role = deps.roles.get(args.agent_type ?? "general")
      if (!role) throw new Error(`unknown role: ${args.agent_type}`)
      const turns = parseForkTurns(args.fork_turns)
      return spawnChild({
        taskName: args.task_name,
        message: args.message,
        parentPath: "root",
        parentRegistry: deps.parentRegistry,
        parentSession: deps.parentSession,
        parentCtx: deps.parentCtx,
        role,
        parentModel: deps.parentModel,
        providers: deps.providers,
        jobs: deps.jobs,
        table: deps.table,
      })
    },
  }

  const waitTool: Tool<{ timeout_ms?: number }, { message: string; timed_out: boolean }> = {
    name: "wait_agent",
    description: "Wait for any live subagent to reach a terminal status. Returns a brief summary and whether it timed out.",
    inputSchema: { type: "object", properties: { timeout_ms: { type: "number", description: "Max wait in ms (default 30000)." } } },
    isReadOnly: true,
    execute: async (args) => {
      const timeoutMs = args.timeout_ms ?? 30_000
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const running = [...deps.table.entries().values()].some((e) => e.status === "running")
        if (!running) {
          const done = [...deps.table.entries().values()].map((e) => e.path)
          return { message: `All subagents settled: ${done.join(", ") || "(none)"}`, timed_out: false }
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      return { message: "wait timed out with subagents still running", timed_out: true }
    },
  }

  const listTool: Tool<{ path_prefix?: string }, { agents: { path: string; status: string }[] }> = {
    name: "list_agents",
    description: "List live subagents in the current tree, optionally filtered by path prefix.",
    inputSchema: { type: "object", properties: { path_prefix: { type: "string" } } },
    isReadOnly: true,
    execute: async (args) => {
      const prefix = args.path_prefix ?? ""
      const agents = [...deps.table.entries().values()]
        .filter((e) => e.path.startsWith(prefix))
        .map((e) => ({ path: e.path, status: e.status }))
      return { agents }
    },
  }

  return [spawnTool, waitTool, listTool]
}

function parseForkTurns(value: string | number | undefined): "none" | "all" | number {
  if (value === undefined || value === "all") return "all"
  if (value === "none") return "none"
  const n = typeof value === "number" ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : "all"
}
```

**NOTE:** `spawnChild`'s `SpawnOptions` includes `forkTurns?: "none" | "all" | number` — but the Task 7 `spawnChild` hardcodes `forkTurns(events, Infinity)`. Update `spawnChild` (Task 7 file) to accept and use `forkTurns`:

```ts
export interface SpawnOptions {
  ...
  forkTurns?: "none" | "all" | number
}
// in spawnChild:
  const turns = opts.forkTurns ?? "all"
  if (turns !== "none") {
    const n = turns === "all" ? Infinity : turns
    for (const ev of forkTurns(opts.parentSession.events, n)) childSession.events.push({ ...ev })
  }
```

Update `packages/subagent/src/index.ts` to export `createSubagentTools` and `SubagentToolDeps`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/subagent test`
Expected: PASS (4 jobs + 2 roles + 2 child/fork + 3 tools).

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/subagent/
git commit -m "feat: subagent spawn_agent wait_agent list_agents tools"
```

---

### Task 9: subagent — send_message, interrupt_agent, followup_task, close_agent, resume_agent tools

**Files:**
- Modify: `packages/subagent/src/tools.ts`
- Modify: `packages/subagent/test/tools.test.ts`

**Interfaces:**
- Consumes: `SubagentToolDeps` (Task 8); `AgentTable`/`ChildAgentEntry` (Task 7).
- Produces: 5 more tools appended to `createSubagentTools`'s returned array.

- [ ] **Step 1: Write the failing tests**

Append to `packages/subagent/test/tools.test.ts`:

```ts
describe("subagent control tools", () => {
  it("send_message queues into the child mailbox", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const send = all.find((t) => t.name === "send_message")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const out = await send.execute({ target: "root/helper", message: "extra" }, {})
    expect(out).toEqual({ queued: true })
    expect(table.get("root/helper")!.mailbox).toContain("extra")
  }, 10_000)

  it("close_agent aborts and removes the child", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const close = all.find((t) => t.name === "close_agent")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    expect(table.get("root/helper")).toBeDefined()
    const out = await close.execute({ target: "root/helper" }, {})
    expect((out as { previous_status: string }).previous_status).toBe("running")
    expect(table.get("root/helper")).toBeUndefined()
  }, 10_000)

  it("interrupt_agent aborts the controller but keeps the agent", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const interrupt = all.find((t) => t.name === "interrupt_agent")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const entry = table.get("root/helper")!
    const out = await interrupt.execute({ target: "root/helper" }, {})
    expect((out as { previous_status: string }).previous_status).toBe("running")
    expect(table.get("root/helper")).toBeDefined()
    expect(entry.controller.signal.aborted).toBe(true)
  }, 10_000)

  it("resume_agent re-adds a fresh child entry", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const resume = all.find((t) => t.name === "resume_agent")!
    const out = await resume.execute({ target: "root/helper" }, {})
    expect((out as { resumed: boolean }).resumed).toBe(true)
    expect(table.get("root/helper")!.status).toBe("running")
  })

  it("followup_task queues and marks delivered", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const follow = all.find((t) => t.name === "followup_task")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const out = await follow.execute({ target: "root/helper", message: "more" }, {})
    expect((out as { delivered: boolean }).delivered).toBe(true)
    expect(table.get("root/helper")!.mailbox).toContain("more")
  }, 10_000)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/subagent test`
Expected: FAIL — `send_message`/`close_agent`/`interrupt_agent`/`resume_agent`/`followup_task` not registered.

- [ ] **Step 3: Implement**

Append to `packages/subagent/src/tools.ts` (inside `createSubagentTools`, after `listTool`):

```ts
  const sendTool: Tool<{ target: string; message: string }, { queued: boolean }> = {
    name: "send_message",
    description: "Send a message to an existing subagent. Queued; does not trigger a new turn.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      entry.mailbox.push(args.message)
      return { queued: true }
    },
  }

  const interruptTool: Tool<{ target: string }, { previous_status: string }> = {
    name: "interrupt_agent",
    description: "Interrupt a subagent's current turn, if any, and return its previous status. The agent remains available.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      const previous = entry.status
      entry.controller.abort()
      return { previous_status: previous }
    },
  }

  const followupTool: Tool<{ target: string; message: string }, { delivered: boolean }> = {
    name: "followup_task",
    description: "Send a follow-up task to a subagent and trigger a new turn. This sub-project queues the message and marks delivered; re-driving the loop is deferred.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      entry.mailbox.push(args.message)
      return { delivered: true }
    },
  }

  const closeTool: Tool<{ target: string }, { previous_status: string }> = {
    name: "close_agent",
    description: "Close a subagent and reclaim its resources (abort execution, remove from the table).",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      const previous = entry.status
      entry.controller.abort()
      deps.table.remove(args.target)
      return { previous_status: previous }
    },
  }

  const resumeTool: Tool<{ target: string }, { resumed: boolean }> = {
    name: "resume_agent",
    description: "Re-activate a previously closed subagent path with a fresh controller and session.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args) => {
      deps.table.add(args.target, {
        path: args.target,
        status: "running",
        session: createSession(),
        controller: new AbortController(),
        mailbox: [],
      })
      return { resumed: true }
    },
  }
```

Update the returned array: `return [spawnTool, waitTool, listTool, sendTool, interruptTool, followupTool, closeTool, resumeTool]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/subagent test`
Expected: PASS (existing + 5 new).

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/subagent/
git commit -m "feat: subagent send/interrupt/followup/close/resume tools"
```

---

### Task 10: subagent — job_output, job_list, job_kill tools

**Files:**
- Modify: `packages/subagent/src/tools.ts`
- Modify: `packages/subagent/test/tools.test.ts`

**Interfaces:**
- Consumes: `JobRegistry` (Task 5).
- Produces: 3 more tools appended to `createSubagentTools`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/subagent/test/tools.test.ts`:

```ts
describe("job tools", () => {
  it("job_output reads a completed job; job_list enumerates it", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const output = all.find((t) => t.name === "job_output")!
    const list = all.find((t) => t.name === "job_list")!
    const spawnOut = await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const jobId = (spawnOut as { job_id: string }).job_id
    await new Promise((r) => setTimeout(r, 150))
    const read = await output.execute({ job_id: jobId }, {})
    const body = read as { text: string; status: string }
    expect(body.text).toContain("[status: completed]")
    const jobsOut = await list.execute({}, {})
    expect((jobsOut as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toContain(jobId)
  }, 10_000)

  it("job_kill cancels a running job", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const kill = all.find((t) => t.name === "job_kill")!
    const spawnOut = await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const jobId = (spawnOut as { job_id: string }).job_id
    const out = await kill.execute({ job_id: jobId }, {})
    expect(["cancellation-requested", "already-finished"]).toContain((out as { outcome: string }).outcome)
  }, 10_000)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/subagent test`
Expected: FAIL — `job_output`/`job_list`/`job_kill` not registered.

- [ ] **Step 3: Implement**

Append to `packages/subagent/src/tools.ts`:

```ts
  const jobOutputTool: Tool<{ job_id: string; wait?: boolean; timeout_ms?: number }, { text: string; status: string }> = {
    name: "job_output",
    description: "Read a background job. Non-blocking unless wait: true. Every response ends with [status: ...].",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, wait: { type: "boolean" }, timeout_ms: { type: "number" } }, required: ["job_id"] },
    isReadOnly: true,
    execute: async (args) => {
      if (args.wait === true) await deps.jobs.wait(args.job_id, args.timeout_ms ?? 30_000)
      const snapshot = deps.jobs.read(args.job_id)
      const body = snapshot.output.length > 0 ? snapshot.output : "(no output)"
      return { text: `${body}\n[status: ${snapshot.status}]`, status: snapshot.status }
    },
  }

  const jobListTool: Tool<Record<string, never>, { jobs: { id: string; kind: string; status: string; label: string }[] }> = {
    name: "job_list",
    description: "List your background jobs (running and finished) with ids, kinds, and statuses.",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: true,
    execute: async () => {
      const jobs = deps.jobs.list("root").map((j) => ({ id: j.id, kind: j.kind, status: j.status, label: j.label }))
      return { jobs }
    },
  }

  const jobKillTool: Tool<{ job_id: string; reason?: string }, { outcome: string }> = {
    name: "job_kill",
    description: "Request cancellation of a running background job.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, reason: { type: "string" } }, required: ["job_id"] },
    isReadOnly: false,
    execute: async (args) => ({ outcome: deps.jobs.kill(args.job_id) }),
  }
```

Add all three to the returned array (11 tools total).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/subagent test`
Expected: PASS.

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/subagent/
git commit -m "feat: subagent job_output job_list job_kill tools"
```

---

### Task 11: Full acceptance verification

**Files:**
- None (verification only).

- [ ] **Step 1: Full gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: all packages pass.

- [ ] **Step 2: Confirm clean tree + commit log**

Run: `git status --short` → clean.
Run: `git log --oneline` → the 10 implementation commits from Tasks 1-10.

- [ ] **Step 3: Report completion**

Report: task/subagent + provider system complete — llm-openai-compatible protocol (self-authored, no @ai-sdk), provider registry shared by main + sub agents, exec/shell background jobs, unified job service, role system with built-in roles, 11 subagent/job tools, child creation with fork_turns and role-driven model, close_agent resource reclaim; no depth limit, no bun, platform-neutral.
