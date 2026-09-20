# M5／T4 block ③ — 界 Implementation Plan

> **⚠ 這份計畫**尚未執行**（2026-09-21 使用者裁定：先寫計畫、先推、之後在工作電腦接手）。**
> **執行前先讀 §0 的「接手前該知道的四件事」。**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一個工具的回傳值**不會無界地進到日誌與模型**，而界**是**那個一直在樹裡、有測試、而**從來沒有被掛上**的護欄。

**Architecture:** `packages/output-retention` 的 `createOutputSpillGuard` 已經是 dsh spill policy 的移植，**而生產裡零個掛載**（`assembly.ts:740` 的 `if (opts.outputSpill)`，而**沒有任何呼叫者設它**）。這一塊：**先補兩個 dsh 有而 IH 沒有的行為**，**再在 CLI 把它掛上並釘住**。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-20-m5-t4-tool-pipeline-design.md`（**§4 是這一塊的全部依據**）。前置：block ①（軟失敗信封）與 block ②（參數 schema 層）—— **都已交付、已推。**

---

## 0. 接手前該知道的四件事

### 0.1 一個**先決**，而它不是這一塊的設計，是 block ② 的終審指名的

**`execute-tool-calls.ts` 的三個填補信封不對稱：**

| 行 | 填什麼 | `output` |
|---|---|---|
| `:197` | 參數違反（軟） | `{ error, code: TOOL_FAILED }` |
| `:458` | 本體失敗（軟） | `{ error, code: TOOL_FAILED }` |
| **`:381`** | **中止路徑的「已開始但沒輸出」** | **`{ error }` —— 沒有 `code`** |
| `:405` | 中止路徑的「從未開始」 | `{ error, code: TOOL_ABORTED_BEFORE_DISPATCH }` |

**而 block ③ 需要一個「這一筆是合成的失敗」的判準**（spec §4.3 說**合成的失敗不應該被界** —— 截斷一個錯誤會讓模型看不到它為什麼失敗）。

**⇒ 終審的原話：**

> **If block ③ keys on `code === TOOL_FAILED` it silently bounds abort fills; if it keys on "an object with an `error` string" it bounds real tool outputs shaped like that.**
>
> **My recommendation: before block ③, add the one missing bit of the vocabulary the block already established — make both fills carry their code** … and have the spill predicate **read the code, not the shape**.

**⇒ 這一塊的 Task 1 就是它。** 它是**兩行的改動 ＋ 一個常數**，而**不做它的代價是那個界會用一個猜**。

### 0.2 §4.3 是一個**有代價的取捨**，而它要在改動裡看得見

**dsh 的版本改的是 `content`（模型面的呈現）；IH 的版本改的是 `output`** —— **也就是寫進 `tool/result` 的東西。**

**⇒ 所以打開它改的是**durable 的記錄**，不只是顯示。** 那與「日誌是唯一真相」有張力，而 **spec §4.3 把它寫成一個**決定**，不是一個實作細節** —— **所以它要在程式註解裡、而不是只在 spec 裡。**

**⇒ 這一句是這一塊的整個哲學**：

> **代價是：日誌裡不再是工具真的回傳的東西。** 它換到的是**界可以持久化**（重播時界還在）。

### 0.3 那個 `if (opts.outputSpill)` 的語意要處理

`assembly.ts:740` 是 `if (opts.outputSpill) ctx.mount(createOutputSpillGuard(ctx, opts.outputSpill))` —— **「缺席即不掛」**。

**⇒ 所以「在 CLI 預設打開」意味著那個呼叫者要主動傳一個物件。**

**裁定（這一塊的 Task 4 照這個做）：** **不改組裝的語意，改 CLI 的呼叫點。** 理由：那個「缺席即不掛」是**別的宿主的**契約（SDK／ACP 掛不掛是它們的事，spec §7 把那一格留給另一個單元），**而在 CLI 這一端把預設打開是 CLI 的決定。** 一個空物件 `{}` 在 `run.ts` 的呼叫點上是**明說的**，而在 `assembly.ts` 裡把它變成無條件則是**替所有宿主決定**。

### 0.4 全套閘門是**五步**，而它現在是一個指令

```bash
pnpm verify:all     # block ② 加的；母體不足會 exit 1
```

**⇒ 不要只跑 `pnpm -r --no-bail test`** —— 它**在有紅的時候只跑一個前綴**，而它**不含 `e2e/`**。**兩件事都量到過**（見 `docs/handoff/2026-09-20-m5-t4-block2-argument-schema.md` §4.3）。

## Global Constraints

- **改的是 `output`，而它要在程式註解裡說出來**（§0.2）。**不要在實作把它當成顯示細節。**
- **合成的失敗不被界** —— 而那靠**一個 `code` 判準**，不靠形狀（§0.1）。
- **Skip `read`** —— dsh 的理由逐字適用：不跳會產生 `read → spill → read` 的迴圈，**模型為了看被截斷的檔案再去讀一次，然後再被截斷一次**。
- **替代品不得大於上限** —— dsh 的原文是 "the policy **NEVER** emits a replacement larger than the cap"；**一個為了設界而存在、結果自己越界的替代品**，正是這一塊要消滅的形狀。
- ⚠ **不要在註解裡寫一個「沒有生產消費者」的 export 名字** —— 掃描器不剝註解，那會讓那一列消失（量到 3 → 2）。
- ⚠ **行號會腐化。** 每一處引用動手前先 `grep -n`。
- **不新增 export，除了 Task 1 的那一個常數。** `--gate` 在中途會是 `N NEW rows`，**那是預期的**（block ① 與 ② 的教訓）。

---

## File Structure

| 檔案 | 角色 | 哪個任務 |
|---|---|---|
| `packages/core-agent/src/execute-tool-calls.ts` | 三個填補 / 兩個軟路徑 | **T1**（讓 abort 的填補帶 `code`） |
| `packages/core-agent/src/index.ts` | re-export | **T1** |
| `packages/output-retention/src/spill-guard.ts` | **護欄本體** | **T2**（跳過 `read`）· **T3**（替代品不得越界）· **T4**（一個 `code` 判準） |
| `apps/cli/src/run.ts` | CLI 的呼叫點 | **T4**（把預設打開說出來） |

**⇒ 這一塊**不動** `assembly.ts`**（§0.3 的裁定）：它的「缺席即不掛」是別的宿主的契約。

---

### Task 1（**先決**）: 讓 abort 的填補帶 `code` —— 界才有一個可讀的判準

**Files:**
- Modify: `packages/core-agent/src/execute-tool-calls.ts:381`（那一格）＋ 常數區
- Modify: `packages/core-agent/src/index.ts`（re-export）
- Test: `packages/core-agent/test/execute-tool-calls.test.ts`

**Interfaces:**
- Produces: `export const TOOL_ABORTED_MID_FLIGHT = "TOOL_ABORTED_MID_FLIGHT"` —— **Task 4 的判準讀它**（以及既有的 `TOOL_FAILED`、`TOOL_ABORTED_BEFORE_DISPATCH`）。

**為什麼一條新的常數而不是重用 `TOOL_ABORTED_BEFORE_DISPATCH`**：那一格是**已開始而沒有輸出**的（body 跑了、被中止了），而 `TOOL_ABORTED_BEFORE_DISPATCH` 是**從未開始**的。**兩件不同的事不可以共用一句話** —— 那是 block ① 的 §2.3 已經立過的規則，**而這裡是它的第二個實例**。

- [ ] **Step 1: 寫紅測試（先量機制）**

在 `describe("executeToolCalls scheduler")` 裡加：

```ts
  it("the abort fill carries its OWN code — a mid-flight kill is not the same fact as a never-started one", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const ac = new AbortController()
    tools.register({
      name: "killme", description: "", inputSchema: {}, isConcurrencySafe: true,
      // Settles only after the abort fires, so this slot gets the ABORT FILL
      // (started, no output) rather than a real result or a cancellation.
      execute: async () => { await new Promise((r) => setTimeout(r, 40)); ac.abort(); throw new Error("killed") },
    })
    await expect(
      executeToolCalls(ctx, session, tools, [{ callId: "c0", name: "killme", args: {} }], { maxParallel: 1, signal: ac.signal }),
    ).rejects.toThrow("agent aborted")
    const results = session.events.filter((e) => e.type === "tool/result") as { output: { code?: string } }[]
    expect(results).toHaveLength(1)
    expect(results[0]!.output.code).toBe(TOOL_ABORTED_MID_FLIGHT)
  })
```

- [ ] **Step 2: 跑它，確認它紅**

Run: `pnpm --filter @i-harness/core-agent exec vitest run test/execute-tool-calls.test.ts -t "its OWN code"`

Expected: **紅** —— `TOOL_ABORTED_MID_FLIGHT` 還不存在（**那條的紅就是「東西還不存在」**）。

- [ ] **Step 3: 實作（兩行 ＋ 一個常數）**

常數區（`TOOL_FAILED` 旁邊）：

```ts
// A STARTED call whose body never produced an output because the step was
// aborted mid-flight. Deliberately NOT TOOL_ABORTED_BEFORE_DISPATCH: that one
// is a call that never started. Two different facts, two different codes —
// the same rule block ①'s §2.3 established for the message strings.
export const TOOL_ABORTED_MID_FLIGHT = "TOOL_ABORTED_MID_FLIGHT"
```

`:381` 的 `output: { error: message }` → `output: { error: message, code: TOOL_ABORTED_MID_FLIGHT }`。

`core-agent/src/index.ts` 的 re-export 區塊加上它。

- [ ] **Step 4: 跑測試（綠）**

Run: `pnpm --filter @i-harness/core-agent exec vitest run`

Expected: **全綠**。**若 `M51 B3` 那條紅，停手回報** —— 它斷言的是 `toMatchObject({ error: "aborted by signal" })`，而加 `code` **不該**動它。

- [ ] **Step 5: 突變**

把新常數的值改成 `TOOL_ABORTED_BEFORE_DISPATCH` ⇒ **Step 1 那條必須紅**（**它證明那兩個事實被分開釘住**）。**還原。**

- [ ] **Step 6: Commit**

```bash
git add packages/core-agent/src/execute-tool-calls.ts packages/core-agent/src/index.ts packages/core-agent/test/execute-tool-calls.test.ts
git commit -m "feat(core-agent): M5 T4 block 3 prerequisite — a mid-flight abort fill says so, so a bound can read the code rather than guess the shape"
```

---

### Task 2: 跳過 `read`

**Files:**
- Modify: `packages/output-retention/src/spill-guard.ts`
- Test: `packages/output-retention/test/spill-guard.test.ts`

**Interfaces:**
- Consumes: `dispatch as { name: string }`（`:33` 既有）。
- Produces: 無新 export。

**dsh 的理由逐字適用**（spec §4.2）：

> 不跳會產生 `read → spill → read` 的迴圈 —— **模型為了看被截斷的檔案再去讀一次，然後再被截斷一次**。

**⇒ 而 `read` 的工具名是 `"read"`**（`packages/fs/src/index.ts:240`，量過）。

- [ ] **Step 1: 寫紅測試**

在 `packages/output-retention/test/spill-guard.test.ts` 加（**照該檔既有的掛載形狀 —— 它有三個 `ctx.mount(createOutputSpillGuard(ctx, {...}))` 的呼叫點**）：

```ts
  it("never replaces a `read` result — a truncated read would send the model back to read again", async () => {
    // …mount with maxOutputBytes small (e.g. 100), then drive two calls through
    // the SAME registry: one named `read` returning an oversized string, one
    // named something else returning the SAME oversized string.
    // Assert: the non-read one is replaced (contains the spill notice); the
    // read one is returned byte-identical.
  })
```

- [ ] **Step 2: 跑它，確認它紅**

Expected: **紅在 `read` 那一半**（現在**兩個都會被替換**）。

- [ ] **Step 3: 實作**

`spill-guard.ts:30` 之後（`const d = dispatch as { name: string }` 那附近）：

```ts
        // A truncated `read` sends the model back to read the same file, and it
        // gets truncated again — the loop is worse than the size. dsh skips it
        // for exactly this reason (spec §4.2). The check is on the TOOL NAME at
        // the cascade seam, which is the only place this guard can see it.
        if (d.name === "read") return out
```

**放在那兩個 size 檢查**之前。**⇒ 它要涵蓋字串與物件兩條路徑**（那一行在兩者之前 ⇒ 涵蓋了）。

- [ ] **Step 4: 跑測試（綠）** ／ **Step 5: 突變**（拿掉那一行 ⇒ Step 1 紅；還原）

- [ ] **Step 6: Commit**

```bash
git add packages/output-retention/src/spill-guard.ts packages/output-retention/test/spill-guard.test.ts
git commit -m "fix(output-retention): M5 T4 block 3 — a spilled `read` is a read-spill-read loop, so it is skipped"
```

---

### Task 3: 替代品**不得大於上限**

**Files:**
- Modify: `packages/output-retention/src/spill-guard.ts`（`:40` 與 `:49` 兩個組裝點）
- Test: `packages/output-retention/test/spill-guard.test.ts`

**Interfaces:**
- Consumes: `createTextRetainer`／`spillNotice`（既有）。
- Produces: 無新 export。

**dsh 的原文是 "the policy NEVER emits a replacement larger than the cap"**，而它在那裡是一個**明確的檢查**（超了就放棄、保留原文）。

**⇒ 而 IH 今天沒有**：`:35`／`:43` 只檢查**進入時**的 `<= maxBytes`，而 **`kept.text + "\n" + spillNotice(...)` 可以超過它** —— 因為 notice 自己佔位元組。

- [ ] **Step 1: 寫紅測試**

```ts
  it("never emits a replacement larger than the cap — the notice counts against it", async () => {
    // Mount with a SMALL maxOutputBytes (the notice itself is ~100+ bytes, so a
    // cap near that size forces the arithmetic to matter), drive one oversized
    // result, and assert Buffer.byteLength(replacement) <= cap.
    // Then drive the boundary case: a result JUST over the cap where the notice
    // would push the replacement past it ⇒ the ORIGINAL must be returned.
  })
```

- [ ] **Step 2: 跑它，確認它紅**

Expected: **紅在第二個案例**（那個剛好越界的，會被換成一個**更大的**替代品）。

- [ ] **Step 3: 實作**

**照 dsh 的算式**（它的 `:166-181` 是這個形狀）：**先算 notice 的位元組數、把它從預算裡扣掉**，再取頭尾；而**如果組出來的替代品仍然超過上限，就放棄、回原文**。

```ts
        // The cap bounds what the MODEL sees, so the notice is inside it, not
        // on top of it. dsh's rule (spec §4.2): "the policy NEVER emits a
        // replacement larger than the cap". A bound whose own replacement
        // exceeds it is the defect this guard exists to remove — so if the
        // arithmetic cannot fit, keep the original rather than emit something
        // larger than what it replaced.
        const notice = spillNotice(kept.omittedBytes, path)
        const replacement = kept.text + "\n" + notice
        if (Buffer.byteLength(replacement, "utf-8") > maxBytes) return out
        return replacement
```

**⚠ 而兩個組裝點（字串與物件）都要改** —— **它們今天各有一份相同的算式**，而**只改一個就是這一塊一路在消滅的「只做一半」。**

**⚠ 而物件那一條的 `{ output, outputPaths, spill }` 信封也要算進去** —— 上限管的是**那一格的 `output`**，所以**檢查的是 `output` 那一欄的位元組數**。**把這個判斷寫在註解裡**，因為它是那個信封唯一容易搞錯的地方。

- [ ] **Step 4: 跑測試（綠）** ／ **Step 5: 突變**（把 `> maxBytes` 的放棄拿掉 ⇒ Step 1 紅；還原）

- [ ] **Step 6: Commit**

```bash
git add packages/output-retention/src/spill-guard.ts packages/output-retention/test/spill-guard.test.ts
git commit -m "fix(output-retention): M5 T4 block 3 — the bound counts its own notice, and keeps the original when it cannot fit"
```

---

### Task 4: 在 CLI **掛上**它（而且它會改的是**日誌**）

**Files:**
- Modify: `packages/output-retention/src/spill-guard.ts`（一個 `code` 判準）
- Modify: `apps/cli/src/run.ts`（把預設打開**說出來**）
- Test: `packages/output-retention/test/spill-guard.test.ts`（那條判準）
- Test: `apps/cli/test/`（**照該套件既有的形狀** —— 一個釘住「CLI 真的掛了它」的案例）

**Interfaces:**
- Consumes: T1 的 `TOOL_ABORTED_MID_FLIGHT` ＋ 既有的 `TOOL_FAILED`／`TOOL_ABORTED_BEFORE_DISPATCH`。
- Produces: 無新 export。

**這一條有兩件，而第二件是這一塊的**理由**。**

**(a) 合成的失敗不被界 —— 靠一個 `code` 判準。**

```ts
// A synthetic failure is a VERDICT ABOUT a call, not output FROM it. Truncating
// one is worse than not bounding it: the model would lose the reason the call
// failed, which is the whole point of block ①. And the predicate reads the
// CODE, not the shape — a body that returns `{ error }` as real data is not a
// failure, and keying on the shape would bound it.
const SYNTHETIC_FAILURE_CODES = new Set([
  TOOL_FAILED, TOOL_ABORTED_BEFORE_DISPATCH, TOOL_ABORTED_MID_FLIGHT,
])
const isSyntheticFailure = (out: unknown): boolean =>
  typeof out === "object" && out !== null && SYNTHETIC_FAILURE_CODES.has((out as { code?: string }).code as string)
```

**放在 `d.name === "read"` 那一行的旁邊**，同樣在 size 檢查之前。

**⚠ 而「那三個常數住在哪裡」已經量過了，而答案是「不是 `core-agent`」：**

```
output-retention 的依賴 : core-plugin, core-tools
core-agent 的依賴       : compaction, core-plugin, core-session, core-tools,
                          llm-mock, llm-seam, token-meter, telemetry
```

**⇒ `output-retention → core-agent` 是一條**方向相反**的新邊（一個低階工具依賴 agent 迴圈），而**這一塊不加它。**

**⇒ 裁定：那三個 code 宣告在 `core-tools`。** 理由：**它們描述的是**工具結果的形狀**，而 `core-tools` 正是擁有那份契約的套件**（`ToolResult`、`Tool`、registry 都在那裡），**而 `core-agent` 與 `output-retention` 都依賴它** ⇒ **兩邊都構得到，而沒有新邊。**

**作法（最小）：** `core-tools/src/index.ts` 宣告那三個常量；`execute-tool-calls.ts` **改成從 `@i-harness/core-tools` import，並保留它自己的 re-export**（所以既有的匯入者與測試不動）。**這是一次「把一個常量搬到它真正的家」的小重構，而它不是這一塊的主題** —— **所以它自己一個提交，訊息要說出為什麼**。

**⇒ 而如果實作者量到那條搬遷會動到很多呼叫點，停手回報** —— **代價要判在看得見的地方，不是在一個順手的編輯裡。**

**(b) CLI 把預設打開 —— 而它要在呼叫點上看得見。**

`apps/cli/src/run.ts:543` 今天是 `...(opts.outputSpill !== undefined ? { outputSpill: opts.outputSpill } : {})` —— **而沒有呼叫者設它**。

```ts
      // M5 T4 block ③: MOUNTED BY DEFAULT. Until this line, `createOutputSpillGuard`
      // had tests and no production mount — the exact "declared, tested, never
      // wired" shape this repo's reachability audit exists to find.
      //
      // NOTE WHAT IT CHANGES: IH's guard rewrites `output` — the DURABLE record,
      // not the model-facing rendering (dsh's rewrites `content`). So this is a
      // change to what the session log holds, not to how it is displayed. spec
      // §4.3 states that trade-off and why it is taken: the bound survives a
      // replay, which a rendering-only bound would not.
      outputSpill: opts.outputSpill ?? {},
```

**⇒ 而 `opts.outputSpill ?? {}` 就是那個「把預設打開說出來」的形式** —— 呼叫者仍然可以傳自己的設定（**上限、spill 目錄、GC**），而**不傳就是預設**。**而這一行就是那個「從來沒有被掛上」的護欄第一次被掛上的地方。**

- [ ] **Step 1: 寫測試（兩個）** —— 合成的失敗不被界（**三個 `code` 各一條**）；CLI 真的掛了它
- [ ] **Step 2: 跑它們，確認紅**
- [ ] **Step 3: 實作 (a) 與 (b)**
- [ ] **Step 4: 跑測試（綠）**
- [ ] **Step 5: 突變**（把 `isSyntheticFailure` 改成永遠回 `false` ⇒ 那三條必須紅；把 `run.ts` 的 `?? {}` 拿掉 ⇒ CLI 那條必須紅。**各還原。**）
- [ ] **Step 6: 五步閘門**

```bash
pnpm verify:all
```

Expected: `suite` 全綠 · **母體 66** · typecheck 0 · **e2e 5 檔** · **`gate PASS`**。**任何一步不是預期 ⇒ 停手回報，不要改數字去迎合。**

- [ ] **Step 7: Commit**

```bash
git add packages/output-retention/src/spill-guard.ts apps/cli/src/run.ts packages/output-retention/test/spill-guard.test.ts
git commit -m "feat(output-retention,cli): M5 T4 block 3 — the guard is mounted, synthetic failures are exempt, and the log-changing trade-off is stated"
```

---

## Self-Review

**1 · Spec coverage**

| spec | 在哪 |
|---|---|
| §4.1 在 CLI 掛上 | **T4(b)** |
| §4.2-1 跳過 `read` | **T2** |
| §4.2-2 替代品不得大於上限 | **T3** |
| §4.3 它改的是 `output` 不是 `content`（**一個決定，不是細節**） | **T4(b) 的註解 ＋ Global Constraints 第 1 條** |
| §4.4 的代價 | T4 的提交訊息 ＋ handoff |
| §9 ③ 的三項 | T2／T3／T4 |
| **block ② 終審指名的先決** | **T1** |

**2 · Placeholder scan** —— 無 TBD。**T2 與 T4 的測試是描述性的**（它們要先讀那兩個套件既有的 fixture 形狀），而**它們明說自己是**，並說明理由 —— 與 block ② 的 T3 同一個判斷。

**3 · Type consistency** —— `TOOL_ABORTED_MID_FLIGHT`（T1 定義、T4 消費）· `isSyntheticFailure`／`SYNTHETIC_FAILURE_CODES`（T4 內部）· `createOutputSpillGuard`／`OutputSpillGuardConfig`（既有）。

**4 · 三個明說的缺口**

- **spec §7 的「用 `deriveMessages` 端到端斷言」那一列仍然不在**（它住在 `core-session`）。**它從 block ① 就掛在那裡，而它是一個獨立小項。**
- **SDK／ACP 掛不掛排程** —— spec §7 把那一格留給另一個單元，而這一塊**只動 CLI**（§0.3）。
- **`pnpm verify:all` 不是強制的**（block ② 的 concern 2）—— **讓它成為強制的是 CI 或 git hook 的決定，在這一塊之上。**

**5 · 這一塊**沒有**做的**

- **把散落的界收斂到同一處**（`shell` 64KB、`exec` 64KB、`web` 128K chars、`compaction` 8,192 chars 維持原位）—— spec §6.1 明說不做，**它們服務不同的東西**。
- **`assembly.ts` 的語意**（§0.3 的裁定）。
