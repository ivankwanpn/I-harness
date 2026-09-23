# M74 — 子代理的預算要撐得住 Design

**一句話**：M73 給了子代理一個**窗口**，於是它會在大約九成窗口處**硬失敗**（`prompt_too_long`）——而它**沒有 compactor**，所以那個預算是牆而不是預算。本階段給子代理自己的壓縮，並先修掉一個**今天就存在**的缺陷：`forkTurns` 把父的壓縮標記連同**父的 seq 號碼**交給子代理。

**來源**：M73 的紀錄 §4.1／§4.3（本樹自己的殘餘指名），加上 2026-09-23 的偵察（逐檔讀樹，每一條都帶 `path:line`）。

**分級**：**L**（改變別人依賴的介面：子代理的耐久 log 開始出現壓縮事件，而那份 log 是**同一個 store 裡的一個普通 session**——`sessions list`／`session-query` 的 FTS／冷啟的鏡像重建都讀它；`forkTurns` 的輸出契約也從「逐字複製」變成「重映射」）⇒ 完整 spec ＋ 計畫 ＋ 最終審查。

---

## 0. 它讓什麼變得不一樣（全部是量測，每一條都有 `path:line`）

| 事實 | 讀數 |
|---|---|
| **子代理沒有壓縮，所以它的預算只有第三層** | compactor 只從 `deps.compact` 建（`core-agent:185-201`）；階梯的第 1、2 層都要它（`:230-238`）⇒ 子代理只有第 3 層 `throw prompt_too_long`。子代理的預算是 `contextWindow * 0.9`（`core-agent:31`），而壓縮的壓力門檻是 `0.8`（`config.ts:106`）——**兩者之間正好是 10% 的餘裕**，而今天沒有人用它 |
| **子代理的**兩個**建構點** | `child.ts:346-390`（spawn）與 `tools.ts:683-700`（rebuild）。兩者的 deps 都沒有 `compact` |
| **`forkTurns` 是 12 行的 raw slice** | `subagent/src/fork.ts` 全文只有一個 `slice`／`return events`；唯一呼叫者是 `child.ts:264`，結果在兩個臂都**逐字 append**（`child.ts:289`／`:294`） |
| **父的壓縮標記會帶著父的座標過去** | `append` 只重寫事件自己的 `seq`（`core-session:353`），**不動** `shadowedSeqs`／`removedSeqs` 裡引用的索引 ⇒ `"all"` 時索引剛好重合（切片就是整份），`forkTurns: N` 時它們指向**子代理座標裡完全不同的那些事件** ⇒ **無聲藏掉內容** |
| **孿生實作早就解了同一題** | `session-persistence/src/fork.ts:148-174`：保留壓縮標記（`:121-131` 明文裁定「即使在 rewind 窗口內也要留著」）、並用 `remapSeedEvent`（`:164-174`）把引用重映射到新 session 的座標；`forkTurns` **沒有這一段** |
| **而沒有測試蓋它** | 全樹沒有任何 `forkTurns` 案例用**帶壓縮標記**的父 log（`child.test.ts:23-33` 用的是乾淨的 turn） |
| **沒有任何 derive 假設壓縮只發生在頂層** | `deriveMessages`／`activeTokens`／`deriveProjectionRewrite`／`derivePruneSubstitutes`／`rewindCuts` 都是 `session.events` ＋ `header.seedLength` 的純函式；全樹 grep 找不到把 `origin`／`delegationDepth`／`parentSession` 與壓縮放在一起讀的地方 |
| **引擎需要的東西，子代理手上幾乎都有** | `model`（`child.ts:305`）、`config` 的所有輸入（窗口 `:314-315`、overhead `estimateChildOverhead` `:70-72`）、`maxOutputTokens`（M73 已傳）——**`requestShape` 甚至是免費的**：core-agent 自己用 `deps.systemPrompt` ＋ `deps.tools.schemas()` 建它（`:189-193`）⇒ 子代理的引擎自動拿到**子代理自己的** prefix |
| **而 `profile`／`modelId`／`provider`／`telemetry` 到不了子代理——但主要 session 的引擎也沒有** | core-agent 只傳 `model`／`config`／`maxOutputTokens?`／`requestShape`（`:185-201`）；全樹 `createCompactionEngine(` 只有兩個命中（定義與那一個呼叫）⇒ **這是對等的，不是缺口** |
| **子代理會把繼承來的摘要當成自己的** | `lastSummaryText` 掃**整份** log（`compaction/src/index.ts:547-556`，用在 `:167`）並注入成 `<previous-summary>`；而 `deriveMessages` 會把繼承的摘要渲染成一個 `user` 訊息（`core-session:561-563`）⇒ 子代理的第一次壓縮會「更新」一份關於**父的歷史**的摘要 |
| **`AgentConfig.compact` 的窗口是必填，而且會 throw** | `config.ts:103-105`（非正數 ⇒ 建構時拋）⇒ 子代理必須**只在窗口解析出來時**才寫那個鍵（M73 對 `budget` 的同一條紀律） |
| **`auto: false` 對子代理是**空的**表面** | `Agent.compact` 唯一的可達路徑是 `SessionAssembly.compactNow`（`assembly.ts:1366`，CLI `run.ts:803`）——子代理**沒有任何 handle** 到它 |
| **M73 那條測試斷言的正是這次要改的契約** | `child.test.ts:877-909`：`expect(parentClient.requests).toHaveLength(0)`（`:908`）＋ `/prompt_too_long/`；它的註解（`:877-885`）說「no compactor」 |
| **一份子代理的 log 是一個普通的 session** | `coordinator.create` 在 jsonl backend 寫 `<storeRoot>/child-<uuid>.jsonl`（`session-persistence:450-474`）；它被 `coordinator.list()` 列出、被 session-query 索引、被 CLI `sessions list`／`show --json` 讀 |
| **誰讀子代理的 log** | 冷啟的鏡像重建（`subagent/src/index.ts:271-291` 的 `loadOwned`）、任務復原分類（`task-protocol.ts:350-363`，以 `seedLength` 切）、agent-team 的耐久探測（`scheduler.ts:519-539`）、CLI `sessions.ts:77-114`／`:160-188`／`:227-229`、session-query 的 FTS。**父的 task projection 與 stale 段落從不讀 events**（`projection.ts`、`section.ts:34-64` 只讀欄位） |
| **一個要刻意決定的邊角** | `driveFollowups` 的 inbox 游標讀的是**原始** `subagent/inbox` 事件（`tools.ts:750-753`）⇒ 一個 `compaction/reset` 會讓某則 inbox 訊息對**模型**不可見、但仍算「已消費」 |

**⇒ 這一輪不是「加一個鍵」，是把「預算要能撐得住」補完，並把它**踩到的**那個既有缺陷先修掉。**

## 1. 設計

### 1.1 `forkTurns` 的重映射（前置，先做）

`forkTurns` 在切片之後要**把壓縮標記的引用重映射到子代理的座標**——被切掉的事件不再被引用。

**用同一份實作，而那件事已經量過**：`session-persistence/src/fork.ts` 的 `remapSeedEvent`（`:164-174`）**正是**這個函式——簽名 `(event, index, renumbered: ReadonlyMap<number, number>)`，它把事件重編號到子 session 的座標、重映射 `compaction/summary` 的 `shadowedSeqs`／`compaction/reset` 的 `removedSeqs`／`session/title` 的 `messageSeqs`，而**指向已被切掉區域的引用會消失**（`:165-169` 的 `flatMap`）——那正是 `forkTurns: N` 需要的事。

**它未匯出**（`:164` 是 `function`，不是 `export function`）⇒ 本階段要**匯出它**（連同從 `session-persistence` 的 index 轉出，因為 subagent 走 package root），這**不是新能力、是新能見度**：它已經有第二個消費者（`completedTurnPrefix` 在 `:158` 用它），而本階段給它第三個。**不要在 subagent 再寫一份**——本專案的「一條規則只落一處」在 M73 已經吃過一次同類的裁決（M73-P1）。

`forkTurns` 因此變成：切片 → 建 `renumbered`（父 seq → 子 index）→ `map(remapSeedEvent)`。**契約的改變要寫明**：它的輸出從「父事件的逐字切片」變成「**子代理座標下的**種子」——這是它的呼叫者（`child.ts:289`／`:294`）本來就需要、而今天沒有拿到的東西。

### 1.2 兩個建構點各加一個 `compact` 鍵

沿用 M73 對 `budget` 的同一條紀律（**兩處都要、同一個形狀、同一個來源**；「只出現在第一次 spawn 的預算會在每次 resume 時消失」）：

```ts
    ...(contextWindow !== undefined
      ? { compact: { contextWindow, ...(overheadTokens !== undefined ? { overheadTokens } : {}) } }
      : {}),
```

- 其餘走 `CompactionConfig` 的預設（`thresholdRatio 0.8`、`retainTokens 0`、`maxTokens 1024`、`minSummaryChars 500`、`prune` 開）。**`auto` 不寫**：`deps.compact?.auto ?? true`（`core-agent:202`）已經是 true，而明寫它會製造一個「看起來可以關」的旋鈕——關掉對子代理是**空的表面**（§0 第 11 列）。
- **沒有任何新的穿線**：`requestShape` 由 core-agent 自己從子代理的 prompt／tools 建（§0 第 8 列）、`maxOutputTokens` 在 M73 已經傳了。
- 這一條同時讓**階梯的第 1、2 層**對子代理活起來（那是 M73 刻意留給這個單位的洞）。

### 1.3 seed 可壓——以及**兩份摘要**那條必須守住的性質

子代理的整份 log（含繼承來的 seed）都是它的 context ⇒ 它可以壓縮它。這是唯一能救「從一個接近窗口的父session spawn 出來」的版本。

**必須守住的性質**：子代理的衍生 surface 上**永遠不會同時出現兩份摘要**。繼承的 `compaction/summary` 是一份普通的事件（`deriveMessages` 會渲染它），所以子代理的新 summary **必須把它 shadow 掉**——否則模型會同時看到兩份（一份描述父的歷史、一份描述子代理的）。這一條要有**測試**，而 region 的選擇是否自然涵蓋它**要量**（`retainTokens: 0` 的預設讓它應該涵蓋；量了才算）。

### 1.4 `forkTurns` 的**預設值**不動

`"all"` 讓子代理的第一個請求就是父的整份逐字稿——那是**產品決定**（它決定子代理「看得到什麼」），不在本單位。本單位只保證：**不管種子多大，子代理撐得住**（§1.3）。

### 1.5 那條 inbox 游標的邊角，刻意寫下來

`compaction/reset` 會讓一則 inbox 訊息對模型不可見、卻仍算已消費（§0 最後一列）。**本單位不改它**，理由是：那是 `resetWindow` 語意的一部分，而 `resetWindow` 只在第 1 層壓縮之後仍超預算時才跑；把它改成「不 shadow inbox 事件」會讓壓縮在最有需要的時候失效。⇒ 列為殘餘，不是缺陷。

### 1.6 M73 那條 fail-closed 測試要改，而且是具名的

`child.test.ts:877-909` 斷言 `parentClient.requests` 是**空的**。有了 compactor，引擎會在 `enforceBudget` **之前**跑 `maybeCompact`（`core-agent:285` 先於 `:290`）⇒ 會有一次**摘要器**請求。

改成斷言**它要斷言的事**：仍然是 fail-closed（`prompt_too_long`），而**唯一**發生的請求是**摘要器那一次**（不是那條超窗的主要請求）。**不放寬**：它從「零個請求」變成「一個請求、而且可證明是摘要器的」——後者更精確。它的註解（`:877-885`）同步改成真的事實。

## 2. 驗收（每一條都要**紅先 ＋ 變異證明**：把修法拿掉 ⇒ 對應測試紅）

1. **`forkTurns: N` 帶著壓縮標記的父 log** ⇒ 子代理的標記引用落在**子代理座標**，而且**沒有任何內容無聲消失**（今天會）。
2. **超壓的子代理壓縮後繼續**：一條真的超過壓力門檻的子代理 session，做出一次摘要器呼叫並**繼續跑完**，而不是 `prompt_too_long`。
3. **子代理的摘要請求帶的是它自己的 prefix**：`systemPrompt`／`tools` 等於該子代理的 composed prompt 與工具 schemas。
4. **不會有兩份摘要**：壓縮過的子代理，它衍生的 surface 上只有一份 `compaction/summary` 的內容。
5. **重建的路徑也一樣**：`resume_agent` 重建出來的子代理同樣有 compactor（形狀與 spawn 一致）。
6. **缺席即缺席**：沒有解析出窗口 ⇒ deps 裡**沒有** `compact` 鍵（不得注入預設）。
7. **M73 的 fail-closed 契約不被放寬**：那條測試改成「一個請求、且它是摘要器的」。
8. `pnpm verify:all` 五步全綠、`--gate` 不得新增 row。

## 3. 刻意不做（YAGNI）

- **子代理的 telemetry**：`compaction/attempt` 對子代理仍不可見——但**主要 session 的引擎今天也沒收到 telemetry**（core-agent 不傳它）⇒ 那是既存的對等缺口，不是本單位造成的。
- **子代理的 `modelPolicies`／catalog 窗口**：同上，主要 session 的引擎也沒有（`profile`／`modelId`／`provider` 都沒傳）。
- **`forkTurns` 的預設值**（§1.4）。
- **子代理的壓縮門檻客製化**（沒有 host 介面；走預設）。
- **`auto: false` 的表面**：對子代理是空的（§0 第 11 列）。

## 4. 它不保證什麼（明說）

1. **不保證子代理一定跑得完**：壓縮是**盡力**的（fail-soft，一次摘要失敗不會炸掉 turn），而一個大到連壓縮都救不回來的種子仍會硬失敗。
2. **不保證便宜**：子代理會為**繼承來的**歷史付一次摘要呼叫（§1.3 的選擇）。那本來就是它燒掉的 token，但它是**新增的一筆**成本。
3. **不保證父的視圖不變**：子代理的 log 是同一個 store 裡的普通 session ⇒ 它的 `updatedAt`（`sessions list` 的排序）、它的 FTS 內容、`sessions show --json` 的事件都會變。**父的 task projection 與 stale 段落不受影響**（它們不讀 events）。

## 5. 殘餘（寫出來，不是藏起來）

- **inbox 游標的邊角**（§1.5）。
- **子代理的 telemetry**（§3 第一條）。
- **子代理的 `modelPolicies`／catalog**（§3 第二條）。
- **`forkTurns` 的預設值**（§3 第三條）。
- **`forkTurns` 在**非耐久**臂的 seq 混用**：非耐久臂用 `events.push` 播種（保留**父的** seq），而之後的 `append` 重新編號——那份混用不會被任何耐久讀者看到，但它是同一個函式家族的另一個未爆彈。**本單位不動它**，記下來。

## 6. 取樣與自創

| 部分 | 來源 |
|---|---|
| `forkTurns` 的重映射 | **本樹自己的孿生實作**（`session-persistence/src/fork.ts:148-174`）——同一題的既有答案，本單位把它接到另一個呼叫者 |
| 子代理的 compactor 形狀 | **沿用 M73 對 `budget` 的紀律**（兩處同形、同源、缺席即缺席） |
| seed 可壓 | **使用者 2026-09-23 的選擇**（相對於「只壓自己的事件」）：整份 log 都是它的 context，而那是唯一能救 spawn 就超窗的版本 |
| 「兩份摘要」的性質 | **本輪偵察**（`lastSummaryText` 掃整份 log ＋ `deriveMessages` 渲染繼承的摘要 ⇒ 兩個站點合起來會讓模型看到兩份） |
| 「不做 telemetry／policies」的判斷 | **本輪量到的對等**：主要 session 的引擎今天也沒有它們 |
