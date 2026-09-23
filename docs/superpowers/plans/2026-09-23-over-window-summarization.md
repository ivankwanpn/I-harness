# M75 — 超窗的摘要化要有路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 當摘要器那條單一請求**放不下**窗口時（今天是：provider 拒絕 ⇒ fail-soft ⇒ 階梯 reset ⇒ **context 被丟掉、沒有摘要**），把區域**切成幾塊、串連地摘要**，讓摘要真的發生。

**Architecture:** **只在放不下時才切**（判準是夾取已經算出來的那個數）。每一塊送**它自己的訊息**（Shape B——前綴形狀在算術上不可能修好這個 regime），第 k 塊把**running summary** 當 `previousSummary` 收下（串連），pass 結束時附加**一個** `compaction/summary`、`shadowedSeqs` 是**整個區域**。中途**不落任何標記**。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-23-over-window-summarization-design.md`（權威；§1 設計、§2 驗收）

## Global Constraints

- **紅先測試 ＋ 變異證明**：每一條修法都要先看到紅；實作後**把修法拿掉一次**、確認**具名的那條**測試變紅、再用 Edit 工具還原（**絕不**用 `git checkout --`），並以 `sha256sum` 確認位元組還原。
  - **突變是預測**：本計畫寫「拿掉哪一條規則 ⇒ 哪一條測試必須紅」。**哪一行字面編輯能達到那個效果，由你量測決定並記錄**——M72／M73／M74 三個階段裡，計畫的字面突變預測錯了**十幾次**。找不到能讓它紅的突變 ⇒ **那是發現，回報它**，不要換一條測試來遷就。
- **既有測試只在「它刻意斷言的正是這次要改的契約」時才改**，而且要**具名說明**、不得放鬆。**本計畫預期零條**——若你跑出來紅了任何一條，**回報它**（錯的清單比沒有清單更糟）。
- **普通情況逐位元組不變**：surface 放得下時，摘要請求必須與今天**完全相同**（一個呼叫、同一個 prefix 形狀）。這是本階段最重要的不變式，**要有一條測試釘住**。
- **缺席即缺席**：沒有窗口／沒有 cap 時不注入任何預設。
- **提交訊息不加任何 attribution trailer**；**不 amend**；blobs LF；檔案用 Write/Edit 工具寫。
- **每個任務只跑自己套件的測試與 typecheck**；`pnpm verify:all` **整支分支只跑一次**（收尾任務）。
- **不要動 `docs/`**（紀錄由控制器寫）。**不要動 seam 的事件聯集與 `LLMUsage` 的欄位**。**不新增 export**（收尾閘門會看）。
- **一條規則只落一處**：切點的「區塊對齊」規則已經有兩份（`region.ts:34-46`、`index.ts:337-342`）——**重用其中一份，不要寫第三份**。

---

### Task 1: 切塊器（純函式，先讓它自己站得住）

**Files:**
- Create: `packages/compaction/src/slices.ts`
- Test: `packages/compaction/test/slices.test.ts`

**Interfaces:**
- Consumes: `deriveMessagesUpTo(session, maxSeq)`（`@i-harness/core-session`）、`estimateContent(messages)`（`@i-harness/token-meter`，compaction 已依賴）、`Session`
- Produces: `sliceRegion(session: Session, shadowedSeqs: number[], budgetTokens: number): LLMMessage[][]`——每一塊是**它自己的訊息**（Shape B），切點**區塊對齊**，**合起來就是整個區域**（不漏、不重）

**實況（量測）**：`deriveMessagesUpTo` 是 prefix fold，所以「第 k 塊自己的訊息」＝ `deriveMessagesUpTo(cut_k).slice(deriveMessagesUpTo(cut_{k-1}).length)`——**用既有的 fold 兩次、取尾段**，不要自己重寫投影。定價用 `estimateContent`（per-message），**不要**用 `deriveSearchText`（它對 `step/start`／`turn/end` 回空字串、還剝掉工具結果的圖 ⇒ 剛好低估摘要器要付的那些訊息）。

- [ ] **Step 1: 寫紅測試**

```ts
import { describe, expect, it } from "vitest"
import { append, createSession, deriveMessagesUpTo, type Session } from "@i-harness/core-session"
import { estimateContent } from "@i-harness/token-meter"
import { sliceRegion } from "../src/slices.ts"

/** A session of `turns` turns, each with one user message and one read call. */
function toolSession(turns: number): Session {
  const s = createSession()
  for (let t = 0; t < turns; t++) {
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: `question ${t} ` + "filler ".repeat(120) })
    append(s, { type: "tool/call", callId: `call_${t}`, name: "read", args: { path: `f${t}.txt` } })
    append(s, { type: "tool/result", callId: `call_${t}`, name: "read", output: { content: "body ".repeat(200) } })
    append(s, { type: "assistant/message", text: `answer ${t} ` + "filler ".repeat(120) })
    append(s, { type: "turn/end" })
  }
  return s
}

const allSeqs = (s: Session): number[] => s.events.map((e) => e.seq!).filter((n) => n !== undefined)

describe("sliceRegion", () => {
  it("M75: a budget that fits everything returns ONE slice, equal to the whole fold", () => {
    const s = toolSession(3)
    const slices = sliceRegion(s, allSeqs(s), 1_000_000)
    expect(slices).toHaveLength(1)
    expect(slices[0]).toEqual(deriveMessagesUpTo(s, s.events.at(-1)!.seq!))
  })

  it("M75: a small budget splits, and the slices together are exactly the region", () => {
    const s = toolSession(6)
    const whole = deriveMessagesUpTo(s, s.events.at(-1)!.seq!)
    const slices = sliceRegion(s, allSeqs(s), 400)
    expect(slices.length).toBeGreaterThan(1)
    // nothing dropped, nothing duplicated, order preserved
    expect(slices.flat()).toEqual(whole)
  })

  it("M75: every slice is cut at a block boundary — no slice starts with an orphan tool result", () => {
    const s = toolSession(6)
    for (const slice of sliceRegion(s, allSeqs(s), 400)) {
      const first = slice[0]
      // a `tool` message whose call is not in the same slice would be an orphan
      const calls = new Set(slice.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : [])))
      const orphans = slice.filter((m) => m.role === "tool" && !calls.has(m.toolCallId ?? ""))
      expect(orphans).toEqual([])
      expect(first).toBeDefined()
    }
  })

  it("M75: the budget is a real bound — every slice fits it (unless a single block cannot)", () => {
    const s = toolSession(6)
    const budget = 400
    for (const slice of sliceRegion(s, allSeqs(s), budget)) {
      // a slice may exceed the budget only when it is a single block (one turn)
      const oneTurn = slice.filter((m) => m.role === "user").length <= 1
      if (!oneTurn) expect(estimateContent(slice)).toBeLessThanOrEqual(budget)
    }
  })
})
```

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/compaction test`
Expected: 紅在 `sliceRegion` 不存在（模組匯入失敗）。

- [ ] **Step 3: 實作**

`packages/compaction/src/slices.ts`：

```ts
import { deriveMessagesUpTo, type Session } from "@i-harness/core-session"
import type { LLMMessage } from "@i-harness/llm-seam"
import { estimateContent } from "@i-harness/token-meter"

/** Split a region into token-bounded slices of the region's OWN messages.
 *
 * M75: when the single prefix-shaped summarizer request cannot fit the window,
 * the pass summarises the region in pieces instead. Each piece sends only its
 * own messages (a prefix-per-piece shape would re-send everything and is
 * arithmetically incapable of getting under the window).
 *
 * Cuts fall on BLOCK boundaries: a `tool/result` whose `tool/call` lives in the
 * previous piece projects as a `tool` message with no call, which providers
 * reject (the same hazard `selectShadowableRange`'s walk-off exists for). The
 * piece boundaries come from the SHARED fold — `deriveMessagesUpTo` twice, tail
 * taken — so a piece can never show a different projection than the main path.
 *
 * A piece whose SINGLE block exceeds the budget is emitted alone and over
 * budget: there is nothing to split further, and the caller's fail-soft path
 * already covers the case where even that does not fit.
 */
export function sliceRegion(session: Session, shadowedSeqs: number[], budgetTokens: number): LLMMessage[][] {
  // …walk the region's BLOCKS (a tool block = call..result, otherwise one turn),
  // price each block as the fold's tail beyond the previous cut, and close a
  // slice before any block that would push it over the budget.
}
```

**實作要點（不是佔位——這些是必須落地的性質，測試會驗）**：
- 走的是**區塊**不是訊息：一個 tool 區塊是 `tool/call` → 它的 `tool/result`（含中間的事件）；其餘以 `turn/start` 為單位。
- 每一塊的價格 ＝ `estimateContent(deriveMessagesUpTo(session, blockEnd).slice(prefixLenBeforeBlock))`。
- 累加時：若「加入這一塊」會超過 `budgetTokens` **且**目前這一塊不是空的 ⇒ 先收掉再開新的。
- 最後把剩下的收掉；**空區域回 `[]`**。

- [ ] **Step 4: 跑它，看到綠**

Run: `pnpm --filter @i-harness/compaction test` ＋ 該套件 typecheck。

- [ ] **Step 5: 變異證明（兩條）**

(a) 把「區塊對齊」拿掉（改成逐訊息切）⇒ 第 3 條必須紅；(b) 把「合起來剛好是整個區域」的性質破壞（例如把每一塊都從頭 fold ⇒ 重複）⇒ 第 2 條必須紅。記錄實際編輯與 `sha256sum`。

- [ ] **Step 6: Commit**

```bash
git add packages/compaction/src/slices.ts packages/compaction/test/slices.test.ts
git commit -m "feat(compaction): a region can be sliced into token-bounded, block-aligned pieces (M75)"
```

---

### Task 2: fallback 的閘 ＋ 串連（引擎的改動）

**Files:**
- Modify: `packages/compaction/src/summarizer.ts`（`summarizeWithModel` 的 9 個參數之外，新增一個「多塊」的入口或讓呼叫者驅動——見 Step 3）
- Modify: `packages/compaction/src/index.ts`（`compactOnce` 的 `:167-207`：判準、切片、串連、收尾）
- Test: `packages/compaction/test/summarizer-prefix.test.ts`（既有檔，加案例）

**Interfaces:**
- Consumes: Task 1 的 `sliceRegion`
- Produces: 行為——放不下時**切塊並串連**；放得下時**逐位元組不變**

**實況（量測）**：判準是免費的——夾取已經算出 `estimateContent(messages) + overheadTokens`（`summarizer.ts:230`），而「放不下」就是 `clampOutputCap` 的 arm C（`llm-seam:462-463`）。因此判準必須與夾取**用同一個算式**，不要另寫一套。

- [ ] **Step 1: 寫紅測試（兩條，一條是「不變」）**

```ts
  it("M75: a region that does NOT fit the window still gets a SUMMARY (not a reset)", async () => {
    const { model, requests } = capturingModel()
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 400, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE,
      maxOutputTokens: 50_000,
    })
    const s = toolSession() // 既有 fixture：12 個 read 呼叫
    const result = await engine.compact(s)

    expect(result.compacted).toBe(true)
    // a summary EXISTS — today this is the case that fails soft and resets
    expect(result.summary).toBeDefined()
    expect(s.events.some((e) => e.type === "compaction/summary")).toBe(true)
    // …and it took MORE than one call (the pieces)
    expect(requests.length).toBeGreaterThan(1)
  })

  it("M75: a region that DOES fit keeps today's single, byte-identical prefix call", async () => {
    const { model, requests } = capturingModel()
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 1_000_000, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE,
    })
    const s = toolSession()
    await engine.compact(s)
    expect(requests).toHaveLength(1)
    // the prefix property: the request's messages are exactly the derived fold
    expect(requests[0]!.messages).toEqual(deriveMessages(s))
  })
```

（`capturingModel`、`SHAPE`、`toolSession` 都在該檔既有——沿用，不要新寫。）

**第二條是本階段最重要的不變式**：`deriveMessages(s)` 是主路徑的 fold（`summarizer-prefix.test.ts:61-86` 已有的斷言形狀）。

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/compaction test`
Expected: 第 1 條紅（今天 `compacted` 是 `false`／沒有 summary——量出來是哪一個，並記錄）；第 2 條**綠先**（今天就是那個形狀）——它的殺手是 Step 5 的變異。

- [ ] **Step 3: 實作**

`compactOnce` 內、`summarizeWithModel` 呼叫之前：

```ts
      // M75: the single prefix-shaped request is the fast path — it is a byte
      // prefix of the session's last main request and the provider cache serves
      // it. It stops being possible exactly when the region itself fills the
      // window (clampOutputCap's arm C returns the raw cap; a strict provider
      // rejects `input + max_tokens > context`). THEN — and only then — the pass
      // summarises the region in pieces: pieces 2..N are cold reads (this tree
      // sends no cache breakpoints), which is strictly better than today's
      // outcome there: no summary at all and the context thrown away by a reset.
      const inputPrice = (messages: LLMMessage[]): number =>
        estimateContent(messages) + (config.overheadTokens ?? 0)
      const budget = contextWindow  // the pieces must fit the WINDOW, not the gate
```

判準與驅動：

- 若 `inputPrice(prefix?.messages ?? [directive]) < contextWindow`（**放得下**）⇒ **今天那條路**，一行都不改。
- 否則 ⇒ `sliceRegion(session, shadowedSeqs, sliceBudget)`，其中 `sliceBudget` 必須讓每一塊**加上輸出與邊際**仍然合法（**量一個安全值**：它是 `contextWindow` 減掉輸出與邊際；計畫不替你猜數字，**你量並記錄你用的公式**）。
- 逐塊呼叫 `summarizeWithModel`，`previousSummary` 從第一塊的 `lastSummaryText(session)` 起、之後傳**running text**（串連）。
- **running text 不落任何標記**；全部成功之後才照今天的方式附加**一個** `compaction/summary`，`shadowedSeqs` 是**整個區域**。
- **整段切塊與串連的簿記在 fail-soft 的 `try` 裡面**（或全函式不拋）。

`summarizeWithModel` 需要能收「這一塊的訊息」：**最小改法**是加一個可選參數（例如 `messagesOverride?: LLMMessage[]`），讓 prefix 只在沒有 override 時使用——**不要**在 `summarizer.ts` 裡再寫一份訊息組裝。

**另外兩件 spec 要求、必須落在這一任務的事**：

1. **品質門檻只在最後一塊強制**（spec §1.5）：`minSummaryChars` 今天**每次呼叫**都檢查（`summarizer.ts:242`）。切塊之後 **per-slice 檢查是錯的**（一塊合法的 merge 可能很短）。改成：**中間塊不檢查**、**最後一塊照舊檢查**；並在那一行旁邊寫明理由與它的盲區（一個「中途很混但最後剛好夠長」的鏈不會被抓到——與今天「一次呼叫剛好夠長」是同一個盲區的形狀）。
2. **`attempts` 的語意**（spec §1.6）：pass 現在是 N 次呼叫（含每塊的重試）⇒ `compaction/attempt` 的 `attempts` 不再與歷史數字可比。在**發出那個事件的那一行旁邊**寫一句，否則那個數字會靜默地改變意義。

- [ ] **Step 4: 跑它，看到綠**

Run: 該套件 test ＋ typecheck。**所有既有案例都要綠**（這是「零條既有斷言要改」的驗證點；若有紅，回報）。

- [ ] **Step 5: 變異證明（兩條）**

(a) 把判準拿掉（**無條件**切塊）⇒ 第 2 條必須紅（普通情況變成多個呼叫、請求不再是 prefix）；(b) 把串連拿掉（每一塊都用同一份 `lastSummaryText`）⇒ **Step 4 的串連斷言**（Task 3 會加）必須紅——若這一輪還沒有那條斷言，記下你量到什麼。記錄實際編輯與 `sha256sum`。

- [ ] **Step 6: Commit**

```bash
git add packages/compaction/src/index.ts packages/compaction/src/summarizer.ts packages/compaction/test/summarizer-prefix.test.ts
git commit -m "feat(compaction): an over-window region is summarised in chained pieces (M75)"
```

---

### Task 3: 完整性與原子性（把性質釘住）

**Files:**
- Test: `packages/compaction/test/summarizer-prefix.test.ts`（或同套件的新檔）
- Modify: 只在**發現需要改程式**時——那是發現，回報它

**Interfaces:**
- Consumes: Task 2 的行為
- Produces: 四條被釘住的性質

- [ ] **Step 1: 寫測試（四條，逐字）**

```ts
// 一個每次回「不同的」摘要的 client：running 的鏈必須可辨識。
// （既有的 capturingModel 每次都回同一個常數 ⇒ 分不出「串連」與「每塊都用同一份」。）
function sequencedModel(texts: string[]): { model: ModelClient; requests: LLMRequest[]; markerCounts: number[] } {
  const requests: LLMRequest[] = []
  const markerCounts: number[] = []
  let call = 0
  return {
    requests,
    markerCounts,
    model: {
      async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
        requests.push(request)
        yield { type: "text/chunk", text: texts[Math.min(call++, texts.length - 1)]! }
        yield { type: "end" }
      },
    },
  }
}

const summariesOf = (m: LLMRequest): string =>
  m.messages.map((x) => (typeof x.content === "string" ? x.content : "")).join("\n")

describe("M75: an over-window region is summarised in chained pieces", () => {
  it("M75: the chained pieces each receive the RUNNING summary", async () => {
    const { model, requests } = sequencedModel(["PIECE-ONE", "PIECE-TWO", "PIECE-THREE"])
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 400, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE,
      maxOutputTokens: 50_000,
    })
    const s = toolSession()
    await engine.compact(s)

    expect(requests.length).toBeGreaterThan(1)
    // piece 1 has no anchor; piece k>1 carries what piece k-1 produced
    expect(summariesOf(requests[0]!)).not.toContain("<previous-summary>")
    for (let k = 1; k < requests.length; k++) {
      expect(summariesOf(requests[k]!)).toContain("<previous-summary>")
      expect(summariesOf(requests[k]!)).toContain(k === 1 ? "PIECE-ONE" : "PIECE-TWO")
    }
  }, 30_000)

  it("M75: the pass appends exactly ONE summary marker, shadowing the WHOLE region", async () => {
    const { model } = sequencedModel(["PIECE-ONE", "PIECE-TWO", "PIECE-THREE"])
    const s = toolSession()
    await createCompactionEngine({
      model, config: { contextWindow: 400, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE, maxOutputTokens: 50_000,
    }).compact(s)

    const markers = s.events.filter((e) => e.type === "compaction/summary")
    expect(markers).toHaveLength(1)
    // the WHOLE region, exactly what the single-call path would have named
    expect((markers[0] as { shadowedSeqs: number[] }).shadowedSeqs).toEqual(selectShadowableRange(s, 0))
  }, 30_000)

  it("M75: no marker appears mid-pass", async () => {
    const s = toolSession()
    const counts: number[] = []
    const base = sequencedModel(["PIECE-ONE", "PIECE-TWO", "PIECE-THREE"])
    const model: ModelClient = {
      async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
        // every call observes the log BEFORE the pass has appended anything
        counts.push(s.events.filter((e) => e.type.startsWith("compaction/")).length)
        yield* base.model.stream(request)
      },
    }
    await createCompactionEngine({
      model, config: { contextWindow: 400, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE, maxOutputTokens: 50_000,
    }).compact(s)

    expect(counts.length).toBeGreaterThan(1)
    expect(counts.every((n) => n === 0)).toBe(true)
  }, 30_000)

  it("M75: a failure in a middle piece is still atomic — nothing appended, reason says so", async () => {
    const s = toolSession()
    let call = 0
    const model: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        call += 1
        if (call === 2) yield { type: "error", error: new Error("piece two exploded") }
        else { yield { type: "text/chunk", text: "PIECE-" + call }; yield { type: "end" } }
      },
    }
    const result = await createCompactionEngine({
      model, config: { contextWindow: 400, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE, maxOutputTokens: 50_000,
    }).compact(s)

    expect(result.compacted).toBe(false)
    expect(result.reason).toBe("summarizer-failed")
    expect(s.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
  }, 30_000)
})
```

（`selectShadowableRange` 由 `../src/index.ts` 匯出，`toolSession`／`SHAPE`／`Session`／`ModelClient`／`LLMRequest`／`LLMStreamEvent` 都已在那個測試檔的 import 範圍內。**若某一條做不到**——例如 client 拿不到 session——回報它並說明你量到的限制，**不要**改成空洞的斷言。）

- [ ] **Step 2: 跑它，看到綠（或看到你回報的限制）**

- [ ] **Step 3: 變異證明（兩條）**

(a) 讓「中途落標記」發生（在迴圈裡 `append` 一個 summary）⇒ 第 3 條必須紅；(b) 拿掉原子性（把已完成的塊落成標記）⇒ 第 4 條必須紅。記錄實際編輯與 `sha256sum`。

- [ ] **Step 4: Commit**

```bash
git add packages/compaction/test/
git commit -m "test(compaction): one marker, the running chain, and a mid-piece failure that still appends nothing (M75)"
```

---

### Task 4: 收尾（閘門＋報告）

**Files:** 無（只跑閘門與寫報告）

- [ ] **Step 1: `pnpm verify:all`**

Run: `pnpm verify:all`
Expected: 五步全綠（母體 67）。**`--gate` 不得新增 row**（本輪不新增 export——`sliceRegion` 是**套件內部**的匯出，若它會產生一列，**回報而不要加 allowlist**）。
- **若 suite 紅在已量測的負載 flake**（`apps/cli` 的 M12 retry、`session-executor` 的 `shell-promotion W10`、`apps/cli` 的 headless W10）：隔離跑、**兩個讀數都記**。**跑閘門時不要同時跑 subagent。**

- [ ] **Step 2: 報告**（寫給控制器，不進 git）

每個任務各自的：紅先證據、GREEN、**每一條變異證明與其 sha 驗證**（含你實際用的那一行編輯）、被改動的既有斷言（**預期零條**）、你量到的預算公式與數字、以及**沒有做的事**（見 §殘餘）。

---

## 驗收（照 spec §2）

1. **超窗的 session 真的被摘要**（不是 reset）——Task 2 第 1 條。
2. **普通情況逐位元組不變**（一次呼叫、prefix 形狀）——Task 2 第 2 條。
3. **串連**（第 2..N 塊帶 running summary）——Task 3 第 1 條。
4. **一個標記**（`shadowedSeqs` 是整個區域）＋ **中途沒有標記**——Task 3 第 2、3 條。
5. **切點合法**（沒有孤兒 `tool/result`）——Task 1 第 3 條。
6. **失敗仍然原子**——Task 3 第 4 條。
7. `pnpm verify:all` 五步全綠、`--gate` 無新增 row——Task 4。

**每一條都要有對應的變異證明**（把修法拿掉 ⇒ 該條紅）。

## 殘餘（本階段**不做**，寫出來不是忘了）

- **種子端的約束**（在 spawn 時就別把超過子代理窗口的東西交給它）：`spawnChild` 是唯一同時握有（種子，窗口）的地方，而那對值裡**窗口在種子被建出來時還不在 scope**（宣告角色的 binding 在 `await opts.resolveModel` 之後才有）⇒ 修法要先**重排 `resolveModel` 到種子之前**，而那順帶關掉一個**真的洩漏**：`coordinator.create` 在模型能失敗之前就建了 durable child session ⇒ 一次非 ready 會留下**孤兒 `child-<uuid>` log**。
- **prune 在摘要之前**：prefix 路徑上剛規劃好的 prune 替代品**不會縮小**摘要器的輸入（標記在摘要之後才附加，而 fold 是從 log 折的）⇒ 摘要器重讀未 prune 的工具輸出。獨立的成本缺陷。
- **單一區塊就超窗**：切塊器救不了它（沒有東西可以再切），仍走 fail-soft ⇒ reset。真正的解法是那一塊的來源（工具結果的上限）。
- **`rewind/point` 的 `anchorSeq`**（M74 的殘餘）。
- **`attempts` 的語意改變**（現在包含每塊的重試）——要寫在 telemetry 事件旁邊。
- **breaker 分不出「模型不穩」與「最後一塊還是太大」**。
