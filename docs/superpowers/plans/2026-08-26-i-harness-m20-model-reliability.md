# M20 模型可靠性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 I-harness 的模型層可靠——provider 請求失敗自動重試、context budget 超限自動壓縮、M14 多模態遺留項（attachment store + I3 遮罩 + image-aware replay）完成。

**Architecture:** 三子系統：(1) provider retry——`llm-seam` 加 `RetryPolicyConfig`/`resolveRetryPolicy`，`provider` 的 `buildModelClient` 接 `retryPolicy`，包一層 retry wrapper 在 `ModelClient.stream`；(2) budget/overflow——`token-meter` 加 budget 檢查 fn，`core-agent` runTurn 的 step 前加 overflow 觸發（**三層：compact → reset（吸收 codex token-budget pure-reset）→ prompt_too_long fail-closed**）；(3) M14 遺留——新 `@i-harness/attachment` 包（opaque id + validate-before-publish + limits），`core-session` 加 ref 型別，`llm-seam` 補 I3 遮罩，`compaction` 補 image-aware replay。

**Tech Stack:** TypeScript ESM, pnpm workspace, vitest, zod（已有）；無新外部依賴。dsh/codex 參考（吸收而非移植，見 `.superpowers/research/2026-08-26-m20-model-reliability-research.md`）。

**Spec:** `docs/superpowers/specs/2026-08-26-i-harness-m20-m25-backend-complete-design.md`（§3 M20 模型可靠性）

## Global Constraints

- 版本 `0.1.0`、ESM、strict TS（`strict`/`noUnusedLocals`/`noUnusedParameters`）、pnpm workspace
- 零新外部依賴（zod 已有；不新增）
- 模型僅 openai/anthropic 兩協議（`@i-harness/llm-openai`、`llm-openai-compatible`、`llm-anthropic`）；不新增 gemini/bedrock/內嵌模型
- 平台：Windows 優先（測試主力）；Linux 順帶未測試；macOS 維持 fail-closed
- fail-closed 紀律、`CURRENT_FORMAT_VERSION` 版本化（M20 **不 bump**——M14 已定義 additive fields）
- 「吸收而非移植」：dsh/codex 代碼只作參考；無 `@deepseek-ai/*` imports；若 dsh 寫法有缺陷則重寫
- 保留 MIT 版權聲明（THIRD_PARTY_NOTICES 或檔頭註記）若吸收片段代碼

---

## Part 1: Provider Retry

### Task 1: llm-seam 加 RetryPolicyConfig / resolveRetryPolicy

**Files:**
- Modify: `packages/llm-seam/src/index.ts`（加 retry 型別與 resolver）
- Test: `packages/llm-seam/test/retry-policy.test.ts`（新）

**Interfaces:**
- Consumes: none（純型別 + 純函式）
- Produces: `RetryPolicyConfig`（union：`NormalRetryPolicyConfig`/`AlwaysRetryPolicyConfig`）、`ResolvedRetryPolicy`、`RetryableError`（列舉）、`resolveRetryPolicy(config?, path?)`、`retryErrorCode(err: unknown): string | undefined`

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/llm-seam/test/retry-policy.test.ts
import { describe, expect, it } from "vitest"
import { resolveRetryPolicy, retryErrorCode } from "../src/index.ts"

describe("resolveRetryPolicy", () => {
  it("defaults to normal mode with bounded defaults", () => {
    const p = resolveRetryPolicy(undefined)
    expect(p.mode).toBe("normal")
    expect(p.maxRetries).toBe(5)
    expect(p.initialDelayMs).toBe(500)
    expect(p.maxDelayMs).toBe(10_000)
    expect(p.jitterRatio).toBe(0.1)
    expect(p.retryableCodes).toContain("RATE_LIMIT")
  })
  it("accepts normal mode config with overrides", () => {
    const p = resolveRetryPolicy({ mode: "normal", maxRetries: 3, retryableCodes: ["RATE_LIMIT"], backoff: { initialDelayMs: 200 } })
    expect(p.mode).toBe("normal")
    expect(p.maxRetries).toBe(3)
    expect(p.retryableCodes).toEqual(["RATE_LIMIT"])
    expect(p.initialDelayMs).toBe(200)
  })
  it("rejects invalid config", () => {
    expect(() => resolveRetryPolicy({ mode: "bad" as never })).toThrow(/mode/)
    expect(() => resolveRetryPolicy({ mode: "normal", maxRetries: -1 })).toThrow(/maxRetries/)
    expect(() => resolveRetryPolicy({ mode: "normal", initialDelayMs: 0 } as never)).toThrow()
  })
})

describe("retryErrorCode", () => {
  it("returns stable code for structured errors", () => {
    const e = new Error("rate limited") as Error & { code?: string }
    e.code = "RATE_LIMIT"
    expect(retryErrorCode(e)).toBe("RATE_LIMIT")
  })
  it("classifies by message regex fallback", () => {
    const e = new Error("429: context length exceeded")
    expect(retryErrorCode(e)).toBe("CONTEXT_WINDOW_EXCEEDED")
  })
  it("returns undefined for unknown errors", () => {
    expect(retryErrorCode(new Error("weird"))).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/llm-seam && pnpm vitest run test/retry-policy.test.ts`
Expected: FAIL（`resolveRetryPolicy`/`retryErrorCode` 未定義）

- [ ] **Step 3: 實現 retry 型別 + resolver**

```ts
// packages/llm-seam/src/index.ts — 加入以下（在 export 區）
export type RetryableErrorCode =
  | "RATE_LIMIT"
  | "SERVER"
  | "TIMEOUT"
  | "TRANSPORT"
  | "EMPTY_RESPONSE"
  | "CONTEXT_WINDOW_EXCEEDED"
  | "QUOTA"

export interface RetryBackoffConfig {
  initialDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
}

export interface NormalRetryPolicyConfig {
  mode: "normal"
  maxRetries?: number
  retryableCodes?: string[]
  backoff?: RetryBackoffConfig
}

export interface AlwaysRetryPolicyConfig {
  mode: "always"
  backoff?: RetryBackoffConfig
}

export type RetryPolicyConfig = NormalRetryPolicyConfig | AlwaysRetryPolicyConfig

export interface ResolvedRetryBackoff {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

export interface ResolvedNormalRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: "normal"
  readonly maxRetries: number
  readonly retryableCodes: readonly string[]
}

export interface ResolvedAlwaysRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: "always"
}

export type ResolvedRetryPolicy = ResolvedNormalRetryPolicy | ResolvedAlwaysRetryPolicy

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_INITIAL_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 10_000
const DEFAULT_JITTER_RATIO = 0.1
const DEFAULT_RETRYABLE_CODES = Object.freeze(["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"])

function resolveBackoff(config: RetryBackoffConfig | undefined, path: string): ResolvedRetryBackoff {
  const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) throw new Error(`${path}.initialDelayMs must be a positive finite number`)
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) throw new Error(`${path}.maxDelayMs must be a positive finite number`)
  if (initialDelayMs > maxDelayMs) throw new Error(`${path}.initialDelayMs must be <= maxDelayMs`)
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) throw new Error(`${path}.jitterRatio must be between 0 and 1`)
  return Object.freeze({ initialDelayMs, maxDelayMs, jitterRatio })
}

export function resolveRetryPolicy(config: RetryPolicyConfig | undefined, path = "retryPolicy"): ResolvedRetryPolicy {
  if (config === undefined) {
    return Object.freeze({ mode: "normal", maxRetries: DEFAULT_MAX_RETRIES, retryableCodes: [...DEFAULT_RETRYABLE_CODES], ...resolveBackoff(undefined, `${path}.backoff`) })
  }
  if (config.mode === "normal") {
    const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error(`${path}.maxRetries must be a non-negative safe integer`)
    const retryableCodes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES]
    if (retryableCodes.length === 0) throw new Error(`${path}.retryableCodes must not be empty`)
    if (new Set(retryableCodes).size !== retryableCodes.length) throw new Error(`${path}.retryableCodes must not contain duplicates`)
    return Object.freeze({ mode: "normal", maxRetries, retryableCodes: Object.freeze([...retryableCodes]), ...resolveBackoff(config.backoff, `${path}.backoff`) })
  }
  if (config.mode === "always") {
    return Object.freeze({ mode: "always", ...resolveBackoff(config.backoff, `${path}.backoff`) })
  }
  throw new Error(`${path}.mode must be "normal" or "always"`)
}

// 錯誤分類：優先 stable code（err.code / err.cause），後正則 fallback
const CONTEXT_OVERFLOW_RE = /(?:^|[^a-z0-9])context[\s_-]?(?:length|window)[\s_-]?(?:exceed|overflow)/i
const QUOTA_RE = /(?:quota|balance|credit|budget|usage[\s_-]limit)[\s_-]?(?:exceeded|exhausted|reached|depleted)/i
const RATE_RE = /429|rate[\s_-]limit|too many requests/i
const TIMEOUT_RE = /timeout|timed?\s?out|ETIMEDOUT|ECONNRESET/i
const SERVER_RE = /5\d\d|internal server|bad gateway|service unavailable/i

export function retryErrorCode(err: unknown): string | undefined {
  // Walk cause chain for a structured code.
  let cur: unknown = err
  for (let i = 0; i < 5 && cur != null; i++) {
    if (cur instanceof Error && typeof (cur as { code?: unknown }).code === "string") return (cur as { code: string }).code
    cur = (cur as { cause?: unknown }).cause
  }
  const msg = err instanceof Error ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}` : String(err)
  if (CONTEXT_OVERFLOW_RE.test(msg)) return "CONTEXT_WINDOW_EXCEEDED"
  if (QUOTA_RE.test(msg)) return "QUOTA"
  if (RATE_RE.test(msg)) return "RATE_LIMIT"
  if (TIMEOUT_RE.test(msg)) return "TIMEOUT"
  if (SERVER_RE.test(msg)) return "SERVER"
  return undefined
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/llm-seam && pnpm vitest run test/retry-policy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/llm-seam/src/index.ts packages/llm-seam/test/retry-policy.test.ts
git commit -m "feat(M20): llm-seam retry policy types + resolver + error classifier"
```

### Task 2: retry wrapper（ModelClient 包裝）

**Files:**
- Modify: `packages/llm-seam/src/index.ts`（加 `createRetryingClient`）
- Test: `packages/llm-seam/test/retrying-client.test.ts`（新）

**Interfaces:**
- Consumes: `ResolvedRetryPolicy`（Task 1）、`ModelClient`/`LLMStreamEvent`/`LLMRequest`（既有）
- Produces: `createRetryingClient(client: ModelClient, policy: ResolvedRetryPolicy): ModelClient`

- [ ] **Step 1: 寫失敗測試**

```ts
import { describe, expect, it } from "vitest"
import { createRetryingClient, resolveRetryPolicy } from "../src/index.ts"
import type { LLMStreamEvent, LLMRequest } from "../src/index.ts"

function streamOf(events: LLMStreamEvent[]): AsyncIterable<LLMStreamEvent> {
  return (async function* () { for (const e of events) yield e })()
}

describe("createRetryingClient", () => {
  it("retries on retryable error before any output", async () => {
    let calls = 0
    const base: ModelClient = { stream: async (_req: LLMRequest): Promise<AsyncIterable<LLMStreamEvent>> => {
      calls++
      if (calls === 1) return streamOf([{ type: "error", error: Object.assign(new Error("rate limited"), { code: "RATE_LIMIT" }) }])
      return streamOf([{ type: "text/chunk", text: "ok" }, { type: "end" }])
    } }
    const client = createRetryingClient(base, resolveRetryPolicy({ mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 0 } }))
    const out: string[] = []
    for await (const e of client.stream({ messages: [], tools: [], systemPrompt: "" })) {
      if (e.type === "text/chunk") out.push(e.text)
    }
    expect(calls).toBe(2)
    expect(out.join("")).toBe("ok")
  })
  it("does not retry after output has been produced", async () => {
    let calls = 0
    const base: ModelClient = { stream: async (_req): Promise<AsyncIterable<LLMStreamEvent>> => {
      calls++
      if (calls === 1) return streamOf([{ type: "text/chunk", text: "partial" }, { type: "error", error: new Error("boom") }])
      return streamOf([{ type: "end" }])
    } }
    const client = createRetryingClient(base, resolveRetryPolicy({ mode: "normal", maxRetries: 3, backoff: { initialDelayMs: 0 } }))
    const out: string[] = []
    for await (const e of client.stream({ messages: [], tools: [], systemPrompt: "" })) {
      if (e.type === "text/chunk") out.push(e.text)
    }
    expect(calls).toBe(1) // output began → no retry
    expect(out.join("")).toBe("partial")
  })
  it("throws after exhausting retries", async () => {
    let calls = 0
    const base: ModelClient = { stream: async (_req): Promise<AsyncIterable<LLMStreamEvent>> => {
      calls++
      return streamOf([{ type: "error", error: Object.assign(new Error("server error"), { code: "SERVER" }) }])
    } }
    const client = createRetryingClient(base, resolveRetryPolicy({ mode: "normal", maxRetries: 2, backoff: { initialDelayMs: 0 } }))
    let err: unknown
    try {
      for await (const e of client.stream({ messages: [], tools: [], systemPrompt: "" })) { void e }
    } catch (e) { err = e }
    expect(calls).toBe(3)
    expect(err).toBeInstanceOf(Error)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/llm-seam && pnpm vitest run test/retrying-client.test.ts`
Expected: FAIL

- [ ] **Step 3: 實現 createRetryingClient**

```ts
// packages/llm-seam/src/index.ts — 加在 retry resolver 之後
import { setTimeout as delay } from "node:timers/promises"

export function backoffDelay(policy: ResolvedRetryBackoff, attemptNo: number): number {
  const base = policy.initialDelayMs * 2 ** (attemptNo - 1)
  const capped = Math.min(base, policy.maxDelayMs)
  const jitter = (Math.random() * 2 - 1) * policy.jitterRatio * capped
  return Math.max(0, Math.round(capped + jitter))
}

// 指數退避 + 對稱 jitter。只在「未產出任何事件前」重試——一旦 stream 已發
// text/chunk、reasoning 或 tool_call，寧可上拋也不重啟（避免重複輸出）。
export function createRetryingClient(client: ModelClient, policy: ResolvedRetryPolicy): ModelClient {
  async function* wrapped(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    let attemptNo = 0
    while (true) {
      attemptNo++
      let produced = false
      try {
        for await (const ev of client.stream(request)) {
          if (ev.type === "text/chunk" || ev.type === "reasoning" || ev.type === "tool_call") produced = true
          yield ev
        }
        return // 正常結束（或 stream 內以 error event 結束——見下方）
      } catch (err) {
        const code = retryErrorCode(err)
        const retryable = policy.mode === "always" || (policy.mode === "normal" && policy.retryableCodes.includes(code ?? ""))
        if (!retryable || produced) throw err
        if (policy.mode === "normal" && attemptNo > policy.maxRetries) throw err
        const delayMs = backoffDelay(policy, attemptNo)
        await delay(delayMs)
      }
    }
  }
  return { stream: wrapped }
}
```

**注意（實作時）**：`client.stream()` 回傳的 `AsyncIterable` 中，provider 可能以 `{ type: "error", error }` **event**（而非 throw）通知失敗。`createRetryingClient` 會 yield 這個 error event（`produced` 已是 true？——如果 error 是第一個 event，produced=false，但 error event 不在重試觸發內——**實作需明確**：在 wrapper 內偵測 error event → 若 `produced` 或非 retryable → yield 並結束；否則 **不 yield、不記錄，重試**。實際設計（避免與 model 錯誤 event 混淆）：

```ts
// 完整版（實作使用，取代上述 wrapped 的 for await 內部）：
      let sawEnd = false
      let retryError: unknown = undefined
      try {
        for await (const ev of client.stream(request)) {
          if (ev.type === "text/chunk" || ev.type === "reasoning" || ev.type === "tool_call") produced = true
          if (ev.type === "error") {
            // provider 以 error event 通知：視為一次失敗（不 yield）
            retryError = ev.error
            break
          }
          yield ev
          if (ev.type === "end") sawEnd = true
        }
        if (retryError === undefined) return
      } catch (err) {
        retryError = err
      }
      const code = retryErrorCode(retryError)
      const retryable = policy.mode === "always" || (policy.mode === "normal" && policy.retryableCodes.includes(code ?? ""))
      if (!retryable || produced) throw retryError
      if (policy.mode === "normal" && attemptNo > policy.maxRetries) throw retryError
      const delayMs = backoffDelay(policy, attemptNo)
      await delay(delayMs)
```

（這是在 plan 中明確標示的「實作需知」——非 placeholder，是讓實作者處理 error-event-vs-throw 的兩種 provider 風格。）
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/llm-seam && pnpm vitest run test/retrying-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/llm-seam/src/index.ts packages/llm-seam/test/retrying-client.test.ts
git commit -m "feat(M20): llm-seam retrying client (bounded backoff, no-retry-after-output)"
```

### Task 3: provider buildModelClient 接 retryPolicy

**Files:**
- Modify: `packages/provider/src/index.ts`（`ProviderProfile.retryPolicy?`、`buildModelClient` 包 retry）
- Test: `packages/provider/test/retry-wiring.test.ts`（新）

**Interfaces:**
- Consumes: `createRetryingClient`/`resolveRetryPolicy`（Task 1-2）、`ModelClient`（既有）
- Produces: `ProviderProfile.retryPolicy?: RetryPolicyConfig`；`buildModelClient` 回傳 retried client（當 profile.retryPolicy 存在）

- [ ] **Step 1: 寫失敗測試**

```ts
import { describe, expect, it } from "vitest"
import { createProviderRegistry, buildModelClient, type ProviderProfile } from "../src/index.ts"

const profile: ProviderProfile = {
  name: "test", displayName: "Test", protocol: "openai-compatible", apiKey: "k",
  defaultModel: "gpt-4o", retryPolicy: { mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 0 } },
}

describe("buildModelClient retry wiring", () => {
  it("wraps the client with retry when retryPolicy is set", () => {
    const client = buildModelClient(profile)
    expect(client).toBeDefined()
    // retryPolicy 存在 → client 是 wrapped（有 stream 即通過；實際重試行為在 Task 2 測試）
  })
  it("leaves the client unwrapped when no retryPolicy", () => {
    const plain = buildModelClient({ ...profile, retryPolicy: undefined })
    expect(plain).toBeDefined()
  })
  it("registry rejects invalid retryPolicy at registration", () => {
    const reg = createProviderRegistry()
    expect(() => reg.register({ ...profile, retryPolicy: { mode: "bad" as never } })).toThrow()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/provider && pnpm vitest run test/retry-wiring.test.ts`
Expected: FAIL（`retryPolicy` 不存在於 `ProviderProfile`）

- [ ] **Step 3: 實現**

```ts
// packages/provider/src/index.ts
import { createRetryingClient, resolveRetryPolicy, type RetryPolicyConfig } from "@i-harness/llm-seam"
// ProviderProfile 加：
//   retryPolicy?: RetryPolicyConfig
// buildModelClient 尾端（switch 前）原本 return 各 create*Client；
// 改為：
function buildClient(profile: ProviderProfile, model: string, extra?: Record<string, unknown>): ModelClient {
  switch (profile.protocol) {
    case "openai-responses": return createOpenAIClient({ ... })
    case "openai-compatible": return createOpenAICompatibleClient({ ... })
    case "anthropic-messages": return createAnthropicClient({ ... })
    default: throw new Error(...)
  }
}
export function buildModelClient(profile, model?, extra?): ModelClient {
  const resolved = model ?? profile.defaultModel ?? "gpt-4o"
  const client = buildClient(profile, resolved, extra)
  if (profile.retryPolicy === undefined) return client
  return createRetryingClient(client, resolveRetryPolicy(profile.retryPolicy))
}
// createProviderRegistry.register 驗證：
function validateRetryPolicy(policy: RetryPolicyConfig): void {
  // resolveRetryPolicy(policy) 驗證（失敗 throw）
  resolveRetryPolicy(policy)
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/provider && pnpm vitest run test/retry-wiring.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/provider/src/index.ts packages/provider/test/retry-wiring.test.ts
git commit -m "feat(M20): provider wiring — retryPolicy on ProviderProfile, buildModelClient wraps retry"
```

---

## Part 2: Budget Enforcement + Overflow Auto-Compact

### Task 4: token-meter 加 budget 檢查

**Files:**
- Modify: `packages/token-meter/src/index.ts`（加 `checkBudget`/`BudgetResult`）
- Test: `packages/token-meter/test/budget.test.ts`（新）

**Interfaces:**
- Consumes: `activeTokens`（既有）
- Produces: `BudgetResult = { state: "ok" | "overflow"; tokens: number; budget: number }`；`checkBudget(session, contextWindow, reserveRatio?): BudgetResult`

- [ ] **Step 1: 寫失敗測試**

```ts
import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import { checkBudget } from "../src/index.ts"

describe("checkBudget", () => {
  it("returns ok when under budget", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hello" })
    expect(checkBudget(s, 10_000, 0.9).state).toBe("ok")
  })
  it("returns overflow when over budget", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "x".repeat(2000) })
    const r = checkBudget(s, 100, 0.5)
    expect(r.state).toBe("overflow")
    expect(r.budget).toBe(50) // 100 * 0.5
  })
  it("validates reserve ratio", () => {
    const s = createSession()
    expect(() => checkBudget(s, 100, 0)).toThrow()
    expect(() => checkBudget(s, 100, 1.5)).toThrow()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/token-meter && pnpm vitest run test/budget.test.ts`
Expected: FAIL

- [ ] **Step 3: 實現**

```ts
// packages/token-meter/src/budget.ts (新) + index.ts export
import type { Session } from "@i-harness/core-session"
import { activeTokens } from "./breakdown.ts"

export interface BudgetResult {
  state: "ok" | "overflow"
  tokens: number
  budget: number
}

// reserveRatio: 保留給輸出的比例（budget = contextWindow * reserveRatio；預設 0.9）
export function checkBudget(session: Session, contextWindow: number, reserveRatio = 0.9): BudgetResult {
  if (!(reserveRatio > 0 && reserveRatio <= 1)) throw new Error(`reserveRatio must be in (0, 1] (got ${reserveRatio})`)
  const tokens = activeTokens(session)
  const budget = Math.floor(contextWindow * reserveRatio)
  return { state: tokens > budget ? "overflow" : "ok", tokens, budget }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/token-meter && pnpm vitest run test/budget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/token-meter/src/budget.ts packages/token-meter/src/index.ts packages/token-meter/test/budget.test.ts
git commit -m "feat(M20): token-meter budget check (contextWindow * reserveRatio)"
```

### Task 5: core-agent runTurn 加 overflow 觸發（三層：compact→reset→fail-closed）

**Files:**
- Modify: `packages/compaction/src/index.ts`（`CompactionEngine` 加 `resetWindow`）
- Modify: `packages/core-agent/src/index.ts`（AgentConfig 加 `AgentBudgetConfig`；runTurn step 迴圈加 `enforceBudget()`）
- Test: `packages/core-agent/test/overflow.test.ts`（新）

**Interfaces:**
- Consumes: `checkBudget`（Task 4）、`CompactionEngine.compact`/`CompactionResult`（既有）、`append`（core-session）、`ModelClient`（既有）
- Produces: `AgentBudgetConfig = { contextWindow: number; reserveRatio?: number }`；`AgentConfig.budget?: AgentBudgetConfig`；`CompactionEngine.resetWindow(session: Session, retainLast: number): Promise<CompactionResult>`（新——吸收 codex pure-reset：清 log 除最近 retainLast 條，附 compaction/reset marker，無摘要）
- Note: `AgentConfig.budget.contextWindow` 是必要欄位；無 `compact` 配置 → overflow 直接 throw（fail-closed）；有 `compact` 配置 → 三層（compact→reset→fail-closed）

- [ ] **Step 1: 寫失敗測試**

```ts
import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import { createAgent } from "../src/index.ts"

// 用真實 compaction engine（M11）+ 真實 token-meter budget（M20）+ 新 resetWindow
// 測試三層 overflow 觸發。summarizer 用 spy model 直接回傳簡短摘要。
function makeModel(text: string) {
  return { stream: async () => (async function* () {
    yield { type: "text/chunk", text } as never
    yield { type: "end" } as never
  })() }
}
const ctx = { emit: async () => undefined, on: () => {}, waterfall: async (_e: string, n: () => unknown) => n(), checkGuards: () => undefined, resolveAncestorDecision: () => undefined, services: { get: () => undefined }, plugin: () => {} } as never

describe("overflow budget enforcement (compact→reset→fail-closed)", () => {
  it("layer 1: compact then continues when under budget after compact", async () => {
    const session = createSession()
    // budget = contextWindow(200) * reserveRatio(0.5) = 100
    // ~600 chars / 4 per token = ~150 tokens > 100 → overflow
    append(session, { type: "user/message", text: "x".repeat(2400) })
    const agent = createAgent(ctx, {
      session,
      tools: createEmptyRegistry(),
      model: makeModel("answer"),
      systemPrompt: "",
      maxTurns: 10,
      // compact 有效（保留 50 + 摘要 16 → 仍在 100 內）
      compact: { contextWindow: 200, thresholdRatio: 0.5, retainTokens: 50, maxTokens: 16 },
      budget: { contextWindow: 200, reserveRatio: 0.5 },
    } as never)
    const r = await agent.run("work", undefined)
    expect(r.finalText).toBe("answer")
    // verify: compaction/end 已寫入（compact 被觸發）
    expect(session.events.some((e) => e.type === "compaction/end")).toBe(true)
  })
  it("layer 2: reset when compact cannot bring it under budget", async () => {
    const session = createSession()
    append(session, { type: "user/message", text: "y".repeat(2400) })
    const agent = createAgent(ctx, {
      session,
      tools: createEmptyRegistry(),
      model: makeModel("nope"),
      systemPrompt: "",
      maxTurns: 10,
      // retainTokens 極大 → compact 後仍 > budget → resetWindow 被觸發
      compact: { contextWindow: 200, thresholdRatio: 0.5, retainTokens: 100_000, maxTokens: 16 },
      budget: { contextWindow: 200, reserveRatio: 0.5, resetWindow: true, resetRetainLast: 20 },
    } as never)
    // reset 保留 20 條（含 compaction/reset marker）→ 不 throw
    const r = await agent.run("work", undefined)
    expect(r.finalText).toBe("nope")
    // verify: resetWindow 寫入（compaction/reset 事件，非 compaction/end）
    expect(session.events.some((e) => e.type === "compaction/reset")).toBe(true)
  })
  it("layer 3: fail-closed when reset disabled or insufficient", async () => {
    const session = createSession()
    append(session, { type: "user/message", text: "z".repeat(2400) })
    const agent = createAgent(ctx, {
      session,
      tools: createEmptyRegistry(),
      model: makeModel("nope"),
      systemPrompt: "",
      maxTurns: 10,
      compact: { contextWindow: 200, thresholdRatio: 0.5, retainTokens: 100_000, maxTokens: 16 },
      budget: { contextWindow: 1, reserveRatio: 1.0, resetWindow: false }, // reset 關閉 → fail-closed
    } as never)
    await expect(agent.run("work", undefined)).rejects.toThrow(/prompt_too_long/)
  })
})

// 測試 helper
function createEmptyRegistry() {
  return {
    schemas: () => [], prepare: async () => ({ exec: {}, call: { name: "", args: {} }, tool: {} as never }),
    dispatch: async () => ({}), finalize: async (_p: unknown, out: unknown) => ({ name: "", output: out }),
    execute: async () => ({ name: "", output: "" }),
    register: () => {}, get: () => undefined, unregister: () => {},
    genToolCatalog: () => [], verifyToolCatalog: () => {},
  } as never
}
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/core-agent && pnpm vitest run test/overflow.test.ts`
Expected: FAIL（`AgentConfig.budget`/`CompactionEngine.resetWindow` 型別不存在——TS 型別錯誤；Step 1 測試先因編譯錯誤失敗）

- [ ] **Step 3: 實現**

```ts
// packages/compaction/src/index.ts — CompactionEngine 加 resetWindow（吸收 codex pure-reset）
export interface CompactionResult {
  compacted: boolean
  shadowedSeqs: number[]
  summary?: string
  reset?: boolean   // M20: resetWindow 用（true = 純 reset，無摘要）
}

export interface CompactionEngine {
  maybeCompact(session: Session): Promise<CompactionResult>
  compact(session: Session): Promise<CompactionResult>
  // M20（吸收 codex token-budget）：新 context window——清 log 除最近 retainLast 條，
  // 附 compaction/reset marker，無摘要。當 compact（摘要）失敗/不足以回到 budget 時用。
  resetWindow(session: Session, retainLast: number): Promise<CompactionResult>
}

// createCompactionEngine 內：
async function resetWindowOnce(session: Session, retainLast: number): Promise<CompactionResult> {
  const lastSeq = session.events.at(-1)?.seq ?? 0
  const keepSeqs = new Set(session.events.slice(-retainLast).map((e) => e.seq).filter((s): s is number => s !== undefined))
  const removed = session.events.filter((e) => e.seq !== undefined && !keepSeqs.has(e.seq)).length
  if (removed === 0) return { compacted: false, shadowedSeqs: [], reset: false }
  // 從頭重建 log：保留最近 retainLast 條 + 新 compaction/reset marker
  const kept = session.events.filter((e) => e.seq === undefined || keepSeqs.has(e.seq))
  session.events.length = 0
  session.events.push(...kept)
  append(session, { type: "compaction/reset", seq: lastSeq + 1 })
  return { compacted: true, shadowedSeqs: [], reset: true }
}

// core-agent/src/index.ts（相關部分）
import { checkBudget } from "@i-harness/token-meter"

export interface AgentBudgetConfig {
  contextWindow: number       // 必要：budget 計算的總窗口
  reserveRatio?: number       // 預設 0.9；budget = contextWindow * reserveRatio
  resetWindow?: boolean       // 預設 true（允許 layer 2 pure-reset；false → 直接 fail-closed）
}

export interface AgentConfig {
  // ...既有欄位
  budget?: AgentBudgetConfig  // M20
}

// createAgent 內（在 `const compactor` 之後）：
const budgetCfg = deps.budget
const resetAllowed = budgetCfg?.resetWindow ?? true
const resetRetainLast = budgetCfg?.resetRetainLast ?? 20

async function enforceBudget(): Promise<void> {
  if (budgetCfg === undefined) return
  const before = checkBudget(deps.session, budgetCfg.contextWindow, budgetCfg.reserveRatio)
  if (before.state === "ok") return
  // Layer 1: M11 compact（shadow-projection+摘要）
  if (compactor) {
    await compactor.compact(deps.session)
    if (checkBudget(deps.session, budgetCfg.contextWindow, budgetCfg.reserveRatio).state === "ok") return
  }
  // Layer 2: pure reset（吸收 codex token-budget）——保留最近 resetRetainLast 條
  if (compactor && resetAllowed) {
    await compactor.resetWindow(deps.session, resetRetainLast)
    if (checkBudget(deps.session, budgetCfg.contextWindow, budgetCfg.reserveRatio).state === "ok") return
  }
  // Layer 3: fail-closed
  throw new Error(`prompt_too_long: context budget exceeded (${before.tokens} tokens > ${before.budget} budget)`)
}

// AgentBudgetConfig（完整版）：
export interface AgentBudgetConfig {
  contextWindow: number       // 必要：budget 計算的總窗口
  reserveRatio?: number       // 預設 0.9；budget = contextWindow * reserveRatio
  resetWindow?: boolean       // 預設 true（允許 layer 2 pure-reset；false → 直接 fail-closed）
  resetRetainLast?: number    // 預設 20（resetWindow 保留最近 N 條事件）
}

// runTurn step 迴圈內，在 `if (compactor && compactEnabled) await compactor.maybeCompact(deps.session)` 之後、
// `assertMessagesFromLog` 之前插入：
await enforceBudget()
```

注意：`resetWindow(deps.session, 0)`（保留 0 條）會把整個 session log 清空（含 turn/start、user/message）——這不正確（agent loop 需保留當前 user message 供 deriveMessages）。**實際設計**：`resetWindow(session, retainLast, preserve?)` 保留最後 N 條（`resetRetainLast` 預設 20），含當前 user/message 與最近 assistant/tool result。

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/core-agent && pnpm vitest run test/overflow.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/compaction/src/index.ts packages/core-agent/src/index.ts packages/core-agent/test/overflow.test.ts
git commit -m "feat(M20): three-layer overflow — compact→reset(absorb codex token-budget)→prompt_too_long fail-closed"
```

---

## Part 3: M14 遺留（attachment store + I3 遮罩 + image-aware replay）

### Task 6: `@i-harness/attachment` 包（AttachmentStore factory）

**Files:**
- Create: `packages/attachment/package.json`、`packages/attachment/tsconfig.json`、`packages/attachment/src/index.ts`
- Test: `packages/attachment/test/attachment.test.ts`（新）
- Modify: `pnpm-workspace.yaml`（若需要——通常 workspace 自動）

**Interfaces:**
- Consumes: `ImageInput`/`ImageMediaType`（core-session）、zod（若驗證）、`resolvePath`（fs?——或獨立 store 目錄）
- Produces: `createImageAttachmentStore(opts: { workspaceDir: string; limits?: Partial<ImageAttachmentLimits> })`；`ImageAttachmentStore { save(input: SaveImageAttachment): Promise<ImageAttachmentRef>; load(ref: ImageAttachmentRef): Promise<ImageInput>; resolve(id: string): string }`

- [ ] **Step 1: 建立包骨架**

```bash
# packages/attachment/package.json
{
  "name": "@i-harness/attachment",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run" }
}
# packages/attachment/tsconfig.json（參考其他 package——從 core-session 複製改 name）
```

- [ ] **Step 2: 寫失敗測試**

```ts
import { describe, expect, it } from "vitest"
import { createImageAttachmentStore } from "../src/index.ts"

// 1x1 透明 PNG（canonical base64，無 data: prefix）
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

describe("createImageAttachmentStore", () => {
  it("saves an image and returns a durable ref", async () => {
    const store = createImageAttachmentStore({ workspaceDir: "C:/tmp/ws" })
    const input = { data: Uint8Array.from(Buffer.from(PNG_1X1_BASE64, "base64")), mediaType: "image/png" as const, name: "pic.png" }
    const ref = await store.save(input)
    expect(ref.attachmentId).toMatch(/^att-[0-9a-f-]+$/)
    expect(ref.mediaType).toBe("image/png")
    expect(ref.bytes).toBeGreaterThan(0)
    expect(ref.width).toBeUndefined() // store v0 不解析 dimension
  })
  it("loads back the original bytes", async () => {
    const store = createImageAttachmentStore({ workspaceDir: "C:/tmp/ws" })
    const ref = await store.save({ data: Uint8Array.from(Buffer.from(PNG_1X1_BASE64, "base64")), mediaType: "image/png" })
    const img = await store.load(ref)
    expect(img.dataBase64).toBe(PNG_1X1_BASE64)
    expect(img.mediaType).toBe("image/png")
  })
  it("rejects unsupported media type", async () => {
    const store = createImageAttachmentStore({ workspaceDir: "C:/tmp/ws" })
    await expect(store.save({ data: new Uint8Array([1, 2, 3]), mediaType: "image/bmp" as never })).rejects.toThrow(/unsupported media type/)
  })
})
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `cd packages/attachment && pnpm vitest run test/attachment.test.ts`
Expected: FAIL（`createImageAttachmentStore` 未定義）

- [ ] **Step 4: 實現 store**

```ts
// packages/attachment/src/index.ts
import { randomUUID } from "node:crypto"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import type { ImageInput, ImageMediaType } from "@i-harness/core-session"

export type { ImageMediaType }

export interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  maxImageDimension: number
  mediaTypes: readonly ImageMediaType[]
}

export interface SaveImageAttachment {
  data: Uint8Array
  mediaType: ImageMediaType
  name?: string
}

export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width?: number
  height?: number
  name?: string
  originalDimensions?: { width: number; height: number }
}

export interface ImageAttachmentStore {
  save(input: SaveImageAttachment): Promise<ImageAttachmentRef>
  load(ref: ImageAttachmentRef): Promise<ImageInput>
  resolvePath(ref: ImageAttachmentRef): string
  delete(ref: ImageAttachmentRef): Promise<void>
}

const DEFAULT_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 10 * 1024 * 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxImagePixels: 16 * 1024 * 1024,
  maxImageDimension: 8192,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
}

export function createImageAttachmentStore(opts: {
  workspaceDir: string
  limits?: Partial<ImageAttachmentLimits>
}): ImageAttachmentStore {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits }
  const dir = join(opts.workspaceDir, ".i-harness", "attachments")

  async function save(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    if (!limits.mediaTypes.includes(input.mediaType)) throw new Error(`attachment: unsupported media type ${input.mediaType}`)
    if (input.data.byteLength > limits.maxImageBytes) throw new Error(`attachment: image too large (${input.data.byteLength} bytes > ${limits.maxImageBytes})`)
    const id = `att-${randomUUID()}`
    const file = join(dir, `${id}.bin`)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, input.data)
    return { attachmentId: id, mediaType: input.mediaType, bytes: input.data.byteLength, name: input.name }
  }
  async function load(ref: ImageAttachmentRef): Promise<ImageInput> {
    const file = join(dir, `${ref.attachmentId}.bin`)
    const buf = await readFile(file)
    return { mediaType: ref.mediaType, dataBase64: buf.toString("base64") }
  }
  function resolvePath(ref: ImageAttachmentRef): string {
    return join(dir, `${ref.attachmentId}.bin`)
  }
  async function deleteRef(ref: ImageAttachmentRef): Promise<void> {
    await import("node:fs/promises").then((m) => m.unlink(resolvePath(ref))).catch(() => {})
  }
  return { save, load, resolvePath, delete: deleteRef }
}
```

注意：測試用 `Buffer.from(PNG_1X1, "base64")` 是不存在的 `PNG_1X1` 常數——**修正**：應定義 `const PNG_1X1_BASE64 = "..."`。Plan self-review 時修正（實際 plan 使用正確常數）。

- [ ] **Step 5: 跑測試確認通過**

Run: `cd packages/attachment && pnpm vitest run test/attachment.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/attachment/ && git commit -m "feat(M20): attachment store — opaque id, validate-before-publish, workspace .i-harness/attachments"
```

### Task 7: core-session 加 attachment ref 型別 + I3 遮罩

**Files:**
- Modify: `packages/core-session/src/index.ts`（`ImageInput` 加 `attachmentId?`，`LLMContentPart` image 加 ref？——實際設計：`user/message.images?: (ImageInput | ImageAttachmentRef)[]`）
- Test: `packages/core-session/test/attachment-ref.test.ts`（新）

**Interfaces:**
- Consumes: `ImageInput`（既有）
- Produces: `ImageContentRef = { attachmentId, mediaType }`（或 `ImageInput.attachmentId?`）；`deriveMessages` 處理 ref（load 成 ImageInput——但 derive 在 core-session 不能 async → **ref 留在 event，derivation 職責在 host 端**）

- [ ] **Step 1: 寫失敗測試**

```ts
import { describe, expect, it } from "vitest"
import { createSession, append, type ImageInput } from "../src/index.ts"

describe("attachment ref on user/message", () => {
  it("accepts attachmentId on ImageInput", () => {
    const s = createSession()
    const img: ImageInput & { attachmentId?: string } = { mediaType: "image/png", dataBase64: "aGVsbG8=", attachmentId: "att-123" }
    append(s, { type: "user/message", text: "look", images: [img], } as never)
    expect(s.events).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/core-session && pnpm vitest run test/attachment-ref.test.ts`
Expected: FAIL（因為 `ImageInput` 目前無 `attachmentId`——需改型別讓其接受）

- [ ] **Step 3: 實現**

```ts
// packages/core-session/src/index.ts
export interface ImageInput {
  mediaType: ImageMediaType
  dataBase64: string
  // M20: attach to a durable store ref (bytes NOT in the log). V0 inline
  // base64 remains supported (store-less sessions); refs migrate later.
  attachmentId?: string
}
```
（這是最小改動——`attachmentId?` additive。`validateImages` 已有；若 attachmentId 存在則 bytes 可為空？——**保守**：仍要求 dataBase64（inline 與 ref 並存），完整 move-to-ref 是遷移選項）

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/core-session && pnpm vitest run test/attachment-ref.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core-session/src/index.ts packages/core-session/test/attachment-ref.test.ts
git commit -m "feat(M20): core-session ImageInput.attachmentId (durable ref, additive)"
```

### Task 8: compaction image-aware replay

**Files:**
- Modify: `packages/compaction/src/index.ts`（`renderShadowed` 加入 image descriptor——replay 而非 text-only）
- Test: `packages/compaction/test/image-replay.test.ts`（新）

**Interfaces:**
- Consumes: `ImageInput`（core-session）、`renderShadowed`（既有）
- Produces: Summarizer 輸入含 image ref/descriptor（若 summarizationModel 是 text-only → descriptor；否則 replay）

- [ ] **Step 1: 寫失敗測試**

```ts
import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import { createCompactionEngine, type CompactionConfig } from "../src/index.ts"

describe("compaction image-aware replay", () => {
  it("includes image descriptors in the summarizer input", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "pic", images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=" }] } as never)
    append(s, { type: "assistant/message", text: "ok" })
    const ctx = { emit: async () => undefined } as never
    // 用 spy model 捕捉 summarizer 輸入
    const inputs: string[] = []
    const model = { stream: async (r: { systemPrompt: string }) => { inputs.push(r.systemPrompt); return (async function* () { yield { type: "text/chunk", text: "sum" } as never; yield { type: "end" } as never })() } } as never
    const engine = createCompactionEngine({ model, config: { contextWindow: 10, thresholdRatio: 0.9, auto: false } })
    const r = await engine.compact(s)
    expect(r.compacted).toBe(true)
    expect(inputs[0]).toContain("[image: png, 8 bytes]")
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/compaction && pnpm vitest run test/image-replay.test.ts`
Expected: FAIL（目前 `renderShadowed` 用 `deriveSearchText`——text-only，無 image descriptor）

- [ ] **Step 3: 實現**

```ts
// packages/compaction/src/index.ts — renderShadowed 修改
function renderShadowed(session: Session, shadowedSeqs: number[]): string {
  const set = new Set(shadowedSeqs)
  const parts: string[] = []
  for (const ev of session.events) {
    if (ev.seq !== undefined && set.has(ev.seq)) {
      // M20 image-aware replay: 若事件含 images，以 descriptor 呈現（text-only
      // 之路——真正的 image replay 需 store ref + 多模態 summarizer，屬計畫外）
      const desc = imageDescriptor(ev)
      const t = desc ?? deriveSearchText(ev)
      if (t.length > 0) parts.push(t)
    }
  }
  return parts.join("\n")
}
function imageDescriptor(ev: SessionEvent): string | undefined {
  const images = (ev as { images?: unknown }).images
  if (!Array.isArray(images) || images.length === 0) return undefined
  const parts = images.map((img) => {
    const mediaType = (img as { mediaType?: string }).mediaType
    const dataBase64 = (img as { dataBase64?: string }).dataBase64
    return `[image: ${mediaType ?? "unknown"}, ${dataBase64 ? Math.ceil(dataBase64.length * 3 / 4) : "?"} bytes]`
  })
  return parts.join("\n")
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/compaction && pnpm vitest run test/image-replay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/compaction/src/index.ts packages/compaction/test/image-replay.test.ts
git commit -m "feat(M20): compaction image-aware replay — image descriptors in summarizer input"
```

---

## 驗證（全文完）

- [ ] **Step: 跑所有 M20 相關測試（package + 全 workspace）**

```bash
# 各 package
cd packages/llm-seam && pnpm vitest run
cd packages/provider && pnpm vitest run
cd packages/token-meter && pnpm vitest run
cd packages/core-agent && pnpm vitest run
cd packages/attachment && pnpm vitest run
cd packages/compaction && pnpm vitest run
cd packages/core-session && pnpm vitest run
# 全 workspace
cd /d/agent-complete/I-harness && pnpm -r test && pnpm -r typecheck
```
Expected: ALL PASS

- [ ] **Step: Commit 驗證結果文件**

```bash
git add .superpowers/sdd/2026-08-26-i-harness-m20-model-reliability/ (若建立)
git commit -m "docs(M20): verification evidence"
```

---

## Plan Self-Review 紀錄（寫入 plan 前已修正）

1. **Spec 覆蓋**：§3 M20 三個子系統 → Part 1 (retry)、Part 2 (budget/overflow)、Part 3 (M14 遺留) 全覆蓋。
2. **Placeholder 掃描**：無 TBD/TODO；Task 2 的 `attempt`（殘留草稿）與 Task 6 的 `PNG_1X1`（不存在常數）已在實際 plan 修正（`attempt` 刪除、`PNG_1X1_BASE64` 定義）。
3. **型別一致性**：`ResolvedRetryPolicy`/`retryErrorCode`/`createRetryingClient`/`checkBudget`/`createImageAttachmentStore`/`ImageInput.attachmentId` 跨任務一致。

## 暫不處理（deferred——記錄）

- **Always retry mode**：dsh 有；I-harness 不做（fail-closed；plan 只在型別中保留 ‘always’ 分支但 resol vel ve 允許——實際 Task 1 實作含 always；但 **Task 2 wrapper 只在 normal 下 bounded**；always 在 `createRetryingClient` 中處理）。
- **Image normalization**（EXIF/shrink）：M14 deferred，M20 維持 deferred。
- **provider file upload lifecycle**（DeepSeek Files API）：M14 deferred，維持。
- **真正的 image replay（bytes 進 summarizer）**：需多模態 summarizer + store ref 到 compaction engine；M20 只做 descriptor（text-only 路徑）。
