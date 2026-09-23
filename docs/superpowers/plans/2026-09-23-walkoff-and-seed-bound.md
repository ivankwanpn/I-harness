# M76 — 走位守衛與種子邊界 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ①走位守衛在樹的**實際**日誌順序下是惰性的（M70 的 `tool/dispatch` 讓它提前停下）⇒ 兩個壓縮邊界站點仍會孤兒化 `tool/result`；把啟發式換成**精確判準**。②`spawnChild` 在模型能失敗**之前**就建了 durable 子 session 與種子 ⇒ 一次非 ready 的解析留下**孤兒 `child-<uuid>` log**；把 `resolveModel` 挪到種子之前，並在量出的條件上讓「種子自己就超窗」可見。③`anchorSeq` 從不重映射 ⇒ 用與 `shadowedSeqs` 同一條路重映射它。

**Architecture:** 三個獨立的修法，共用一個性質：**切點／引用必須與投影一致**。①把判準從「這個事件是不是 tool 事件」換成「切點之後有沒有孤兒化的 `tool/result`」（result 側，因為未 flush 的 pending call 不進投影）。②把順序改成「閘 → `resolveModel` → 建立 → 貼種子」，於是窗口在種子被建出來時就在 scope，而失敗不再留下 durable 垃圾。③`anchorSeq` 走 `shadowedSeqs` 已經在走的那條映射。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-23-walkoff-and-seed-bound-design.md`（權威；§1.1 判準、§1.2 順序、§1.3 種子端裁決、§1.4 anchorSeq）

## Global Constraints

- **紅先測試 ＋ 變異證明**：每一條修法都要先看到紅；實作後**把修法拿掉一次**、確認**具名的那條**測試變紅、再用 Edit 工具還原（**絕不**用 `git checkout --`），並以 `sha256sum` 確認位元組還原。
  - **突變是預測**：本計畫寫「拿掉哪一條規則 ⇒ 哪一條測試必須紅」。**哪一行字面編輯能達到那個效果，由你量測決定並記錄**——M72／M73／M74／M75 裡，計畫的字面預測錯了**十幾次**，其中 M75 有五個**字面值本身**是任何實作都過不了的。找不到能讓它紅的突變 ⇒ **那是發現，回報它**，不要換一條測試來遷就。
- **既有測試預期零條改動**：只有當某條測試刻意斷言的正是這次要改的契約時才動，而且要**具名說明**、不得放鬆。若有紅，**回報它**（錯的清單比沒有清單更糟）。
- **一條規則只落一處**：走位判準只有一個家（`walkOffToolEvents`）；`anchorSeq` 的重映射只有一個家（`remapSeedEvent`）。
- **缺席即缺席**：沒有窗口時不注入預設、不 warn。
- **提交訊息不加任何 attribution trailer**；**不 amend**；blobs LF；檔案用 Write/Edit 工具寫。
- **每個任務只跑自己套件的測試與 typecheck**；`pnpm verify:all` **整支分支只跑一次**（收尾任務）。
- **不要動 `docs/`**（紀錄由控制器寫）。**不新增 export**（收尾閘門會看）。

---

### Task 1: 走位判準精確化（①）

**Files:**
- Modify: `packages/compaction/src/region.ts`（`walkOffToolEvents` 的**判準**與它的 docstring）
- Modify: `packages/compaction/src/index.ts:338-343`（`resetWindowOnce` 呼叫點上方**過期**的讀數註解）
- Create: `packages/compaction/test/walkoff.test.ts`

**Interfaces:**
- Consumes: `Session`（`@i-harness/core-session`）、`deriveMessages`／`deriveMessagesUpTo`
- Produces: `walkOffToolEvents(session, index): number`（**簽名不變**，只有判準變）；兩個既有呼叫點（`region.ts:67`、`index.ts:344`）**呼叫方式不變**

**判準（精確的那一條，spec §1.1）**：切點 `j` 安全 **iff** 對所有 index ≥ `j` 的事件，凡它是 `tool/result`，它的 `tool/call` 也必須在 index ≥ `j`。**不是**「有沒有開著的 call」——一個**從未解析**的 `tool/call`（中止的 turn）在投影裡不存在（`deriveMessages` 把未 flush 的 pending call 丟掉）⇒ 用 call 側當判準會讓中止過的 session 每一個切點都不安全 ⇒ 走位退到 0 ⇒ `resetWindowOnce` 永遠 `removedSeqs` 為空 ⇒ **階梯退化成 fail-closed**。這一條是本任務的殺手條款。

- [ ] **Step 1: 寫紅測試**（`packages/compaction/test/walkoff.test.ts`）

```ts
import { describe, expect, it } from "vitest"
import { append, createSession, deriveMessages, type Session } from "@i-harness/core-session"
import { walkOffToolEvents } from "../src/region.ts"

/** M70's shipped log order: a `tool/dispatch` sits BETWEEN the call and its result. */
function dispatchSession(turns: number): Session {
  const s = createSession()
  for (let t = 0; t < turns; t++) {
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: `question ${t}` })
    append(s, { type: "step/start" })
    append(s, { type: "tool/call", callId: `call_${t}`, name: "read", args: { path: `f${t}.txt` } })
    append(s, { type: "tool/dispatch", callId: `call_${t}` })
    append(s, { type: "tool/result", callId: `call_${t}`, name: "read", output: { content: `body ${t}` } })
    append(s, { type: "assistant/message", text: `answer ${t}` })
    append(s, { type: "step/end" })
    append(s, { type: "turn/end" })
  }
  return s
}

/** The messages the projection shows BEFORE `cut` — the tail is what a cut retains. */
function messagesBefore(s: Session, cut: number): number {
  return deriveMessages({ ...s, events: s.events.slice(0, cut) }).length
}

/** A retained tail is orphaned iff its FIRST message is a `tool` whose call is not in the tail. */
function orphansAtCut(s: Session, cut: number): number {
  const whole = deriveMessages(s)
  const tail = whole.slice(messagesBefore(s, cut))
  const calls = new Set(tail.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : [])))
  return tail.filter((m) => m.role === "tool" && !calls.has(m.toolCallId ?? "")).length
}

describe("M76: the walk-off rule is exact, not a heuristic", () => {
  it("M76: no cut the rule accepts ever orphans a tool result (dispatch-shaped log)", () => {
    const s = dispatchSession(6)
    const bad: number[] = []
    for (let cut = 0; cut <= s.events.length; cut++) {
      const walked = walkOffToolEvents(s, cut)
      if (orphansAtCut(s, walked) > 0) bad.push(cut)
    }
    expect(bad).toEqual([])
  })

  it("M76: an unresolved call does NOT collapse the walk to 0 (an aborted turn must not disable the ladder)", () => {
    const s = createSession()
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: "q" })
    append(s, { type: "tool/call", callId: "call_never", name: "read", args: {} }) // no result, ever
    append(s, { type: "turn/end" })
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: "q2" })
    append(s, { type: "assistant/message", text: "a2" })
    append(s, { type: "turn/end" })
    // The last event is a `turn/end`: nothing to walk over. A call-side predicate
    // ("is any call still open?") would walk all the way to 0 here and, on the real
    // ladder, make `resetWindowOnce` remove nothing forever.
    const last = s.events.length - 1
    expect(walkOffToolEvents(s, last)).toBe(last)
  })
})
```

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/compaction test`
Expected: 第 1 條紅（dispatch 形狀下會有一批 cut 被判安全卻孤兒化）；第 2 條**今天就是綠的**（舊判準在最後一個 `turn/end` 上本來就停）——它是**實作期間**的殺手：任何用 call 側當判準的寫法都會讓它紅。**量出來並記錄**：第 1 條紅了幾個 cut（舊判準下應為非零）。

- [ ] **Step 3: 實作**

`walkOffToolEvents` 的**判準**改成 result 側；兩個呼叫點不動。**實作方式你自己量**（可以由 `index` 往前掃，也可以先為每個 `tool/call` 記下它的 index 再一次掃；**不要**引入第二份規則的副本）。docstring 要寫明：①它是**精確**規則而不是啟發式；②為什麼看 result 側（未 flush 的 pending call 不進投影）；③`tool/dispatch` **不需要被具名**——它落在「index ≥ j 的 result」這個條件裡自然被覆蓋。

同時用「你實測出來的兩張表」改寫 `index.ts:342-343` 的過期讀數（它今天寫的是 M70 **之前**的「4 of the first 25」，而 M75 量到的是 `retainLast` 1..25 有 **6** 個值孤兒化、走位後**還是 6**）。

- [ ] **Step 4: 跑它，看到綠**

Run: `pnpm --filter @i-harness/compaction test` ＋ 該套件 typecheck。**所有既有案例都要綠**（`compaction.test.ts` 的 86/95/102 與 `engine.test.ts` 的 350/364 是兩個走位站點的既有覆蓋；紅了就是發現）。

- [ ] **Step 5: 變異證明（兩條）**

(a) 把判準換回舊的（只認 `tool/call`／`tool/result` 兩種事件）⇒ 第 1 條必須紅；(b) 把判準寫成 **call 側**版（有沒有未解析的 call）⇒ 第 2 條必須紅。記錄實際編輯與 `sha256sum`（前後）。

- [ ] **Step 6: Commit**

```bash
git add packages/compaction/src/region.ts packages/compaction/src/index.ts packages/compaction/test/walkoff.test.ts
git commit -m "fix(compaction): the walk-off rule asks the RESULT side, so a dispatch-marked tool run can no longer orphan a result (M76)"
```

---

### Task 2: 種子側的重排與可視性（②）

**Files:**
- Modify: `packages/subagent/src/child.ts`（`spawnChild` 的順序；`:252-253` 的註解；新的 warn）
- Test: `packages/subagent/test/child.test.ts`（既有檔，加案例）

**Interfaces:**
- Consumes: `estimateContent`（`@i-harness/token-meter`，**已經是 `packages/subagent` 的依賴**）
- Produces: 行為——順序變成「閘 → `resolveModel` → `coordinator.create` → `createSession` → 貼種子」；**失敗不留 durable 垃圾**；種子投影 ≥ 視窗時**一行 warn**

**裁決（spec §1.3，不要再問）**：**不修剪、不 fail-closed**。切得動的超窗種子現在會**被子代理自己串連摘要**（M75），而修剪是**無聲丟掉**那些資訊 ⇒ 嚴格更差；fail-closed 會把「從大 session 生一個子代理」這個**主要用例**關掉。本任務只做**順序**與**可見性**。

- [ ] **Step 1: 寫紅測試（三條）**

用該檔**既有的** fixtures（M74 的嚴格案例用它自己的 window-enforcing client；`f.table.get(path)!.session` 是子代理**自己**的 session）。**若既有 fixture 表達不了某條性質**，回報你量到的限制——不要改用空洞的斷言。

1. **一次非 ready 的 `resolveModel` 不留 durable 子 session**：用一個非 ready 的 binding 觸發 throw，然後斷言 durable 側**沒有**任何新建立的 `child-<uuid>` session（既有 fixture 應該能從 coordinator／table 觀察到——**量出來並記錄你用的是哪個觀察點**）。這條的紅先是**把順序改回去**。
2. **warn 的觸發**：種子的投影價格 ≥ 視窗 ⇒ warn 出現，且訊息說出後果（會先摘要成幾塊；若是一整塊不可切則這一輪 fail-soft）。
3. **warn 不觸發**：種子放得下 ⇒ **沒有** warn（否則一個永遠 warn 的實作也會綠）。

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/subagent test`
Expected: 第 1 與第 2 條紅（今天沒有 warn、且失敗留下 session）；第 3 條綠先。

- [ ] **Step 3: 實作**

`child.ts`：把 `resolveModel` 區塊**整段**移到 `coordinator.create` 之前（閘之後）。`contextWindow`／`maxOutputTokens`／`model` 的賦值不變，只是提早發生；`declareRole`／telemetry 的既有行為不變。**`sessionId` 的產生**（`child-<uuid>`）留在 `coordinator.create` 那一側，但只有在解析成功之後才會被用到。

warn：**用與子代理自己的引擎同一種價格**（`estimateContent`）算**種子的投影價格**，≥ 視窗時 warn 一行。註解要寫明：這**不是**新的策略，只是讓「子代理必須先摘要一輪」可見；修剪與 fail-closed 都被理由否決（spec §1.3）。順手把 `:252-253` 的註解改成**現在為真**的版本（它說「a refused spawn leaves no child session behind」——重排之後對**所有**失敗路徑為真）。

- [ ] **Step 4: 跑它，看到綠**

Run: 該套件 test ＋ typecheck。既有案例全綠（尤其是 M74 的嚴格兩個案例與 M75 的子代理案例——它們刻意斷言的行為**不變**）。

- [ ] **Step 5: 變異證明（兩條）**

(a) 把順序改回去（`resolveModel` 回到 `create` 之後）⇒ 第 1 條紅；(b) 把 warn 的條件拿掉（無條件 warn 或無條件不 warn）⇒ 第 2 或第 3 條紅。記錄實際編輯與 `sha256sum`。

- [ ] **Step 6: Commit**

```bash
git add packages/subagent/src/child.ts packages/subagent/test/child.test.ts
git commit -m "fix(subagent): the model resolves before the child session exists, so a refused spawn leaves nothing behind (M76)"
```

---

### Task 3: `anchorSeq` 的重映射（③）

**Files:**
- Modify: `packages/session-persistence/src/fork.ts`（`remapSeedEvent`，`:170-180`）
- Modify: `packages/subagent/src/fork.ts:16-29`（契約註解：它現在說 `rewind/point` 的引用**不在**契約內）
- Test: `packages/session-persistence/test/fork.test.ts`（既有檔，加案例）

**Interfaces:**
- Produces: `remapSeedEvent` 對 `rewind/point` 的 `anchorSeq` **與 `seq` 一樣**被映射到子 log 的 index

**為什麼是重映射而不是丟掉**（spec §1.4）：`anchorSeq` 與 `shadowedSeqs` 是**同一種引用**（都指名一個 seq），而 session-fork 路徑用「整條丟掉」繞過 ⇒ 兩條孿生路徑不一致。重映射**保住語意**（rewind 的語意是隱藏 `anchor..seq`）；丟掉會讓那段內容在子代理眼裡**重新出現**。

- [ ] **Step 1: 寫紅測試**

在 `fork.test.ts`：一個帶 `rewind/point`（`anchorSeq` < `seq`）的種子經過 `forkTurns`（`forkTurns: N`，讓切片從後面的 `turn/start` 開始——**索引不重合**才驗得出映射）⇒ 斷言子 log 裡那個標記的 `anchorSeq` 與 `seq` 都指向**同一個事件**（用「取兩邊 seq 指到的事件再比對其身分」的方式斷言，不要斷言一個寫死的數字）。紅先＝今天 `anchorSeq` 帶著父的座標。

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/session-persistence test`

- [ ] **Step 3: 實作**

`remapSeedEvent` 對 `rewind/point` 增加 `anchorSeq` 的映射——**用同一個 `seq → index` 映射**（不要寫第二份換算）。同步更正 `subagent/src/fork.ts:16-29` 的契約註解，說明它**現在**在契約內、以及與 session-fork「丟掉」那條路的差異（那條路仍在丟，本任務不動它）。

- [ ] **Step 4: 跑它，看到綠**

Run: 該套件 test ＋ typecheck；既有 `shadowedSeqs`／`removedSeqs`／`messageSeqs` 的斷言全綠。

- [ ] **Step 5: 變異證明**

拿掉 `anchorSeq` 的映射 ⇒ 新測試紅。記錄實際編輯與 `sha256sum`。

- [ ] **Step 6: Commit**

```bash
git add packages/session-persistence/src/fork.ts packages/subagent/src/fork.ts packages/session-persistence/test/fork.test.ts
git commit -m "fix(session-persistence): a seeded rewind marker's anchor is remapped like every other seq reference (M76)"
```

---

### Task 4: 收尾（閘門＋報告）

**Files:** 無（只跑閘門與寫報告）

- [ ] **Step 1: `pnpm verify:all`**

Run: `pnpm verify:all`
Expected: 五步全綠（母體 67）。**`--gate` 不得新增 row**（本輪不新增 export）；若新增，**回報而不要加 allowlist**。
- **若 suite 紅在已量測的負載 flake**（`apps/cli` 的 M12 retry、`session-executor` 的 `shell-promotion W10`、`apps/cli` 的 headless W10）：隔離跑、**兩個讀數都記**。**跑閘門時不要同時跑 subagent。**

- [ ] **Step 2: 報告**（寫給控制器，不進 git）

每個任務各自的：紅先證據、GREEN、**每一條變異證明與其 sha 驗證**（含你實際用的那一行編輯）、被改動的既有斷言（**預期零條**）、以及**你量到的讀數**（Task 1 的兩張表、Task 2 的 warn 觸發／不觸發、Task 3 的映射結果）。

---

## 驗收（照 spec §2）

1. **走位掃描**：每一個被規則接受的切點都不孤兒化（dispatch 形狀）——Task 1 第 1 條。
2. **中止的 turn 不讓階梯退化**——Task 1 第 2 條。
3. **兩個站點不回歸**（既有測試全綠；`retainLast` 1..25 與抽樣預算的實測孤兒數要記錄）——Task 1 Step 4。
4. **非 ready 的解析不留 durable session**——Task 2 第 1 條。
5. **warn 只在那個條件上觸發**（兩邊都有測試）——Task 2 第 2、3 條。
6. **`anchorSeq` 落在子 log 的正確 index**——Task 3。
7. `pnpm verify:all` 五步全綠、`--gate` 無新增 row——Task 4。

## 殘餘（本階段**不做**，寫出來不是忘了）

- **既有的孤兒 `child-<uuid>` log 沒有遷移路徑**（只保證新的不再產生）。
- **切不動的單一巨塊**（M75 §4.4）：種子側只到「warn ＋ 繼續」；真正的解法是那一塊的**來源**（工具結果的上限）。
- **`tool/dispatch` 的 `eventSeq`**：不動、也不假設它的語意。
- **`forkTurns` 的預設 `"all"`**：產品決定。
- **session-fork 路徑仍在「丟掉」`rewind/point`**（孿生路徑的既有不一致；本階段只讓子代理那條**正確**，沒有去統一它們）。
- **M75 §5 的其餘殘餘**（prune／`attempts`／breaker／惰性路線）不在本單位。
