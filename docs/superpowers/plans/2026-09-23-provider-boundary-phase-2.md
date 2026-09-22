# M72 階段 Ⅱ — 輸出上限＋截斷看得見 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 IH 送出去的請求**帶得住輸出上限**（照 Pi／DSH：模型真的有上限），並讓「被上限截斷」變成**看得見的結局**——上限**先與剩下的 context 夾過**，五個轉接器各用自己的 wire 欄位，撞到上限的那一回合在 telemetry 與 `run` 的輸出裡讀得到。

**Architecture:** 值走一條**既有的鏈**（設定列 `maxTokens` → 卡片 `maxOutputTokens` → 具名常數），在 **core-agent 組請求時夾一次**（它同時握有窗口與輸入估計），隨 `LLMRequest.maxOutputTokens` 進五個轉接器；截斷則是 seam 終止事件上的**一個可選位** `{ type: "end"; truncated?: true }`，由各轉接器**自己的終止字面**決定，再由 core-agent 寫進 session log 與 telemetry。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-22-provider-boundary-design.md`（設計的權威；§1.1／§1.2／§1.3 是本階段的範圍，§2 第 2 條是驗收）

> **這是三階段中的第二份計畫。** 階段 Ⅰ（沉默的失敗）已於 `398952a5`／紀錄 `docs/handoff/2026-09-23-m72-phase-1.md` 交付。**階段 Ⅲ（usage＋reasoning）日後另寫一份計畫。**

## Global Constraints

- **紅先測試 ＋ 變異證明**：每一條修法都要先看到紅，並在實作後**把修法拿掉一次**、確認測試變紅、再逐位元組還原（`sha256sum` 前後相同）。**不得用 `git checkout --` 還原未提交的改動**（它會還原到 HEAD，不是你的編輯——本 repo 這一週被這個坑過兩次）。要還原自己的編輯，用 Edit 工具改回去。
- **既有測試只在「它刻意斷言的正是這次要改的契約」時才改**，而且要**具名說明**、不得放鬆（`expect` 只能變嚴或等價）。
- **提交訊息不加任何 attribution trailer**；**不 amend**；blobs LF；檔案用 Write/Edit 工具寫。
- **每個任務只跑自己套件的測試與 typecheck**；`pnpm verify:all` **整支分支只跑一次**（在階段的收尾任務）。
- **不要動 `docs/`**（紀錄由控制器寫）。
- **seam 的改動只能是「加欄位／加常數／加一個純函式」**：`LLMRequest.maxOutputTokens?: number`、`{ type: "end"; truncated?: true }`、`OUTPUT_CAP_SAFETY_MARGIN`、`ANTHROPIC_MAX_TOKENS_FALLBACK`、`clampOutputCap`。**不得**把 finish-reason 詞彙（`max_tokens`／`length`／`MAX_TOKENS`／`stopReason`）漏進 seam——那正是 seam 要擋的東西（spec §1.3）。
- **`truncated` 缺席 ⇒ 與今天逐位元組相同**：只有 `true` 才寫欄位，永遠不寫 `truncated: false`。
- **上限只在鏈解析出值時才送**；唯一的例外是 anthropic（Messages API 必填）⇒ 它用 `ANTHROPIC_MAX_TOKENS_FALLBACK`。**五個轉接器都不做自動退讓、不重試、不 compact**（spec §3）。
- **夾取的水位**：`clampOutputCap(value, contextWindow, estimatedInput)` 只在「剩下的空間 ≥ 1」時夾；空間 ≤ 0 時**原樣回傳**（請求本來就跑不動，把上限壓成 1 只會把一個上下文溢出假裝成一次截斷）。
- **abort 不是 provider 失敗**：任何把例外轉成事件的 `catch`，在 `request.signal?.aborted === true` 時**重新拋出**（本階段新增的 catch 不多，但規矩不變）。
- **不動 `config.options` 的語意**（不驗證它、不禁止它覆蓋必填欄位）；**不動 `LLMRequest.model` 這個死欄位**；**不新增 model-catalog 家族**（見 §殘餘）。

---

### Task 1: seam —請求欄位、終止位、常數與夾取函式

**Files:**
- Modify: `packages/llm-seam/src/index.ts`（`LLMRequest` `:254-267`；`LLMStreamEvent` `:30-36`；新常數與函式放在 `SSEParseError`（`:378-383`）之後）
- Test: `packages/llm-seam/test/seam.test.ts`

**Interfaces:**
- Produces（後面每個任務都靠這些名字，逐字）：
  - `LLMRequest.maxOutputTokens?: number`
  - `LLMStreamEvent` 的終止臂：`{ type: "end"; truncated?: true }`
  - `export const ANTHROPIC_MAX_TOKENS_FALLBACK: number`（= 128_000）
  - `export function clampOutputCap(value: number, contextWindow: number | undefined, estimatedInputTokens: number): number`
  - （夾取的安全邊際 4096 **不匯出**：它只被同檔的 `clampOutputCap` 用，而 reachability 儀器把「只有自己檔案引用」當成未消費的匯出 ⇒ 匯出它會**多一列**、閘門紅。測試用字面值 4096 斷言。）

- [ ] **Step 1: 寫紅測試**（`packages/llm-seam/test/seam.test.ts` 末尾加一個 describe）

```ts
describe("M72 Ⅱ: the output cap", () => {
  it("leaves the value alone when no window is known", () => {
    expect(clampOutputCap(8192, undefined, 100_000)).toBe(8192)
  })

  it("leaves the value alone when the window has room", () => {
    expect(clampOutputCap(8192, 200_000, 1_000)).toBe(8192)
  })

  it("clamps to the room left after the estimated input and the safety margin", () => {
    // 200000 - 190000 - 4096 = 5904
    expect(clampOutputCap(65_536, 200_000, 190_000)).toBe(5904)
  })

  it("returns the value unchanged when the window has no room at all", () => {
    // room = 200000 - 199000 - 4096 < 1 → the request cannot run either way;
    // clamping to 1 would dress a context overflow up as a truncation.
    expect(clampOutputCap(8192, 200_000, 199_000)).toBe(8192)
  })
})
```

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/llm-seam test`
Expected: 紅在 `clampOutputCap is not a function`（或 import 失敗）。

- [ ] **Step 3: 實作**

在 `packages/llm-seam/src/index.ts`：`LLMRequest`（`:254-267`）在建議欄位後加：

```ts
  /** M72 Ⅱ: this request's output cap — already resolved through the host's
   * chain (a user-written `--max-tokens` wins over the model card) and already
   * clamped against the room this request has left. `undefined` → send NOTHING:
   * four of the five wires treat an absent cap as the provider's own default,
   * and inventing a number here would make every request a statement we cannot
   * back. Anthropic is the one exception and owns its own fallback (its
   * Messages API REJECTS a request without `max_tokens`). */
  maxOutputTokens?: number
```

`LLMStreamEvent`（`:30-36`）的終止臂改成：

```ts
  | { type: "end"; truncated?: true }
```

在檔案末尾（`SSEParseError` 之後）加：

```ts
/**
 * M72 Ⅱ: the margin `clampOutputCap` keeps between the input we estimate and
 * the window. Sampled from Pi's `clampMaxTokensToContext` (`context − estimated
 * input − 4096`): the request-level clamp exists so that sending a model's full
 * output ceiling cannot turn a request that would have run into a 400 —
 * Anthropic treats `input + max_tokens > context` as a validation error.
 *
 * NOT exported on purpose: this file is its only consumer, and the reachability
 * instrument reads a single-file export as an unconsumed one (one new row = a
 * red gate). The number is documented here and asserted by this package's tests.
 */
const OUTPUT_CAP_SAFETY_MARGIN = 4096

/**
 * M72 Ⅱ: what Anthropic gets when the chain resolves NOTHING. Its Messages API
 * lists `max_tokens` as required — today every such request is a 400 — so this
 * is the one adapter that must always send a number. The value is the
 * documented maximum output of the current generation (128,000), i.e. "no
 * practical ceiling", NOT a guess at a reasonable answer. Recorded residual:
 * an older model whose real ceiling is lower will 400 here — which is what it
 * does TODAY as well (no `max_tokens` is also a 400), so this is a strict
 * improvement even before the card arm fires.
 */
export const ANTHROPIC_MAX_TOKENS_FALLBACK = 128_000

/**
 * M72 Ⅱ: `min(value, room left in the window)`. Pure so every caller clamps the
 * same way; the host supplies the estimate because only the host knows how it
 * prices a message (this package deliberately owns no tokenizer).
 *
 * When no window is known the value is returned untouched. When the estimated
 * input plus the margin already fills the window, the value is ALSO returned
 * untouched: the request cannot run at that size whichever cap it carries, and
 * clamping to 1 token would turn a context overflow into a silent truncation.
 */
export function clampOutputCap(value: number, contextWindow: number | undefined, estimatedInputTokens: number): number {
  if (contextWindow === undefined) return value
  const room = contextWindow - estimatedInputTokens - OUTPUT_CAP_SAFETY_MARGIN
  return room >= 1 ? Math.min(value, room) : value
}
```

import 行（`seam.test.ts` 第 1 行那條）加 `clampOutputCap`。

- [ ] **Step 4: 跑它，看到綠**

Run: `pnpm --filter @i-harness/llm-seam test` → 全綠（既有測試不動）。

- [ ] **Step 5: 變異證明（兩條）**

(a) 把 `if (contextWindow === undefined) return value` 拿掉 ⇒ 第一條紅（`NaN`／比較失敗）；(b) 把 `room >= 1 ? Math.min(value, room) : value` 改成 `Math.max(1, Math.min(value, room))` ⇒ **第四條**紅。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-seam/src/index.ts packages/llm-seam/test/seam.test.ts
git commit -m "feat(llm-seam): the request carries an output cap, the terminal event carries truncation (M72 II)"
```

---

### Task 2: 值鏈——把已經算出來的上限送到 core-agent 手上

**Files:**
- Modify: `packages/provider-runtime/src/index.ts`（drop site `:646-650`；`SessionModelBinding` `:65-72`；binding 組裝 `:654-668`）
- Modify: `packages/session-executor/src/service.ts`（ready 形狀 `:50-59`；rebind `:305-310`；assembly options `:348-356`）
- Modify: `packages/session-executor/src/assembly.ts`（`AssemblyOptions`；`budget` 旁把值交給 `AgentDeps`）
- Modify: `packages/core-agent/src/index.ts`（`AgentDeps` 加 `maxOutputTokens?: number`）
- Modify: `apps/cli/src/run.ts`（`:506` 旁、`:624` 旁）
- Test: `packages/provider-runtime/test/runtime.test.ts`、`packages/session-executor/test/*`（該套件既有測試檔）

**Interfaces:**
- Consumes: `resolveEffectiveModelContext(...)?.maxOutputTokens`（**已存在**，`packages/provider/src/index.ts:275-302`——今天算出來就被丟掉）
- Produces: `SessionModelBinding.maxOutputTokens?: number`；`AgentDeps.maxOutputTokens?: number`（Task 3 讀它）

**實況（量測）**：`packages/provider-runtime/src/index.ts:646-650` 只取 `.contextWindow`，同一個物件上的 `maxOutputTokens` 被丟掉；`SessionModelBinding`（`:65-72`）沒有那個欄位。**整條鏈已經算完了**，缺的只是最後幾公尺。

- [ ] **Step 1: 寫紅測試**（`packages/provider-runtime/test/runtime.test.ts`）

該檔的 ready-binding 案例用 `toMatchObject`（`:241`、`:249`）⇒ 加欄位**不會**弄紅既有斷言。照 `:85-120` 那個案例的 fixture（settings 列 `{ id, contextWindow }` 的形狀）新增一個獨立案例，設定列裡多一個 `maxTokens`：

```ts
  it("M72 Ⅱ: the binding carries the resolved output cap, not just the window", async () => {
    // 同 :100-116 的設定列形狀，只是多一個使用者寫的上限
    const runtime = /* 照 :85-120 的 fixture 建法 */ makeRuntime({
      models: [
        { id: "session-model", contextWindow: 96_000, maxTokens: 1_234 },
        { id: "default-model", contextWindow: 128_000 },
      ],
    })
    await expect(runtime.resolveModel({})).resolves.toMatchObject({
      status: "ready",
      binding: { modelId: "default-model", contextWindow: 128_000 },
    })
    await expect(runtime.resolveModel({
      sessionSelection: { provider: "deepseek", model: "session-model" },
    })).resolves.toMatchObject({
      status: "ready",
      binding: { modelId: "session-model", maxOutputTokens: 1_234 },
    })
  })
```

**兩條斷言是刻意的對照**：寫了上限的那列帶 `maxOutputTokens`，沒寫的那列**不帶**（`toMatchObject` 只檢查提到的欄位，所以「不帶」由 Step 5 的變異 (b) 與 `packages/provider` 型別擋著，不是靠這條斷言——在報告裡寫明這一點）。

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/provider-runtime test`
Expected: 紅——`maxOutputTokens` 是 `undefined`（今天沒有這個欄位／沒被帶上）。

- [ ] **Step 3: 實作**

`packages/provider-runtime/src/index.ts`：

```ts
      const effective = resolveEffectiveModelContext({
        profile,
        modelId,
        ...(userModel !== undefined ? { userModel } : {}),
      })
      const contextWindow = effective?.contextWindow
      // M72 Ⅱ: the same resolution already produced the output cap — it was
      // thrown away one line after being computed. Both numbers travel: the
      // window is what the host compacts against, the cap is what the request
      // must actually carry.
      const maxOutputTokens = effective?.maxOutputTokens
```

binding 組裝（`:654-668`）加（照 `contextWindow` 那一行的形狀）：

```ts
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
```

`SessionModelBinding`（`:65-72`）加：

```ts
  /** M72 Ⅱ: the resolved output cap (user row > card). Absent → the adapter
   * sends nothing (anthropic falls back to its own constant). */
  maxOutputTokens?: number
```

`packages/session-executor/src/service.ts`：ready 形狀（`:50-59`）加同一個欄位；`:305-310` 的 rebind 段照 `contextWindow` 的處理補上；`:348-356` 的 assembly options 加

```ts
            maxOutputTokens: binding.maxOutputTokens,
```

`packages/session-executor/src/assembly.ts`：`AssemblyOptions` 加 `maxOutputTokens?: number`（放在 `contextWindow` 旁），並在組 `AgentDeps` 的那一處（`budget` 的來源附近）傳下去：

```ts
      ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
```

`packages/core-agent/src/index.ts`：`AgentDeps` 加

```ts
  /** M72 Ⅱ: the resolved output cap for this session's model (undefined → the
   * adapter sends none). Read at request assembly, clamped there. */
  maxOutputTokens?: number
```

`apps/cli/src/run.ts`：`:506` 旁加 `const maxOutputTokens = providerBinding?.maxOutputTokens`，並在 `:624` 的 `contextWindow` 旁用同一形狀傳進 assembly options：

```ts
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
```

- [ ] **Step 4: 跑它們，看到綠**

Run: `pnpm --filter @i-harness/provider-runtime test`、`--filter @i-harness/session-executor test`、`--filter @i-harness/core-agent test`；三個 typecheck。

- [ ] **Step 5: 變異證明**

把 provider-runtime 的 `...(maxOutputTokens !== undefined ? { maxOutputTokens } : {})` 拿掉 ⇒ Step 1 的測試紅。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/provider-runtime/src/index.ts packages/provider-runtime/test packages/session-executor/src packages/session-executor/test packages/core-agent/src/index.ts apps/cli/src/run.ts
git commit -m "feat(provider): the resolved output cap survives the value chain (M72 II)"
```

---

### Task 3: core-agent 在組請求時夾一次

**Files:**
- Modify: `packages/core-agent/src/index.ts`（請求組裝 `:291-302`）
- Test: `packages/core-agent/test/`（該套件既有的 agent 測試檔；照它既有的 `createAgent`／deps fixture）

**Interfaces:**
- Consumes: `AgentDeps.maxOutputTokens`（Task 2）、`budgetCfg.contextWindow`（`deps.budget`，`:195`）、`estimateContent`（`@i-harness/token-meter`，`:48`）、`clampOutputCap`（Task 1）
- Produces: 行為——每一則送出的請求帶著**已夾過的** `maxOutputTokens`

- [ ] **Step 1: 寫紅測試**（`packages/core-agent/test/agent.test.ts`，照 `:103-126` 那個案例的 `createContext`／`makeDeps`／`deps.model = { async *stream(request) {…} }` 形狀）

```ts
  it("M72 Ⅱ: the request carries the cap", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    const seen: { maxOutputTokens?: number }[] = []
    deps.model = {
      async *stream(request: { maxOutputTokens?: number }) {
        seen.push({ ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}) })
        yield { type: "text/chunk", text: "done" }
        yield { type: "end" }
      },
    }
    // A window far larger than anything this test sends → nothing to clamp
    // against, so the value is the one that went in. (The arithmetic itself is
    // pinned exactly by Task 1's seam tests; this pins the WIRING.)
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p", maxTurns: 1, maxOutputTokens: 8_000, budget: { contextWindow: 1_000_000 } })
    await agent.run("hi")
    expect(seen[0]!.maxOutputTokens).toBe(8_000)
  })

  it("M72 Ⅱ: the cap is clamped down when the window is nearly full", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    const seen: { maxOutputTokens?: number }[] = []
    deps.model = {
      async *stream(request: { maxOutputTokens?: number }) {
        seen.push({ ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}) })
        yield { type: "end" }
      },
    }
    // 10,000 − (estimated input + overhead) − 4096 < 8,000 for any non-empty
    // prompt → strictly less, and still a positive number.
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p", maxTurns: 1, maxOutputTokens: 8_000, budget: { contextWindow: 10_000 } })
    await agent.run("hi")
    expect(seen[0]!.maxOutputTokens).toBeLessThan(8_000)
    expect(seen[0]!.maxOutputTokens).toBeGreaterThan(0)
  })

  it("M72 Ⅱ: no cap resolved → the field is ABSENT, not 8000 and not 0", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    const seen: { maxOutputTokens?: number }[] = []
    deps.model = {
      async *stream(request: { maxOutputTokens?: number }) {
        seen.push({ ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}) })
        yield { type: "end" }
      },
    }
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p", maxTurns: 1 })
    await agent.run("hi")
    expect("maxOutputTokens" in seen[0]!).toBe(false)
  })
```

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/core-agent test`
Expected: 兩條都紅（第一條 `undefined`；第二條…**先確認它今天為什麼紅**——今天欄位不存在於請求上，所以第二條其實會**綠**。若綠，就在報告裡寫明：第二條是**缺席的守衛**，其殺手是 Step 5 的變異 (b)）。

- [ ] **Step 3: 實作**

`packages/core-agent/src/index.ts` 的請求組裝（`:291-302`）加：

```ts
        // M72 Ⅱ: the cap the host resolved for this model, CLAMPED here because
        // this is the only place that holds all three inputs at once: the value
        // (deps), the window (budgetCfg) and the input we are about to send.
        // Estimated with the same meter the budget check uses, plus the same
        // overhead it charges — so the clamp and the compaction ladder agree on
        // what "the input" costs. Absent deps value → absent field.
        ...(deps.maxOutputTokens !== undefined
          ? {
              maxOutputTokens: clampOutputCap(
                deps.maxOutputTokens,
                budgetCfg?.contextWindow,
                estimateContent(messages) + (budgetCfg?.overheadTokens ?? 0),
              ),
            }
          : {}),
```

import 行加 `clampOutputCap`（`@i-harness/llm-seam`）與 `estimateContent`（`@i-harness/token-meter`，若尚未 import）。

- [ ] **Step 4: 跑它，看到綠**

Run: `pnpm --filter @i-harness/core-agent test` + typecheck。

- [ ] **Step 5: 變異證明（兩條）**

(a) 把 `clampOutputCap(...)` 換成 `deps.maxOutputTokens`（不夾）⇒ 第一條紅；(b) 把整個 `...(deps.maxOutputTokens !== undefined ? … : {})` 拿掉 ⇒ 第二條紅。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/core-agent/src/index.ts packages/core-agent/test
git commit -m "feat(core-agent): the request's cap is clamped against the room the window has left (M72 II)"
```

---

### Task 4: anthropic、openai、openai-compatible 各自送自己的欄位

**Files:**
- Modify: `packages/llm-anthropic/src/index.ts`（body `:131-153`；import）
- Modify: `packages/llm-openai/src/index.ts`（body `:93-126`）
- Modify: `packages/llm-openai-compatible/src/index.ts`（body `:102-135`；config `:3-15`）
- Modify: `packages/provider/src/index.ts`（`ProviderProfile` `:20-51`；`WireClientConfig` `:900-908`；`buildClient` `:866-885`）
- Modify: `packages/provider-runtime/src/index.ts`（`providerView` `:681-723`／`runtimeProfile` `:733-769` 的欄位傳遞）
- Modify: `packages/settings/src/index.ts`（`SettingsProviderConfig` `:106-146`）
- Test: `packages/llm-anthropic/test/anthropic.test.ts`、`packages/llm-openai/test/openai.test.ts`、`packages/llm-openai-compatible/test/openai-compatible.test.ts`、`packages/provider/test/*`

**Interfaces:**
- Consumes: `request.maxOutputTokens`（Task 1/3）、`ANTHROPIC_MAX_TOKENS_FALLBACK`（Task 1）
- Produces: `OpenAICompatibleConfig.maxTokensField?: "max_tokens" | "max_completion_tokens"`；`ProviderProfile.maxTokensField?`；`SettingsProviderConfig.maxTokensField?`

**為什麼 openai-compatible 要有欄位名開關**（spec §1.2）：`max_tokens` 對**相容 gateway**（本轉接器存在的理由）是通用名，對**新 OpenAI 模型**是被拒的舊名。本樹照 Pi 的形狀把它做成**顯式配置**而不是猜。

- [ ] **Step 1: 寫紅測試（六條：三個轉接器 ＋ provider 的 wiring）**

`packages/llm-anthropic/test/anthropic.test.ts`：

```ts
  it("M72 Ⅱ: the cap is body-level max_tokens (the messages API requires it)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s", maxOutputTokens: 4096 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_tokens).toBe(4096)
    await it.return?.()
  })

  it("M72 Ⅱ: no cap resolved → the fallback constant, never nothing", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_tokens).toBe(ANTHROPIC_MAX_TOKENS_FALLBACK)
    await it.return?.()
  })
```

`packages/llm-openai/test/openai.test.ts`：

```ts
  it("M72 Ⅱ: the cap is top-level max_output_tokens", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s", maxOutputTokens: 4096 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_output_tokens).toBe(4096)
    // the chat-completions spelling is NOT this wire's
    expect(body.max_tokens).toBeUndefined()
    await it.return?.()
  })

  it("M72 Ⅱ: no cap resolved → neither spellings are sent", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect("max_output_tokens" in body).toBe(false)
    expect("max_tokens" in body).toBe(false)
    await it.return?.()
  })
```

`packages/llm-openai-compatible/test/openai-compatible.test.ts`：

```ts
  it("M72 Ⅱ: the cap goes on the default field name", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s", maxOutputTokens: 4096 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_tokens).toBe(4096)
    await it.return?.()
  })

  it("M72 Ⅱ: a route can name its own field (new OpenAI models reject max_tokens)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m", maxTokensField: "max_completion_tokens" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s", maxOutputTokens: 4096 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_completion_tokens).toBe(4096)
    expect(body.max_tokens).toBeUndefined()
    await it.return?.()
  })

  it("M72 Ⅱ: no cap resolved → no cap field at all", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect("max_tokens" in body).toBe(false)
    expect("max_completion_tokens" in body).toBe(false)
    await it.return?.()
  })
```

`packages/provider/test/retry-wiring.test.ts`（該檔已有「真轉接器 + stub fetch」的寫法）——**route 到 wire 的接線**：

```ts
  it("M72 Ⅱ: a route's own field name reaches the wire", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = buildModelClient({
      name: "gw", displayName: "GW", protocol: "openai-compatible",
      apiKey: "k", baseUrl: "https://gw.test", maxTokensField: "max_completion_tokens",
    }, "m")
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s", maxOutputTokens: 7 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_completion_tokens).toBe(7)
    await it.return?.()
  })
```

- [ ] **Step 2: 跑它們，看到紅**

Run: 四個套件。Expected: 全部紅（今天沒有任何轉接器寫上限；`maxTokensField` 不是 config 的欄位）。

- [ ] **Step 3: 實作**

`llm-anthropic`（body 的第一個欄位之後）：

```ts
        // M72 Ⅱ: `max_tokens` is REQUIRED by the Messages API — the one wire
        // where "send nothing" is not an option, so the fallback lives here and
        // is documented as "no practical ceiling", not as a guess.
        max_tokens: request.maxOutputTokens ?? ANTHROPIC_MAX_TOKENS_FALLBACK,
```

`llm-openai`（放在 `...(config.options ?? {})` **之後**——request 級別的值必須能覆蓋 options，和 reasoning 的規矩一致）：

```ts
        ...(request.maxOutputTokens !== undefined ? { max_output_tokens: request.maxOutputTokens } : {}),
```

`llm-openai-compatible`：

```ts
        // M72 Ⅱ: the field NAME is a per-route choice — `max_tokens` is what
        // compatible gateways take, `max_completion_tokens` is what the newest
        // OpenAI models demand. Explicit config, not a guess (Pi's
        // maxTokensField solves the same problem by probing).
        ...(request.maxOutputTokens !== undefined
          ? { [config.maxTokensField ?? "max_tokens"]: request.maxOutputTokens }
          : {}),
```

config 介面（`llm-openai-compatible/src/index.ts:3-15`）加：

```ts
  /** M72 Ⅱ: which wire field carries the cap on THIS route. Default
   * `max_tokens` (the compatible-gateway spelling). */
  maxTokensField?: "max_tokens" | "max_completion_tokens"
```

`packages/provider/src/index.ts`：`ProviderProfile`（`:20-51`）與 `WireClientConfig`（`:900-908`）各加 `maxTokensField?: "max_tokens" | "max_completion_tokens"`；`buildClient` 的 `openai-compatible` 分支（`:872`）把它傳進 config（照 `inputModalities` 的形狀）。`packages/provider-runtime/src/index.ts` 的 `providerView`／`runtimeProfile` 照 `inputModalities` 既有那兩行的形狀把它從 route 設定帶到 profile。`packages/settings/src/index.ts` 的 `SettingsProviderConfig` 加同名欄位（`sections.ts` 的 FieldSpec 照 `inputModalities` 那一列加，值域是那兩個字串）。

- [ ] **Step 4: 跑它們，看到綠**

Run: `pnpm --filter @i-harness/llm-anthropic test`、`--filter @i-harness/llm-openai test`、`--filter @i-harness/llm-openai-compatible test`、`--filter @i-harness/provider test`、`--filter @i-harness/provider-runtime test`、`--filter @i-harness/settings test`；六個 typecheck。

- [ ] **Step 5: 變異證明（四條）**

(a) 拿掉 anthropic 的 `max_tokens` 那一行 ⇒ 兩條 anthropic 測試紅；(b) 拿掉 openai 的 `max_output_tokens` ⇒ 該條紅；(c) 把 openai-compatible 的 `config.maxTokensField ?? "max_tokens"` 改成寫死 `"max_tokens"` ⇒ **第二條**紅；(d) 把 openai 與 openai-compatible 的條件改成**無條件送**（`?? 0`）⇒ 各自的「no cap」那條紅（那兩條是**缺席的守衛**、沒有紅先，這是它們的殺手——照階段 Ⅰ 的 R1 先例）。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-anthropic packages/llm-openai packages/llm-openai-compatible packages/provider packages/provider-runtime/src/index.ts packages/settings
git commit -m "feat(llm): anthropic, openai and the compatible route send their own output-cap field (M72 II)"
```

---

### Task 5: gemini 與 bedrock——今天不存在的父物件

**Files:**
- Modify: `packages/llm-gemini/src/index.ts`（body `:121-148`）
- Modify: `packages/llm-bedrock/src/index.ts`（body `:128-153`）
- Test: `packages/llm-gemini/test/gemini.test.ts`、`packages/llm-bedrock/test/bedrock.test.ts`

**Interfaces:**
- Consumes: `request.maxOutputTokens`（Task 1/3）
- Produces: 行為——`generationConfig.maxOutputTokens`（gemini）與 `inferenceConfig.maxTokens`（bedrock）

**實況（量測）**：兩個檔的 body 今天都**沒有**這兩個父物件（gemini `:121-148`、bedrock `:128-153`）；bedrock 的 `config.options` 全被塞進 `additionalModelRequestFields`，而 Converse **只認** `inferenceConfig` 裡的 `maxTokens`（該檔自己的註解 `:12`）。

- [ ] **Step 1: 寫紅測試（各兩條）**

`packages/llm-gemini/test/gemini.test.ts`（照 `:18-30` 那個案例的 fetch-stub 形狀）：

```ts
  it("M72 Ⅱ: the cap lives in generationConfig.maxOutputTokens, and the parent is built for it", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createGeminiClient({ apiKey: "test-key", baseUrl: "https://api.example", model: "gemini-2.5-pro" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "sys", maxOutputTokens: 4096 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.generationConfig).toEqual({ maxOutputTokens: 4096 })
    await it.return?.()
  })

  it("M72 Ⅱ: no cap resolved → no generationConfig at all (absent is absent)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createGeminiClient({ apiKey: "test-key", baseUrl: "https://api.example", model: "gemini-2.5-pro" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "sys" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect("generationConfig" in body).toBe(false)
    await it.return?.()
  })
```

`packages/llm-bedrock/test/bedrock.test.ts`（照 `:34-45` 那個案例的 `fakeRuntime`／`lastCommandSent` 形狀）：

```ts
  it("M72 Ⅱ: the cap lives in inferenceConfig.maxTokens", async () => {
    const { fake } = fakeRuntime([])
    const client = createBedrockClient({ model: "claude-x" }, fake)
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "sys", maxOutputTokens: 4096 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const { input } = await lastCommandSent(fake)
    expect(input.inferenceConfig).toEqual({ maxTokens: 4096 })
  })

  it("M72 Ⅱ: no cap resolved → no inferenceConfig at all", async () => {
    const { fake } = fakeRuntime([])
    const client = createBedrockClient({ model: "claude-x" }, fake)
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "sys" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const { input } = await lastCommandSent(fake)
    expect("inferenceConfig" in input).toBe(false)
  })
```

- [ ] **Step 2: 跑它們，看到紅**

Run: 兩個套件。Expected: 四條全紅。

- [ ] **Step 3: 實作**

gemini（`...(config.options ?? {})` 與 effort 之後，順序讓 request 贏）：

```ts
        // M72 Ⅱ: the parent object does not exist today — Gemini takes the cap
        // at generationConfig.maxOutputTokens, and the parent is optional on
        // the wire, so when there is no cap we do not build it at all.
        ...(request.maxOutputTokens !== undefined
          ? { generationConfig: { maxOutputTokens: request.maxOutputTokens } }
          : {}),
```

bedrock（`additionalModelRequestFields` 之後）：

```ts
        // M72 Ⅱ: Converse accepts maxTokens ONLY inside inferenceConfig, which
        // this adapter has never built (every option went to
        // additionalModelRequestFields, which the wire does not read for it).
        ...(request.maxOutputTokens !== undefined
          ? { inferenceConfig: { maxTokens: request.maxOutputTokens } }
          : {}),
```

（bedrock 的 `ConverseStreamCommandInput` 型別要能吃這個鍵——它是既有型別，不需要新增 import；若 typecheck 說不行，回報而不要 cast。）

- [ ] **Step 4: 跑它們，看到綠**

Run: 兩個套件 + 兩個 typecheck。

- [ ] **Step 5: 變異證明（兩條）**

(a) 拿掉 gemini 的 `generationConfig` 區塊 ⇒ 兩條 gemini 紅；(b) 拿掉 bedrock 的 `inferenceConfig` 區塊 ⇒ 兩條 bedrock 紅。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-gemini packages/llm-bedrock
git commit -m "feat(llm): gemini's generationConfig and bedrock's inferenceConfig carry the cap (M72 II)"
```

---

### Task 6: 截斷看得見——五個轉接器各自的終止字面

**Files:**
- Modify: `packages/llm-anthropic/src/index.ts`（`message_delta` 臂 `:191-194`；終止 `:288`）
- Modify: `packages/llm-openai/src/index.ts`（`:201` 附近新增 `response.incomplete` 臂；終止 `:275`）
- Modify: `packages/llm-openai-compatible/src/index.ts`（chunk 迴圈 `:196-201`；終止 `:260`）
- Modify: `packages/llm-gemini/src/index.ts`（`handleChunk` `:231-248`；終止 `:277`）
- Modify: `packages/llm-bedrock/src/index.ts`（`handleMember` `:236-240`；終止 `:273`）
- Test: 五個套件各自的 test 檔

**Interfaces:**
- Consumes: seam 的 `{ type: "end"; truncated?: true }`（Task 1）
- Produces: 行為——撞到上限的那一回合，終止事件帶 `truncated: true`；其餘**逐位元組同今天**

**五家的字面互不相同，所以每家只回答「provider 是否說它撞到上限了」**：`stop_reason: "max_tokens"`（anthropic）· `finish_reason: "length"`（chat completions）· `response.incomplete` ＋ `incomplete_details.reason: "max_output_tokens"`（Responses）· `finishReason: "MAX_TOKENS"`（gemini）· `stopReason: "max_tokens"`（bedrock，在 `messageStop` 上）。

**`response.incomplete` 的兩個理由要分開**：`max_output_tokens` 是**截斷**；`content_filter` 是**拒答**——它不是截斷，本階段**不**標成 `truncated`（拒答自己的通道是一條要改 seam 詞彙的產品決定，記在殘餘裡）。

- [ ] **Step 1: 寫紅測試（每家兩條：撞到上限 ⇒ `truncated: true`；正常結束 ⇒ 沒有那個欄位）**

`packages/llm-anthropic/test/anthropic.test.ts`：

```ts
  it("M72 Ⅱ: stop_reason max_tokens reaches the seam as truncated", async () => {
    const sse = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 5 } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end", truncated: true })
  })

  it("M72 Ⅱ: a clean ending carries NO truncated field", async () => {
    const sse = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end" })
  })
```

`packages/llm-openai-compatible/test/openai-compatible.test.ts`：同形狀，SSE 換成

```ts
    const sse = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`
```

（第二條把 `"length"` 換成 `"stop"`。）

`packages/llm-openai/test/openai.test.ts`——**這一家的截斷事件今天完全不存在**（`response.incomplete` 落進 `return []`），所以三條：

```ts
  it("M72 Ⅱ: response.incomplete with reason max_output_tokens is a truncation", async () => {
    const sse = `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end", truncated: true })
  })

  it("M72 Ⅱ: response.incomplete for content_filter is NOT a truncation (it is a refusal)", async () => {
    // …同 fixture，reason 換成 "content_filter"…
    expect(events.at(-1)).toEqual({ type: "end" })
  })

  it("M72 Ⅱ: response.completed carries no truncated field", async () => {
    // …event: response.completed / {"type":"response.completed"}…
    expect(events.at(-1)).toEqual({ type: "end" })
  })
```

`packages/llm-gemini/test/gemini.test.ts`（用**該檔自己的 `sseResponse` helper**）：

```ts
  it("M72 Ⅱ: finishReason MAX_TOKENS reaches the seam as truncated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([{ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }] }])))
    const client = createGeminiClient({ apiKey: "test-key", baseUrl: "https://api.example", model: "gemini-2.5-pro" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end", truncated: true })
  })

  it("M72 Ⅱ: finishReason STOP carries no truncated field", async () => {
    // …同 fixture，finishReason 換成 "STOP"…
    expect(events.at(-1)).toEqual({ type: "end" })
  })
```

`packages/llm-bedrock/test/bedrock.test.ts`（用該檔的 `fakeRuntime`）：

```ts
  it("M72 Ⅱ: messageStop stopReason max_tokens reaches the seam as truncated", async () => {
    const { fake } = fakeRuntime([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x" } } },
      { messageStop: { stopReason: "max_tokens" } },
    ])
    const client = createBedrockClient({ model: "claude-x" }, fake)
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end", truncated: true })
  })

  it("M72 Ⅱ: messageStop stopReason end_turn carries no truncated field", async () => {
    // …同 fixture，stopReason 換成 "end_turn"…
    expect(events.at(-1)).toEqual({ type: "end" })
  })
```

- [ ] **Step 2: 跑它們，看到紅**

Run: 五個套件。Expected: 十條全部紅在「`{"type":"end"}` ≠ `{"type":"end","truncated":true}`」。

- [ ] **Step 3: 實作**

每家一個**閉包旗標**（`let truncated = false`）＋終止時只寫 `true`：

```ts
      yield truncated ? { type: "end", truncated: true } : { type: "end" }
```

各自的**設定點**：

- anthropic（`message_delta` 臂內，usage 之外）：
  ```ts
        const stop = (event.delta as { stop_reason?: string } | undefined)?.stop_reason
        if (stop === "max_tokens") truncated = true
  ```
- openai-compatible（chunk 迴圈的 `choices` 讀取處，`choice.delta` 旁）：
  ```ts
          if ((choice as { finish_reason?: string }).finish_reason === "length") truncated = true
  ```
- openai（新臂，放在 `response.completed` 之前）：
  ```ts
        // M72 Ⅱ: the Responses stream's truncation ending. `response.incomplete`
        // also fires for `content_filter` — a REFUSAL, not a truncation — so the
        // bit keys on the REASON, never on the event name.
        if (t === "response.incomplete") {
          const reason = (event.response as { incomplete_details?: { reason?: string } } | undefined)?.incomplete_details?.reason
          if (reason === "max_output_tokens") truncated = true
          return []
        }
  ```
- gemini（`handleChunk` 內，`candidates` 讀取處）：
  ```ts
        if ((candidates?.[0] as { finishReason?: string } | undefined)?.finishReason === "MAX_TOKENS") truncated = true
  ```
- bedrock（`handleMember` 內，`:236-240` 的註解旁）：
  ```ts
        if (m.messageStop?.stopReason === "max_tokens") truncated = true
  ```
  （並把那句「messageStart/messageStop carry no stream content」的註解改成它現在**確實**讀 `stopReason` 的事實——那正是本階段的主題。）

- [ ] **Step 4: 跑它們，看到綠**

Run: 五個套件 → 全綠（含既有的 `toEqual([{ type: "end" }])` 兩條：`packages/llm-openai-compatible/test/openai-compatible.test.ts:82-93`、`packages/provider/test/retry-wiring.test.ts:46`——**它們是本條「缺席即不寫」的守門人**）。

- [ ] **Step 5: 變異證明（每家一次，共五條）**

把該家的設定點拿掉 ⇒ 該家的「truncated」那條紅，而「clean ending」那條仍綠。還原並 `sha256sum` 驗證五個檔。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-anthropic packages/llm-openai packages/llm-openai-compatible packages/llm-gemini packages/llm-bedrock
git commit -m "feat(llm): every adapter reports its own truncation ending as one bit (M72 II)"
```

---

### Task 7: 讓那一格進得了紀錄——session log、telemetry、`run` 的輸出

**Files:**
- Modify: `packages/core-session/src/index.ts`（`step/end` 臂 `:25`）
- Modify: `packages/core-agent/src/index.ts`（`case "end"` `:397`；`step/end` append `:441`）
- Modify: `packages/telemetry/src/types.ts`（union）與 `packages/telemetry/src/manifest.ts`（manifest 表）
- Modify: `packages/llm-mock/src/index.ts`（`MockStep` `:8-15`；終止 `:37`）
- Modify: `apps/cli/src/run.ts`（`HeadlessResult` `:218-227`；drain 之後 `:780-790`；stderr 摘要 `:828` 旁）
- Modify: `apps/cli/src/index.ts`（`:487` 的輸出旁）
- Test: `packages/core-agent/test/agent.test.ts`、`packages/llm-mock/test/mock.test.ts`、`apps/cli/test/metrics-summary.test.ts`（照它的 harness）

**Interfaces:**
- Consumes: `ev.truncated`（Task 6）
- Produces: session 事件 `{ type: "step/end"; truncated?: true }`；telemetry 事件 `provider/truncated`（`data: { step: number }`）；`HeadlessResult.truncated?: boolean`；`MockStep.truncated?: true`（讓 `runHeadless` 的 `mockScript` 能演一個截斷的結局——沒有它，這條路徑在 CLI 上**無法端到端被驗**）

- [ ] **Step 1: 寫紅測試（三處）**

`packages/core-agent/test/agent.test.ts`（`makeDeps(ctx)` 帶的 session 就在手上；telemetry 的斷言照 `packages/core-agent/test/provider-usage.test.ts` 的 sink 形狀）：

```ts
  it("M72 Ⅱ: a truncated step is written durably and reported as telemetry", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = {
      async *stream() {
        yield { type: "text/chunk", text: "partial" }
        yield { type: "end", truncated: true }
      },
    }
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p", maxTurns: 1 })
    await agent.run("hi")
    expect(deps.session.events.find((e) => e.type === "step/end")).toMatchObject({ truncated: true })
  })

  it("M72 Ⅱ: a clean step writes no truncated field", async () => {
    // …同 fixture，改成 yield { type: "end" }…
    expect(deps.session.events.find((e) => e.type === "step/end")).not.toHaveProperty("truncated")
  })
```

`packages/llm-mock/test/mock.test.ts`：

```ts
  it("M72 Ⅱ: a mock step can end truncated", async () => {
    const events = []
    for await (const ev of createMockClient([{ role: "assistant", text: "partial", truncated: true }]).stream(request)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end", truncated: true })
  })
```

`apps/cli/test/metrics-summary.test.ts`（該檔的 `mkdtempSync` ＋ `console.error` spy harness 直接可抄）：

```ts
  it("M72 Ⅱ: a truncated run says so on STDERR and on the result", async () => {
    const result = await runHeadless("say hi", {
      workspace: root,
      mockScript: [{ role: "assistant", text: "partial", truncated: true }],
    })
    expect(result.truncated).toBe(true)
    expect(errors.some((line) => line.includes("[truncated]"))).toBe(true)
  }, 30_000)

  it("M72 Ⅱ: a clean run neither says it nor sets the field", async () => {
    const result = await runHeadless("say hi", { workspace: root, mockScript: [{ role: "assistant", text: "hi" }] })
    expect(result.truncated).toBeUndefined()
    expect(errors.some((line) => line.includes("[truncated]"))).toBe(false)
  }, 30_000)
```

- [ ] **Step 2: 跑它們，看到紅**

Run: `pnpm --filter @i-harness/core-agent test`、`--filter @i-harness/telemetry test`、`--filter @i-harness/cli test`。

- [ ] **Step 3: 實作**

`packages/core-session/src/index.ts` 的 `step/end` 臂：

```ts
  | { type: "step/end"; seq?: number; /** M72 Ⅱ: the provider stopped at the output cap. */ truncated?: true }
```

`core-agent` 的 `case "end"`（`:397-398`）：

```ts
          case "end":
            // M72 Ⅱ. Recorded in TWO places on purpose: the durable log (what a
            // reopen reads) and the host's telemetry (what an operator watches).
            // Absent stays absent — a clean ending writes no field at all.
            if (ev.truncated === true) {
              truncatedThisStep = true
              deps.telemetry?.emit({ type: "provider/truncated", ts: Date.now(), data: { step: steps } })
            }
            break
```

（`let truncatedThisStep = false` 宣告在 `for await` 之前；`:441` 的 append 改成）

```ts
      append(deps.session, { type: "step/end", ...(truncatedThisStep ? { truncated: true } : {}) })
```

`packages/telemetry/src/types.ts` 的 union 加 `| "provider/truncated"`；`manifest.ts` 的表加一列（照 `provider/usage` 那一列的形狀，含「這個 code 是我們自己的、五來源審計沒有對應列」的註解）：

```ts
  { code: "provider/truncated", domain: "provider", description: "A provider round-trip ended at the output cap (count = round-trips that hit it)" },
```

`apps/cli/src/run.ts`：`HeadlessResult` 加 `truncated?: boolean`；drain 之後從 session log 讀（最後一個 `turn/start` 之後有任何 `step/end.truncated === true`）：

```ts
    const lastTurnStart = session.events.map((e) => e.type).lastIndexOf("turn/start")
    const truncated = session.events.slice(lastTurnStart).some((e) => e.type === "step/end" && e.truncated === true)
```

並在 `:828` 的 stderr 摘要旁（**不在 stdout**——stdout 只放 telemetry 的 NDJSON 與最終文字）印一行：

```ts
    if (truncated) console.error("[truncated] the provider stopped at the output cap; the answer is incomplete")
```

`HeadlessResult` 回傳時帶上 `...(truncated ? { truncated: true } : {})`；`apps/cli/src/index.ts:487` 之後同樣把該行印到 stderr（若該處已有 run 結果的處理點）。

- [ ] **Step 4: 跑它們，看到綠**

Run: 三個套件 + typecheck。

- [ ] **Step 5: 變異證明（兩條）**

(a) 把 core-agent 的 `truncatedThisStep = true` 那一行拿掉 ⇒ 兩條 core-agent 斷言紅；(b) 把 run.ts 的 `truncated` 導出改成 `false` ⇒ 該 CLI 測試紅。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/core-session/src/index.ts packages/core-agent/src/index.ts packages/telemetry/src packages/telemetry/test apps/cli
git commit -m "feat(observability): a truncated round-trip reaches the log, telemetry and run output (M72 II)"
```

---

### Task 8: `models list`／`provider list` 顯示**使用者寫的值**

**Files:**
- Modify: `apps/cli/src/models.ts`（`ModelsRouteView` `:234-248`；`viewOf` `:305-332`；`renderModels` `:281-292`）
- Modify: `apps/cli/src/provider.ts`（`cards` `:195-202`）
- Test: `apps/cli/test/models-command.test.ts`、`apps/cli/test/provider-command.test.ts`

**Interfaces:**
- Consumes: `ModelDescriptor.maxTokens`（**已存在**，`packages/provider/src/index.ts:320`，由 settings 列 merge 進去——`provider-runtime/src/index.ts:862-872`）
- Produces: 兩條 list 的每一行多一段 `set: N`

**實況（量測）**：`models list` 今天只印**卡片**的兩個數字（`:282-284`），使用者的值雖然在 `directory()` 的 row 上、卻被 `viewOf`（`:323-328`）投影掉了。

- [ ] **Step 1: 寫紅測試**

在 `models-command.test.ts` 既有案例（該檔 `:266` 已經斷言 `maxTokens: 409_600` 這種 row）旁新增：一個設定列帶 `maxTokens` 的模型 ⇒ 輸出的那一行含 `set: 409600`；同一個模型在**沒有**使用者值時，那一行**不含** `set:`。`provider-command.test.ts` 同形狀一條。

- [ ] **Step 2: 跑它們，看到紅**

Run: `pnpm --filter @i-harness/cli test`。Expected: 紅——今天的行只有卡片數字。

- [ ] **Step 3: 實作**

`models.ts`：`ModelsRouteView.models` 的元素加 `maxTokens?: number`；`viewOf` 的投影加 `...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {})`；`renderModels` 的行改成（**卡片與使用者值分開念**，因為它們是兩件事）：

```ts
      const numbers = model.card?.contextWindow !== undefined
        ? `${model.card.contextWindow}${model.card.maxOutputTokens !== undefined ? ` / ${model.card.maxOutputTokens}` : ""}`
        : "no card"
      // M72 Ⅱ: the value the USER wrote, said separately from the card — the
      // card is the model's documented ceiling, this is what a request will
      // actually carry. Absent → nothing printed (an unset switch is off).
      const setCap = model.maxTokens !== undefined ? `  set: ${model.maxTokens}` : ""
      lines.push(`  ${model.id}  (${numbers})${setCap}${ownProtocol}${model.aliases.length > 0 ? `  +retired: ${model.aliases.join(", ")}` : ""}`)
```

`provider.ts` 的 `cards`（`:195-202`）用同一形狀（`model.maxTokens`）。

- [ ] **Step 4: 跑它們，看到綠**

Run: `pnpm --filter @i-harness/cli test` + typecheck。

- [ ] **Step 5: 變異證明**

把 `setCap` 那段拿掉 ⇒ 兩條新測試紅。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/models.ts apps/cli/src/provider.ts apps/cli/test
git commit -m "feat(cli): models list and provider list show the user-written output cap (M72 II)"
```

---

### Task 9: 階段收尾（閘門＋報告）

**Files:**
- Modify: 無（只跑閘門與寫報告）

- [ ] **Step 1: `pnpm verify:all`**

Run: `pnpm verify:all`
Expected: 五步全綠（母體 67；`--gate` 不得新增 row——**本階段的新匯出有兩個**（`ANTHROPIC_MAX_TOKENS_FALLBACK` 由 `llm-anthropic` 用、`clampOutputCap` 由 `core-agent` 用），各有一個生產消費者；安全邊際常數刻意**不**匯出（只有自己檔用 ⇒ 會多一列）。若閘門說有未消費的 row，那是真的，回報而不要加 allowlist）。
**若 suite 紅在已量測的負載 flake**：隔離跑該套件，**兩個讀數都記**。

- [ ] **Step 2: 報告**（寫給控制器，不進 git）

每個任務各自的：紅先證據、GREEN、**每一條變異證明與其 sha 驗證**、被改動的既有斷言（引用前後並說明為何是**刻意**而非放鬆）、以及**沒有做的事**：拒答（`content_filter`／`SAFETY`／`refusal`）**沒有**自己的通道（本階段只保證它不掉進 `truncated`）；沒有自動重試或 compact；沒有新增 catalog 家族。

---

## 驗收（照 spec §2 第 2 條）

1. 五個轉接器**各自**的 body 在給定上限時帶**自己的** wire 欄位（逐一斷言，含 gemini／bedrock 的**父物件**）。
2. **沒有**給上限且**沒有**卡片時，**只有** anthropic 仍送出一個值（`ANTHROPIC_MAX_TOKENS_FALLBACK`），其餘四個不送。
3. `models list` 顯示**使用者寫的值**。
4. 截斷**可觀測**：被上限截斷的一回合在 telemetry（`provider/truncated`）與 `run` 的輸出裡看得出來。
5. `pnpm verify:all` 五步全綠、`--gate` 無新增 row。

**每一條都要有對應的變異證明**（把修法拿掉 ⇒ 該條紅）。

## 殘餘（本階段**不做**，寫出來不是忘了）

- **拒答沒有自己的通道**：`content_filter`（Responses）、`SAFETY`／`RECITATION`（gemini）、`stop_reason: "refusal"`（anthropic）今天都是「200 空成功」——本階段只保證它們**不掉進 `truncated`**；給它們一個通道要動 seam 的詞彙，是產品決定。
- **沒有 catalog 家族**：`anthropic`／`openai`／`openai-compatible` 三個 family 在 `model-catalog.json` **不存在**（今天只有 deepseek／gemini／bedrock）。⇒ 內建 anthropic profile 的預設模型 `claude-3-5-sonnet-latest`（CLI `apps/cli/src/index.ts:97`）沒有卡片、也沒有窗口，會拿到 `ANTHROPIC_MAX_TOKENS_FALLBACK`（128 000），而它的真實上限是 8 192 ⇒ **仍然 400**（與今天相同，但不是修好）。
- **legacy thinking 的 `budget_tokens` 與上限的關係**：`budget_tokens` 必須**小於** `max_tokens`；若使用者把上限設得比 legacy budget 小，Anthropic 會回 400。本階段不改 reasoning 的語意（Ⅲ 的地盤）。
- `config.options` 仍可覆蓋必填欄位（四個可、bedrock 不可）——但**上限本身**是 request 級別、寫在 options 之後，所以**不會**被 route 設定吃掉。
- `LLMRequest.model` 仍是死欄位。
