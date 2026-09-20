# M5／T4 block ① — 軟失敗信封 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一個被派送的工具呼叫，無論成功或丟出，都在日誌裡留下**恰好一筆** `tool/result` —— 而且 turn 繼續。

**Architecture:** `executeToolCalls` 的失敗路徑停止 `rethrow`，改走中止路徑**已經在跑**的那條：填補沒有輸出的格子、讓頭部游標前進、讓已經落地的兄弟 commit 它們**真的**結果、替從未開始的呼叫填一筆（訊息與中止不同）。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest · 純函式排程器（`core-agent`）

**Spec:** `docs/superpowers/specs/2026-09-20-m5-t4-tool-pipeline-design.md`（**§2 是這一塊的全部依據**；§2.2／§2.3／§2.4 是它的理由與代價）。區塊 ②（參數 schema）與 ③（界）另有計畫。

## Global Constraints

- **接縫沒有錯誤旗標，而 v1 不加**（spec §2.5）。`grep -rn "isError\|is_error" packages/llm-*/src` 必須**維持零命中**。
- **中止路徑的 `throw new Error("agent aborted")` 不動**（spec §2）。既有的五條 abort 測試必須**一條都不改**。
- **`prepare` 的政策丟出仍然殺掉整個 turn**（spec §6.1）：`unknown tool`、`guard denied`、`denied`、approval-denied。這一塊**不碰**它們。
- **合成失敗不跑 `finalize`、不發 `agent/post-tool`**（M10a 的既有裁定，經 `"synthetic" in slot` 那條分支）。
- **不新增 export，除了那兩個常數**（`TOOL_FAILED`、`TOOL_CANCELLED_BY_SIBLING`）—— `node scripts/audit/check-reachability.mjs --gate` 必須維持 `gate PASS -- no new rows`。
- **測試住在 `packages/core-agent/test/`**，這一塊全部改 `packages/core-agent/test/execute-tool-calls.test.ts` 一個檔。
- **行號會腐化。** 這份計畫的每一處引用在動手前先 `grep -n` 核對。

---

## File Structure

| 檔案 | 角色 | 這一塊做什麼 |
|---|---|---|
| `packages/core-agent/src/execute-tool-calls.ts` | 批次排程器 —— 派送、提交、取消、**失敗** | **唯一的生產改動**：失敗路徑（檔尾的 `if (firstError)` 區塊）＋ 兩個常數 |
| `packages/core-agent/src/index.ts` | 對外出口 ＋ 呼叫點 | `:12-16` 的 re-export 區塊加兩個名字；`:405-407` 的**契約註解**改寫 |
| `packages/core-agent/test/execute-tool-calls.test.ts` | 這一塊的全部測試 | 改寫一條（被推翻的契約）＋ 新增四條 |

**為什麼不動 `core-session`、`core-tools`、任何適配器**：這一塊只改「失敗之後**寫什麼進日誌**」。`tool/result` 的形狀、`deriveMessages` 的投影、`toolResultText` 的呈現**一個字都不改**（spec §8 的表）。

---

### Task 1: 失敗的呼叫拿到自己的結果，落地的兄弟拿到真的結果

**Files:**
- Modify: `packages/core-agent/src/execute-tool-calls.ts`（檔尾的 `if (firstError)` 區塊，`git grep -n "rethrow the first error"` 找它）
- Modify: `packages/core-agent/src/execute-tool-calls.ts:7` 附近（常數區）
- Test: `packages/core-agent/test/execute-tool-calls.test.ts`（改寫 `:203` 那一條，新增一條）

**Interfaces:**
- Consumes: 中止路徑既有的兩個機制 —— `SyntheticSlot`（`"synthetic" in slot` 的提交分支）與 `commitReady()`。
- Produces: `export const TOOL_FAILED = "TOOL_FAILED"` —— 失敗那一格 `output` 的 `code`。Task 2、Task 3 會用到它。

- [ ] **Step 1: 讀懂被推翻的那一條測試**

打開 `packages/core-agent/test/execute-tool-calls.test.ts`，找到 `describe("executeToolCalls scheduler")` 裡的：

```ts
it("drains started calls and rethrows the first failure (no fabrication)", async () => {
```

**它斷言兩件事，而兩件都要被推翻**：`.rejects.toThrow("kaboom")` 與 `expect(resultsOf(session).length).toBeLessThan(2)`。**這一條不是被刪掉，是被改寫成新契約** —— 一個刪掉的斷言不留痕，一個改寫的斷言說明契約變了。

- [ ] **Step 2: 改寫那一條成為新契約（紅）**

把那一條**整條**換成（`describe` 的位置不變）：

```ts
  it("a failed call yields its OWN result and the turn continues (no rethrow)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    tools.register({
      name: "oktool",
      description: "ok",
      inputSchema: {},
      isConcurrencySafe: true,
      execute: async () => { await new Promise((r) => setTimeout(r, 20)); return { ok: true } },
    })
    tools.register({
      name: "boomtool",
      description: "boom",
      inputSchema: {},
      isConcurrencySafe: true,
      execute: async () => { throw new Error("kaboom") },
    })
    // NO .rejects — the whole point of this contract is that it resolves.
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "oktool", args: {} },
      { callId: "c1", name: "boomtool", args: {} },
    ], { maxParallel: 10 })
    // Every dispatched call has exactly one result, in MODEL order: the
    // failing slot is filled synthetically so the head-of-line cursor
    // advances and the settled sibling commits its REAL output.
    const results = session.events.filter((e) => e.type === "tool/result") as {
      callId: string
      name: string
      output: unknown
    }[]
    expect(results.map((r) => r.callId)).toEqual(["c0", "c1"])
    expect(results[0]!.output).toEqual({ ok: true })
    expect(results[1]!.output).toEqual({ error: "kaboom", code: TOOL_FAILED })
  })
```

同時把檔頭的 import 改成（加 `TOOL_FAILED`）：

```ts
import { executeToolCalls, TOOL_ABORTED_BEFORE_DISPATCH, TOOL_FAILED } from "../src/index.ts"
```

- [ ] **Step 3: 先加常數與 re-export（它們是惰性的，不改變行為）**

**先加它們的理由**：否則 Step 4 的紅會是「模組匯不出這個名字」—— 那個紅**證明不了任何關於契約的事**。加了之後，紅才是**真的紅**（那個 promise 拒絕）。

在 `execute-tool-calls.ts` 的常數區（`git grep -n "TOOL_ABORTED_BEFORE_DISPATCH"` 找 `:7` 那一行），加：

```ts
export const TOOL_FAILED = "TOOL_FAILED"
```

放在 `TOOL_ABORTED_BEFORE_DISPATCH` **旁邊**（不要另開一區）。

然後在 `core-agent/src/index.ts` 的 re-export 區塊（`git grep -n "TOOL_ABORTED_BEFORE_DISPATCH" packages/core-agent/src/index.ts` 找 `:12-16`）把 `TOOL_FAILED,` 加進去，跟隨既有的排列風格。

- [ ] **Step 4: 跑它，確認它紅 —— 而紅的理由是對的那一個**

Run: `pnpm --filter @i-harness/core-agent exec vitest run test/execute-tool-calls.test.ts -t "yields its OWN result"`

Expected: **紅**，而紅的訊息是 **`kaboom`**（那個 promise 拒絕）—— **不是** `does not provide an export named`。

**這就是被推翻的那條契約本身**：今天一個工具丟出，`executeToolCalls` 就拒絕。若你看到的是 export 的錯，**Step 3 沒做**。若它綠，**停手回報** —— 那代表你改錯了檔。

- [ ] **Step 5: 改失敗路徑（綠）**

在 `execute-tool-calls.ts` 檔尾找到（`git grep -n "Failure: drain started"`）：

```ts
  // Failure: drain started (results discarded), rethrow the first error.
  if (firstError) {
    await Promise.allSettled([...inFlight.values()])
    inFlight.clear()
    throw firstError
  }
```

換成：

```ts
  // Failure: cancel the siblings (M5 T4), then COMMIT — every DISPATCHED call
  // ends in exactly one tool/result. This used to `throw firstError` and
  // discard the batch; fs/src/error.ts records the consequence in its own
  // words ("no tool/result and no turn/end are appended ... read as hung").
  //
  // Cancelling and committing are different questions: cancellation answers
  // "do the siblings keep working" (no), committing answers "how does what
  // happened get written down" (honestly). Discarding the siblings' already
  // settled results made the M5 T4 cancellation pointless — they were
  // cancelled AND thrown away.
  if (firstError) {
    await Promise.allSettled([...inFlight.values()])
    inFlight.clear()
    // Fill every STARTED slot that produced no output, so the head-of-line
    // cursor advances and an already-settled sibling commits its REAL result
    // (the SAME mechanism M51 B3 added to the abort path, one branch up).
    const message = firstError instanceof Error ? firstError.message : String(firstError)
    for (let i = committed; i < startedUpTo; i += 1) {
      if (slots[i] !== undefined) continue
      const call = batch[i]!
      slots[i] = {
        name: call.name,
        callId: call.callId,
        synthetic: true,
        output: { error: message, code: TOOL_FAILED },
      }
    }
    await commitReady()
  }
```

- [ ] **Step 6: 跑測試（綠）**

Run: `pnpm --filter @i-harness/core-agent exec vitest run test/execute-tool-calls.test.ts`

Expected: **全綠**。若 `M5 — a failure cancels its siblings` 變紅，**停手回報** —— 那代表 `batchAbort.abort()` 被碰掉了，而它是這一塊**不可以動**的東西（Global Constraints）。

- [ ] **Step 7: 用突變證明這條測試真的在測這個**

把 `await commitReady()` 那一行**註解掉**，重跑。

Expected: **紅** —— `expected [ 'c1' ] to deeply equal [ 'c0', 'c1' ]`（兄弟的結果沒有 commit）。

**還原那一行**，再跑一次確認綠。**這一步不是儀式**：它證明這條測試紅在「兄弟沒有 commit」而不是別的。

- [ ] **Step 8: Commit**

```bash
git add packages/core-agent/src/execute-tool-calls.ts packages/core-agent/src/index.ts packages/core-agent/test/execute-tool-calls.test.ts
git commit -m "feat(core-agent): M5 T4 block 1 — a failed tool call yields its own result, and its settled siblings keep theirs"
```

---

### Task 2: 從未開始的呼叫拿到一筆**與中止不同**的結果

**Files:**
- Modify: `packages/core-agent/src/execute-tool-calls.ts`（Task 1 寫的那個 `if (firstError)` 區塊的尾巴）
- Modify: `packages/core-agent/src/index.ts`（re-export）
- Test: `packages/core-agent/test/execute-tool-calls.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `TOOL_FAILED`；中止路徑既有的 `TOOL_ABORTED_BEFORE_DISPATCH`（`execute-tool-calls.ts:7`）與它的 `append` 迴圈（`:243-251`）。
- Produces: `export const TOOL_CANCELLED_BY_SIBLING = "TOOL_CANCELLED_BY_SIBLING"`。

**為什麼需要一條新的訊息**：spec §2.3 —— 「被中止」與「因為同批的兄弟失敗而被取消」**是兩件不同的事，不可以共用一句話**。共用會讓一份日誌分不出「使用者按了停」與「工具壞了」。

- [ ] **Step 1: 寫紅測試**

在 `describe("executeToolCalls scheduler")` 裡，Task 1 那一條的**後面**加：

```ts
  it("a never-started call is CANCELLED, and says so — not the abort message", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    tools.register({
      name: "boomtool",
      description: "boom",
      inputSchema: {},
      isConcurrencySafe: true,
      // Throws IMMEDIATELY: c0 fails before c1's prepare ever runs, so c1 is
      // never started and lands in the [startedUpTo, batch.length) range.
      execute: async () => { throw new Error("kaboom") },
    })
    tools.register({
      name: "nevertool",
      description: "never started",
      inputSchema: {},
      isConcurrencySafe: true,
      execute: async () => ({ ok: true }),
    })
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "boomtool", args: {} },
      { callId: "c1", name: "nevertool", args: {} },
    ], { maxParallel: 1 })
    const results = session.events.filter((e) => e.type === "tool/result") as {
      callId: string
      output: { code?: string }
    }[]
    expect(results.map((r) => r.callId)).toEqual(["c0", "c1"])
    expect(results[0]!.output.code).toBe(TOOL_FAILED)
    expect(results[1]!.output.code).toBe(TOOL_CANCELLED_BY_SIBLING)
    // The two must NOT share a message: one is "the user stopped the step",
    // the other is "a sibling in the same batch failed". A log that cannot
    // tell them apart is the defect this pins.
    expect(results[1]!.output).not.toMatchObject({ code: TOOL_ABORTED_BEFORE_DISPATCH })
  })
```

import 那一行再加上 `TOOL_CANCELLED_BY_SIBLING`。

- [ ] **Step 2: 跑它，確認它紅**

Run: `pnpm --filter @i-harness/core-agent exec vitest run test/execute-tool-calls.test.ts -t "CANCELLED, and says so"`

Expected: **紅** —— `TOOL_CANCELLED_BY_SIBLING` 尚未 export（import 失敗），或 `results` 只有 `["c0"]`。

- [ ] **Step 3: 加常數並實作**

`execute-tool-calls.ts` 常數區（`TOOL_FAILED` 旁邊）：

```ts
// A call that never started because a SIBLING failed. Deliberately a
// different code AND a different message from TOOL_ABORTED_BEFORE_DISPATCH:
// "the user stopped the step" and "a tool in this batch broke" are different
// facts, and a log that conflates them cannot be read back.
export const TOOL_CANCELLED_BY_SIBLING = "TOOL_CANCELLED_BY_SIBLING"
```

`core-agent/src/index.ts` 的 re-export 區塊加上它。

然後在 `if (firstError)` 區塊的**尾巴**（`await commitReady()` 之後）加：

```ts
    // Calls that never started: no `prepare`, no `tool/dispatch`, no body.
    // They get a result too, so the projection never emits a tool_use with no
    // tool_result — but their verdict is CANCELLATION, not abort.
    for (let i = startedUpTo; i < batch.length; i += 1) {
      const call = batch[i]!
      append(session, {
        type: "tool/result",
        callId: call.callId,
        name: call.name,
        output: {
          error: "tool call cancelled: a sibling call in the same batch failed",
          code: TOOL_CANCELLED_BY_SIBLING,
        },
      })
    }
```

- [ ] **Step 4: 跑測試（綠）**

Run: `pnpm --filter @i-harness/core-agent exec vitest run test/execute-tool-calls.test.ts`

Expected: **全綠**。

- [ ] **Step 5: 突變 —— 證明「不同」這一半被釘住**

把新迴圈的 `code: TOOL_CANCELLED_BY_SIBLING` 改成 `code: TOOL_ABORTED_BEFORE_DISPATCH`，重跑。

Expected: **紅** —— `expected 'TOOL_ABORTED_BEFORE_DISPATCH' to be 'TOOL_CANCELLED_BY_SIBLING'`。

**還原**，再跑確認綠。

- [ ] **Step 6: Commit**

```bash
git add packages/core-agent/src/execute-tool-calls.ts packages/core-agent/src/index.ts packages/core-agent/test/execute-tool-calls.test.ts
git commit -m "feat(core-agent): M5 T4 block 1 — a never-started call is CANCELLED by its sibling, and the log says which"
```

---

### Task 3: 三條**不可以動**的界線

**Files:**
- Modify: `packages/core-agent/src/execute-tool-calls.ts`（`commitReady()` 的 try/catch）
- Test: `packages/core-agent/test/execute-tool-calls.test.ts`

**Interfaces:**
- Consumes: Task 1／2 的失敗路徑。
- Produces: 無新 export。**這一條是防守** —— 它把 spec §2、§6.1 的三條界線釘成測試。

**為什麼這一條要獨立**：前兩條動的是失敗路徑，而失敗路徑**緊貼著**中止路徑與 `prepare` 的丟出。**一個「順手統一一下」的編輯會把三條界線一起抹掉，而前面所有的測試都會照樣綠** —— 除非有東西單獨釘住它們。

- [ ] **Step 1: 寫三條界線的測試（紅 or 綠 —— 見下）**

在 `describe("executeToolCalls scheduler")` 的最後加：

```ts
  it("BOUNDARY: a PREPARE refusal still kills the turn (spec §6.1 — only a dispatched failure is soft)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    // An unregistered tool makes `prepare` throw at core-tools:230. That is a
    // POLICY/PROTOCOL refusal, not a tool failure, and it must stay loud.
    await expect(
      executeToolCalls(ctx, session, tools, [{ callId: "c0", name: "no-such-tool", args: {} }], { maxParallel: 10 }),
    ).rejects.toThrow("unknown tool: no-such-tool")
    expect(session.events.filter((e) => e.type === "tool/result")).toHaveLength(0)
  })

  it("BOUNDARY: an ABORT still throws 'agent aborted' (block 1 does not touch it)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const ac = new AbortController()
    ac.abort()
    await expect(
      executeToolCalls(ctx, session, tools, [
        { callId: "c0", name: "anyTool", args: {} },
      ], { maxParallel: 1, signal: ac.signal }),
    ).rejects.toThrow("agent aborted")
  })

  it("BOUNDARY: a throwing finalize during the failure drain still fills the never-started calls", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    // Mirrors the abort-path test ("abort dominates a throwing finalize").
    // The failure path inherits the same swallow, AND the same cost.
    ctx.on("tools/post-execute", () => { throw new Error("post-execute boom") })
    tools.register({
      name: "okTool", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => { await new Promise((r) => setTimeout(r, 30)); return { ok: true } },
    })
    tools.register({
      name: "boomTool", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => { throw new Error("kaboom") },
    })
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "okTool", args: {} },
      { callId: "c1", name: "boomTool", args: {} },
      { callId: "c2", name: "okTool", args: {} }, // never started (pool full at the failure)
    ], { maxParallel: 2 })
    const cancelled = session.events.filter(
      (e) => e.type === "tool/result" && (e as { output?: { code?: string } }).output?.code === TOOL_CANCELLED_BY_SIBLING,
    )
    expect(cancelled.map((e) => (e as { callId: string }).callId)).toEqual(["c2"])
  })
```

- [ ] **Step 2: 跑它們**

Run: `pnpm --filter @i-harness/core-agent exec vitest run test/execute-tool-calls.test.ts -t "BOUNDARY"`

Expected: **前兩條綠、第三條紅** —— 第三條會因為 `commitReady()` 的丟出**逃出 `executeToolCalls`**，於是 `cancelled` 是空的（而且測試會以 `post-execute boom` 失敗）。

**若三條全綠，停手回報**：那代表第三條沒有測到它要測的東西。

- [ ] **Step 3: 加 try/catch**

在 Task 1 寫的 `await commitReady()` 外面加：

```ts
    try {
      await commitReady()
    } catch {
      // A throwing tools/post-execute listener must not suppress the
      // never-started fills below — the abort path swallows for exactly this
      // reason (see its comment at the top of the abort branch).
      //
      // STATED COST (inherited, not introduced): a settled sibling sitting
      // BEHIND the throwing listener does not get its result. The abort path
      // has the same hole and the same test shape; this block does not fix it,
      // it makes the two paths consistent and the cost visible.
    }
```

- [ ] **Step 4: 跑測試（綠）**

Run: `pnpm --filter @i-harness/core-agent exec vitest run test/execute-tool-calls.test.ts`

Expected: **全綠**。

- [ ] **Step 5: Commit**

```bash
git add packages/core-agent/src/execute-tool-calls.ts packages/core-agent/test/execute-tool-calls.test.ts
git commit -m "test(core-agent): M5 T4 block 1 — the three boundaries that must not move with the failure path"
```

---

### Task 4: 過期的契約註解，與全套閘門

**Files:**
- Modify: `packages/core-agent/src/index.ts`（`git grep -n "rethrows the first tool failure"` 找那段）
- Modify: `docs/handoff/2026-09-20-queued-work.md`（§1 的 W5 列 ＋ §5 的完成記錄）

**Interfaces:**
- Consumes: Task 1–3 全部。
- Produces: 無。

- [ ] **Step 1: 找出說謊的註解**

```bash
git grep -n "rethrows the first tool failure" packages/core-agent/src/index.ts
```

它會指向 `core-agent/src/index.ts` 呼叫點上方那段（大約 `:405-407`）。**那段話在 Task 1 落地的那一刻就變成假的。**

- [ ] **Step 2: 改寫它**

把那三行**整段**換成：

```ts
        // M13: concurrent execution. The scheduler appends tool/result in model
        // order and emits agent/post-tool from its commit lane; it throws
        // "agent aborted" on step abort (draining + synthesizing results for
        // never-started calls). A tool failure does NOT throw: the failed call
        // is filled with a TOOL_FAILED result, its never-started siblings get
        // TOOL_CANCELLED_BY_SIBLING, and the turn continues so the model sees
        // the error and can retry. (Before M5 T4 block ① this rethrew the first
        // failure and discarded the batch; fs/src/error.ts records what that
        // looked like from the outside.)
```

- [ ] **Step 3: 全套**

```bash
pnpm -r --no-bail test
pnpm typecheck
node scripts/audit/check-reachability.mjs --gate
```

Expected:
- `pnpm -r --no-bail test` → **exit 0**。基線是 **`2624 passed · 0 failed · 9 skipped`**（W4 修正輪量到的，`docs/handoff/2026-09-20-queued-work.md` §5；其後只有 docs 提交，所以基線不動）。這一塊淨增 **4** 條：**Task 1 是改寫，不是新增（淨 0）**、Task 2 加 1、Task 3 加 3 ⇒ **預期 `2628 passed · 0 failed · 9 skipped`**。**動手前先把這個算式寫在旁邊**，跑完對照。
- `pnpm typecheck` → **0 error lines**
- `check-reachability.mjs --gate` → **`gate PASS -- no new rows`**

**⚠ 兩個既有的 flake，看到它們紅：重跑一次、繼續，不要改任何計數。**
1. `packages/session-executor/test/shell-promotion.test.ts` 在負載下 30 秒逾時
2. `apps/cli/test/input-tiers.test.ts` 的 executor 案例在滿載下紅，隔離跑必過

**預期不符就停手回報** —— 不要改那個數字去迎合結果。

- [ ] **Step 4: 更新佇列文件**

`docs/handoff/2026-09-20-queued-work.md`：
- §1 的 **W5** 列：`實作未開始` → **`✅ block ①（信封）完成`**
- §5 的 **T4 的工具管線** 那列底下，加一段完成記錄：**三塊的哪一塊完成了**、**量到什麼**、**`ruling A` 被推翻而它是刻意的**

**規則（文件自己的 §0）**：**做完一件，就在同一個提交裡把它的狀態改掉。** 而 **SHA 不能在它存在之前被寫下** —— 狀態列先寫成 `<SHA>` 佔位。

- [ ] **Step 5: Commit**

```bash
git add packages/core-agent/src/index.ts docs/handoff/2026-09-20-queued-work.md
git commit -m "docs(core-agent): M5 T4 block 1 — the call site's contract comment catches up, and the queue records the block"
```

- [ ] **Step 6: 補上 SHA**

```bash
git log --oneline -4
```

把該列的 `<SHA>` 換成真的 SHA，另開一個 docs 提交（**這是這條分支的既有慣例：一個 SHA 不能在它存在之前被寫下**）。

---

## Self-Review

**1 · Spec coverage（§2 的每一條對照一個任務）**

| spec | 在哪 |
|---|---|
| §2.1 步驟 1（停止啟動） | **不動** —— 既有的 `:190`／`:208` 已經正確 |
| §2.1 步驟 2（取消在飛的兄弟） | **不動** —— `4c85a04` 已經正確，Task 1 Step 7 的「若紅停手」守它 |
| §2.1 步驟 3（不再 rethrow） | Task 1 |
| §2.1 步驟 4（填失敗那一格） | Task 1 |
| §2.1 步驟 5（落地的兄弟 commit） | Task 1 |
| §2.1 步驟 6（從未開始的填） | Task 2 |
| §2.3（訊息必須不同） | Task 2 Step 5 的突變 |
| §2.4 的四條代價 | 前三條由 Task 3 與 Global Constraints 守住；第四條（post-tool）由既有的 `"synthetic" in slot` 分支維持，`M51 B3` 那條測試仍然綠 |
| §2.5（不加錯誤旗標） | Global Constraints 第 1 條 |
| §6.1（政策丟出仍然大聲） | Task 3 第 1 條 |
| §7 的測試表（前兩列） | Task 1、Task 2 |

**2 · Placeholder scan** —— 無 TBD／TODO；每個 code step 都有完整可貼的內容。

**3 · Type consistency** —— `TOOL_FAILED` 與 `TOOL_CANCELLED_BY_SIBLING` 在 Task 1／2 定義，在 Task 1／2／3 使用，拼字一致；`SyntheticSlot` 與 `commitReady` 是既有的名字（`execute-tool-calls.ts:65`、`:88`）。

**4 · 一個刻意的缺口（寫出來免得被當成漏做）** —— **`deriveMessages` 端到端那一條**（spec §7 第三列：「每一個 `tool/call` 都有對應的 `tool/result`，用 `deriveMessages` 的輸出斷言」）**不在這一塊**。理由：`deriveMessages` 住在 `core-session`，而這一塊的 Global Constraints 明說不動它；把它寫成 `core-session` 的一條測試會**假裝這一塊改了它**。**它是 block ②／③ 的計畫要處理的**，或者是一個獨立的小項。**這裡記著，不假裝做了。**
