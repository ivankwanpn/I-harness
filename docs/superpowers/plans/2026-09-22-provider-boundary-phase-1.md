# M72 階段 Ⅰ — 沉默的失敗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 provider 邊界的**失敗浮上來**——補上被丟掉的 system prompt、把串流內部的錯誤事件（以及 bedrock 的 throw、四個解析器的裸 `JSON.parse`）變成看得見的 `error`。

**Architecture:** 四個轉接器（`llm-openai-compatible`／`llm-openai`／`llm-anthropic`／`llm-gemini`）與 `llm-bedrock` 各自對 seam 的 `LLMStreamEvent` 契約負責；本階段只動**請求的組裝**與**失敗的通道**，不新增任何 wire 欄位、不動 seam 的事件聯集。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-22-provider-boundary-design.md`（設計的權威；§1.5 是本階段的範圍，§2 第 1 條是驗收）

> **這是三階段中的第一份計畫。** spec 把 M72 分成三個**可各自出貨**的階段（照 M5/T4 的先例：一份 spec、每階段一份計畫）。**階段 Ⅱ（輸出上限＋截斷可見）與 Ⅲ（usage＋reasoning）日後各寫一份計畫**，本檔只涵蓋 **Ⅰ：沉默的失敗**。

## Global Constraints

- **紅先測試 ＋ 變異證明**：每一條修法都要先看到紅，並在實作後**把修法拿掉一次**、確認測試變紅、再逐位元組還原（`sha256sum` 前後相同）。**不得用 `git checkout --` 還原未提交的改動**（它會還原到 HEAD，不是你的編輯——本 repo 這一週被這個坑過兩次）。
- **既有測試只在「它刻意斷言的正是這次要改的契約」時才改**，而且要**具名說明**、不得放鬆（`expect` 只能變嚴或等價）。已知會撞到的**只有一條**（Task 1 的那條 `expect(body.system).toBeUndefined()`）。
- **提交訊息不加任何 attribution trailer**；**不 amend**；blobs LF；檔案用 Write/Edit 工具寫。
- **每個任務只跑自己套件的測試與 typecheck**；`pnpm verify:all` **整支分支只跑一次**（在階段的收尾任務）。
- **不要動 `docs/`**（紀錄由控制器寫）；不要動 `packages/llm-seam/src/index.ts` 的**事件聯集**（那屬於階段 Ⅱ）。
- **`error` 事件的形狀**：`{ type: "error"; error: Error }`（seam 既有成員，見 `packages/llm-seam/src/index.ts:34`）。**`error` 是終止的**：發出它就 `return`，不要再發 `end`（bedrock 既有實作就是這個規矩，見其 `:243-249`）。
- **abort 不是 provider 失敗**：任何把例外轉成事件的 `catch`，都必須在 `request.signal?.aborted === true` 時**重新拋出**——取消要維持今天「從產生器拋出」的行為，不得變成一個 `error` 事件。

---

### Task 1: `llm-openai-compatible` 把 system prompt 送出去

**Files:**
- Modify: `packages/llm-openai-compatible/src/index.ts`（`toWireMessage` 附近的組裝）
- Test: `packages/llm-openai-compatible/test/openai-compatible.test.ts`

**Interfaces:**
- Consumes: `LLMRequest.systemPrompt: string`（seam，必填、可為空字串）
- Produces: 無新介面；**行為**：非空的 `systemPrompt` 成為 `body.messages` 的**第一則** `{ role: "system", content: … }`

**現況（量測）**：`toWireMessage`（`:72-89`）只有 `tool`／`assistant`／其他三個分支，`systemPrompt` **全檔未被讀**；測試 `:25` 的 `expect(body.system).toBeUndefined()` 把這件事釘成正確，而同一條斷言的 `body.messages`（`:26-30`）裡也沒有 system 訊息。**內建的 `deepseek` profile 走的就是這條線。**

- [ ] **Step 1: 寫紅測試**（改既有那條，並新增一條空字串的）

在 `packages/llm-openai-compatible/test/openai-compatible.test.ts` 的既有案例裡，把 `:25` 那一行換成：

```ts
    // M72 Ⅰ: the system prompt is a MESSAGE, not a top-level field — the old
    // assertion (`body.system` undefined) was true about the field and wrong
    // about the mapping: it left the prompt on the floor.
    expect(body.system).toBeUndefined()
```
並把 `:26-30` 的期望陣列改成（**system 在最前面**）：

```ts
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"content":"data"}' },
    ])
```

在**同一個 describe 內、既有案例之後**追加一條：

```ts
  it("M72 Ⅰ: a blank system prompt sends NO system message (nothing to say)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      systemPrompt: "",
    } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.messages).toEqual([{ role: "user", content: "hi" }])
    await it.return?.()
  })
```

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/llm-openai-compatible test`
Expected: 第一條紅在**期望陣列少了 system 那則**（`expected [ …(3) ] to deeply equal [ …(4) ]`）；第二條**綠**（今天本來就不送）。

- [ ] **Step 3: 實作**

在 `packages/llm-openai-compatible/src/index.ts` 的 body 組裝處（`:98-109`），把 `messages` 改成先鋪 system：

```ts
        const body = {
          model: config.model,
          // M72 Ⅰ: the system prompt is the first MESSAGE. The old code sent no
          // system content at all — chat/completions has no top-level `system`
          // FIELD, but the role IS the mapping, and dropping it meant every
          // request to a compatible gateway ran without its system prompt.
          // Blank → no message: same rule as llm-gemini/llm-bedrock, and an
          // empty system turn is pure overhead.
          messages: [
            ...(request.systemPrompt.trim() !== "" ? [{ role: "system", content: request.systemPrompt }] : []),
            ...messages.map(toWireMessage),
          ],
```

- [ ] **Step 4: 跑它，看到綠**

Run: `pnpm --filter @i-harness/llm-openai-compatible test` → 全綠（含既有的空 tools／abort／SSE 案例）。

- [ ] **Step 5: 變異證明**

把 `...(request.systemPrompt.trim() !== "" ? [{ role: "system", content: request.systemPrompt }] : [])` 整段拿掉 ⇒ 第一條必須紅（第二條仍綠）。**還原並以 `sha256sum` 確認位元組相同。**

- [ ] **Step 6: Commit**

```bash
git add packages/llm-openai-compatible/src/index.ts packages/llm-openai-compatible/test/openai-compatible.test.ts
git commit -m "fix(llm): the openai-compatible request carries the system prompt as its first message (M72 I)"
```

---

### Task 2: 串流內的錯誤事件不再被吃掉（anthropic ＋ openai）

**Files:**
- Modify: `packages/llm-anthropic/src/index.ts`（`handleEvent`）
- Modify: `packages/llm-openai/src/index.ts`（`handleEvent`）
- Test: `packages/llm-anthropic/test/anthropic.test.ts`、`packages/llm-openai/test/openai.test.ts`

**Interfaces:**
- Consumes: seam 的 `{ type: "error"; error: Error }`
- Produces: 無新介面；**行為**：HTTP 200 的串流若載明失敗，整條流以**一個 `error` 事件**結束（而不是一個乾淨的 `end`）

**現況（量測）**：兩者的 `handleEvent` 都沒有對應分支——anthropic 的 `:234` 與 openai 的 `:197`／`:202` 都是 `return []`，之後照樣 `yield { type: "end" }`。**一次失敗的往返因此讀成一次乾淨的空成功。**

- [ ] **Step 1: 寫紅測試（兩個套件各一條）**

`packages/llm-anthropic/test/anthropic.test.ts`（照該檔既有的 `new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })` 形狀）：

```ts
  it("M72 Ⅰ: an in-stream error event is surfaced, not swallowed", async () => {
    const sse =
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
    const events = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(["error"])
    expect((events[0] as { error: Error }).error.message).toContain("Overloaded")
  })
```

`packages/llm-openai/test/openai.test.ts`（Responses：終止事件是 `response.failed`）：

```ts
  it("M72 Ⅰ: a failed Responses stream is surfaced, not swallowed", async () => {
    const sse =
      `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(["error"])
    expect((events[0] as { error: Error }).error.message).toContain("boom")
  })
```

（兩條的 client 工廠與 import 名以**各檔既有的**為準；照該檔第一條案例的寫法抄。）

- [ ] **Step 2: 跑它們，看到紅**

Run: `pnpm --filter @i-harness/llm-anthropic test` 與 `pnpm --filter @i-harness/llm-openai test`
Expected: 兩條都紅——`expected [ 'end' ] to deeply equal [ 'error' ]`（今天只發 `end`）。

- [ ] **Step 3: 實作**

`packages/llm-anthropic/src/index.ts` 的 `handleEvent`（在 `:234` 的 `return []` **之前**）加：

```ts
      // M72 Ⅰ: Anthropic reports mid-stream failures as an SSE `error` event on
      // an HTTP 200 stream. Without this arm the event fell into `return []`,
      // the loop finished, and the caller got a clean `end` for a failed
      // round-trip — the seam's own words: a failure must not read as success.
      if (t === "error") {
        const err = data.error as { type?: string; message?: string } | undefined
        return [{ type: "error", error: new Error(`${err?.type ?? "error"}: ${err?.message ?? "provider reported an error"}`) }]
      }
```

`packages/llm-openai/src/index.ts` 的 `handleEvent`（同樣在它的 `return []` **之前**）加：

```ts
      // M72 Ⅰ: the Responses API signals failure on the stream (`response.failed`)
      // and can also send a bare `error` event. Both used to fall through to the
      // empty default, so a failed response was indistinguishable from an empty
      // one. `response.incomplete` is deliberately NOT handled here — that is
      // truncation, i.e. phase Ⅱ's `truncated` bit.
      if (t === "response.failed" || t === "error") {
        const r = data.response as { error?: { message?: string; code?: string } } | undefined
        const e = data.error as { message?: string } | undefined
        const message = r?.error?.message ?? e?.message ?? "the provider reported a failed response"
        return [{ type: "error", error: new Error(message) }]
      }
```

**兩者都必須讓 `error` 終止**：`handleEvent` 回傳的事件被外層 `yield*` 出去之後，迴圈看到 `error` 就 `return`（照 bedrock 既有的寫法；若該檔的迴圈沒有這條，補上 `if (ev.type === "error") return` 的等價判斷）。

- [ ] **Step 4: 跑它們，看到綠**

Run 兩套 → 全綠（含既有的多事件案例）。

- [ ] **Step 5: 變異證明（兩條各一次）**

分別把兩個新分支拿掉 ⇒ 對應測試必須紅回 `[ 'end' ]`。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-anthropic/src/index.ts packages/llm-anthropic/test/anthropic.test.ts packages/llm-openai/src/index.ts packages/llm-openai/test/openai.test.ts
git commit -m "fix(llm): a 200 stream that reports failure ends as an error, not as a clean end (M72 I)"
```

---

### Task 3: bedrock 的請求層失敗變成 `error` 事件

**Files:**
- Modify: `packages/llm-bedrock/src/index.ts`（`client.send` 的呼叫點，`:156-159`；import）
- Test: `packages/llm-bedrock/test/bedrock.test.ts`

**Interfaces:**
- Consumes: `describeTransportError(label: string, url: string, error: unknown): Promise<Error>`（**已存在**，`packages/llm-seam/src/index.ts:337`，其餘四個轉接器都在用）
- Produces: 無新介面；**行為**：`client.send` 的拒絕 → **一個 `error` 事件**（附診斷字串），而非裸拋

**現況（量測）**：`packages/llm-bedrock/src/index.ts:156-159` 的 `await client.send(...)` **沒有任何 `try`/`catch`** ⇒ 認證、節流、網路、abort 全部裸拋，繞過 seam 的 `error` 事件通道（其餘四個都有）。

- [ ] **Step 1: 寫紅測試**

`packages/llm-bedrock/test/bedrock.test.ts`（用該檔**既有的** `fakeRuntime` helper 與 `createBedrockClient(config, fake)` 兩參數形狀——量於 `:12-22` 與 `:37`）：

```ts
  it("M72 Ⅰ: a request-level failure is an error event with a diagnosis, not a raw throw", async () => {
    const { fake } = fakeRuntime([])
    ;(fake.send as unknown as Mock).mockRejectedValueOnce(new Error("AccessDeniedException: nope"))
    const client = createBedrockClient({ model: "m" }, fake)
    const events: { type: string }[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(["error"])
    expect((events[0] as { error: Error }).error.message).toContain("AccessDeniedException")
  })
```

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/llm-bedrock test`
Expected: 紅——今天那個例外**從產生器拋出**（測試會以未捕捉的 rejection 失敗），而不是一個事件。

- [ ] **Step 3: 實作**

`packages/llm-bedrock/src/index.ts`：import 加 `describeTransportError`（該檔的 import 行加進 `@i-harness/llm-seam` 那條），並把 `:156-159` 改成：

```ts
      let output: ConverseStreamCommandOutput
      try {
        output = await client.send(
          new ConverseStreamCommand(body),
          request.signal !== undefined ? { abortSignal: request.signal } : {},
        )
      } catch (err) {
        // M72 Ⅰ: M61's cancel and every request-level failure (auth, throttling,
        // network) used to escape as a raw SDK throw, bypassing the seam's error
        // channel the other four adapters use. Abort is NOT a provider failure:
        // it keeps today's behaviour (a throw out of the generator).
        if (request.signal?.aborted === true) throw err
        yield { type: "error", error: await describeTransportError("bedrock", config.region ?? "", err) }
        return
      }
```

（`ConverseStreamCommandOutput` 的型別名以該檔既有的 import 為準；`config.region` 若不在 config 上，用該檔既有可得的標識字串，或傳空字串——**不要為此擴充 config**。）

- [ ] **Step 4: 跑它，看到綠**

Run 該套件 → 全綠（含既有的串流案例與 abort 案例）。

- [ ] **Step 5: 兩個變異證明**

(a) 把 `try`/`catch` 拿掉 ⇒ 新測試紅（裸拋）；(b) 把 `if (request.signal?.aborted === true) throw err` 拿掉並餵一個 aborted signal ⇒ **既有的 abort 行為**（如果該檔有案例）必須紅；沒有案例就在報告裡寫明「這條只由程式碼審查覆蓋」。還原並 `sha256sum` 驗證。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-bedrock/src/index.ts packages/llm-bedrock/test/bedrock.test.ts
git commit -m "fix(llm): bedrock's request-level failures reach the seam's error channel (M72 I)"
```

---

### Task 4: 四個 SSE 解析器的裸 `JSON.parse`（同一形狀，一次做完）

**Files:**
- Modify: `packages/llm-seam/src/index.ts`（新增 **一個** 具名的錯誤型別）
- Modify: `packages/llm-openai-compatible/src/index.ts`（`parseSSE`，`:58-68`；讀取迴圈）
- Modify: `packages/llm-openai/src/index.ts`（`parseSSE`，`:70-80`；讀取迴圈）
- Modify: `packages/llm-anthropic/src/index.ts`（`parseSSE`，`:109-117`；讀取迴圈）
- Modify: `packages/llm-gemini/src/index.ts`（`parseSSE`，`:59-67`；讀取迴圈）
- Test: 四個套件各自的 test 檔

**Interfaces:**
- Produces: `export class SSEParseError extends Error`（`@i-harness/llm-seam`），訊息含**壞掉的那一段原文的截斷**（前 80 字元）——四個轉接器共用它，這是它住在 seam 的理由（與 `describeTransportError` 同一個先例）
- Consumes: 無

**現況（量測）**：四個 `parseSSE` 的 `JSON.parse` **都無防護**（`:66`／`:78`／`:115`／`:65`）⇒ 壞 chunk **拋出**，而同一個轉接器的 HTTP 失敗**是事件**——同一個 provider 的可觀測失敗通道取決於壞在哪裡。

- [ ] **Step 1: 在 seam 加型別（無測試：它是資料）**

`packages/llm-seam/src/index.ts`，靠近 `describeTransportError`（`:337`）處：

```ts
/**
 * M72 Ⅰ: a stream body that was not valid SSE/JSON. Thrown by an adapter's
 * `parseSSE` so the READING LOOP can decide — a corrupt chunk is a provider
 * failure like any other and belongs on the seam's `error` channel, not out of
 * the generator as an exception while the same adapter reports HTTP failures as
 * events. The message carries a truncated copy of the offending text: without
 * it a 4000-chunk stream gives no way to tell WHAT was malformed.
 */
export class SSEParseError extends Error {
  constructor(text: string) {
    super(`malformed SSE chunk: ${text.slice(0, 80)}`)
    this.name = "SSEParseError"
  }
}
```

- [ ] **Step 2: 寫紅測試（四個套件各一條，同一形狀、各自的工廠）**

**四條的形狀相同，只有工廠與 config 不同**（四條都寫在這裡，因為實作者可能只讀自己那一條）：

`packages/llm-openai-compatible/test/openai-compatible.test.ts`

```ts
  it("M72 Ⅰ: a corrupt chunk is an error event, not an exception out of the generator", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("data: {not json\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: { type: string }[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(["error"])
    expect((events[0] as { error: Error }).error.message).toContain("not json")
  })
```

`packages/llm-openai/test/openai.test.ts` — 同，換 `createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })`。

`packages/llm-anthropic/test/anthropic.test.ts` — 同，換 `createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })`。

`packages/llm-gemini/test/gemini.test.ts` — 同，換 `createGeminiClient({ apiKey: "k", baseUrl: "https://api.example", model: "gemini-2.5-pro" })`（量於該檔 `:21`）。

> **為什麼只餵一個壞 chunk、不斷言有沒有先吐內容**：`new Response(string)` 的 body **可能整段當一個 chunk 交付**，所以「有效前綴先被 yield」**不是**我們能釘的事實——把它寫進期望值會做出一個**看 Node 心情**的測試。本條的判別力在於：**今天它拋出且沒有任何事件**，修好之後**恰好一個 `error`**。中段的損壞走同一個 `catch`；在測試的註解裡寫明「前綴是否已交付不在此斷言」，不要留給下一個人猜。

- [ ] **Step 3: 跑它們，看到紅**

Run 四個套件
Expected: 四條都紅——今天那個 `SyntaxError` **從 for-await 拋出**。

- [ ] **Step 4: 實作（四個檔同一個形狀）**

每個 `parseSSE` 的 `JSON.parse` 包起來（**以 openai-compatible 為例**，其餘三個只差在是否有 `[DONE]` 分支）：

```ts
      try {
        return JSON.parse(data) as Record<string, unknown>
      } catch (err) {
        throw new SSEParseError(data)
      }
```

（`llm-anthropic` 與 `llm-gemini` 沒有 `[DONE]` 分支，直接包那一行 `JSON.parse`。）每個檔的 import 加 `SSEParseError`。

每個**讀取迴圈**（`try { while (true) … } finally { reader.releaseLock() }`）補一個 `catch`：

```ts
      } catch (err) {
        // M72 Ⅰ: a corrupt chunk is a provider failure → the seam's error channel.
        // Abort is NOT: an aborted signal keeps today's behaviour (a throw).
        if (request.signal?.aborted === true) throw err
        yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
        return
      } finally {
        reader.releaseLock()
      }
```

- [ ] **Step 5: 跑它們，看到綠**

Run 四個套件 → 全綠（含既有的多 chunk／`[DONE]`／abort 案例）。

- [ ] **Step 6: 變異證明**

(a) 把 `parseSSE` 的 try/catch 拿掉 ⇒ 測試回到「SyntaxError 拋出」；(b) 把迴圈的 `catch` 拿掉 ⇒ 同上；(c) 把 `if (request.signal?.aborted === true) throw err` 拿掉 ⇒ 若該套件有 abort-mid-stream 案例必須紅，沒有就在報告寫明。還原並 `sha256sum` 驗證四個檔。

- [ ] **Step 7: Commit**

```bash
git add packages/llm-seam/src/index.ts packages/llm-openai-compatible/src/index.ts packages/llm-openai/src/index.ts packages/llm-anthropic/src/index.ts packages/llm-gemini/src/index.ts packages/llm-openai-compatible/test packages/llm-openai/test packages/llm-anthropic/test packages/llm-gemini/test
git commit -m "fix(llm): a corrupt stream chunk reaches the error channel instead of escaping the generator (M72 I)"
```

---

### Task 5: 階段收尾（閘門＋報告）

**Files:**
- Modify: 無（只跑閘門與寫報告）

- [ ] **Step 1: `pnpm verify:all`**

Run: `pnpm verify:all`
Expected: 五步全綠（母體 67；`--gate` 不得新增 row——**本階段唯一的匯出是 `SSEParseError`，它有四個生產消費者**，所以不該有新列；若閘門說有，那是真的，回報而不要加 allowlist）。
**若 suite 紅在已量測的負載 flake**：隔離跑該套件，**兩個讀數都記**。

- [ ] **Step 2: 報告**（寫給控制器，不進 git）

四個任務各自的：紅先證據、GREEN、**每一條變異證明與其 sha 驗證**、被改動的既有斷言（引用前後並說明為何是**刻意**而非放鬆）、以及**沒有做的事**（空字串 system 在 openai／anthropic 仍是「照送」——那是既有的跨轉接器不一致，**本階段只記錄不動**）。

---

## 驗收（照 spec §2 第 1 條）

1. openai-compatible 送出的 body 裡**有 system 訊息**，且內容等於 `systemPrompt`；空字串時**沒有**。
2. anthropic 收到 `type:"error"` 的串流 ⇒ **一個 `error` 事件**（不是空成功）。
3. 四個 SSE 轉接器收到**壞掉的 chunk** ⇒ `error` 事件（不是拋出）。
4. bedrock 的請求層失敗 ⇒ `error` 事件 ＋ 診斷字串。
5. `pnpm verify:all` 五步全綠、`--gate` 無新增 row。

**每一條都要有對應的變異證明**（把修法拿掉 ⇒ 該條紅）。
