# M73 — 每一條離開行程的請求都帶著自己的預算 Design

**一句話**：讓 provider 請求的**預算**（輸出上限與 context 窗口）在**每一條**出口都成立——今天有兩條出口完全沒有它：**子代理的 agent deps**（兩個建構點）與 **compaction 的摘要請求**。

**來源**：本樹自己的紀錄指名了這兩條（M72 階段 Ⅱ §5.5「值鏈的完整性只對主要 session 成立」、階段 Ⅲ §4.2「compaction 的候選修法」），加上 **2026-09-23 的兩份偵察**（兩個並行 subagent 逐檔讀樹，每一條斷言都帶 `path:line`）。

**分級**：**L**（改變別人依賴的介面：`RoleModelState`／`RoleModelResolution` 的 ready arm、`SpawnOptions`／`SubagentToolDeps` 的新欄位，而 `AgentDeps.maxOutputTokens`／`AgentDeps.budget` 第一次有了子代理消費者）⇒ 完整 spec ＋ 計畫 ＋ 最終審查。

---

## 0. 它讓什麼變得不一樣（全部是量測，每一條都有 `path:line`）

| 事實 | 讀數 |
|---|---|
| **子代理的 agent 只有一個界：步數** | 全樹只有**四個** `createAgent(` 呼叫點（工廠、`assembly.ts:1235`、`child.ts:290`、`tools.ts:657`）。子代理那兩個的 deps 物件**沒有** `budget`／`compact`／`maxOutputTokens`／`telemetry`／`maxTurns` ⇒ `maxTurns` 走預設 **20**（`core-agent/src/index.ts:150`） |
| **整個 package 沒有預算的概念** | `packages/subagent/src/` 的 `contextWindow`／`maxOutputTokens` **零命中**；`grep -i compaction packages/subagent` **零命中** |
| **型別在兩處窄化** | `subagent/src/child.ts:179-182` 與 **`session-executor/src/assembly.ts:100-103`**——兩者都把 ready arm 寫成 `{ client, reasoningEffort? }`（第二處不在任何既有紀錄裡） |
| **但值在 runtime 還在** | `provider-runtime` 的 `SessionModelBinding`（`:66-76`）帶 `contextWindow?`／`maxOutputTokens?`，而 `apps/cli/src/provider-runtime.ts:19-23` **原物件回傳**；TS 結構型別**不會刪屬性** ⇒ 在「role 宣告了模型」那條路上，兩個數字**就在被丟掉的那個物件上**——丟掉它的是**型別**（編譯期）與**讀取點**（`child.ts:284-285`、孿生 `tools.ts:633-634`） |
| **繼承那條路是真的沒有** | `child.ts:268`：沒有宣告時只拿 `opts.parentModel`（assembly 的身份穩定 handle，`assembly.ts:427-445`）；兩個數字在 `run.ts:636-637`／`service.ts:362-363` 交進 assembly 就**停在那裡**，`registerSubagent`（`assembly.ts:1057-1083`）和 `SpawnOptions`（`child.ts:184-212`）都沒有欄位 |
| **子代理不壓縮、不量、不檢查預算** | compactor 只從 `deps.compact` 建（`core-agent:185-194`）；壓力檢查有 guard（`:278`）；預算階梯早退（`:215-216`）；`token/usage` 需要 `deps.telemetry`（`:483-486`）⇒ metrics sink（`telemetry/src/metrics.ts:59-91`）**看不到子代理的 token**；`get_context_remaining` 只對主 session 註冊（`assembly.ts:825`） |
| **階梯給子代理的只有第三層** | `enforceBudget`（`core-agent:215-234`）：①壓縮（要有 compactor）②reset（**也要**有 compactor）③`throw prompt_too_long`。子代理沒有前兩層 ⇒ **給了窗口就是硬失敗** |
| **「超過窗口」不是罕見情境** | `forkTurns` 預設 **`"all"`**（`child.ts:226-227`、`fork.ts:3-12`）⇒ 子代理的**第一個請求就是父的整份逐字稿** |
| **rebuild 路徑還有第二個缺陷** | `tools.ts:659` 傳 `systemPrompt: role.systemPrompt`，而 spawn 傳 `composeSubagentPrompt(role.systemPrompt)`（`child.ts:297`；組成在 `child.ts:33-51`）。`composeSubagentPrompt` 全樹**只有一個呼叫點** ⇒ **重建的子代理掉掉 `SUBAGENT_PROMPT_CONTRACT`**，而 `child.ts:296` 的註解說「每個 child agent 都會附加」。spawn 那條有測試（`subagent/test/child.test.ts:370-376`），**rebuild 那條沒有** |
| **摘要請求連一元預算都沒有** | `compaction/src/summarizer.ts:181-184` 的三個 `LLMRequest` 字面只有 `messages`／`tools`／`systemPrompt`；`packages/compaction/` 全包 `maxOutputTokens` **零命中**（含測試） |
| **`CompactionConfig.maxTokens` 不是上限** | 它唯一的用途是事後切片：`summarizer.ts:196` `approxTokens(trimmed) > maxTokens ? trimToTokens(trimmed, maxTokens) : trimmed`，而 `trimToTokens` = `text.slice(0, maxTokens * 4)`（`:144-146`）。所以 `config.ts:39-41` 的「caps the output at ~4096 chars」講的是**切片**，不是模型被叫停——模型可以吐任意長（照價計費），而切片是**無聲**的 |
| **窗口在壓縮引擎手上，cap 不在** | 窗口：`compaction/src/index.ts:77` 解析，呼叫點 `:159` **同一個 scope**（前綴模式有 `prefix.messages` 可估）。cap：只活在 assembly／`core-agent:91` 的 deps，**沒有往 compaction 傳**（`core-agent:185-194` 只傳 `model`／`config`／`requestShape`）。`clampOutputCap` 與 `OUTPUT_CAP_SAFETY_MARGIN` 在 `llm-seam:453-466`／`:419`，而 compaction **已經依賴 llm-seam**（`summarizer.ts:1`） |
| **摘要失敗在使用者眼裡等於「沒東西可壓」** | 400 ⇒ `summarizer.ts:188` rethrow ⇒ `compaction/src/index.ts:162-172` **吞掉**、`warn`、`compacted:false`；而 CLI 對**任何** `compacted:false` 回 `"No compactable history yet."`（`apps/cli/src/run.ts:101-102`） |
| **被丟掉的那個值是真的** | M72 Ⅲ 之後 anthropic 的 fallback **會解析進 binding**（`provider-runtime/src/index.ts:675-676`）⇒ 對一個宣告了 anthropic model 的 role，`child.ts:285` 丟掉的是**一個真數字**，而子代理的請求到轉接器時沒有任何 cap（`llm-anthropic/src/index.ts:157-159`，request → route `options.max_tokens` → 常數）⇒ **階段 Ⅱ 的 I1 形狀，多了一條可達路徑** |

**⇒ 這一輪不是「補兩個欄位」，是把「請求帶得住自己的預算」這條契約補到它真正該有的每一條出口。**

## 1. 設計

### 1.1 子代理的 binding 不再被窄化

把**兩處** ready arm 從 `{ client, reasoningEffort? }` 補成真正的 binding 形狀（`contextWindow?`／`maxOutputTokens?`）。這不是新增解析：在 declared-role 那條路上值本來就在物件上（§0 第 4 列），改的是**型別**與**兩個讀取點**。

### 1.2 兩個建構點：把數字交進 deps

`child.ts:290-316`（spawn）與 `tools.ts:657-667`（resume／rebuild）各加兩個 spread：

- `maxOutputTokens` → `AgentDeps.maxOutputTokens`，由 `core-agent:304-312` 的既有夾取處理（它握有窗口與輸入估計）。
- `budget: { contextWindow, overheadTokens }` → 讓預算階梯與 `checkBudget` 對子代理生效。形狀以 `AgentBudgetConfig`（`core-agent:29-38`）為準：`contextWindow` 是**必填**，其餘可選。

**兩個建構點都要同時處理兩條來源**：role 宣告了模型 ⇒ binding 上的值（§1.1）；沒宣告 ⇒ §1.3 穿進來的 session 值。兩條路都不注入預設：**沒有值就不寫那個鍵**（M72 的「缺席即缺席」）。

`overheadTokens` 按**子代理真實的形狀**估（`composeSubagentPrompt(role.systemPrompt)` ＋ `childReg.schemas()`），不是抄主 session 的（主 session 的先例：`assembly.ts:355`、`:1200-1202`）。

### 1.3 繼承那條路：穿線

`AssemblyOptions.contextWindow`／`maxOutputTokens`（`assembly.ts:211`／`:217`）在 `registerSubagent`（`:1057-1083`）的呼叫點**就已經在 scope 裡** ⇒ 依序加可選欄位穿過 `registerSubagent → SubagentToolDeps → SpawnOptions`，再在 `child.ts` 的 inherit 分支用它。

**guardian 是特例，而且本設計對它的答案是「不傳」**：`guard-approval/src/guardian/reviewer.ts:149` 是 `deps.model ?? deps.parentModel`，而 `deps.model` 是 host 交給 `registerGuardian` 的一個**裸 `ModelClient`**（`assembly.ts:1129`）——那個站點**沒有任何 binding 可以解析**，所以「配置了模型的 guardian」的窗口與 cap **在結構上不可知**。⇒ 依「缺席即缺席」，**只在繼承臂傳**（`deps.model === undefined` 時才把 session 的數字往下給）；配置臂不傳，並列為殘餘（要修就得讓 host 連它的 binding 一起交進來）。**傳一個不是它的數字比不傳更糟**——那會讓預算階梯與夾取用一個錯的窗口去判斷。

### 1.4 窗口進來了 ⇒ 階梯第三層變成可達（**刻意的**）

子代理**沒有**壓縮層，所以超過窗口時它會 `throw prompt_too_long`（§0 第 7 列）。

**這是刻意的，寫出來**：今天子代理是**無聲**送出一條超窗請求（anthropic 400、其他家看情況），父session 拿到的是一句沒有上下文的 provider 錯誤。**大聲且可讀的失敗**換掉**無聲的失敗**，正是 M72 的主題。

**代價明說**：一個今天在 provider 容忍度下「勉強跑得動」的子代理（例如輸入恰好略過窗口而 provider 只截斷不回錯）會**變成明確失敗**。這是行為改變。

**觸發點是儲備比，不是牆**：`AgentBudgetConfig.reserveRatio` 預設 **0.9**（`core-agent:31`），而 `checkBudget` 的預算是 `contextWindow * reserveRatio`（`:220`）⇒ 子代理會在**窗口的九成**就進入階梯，那裡沒有第 1、2 層，於是直接 `prompt_too_long`。

### 1.5 rebuild 路徑的 prompt contract

`tools.ts:659` 改成與 spawn 相同的 `composeSubagentPrompt(role.systemPrompt)`，並補一條測試釘住**重建**的子代理也帶 contract（spawn 那條已有，rebuild 那條沒有）。

### 1.6 compaction 的摘要請求帶 cap，而且要被夾

- 把 `deps.maxOutputTokens` 從 `core-agent:185-194` 傳進 `createCompactionEngine`，再傳到 `compactOnce` 與 `summarizeWithModel`。
- 在**窗口已在手的那個位置**（`compaction/src/index.ts:77` 解析、`:159` 呼叫）用既有的 `clampOutputCap(value, contextWindow, estimatedInput)` 夾一次；`estimatedInput` 用前綴模式的 `estimateContent(prefix.messages)`（`token-meter` 已是 compaction 的依賴，`tokens.ts:2`），legacy 模式用 `approxTokens(buildSummaryPrompt(...))`。
- **`CompactionConfig.maxTokens` 不動、也不當 wire cap**：它是**字元**預算（1024 ≈ 4096 字元），而 `max_tokens` 是 **token** 上限；而且它現在的語意是**事後切片**，改成請求上限會產生「被切斷但仍然通過 `minSummaryChars` floor 檢查」的摘要——而下一輪的 anchored 摘要是建立在它上面的。兩者分開，並在兩邊的註解寫明。

### 1.7 摘要失敗要與「沒東西可壓」分得出來

`compaction/src/index.ts:162-172` 的 fail-soft **保留**（那是刻意的：一次摘要失敗不該炸掉整個 turn），但**結果要帶得出原因**。

**先看清楚 `false` 不只兩種**：今天 `{ compacted: false, shadowedSeqs: [] }` 至少出現在四個地方——`:109`（沒有可壓的區域）、**`:171`（摘要器失敗）**、以及 `:186`／`:215` 兩條引擎自己的早退。所以判別欄位的義務是**「摘要器失敗」要與其餘全部分得開**，不是只跟「沒東西可壓」分開。

**形狀**：`CompactionResult` 加一個可選的判別欄位（值域至少含 `summarizer-failed`），**缺席維持缺席**——今天那些不帶原因的呼叫點不改行為。CLI 的 `/compact` 照著分（`apps/cli/src/run.ts:101-102` 今天對**任何** `compacted:false` 都回 `"No compactable history yet."`）。

## 2. 驗收（每一條都要**紅先 ＋ 變異證明**：把修法拿掉 ⇒ 對應測試紅）

1. **子代理帶 cap**：一個宣告了模型的 role spawn 出來的子代理，它的 `AgentDeps.maxOutputTokens` 等於 binding 的值（今天沒有）。
2. **子代理帶窗口，且夾取真的發生**：同一個子代理的 `AgentDeps.budget.contextWindow` 等於 binding 的窗口；而**夾取**要有一條案例——窗口小、輸入大時，送出的 `maxOutputTokens` 是 `window − 輸入估計 − 4096` 而不是原值。
3. **繼承那條路也帶**：沒有宣告模型的 role ⇒ 子代理拿到的是**session 的**窗口與 cap（今天兩個都沒有）。
4. **rebuild 也帶**：`resume_agent`／inbox sweep 重建出來的 agent，deps 與 spawn 一致（含 §1.5 的 prompt contract）。
5. **摘要請求帶被夾過的 cap**：摘要請求的 `maxOutputTokens` 存在、且被窗口夾過。
6. **摘要失敗說得出自己是什麼**：一條案例讓摘要器失敗，斷言回傳值帶得出「摘要器失敗」（而不是與其他 `compacted:false` 同形），且 CLI 的 `/compact` 訊息與「沒東西可壓」不同。
7. **既有的「缺席即缺席」不被破壞**：沒有任何窗口／cap 時，子代理的 deps 仍然不帶那兩個鍵（不注入預設）。
8. `pnpm verify:all` 五步全綠、`--gate` 不得新增 row（本輪**不新增 export**）。

## 3. 刻意不做（YAGNI）

- **子代理自己的壓縮**：它會把 shadow 事件寫進子代理的耐久 log，而那份 log 鏡射到父的 coordinator ⇒ 改變的是「子代理的 log 長什麼樣」。那是一個**獨立的設計決定**，不混進預算這條。
- **子代理的 telemetry**：讓 metrics 看得到子代理的 token 是**回報面**的改變（誰付了多少），與「請求帶得住預算」是兩件事。
- **`forkTurns` 的預設值**（`"all"`）：它放大了問題，但改它會改變子代理**看得到什麼**——那是產品決定。
- **`CompactionConfig.maxTokens` 的語意重整**（§1.6 說明為什麼不）。
- **M72 留下的 response 側項目**：`response.incomplete` 仍丟 usage、compat 不讀 OpenAI 形狀的 cache 拼法——那是「**回應**的事實」，不是「請求的預算」。

## 4. 它不保證什麼（明說）

1. **不保證子代理一定能跑完**：給了窗口之後，一個真的超窗的子代理會**失敗**而不是**變慢**（§1.4）。那是刻意的，但它是行為改變。
2. **不保證摘要一定成功**：本輪只讓那條請求**合法**（帶得住它該帶的欄位）並讓失敗**看得見**；摘要器仍然可以因為其他原因失敗。
3. **不保證子代理的預算與主 session 同值**：宣告了自己的模型／route 的 role 拿到的是**那條 route 的**數字；guardian 亦然。這是對的（預算是 route 的事），但記錄要這樣寫。
4. **不保證 `overheadTokens` 精確**：它是估計（system prompt ＋ tool schemas），與主 session 一樣是估計。

## 5. 殘餘（寫出來，不是藏起來）

- **子代理的壓縮**（§3 第一條）——沒有它，「子代理在長任務上自己救自己」不存在。
- **子代理的 telemetry**：metrics sink 今天看不到子代理的 token。
- **`forkTurns` 的預設**讓子代理的第一個請求可能從一開始就超過窗口，而它**沒有壓縮可以救**。
- **guardian 的窗口來源**若其實作與 `deps.model ?? deps.parentModel` 不同（例如 plugin 提供的 guardian），要再確認一次。
- **`get_context_remaining` 對子代理不可用**（它綁在主 session 上）；若哪天把角色工具清單放寬到它，子代理會被餵**父的**窗口與用量（`child.ts:72-91` 按名字複製工具）——今天不可達（`roles.ts:42-68` 的 builtin 清單與 `run.ts:82` 的 plugin permit list 都不含它）。

## 6. 取樣與自創

| 部分 | 來源 |
|---|---|
| 「請求帶得住自己的預算」的形狀（值鏈、夾取、absent ≠ 0） | **沿用 M72 已立的規矩**（`provider-boundary-design.md` §1.1／§1.2），本輪只是把它補到缺的出口 |
| 子代理的兩個建構點與「每次重建都再丟一次」 | **本樹自己的紀錄**（M72 階段 Ⅱ §5.5），本輪以讀樹**複核並擴充**（第二處型別窄化、rebuild 的 prompt contract、沒有 telemetry） |
| compaction 的窗口/cap 可達性 | **本輪的偵察**（逐檔讀樹，含 `resolveContextWindow` 的 catalog 臂在生產上不會走到這個量測） |
| 「超過窗口就硬失敗」的取捨 | **自創的判斷**——本樹沒有先例（子代理從來沒有窗口），而階梯的三層結構（`core-agent:215-234`）使「只有第三層」是**唯一的**結果 |
| 「失敗要與沒東西可壓分得開」 | **沿用 M72 的主題**（沉默的失敗是缺陷）；本輪發現它在 `/compact` 上是**使用者可見**的一句話 |
