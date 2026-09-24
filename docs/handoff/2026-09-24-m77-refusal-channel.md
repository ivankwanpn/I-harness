# M77（拒絕要有通道）交付紀錄

**一句話**：**模型拒絕跟成功無法分辨**——`content_filter`／`SAFETY`／`RECITATION`／`refusal`／`guardrail_intervened` 全都以 HTTP 200 ＋ 空內容到達，於是 `core-agent` **把空的 assistant 訊息寫進日誌**、turn 正常結束、`finalText` 是 `""`、CLI 什麼都不印、exit code 0。本階段給它一條通道：seam 的 `end` 加一個**語意**位元 `refused?: true`（與 `truncated` 逐點對稱），五家在**自己的** wire 上認字面，三個消費者照抄 `truncated` 的形狀。

- **分支**：`m77`（from `main` `c4c78f41`）。**執行段**：`7b7d29b1`（spec＋計畫）＋ `26ec2359`..`c4cc61a1`（三個任務＋Task 1 一輪 fix round＋單一 fix wave＋一輪指標更正）。合併尚未進行。
- **spec（權威）**：`docs/superpowers/specs/2026-09-24-refusal-channel-design.md`
- **計畫**：`docs/superpowers/plans/2026-09-24-refusal-channel.md`
- **執行**：subagent-driven development——4 個任務 → 逐任務複審 → Task 1 一輪 fix round → **終審（opus）** → **單一 fix wave** → 限定複審
- **它屬於**：`docs/handoff/2026-09-23-backend-closure-plan.md` 的 **M77／M76–M80**

---

## 1. 閘門與算術

**`pnpm verify:all` 在最終樹上 PASSED**（單獨執行）：

| 步驟 | 讀數 |
|---|---|
| suite | exit 0 · **3118 passed｜9 skipped｜0 failed** |
| population | **67 of 67** |
| typecheck | exit 0 |
| e2e | exit 0 · 5 檔 |
| reachability | exit 0 · **432 列** · `gate PASS -- no new rows`（逐字複核） |

**算術**：M76 終態 **3083** ＋ **35** ＝ **3118**：Task 1 ＋2、Task 2 ＋7、Task 3 ＋10（中途讀數 3102）＋ **fix wave ＋16**（12 個 red-first ＋ 4 個對照）＝ 3118 ✓。

**reachability 是 432，不是 433——而那個差是量出來的，不是漂移**：`@i-harness/llm-seam#RetryableErrorCode` **被本階段合法地消費了**（anthropic 那一臂真的 import 了那個型別）⇒ 它從「未被消費」的列退了出來。**控制器一度寫「應該回到 433」，那是算術錯誤**——它同時說了「那一列保持退休」與「回到 433」，兩者不可能同時成立。實作者**拒絕**把數字遷就我的指令，改成在四個 commit 上逐一量（base 433 → Task 2 431 → HEAD 431 → 改註解後 432）並照真實數字提交。**這是本階段第三次由 subagent 用一次量測糾正控制器。**

---

## 2. 交付物

### 2.1 seam 的位元（`packages/llm-seam`）

`| { type: "end"; truncated?: true; refused?: true }`——**語意**位元，**不是**新聯集成員，**不是** wire 詞彙。

**為什麼不是新成員（量到的兩半）**：`core-agent` 的 `switch` 沒有 `default`、沒有 exhaustive assert ⇒ **靜默丟掉**；而重試包**不丟**它——`createRetryingClient` 尾端的 `yield ev` 是 **catch-all、原樣轉發**，它只是**不判斷**（`produced` 永遠不設），於是新成員會**未經判斷地到達消費者**再死在 `core-agent` 那個 defaultless 的 switch 上。**（這一條的理由在執行期被更正過一次：原文說重試包「也會丟掉」是假的。）**

### 2.2 五家 ＋ 它們**各自的第二、第三個**載體（`packages/llm-*`）

**終審最重要的發現是：只認「停止原因」的字面是不夠的。** 三家有**內容側**的載體，而它們今天仍然靜默：

| wire | 停止原因的字面 | 內容側的載體（終審補上） |
|---|---|---|
| `llm-openai`（Responses） | `response.incomplete` ＋ `incomplete_details.reason === "content_filter"` | **`response.refusal.delta`**／`response.refusal.done`／`ResponseContentPartAddedEvent` 的 `type === "refusal"` 部分 |
| `llm-openai-compatible` | `finish_reason === "content_filter"` | **`delta.refusal`**（這一條 wire 自己的拒絕欄位，配 `finish_reason: "stop"` ＋ `content: null`） |
| `llm-gemini` | `finishReason` 為 `SAFETY`／`RECITATION`，**以及**輸入側的 `promptFeedback.blockReason` | **另外六個內容／政策的停止原因**（`PROHIBITED_CONTENT`／`BLOCKLIST`／`SPII`／`IMAGE_SAFETY`／`IMAGE_PROHIBITED_CONTENT`／`IMAGE_RECITATION`） |
| `llm-anthropic` | `stop_reason === "refusal"` | —— |
| `llm-bedrock` | `messageStop.stopReason === "guardrail_intervened"` | —— |

**而 anthropic 的 `model_context_window_exceeded` 走另一條**：它不是拒絕，是**輸入側**的訊號，所以它發一個帶 **`CONTEXT_WINDOW_EXCEEDED`**（seam **既有**的碼、已分類、**不在**預設重試清單）的 `error` 事件——**不新造詞彙**。測試用 `retryErrorCode()` 斷言分類，而那個碼落在分類器**先讀**的欄位上（先讀 `code`、再跑正則）⇒ **結構性的，不是字串性的**。

### 2.3 消費者（`core-agent`／`core-session`／`telemetry`／`apps/cli`／兩個訊息）

與 `truncated` 逐點對稱：`provider/refused` telemetry、耐久的 `step/end.refused`、CLI 的 `[refused]` ＋ `result.refused`。**空 assistant 訊息**照寫（語意在欄位、不在文字——否則日誌上「模型沒說話」與「被擋」仍然不可分）。兩個內部訊息（compaction 的「summary 是空的」、session-title 的「title 是空的」）在看到拒絕時改說**提供者拒絕**。

**`refused` 與 `truncated` 各自獨立**（不假設互斥），CLI 的順序是 `[truncated]` 然後 `[refused]`，而且有測試釘住。

---

## 3. ⚠️ 這一輪最重要的那條：**紀錄是這棵樹裡最不可信的產物**

M76 的教訓是「註解宣稱有效、其實無效」。M77 把它推得更遠：**本階段自己的紀錄錯了三次，而三次都是被量測推翻的**——

1. **「重試包也會丟掉新成員」**（控制器寫進 spec，實作者抄進註解）：假的。它的 `yield ev` 是 catch-all、**原樣轉發**。
2. **「`manifest.test.ts` 會斷言型別與 manifest 一致，所以兩處必須同時改」**（控制器寫的）：假的，而且**比假的更糟**——那個測試的執行期那一半是**同義反覆**（`codes` 是從 manifest 建的），所以**加了型別卻忘了 manifest 列是沒有任何東西守著的**。修它要動一條既有斷言 ⇒ 指派給 **M79**。
3. **「reachability 應該回到 433」**（控制器在指令裡寫的）：算術錯了——它同時要求「那一列保持退休」與「回到 433」。實作能量、能拒絕、照真實數字提交。

**而終審把同一件事推到了計畫本身**：spec §1.2 的字面表（來自偵察）**只列了停止原因**，而三家有**內容側**的載體 ⇒ **本階段要消滅的那個症狀在真實的 OpenAI 拒絕形狀上仍然完整存在**。那不是實作的錯——**它照著表做了**——是表不完整。

**⇒ 這一條鏈的紀律因此再收緊一步：任何「某個東西被守著」的斷言，都要先量它是否真的會紅。** 三個例子裡有兩個是「我以為有牙的東西其實沒有」。

**而這一輪也有三次是 subagent 用一次量測糾正控制器**：EOL 的儀器（worktree 是 CRLF、blob 是 LF，我量的是 blob）、第二輪的帶狀區算術、以及上面第 3 條。**這是這套流程存在的理由，紀錄下來。**

---

## 4. 裁決（Rulings）— 逐條附代價

1. **詞彙是 `end` 上的語意位元**，不是新聯集成員（會被 defaultless 的 `switch` 靜默丟掉；重試包會轉發但不判斷），也不是 wire 字面（M72 Ⅱ 的約束）。*代價*：**分不出拒絕的種類**（見 §5）。
2. **context 超限走既有的 `CONTEXT_WINDOW_EXCEEDED` 碼**，不新造詞彙、不改重試政策。*代價*：它是一個**終止的 error ⇒ 整個 run 失敗、exit 1**（M77 之前是「空成功、exit 0」）——**這個行為改變現在寫在 spec §4.5**。
3. **拒絕不接到 `EMPTY_RESPONSE`**（那個碼在**預設重試清單裡**，接上去等於重試一個內容過濾——徒勞）。*代價*：那個死碼繼續死著（具名殘餘）。
4. **唯一被改的既有斷言是一個具名的**：`llm-openai/test/openai.test.ts` 的 `content_filter` 案例原本斷言 `{ type: "end" }`——**它刻意斷言的正是本階段要改的契約**（拒絕＝空成功）。改成 `{ type: "end", refused: true }` 並在該處說明為何改。
5. **fix wave 的三個補丁都接受**：內容側載體、seam JSDoc 的引用改成符號名、三個過期註解。**其中只有一條既有斷言被動**（compaction 的 `BYTE FOR BYTE` 從子字串改成錨定匹配——**更嚴**，而實作者量到舊形式會放過一個漂移過的訊息）。
6. **`ESCALATION`／`PUP_LIMITED_DISABLED`／`LANGUAGE`／`OTHER` 與各種 `MALFORMED_*`／影像原因都不設位元**，原則是：**位元用在「提供者因為內容／政策而不產出」；能力或可用性的限制走錯誤通道**（anthropic 的 context 上限就是這樣），**沒有現成碼的就具名，不新造詞彙**。（終審更正了實作時寫錯的一句：`LANGUAGE` 廠商說是**回應側**的旗標，不是請求側的約束——排除的結論不變，理由換成上面的原則。）
7. **compat 的 `refusal: ""` 保持現狀**（欄位是字串就設位元）：一個總是送空字串的 gateway 會把每個回應標成拒絕，但拿掉它會漏掉**空訊息的拒絕**——而那是本階段要消滅的靜默。沒有廠商明文、沒有測試；**量了再說，不猜**。
8. **`4c`（每家一個獨立性測試）被拒**：那個 wire 從不送 `n`，兩條 `choices` 的框是**發明的內容**——忠於 brief 自己的警告。

---

## 5. 殘餘與 deferred minors

**殘餘（spec §4／§5）**：**分不出拒絕的種類**（要分辨得再分一層語意，不是搬字面）；**「非內容」的空結束仍然靜默**（gemini 的其他十個停止原因——**與本階段要消滅的症狀同一類**，已成為**候選單位 2.5**）；**拒絕之後的行為是產品決定**（重試？換模型？一個驅動 CLI 的腳本仍然分不出拒絕與成功，除非解析 stderr）；**anthropic 的 context 臂會弄死整個 run**；`EMPTY_RESPONSE` 沒有生產者；**`delta.refusal` 的伴隨形狀不可查**（兩個文件站都 403，且不影響正確性）；**`refusal: ""` 的邊界未測**；`llm-seam` 的 JSDoc 仍是「一家一個載體」的舊寫法；`response.completed` 的 `output[]` 是**陳述的邊界、不是量測過的 wire**。

**Deferred minors（8 條）**：`core-agent` 的註解曾把映射寫成 1:1（fix wave 已收）；`compaction` 的 `BYTE FOR BYTE`（fix wave 已錨定）；`spyTelemetry` 被複製一份；`CAPABILITIES-DETAIL.md` 說「19 行」而 manifest 有 23 列（**第三次遺漏**，M80 收）；**`manifest.test.ts` 的同義反覆**（指派 M79）；`session-title` 的訊息**沒有呼叫端觀察得到**（在 `try` 裡、`catch` 直接回退）；`llm-gemini` 的排除清單只列了 10 個（14 個裡）；`anthropic.test.ts` 的一句措辭。

**▶ 已收線（M79，2026-09-24）：`CAPABILITIES-DETAIL.md` 的 telemetry 詞彙數已改成 manifest 的列數** —— `45bd37e` 把「19 行」連同其他三處一律改成 **23 列**（早於預期的「M80 收」）；M80 的 T3 再把 23 → **24**（M80 T1 新增的 `provider/empty`）。**本條 deferred minor 關閉；上面的殘餘清單不在這次收線的範圍內**（收線判讀在 `docs/handoff/2026-09-24-m80-backend-readiness.md`，M80）。

---

## 6. 給下一個動這條鏈的人

1. **要動 seam 的聯集**：位元是**欄位**不是成員（`core-agent` 的 defaultless `switch` 會靜默丟掉新成員），而**沒有任何東西會替你發現**——只有測試。
2. **要加一家 wire 的拒絕**：先問「這一家的拒絕是**停止原因**還是**內容**？」——M77 的教訓是**兩者都要**，而只認停止原因的表會在真實形狀上留一個完整的缺口。
3. **要動 `manifest.ts`**：那一列**要手動加**，`manifest.test.ts` **不守它**（它的執行期那一半是同義反覆）。M79 會修那個測試；在那之前，加了型別忘了列 = 沒有東西會紅。
4. **要動 CLI 的拒絕呈現**：`[truncated]` 先、`[refused]` 後，有測試釘住；而**exit code 仍然是 0**——若哪天要讓腳本能分辨，那是**產品決定**（§5）。
5. **引 `llm-seam`／`core-agent` 的註解一律用符號名**：`llm-seam` 在本階段被寫了兩次註解（新增區塊、JSDoc 轉換 ⇒ **+33 行**），而 `core-agent` 被 Task 3 自己動過（開頭多 7 行、`end` 臂多 1 行）⇒ **新寫的三個 core-agent 引用一次就全部過期**。符號名不會過期。
