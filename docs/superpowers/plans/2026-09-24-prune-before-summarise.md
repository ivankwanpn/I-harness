# M78 — prune 在摘要之前 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `planPrune` 在摘要**之前**就跑完，但 `compaction/prune` 標記**在摘要成功之後**才附加（`compaction/index.ts:218`），而摘要器的 prefix 是從**日誌**折的 ⇒ **已經規劃好要省的 token，摘要器一份都沒省到**（而且那些 token 還算進 M75/M76 的 fit 判準）。本階段把標記**移到 prefix 之前**。

**Architecture:** 移動**附加的時機**，不動規劃、不動投影、不動 prune-only 那條路。**失敗時 prune 會留著**——這是刻意的（prune 安全、對下一次是淨賺、階梯本來就會重試），要有一條測試釘住並在 telemetry 發射點旁寫明。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-24-prune-before-summarise-design.md`（權威；§1.1 設計、§2 驗收）

## Global Constraints

- **紅先測試 ＋ 變異證明**：每一條修法都要先看到紅；實作後**把修法拿掉一次**、確認**具名的那條**測試變紅、再用 Edit 工具還原（**絕不**用 `git checkout --`），並以 `sha256sum` 確認位元組還原。
  - **突變是預測**：哪一行字面編輯能達到那個效果，**由你量測決定並記錄**——M72–M77 裡計畫的字面預測錯了十幾次，M75 有五個**字面值本身**是任何實作都過不了的。找不到能讓它紅的突變 ⇒ **那是發現，回報它**。
- **既有測試預期零條改動**。若有紅，**回報它**（M77 只改過一條，而且是具名的）。
- **`pruneRecords.length === 0` 時逐位元組不變**：請求、標記、順序都與今天相同。
- **不新增 export**；**不加 attribution trailer**；**不 amend**；blobs LF；檔案用 Write/Edit 工具寫。
- **不要動 `docs/`**。只跑 `packages/compaction`（與受影響的 `core-session`）的測試與 typecheck。**不要跑 `pnpm verify:all`**。

---

### Task 1: 把 prune 標記移到 prefix 之前

**Files:**（**執行期更正：真正的修法在 `core-session`，不是「移標記」——見 spec §1.1**）
- Modify: `packages/core-session/src/index.ts`（`deriveMessagesUpTo` 的 seq 濾網**對 `compaction/prune` 破例**＋ docstring 寫明例外與理由）
- Modify: `packages/compaction/src/index.ts`（標記仍移到 prefix 之前——那個改動本身**不足以**修好，但它是「失敗時 prune 留著」這條刻意行為的來源，而且讓附加處與摘要處的順序讀得懂）
- Test: `packages/compaction/test/prune.test.ts`（既有檔，加案例）＋ `packages/core-session/test/`（prefix 性質）

**Interfaces:**
- Consumes: 既有的 `planPrune`／`PruneRecord`／`derivePruneSubstitutes`（`core-session` 的前置掃描）
- Produces: 行為——**摘要器的 prefix 是 prune 過的**；**摘要失敗時 prune 留著**

- [ ] **Step 1: 寫紅測試（四條）**

1. **prefix 是 prune 過的**：一個舊工具輸出會被 `planPrune` 命中、但**不會**走 prune-only 的 session（`thresholdRatio` 讓 prune 後的量仍高於門檻，或 `allowPruneOnly === false`）⇒ 斷言摘要請求的 messages 裡**有取代文字**（`renderPruneSubstitute` 的產物）而**沒有原始輸出**。今天紅（帶著原始輸出）。
2. **失敗保留 prune**：讓摘要器 throw ⇒ 斷言 `compaction/prune` **在**、`compaction/summary` **不在**、`reason === "summarizer-failed"`。今天紅（什麼都沒有）。
3. **沒被命中時逐位元組不變**：`pruneRecords` 為空 ⇒ 請求與標記集合與今天完全相同（用既有的斷言形狀，量出來再寫）。
4. **紅利：prune 讓一個區域從「要切塊」變回「單一呼叫」**：構造一個**剛好**放不下、而 prune 之後放得下的區域 ⇒ 斷言**恰好一個**請求（M75/M76 的閘是關的）。這條是這個修法的價值說明，**它今天也紅**。

**既有 prune 測試（含 prune-only）必須全綠**——它們是對照組。

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/compaction test`
Expected: 第 1、2、4 條紅（量出來各自紅在哪裡並記錄）；第 3 條綠先。

- [ ] **Step 3: 實作**（**兩處，第二處才是有效的**）

**(a) `packages/core-session/src/index.ts` 的 `deriveMessagesUpTo`**：seq 濾網對 **`compaction/prune`** 破例（它必須被 prefix fold 看見）。註解寫明**為什麼它安全而 summary／reset 不安全**：prune 是**內容尋址**的（map 以工具呼叫為 key，取代文字是**那份舊輸出**的性質）⇒ 套到任何 fold 都對；`summary`／`reset` 是**時間尋址**的（它們的 seq 清單**指名一段區域**）⇒ **必須繼續服從**。docstring 也要改（它現在承諾「as of a PREFIX」，例外要寫出來，否則下一個人會讀成 bug）。

**(b) `packages/compaction/src/index.ts`**：標記仍移到 `:132` 的 `planPrune` 之後、`:160` 建 `prefix` 之前，**刪掉**原本 `:218` 的那一次。**其餘逐字不變**（`renderShadowed` 仍然收到它規劃的那份 records；prune-only 那條路不動；summary 的三個標記不動）。

在**發射 `failure` telemetry 的那一行旁邊**寫明：摘要失敗時 prune 已經附加、且不會撤銷，理由是 spec §1.1 的三條（prune 安全、對下一次是淨賺、階梯會重試），並指向釘住它的那條測試。

- [ ] **Step 4: 跑它，看到綠**

Run: 該套件 test ＋ typecheck。既有案例全綠（尤其是 `prune.test.ts` 與 prune-only 的案例）。

- [ ] **Step 5: 變異證明（兩條）**

(a) 把標記搬回摘要之後 ⇒ 第 1、4 條紅；(b) 在失敗路徑上想辦法「撤銷」prune（日誌是 append-only ⇒ **你做不到**；若你找到一個能做的方式，那**本身就是發現**，回報它）。記錄實際編輯與 `sha256sum`。

- [ ] **Step 6: Commit**

```bash
git add packages/compaction/src/index.ts packages/compaction/test/prune.test.ts
git commit -m "fix(compaction): the prune marker lands before the summarizer folds the log, so the tokens it plans to save are actually saved (M78)"
```

---

### Task 2: 收尾（閘門＋報告）

**Files:** 無（只跑閘門與寫報告）

- [ ] **Step 1: `pnpm verify:all`**

Expected: 五步全綠（母體 67）。**`--gate` 不新增列**（不新增 export）。
- **注意**：M77 之後 reachability 的**讀數是 432**（`@i-harness/llm-seam#RetryableErrorCode` 被合法消費、退了出來）。**432 是基準，不是 433。**
- **若 suite 紅在已量測的負載 flake**（`apps/cli` 的 M12 retry、`session-executor` 的 `shell-promotion W10`、`apps/cli` 的 headless W10）：隔離跑、**兩個讀數都記**。**跑閘門時不要同時跑 subagent。**

- [ ] **Step 2: 報告**（寫給控制器，不進 git）

紅先證據、GREEN、**每一條變異證明與其 sha 驗證**（含你實際用的那一行編輯）、被改動的既有斷言（**預期零條**）、以及**你量到的讀數**（摘要請求在修前／修後的 token 數，以及第 4 條那個區域修前的請求數）。

---

## 驗收（照 spec §2）

1. 摘要器的 prefix 是 prune 過的——Task 1 第 1 條。
2. prune-only 那條路不變——Task 1 Step 4（既有案例）。
3. 失敗仍然保留 prune——Task 1 第 2 條。
4. 沒被命中時逐位元組不變——Task 1 第 3 條。
5. 與 M75/M76 閘的互動（紅利）——Task 1 第 4 條。
6. `pnpm verify:all` 五步全綠、`--gate` 無新增列——Task 2。

## 殘餘（本階段**不做**，寫出來不是忘了）

- **平行預檢的 checkpoint**（spec §1.2）：候選，條件是儲存變遠端。
- **既有的 checkpoint 成本**（10 個並行呼叫 62 ms vs 16 ms）：**接受**，數字在 spec §0 與紀錄。
- **M70 §47 的另外兩個成本項**（flush 前綴而非只 flush 標記；batch-level 替代方案）不在本階段。
