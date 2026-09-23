# M75 — 超窗的摘要化要有路 Design

**一句話**：M74 量到的那個 regime——**surface 超過窗口時，「壓縮」實際上是 reset**（摘要器自己的請求也超窗 ⇒ provider 拒絕 ⇒ fail-soft ⇒ 階梯第 2 層把繼承來的 context 丟掉）——本階段給它一條路：**當那條單一請求放不下時，把區域切成幾塊、串連地摘要**，於是**摘要真的發生**，context 不被丟掉。

**來源**：M74 的紀錄 §3／§5（本樹自己的殘餘指名），加上 2026-09-23 的兩份偵察（種子端與引擎端，每一條都帶 `path:line`）。

**分級**：**L**（改變壓縮引擎的摘要路徑——那是**每一個 session** 在壓力下都會走的路），⇒ 完整 spec ＋ 計畫 ＋ 最終審查。

**這一輪的兩個前提修正（偵察推翻我原本的說法，如實記下）**：

1. **`prefix` 不是 M73 加的**，是 **M5/D2** 加的（`summarizer.ts:170-174` 的註解自己這麼說；`git log -S` 也只命中 `747bce1b feat(m5): the summarizer stops paying full price (D2)`）。**M73 加的是第 9 個參數 `limits`**（那個 cap）。
2. **子代理的窗口在「種子被建出來」的那一刻並不在 scope 裡**——種子在 `subagent/src/child.ts:264` 建、在 `:289`／`:294` 貼上，而宣告角色的 binding 要到 `await opts.resolveModel(declared)`（`:322`）之後才有窗口（`:328`）。⇒ **種子端的約束需要先重排**，那是**另一個單位**（§3 最後一條），不在本階段。

---

## 0. 它讓什麼變得不一樣（全部是量測，每一條都有 `path:line`）

| 事實 | 讀數 |
|---|---|
| **摘要器的輸入沒有任何上界** | `prefix.messages = deriveMessagesUpTo(session, lastShadowed)`（`compaction/index.ts:160`）＝**整個區域**；`retainTokens` 預設 **0**（`config.ts:110`）⇒ 區域＝**整份 session 減掉標記**（`region.ts:20-26`）。**這條路徑上沒有截斷、沒有分割、沒有任何守衛** |
| **它「有被計價、但從不被縮小」** | `summarizer.ts:215-232` 用 `estimateContent(messages) + overheadTokens` 夾 cap；當輸入**自己就佔滿窗口**時，`clampOutputCap` 走 `!(hardRoom >= 1)` 那條臂**原值回傳**（`llm-seam:462-463`） |
| **於是請求違法、而且不會被重試掩蓋** | provider 的規則是 `input + max_tokens > context` ⇒ 驗證錯誤（`llm-seam:413` 的註解逐字如此）；`CONTEXT_WINDOW_EXCEEDED` **不在** `DEFAULT_RETRYABLE_CODES`（`llm-seam:93`）⇒ `createRetryingClient`（`:173-235`）**不會**偷偷重送 |
| **失敗是 fail-soft，於是階梯接手** | `compaction/index.ts:197-207`：一行 warn ＋ `return { compacted:false, …, reason:"summarizer-failed" }`，**不附加任何事件**。接著 `enforceBudget` 的**第 1 層**再把**同一個**超窗請求跑一遍（`core-agent:231`），然後**第 2 層** `resetWindow`（`:236`，保留最後 20 個事件） |
| **結果是「context 被丟掉」而不是「被摘要」** | 量到的：`child.test.ts:1112-1172`——`status === "completed"`、被拒的都是摘要器請求（`:1156-1157`）、唯一被服務的是主要那條（cap `4242 → 1697`，`:1159`）、`compaction/reset` 的 `removedSeqs` 含繼承頭部的 seq（`:1165-1167`）、**`compaction/summary` 不存在**（`:1168`）、`INHERITED-HEAD-SENTINEL` 從 surface 消失（`:1171-1172`） |
| **那個 regime 與 session 無關** | `core-agent:283-290` 在**每一個** step 邊界跑；差別只在**頻率**——主要 session 一般是「一個大 turn 把它推過去」，而**子代理在第一次邊界之前就可以已經超窗**（種子在 spawn 時就貼上，`child.ts:289`） |
| **「80% 自動壓縮」已經存在** | `thresholdRatio` 預設 **0.8**（`config.ts:106`），`maybeCompact` 在每個 step 邊界、模型看到 surface 之前跑（`core-agent:283-285`）。**門檻不是問題**：門檻管「什麼時候試」，管不了「摘要器吃得下什麼」 |
| **prefix 快取只在第一塊還在** | 前綴比對從位置 0 開始；**Shape A**（每塊都 `deriveMessagesUpTo`）在算術上**不可能**修好這個 regime（整份放不下 ⇒ 某一塊也放不下）；**Shape B**（每塊只送自己那些訊息）才可能，而它的第 2..N 塊是**冷**的——因為本樹**不送任何 `cache_control`／`cachePoint`**（`docs/superpowers/specs/2026-09-18-prompt-cache-continuity-design.md:165`，全樹 grep 確認），整個性質靠 provider 的**自動**前綴比對 |
| **而那個代價在目標 regime 裡是零** | 今天那個請求**被拒**⇒ 快取性質在那裡**本來就值零**，而結果是一次**摧毀 context** 的 reset。用「N−1 次冷讀 ＋ 真的摘到」換「零快取、零摘要、context 被丟掉」是**嚴格改善**。危險只在**另一個** regime：若在單一請求本來放得下時也切塊，就是把一次熱讀換成 N−1 次冷讀 ⇒ **必須是 fallback** |
| **判準是免費的** | 夾取已經算出那個數（`summarizer.ts:230`）⇒「單一請求放不下」＝ `hardRoom < 1`，引擎當場就知道 |
| **附帶發現（同一段程式，獨立的小缺陷）** | prefix 路徑上**剛規劃好的 prune 替代品不會縮小摘要器的輸入**：`planPrune` 在 `:127`、`renderShadowed(..., pruneRecords)` 在 `:136`（只餵文字路徑），而 `compaction/prune` 標記**在摘要之後**才附加（`:208`），`deriveMessagesUpTo` 又是從 log 折的 ⇒ **摘要器重讀未 prune 的工具輸出**（`:127-136`、`:208`、`core-session:455-457/508/235-244`） |

**⇒ 這一輪不是「調門檻」，是給摘要器一條**吃得下**的路——而且只在它吃得下的時候才走單一那條。**

## 1. 設計

### 1.1 判準：**fallback**，不是預設路徑

單一請求先試。**只有當它放不下**（`estimateContent(messages) + overhead + margin ≥ window`，等價於 `clampOutputCap` 的 arm C）才切塊。

**這一條是整個設計的關鍵**：沒有它，每一次普通的自動壓縮都會從「一次熱讀」變成「N−1 次冷讀」，而且把失敗面乘 N。

### 1.2 形狀：**Shape B**（只送那一塊自己的訊息）

- 每塊的 `messages` ＝**那一塊的訊息**（不是 `deriveMessagesUpTo` 的前綴）＋ directive（永遠是最後一則 user 訊息）。
- **Shape A 不要做**：它在算術上不可能修好這個 regime（整份放不下 ⇒ 某一塊也放不下）。
- 切點必須**區塊對齊**（工具呼叫／結果成對）——重用既有的走位規則（`region.ts:34-46`、`index.ts:337-342`），**不要再寫第三份**；而且要落在 `user/message`／`turn/start` 上，讓每塊自己讀得懂。
- 定價用 `estimateContent`（per-message），**不要**用 `deriveSearchText`——後者對 `step/start`／`turn/end` 回空字串、還會剝掉工具結果的圖，**剛好低估了摘要器要付的那些訊息**（`core-session:632-669`、`:641-650`）。

### 1.3 串連：**chained**，不是 N 份獨立摘要

prompt 自己就寫著「merge the conversation ABOVE into the previous summary」（`summarizer.ts:28-29`）⇒ 第 k 塊要把**running text** 當 `previousSummary` 收下。第一塊用 FRESH **若且唯若**原本就沒有上一份摘要（`lastSummaryText` 沒有找到 ⇒ `:100` 的選擇自然成立）。

### 1.4 一次 pass、**一個**標記

- running text **只留在記憶體**，**中途不得附加任何 `compaction/summary`**：附加的標記會變成表面上的 user 訊息、改變 `activeTokens`，而且——決定性地——**改變 `deriveMessagesUpTo` 對後面每一塊的結果、破壞 §1.1／§0 的前綴同一性**；中途失敗還會留下一個沒有 `compaction/end` 的標記，而那些標記類別把它當成一次壓縮（`index.ts:413-420`、`region.ts:5-12`）。
- pass 結束時附加**一個** `compaction/summary`，`shadowedSeqs` 是**整個區域**（與今天逐字相同，`index.ts:210`）。

### 1.5 品質門檻的位置：**只在最後一塊**

`minSummaryChars`（預設 500）今天**每次呼叫**都強制（`summarizer.ts:242`）。切塊之後：

- **per-slice 強制是錯的**——一塊合法的 merge 可能很短（那一塊本來就沒什麼可併）；
- **只在最後一塊強制**＝對「session 真正會拿到的那份摘要」守門，而且不懲罰中間那些短而正確的合併。

⇒ **在最後一塊強制**，並把這個選擇的理由寫在註解裡。**代價明說**：一個「中途很混但最後剛好夠長」的鏈不會被抓到——那與今天「一次呼叫剛好夠長」是同一個盲區的形狀。

### 1.6 失敗與狀態：**一次 pass ＝ 一個結果**

- 切塊、定價、串連的簿記**必須在 fail-soft 的 `try` 裡面**（或是**全函式**的）：`renderShadowed` 今天就在外面，而程式碼自己為此留了警告（`index.ts:520-523`、`:543-546`）——一個會拋的切塊器會**逃出 `compact()`**。
- **不做部分進度**：第 j 塊失敗 ⇒ 丟掉整條鏈、回 `{ compacted:false, reason:"summarizer-failed" }`、**不附加任何事件**（與今天的原子性一致）。下一次重試是從 `lastSummaryText` 重來，**不是**從半條鏈。
- breaker／hysteresis／re-fire 的**代數不變**（N 次呼叫仍在同一個 `compactOnce` 裡 ⇒ 一次 pass 一個 outcome）。**變的是頻率**：一次 pass 現在有 N 個失敗機會 ⇒ breaker 會更早跳，而它分不出「模型不穩」與「最後一塊還是太大」。**記為已知。**
- `attempts`（telemetry 的 `compaction/attempt`）語意變成「含每塊重試的呼叫數」——**寫在事件旁邊**，否則那個數字會靜默地改變意義。

## 2. 驗收（每一條都要**紅先 ＋ 變異證明**）

1. **超窗的 session 真的被摘要**：一個 surface 超過窗口的 session（子代理與主要各一），在**會拒收超窗請求的 mock client** 下，**產生一份摘要**（有一個 `compaction/summary`），**不是** reset。（今天：`compaction/summary` 不存在。）
   - **兩個一半都要釘住，而它們是不同的形狀**（執行期的終審抓到的）：主要的那一半在 `packages/compaction/test/summarizer-prefix.test.ts`；**子代理那一半**在 `packages/subagent/test/child.test.ts`——一個**可切**的繼承區域（12 個小 turn）配一個會拒收超窗請求的 client ⇒ 一份 `compaction/summary`、沒有 `compaction/reset`。**既有的**那條單一巨型區塊的子代理案例**保持斷言 reset**：它是一個切塊器動不了的區塊，那是 §4.4 的殘餘，不是缺陷。
2. **普通情況不受影響**：surface 放得下時，**恰好一次**呼叫，而且那個請求與今天**逐位元組相同**（prefix 性質仍在）。
3. **串連**：第 2..N 塊的請求帶著 running summary（`<previous-summary>` 的內容＝前一塊的結果）。
4. **一個標記**：整個 pass 只有**一個** `compaction/summary`，`shadowedSeqs` 是**整個區域**；**中途沒有任何標記**出現在 log 裡。
5. **切點合法**：每一塊都不在工具區塊中間切（沒有一塊以孤兒 `tool/result` 開頭）。
6. **失敗仍然原子**：讓第 j 塊失敗 ⇒ 不附加任何事件、回 `reason: "summarizer-failed"`（與今天同形）。
7. `pnpm verify:all` 五步全綠、`--gate` 不得新增 row（本輪**不新增 export**）。

## 3. 刻意不做（YAGNI）

- **Shape A**（每塊都送前綴）：算術上不可能修好這個 regime（§1.2）。
- **部分進度**（中途把 running text 落成標記）：會改表面、破壞前綴同一性、並在中途失敗時留下沒有 `end` 的標記（§1.4）。
- **顯式 `cache_control`**：本樹今天完全不送（`prompt-cache-continuity-design.md:165`），那是**另一個**契約決定。
- **種子端的約束**（在 spawn 時就別把超過子代理窗口的東西交給它）——見 §5 第一條：那是**下一個單位**，而且它需要先把 `resolveModel` 挪到種子之前（順帶關掉一個孤兒 log 的洩漏）。
- **prune 在摘要之前**（§0 最後一列的附帶發現）：那是**獨立的成本缺陷**，記為候選，不在本階段的行為契約裡。

## 4. 它不保證什麼（明說）

1. **不保證摘要的品質**：N 次串連合併是「摘要的摘要」——四家先例研究把這件事列為已知的退化（`docs/research/2026-09-02-compact-fourway.md:122`）。本階段換到的是「有摘要」而不是「更好的摘要」。
2. **不保證便宜**：第 2..N 塊是**冷**讀（§0）。目標 regime 今天是零，所以仍是改善，但它不是免費的。
3. **不保證 breaker 的頻率不變**：一次 pass 有 N 個失敗機會（§1.6）。
4. **不保證那條路一定走得完**：最後一塊仍可能放不下（切塊器以區塊為單位，而一個單一巨大的工具結果就是一個區塊）——那時仍然 fail-soft 回 reset，**與今天相同**。這一條要具名。
5. **不保證每一條 session 都走得到**（執行期新增，因為它是**靜默**的）：這條 fallback 需要**四樣同時在**——`region`、`prefix`（request shape）、解析出來的 `maxOutputTokens`、以及 `contextWindow`（`summarizer.ts:302-313`）。因此**配置了 `summarizationModel`**、**引擎沒有 `requestShape`**、或**綁定解析不出 output cap**（`apps/cli/src/run.ts:536`）的路線，超窗時仍然是今天的 reset。這是**沿用 clamp 的前提**，不是本階段造的。
6. **不保證 gate 會在真的大到爆的時候開**：閘問的是**估計值**（`estimateContent`），而估計是 ~4 字元／token 的密度常數。一個 CJK 為主的區域在真實 tokenizer 眼裡可以是 ~1 字元／token ⇒ **它可能遠超窗口，而估計說放得下**，fallback 因此不開。同樣沿用 clamp，不是本階段造的。

## 5. 殘餘（寫出來，不是藏起來）

- **種子端的約束**（§3 最後一條）：`spawnChild` 是唯一同時握有（種子，窗口）的地方，而那對值裡**窗口在種子被建出來時還不在 scope**（§開頭第 2 條）⇒ 修法要先重排 `resolveModel`，而那個重排**順帶關掉一個真的洩漏**：`coordinator.create`（`child.ts:274`）在模型能失敗（`:323`）**之前**就建了 durable child session ⇒ 一次 `resolveModel` 非 ready 會留下一個**孤兒 `child-<uuid>` log**（`child.ts:252-253` 的註解「a refused spawn leaves no child session behind」在那條路上是假的）。
- **prune 在摘要之前**（§0 最後一列）。
- **`rewind/point` 的 `anchorSeq`**（M74 的殘餘，未動）。
- **單一區塊就超窗**（§4.4）——切塊器救不了它，而真正的解法是那一塊的來源（工具結果的上限）。
- **`attempts` 的語意改變**（§1.6）。
- **breaker 分不出「不穩」與「太大」**（§1.6）。
- **切塊的粒度由 session 的 user-message 結構決定**（執行期量到）：每一塊必須以 `user` 訊息開頭（provider 的規則），因此**一個 user turn 內的訊息不能再切**；一個孤立就超預算的塊仍然走呼叫端的 fail-soft。另外，若區域的 fold 因為先前的 rewrite 而隱掉了它的第一則 user 訊息，**第一塊就會以 `assistant` 開頭**——那與今天單一呼叫會送出的東西**逐位元組相同**；而**一個宣告了卻在 fold 裡從未解析的工具呼叫**會讓每個切點都被拒（§1.5 的守衛），那個尾巴於是變成一塊。
- **一個既有的漏洞，本階段量到但沒有修**（終審的讀數，指名為獨立的後續單位）：`walkOffToolEvents` 的走位在**任何非工具事件**上停下，而 `tool/dispatch`（永遠落在一個工具執行裡面，`core-agent/src/execute-tool-calls.ts:249-253`）會讓它提前結束 ⇒ 兩個既有的呼叫點（`region.ts:67` 的 `selectShadowableRange`、`index.ts:344` 的 `resetWindowOnce`）仍會**孤兒化 `tool/result`**。量到的：日誌順序 `call → result` ⇒ 63 個切點裡 8 個孤兒、走位後 **0**；`call → dispatch → result`（**M70 之後的實際順序**）⇒ 71 個裡 **16** 個孤兒、走位後**還是 16**。逐點：`resetWindowOnce` 的 `retainLast` 1..25 有 6 個值孤兒化（`[4,5,13,14,22,23]`），`selectShadowableRange` 抽樣的 162 個預算裡有 48 個。**M70 的 dispatch 標記讓這個守衛靜默失效，而它的註解還宣稱有效。** 修法就是把切塊器已經在用的 message-space 規則套到那兩個點上（或讓走位也跳過 `tool/dispatch`／`step/*`），加一條掃描切點的測試。**不屬於本階段的合約。**

## 6. 取樣與自創

| 部分 | 來源 |
|---|---|
| 「切塊只在放不下時」 | **本輪偵察的算術**（§0：Shape A 不可能、冷讀的代價、判準免費） |
| 串連（chained）的形狀 | **prompt 自己的字面**（`summarizer.ts:28-29`「merge the conversation ABOVE into the previous summary」） |
| 切點要區塊對齊 | **本樹已立的規則**（`region.ts:34-46`、`index.ts:337-342`）＋ M5/D2 的前綴同一性前提（`core-session:451-453`） |
| 「只在最後一塊守門」 | **自創的判斷**（per-slice 會懲罰短而正確的合併），並把它的盲區明說（§1.5） |
| 「不做部分進度」 | **沿用今天的原子性**（`index.ts:197-207`） |
| 品質退化的先例 | **本樹自己的研究**（`docs/research/2026-09-02-compact-fourway.md:122`） |
