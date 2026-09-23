# M74（子代理的預算要撐得住）交付紀錄

**一句話**：M73 給子代理一個**窗口**，於是它會在大約九成窗口處**硬失敗**——而它沒有 compactor，所以那是牆不是預算。M74 給它自己的壓縮，並先修掉一個**今天就存在**的缺陷：`forkTurns` 把父的壓縮標記連同**父的 seq 號碼**交給子代理。

- **分支**：`m74`（`8f18763` → 終態，**16 個 commit**；合併尚未進行）
- **spec（權威）**：`docs/superpowers/specs/2026-09-23-child-budget-compaction-design.md`（`0d3e86e`，**終審後更正於 `3cee6899`**）
- **計畫**：`docs/superpowers/plans/2026-09-23-child-budget-compaction.md`（`ab29f4e` ＋ 四次修正）
- **執行**：subagent-driven development——4 個實作任務 → 逐任務複審 → 四次 fix round → 終審（opus，15 commits）→ **單一 fix wave** → 限定複審 → 控制器修正兩個文件殘餘

> 這份紀錄原本以 `…-partial.md` 存在（使用者下班前要求停止並推 GitHub）；`git mv` 成現在的名字，內容改寫為完整的版本。

---

## 1. 閘門與算術

**`pnpm verify:all` 在最終樹上 PASSED**：

| 步驟 | 讀數 |
|---|---|
| suite | exit 0 · **3056 passed｜9 skipped｜0 failed** |
| population | **67 of 67** |
| typecheck | exit 0 |
| e2e | exit 0 · 5 檔 |
| reachability | exit 0 · **433 列** · `gate PASS -- no new rows` |

**算術**：M73 結尾 **3047** ＋ **10** 個新案例 ＝ **3056**。（中途讀數 3055 是 fix wave 之前。）**reachability 與 M73 相同（433）**——本階段唯一的新匯出 `remapSeedEvent` 有一個消費者 ⇒ 不新增未消費的列，計畫的預測成立。

**整個分支的測試檔刪除只有 11 行**，全在 `child.test.ts`：第 3 行的 import，以及那條被**轉換**的案例（`it.fails` → `it`，見 §3）。⇒ **沒有任何既有斷言被放寬。**

---

## 2. 兩個交付物

### 2.1 `forkTurns` 的重映射（前置，也是一個獨立缺陷）

`forkTurns` 是 **12 行的 raw slice**，把父的事件**逐字**交給子代理。而 `append` **只重寫事件自己的 `seq`，不動它「指名」的那些 seq** ⇒ 父的 `shadowedSeqs`／`removedSeqs` 帶著**父的座標**進到一個從 0 開始的 log。`"all"` 時索引剛好重合（無害）；`forkTurns: N` 時切片從後面的 `turn/start` 開始，那些引用指向**別的事件**——**包含它自己**——而**沒有任何測試在蓋它**。

修法：把 `session-persistence` **既有的** `remapSeedEvent` 匯出（它一直在解同一題，只是沒匯出），並讓 `forkTurns` 的**三個 return 路徑都**經過它。切片的邏輯**逐字不動**（搬進 `sliceTurns`）。

### 2.2 子代理自己的 compactor

**兩個建構點各一個鍵**（`child.ts` spawn、`tools.ts` rebuild），形狀與來源完全相同、缺席即缺席：

```ts
...(contextWindow !== undefined
  ? { compact: { contextWindow, ...(overheadTokens !== undefined ? { overheadTokens } : {}) } }
  : {}),
```

**沒有新的穿線**——因為 M73 已經把值都算出來了：`requestShape` 由 core-agent 自己從子代理的 prompt／tools 建（⇒ 摘要請求是**子代理自己請求的 byte-prefix**），`maxOutputTokens` M73 已傳。`auto` 不寫（已經是 true，而一個只能關的旋鈕對子代理是空的表面——`Agent.compact` 只經 `SessionAssembly.compactNow` 可達）。

**兩個站點是獨立見證的**：拿掉 spawn 的 spread ⇒ 只有 spawn 側的案例紅（`resume.test.ts` 27/27 全綠）；拿掉 rebuild 的 ⇒ 只有 rebuild 的那條紅。這條紀律源自 M73 的紀錄（「只出現在第一次 spawn 的預算會在每次 resume 時消失」）。

---

## 3. ⚠️ 這一輪最重要的那條：救援者是 reset，不是摘要

**它從一個「被推翻的 spec 要求」開始。** spec §1.3 原本要求「子代理的衍生 surface 上永遠不會同時出現兩份摘要」。T3 **量測推翻它**：`selectShadowableRange`（`compaction/src/region.ts:20-25` 與 `:52-55`）**兩條臂都跳過壓縮標記** ⇒ 新的 summary 蓋不掉舊的——而那是**與 session 無關**的引擎性質，**主要 session 第二次壓縮之後也一樣**，而且**引擎自己的測試早就釘住它**（`compaction/test/compaction.test.ts:79-88`、`:90-97`）、設計也寫在碼裡（`compaction/index.ts:162-166`「the anchored semantics are prompt-only」）。

⇒ **那個要求是控制器發明的**（`spec:64`，列在「本輪偵察」）。spec 就地更正，測試改成斷言**真實的、刻意的**行為，殺手是「拿掉 `region.ts:22` 的標記跳過」——**那是選項 (a) 產品變更的縮影**（若哪天要改引擎，這條測試會紅）。

**然後終審把同一件事推得更遠**：那條「兩份摘要」的情境只發生在**輸入放得下**的時候。當子代理的 surface **超過窗口**時：

1. 摘要器自己的請求**也超窗**（它從 `deriveMessagesUpTo(session, lastShadowed)` 建輸入——第一次壓縮就是**整份繼承來的 surface**——而且**從不縮小**；`clampOutputCap` 在輸入佔滿窗口時**原值回傳**）；
2. 真 provider 拒絕 ⇒ 壓縮 **fail-soft**；
3. 階梯第 2 層的 **reset** 接手（保留最後 20 個事件）。

⇒ **子代理確實繼續，但它是「丟掉繼承來的 context、沒有摘要」，不是「被摘要過」。** 用**會拒收超窗請求的 mock client** 量到的讀數：2 次摘要請求被拒（`input 3792 + max_tokens 4242 > context 2000`）、唯一被服務的是**主要**那條（4_242 夾成 1697）、`compaction/reset` 移除 seq 0..10、**沒有任何 `compaction/summary`**、繼承來的 head sentinel 從 surface 上消失。突變：**拿掉階梯的 reset 層 ⇒ 只有那條紅**（它是那個編輯的唯一捕手）。

**那個 regime 在主要 session 也存在**（`enforceBudget` 每個 step 邊界都跑）——**差別在頻率而不是有無**：主要 session 一般落在 0.8w–0.9w，而**子代理的 seed 在任何檢查之前就貼上去了**，所以它的**第一個** step 邊界可以任意超窗。

⇒ **殘餘（產品決定）**：分段摘要、或在 spawn 時修剪／警告種子。在那之前，「壓縮」在 context 最大的時候**正好不可用**，而對子代理那是**常態而非例外**。

---

## 4. 裁決（Rulings）— 逐條附代價

| # | 裁決 | 錯了會怎樣 |
|---|---|---|
| M74-P1 | **把 M73 那條 fail-closed 斷言的重寫從 T4 搬進 T2**——T2 就是讓它變紅的改動，而一個紅的 commit 不是可交付的單位 | T2 的 diff 含一個刻意的契約變更（複審一起判了它） |
| T1-fix1 | **補「map 的值側」案例**——`renumbered.set(seq, seq)`（鍵對、值用父 seq）能存活整個套件，而那正是本缺陷的另一半 | 一條案例 |
| T2-fix1 | **補 rebuild 站點的見證**——清空它的 spread 讓整個套件全綠 | 一條案例 |
| T3 | **把「兩份摘要」判成 spec 的錯**，案例改成斷言**真實**行為、殺手改成 `region.ts:22` 的產品變更縮影 | 若使用者要的是「只有一份摘要」，那是**跨全樹**的引擎決定，而這條測試會是它的紅先見證 |
| **終審後** | **兩個文件殘餘由控制器直接修，不開第二個 fix wave**（流程明文沒有第二個）——它們都是一行、都是「數字／比較說得比量到的多」這一類，而第二條是**我寫的** | 這兩處**沒有經過獨立複審**；所以它們在 ledger 與總結裡**具名**，可以被推翻 |
| （控制器） | 計畫的 fork fixture **不可能成立**（標記放在切片外）⇒ 修計畫 | 零（實作者量到並回報） |
| （控制器） | **多留一個 ` ``` ` 讓圍籬變奇數 ⇒ `task-brief` 對 Task 2 之後的每個任務都失敗**（症狀與病因距離很遠） | 零（`grep -c '^```'` 要是偶數） |

**累積的課（延續）**：計畫的突變預測又錯了數次（本階段實作者**六次**量到「計畫說的那個編輯殺不死它宣稱要殺的測試」）；而**複審抓到兩次「計畫漏了一整跳」**（在 M73 是兩次，這裡是 fork fixture 與 consumer 計數）。

---

## 5. 殘餘（本階段**不做**，逐條具名）

1. **超窗的摘要化**（§3）：surface 超過視窗時「壓縮」實際上是 reset。候選修法＝分段摘要或 spawn 時修剪／警告。
2. **`rewind/point` 的 `anchorSeq`** 沒有被重映射也沒有被丟掉（`session-persistence/src/fork.ts:179` 的 fallthrough 只改 `seq`）。終審量到方向是**少藏**（不是無聲丟內容）⇒ 比本階段修掉的輕，且**早於本階段**。孿生的 session-fork 路徑用**丟掉**來解（`:115-120`）⇒ 兩條路徑不一致。注意 `"all"` 那條路（在那裡標記目前是**正確**重現父的隱藏範圍）。
3. **已存在的子代理 log 沒有遷移路徑**：修法只作用在新 fork 出來的種子；M74 之前寫下的 `child-<uuid>.jsonl` 仍帶著父座標的引用。
4. **inbox 游標的邊角**：`compaction/reset` 會讓一則 inbox 訊息對模型不可見、卻仍算已消費。
5. **子代理的 telemetry 與 `modelPolicies`**：與主要 session 的引擎對等（core-agent 都不傳），非本階段造成。
6. **`forkTurns` 的預設值**（`"all"`）——產品決定：它決定子代理「看得到什麼」。
7. 幾條 comment 級的 Minor（`mainRequests` 的負向子字串分類、host 給 `0`/`NaN` 時錯誤訊息指向孿生的鍵、`overheadTokens` 對子代理不可觀察）——終審判「ship」。

---

## 6. 給下一個動這條鏈的人

- **兩個建構點必須同時被見證**：獨立突變（只拿掉 spawn／只拿掉 rebuild）是這個分支價值最高的測試紀律。
- **「缺席即缺席」在子代理上是三重閘**（`budget`、`compact` 共用同一個 `contextWindow !== undefined`，而 core-agent 會在 `compact` 之前先驗 `budget`）——一個壞的窗口不可能繞過驗證先到達 compactor。
- **`it.fails` 不是一個好裝置**：它把**任何** throw 都當成預期的失敗，所以一條 fixture 層的回歸與「已知缺口」無法區分。要留見證就留一條**紅的** `it`。
- **這一台機器的四個已知負載 flake**：`apps/cli` 的 M12 retry（已修在 PR #7）、`session-executor` 的 `shell-promotion W10`、`apps/cli` 的 headless W10 promotion。**跑閘門時不要同時跑 subagent。**
- **`task-brief` 說找不到某個任務時，先數 `grep -c '^```'`**——一個多出來的圍籬會讓它對之後的每個任務都失敗。
