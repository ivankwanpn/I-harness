# M72 階段 Ⅲ — usage＋reasoning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 provider **回報的事實**真的進到紀錄——四家把**已經送到**的 token 數字映射成 seam 的 `usage` 事件（openai-compatible 還得**先問**），openai-compatible 的 `reasoning_content` 變成 `reasoning` 事件，並且把兩句**已被證偽的註解**與那條**釘住假前提的測試**修成真的。

**Architecture:** seam 的詞彙**不動**（`{ type: "usage"; usage: LLMUsage }` 與 `{ type: "reasoning"; text }` 都已存在）；本階段只讓**生產者**追上契約，逐一在各自的 wire 位置映射，並沿用 anthropic 已立下的兩條規矩：**只取有限數字**、**一個都認不出來就一個事件都不發**（absent ≠ 0）。openai-compatible 先做一次**結構性統一**（兩個 frame 迴圈合而為一），讓後面兩條規則只落在**一個**站點上。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-22-provider-boundary-design.md`（設計的權威；§1.4 是本階段的範圍，§2 第 3 條是驗收）

> **這是 M72 三階段的最後一份計畫。** 階段 Ⅰ（沉默的失敗）與 Ⅱ（輸出上限＋截斷可見）已合併（PR #5、#6）。階段 Ⅱ 的紀錄（`docs/handoff/2026-09-23-m72-phase-2.md`）§6 指定了本階段要接手的東西，其中兩條寫進本計畫（T4 的迴圈統一、T7 的 fallback 進鏈）。

## Global Constraints

- **紅先測試 ＋ 變異證明**：每一條修法都要先看到紅，實作後**把修法拿掉一次**、確認測試變紅、再用 Edit 工具還原（**絕不**用 `git checkout --`，它會還原到 HEAD 而不是你的編輯），並以 `sha256sum` 確認位元組還原。
- **既有測試只在「它刻意斷言的正是這次要改的契約」時才改**，而且要**具名說明**、不得放鬆（`expect` 只能變嚴或等價）。已知會撞到的**只有兩條**：`packages/llm-gemini/test/gemini.test.ts` 那條 fixture 帶 `usageMetadata` 卻期望「沒有 usage」的案例（T2），以及 `packages/llm-bedrock/test/bedrock.test.ts:159` 那條**標題就是假前提**的案例（T3，spec §2.3④ 指名）。
- **提交訊息不加任何 attribution trailer**；**不 amend**；blobs LF；檔案用 Write/Edit 工具寫。
- **每個任務只跑自己套件的測試與 typecheck**；`pnpm verify:all` **整支分支只跑一次**（收尾任務）。
- **不要動 `docs/`**（紀錄由控制器寫）；**不要動 seam 的事件聯集與 `LLMUsage` 的欄位**（本階段只加生產者）。
- **映射的兩條鐵律**（照 `packages/llm-anthropic/src/index.ts:14-27` 的 `mapUsage`）：①每個欄位只在 `typeof v === "number" && Number.isFinite(v)` 時才取；②**一個可辨識的數字都沒有 ⇒ 回 `undefined` ⇒ 不發事件**（捏造的 `0` 會被讀成一次沒人做過的測量）。
- **缺席即缺席**：沒有的值不寫鍵；`provider/usage` 的事件數是「真的有回報的往返數」的分母。
- **abort 不是 provider 失敗**；`error` 是終止的（發出即 `return`）。
- **每一條新規則只落在一處**（openai-compatible 在 T4 之後只剩一個 frame handler；任何「同一條規則寫兩份」都會被複審當缺陷）。

---

### Task 1: `llm-openai`（Responses）——`response.completed` 的 usage 不再被丟掉

**Files:**
- Modify: `packages/llm-openai/src/index.ts`（`response.completed` 臂；檔尾附近新增 `mapUsage`；import）
- Test: `packages/llm-openai/test/openai.test.ts`

**Interfaces:**
- Consumes: `LLMUsage`（`@i-harness/llm-seam`）、`{ type: "usage"; usage: LLMUsage }`
- Produces: 行為——`response.completed.response.usage` ⇒ 一個 `usage` 事件

**實況（量測）**：`packages/llm-openai/src/index.ts:217` 是 `if (t === "response.completed") return []`——payload 整顆落地。wire 位置與欄位名以本樹自己的紀錄為準：`docs/superpowers/specs/2026-09-18-m5-t2-prompt-cache-continuity-design.md:184` 的對照表寫明 `response.completed.response.usage` ⇒ `input_tokens`／`output_tokens`／`input_tokens_details.cached_tokens`。

- [ ] **Step 1: 寫紅測試**

```ts
  it("M72 Ⅲ: response.completed's usage reaches the seam", async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { usage: { input_tokens: 25, output_tokens: 7, input_tokens_details: { cached_tokens: 19 } } },
    })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.filter((e) => e.type === "usage")).toEqual([
      { type: "usage", usage: { inputTokens: 25, outputTokens: 7, cacheReadTokens: 19 } },
    ])
    expect(events.at(-1)).toEqual({ type: "end" })
  })

  it("M72 Ⅲ: a completed response with NO usage emits no usage event", async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.some((e) => e.type === "usage")).toBe(false)
    expect(events.at(-1)).toEqual({ type: "end" })
  })

  it("M72 Ⅲ: only the numbers the wire actually sent are mapped", async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 25 } } })}\n\n`
    // …同 fixture…
    const usage = events.find((e) => e.type === "usage") as { usage: Record<string, unknown> } | undefined
    expect(usage?.usage).toEqual({ inputTokens: 25 })
    expect("outputTokens" in (usage?.usage ?? {})).toBe(false)
    expect("cacheReadTokens" in (usage?.usage ?? {})).toBe(false)
  })
```

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/llm-openai test`
Expected: 第 1、3 條紅（今天 `response.completed` 回 `[]`，`events` 裡只有 `end`）；第 2 條**綠先**（今天本來就沒有 usage）——它的殺手是 Step 5 的變異 (b)。

- [ ] **Step 3: 實作**

`packages/llm-openai/src/index.ts` 的 `response.completed` 臂（`:217`）：

```ts
        if (t === "response.completed") {
          // M72 Ⅲ: the Responses API reports this round-trip's usage HERE and
          // nowhere else — the arm used to drop the payload on the floor. The
          // rules are llm-anthropic's `mapUsage`: finite numbers only, and no
          // recognisable number at all means NO event (a fabricated 0 would read
          // as a measurement nobody made).
          const usage = mapUsage((event.response as { usage?: unknown } | undefined)?.usage)
          return usage !== undefined ? [{ type: "usage", usage }] : []
        }
```

檔尾（或既有 helper 旁）加：

```ts
/** M72 Ⅲ: the Responses shape → the seam's `LLMUsage`. Field names differ from
 * message-start's, so the mapper lives per wire (the seam owns the vocabulary,
 * each adapter owns its spelling). */
function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const details = (r.input_tokens_details ?? {}) as Record<string, unknown>
  const out: LLMUsage = {}
  const take = (from: unknown, to: keyof LLMUsage): void => {
    if (typeof from === "number" && Number.isFinite(from)) out[to] = from
  }
  take(r.input_tokens, "inputTokens")
  take(r.output_tokens, "outputTokens")
  take(details.cached_tokens, "cacheReadTokens")
  return Object.keys(out).length > 0 ? out : undefined
}
```

import 行加 `type LLMUsage`。

- [ ] **Step 4: 跑它，看到綠**

Run: `pnpm --filter @i-harness/llm-openai test` + typecheck。既有的 fixtures 送的是**裸的** `response.completed`（沒有 `response.usage`）⇒ 它們的期望清單不變。

- [ ] **Step 5: 變異證明（兩條）**

(a) 把整段映射改回 `return []` ⇒ 第 1、3 條紅；(b) 把「沒有可辨識數字就回 undefined」改成無條件回 `out`（於是空物件也發事件）⇒ 第 2 條紅。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-openai/src/index.ts packages/llm-openai/test/openai.test.ts
git commit -m "feat(llm-openai): the Responses usage rides the seam's usage event (M72 III)"
```

---

### Task 2: `llm-gemini`——末塊的 `usageMetadata`

**Files:**
- Modify: `packages/llm-gemini/src/index.ts`（`handleChunk`；新增 `mapUsage`；那段「not mapped here」的註解）
- Test: `packages/llm-gemini/test/gemini.test.ts`

**Interfaces:**
- Produces: 行為——末塊的 `usageMetadata` ⇒ 一個 `usage` 事件

**實況（量測）**：`handleChunk`（`:231-268`）只讀 `candidates[0].content.parts`；`:261-267` 的註解（階段 Ⅱ 修過措辭）現在誠實地說「這個轉接器沒有把它映射上去」——**本任務把那句話變成過去式**。欄位名以 M5-T2 表（`:186`）為準：`promptTokenCount`／`candidatesTokenCount`／`cachedContentTokenCount`。

- [ ] **Step 1: 寫紅測試**

```ts
  it("M72 Ⅲ: the last chunk's usageMetadata reaches the seam", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 5, cachedContentTokenCount: 1 } },
    ])))
    const client = createGeminiClient({ apiKey: "test-key", baseUrl: "https://api.example", model: "gemini-2.5-pro" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.filter((e) => e.type === "usage")).toEqual([
      { type: "usage", usage: { inputTokens: 2, outputTokens: 5, cacheReadTokens: 1 } },
    ])
  })

  it("M72 Ⅲ: a chunk without usageMetadata emits no usage event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }] },
    ])))
    const client = createGeminiClient({ apiKey: "test-key", baseUrl: "https://api.example", model: "gemini-2.5-pro" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.some((e) => e.type === "usage")).toBe(false)
    expect(events.at(-1)).toEqual({ type: "end" })
  })
```

**既有測試會撞到一條**（`packages/llm-gemini/test/gemini.test.ts:71-82`）：它的 fixture **已經**帶 `usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 5 }`，而期望清單略過 usage。**具名改它**：把期望清單補上對應的 `usage` 事件（**加**一條，不放寬任何既有元素），並在註解寫明「本階段之前它刻意斷言的是『沒有映射』」。

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/gemini test`（套件名以 `packages/llm-gemini/package.json` 為準）
Expected: 新第 1 條紅、既有那條紅（差一個 usage 事件）；新第 2 條綠先（殺手是 Step 5 的變異 (b)）。

- [ ] **Step 3: 實作**

`handleChunk` 在 `return events` **之前**：

```ts
        // M72 Ⅲ: `usageMetadata` rides the LAST chunk — mapped here instead of
        // only documented. (The comment this replaces said the seam had no usage
        // event; M72 Ⅱ corrected that sentence, this maps it.)
        const usage = mapUsage(event.usageMetadata)
        if (usage !== undefined) events.push({ type: "usage", usage })
```

檔內加：

```ts
/** M72 Ⅲ: Gemini's `usageMetadata` → the seam's `LLMUsage` (finite numbers
 * only; nothing recognisable ⇒ no event, never a fabricated zero). */
function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const out: LLMUsage = {}
  const take = (from: unknown, to: keyof LLMUsage): void => {
    if (typeof from === "number" && Number.isFinite(from)) out[to] = from
  }
  take(r.promptTokenCount, "inputTokens")
  take(r.candidatesTokenCount, "outputTokens")
  take(r.cachedContentTokenCount, "cacheReadTokens")
  return Object.keys(out).length > 0 ? out : undefined
}
```

並把 `:261-267` 那段「does not map … onto it」改寫成現在的事實（映射**在**這裡、欄位名是什麼）。

- [ ] **Step 4: 跑它，看到綠**

Run: 該套件 test + typecheck。

- [ ] **Step 5: 變異證明（兩條）**

(a) 拿掉 `mapUsage` 那三行 ⇒ 新第 1 條與既有那條紅；(b) 讓它無條件發事件 ⇒ 新第 2 條紅。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-gemini/src/index.ts packages/llm-gemini/test/gemini.test.ts
git commit -m "feat(llm-gemini): the last chunk's usageMetadata becomes a usage event (M72 III)"
```

---

### Task 3: `llm-bedrock`——`metadata` 的 usage 快照，以及那條**假前提的測試**

**Files:**
- Modify: `packages/llm-bedrock/src/index.ts`（`handleMember` 的 `metadata` 臂；新增 `mapUsage`；那段註解）
- Test: `packages/llm-bedrock/test/bedrock.test.ts`（**spec §2.3④ 指名的那條**）

**Interfaces:**
- Produces: 行為——`metadata.usage` ⇒ 一個 `usage` 事件

**實況（量測）**：成員型別在 `:185` 已宣告 `metadata?: { usage?: unknown }`（**有型別、從未讀**）；`:244-254` 的註解（階段 Ⅱ 修過）說「這個轉接器沒有把快照映射上去」；`:255` 是 `messageStop` 的截斷讀取。

- [ ] **Step 1: 寫紅測試，並**改寫**那條假前提的測試**

`packages/llm-bedrock/test/bedrock.test.ts:159` 現在是：

```ts
  it("ignores the metadata/usage member (no usage event in the seam vocabulary)", async () => {
```

**改成**（標題與斷言都改，因為它們斷言的正是這次要改的契約——spec §2.3④ 指名這條）：

```ts
  it("M72 Ⅲ: maps the metadata/usage member onto the seam's usage event", async () => {
    const { fake } = fakeRuntime([
      { metadata: { usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, metrics: { latencyMs: 10 } } },
      { messageStop: { stopReason: "end_turn" } },
    ])
    const client = createBedrockClient({ model: "m" }, fake)
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "end") events.push("end")
      if (ev.type === "text/chunk") events.push(`t:${ev.text}`)
      if (ev.type === "usage") events.push(`u:${ev.usage.inputTokens}/${ev.usage.outputTokens}`)
    }
    expect(events).toEqual(["u:5/3", "end"])
  })

  it("M72 Ⅲ: a metadata member without a recognisable number emits no usage event", async () => {
    const { fake } = fakeRuntime([
      { metadata: { metrics: { latencyMs: 10 } } },
      { messageStop: { stopReason: "end_turn" } },
    ])
    const client = createBedrockClient({ model: "m" }, fake)
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "end") events.push("end")
      if (ev.type === "usage") events.push(`u:${ev.usage.inputTokens}/${ev.usage.outputTokens}`)
    }
    expect(events).toEqual(["end"])
  })
```

**並先量一件本計畫無法代答的事**：`@aws-sdk/client-bedrock-runtime` 的 `TokenUsage` 型別**實際宣告了哪些欄位**（本樹自己的 M5-T2 表只寫 `inputTokens`／`outputTokens`）。若型別裡有 `cacheReadInputTokens`／`cacheWriteInputTokens`，**一併映射**（→ `cacheReadTokens`／`cacheCreationTokens`，與 anthropic 的欄位語意對齊），並在報告裡寫明量到什麼。

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/llm-bedrock test`
Expected: 兩條新的紅（今天沒有任何 `u:`）；既有那條**已改寫**的紅到它以新標題重跑為止。

- [ ] **Step 3: 實作**

`handleMember` 內（`messageStop` 那行之後、例外掃描之前）：

```ts
        // M72 Ⅲ: `metadata` carries the round-trip's usage snapshot — typed
        // here since the beginning and never read. Same two rules as every
        // other adapter: finite numbers only, and nothing recognisable ⇒ no
        // event at all.
        const usage = mapUsage(m.metadata?.usage)
        if (usage !== undefined) return [{ type: "usage", usage }]
```

（`usage` 的映射：`inputTokens`→`inputTokens`、`outputTokens`→`outputTokens`，加上 Step 1 量到的 cache 欄位；用同一個 `take`-式 helper。）並把那句「does not map the snapshot onto it」改成現在的事實。

- [ ] **Step 4: 跑它，看到綠**

Run: 該套件 test + typecheck。

- [ ] **Step 5: 變異證明（兩條）**

(a) 拿掉 `mapUsage` 那兩行 ⇒ 改寫後的那條紅；(b) 讓它無條件發事件 ⇒ 新第 2 條紅。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-bedrock/src/index.ts packages/llm-bedrock/test/bedrock.test.ts
git commit -m "feat(llm-bedrock): the metadata usage snapshot becomes a usage event (M72 III)"
```

---

### Task 4: `llm-openai-compatible`——把兩個 frame 迴圈合成一個（先做，讓後面兩條規則只有一個站點）

**Files:**
- Modify: `packages/llm-openai-compatible/src/index.ts`（主迴圈 `:195-235` 與殘餘 flush `:236-250`）
- Test: `packages/llm-openai-compatible/test/openai-compatible.test.ts`

**Interfaces:**
- Produces: 檔內一個 `handleFrame(event) => { events, done }`，兩個呼叫點共用

**實況（量測）**：兩份逐字近似的解析（主迴圈 + 殘餘 flush）。階段 Ⅱ 的 R12 **補了第二份**而不是合併，而 flush 那份**至今仍缺 `tool_calls` 片段累積**（階段 Ⅱ 紀錄 §5.4 的殘餘）⇒ **只在無邊界末幀出現的工具呼叫會被丟掉**。本任務把它結構性地關掉。

- [ ] **Step 1: 寫紅測試**（紅的是**既有的缺陷**，不是新功能）

```ts
  it("M72 Ⅲ: a tool call that arrives ONLY in a boundary-less final frame is not dropped", async () => {
    // no trailing "\n\n": the main loop parses nothing, the flush handles it
    const body = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":"a.txt"}' } }] } }] })}`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.filter((e) => e.type === "tool_call")).toEqual([{ type: "tool_call", call: { name: "read", args: { path: "a.txt" } } }])
  })
```

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/llm-openai-compatible test`
Expected: 紅——只有 `end`（flush 不累積 tool_calls）。

- [ ] **Step 3: 實作**

把「一幀 → 事件」的邏輯抽成**一個**閉包，兩個迴圈都呼叫它：

```ts
      // M72 Ⅲ: ONE frame handler for both the read loop and the residual
      // flush. R12 patched the second copy of a rule; the copies had already
      // drifted (the flush never accumulated tool-call fragments, so a tool
      // call arriving only in a boundary-less final frame was dropped). New
      // wire rules land HERE, once.
      const handleFrame = (event: Record<string, unknown>): { events: LLMStreamEvent[]; done: boolean } => {
        if (event.type === "[DONE]") return { events: [], done: true }
        const events: LLMStreamEvent[] = []
        const choices = (event as { choices?: { delta?: Record<string, unknown> }[] }).choices ?? []
        for (const choice of choices) {
          const delta = choice.delta ?? {}
          if ((choice as { finish_reason?: string }).finish_reason === "length") truncated = true
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
        return { events, done: false }
      }
```

兩個呼叫點改成：

```ts
            const frame = handleFrame(event)
            if (frame.done) { receivedDone = true; break }
            if (yield* emit(frame.events)) return
            if (yield* flushParsedToolCalls()) return
```

（主迴圈與 flush 各一次；R12 那句「the same rule as the main loop」的註解改成指向 `handleFrame`。**`truncated` 的讀取因此只剩一處**——把那條 R12 的註解併進 `handleFrame`。）

- [ ] **Step 4: 跑它，看到綠**

Run: 該套件 test + typecheck → **全部**既有案例（含 R12 的無邊界末幀截斷、[DONE]、殘餘工具呼叫）都要綠。

- [ ] **Step 5: 變異證明**

把 flush 的呼叫點改回「自己解 delta.content」（即還原成兩份）⇒ 新測試紅。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-openai-compatible/src/index.ts packages/llm-openai-compatible/test/openai-compatible.test.ts
git commit -m "refactor(llm-openai-compatible): one frame handler for both loops — the flush stops dropping tool calls (M72 III)"
```

---

### Task 5: `llm-openai-compatible`——`stream_options` 與 usage（**先問才有**）

**Files:**
- Modify: `packages/llm-openai-compatible/src/index.ts`（config；body；`handleFrame`）
- Modify: `packages/provider/src/index.ts`（`ProviderProfile`／`WireClientConfig`／`buildClient`）
- Modify: `packages/provider-runtime/src/index.ts`（`ProviderView`／`providerView`／`runtimeProfile`）
- Modify: `packages/settings/src/index.ts`（`SettingsProviderConfig` ＋ normalizer ＋ 型別）與 `packages/settings/src/sections.ts`（FieldSpec 列）
- Test: `packages/llm-openai-compatible/test/openai-compatible.test.ts`、`packages/provider/test/retry-wiring.test.ts`、`packages/provider-runtime/test/runtime.test.ts`、`packages/settings/test/sections.test.ts`

**Interfaces:**
- Produces: `OpenAICompatibleConfig.usageInStream?: boolean`；`ProviderProfile.usageInStream?`；`SettingsProviderConfig.usageInStream?`（布林）；行為——**預設送** `stream_options: { include_usage: true }`，`usageInStream: false` 時**不送**；尾端的 usage-only chunk ⇒ `usage` 事件

**為什麼這條要先問**（spec §1.4／§4）：這是五家**唯一**一個「預設不送 usage」的協議，而送 `stream_options` 是**請求形狀的改變**——不支援它的 gateway 可能拒絕（Pi 的 `supportsUsageInStreaming` 就是為此存在）。所以閘門是**per-route 能力欄位**，預設開。

**欄位名與 plumbing 照 phase Ⅱ 的 `maxTokensField` 逐條複製**（同一條鏈、同一個先例；`inputModalities` 是更早的同一形狀）：settings 型別＋normalizer＋FieldSpec 列 → `ProviderView` → `providerView`（user-else-template）→ `runtimeProfile`（route 級）→ `ProviderProfile`／`WireClientConfig` → `buildClient` → adapter config。

- [ ] **Step 1: 寫紅測試（四條）**

```ts
  // llm-openai-compatible
  it("M72 Ⅲ: the request asks for usage by default", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.stream_options).toEqual({ include_usage: true })
    await it.return?.()
  })

  it("M72 Ⅲ: a route that says its gateway rejects the key does NOT send it", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m", usageInStream: false })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect("stream_options" in body).toBe(false)
    await it.return?.()
  })

  it("M72 Ⅲ: the trailing usage-only chunk reaches the seam", async () => {
    const sse = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, prompt_cache_hit_tokens: 7 } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.filter((e) => e.type === "usage")).toEqual([
      { type: "usage", usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 7 } },
    ])
    expect(events.at(-1)).toEqual({ type: "end" })
  })

  // provider（wiring，照 retry-wiring.test.ts:79 的真轉接器 + stub fetch 形狀）
  it("M72 Ⅲ: a route's usageInStream reaches the wire", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = buildModelClient({
      name: "gw", displayName: "GW", protocol: "openai-compatible",
      apiKey: "k", baseUrl: "https://gw.test", usageInStream: false,
    }, "m")
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect("stream_options" in body).toBe(false)
    await it.return?.()
  })
```

（`provider-runtime` 與 `settings` 各加一條 plumbing 測試：`usageInStream: false` 從 route 設定一路到 profile／被 normalizer 保留、垃圾值被丟掉。**逐字照同一個先例**——`maxTokensField` 在 `packages/provider-runtime/test/runtime.test.ts` 與 `packages/settings/test/sections.test.ts` 已各有一條，把那兩條的欄位名與期望值換成 `usageInStream` 的布林即可，其餘不動。）

- [ ] **Step 2: 跑它們，看到紅**

Run: `pnpm --filter @i-harness/llm-openai-compatible test`、`--filter @i-harness/provider test`、`--filter @i-harness/provider-runtime test`、`--filter @i-harness/settings test`。

- [ ] **Step 3: 實作**

body（放在 `...(config.options ?? {})` **之前**——route 設定要能覆蓋它）：

```ts
        // M72 Ⅲ: usage must be ASKED for on this wire (the other four report it
        // unasked). Default ON — a routing flag, not a guess about capability;
        // a gateway that rejects the key is switched off per route with
        // `usageInStream: false` (Pi's supportsUsageInStreaming, explicit).
        ...((config.usageInStream ?? true) ? { stream_options: { include_usage: true } } : {}),
```

`handleFrame`（T4 之後**一處**）的末段：

```ts
        // M72 Ⅲ: the opt-in delivers a trailing usage-only chunk (choices: []).
        const usage = mapUsage((event as { usage?: unknown }).usage)
        if (usage !== undefined) events.push({ type: "usage", usage })
```

`mapUsage`：`prompt_tokens`→`inputTokens`、`completion_tokens`→`outputTokens`、`prompt_cache_hit_tokens`→`cacheReadTokens`（規矩同前三家）。

plumbing：`usageInStream?: boolean` 逐層複製 `maxTokensField` 的既有路徑；settings 的 FieldSpec 用 `{ type: "boolean" }`；normalizer 只在 `typeof v === "boolean"` 時保留。

- [ ] **Step 4: 跑它們，看到綠**

Run: 四個套件 test + typecheck。

- [ ] **Step 5: 變異證明（三條）**

(a) 把 `?? true` 改成無條件送 ⇒ 「不送」那條紅；(b) 拿掉 usage 映射 ⇒ 尾端 chunk 那條紅；(c) 讓 `provider-runtime` 不傳 `usageInStream` ⇒ wiring 那條紅。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-openai-compatible packages/provider packages/provider-runtime packages/settings
git commit -m "feat(llm-openai-compatible): usage is asked for (default on, per-route off) and mapped (M72 III)"
```

---

### Task 6: `llm-openai-compatible`——`reasoning_content` 變成 `reasoning`

**Files:**
- Modify: `packages/llm-openai-compatible/src/index.ts`（`handleFrame` 的 delta 讀取；**一處**）
- Test: `packages/llm-openai-compatible/test/openai-compatible.test.ts`

**Interfaces:**
- Produces: 行為——`delta.reasoning_content` ⇒ `{ type: "reasoning"; text }`

**實況（量測）**：`reasoning_content` 在 `packages/` **全樹零命中**（只有 `docs/CAPABILITIES-DETAIL.md:525` 把它列為 wire 欄位）⇒ DeepSeek 家族的推理內容今天**整段被丟掉**（spec §0 的審計列）。

- [ ] **Step 1: 寫紅測試**

```ts
  it("M72 Ⅲ: delta.reasoning_content becomes a reasoning event", async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "weighing options" } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(["reasoning", "text/chunk", "end"])
    expect(events[0]).toEqual({ type: "reasoning", text: "weighing options" })
  })

  it("M72 Ⅲ: an empty reasoning_content emits nothing", async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "" } }] })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.some((e) => e.type === "reasoning")).toBe(false)
  })

  it("M72 Ⅲ: a boundary-less final frame's reasoning_content is not dropped", async () => {
    // no trailing "\n\n" → the flush parses this frame; T4 unified the two
    // paths, so this also pins that unification.
    const body = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "late thought" } }] })}`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.filter((e) => e.type === "reasoning")).toEqual([{ type: "reasoning", text: "late thought" }])
  })
```

- [ ] **Step 2: 跑它，看到紅**

Run: 該套件。

- [ ] **Step 3: 實作**

`handleFrame` 的 choice 迴圈內（`delta.content` 旁）：

```ts
          // M72 Ⅲ: DeepSeek-family gateways stream the reasoning text on
          // `delta.reasoning_content` — a sibling of `content` that had ZERO
          // readers in this tree, so the whole trajectory was dropped.
          const reasoningText = (delta as { reasoning_content?: unknown }).reasoning_content
          if (typeof reasoningText === "string" && reasoningText.length > 0) {
            events.push({ type: "reasoning", text: reasoningText })
          }
```

（**順序**：reasoning 排在該幀的 content 之前——同一幀同時帶兩者時，模型是先想再答。）

- [ ] **Step 4: 跑它，看到綠**

Run: 該套件 test + typecheck。

- [ ] **Step 5: 變異證明**

拿掉那四行 ⇒ 第 1、3 條紅。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-openai-compatible/src/index.ts packages/llm-openai-compatible/test/openai-compatible.test.ts
git commit -m "feat(llm-openai-compatible): delta.reasoning_content becomes a reasoning event (M72 III)"
```

---

### Task 7: anthropic 的 fallback 進鏈——讓**夾取**看得到它（階段 Ⅱ 紀錄 §6 指定）

**Files:**
- Modify: `packages/provider-runtime/src/index.ts`（binding 組裝，`:653` 的 `effective` 之後；import）
- Test: `packages/provider-runtime/test/runtime.test.ts`

**Interfaces:**
- Consumes: `ANTHROPIC_MAX_TOKENS_FALLBACK`（`@i-harness/llm-seam`——`provider-runtime` **已依賴它**）
- Produces: 行為——一個 `anthropic-messages` route 在鏈**什麼都沒解析出來**時，binding 上帶 `maxOutputTokens = ANTHROPIC_MAX_TOKENS_FALLBACK`，於是它在 core-agent 那層**與其他值一樣被夾**；轉接器自己的常數退化成「直接使用轉接器的人」的最後手段

**為什麼**（階段 Ⅱ 終審 I1）：今天那個常數是**在轉接器裡**選的（那裡沒有窗口）⇒ 它**永遠沒被夾過**；`input 100K + 128000 > 200K` 的請求會 400——而那是「上下文快滿」時最容易發生的時刻。**仍然不覆蓋的路徑**：`compaction/src/summarizer.ts` 自己組的請求（不經 binding）——記為殘餘，見 §殘餘。

- [ ] **Step 1: 寫紅測試**

```ts
  it("M72 Ⅲ: an anthropic route with nothing resolved carries the protocol-required fallback", async () => {
    // 一個 anthropic-messages route、沒有卡片、設定列也沒有 maxTokens
    await expect(runtime.resolveModel({})).resolves.toMatchObject({
      status: "ready",
      binding: { modelId: "claude-x", maxOutputTokens: ANTHROPIC_MAX_TOKENS_FALLBACK },
    })
  })

  it("M72 Ⅲ: a non-anthropic route with nothing resolved carries NO cap", async () => {
    // 同一個 fixture，protocol 換成 "openai-compatible"
    const state = await runtime.resolveModel({})
    expect(state.status).toBe("ready")
    expect(state.status === "ready" ? state.binding.modelId : undefined).toBe("m")
    expect(state.status === "ready" ? state.binding : {}).not.toHaveProperty("maxOutputTokens")
  })
```

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/provider-runtime test`。Expected: 第 1 條紅（今天 binding 不帶 cap）；第 2 條**綠先**（殺手是 Step 5 的變異 (b)）。

- [ ] **Step 3: 實作**

`packages/provider-runtime/src/index.ts`（`:653-661` 的 `effective`／`contextWindow`／`maxOutputTokens` 之後）：

```ts
      // M72 Ⅲ: Anthropic's Messages API REQUIRES `max_tokens`, so its fallback
      // must be resolved HERE — where the protocol is known — or the value the
      // adapter invents never meets core-agent's clamp (the phase-Ⅱ record's
      // I1: `input 100K + 128000 > 200K` was a 400 on exactly the request that
      // ran because the context was nearly full).
      const maxOutputTokens = effective?.maxOutputTokens
        ?? (profile.protocol === "anthropic-messages" ? ANTHROPIC_MAX_TOKENS_FALLBACK : undefined)
```

（import 加 `ANTHROPIC_MAX_TOKENS_FALLBACK`；`profile.protocol` 的型別是既有的 `ProviderProtocol`，比對字串即可。）

- [ ] **Step 4: 跑它，看到綠**

Run: 該套件 test + typecheck；**並跑 `--filter @i-harness/core-agent test`**（它消費 `AgentDeps.maxOutputTokens`；夾取對大值是小於上限的數字，既有測試不受影響——若有一條動了，**具名**回報）。

- [ ] **Step 5: 變異證明（兩條）**

(a) 拿掉 `?? (profile.protocol === …)` 這段 ⇒ 第 1 條紅；(b) 把協議判斷拿掉（無條件套用常數）⇒ 第 2 條紅。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/provider-runtime/src/index.ts packages/provider-runtime/test/runtime.test.ts
git commit -m "fix(provider-runtime): the required anthropic fallback resolves in the chain, so the clamp sees it (M72 III)"
```

---

### Task 8: 階段收尾（閘門＋報告）

**Files:**
- Modify: 無（只跑閘門與寫報告）

- [ ] **Step 1: `pnpm verify:all`**

Run: `pnpm verify:all`
Expected: 五步全綠（母體 67；`--gate` 不得新增 row——本階段**不新增任何 seam 匯出**；`usageInStream` 是新欄位不是新匯出）。**若 suite 紅在已量測的負載 flake**（`apps/cli` 的 M12 retry 或 entry-guard）：依既有先例隔離跑該套件、**兩個讀數都記**；fix 已在 `c8dbfc4`（PR #7）。
- **若閘門說有未消費的 row，那是真的，回報而不要加 allowlist。**

- [ ] **Step 2: 報告**（寫給控制器，不進 git）

每個任務各自的：紅先證據、GREEN、**每一條變異證明與其 sha 驗證**、被改動的既有斷言（引用前後並說明為何是**刻意**而非放鬆——本階段預期**只有** gemini 那條與 bedrock 那條）、以及**沒有做的事**（見 §殘餘）。

---

## 驗收（照 spec §2 第 3 條）

1. usage 從**四個**轉接器各自到達 `provider/usage`（**四個獨立案例**：openai、gemini、bedrock、openai-compatible）。
2. `stream_options` **預設送**、能力欄位關掉時**不送**（兩條）。
3. openai-compatible 的 `reasoning_content` 變成 `reasoning` 事件。
4. 兩句假註解（gemini／bedrock）與那條**假前提的測試**（`bedrock.test.ts:159`）已修——測試改成斷言**真的事實**。
5. `pnpm verify:all` 五步全綠、`--gate` 無新增 row。

**每一條都要有對應的變異證明**（把修法拿掉 ⇒ 該條紅）。

## 殘餘（本階段**不做**，寫出來不是忘了）

- **`compaction/src/summarizer.ts` 自己組的請求**：它不經 binding，所以 T7 的 fallback **到不了它**——那條路徑在 anthropic 上仍可能因 `input + 128000 > window` 而 400。**候選修法**（記給下一個動 compaction 的人）：把上限放進 compaction 的設定，讓摘要請求帶自己的 cap。
- **`reasoning` 的語意仍不一致**：四個生產者取自四個**無關**的 wire 概念（anthropic 的 thinking、openai 的 **summary**、bedrock 的 `reasoningContent`、openai-compatible 的 `reasoning_content`），而 gemini 的 thought parts **仍不讀**（`thoughtSignature` 全樹零命中）。要一致化就得替密封上一個「這是原始思考還是摘要」的位——**產品決定**。
- **`"off"` 在 anthropic／bedrock 仍等於 unset**（API 的關法是 `{type:"disabled"}`）——需要產品決定，spec §3 已列。
- **拒答仍沒有自己的通道**（`content_filter`／`SAFETY`／`RECITATION`／`refusal`／`model_context_window_exceeded`）——階段 Ⅱ 的殘餘 1 原封不動。
- **`llm-mock` 仍發不出 `reasoning`**（core-agent 的推理測試因此自帶 fake client）；`MockStep` 只有 `usage`。
- **`docs/CAPABILITIES-DETAIL.md:525` 只列了 `reasoning_content`**，其餘四家的 usage／reasoning wire 位置在該文件裡沒有對應列——本階段不改文件。
