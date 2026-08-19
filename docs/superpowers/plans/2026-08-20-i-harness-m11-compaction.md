# M11 Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add context-pressure auto-compaction and an explicit manual compact to the agent loop: when the estimated context usage crosses a threshold, the older part of the session log is replaced on the model-facing surface by a model-generated structured summary, while the durable log and FTS index keep every event.

**Architecture:** `core-session` gains `compaction/start|end|summary` event types and a shadow-aware `deriveMessages` projection. A new `@i-harness/compaction` package provides config validation, approx token estimation, region selection, a ModelClient-based summarizer, and the `CompactionEngine` (`maybeCompact`/`compact`). `core-agent` gets an optional `compact` config seam (step-boundary pressure check + explicit `agent.compact()`). The CLI passes a `compact` config through.

**Tech Stack:** Node >= 22.18, ESM + strict TS, vitest, pnpm workspaces.

## Global Constraints

- This project does NOT use bun. No `@ai-sdk/*` dependencies. No new external dependencies (only `workspace:*` links).
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- No `CURRENT_FORMAT_VERSION` bump. `compaction/*` event types are additive vocabulary (precedent: M9 `subagent/inbox`).
- **Log-preserving**: compaction NEVER deletes/rewrites events; only the `deriveMessages` projection shrinks.
- Behavior unchanged when `compact` is not configured.
- Config validated at engine construction (fail loud); defaults are Config fields (no hardcoded tunables).

---

### Task 1: core-session — compaction events + shadow-aware deriveMessages

**Files:**
- Modify: `packages/core-session/src/index.ts`
- Test: `packages/core-session/test/session.test.ts`

**Interfaces:**
- Produces: new `SessionEvent` members `compaction/start`, `compaction/end`, `compaction/summary { text, shadowedSeqs }`; shadow-aware `deriveMessages`; `deriveSearchText` handling for the new events. Tasks 2-3 depend on these.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core-session/test/session.test.ts`:

```ts
import { deriveSearchText, toJSONL, fromJSONL, createSession, append } from "../src/index.ts"

describe("compaction events", () => {
  it("new event types round-trip through JSONL", () => {
    const s = createSession()
    append(s, { type: "compaction/start" })
    append(s, { type: "compaction/summary", text: "summary text", shadowedSeqs: [0, 1, 2] })
    append(s, { type: "compaction/end" })
    const restored = fromJSONL(toJSONL(s))
    expect(restored.events.map((e) => e.type)).toEqual(["compaction/start", "compaction/summary", "compaction/end"])
    const summary = restored.events.find((e) => e.type === "compaction/summary") as { text: string; shadowedSeqs: number[] }
    expect(summary.text).toBe("summary text")
    expect(summary.shadowedSeqs).toEqual([0, 1, 2])
  })

  it("deriveMessages shadows the replaced seqs and renders the summary as a user message", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "old turn one" })
    append(s, { type: "assistant/message", text: "old reply" })
    append(s, { type: "user/message", text: "old turn two" })
    append(s, { type: "compaction/start" })
    append(s, { type: "compaction/summary", text: "COMPACTED HISTORY", shadowedSeqs: [0, 1, 2] })
    append(s, { type: "compaction/end" })
    append(s, { type: "user/message", text: "new work" })
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([
      { role: "user", content: "COMPACTED HISTORY" },
      { role: "user", content: "new work" },
    ])
  })

  it("deriveMessages without compaction events derives identically to today", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "a" })
    append(s, { type: "assistant/message", text: "b" })
    expect(deriveMessages(s)).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ])
  })

  it("a compaction summary never shadows a later compaction marker (disjoint sets compose)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "turn a" })
    append(s, { type: "compaction/start" })
    append(s, { type: "compaction/summary", text: "S1", shadowedSeqs: [0] })
    append(s, { type: "compaction/end" })
    append(s, { type: "user/message", text: "turn b" })
    append(s, { type: "compaction/start" })
    append(s, { type: "compaction/summary", text: "S2", shadowedSeqs: [4] })
    append(s, { type: "compaction/end" })
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([
      { role: "user", content: "S1" },
      { role: "user", content: "S2" },
    ])
  })

  it("deriveSearchText: summary → text, start/end → empty", () => {
    expect(deriveSearchText({ type: "compaction/summary", text: "s", shadowedSeqs: [] })).toBe("s")
    expect(deriveSearchText({ type: "compaction/start" })).toBe("")
    expect(deriveSearchText({ type: "compaction/end" })).toBe("")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-session && pnpm test`
Expected: FAIL — `compaction/summary` is not a valid `SessionEvent` member.

- [ ] **Step 3: Write minimal implementation**

In `packages/core-session/src/index.ts`:

1. Add the three members to the `SessionEvent` union (inside the `| (...)` group, before `& { ignorable? }`):

```ts
| { type: "compaction/start"; seq?: number }
| { type: "compaction/end"; seq?: number }
| { type: "compaction/summary"; text: string; shadowedSeqs: number[]; seq?: number }
```

2. In `deriveMessages`, add the shadow pre-pass at the top and the skip in the loop, plus the summary render:

```ts
export function deriveMessages(session: Session): LLMMessage[] {
  const result: LLMMessage[] = []
  let pendingCalls: { id: string; name: string; args: unknown }[] | undefined
  const pendingResults: LLMMessage[] = []
  // M11 compaction shadow pre-pass: collect every seq a compaction/summary
  // replaced on the surface so the render pass skips them. The raw log keeps
  // all events; only this projection shrinks.
  const shadowed = new Set<number>()
  for (const ev of session.events) {
    if (ev.type === "compaction/summary") for (const seq of ev.shadowedSeqs) shadowed.add(seq)
  }
  for (const ev of session.events) {
    if (ev.seq !== undefined && shadowed.has(ev.seq)) continue
    if (ev.type === "user/message") {
      flushToolBlock()
      result.push({ role: "user", content: ev.text })
    } else if (ev.type === "assistant/message") {
      flushToolBlock()
      result.push({ role: "assistant", content: ev.text })
    } else if (ev.type === "compaction/summary") {
      flushToolBlock()
      result.push({ role: "user", content: ev.text })
    } else if (ev.type === "tool/call") {
      pendingCalls ??= []
      pendingCalls.push({ id: ev.callId, name: ev.name, args: ev.args })
    } else if (ev.type === "tool/result") {
      pendingResults.push({ role: "tool", toolCallId: ev.callId, content: JSON.stringify(ev.output) })
    } else if (ev.type === "step/end") {
      flushToolBlock()
    }
  }
  flushToolBlock()
  return result

  function flushToolBlock() { /* unchanged */ }
}
```

3. In `deriveSearchText`, add the summary case:

```ts
case "compaction/summary":
  return ev.text
```

(`compaction/start`/`compaction/end` already fall through the default → `""`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core-session && pnpm test && pnpm typecheck`
Expected: PASS; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core-session/src/index.ts packages/core-session/test/session.test.ts
git commit -m "feat(core-session): compaction events + shadow-aware deriveMessages projection"
```

---

### Task 2: `@i-harness/compaction` — config, token estimation, region selection

**Files:**
- Create: `packages/compaction/package.json`, `packages/compaction/tsconfig.json`, `packages/compaction/src/config.ts`, `packages/compaction/src/tokens.ts`, `packages/compaction/src/region.ts`, `packages/compaction/src/index.ts`
- Test: `packages/compaction/test/compaction.test.ts`

**Interfaces:**
- Consumes: `Session`, `deriveSearchText`, `deriveMessages` from `@i-harness/core-session` (Task 1).
- Produces (used by Task 3):
  - `export function approxTokens(text: string): number`
  - `export function activeTokens(session: Session): number`
  - `export function selectShadowableRange(session: Session, retainTokens: number): number[]`
  - `export interface CompactionConfig` and `export interface ResolvedCompactionConfig`
  - `export function resolveConfig(config: CompactionConfig): ResolvedCompactionConfig` (validates + applies defaults)

- [ ] **Step 1: Scaffold the package**

`packages/compaction/package.json`:

```json
{
  "name": "@i-harness/compaction",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-session": "workspace:*",
    "@i-harness/llm-seam": "workspace:*"
  }
}
```

`packages/compaction/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Run `cd D:/agent-complete/I-harness && pnpm install` after creating both files.

- [ ] **Step 2: Write the failing tests**

`packages/compaction/test/compaction.test.ts`:

```ts
import { createSession, append } from "@i-harness/core-session"
import { approxTokens, activeTokens, selectShadowableRange, resolveConfig, type CompactionConfig } from "../src/index.ts"

describe("compaction config", () => {
  it("validates fail-loud and applies defaults", () => {
    expect(() => resolveConfig({ contextWindow: 0 })).toThrow(/contextWindow/)
    expect(() => resolveConfig({ contextWindow: 1.5 })).toThrow(/contextWindow/)
    expect(() => resolveConfig({ contextWindow: 100, thresholdRatio: 0 })).toThrow(/thresholdRatio/)
    expect(() => resolveConfig({ contextWindow: 100, thresholdRatio: 1.5 })).toThrow(/thresholdRatio/)
    expect(() => resolveConfig({ contextWindow: 100, retainTokens: -1 })).toThrow(/retainTokens/)
    expect(() => resolveConfig({ contextWindow: 100, maxTokens: 0 })).toThrow(/maxTokens/)
    const r = resolveConfig({ contextWindow: 2000 })
    expect(r).toMatchObject({ contextWindow: 2000, thresholdRatio: 0.8, retainTokens: 0, maxTokens: 1024, auto: true })
  })
})

describe("token estimation", () => {
  it("approxTokens is ceil(chars / 4)", () => {
    expect(approxTokens("abcd")).toBe(1)
    expect(approxTokens("abcde")).toBe(2)
    expect(approxTokens("")).toBe(0)
  })

  it("activeTokens sums the derived message contents", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "x".repeat(400) }) // ~100 tokens
    append(s, { type: "assistant/message", text: "y".repeat(400) }) // ~100 tokens
    expect(activeTokens(s)).toBe(200)
  })
})

describe("region selection", () => {
  it("shadowedSeqs = events below the retention budget, excluding compaction markers", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "a".repeat(400) }) // seq 0, ~100 tokens
    append(s, { type: "user/message", text: "b".repeat(400) }) // seq 1, ~100 tokens
    append(s, { type: "compaction/summary", text: "old", shadowedSeqs: [0, 1] }) // seq 2 (marker)
    append(s, { type: "user/message", text: "c".repeat(400) }) // seq 3, ~100 tokens
    // retainTokens=150 keeps the tail (~seq 3 + part of seq 1), shadows seq 0 only
    const shadowed = selectShadowableRange(s, 150)
    expect(shadowed).toEqual([0]) // seq 1 is part of the retained tail; the compaction/summary marker is never shadowed
  })

  it("retainTokens 0 shadows everything except compaction markers", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "x" })
    append(s, { type: "tool/call", callId: "c", name: "bash", args: { command: "hi" } })
    append(s, { type: "compaction/start" })
    const shadowed = selectShadowableRange(s, 0)
    expect(shadowed).toEqual([0, 1])
  })

  it("a session that fits entirely in the retention budget shadows nothing", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    expect(selectShadowableRange(s, 100)).toEqual([])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/compaction && pnpm test`
Expected: FAIL — imports don't resolve.

- [ ] **Step 4: Write minimal implementation**

`packages/compaction/src/config.ts`:

```ts
import type { ModelClient } from "@i-harness/llm-seam"

export interface CompactionConfig {
  contextWindow: number
  thresholdRatio?: number
  retainTokens?: number
  maxTokens?: number
  summarizationModel?: ModelClient
  auto?: boolean
}

export interface ResolvedCompactionConfig {
  contextWindow: number
  thresholdRatio: number
  retainTokens: number
  maxTokens: number
  summarizationModel?: ModelClient
  auto: boolean
}

export function resolveConfig(config: CompactionConfig): ResolvedCompactionConfig {
  if (!Number.isInteger(config.contextWindow) || config.contextWindow <= 0) {
    throw new Error(`compaction: contextWindow must be a positive integer (got ${config.contextWindow})`)
  }
  const thresholdRatio = config.thresholdRatio ?? 0.8
  if (!(thresholdRatio > 0 && thresholdRatio <= 1)) {
    throw new Error(`compaction: thresholdRatio must be in (0, 1] (got ${thresholdRatio})`)
  }
  const retainTokens = config.retainTokens ?? 0
  if (!Number.isInteger(retainTokens) || retainTokens < 0) {
    throw new Error(`compaction: retainTokens must be a non-negative integer (got ${retainTokens})`)
  }
  const maxTokens = config.maxTokens ?? 1024
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new Error(`compaction: maxTokens must be a positive integer (got ${maxTokens})`)
  }
  const auto = config.auto ?? true
  return { contextWindow: config.contextWindow, thresholdRatio, retainTokens, maxTokens, auto, summarizationModel: config.summarizationModel }
}
```

`packages/compaction/src/tokens.ts`:

```ts
import type { Session } from "@i-harness/core-session"
import { deriveMessages } from "@i-harness/core-session"

export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function activeTokens(session: Session): number {
  let total = 0
  for (const m of deriveMessages(session)) total += approxTokens(m.content)
  return total
}
```

`packages/compaction/src/region.ts`:

```ts
import type { Session, SessionEvent } from "@i-harness/core-session"
import { deriveSearchText } from "@i-harness/core-session"

function isCompactionMarker(ev: SessionEvent): boolean {
  return ev.type === "compaction/start" || ev.type === "compaction/end" || ev.type === "compaction/summary"
}

// Events strictly before the first event whose cumulative tail crosses the
// retention budget are shadowable (compaction markers never are). An empty
// budget shadows everything except markers; a budget covering the whole
// session shadows nothing.
export function selectShadowableRange(session: Session, retainTokens: number): number[] {
  const shadowed: number[] = []
  if (retainTokens <= 0) {
    for (const ev of session.events) {
      if (ev.seq === undefined || isCompactionMarker(ev)) continue
      shadowed.push(ev.seq)
    }
    return shadowed
  }
  let tail = 0
  let firstRetainedSeq: number | null = null
  for (let i = session.events.length - 1; i >= 0; i--) {
    const ev = session.events[i]!
    if (isCompactionMarker(ev)) continue
    tail += approxTokens(deriveSearchText(ev))
    if (tail >= retainTokens) {
      firstRetainedSeq = ev.seq ?? i
      break
    }
  }
  if (firstRetainedSeq === null) return shadowed
  for (const ev of session.events) {
    if (ev.seq === undefined || isCompactionMarker(ev)) continue
    if (ev.seq < firstRetainedSeq) shadowed.push(ev.seq)
  }
  return shadowed
}
```

(Import `approxTokens` from `./tokens.ts` in region.ts.)

`packages/compaction/src/index.ts`:

```ts
export { approxTokens, activeTokens } from "./tokens.ts"
export { selectShadowableRange } from "./region.ts"
export { resolveConfig } from "./config.ts"
export type { CompactionConfig, ResolvedCompactionConfig } from "./config.ts"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/compaction && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/compaction
git commit -m "feat(compaction): config validation, approx token estimation, region selection"
```

---

### Task 3: `@i-harness/compaction` — engine + summarizer + event append

**Files:**
- Modify: `packages/compaction/src/index.ts`, `packages/compaction/src/summarizer.ts` (new)
- Test: `packages/compaction/test/engine.test.ts`

**Interfaces:**
- Consumes: Task 1 (`append`, `SessionEvent`), Task 2 (`approxTokens`, `activeTokens`, `selectShadowableRange`, `resolveConfig`, `CompactionConfig`), `ModelClient`/`LLMRequest` from `@i-harness/llm-seam`.
- Produces: `CompactionResult`, `CompactionEngine`, `createCompactionEngine(deps: { model: ModelClient; config: CompactionConfig }): CompactionEngine`. Task 4 consumes these.

- [ ] **Step 1: Write the failing tests**

`packages/compaction/test/engine.test.ts`:

```ts
import { createSession, append, deriveMessages } from "@i-harness/core-session"
import type { ModelClient, LLMStreamEvent } from "@i-harness/llm-seam"
import { createCompactionEngine, type CompactionConfig } from "../src/index.ts"

function mockModel(text: string): ModelClient {
  return {
    async *stream(): AsyncIterable<LLMStreamEvent> {
      yield { type: "text/chunk", text }
      yield { type: "end" }
    },
  }
}

const config: CompactionConfig = { contextWindow: 1000, thresholdRatio: 0.5, maxTokens: 50 }

function longSession() {
  const s = createSession()
  for (let i = 0; i < 20; i++) append(s, { type: "user/message", text: "word ".repeat(80) }) // each ~100 tokens
  return s
}

describe("compaction engine", () => {
  it("maybeCompact triggers above threshold and appends start/summary/end", async () => {
    const s = longSession() // ~2000 tokens > 500 threshold
    const engine = createCompactionEngine({ model: mockModel("## Primary Request and Intent\n- do x"), config })
    const result = await engine.maybeCompact(s)
    expect(result.compacted).toBe(true)
    expect(result.shadowedSeqs.length).toBeGreaterThan(0)
    expect(result.summary).toContain("Primary Request")
    const types = s.events.map((e) => e.type)
    expect(types.slice(-3)).toEqual(["compaction/start", "compaction/summary", "compaction/end"])
    // the surface shrinks and shows the summary
    const msgs = deriveMessages(s)
    expect(msgs[0]!.content).toContain("Primary Request")
  })

  it("maybeCompact below threshold is a no-op", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" }) // tiny
    const engine = createCompactionEngine({ model: mockModel("x"), config })
    const result = await engine.maybeCompact(s)
    expect(result).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(s.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
  })

  it("compact is explicit (no pressure check) while maybeCompact is gated", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" }) // tiny session
    const engine = createCompactionEngine({ model: mockModel("summary"), config }) // retainTokens default 0
    expect((await engine.maybeCompact(s)).compacted).toBe(false) // tiny → below threshold → gated
    const result = await engine.compact(s)
    expect(result.compacted).toBe(true) // explicit call has no pressure gate; the single event is shadowable
    expect(result.shadowedSeqs).toEqual([0])
  })

  it("summarizer failure is fail-soft: no events appended", async () => {
    const failing: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        yield { type: "error", error: new Error("model exploded") }
      },
    }
    const s = longSession()
    const engine = createCompactionEngine({ model: failing, config })
    const result = await engine.compact(s)
    expect(result).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(s.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
  })

  it("empty summarizer output is fail-soft", async () => {
    const empty: ModelClient = { async *stream(): AsyncIterable<LLMStreamEvent> { yield { type: "end" } } }
    const s = longSession()
    const engine = createCompactionEngine({ model: empty, config })
    expect((await engine.compact(s)).compacted).toBe(false)
  })

  it("summary is truncated to maxTokens (approx)", async () => {
    const engine = createCompactionEngine({ model: mockModel("y".repeat(1000)), config })
    const s = longSession()
    const result = await engine.compact(s)
    expect(result.compacted).toBe(true)
    expect(result.summary!.length).toBeLessThanOrEqual(50 * 4)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/compaction && pnpm test`
Expected: FAIL — `createCompactionEngine` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/compaction/src/summarizer.ts`:

```ts
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { approxTokens } from "./tokens.ts"

const COMPACTION_INSTRUCTION = [
  "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
  "",
  "Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.",
  "",
  "## Primary Request and Intent",
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  "",
  "## Key Technical Concepts",
  "- [technologies, frameworks, patterns, and conventions in play]",
  "",
  "## Files and Code",
  "- [exact path: why it matters, key changes or snippets]",
  "",
  "## Errors and Fixes",
  "- [error: how it was resolved, plus any related user feedback]",
  "",
  "## Pending Jobs",
  "- [explicitly requested work not yet completed]",
  "",
  "## Current Work",
  "- [precisely what was in progress at this checkpoint]",
  "",
  "## Next Step",
  "- [the single next action, directly in line with the most recent request, or \"(none)\"]",
  "",
  "## Critical Context",
  "- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
].join("\n")

function trimToTokens(text: string, maxTokens: number): string {
  return text.slice(0, maxTokens * 4)
}

export async function summarizeWithModel(
  model: ModelClient,
  replayText: string,
  maxTokens: number,
): Promise<string> {
  const request: LLMRequest = {
    messages: [{ role: "user", content: `${COMPACTION_INSTRUCTION}\n\n${replayText}` }],
    tools: [],
    systemPrompt: "",
  }
  let out = ""
  for await (const ev of model.stream(request)) {
    if (ev.type === "text/chunk") out += ev.text
    else if (ev.type === "error") throw ev.error
    else if (ev.type === "end") break
  }
  const trimmed = out.trim()
  if (trimmed.length === 0) throw new Error("compaction: summarizer returned empty output")
  return approxTokens(trimmed) > maxTokens ? trimToTokens(trimmed, maxTokens) : trimmed
}
```

In `packages/compaction/src/index.ts`, add:

```ts
import type { Session } from "@i-harness/core-session"
import { append, deriveSearchText } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"
import { resolveConfig, type CompactionConfig, type ResolvedCompactionConfig } from "./config.ts"
import { activeTokens } from "./tokens.ts"
import { selectShadowableRange } from "./region.ts"
import { summarizeWithModel } from "./summarizer.ts"

export interface CompactionResult {
  compacted: boolean
  shadowedSeqs: number[]
  summary?: string
}

export interface CompactionEngine {
  maybeCompact(session: Session): Promise<CompactionResult>
  compact(session: Session): Promise<CompactionResult>
}

export function createCompactionEngine(deps: { model: ModelClient; config: CompactionConfig }): CompactionEngine {
  const config = resolveConfig(deps.config)

  async function compactOnce(session: Session): Promise<CompactionResult> {
    const shadowedSeqs = selectShadowableRange(session, config.retainTokens)
    if (shadowedSeqs.length === 0) return { compacted: false, shadowedSeqs: [] }
    const replayText = renderShadowed(session, shadowedSeqs)
    const model = config.summarizationModel ?? deps.model
    let summary: string
    try {
      summary = await summarizeWithModel(model, replayText, config.maxTokens)
    } catch {
      // Fail-soft: never block the agent on a summarizer failure.
      return { compacted: false, shadowedSeqs: [] }
    }
    append(session, { type: "compaction/start" })
    append(session, { type: "compaction/summary", text: summary, shadowedSeqs })
    append(session, { type: "compaction/end" })
    return { compacted: true, shadowedSeqs, summary }
  }

  return {
    async maybeCompact(session: Session): Promise<CompactionResult> {
      if (activeTokens(session) < config.contextWindow * config.thresholdRatio) {
        return { compacted: false, shadowedSeqs: [] }
      }
      return compactOnce(session)
    },
    compact: compactOnce,
  }
}

function renderShadowed(session: Session, shadowedSeqs: number[]): string {
  const set = new Set(shadowedSeqs)
  const parts: string[] = []
  for (const ev of session.events) {
    if (ev.seq !== undefined && set.has(ev.seq)) {
      const t = deriveSearchText(ev)
      if (t.length > 0) parts.push(t)
    }
  }
  return parts.join("\n")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/compaction && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/compaction
git commit -m "feat(compaction): CompactionEngine with pressure trigger, summarizer, and event append"
```

---

### Task 4: core-agent — optional compaction seam

**Files:**
- Modify: `packages/core-agent/src/index.ts`, `packages/core-agent/test/agent.test.ts`
- Modify: `packages/core-agent/package.json` (add `@i-harness/compaction` dependency)

**Interfaces:**
- Consumes: `createCompactionEngine`, `CompactionConfig`, `CompactionResult` (Task 3); `ModelClient` (already a dep).
- Produces: `AgentConfig.compact?: CompactionConfig`; `Agent.compact(): Promise<CompactionResult>`.

- [ ] **Step 1: Add the dependency**

Add `"@i-harness/compaction": "workspace:*"` to `packages/core-agent/package.json` `dependencies`. Run `cd D:/agent-complete/I-harness && pnpm install`.

- [ ] **Step 2: Write the failing tests**

Add to `packages/core-agent/test/agent.test.ts` (use the existing `makeDeps`/`createContext` harness — an inline structural `ModelClient` like the reasoning test uses, NOT a script-based `createMockClient`, because the summarizer shares the model and script steps are one-shot):

```ts
import { createAgent } from "../src/index.ts"
import { deriveMessages } from "@i-harness/core-session"

describe("agent compaction seam", () => {
  it("auto-compacts at a step boundary when under pressure", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = {
      async *stream() {
        yield { type: "text/chunk", text: "summary and reply ".repeat(40) }
        yield { type: "end" }
      },
    }
    const agent = createAgent(ctx, {
      ...deps, systemPrompt: "p",
      compact: { contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0 },
    })
    const result = await agent.run("z".repeat(300)) // ~75 tokens ≥ 50 threshold → compacts at step 1's boundary
    expect(deps.session.events.some((e) => e.type === "compaction/summary")).toBe(true)
    const summary = deps.session.events.find((e) => e.type === "compaction/summary") as { text: string }
    const msgs = deriveMessages(deps.session)
    expect(msgs[0]).toEqual({ role: "user", content: summary.text })
    expect(result.finalText).toContain("summary and reply")
  })

  it("no compact config → no engine, identical behavior", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = { async *stream() { yield { type: "text/chunk", text: "done" }; yield { type: "end" } } }
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p" })
    await agent.run("task")
    expect(deps.session.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
  })

  it("explicit agent.compact() appends the compaction events", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = { async *stream() { yield { type: "text/chunk", text: "reply ".repeat(20) }; yield { type: "end" } } }
    const agent = createAgent(ctx, {
      ...deps, systemPrompt: "p",
      compact: { contextWindow: 100000, retainTokens: 0 }, // window huge so auto never fires
    })
    await agent.run("task")
    const res = await agent.compact()
    expect(res.compacted).toBe(true)
    expect(res.shadowedSeqs.length).toBeGreaterThan(0)
    expect(deps.session.events.slice(-3).map((e) => e.type)).toEqual(["compaction/start", "compaction/summary", "compaction/end"])
  })
})
```

Note: the compaction summarizer shares the agent's model — with an inline structural client every `stream()` call (agent turn or summarizer) yields the same text, which is what makes these tests deterministic.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/core-agent && pnpm test`
Expected: FAIL — `compact` is not a known AgentConfig field.

- [ ] **Step 4: Write minimal implementation**

In `packages/core-agent/src/index.ts`:

1. Import:

```ts
import { createCompactionEngine, type CompactionConfig, type CompactionResult } from "@i-harness/compaction"
```

2. Add to `AgentConfig`:

```ts
compact?: CompactionConfig // M11: enable context-pressure auto-compaction (requires contextWindow)
```

3. Add to `Agent` interface:

```ts
compact(): Promise<CompactionResult>
```

4. In `createAgent`, build the engine and add the step-boundary check:

```ts
const compactor = deps.compact ? createCompactionEngine({ model: deps.model, config: deps.compact }) : undefined
const compactEnabled = deps.compact?.auto ?? true
```

In `runTurn`'s step loop, right after `append(deps.session, { type: "step/start" })`:

```ts
// M11 compaction: pressure check at the step boundary, before the model sees
// the derived surface. Compaction only ever runs between steps.
if (compactor && compactEnabled) await compactor.maybeCompact(deps.session)
```

5. Return `compact` on the agent:

```ts
return {
  run,
  followup,
  compact: async () => (compactor ? compactor.compact(deps.session) : { compacted: false, shadowedSeqs: [] }),
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/core-agent && pnpm test && pnpm typecheck`
Expected: PASS; existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core-agent
git commit -m "feat(core-agent): optional compaction seam (step-boundary pressure check + agent.compact)"
```

---

### Task 5: CLI wiring + e2e

**Files:**
- Modify: `apps/cli/src/run.ts`, `apps/cli/test/cli.test.ts`
- Modify: `apps/cli/package.json` (add `@i-harness/compaction` dependency)

**Interfaces:**
- Consumes: `CompactionConfig` (Task 3).

- [ ] **Step 1: Add the dependency**

Add `"@i-harness/compaction": "workspace:*"` to `apps/cli/package.json` `dependencies`. Run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

Add to `apps/cli/test/cli.test.ts`:

```ts
import type { ModelClient } from "@i-harness/llm-seam"
import type { CompactionConfig } from "@i-harness/compaction"
import { deriveMessages } from "@i-harness/core-session"

describe("headless CLI M11 compaction", () => {
  it("auto-compacts a long session and completes normally", async () => {
    const compact: CompactionConfig = { contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0, maxTokens: 200 }
    // Inline structural model: every stream() call (agent turn OR the shared
    // summarizer call) yields the same long text, so the e2e is deterministic
    // (a script-based createMockClient would be consumed by the summarizer).
    const model: ModelClient = {
      async *stream() {
        yield { type: "text/chunk", text: "compacted work summary line ".repeat(20) }
        yield { type: "end" }
      },
    }
    const result = await runHeadless("z".repeat(300), { // ~75 tokens ≥ 50 threshold at step 1
      workspace: dir, approveAll: true, compact, model,
    })
    expect(result.exitCode).toBe(0)
    const summary = result.session!.events.find((e) => e.type === "compaction/summary")
    expect(summary).toBeDefined()
    // the summary is model-visible in the final derived surface
    const msgs = deriveMessages(result.session!)
    expect(msgs[0]).toEqual({ role: "user", content: (summary as { text: string }).text })
    expect(result.finalText).toContain("compacted work summary line")
  })

  it("no compact config → no compaction events, behavior unchanged", async () => {
    const result = await runHeadless("plain", { workspace: dir, approveAll: true, mockScript: [{ role: "assistant", text: "ok" }] })
    expect(result.exitCode).toBe(0)
    expect(result.session!.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
  })
})
```

(The inline `model` option replaces `mockScript` for the compaction e2e — `runHeadless` accepts `opts.model`. This avoids the summarizer consuming script steps.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/cli && pnpm test`
Expected: FAIL — `compact` is not a known HeadlessOptions field.

- [ ] **Step 4: Write minimal implementation**

In `apps/cli/src/run.ts`:

1. Import:

```ts
import type { CompactionConfig } from "@i-harness/compaction"
```

2. Add to `HeadlessOptions`:

```ts
compact?: CompactionConfig // M11: enable context-pressure auto-compaction
```

3. Pass through to `createAgent`:

```ts
const agent = createAgent(ctx, {
  session, tools, model,
  systemPrompt: "You are a coding agent.",
  ...(opts.compact ? { compact: opts.compact } : {}),
})
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/cli && pnpm test && pnpm typecheck`
Expected: PASS; existing CLI tests still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/cli
git commit -m "feat(cli): pass compaction config through to the agent"
```

---

### Task 6: Full gates

- [ ] **Step 1: Run the full suite**

Run: `cd D:/agent-complete/I-harness && pnpm -r test && pnpm -r typecheck`
Expected: both exit 0.

- [ ] **Step 2: Verify constraints**

- No `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` changes: `git diff HEAD --stat` shows no version-constant edits.
- No new external deps: `git diff HEAD -- '*/package.json'` shows only `workspace:*` additions (`@i-harness/compaction` in core-agent + apps/cli; new package importer).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: M11 compaction (context-pressure auto + manual compact)" || true
```

## Out of Scope (from spec §6)

- Remote/overflow compaction, per-model policy routing, progress UI/hooks, tool-result pruning.
- Deleting/truncating the durable log — compaction only shadows the surface.
- Token meter service — built-in approx estimator only.
- No `CURRENT_FORMAT_VERSION` bump; no schema changes.
