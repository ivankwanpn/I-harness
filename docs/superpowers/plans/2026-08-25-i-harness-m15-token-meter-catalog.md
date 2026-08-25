# M15 Token Meter + Per-Model Context Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a zero-external-dep pure-function token meter (`packages/token-meter`, dsh-style fixed-density `chars/4` + block/role overhead), extend `ProviderProfile` with per-model context windows, wire compaction to the catalog (catalog-first / config-fallback), and close M14's I3 gate (tool-string base64 masking).

**Architecture:** `packages/token-meter` is the single source of truth for token estimation (`estimateContent` / `estimateMessage` / `activeTokens` / `breakdown`). `packages/provider` gains `contextWindow`/`maxContextWindow`/`modelContexts` fields + pure `resolveModelContext`. `packages/compaction` delegates `activeTokens` to token-meter (keeping `approxTokens` as a content-only thin wrapper — used by `region.ts`/`summarizer.ts`), exports `resolveContextWindow`, and accepts optional `profile`/`modelId` in `createCompactionEngine`. `packages/llm-seam` masks `dataBase64` inside tool-role string content when projecting for a text-only model.

**Tech Stack:** TypeScript (strict, ESM), pnpm workspaces, vitest. Zero new external dependencies — only workspace links (`@i-harness/token-meter` is a new internal package; `compaction` adds workspace links to `provider` + `token-meter`).

## Global Constraints

- No bun. No `@ai-sdk/*`. No new EXTERNAL dependencies (workspace links only).
- ESM + strict TS; tests under `test/*.test.ts` per package; vitest run per package (`pnpm -r test` at root = `vitest run` in each package).
- No version bumps; no new session event types; `CURRENT_FORMAT_VERSION` stays 1.
- Constants: `CHARS_PER_TOKEN = 4`, `BLOCK_OVERHEAD = 4`, `ROLE_OVERHEAD = 4`, `IMAGE_TOKEN_ESTIMATE = 1024` (moved verbatim from compaction, value unchanged).
- Estimation always uses `Math.ceil`.
- Pricing rules (per message, recursive):
  - `user`/`tool` string content: `ceil(len/4) + ROLE_OVERHEAD`.
  - `user`/`tool` parts array: `ROLE_OVERHEAD + Σ per part` — text part `ceil(text/4) + BLOCK_OVERHEAD`; image part `IMAGE_TOKEN_ESTIMATE + BLOCK_OVERHEAD`.
  - `assistant` message: `ROLE_OVERHEAD + (content non-empty ? ceil(content/4) + BLOCK_OVERHEAD : 0) + Σ per toolCall: ceil(name/4) + ceil(argsJson/4) + BLOCK_OVERHEAD` where `argsJson = JSON.stringify(call.args) ?? ""` (`JSON.stringify` can return `undefined`).
- `approxTokens` (public, M14) keeps its content-only semantics: string → `ceil(len/4)`; parts → Σ (`text: ceil/4`, `image: IMAGE_TOKEN_ESTIMATE`). NO block/role overhead. Callers: `region.ts`, `summarizer.ts`, `compaction.test.ts`.
- `activeTokens` semantics CHANGE (M14 → M15): from content-only sum to full-message estimate via token-meter. This is intentional (dsh parity); existing equality assertions must be updated (see Task 4).
- Behavior unchanged when no catalog is provided: `createCompactionEngine` without `profile`/`modelId` is byte-identical to M11/M14 (config-fallback).
- All existing tests must stay green except the intentional `activeTokens` expectation update in `compaction.test.ts`.

---

### Task 1: token-meter — package scaffold + `estimateContent` (TDD)

**Files:**
- Create: `packages/token-meter/package.json`
- Create: `packages/token-meter/tsconfig.json`
- Create: `packages/token-meter/src/estimate.ts`
- Create: `packages/token-meter/src/index.ts`
- Create: `packages/token-meter/test/estimate.test.ts`

**Interfaces:**
- Consumes: `@i-harness/core-session` types (`LLMMessage`, `LLMContentPart`).
- Produces (used by Task 2 and later): `CHARS_PER_TOKEN`, `BLOCK_OVERHEAD`, `ROLE_OVERHEAD`, `IMAGE_TOKEN_ESTIMATE`, `estimateMessage(m: LLMMessage): number`, `estimateContent(messages: LLMMessage[]): number` — all exported from `packages/token-meter/src/index.ts`.

- [ ] **Step 1: Create the package scaffold**

`packages/token-meter/package.json`:

```json
{
  "name": "@i-harness/token-meter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-session": "workspace:*"
  }
}
```

`packages/token-meter/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 2: Write the failing test**

`packages/token-meter/test/estimate.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { BLOCK_OVERHEAD, CHARS_PER_TOKEN, IMAGE_TOKEN_ESTIMATE, ROLE_OVERHEAD, estimateContent, estimateMessage } from "../src/index.ts"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

describe("estimateMessage", () => {
  it("prices a string user message: ceil(chars/4) + ROLE_OVERHEAD", () => {
    expect(estimateMessage({ role: "user", content: "abcd" })).toBe(1 + ROLE_OVERHEAD)
    expect(estimateMessage({ role: "user", content: "" })).toBe(0 + ROLE_OVERHEAD)
  })

  it("prices a parts user message: ROLE_OVERHEAD + per-part (text ceil/4, image estimate) + BLOCK_OVERHEAD each", () => {
    const msg = { role: "user" as const, content: [
      { type: "text" as const, text: "abcd" },
      { type: "image" as const, image: { mediaType: "image/png" as const, dataBase64: PNG } },
    ] }
    expect(estimateMessage(msg)).toBe(ROLE_OVERHEAD + (1 + BLOCK_OVERHEAD) + (IMAGE_TOKEN_ESTIMATE + BLOCK_OVERHEAD))
  })

  it("prices a tool string message like a user string message", () => {
    expect(estimateMessage({ role: "tool", toolCallId: "t1", content: "abcd" })).toBe(1 + ROLE_OVERHEAD)
  })

  it("prices an assistant message with content and toolCalls", () => {
    const msg = { role: "assistant" as const, content: "ok", toolCalls: [
      { id: "c1", name: "bash", args: { command: "ls" } },
    ] }
    const argsJson = JSON.stringify({ command: "ls" })
    expect(msg.toolCalls!.length).toBe(1)
    expect(estimateMessage(msg)).toBe(
      ROLE_OVERHEAD + (Math.ceil(2 / CHARS_PER_TOKEN) + BLOCK_OVERHEAD)
      + (Math.ceil("bash".length / CHARS_PER_TOKEN) + Math.ceil(argsJson.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD),
    )
  })

  it("prices an assistant message with undefined args safely", () => {
    const msg = { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "f", args: undefined }] }
    // JSON.stringify(undefined) === undefined → `?? ""` → 0 chars
    expect(estimateMessage(msg)).toBe(ROLE_OVERHEAD + (Math.ceil(1 / CHARS_PER_TOKEN) + 0 + BLOCK_OVERHEAD))
  })
})

describe("estimateContent", () => {
  it("is the sum of estimateMessage over all messages", () => {
    const messages = [ { role: "user" as const, content: "abcd" }, { role: "assistant" as const, content: "ok" } ]
    expect(estimateContent(messages)).toBe((1 + ROLE_OVERHEAD) + (Math.ceil(2 / CHARS_PER_TOKEN) + ROLE_OVERHEAD))
  })

  it("is deterministic: same input, same number", () => {
    const messages = [ { role: "user" as const, content: "x".repeat(400) } ]
    expect(estimateContent(messages)).toBe(estimateContent(messages))
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/token-meter && pnpm test`
Expected: FAIL — `Failed to resolve import "../src/index.ts"` / module not found (package has no src yet).

- [ ] **Step 4: Implement `estimate.ts` and `index.ts`**

`packages/token-meter/src/estimate.ts`:

```ts
import type { LLMMessage } from "@i-harness/core-session"

// M15: dsh-style fixed-density heuristics. `estimateMessage` prices one
// message (block/role overhead included); `estimateContent` sums them.
export const CHARS_PER_TOKEN = 4
export const BLOCK_OVERHEAD = 4
export const ROLE_OVERHEAD = 4
// M14: fixed per-image estimate (no re-encode/pixel math in v0). Moved here
// from compaction so the meter is the single source of truth.
export const IMAGE_TOKEN_ESTIMATE = 1024

export function estimateMessage(m: LLMMessage): number {
  if (m.role === "assistant") {
    let total = ROLE_OVERHEAD
    // assistant content is always a string (see LLMMessage union) and is an
    // extra text block when non-empty (e.g. preamble before tool calls).
    if (m.content.length > 0) {
      total += Math.ceil(m.content.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
    }
    for (const call of m.toolCalls ?? []) {
      // JSON.stringify(undefined) returns undefined, not a string — normalize
      // so the "as the wire would send it" pricing never sees NaN.
      const argsJson = JSON.stringify(call.args) ?? ""
      total += Math.ceil(call.name.length / CHARS_PER_TOKEN)
        + Math.ceil(argsJson.length / CHARS_PER_TOKEN)
        + BLOCK_OVERHEAD
    }
    return total
  }
  // user | tool
  if (typeof m.content === "string") {
    return Math.ceil(m.content.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
  }
  let total = ROLE_OVERHEAD
  for (const part of m.content) {
    total += part.type === "text"
      ? Math.ceil(part.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
      : IMAGE_TOKEN_ESTIMATE + BLOCK_OVERHEAD
  }
  return total
}

export function estimateContent(messages: LLMMessage[]): number {
  let total = 0
  for (const m of messages) total += estimateMessage(m)
  return total
}
```

`packages/token-meter/src/index.ts`:

```ts
export {
  BLOCK_OVERHEAD,
  CHARS_PER_TOKEN,
  IMAGE_TOKEN_ESTIMATE,
  ROLE_OVERHEAD,
  estimateContent,
  estimateMessage,
} from "./estimate.ts"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/token-meter && pnpm test`
Expected: PASS (all 7 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm install          # wire the new workspace package
pnpm --filter @i-harness/token-meter typecheck
git add packages/token-meter pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(M15): token-meter estimateContent (dsh fixed-density)"
```

Note: `pnpm-lock.yaml` rows for `packages/token-meter` appear after `pnpm install`. Only commit the lockfile if it changed (it will — the new package is registered in the workspace).

---

### Task 2: token-meter — `activeTokens` + `breakdown`

**Files:**
- Create: `packages/token-meter/src/breakdown.ts`
- Modify: `packages/token-meter/src/index.ts`
- Create: `packages/token-meter/test/breakdown.test.ts`

**Interfaces:**
- Consumes: `estimateContent`/`estimateMessage` (Task 1), `@i-harness/core-session` (`Session`, `deriveMessages`).
- Produces (used by Task 4): `activeTokens(session: Session): number`, `breakdown(session: Session): TokenBreakdown`, `interface TokenBreakdown { total: number; perMessage: { index: number; role: "user" | "assistant" | "tool"; tokens: number }[] }` — all exported from `packages/token-meter/src/index.ts`. NOTE: no `seq` on perMessage entries — `LLMMessage` (the model-visible projection) carries no seq; `index` is the message position in the derived array.

- [ ] **Step 1: Write the failing tests**

`packages/token-meter/test/breakdown.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages } from "@i-harness/core-session"
import { ROLE_OVERHEAD, activeTokens, breakdown, estimateContent } from "../src/index.ts"

describe("activeTokens", () => {
  it("derives the session then estimates — equals estimateContent(deriveMessages(session))", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "abcd" })
    append(s, { type: "assistant/message", text: "ok" })
    expect(activeTokens(s)).toBe(estimateContent(deriveMessages(s)))
    expect(activeTokens(s)).toBe((1 + ROLE_OVERHEAD) + (1 + ROLE_OVERHEAD)) // "ok" → ceil(2/4)=1
  })

  it("prices an empty session at 0", () => {
    expect(activeTokens(createSession())).toBe(0)
  })
})

describe("breakdown", () => {
  it("totals per-message estimates with index and role", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "abcd" })
    append(s, { type: "assistant/message", text: "ok" })
    const b = breakdown(s)
    expect(b.perMessage).toEqual([
      { index: 0, role: "user", tokens: 1 + ROLE_OVERHEAD },
      { index: 1, role: "assistant", tokens: 1 + ROLE_OVERHEAD },
    ])
    expect(b.total).toBe(2 * (1 + ROLE_OVERHEAD))
  })

  it("prices a tool block: assistant toolCalls + tool result", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "list files" })
    append(s, { type: "tool/call", callId: "c1", name: "bash", args: { command: "ls" } })
    append(s, { type: "tool/result", callId: "c1", name: "bash", output: { ok: true } })
    const b = breakdown(s)
    // user(1+4) + assistant toolCall(4 + 1 + 4 + 4) + tool string(9/4→3 + 4)
    expect(b.perMessage.map((p) => p.role)).toEqual(["user", "assistant", "tool"])
    expect(b.total).toBe(b.perMessage.reduce((sum, p) => sum + p.tokens, 0))
    expect(b.total).toBe(estimateContent(deriveMessages(s)))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/token-meter && pnpm test`
Expected: FAIL — `activeTokens`/`breakdown` are not exported / module not found.

- [ ] **Step 3: Implement `breakdown.ts` and update `index.ts`**

`packages/token-meter/src/breakdown.ts`:

```ts
import type { Session } from "@i-harness/core-session"
import { deriveMessages } from "@i-harness/core-session"
import { estimateContent, estimateMessage } from "./estimate.ts"

export interface TokenBreakdown {
  total: number
  perMessage: { index: number; role: "user" | "assistant" | "tool"; tokens: number }[]
}

// M15: the single projection rule — the model only ever sees
// deriveMessages(session), so tokens are counted on that exact output
// (audit seam F01-3). The meter never touches raw events.
export function activeTokens(session: Session): number {
  return estimateContent(deriveMessages(session))
}

export function breakdown(session: Session): TokenBreakdown {
  const perMessage = deriveMessages(session).map((m, index) => ({
    index,
    role: m.role,
    tokens: estimateMessage(m),
  }))
  return { total: perMessage.reduce((sum, p) => sum + p.tokens, 0), perMessage }
}
```

Update `packages/token-meter/src/index.ts` (append to the existing re-exports):

```ts
export { activeTokens, breakdown } from "./breakdown.ts"
export type { TokenBreakdown } from "./breakdown.ts"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/token-meter && pnpm test`
Expected: PASS (3 new + 7 from Task 1).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/token-meter typecheck
git add packages/token-meter
git commit -m "feat(M15): token-meter activeTokens + breakdown"
```

---

### Task 3: provider — context catalog fields + `resolveModelContext` + registration validation

**Files:**
- Modify: `packages/provider/src/index.ts`
- Modify: `packages/provider/test/provider.test.ts` (append a new describe block)

**Interfaces:**
- Consumes: existing `ProviderProfile`, `createProviderRegistry`.
- Produces (used by Task 4): `ProviderModelContext { contextWindow?: number; maxContextWindow?: number }`, `ProviderProfile.contextWindow?`, `ProviderProfile.maxContextWindow?`, `ProviderProfile.modelContexts?: Record<string, ProviderModelContext>`, `resolveModelContext(profile: ProviderProfile, modelId: string): { contextWindow?: number; maxContextWindow?: number }` — exported from `packages/provider/src/index.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/provider/test/provider.test.ts`:

```ts
import { resolveModelContext, type ProviderProfile } from "../src/index.ts"

describe("M15 context catalog", () => {
  it("resolveModelContext: per-model override wins over profile-level", () => {
    const profile: ProviderProfile = {
      name: "p", displayName: "P", protocol: "openai-compatible",
      contextWindow: 10_000,
      modelContexts: { big: { contextWindow: 200_000 } },
    }
    expect(resolveModelContext(profile, "big")).toEqual({ contextWindow: 200_000 })
    expect(resolveModelContext(profile, "other")).toEqual({ contextWindow: 10_000 })
  })

  it("resolves maxContextWindow independently with the same precedence", () => {
    const profile: ProviderProfile = {
      name: "p", displayName: "P", protocol: "openai-compatible",
      maxContextWindow: 200_000,
      modelContexts: { big: { maxContextWindow: 218_000 } },
    }
    expect(resolveModelContext(profile, "big").maxContextWindow).toBe(218_000)
    expect(resolveModelContext(profile, "x").maxContextWindow).toBe(200_000)
  })

  it("returns undefined fields when nothing is configured", () => {
    const profile: ProviderProfile = { name: "p", displayName: "P", protocol: "openai-compatible" }
    expect(resolveModelContext(profile, "m")).toEqual({})
  })

  it("register fails loud on non-positive or non-integer windows", () => {
    const reg = createProviderRegistry()
    expect(() => reg.register({ name: "a", displayName: "A", protocol: "openai-compatible", contextWindow: 0 })).toThrow(/contextWindow/i)
    expect(() => reg.register({ name: "b", displayName: "B", protocol: "openai-compatible", contextWindow: -5 })).toThrow(/contextWindow/i)
    expect(() => reg.register({ name: "c", displayName: "C", protocol: "openai-compatible", contextWindow: 1.5 })).toThrow(/contextWindow/i)
    expect(() => reg.register({ name: "d", displayName: "D", protocol: "openai-compatible", modelContexts: { m: { contextWindow: 0 } } })).toThrow(/modelContexts/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/provider && pnpm test`
Expected: FAIL — `resolveModelContext` is not exported; `contextWindow` not a known property (type error stops at typecheck, but vitest via tsx will also fail at module resolution/TypeError).

- [ ] **Step 3: Implement the catalog**

Update `packages/provider/src/index.ts`:

Add the field types to `ProviderProfile`:

```ts
export interface ProviderModelContext {
  contextWindow?: number
  maxContextWindow?: number
}

export interface ProviderProfile {
  name: string
  displayName: string
  protocol: ProviderProtocol
  baseUrl?: string
  apiKey?: string
  models?: string[]
  defaultModel?: string
  inputModalities?: ("text" | "image")[] // M14: absent = text-only (negative capability)
  contextWindow?: number                // M15: default window (tokens) for this provider
  maxContextWindow?: number             // M15: absolute ceiling; budget-enforcement hook (no enforcement in M15)
  modelContexts?: Record<string, ProviderModelContext> // M15: per-model overrides
}
```

Add `resolveModelContext` below the `ProviderProfile` interface (before `ProviderRegistry`):

```ts
// M15: per-model override wins → profile-level → undefined. Pure; the values
// were already validated at registration, so no validation happens here.
export function resolveModelContext(
  profile: ProviderProfile,
  modelId: string,
): { contextWindow?: number; maxContextWindow?: number } {
  const override = profile.modelContexts?.[modelId]
  return {
    contextWindow: override?.contextWindow ?? profile.contextWindow,
    maxContextWindow: override?.maxContextWindow ?? profile.maxContextWindow,
  }
}
```

Add validation to `register` and the validators below `createProviderRegistry`:

```ts
    register(profile) {
      if (profiles.has(profile.name)) throw new Error(`duplicate provider: ${profile.name}`)
      validateModelContext(profile)
      profiles.set(profile.name, profile)
    },
```

```ts
// M15: context windows fail loud at registration (no defaults injected —
// absence means "unknown, fall back to config").
function validateWindow(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`provider: ${label} must be a positive integer (got ${value})`)
  }
}

function validateModelContext(profile: ProviderProfile): void {
  if (profile.contextWindow !== undefined) validateWindow(profile.contextWindow, "contextWindow")
  if (profile.maxContextWindow !== undefined) validateWindow(profile.maxContextWindow, "maxContextWindow")
  if (profile.modelContexts) {
    for (const [modelId, mc] of Object.entries(profile.modelContexts)) {
      if (mc.contextWindow !== undefined) validateWindow(mc.contextWindow, `modelContexts["${modelId}"].contextWindow`)
      if (mc.maxContextWindow !== undefined) validateWindow(mc.maxContextWindow, `modelContexts["${modelId}"].maxContextWindow`)
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/provider && pnpm test`
Expected: PASS (existing 8 + new 4).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/provider typecheck
git add packages/provider
git commit -m "feat(M15): provider context catalog + resolveModelContext + registration validation"
```

---

### Task 4: compaction — migrate to token-meter, `resolveContextWindow`, engine `profile`/`modelId` params

**Files:**
- Modify: `packages/compaction/package.json` (add workspace deps `@i-harness/provider`, `@i-harness/token-meter`)
- Modify: `packages/compaction/src/tokens.ts`
- Modify: `packages/compaction/src/config.ts` (add `resolveContextWindow`)
- Modify: `packages/compaction/src/index.ts` (export `resolveContextWindow`; engine params + use)
- Modify: `packages/compaction/test/compaction.test.ts` (update `activeTokens` expectation at line ~38; add `resolveContextWindow` describe)
- Modify: `packages/compaction/test/engine.test.ts` (add catalog-aware engine test)

**Interfaces:**
- Consumes: `@i-harness/token-meter` (`estimateContent` indirectly via re-exported `activeTokens`; `IMAGE_TOKEN_ESTIMATE`), `@i-harness/provider` (`ProviderProfile`, `resolveModelContext`).
- Produces (used by Task 6 regression): `resolveContextWindow(profile: ProviderProfile | undefined, modelId: string | undefined, config: { contextWindow: number }): number` exported from `packages/compaction/src/index.ts`; `createCompactionEngine(deps: { model: ModelClient; config: CompactionConfig; profile?: ProviderProfile; modelId?: string })`.

- [ ] **Step 1: Write the failing tests**

In `packages/compaction/test/compaction.test.ts`, replace the `activeTokens` test (currently at "activeTokens sums the derived message contents") with:

```ts
  it("activeTokens prices full messages (M15: ceil/4 + ROLE_OVERHEAD per message)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "x".repeat(400) }) // ~100 tokens + ROLE_OVERHEAD
    append(s, { type: "assistant/message", text: "y".repeat(400) }) // ~100 tokens + ROLE_OVERHEAD
    expect(activeTokens(s)).toBe(200 + 2 * 4)
  })
```

Append a new describe to `packages/compaction/test/compaction.test.ts`:

```ts
import { resolveContextWindow, type ResolvedCompactionConfig } from "../src/index.ts"

describe("M15 resolveContextWindow", () => {
  const config: ResolvedCompactionConfig = { contextWindow: 1000, thresholdRatio: 0.8, retainTokens: 0, maxTokens: 1024, auto: true }

  it("catalog-first: per-model override beats profile-level beats config", () => {
    const profile = {
      name: "p", displayName: "P", protocol: "openai-compatible" as const,
      contextWindow: 10_000,
      modelContexts: { big: { contextWindow: 200_000 } },
    }
    expect(resolveContextWindow(profile, "big", config)).toBe(200_000)
    expect(resolveContextWindow(profile, "other", config)).toBe(10_000)
    expect(resolveContextWindow(undefined, "m", config)).toBe(1000)
  })

  it("falls back to config when the profile has no window for the model", () => {
    const profile = { name: "p", displayName: "P", protocol: "openai-compatible" as const }
    expect(resolveContextWindow(profile, "m", config)).toBe(1000)
    expect(resolveContextWindow(profile, undefined, config)).toBe(1000)
  })
})
```

Append to `packages/compaction/test/engine.test.ts`:

```ts
it("maybeCompact uses the catalog window when profile+modelId are provided (M15)", async () => {
  const s = longSession() // ~2000 tokens
  // config says window 1000 (threshold 500) → would fire; catalog says 10000
  // (threshold 5000) → must NOT fire.
  const engine = createCompactionEngine({
    model: mockModel("x"), config,
    profile: { name: "p", displayName: "P", protocol: "openai-compatible", contextWindow: 10_000 },
    modelId: "some-model",
  })
  expect((await engine.maybeCompact(s)).compacted).toBe(false)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/compaction && pnpm test`
Expected: FAIL — `resolveContextWindow` not exported; the updated `activeTokens` assertion fails (actual 200, expected 208); the catalog engine test fires (compacted true).

- [ ] **Step 3: Add workspace dependencies**

`packages/compaction/package.json` — `dependencies` becomes:

```json
  "dependencies": {
    "@i-harness/core-session": "workspace:*",
    "@i-harness/llm-seam": "workspace:*",
    "@i-harness/provider": "workspace:*",
    "@i-harness/token-meter": "workspace:*"
  }
```

Then run `pnpm install` in `D:/agent-complete/I-harness`.

- [ ] **Step 4: Rewrite `packages/compaction/src/tokens.ts`**

```ts
import type { LLMContentPart, Session } from "@i-harness/core-session"
import { activeTokens as meterActiveTokens, IMAGE_TOKEN_ESTIMATE } from "@i-harness/token-meter"

// M15: single source of truth moved to @i-harness/token-meter; kept here as a
// re-export so the M14 public surface is unchanged.
export { IMAGE_TOKEN_ESTIMATE }

// M15: content-only single-blob estimate — string → ceil(chars/4); parts →
// Σ (text: ceil/4, image: IMAGE_TOKEN_ESTIMATE). NO block/role overhead.
// Consumers (region.ts shadow selection, summarizer.ts trimming) price single
// blobs, not full messages; estimateContent (token-meter) is the full-message
// price used by activeTokens.
export function approxTokens(content: string | LLMContentPart[]): number {
  if (typeof content === "string") return Math.ceil(content.length / 4)
  let total = 0
  for (const part of content) {
    total += part.type === "text" ? Math.ceil(part.text.length / 4) : IMAGE_TOKEN_ESTIMATE
  }
  return total
}

// M15: full-message pricing (block/role overhead included). The single
// projection rule: deriveMessages(session) is what the model sees, so the
// meter prices exactly that. Delegates to @i-harness/token-meter.
export function activeTokens(session: Session): number {
  return meterActiveTokens(session)
}
```

- [ ] **Step 5: Add `resolveContextWindow` to `packages/compaction/src/config.ts`**

Append at the end of the file:

```ts
import { resolveModelContext, type ProviderProfile } from "@i-harness/provider"

// M15: catalog-first window resolution — per-model override → profile-level →
// config. Pure and exported so tests (and hosts) can assert it directly.
export function resolveContextWindow(
  profile: ProviderProfile | undefined,
  modelId: string | undefined,
  config: { contextWindow: number },
): number {
  const catalogWindow = profile && modelId
    ? resolveModelContext(profile, modelId).contextWindow
    : undefined
  return catalogWindow ?? config.contextWindow
}
```

- [ ] **Step 6: Update `packages/compaction/src/index.ts`**

Imports become:

```ts
import { append, deriveSearchText } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"
import type { ProviderProfile } from "@i-harness/provider"
import { resolveConfig, resolveContextWindow, type CompactionConfig } from "./config.ts"
```

Re-export line gets `resolveContextWindow`:

```ts
export { resolveConfig, resolveContextWindow } from "./config.ts"
```

Engine signature + body:

```ts
export function createCompactionEngine(deps: {
  model: ModelClient
  config: CompactionConfig
  profile?: ProviderProfile // M15: optional context catalog
  modelId?: string          // M15: the resolved model id for catalog lookup
}): CompactionEngine {
  const config = resolveConfig(deps.config)
  // M15: catalog-first (profile.modelContexts[modelId] → profile.contextWindow
  // → config.contextWindow). No profile/modelId → config → M11/M14 behavior.
  const contextWindow = resolveContextWindow(deps.profile, deps.modelId, config)
```

And the threshold check uses `contextWindow`:

```ts
      if (activeTokens(session) < contextWindow * config.thresholdRatio) {
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/compaction && pnpm test`
Expected: PASS (updated `activeTokens` 208; new `resolveContextWindow` block; catalog engine test; all M11/M14 engine + region tests unchanged).

- [ ] **Step 8: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/compaction typecheck
git add packages/compaction packages/token-meter pnpm-lock.yaml
git commit -m "feat(M15): compaction uses token-meter + catalog-first context window"
```

Note: `packages/token-meter` and `pnpm-lock.yaml` are staged because the new workspace link touches the lockfile. If the lockfile didn't change (already updated in Task 1), drop it from `git add`.

---

### Task 5: llm-seam — M14 I3 close: mask `dataBase64` in tool-role string content

**Files:**
- Modify: `packages/llm-seam/src/index.ts`
- Modify: `packages/llm-seam/test/seam.test.ts` (append to the M14 describe)

**Interfaces:**
- Consumes: `projectImagesForTextModel` (M14, existing).
- Produces: unchanged signature; behavior addition — tool-role string content has `"dataBase64":"<base64>"` replaced with `"dataBase64":"[image omitted: base64:<first-8>]"`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/llm-seam/test/seam.test.ts` (inside the existing `describe("M14 projectImagesForTextModel")` block):

```ts
  it("masks dataBase64 inside tool-role string content (M15 I3 close)", () => {
    const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const out = projectImagesForTextModel([
      { role: "tool", toolCallId: "c1", content: `{"ok":true,"images":[{"mediaType":"image/png","dataBase64":"${payload}"}]}` },
    ])
    const content = out[0]!.content as string
    expect(content).not.toContain(payload) // raw bytes never reach a text-only model
    expect(content).toContain(`"dataBase64":"[image omitted: base64:${payload.slice(0, 8)}]"`)
    expect(content).toContain(`"ok":true`) // the rest of the JSON survives
  })

  it("masks multiple base64 occurrences in one tool string", () => {
    const p1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const p2 = "aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY29uZCBpbWFnZSBwYXlsb2FkISEh"
    const out = projectImagesForTextModel([
      { role: "tool", toolCallId: "c2", content: `[{"dataBase64":"${p1}"},{"dataBase64":"${p2}"}]` },
    ])
    const content = out[0]!.content as string
    expect(content).not.toContain(p1)
    expect(content).not.toContain(p2)
    expect(content).toContain(`base64:${p1.slice(0, 8)}]`)
    expect(content).toContain(`base64:${p2.slice(0, 8)}]`)
  })

  it("leaves user/assistant string content untouched even when it resembles base64", () => {
    const sneaky = `{"dataBase64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}`
    const out = projectImagesForTextModel([{ role: "user", content: sneaky }])
    expect(out[0]!.content).toBe(sneaky)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-seam && pnpm test`
Expected: FAIL — the tool-role string currently passes through untouched (first new test contains the raw payload).

- [ ] **Step 3: Implement the masking**

Update `packages/llm-seam/src/index.ts`:

Replace the M14 comment + function with:

```ts
// M14/M15 negative capability: text-only models never see image bytes.
// Part-level: every image part is replaced with a deterministic text
// placeholder (the base64 prefix is a stable correlation hint, not the bytes).
// M15 I3 close: tool-role STRING content (tool results are
// JSON.stringify(output) and can carry output.images → dataBase64 fields) is
// masked so raw base64 bytes never reach a text-only model. User/assistant
// string content is untouched — the projection never embeds images there.
function maskToolBase64(content: string): string {
  return content.replace(/"dataBase64":"([A-Za-z0-9+/]{8})[A-Za-z0-9+/=]*"/g, '"dataBase64":"[image omitted: base64:$1]"')
}

export function projectImagesForTextModel(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      if (m.role === "tool") return { ...m, content: maskToolBase64(m.content) }
      return m
    }
    // assistant content is always string, so after the check only user/tool
    // parts messages remain; TS cannot prove it from the typeof guard alone
    // (non-literal property), so narrow explicitly on the role discriminant.
    if (m.role === "assistant") return m
    return {
      ...m,
      content: m.content.map((part) =>
        part.type === "image"
          ? { type: "text" as const, text: `[image omitted: model is text-only; base64:${part.image.dataBase64.slice(0, 8)}]` }
          : part,
      ),
    }
  })
}
```

Notes for the implementer:
- The regex demands at least 8 canonical base64 chars (the correlation hint threshold); shorter payloads are not worth masking and don't occur for images (min output is far larger).
- `.replace` with the `/g` flag resets `lastIndex` internally — the regex literal is safe for reuse across calls.
- The placeholder text is exactly `[image omitted: base64:<first-8>]` (differs intentionally from the part-level `[image omitted: model is text-only; base64:<8>]` — both contain no full bytes).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-seam && pnpm test`
Expected: PASS (existing 4 + new 3).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/llm-seam typecheck
git add packages/llm-seam
git commit -m "fix(M15): mask tool-string base64 for text-only models (I3 close)"
```

---

### Task 6: full regression + wrap-up

**Files:**
- None (verification only; check the plan's spec-delivered-commit convention).

**Interfaces:**
- Verifies everything from Tasks 1-5 together.

- [ ] **Step 1: Run the full test suite**

```bash
cd D:/agent-complete/I-harness
pnpm -r test
```

Expected: ALL packages green — `token-meter` (10 tests), `provider` (12), `compaction` (M11/M14 suite + updated activeTokens + new catalog tests), `llm-seam` (7), plus every other package unchanged.

- [ ] **Step 2: Run the full typecheck**

```bash
cd D:/agent-complete/I-harness
pnpm -r typecheck
```

Expected: PASS everywhere.

- [ ] **Step 3: Manual cross-check (no code change unless a bug shows)**

Verify the following by reading the final files (not editing):
- `packages/compaction/src/tokens.ts` exports `approxTokens`, `activeTokens`, `IMAGE_TOKEN_ESTIMATE` (M14 surface intact) and delegates `activeTokens` to token-meter.
- `packages/compaction/src/index.ts` exports `resolveContextWindow` and `resolveConfig`; engine accepts `profile`/`modelId`.
- `packages/token-meter/src/index.ts` exports all four constants + `estimateContent`, `estimateMessage`, `activeTokens`, `breakdown`, `TokenBreakdown`.
- `packages/provider/src/index.ts` exports `ProviderModelContext` + `resolveModelContext`; `register` validates windows.
- `packages/llm-seam/src/index.ts` masks tool-role string base64; part-level placeholder unchanged.
- No new session event types; `CURRENT_FORMAT_VERSION` still 1 (grep `packages/core-session`).

- [ ] **Step 4: Commit any leftover state and summarize**

```bash
cd D:/agent-complete/I-harness
git status --short   # should be clean; commit anything stray with a fitting message
git log --oneline -6
```

If everything is committed, no commit is needed here. Add a handoff note in the repo if the project convention requires it (check `docs/` recent history; M14 added a handoff doc — mirror that pattern only if previous milestones did).

---

## Self-Review Notes (already resolved during planning)

- **Spec deviation 1 — `TokenBreakdown.perMessage` has no `seq`:** the model-visible projection (`LLMMessage`) carries no seq, so per-message entries use `index` only. `seq?` in the spec's sketch is dropped in the implementation (YAGNI; field would always be `undefined`).
- **Spec gap filled — existing `activeTokens` test:** `packages/compaction/test/compaction.test.ts` asserted 200 (content-only). M15 changes `activeTokens` semantics to full-message pricing (dsh parity), so the expectation moves to 208 (200 + 2 × ROLE_OVERHEAD). Engine tests are behavior-based (500 vs ~2000 tokens) and need no change.
- **Spec gap filled — engine catalog observability:** `resolveContextWindow` is exported as a pure function (spec §8's testing need) AND `maybeCompact` has a behavior-based test (catalog window 10000 → no fire).
- **Spec nuance — `JSON.stringify(args)` can return `undefined`:** `?? ""` guards the `toolCalls` pricing branch.
- **Scope check — CLI:** verified `apps/cli/src/run.ts` only pass-throughs `opts.compact` (config) and does not build a profile for compaction; no CLI change in M15 (spec §9).
- **Dependency direction checked:** `compaction → provider` adds no cycle (provider depends on llm-seam → core-session, never on compaction).
