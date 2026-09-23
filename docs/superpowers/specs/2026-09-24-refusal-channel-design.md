# M77 — 拒絕要有通道 Design

**一句話**：今天**模型拒絕跟成功無法分辨**——`content_filter`（openai）、gemini `SAFETY`／`RECITATION`、anthropic `stop_reason: "refusal"`、bedrock `guardrail_intervened` 全都以 HTTP 200＋空內容到達，seam 只報「空成功」，於是 `core-agent` **把一則空的 assistant 訊息寫進日誌**、turn 正常結束、`finalText` 是 `""`、CLI 什麼都不印、exit code 0。本階段給它一條通道。

**來源**：M72 §Ⅱ／§Ⅲ 的殘餘（`docs/handoff/2026-09-23-m72-phase-2.md:88`、`m72-phase-3.md:114`）；2026-09-24 的偵察（seam ＋ 五個轉接器 ＋ 三個消費者，逐條帶 `path:line`）。

**分級**：**L**（動的是 seam 的事件聯集——**每一個**模型回應都經過它）。

---

## 0. 它讓什麼變得不一樣（全部量測／讀碼，逐條帶 `path:line`）

| 事實 | 讀數 |
|---|---|
| **seam 沒有停止原因的詞彙** | `LLMStreamEvent`（`llm-seam/src/index.ts:30-36`）＝ `text/chunk`／`reasoning`／`tool_call`／`usage`／`end{truncated?}`／`error`。**M72 Ⅱ 明文規定 finish-reason 詞彙不得滲進 seam**（`docs/superpowers/plans/2026-09-23-provider-boundary-phase-2.md:22`） |
| **五個轉接器今天都把拒絕變成裸 `end`** | **openai**：只認 `response.incomplete` 的 `incomplete_details.reason === "max_output_tokens"`（`llm-openai/src/index.ts:214`），而 `content_filter` **被刻意繞開失敗臂**（`:230-245` 的註解、`:233-234`）⇒ `[]` ⇒ 裸 `end`；**openai-compatible**：只認 `finish_reason === "length"`（`:251`）；**gemini**：只認 `finishReason === "MAX_TOKENS"`（`:253`），**`promptFeedback.blockReason` 全檔 0 命中**；**anthropic**：只認 `stop_reason === "max_tokens"`（`:204`），`"refusal"` 與 `"model_context_window_exceeded"` **不被讀**；**bedrock**：只認 `stopReason === "max_tokens"`（`:281`）。**五個都沒有 log／warn／error** |
| **空成功被寫成日誌** | `core-agent/src/index.ts:476`：`else if (toolCallsThisStep === 0) append(session, { type: "assistant/message", text: "" })` ⇒ turn 正常結束（`:483`、`:486`）、`finalText` 是 `""`（`:494-501`）。**`switch` 沒有 `default`、沒有 exhaustive assert**（`:416-419` 自己說明） |
| **CLI 靜默** | `apps/cli/src/index.ts:487`：`if (r.finalText) console.log(r.finalText)` ⇒ 什麼都不印；exit code 0（`apps/cli/src/run.ts:888`） |
| **重試包從不看有沒有產出** | `llm-seam/src/index.ts:173-235`：只重試 throw 或 `error` 事件，且只在**還沒有產出**之前（`:191`）。**`EMPTY_RESPONSE` 這個碼在整棵樹裡沒有生產者**（只在 `:47`、`:93` 出現）⇒ 它永遠不會觸發 |
| **而 context 超限**的碼**存在且有分類** | `RetryableErrorCode` 有 `CONTEXT_WINDOW_EXCEEDED`（`llm-seam/src/index.ts:42-49`），由 `retryErrorCode()` 用**訊息正則**從 throw 的錯誤裡撈（`:126`、`:143`），**不在** `DEFAULT_RETRYABLE_CODES`（`:93`） |
| **`truncated` 是本階段要複製的先例，而它的形狀是量出來的** | **生產者 5 個**（`llm-openai:214`、`openai-compatible:251`、`gemini:253`、`anthropic:204`、`bedrock:281`）＋ mock（`llm-mock:45`）；**讀者只有 3 個**：`core-agent/src/index.ts:431`（→ `provider/truncated` telemetry ＋ 耐久欄位 `step/end.truncated`，`:433`／`:478`）、`apps/cli/src/run.ts:825`（→ stderr `[truncated]`，`:885`）、以及重試包**分支在 `end` 上但不讀它**（`llm-seam:204`） |
| **加一個欄位的代價是「3 個 schema 點」＋「1 條會紅的斷言」** | schema：`core-session/src/index.ts:25`（`step/end{truncated?}`）、`telemetry/src/types.ts:23`（事件型別聯集）、**`telemetry/src/manifest.ts:36`**——而 `telemetry/test/manifest.test.ts:7-16` **斷言 manifest 與型別聯集一致** ⇒ 新事件型別必須有 manifest 列，否則那裡紅 |
| **那條會紅的斷言正是本階段要改的行為** | `llm-openai/test/openai.test.ts:489-497`：`content_filter` 的 fixture ⇒ `expect(events.at(-1)).toEqual({ type: "end" })` **逐欄相等**（`:495`）＋ `not.toHaveProperty("truncated")`（`:496`）。**這是既有測試刻意斷言「拒絕＝空成功」，所以它必須改，而且要具名。** |
| **另外四家的「其他原因是乾淨結束」斷言不會紅** | `gemini.test.ts:430-437`（`STOP`）、`anthropic.test.ts:552-560`（`end_turn`）、`openai-compatible.test.ts:397-405`（`stop`）、`bedrock.test.ts:541-551`（`end_turn`）——它們的註解說「every other reason is a clean ending」，**那個「every other」變得不精確**，但斷言本身（`STOP`／`end_turn`／`stop` 仍是乾淨結束）**仍然為真** |
| **兩個內部消費者今天給出**誤導**的訊息** | `compaction/src/summarizer.ts:272`：`throw new Error("compaction: summarizer returned empty output")`；`session-title/src/index.ts:84`：`throw new Error("empty provider title")`——一個拒絕會被說成「空輸出」 |

**⇒ 通道要**小而對稱**：一個**語意**位元（不是 wire 詞彙）＋ 一條**已經存在**的錯誤碼路線，複製 `truncated` 的形狀。**

## 1. 設計

### 1.1 詞彙：`end` 加一個語意位元 `refused?: true`；context 超限走**既有**的錯誤碼

- **`{ type: "end"; truncated?: true; refused?: true }`**——與 `truncated` 完全對稱：**缺席即缺席**（永遠不寫 `false`），而它是**語意**的（「提供者拒絕產生內容」），**不是** wire 詞彙（`content_filter`／`SAFETY`／`refusal`／`guardrail_intervened` **都不進 seam**，M72 Ⅱ 的約束不破）。
  - **為什麼不新增一個聯集成員**：`core-agent` 的 `switch`（`packages/core-agent/src/index.ts`，其 `:416-419` 自己這麼說）沒有 `default`、也沒有 exhaustive assert ⇒ 新成員會被**靜默丟掉**（**這半條是量到的**）。而重試包**不是**「丟掉」它——`createRetryingClient`（`packages/llm-seam/src/index.ts`）的尾端 `yield ev` 是**catch-all，會把它原樣轉發**；它認得的是 `text/chunk`／`reasoning`／`tool_call`（設 `produced`）、`usage`（保留）與終止的 `error`／`end` ⇒ 新成員會**未經判斷**地到達消費者（`produced` 永遠不設），然後死在 `core-agent` 那個 defaultless 的 switch 上。加欄位則**既有讀者的 `=== true` 檢查自然繼續工作**（`core-agent` 的 `if (ev.truncated === true)` 與 `run.ts` 的同形狀）。
    - **引用以符號為準，不用行號**（這一節的量測註記）：`llm-seam/src/index.ts` 的行號在本階段**兩次位移**（任務 1 的註解與 JSDoc 轉換都在同一段上方）⇒ 引 `llm-seam` 一律用**符號名**（`createRetryingClient`、`RetryableErrorCode`、`retryErrorCode`）或 `path` ＋ 符號，行號只出現在**當次**的量測紀錄裡。
    - **執行期更正（Task 1 的複審推翻了原文的重試包那半）**：原文說重試包「也會丟掉」——**假的**；真相是**轉發但不判斷**。裁決的結論不變（用欄位），理由是上面修正過的那一條。
  - **為什麼不是 `error` 事件**：拒絕**不是**傳輸失敗——HTTP 200、串流正常結束。把它變成 error 會讓它進重試分類，而重試一個內容過濾是**徒勞**的（同樣的輸入 ⇒ 同樣的拒絕）。
- **`model_context_window_exceeded`（anthropic 的 `stop_reason`）走另一條**：它不是拒絕，是**輸入側**的訊號，而 seam **已經有**那個碼（`CONTEXT_WINDOW_EXCEEDED`，已分類、**不在**預設重試清單）。⇒ anthropic 的這一臂**發出一個帶該碼的 `error` 事件**（`code` 是 `retryErrorCode()` 讀的同一個欄位，`llm-seam:132-149`），**不新增第二套詞彙**。這一條同時是 M75 的補強：M75 靠**估計**判斷超窗，而這裡是**提供者自己說的**。
  - **不做**：不把它接進預算階梯（那是另一個單位）；本階段只讓它**出現**（不再靜默）。

### 1.2 生產者：五個轉接器 ＋ mock

每家在自己的 wire 上認**自己的**拒絕字面，設 `refused = true`（與 `truncated` 同一個變數模式、同一個 yield 點）：

| 檔案 | 認的字面 |
|---|---|
| `llm-openai`（Responses） | `response.incomplete` 且 `incomplete_details.reason === "content_filter"` |
| `llm-openai-compatible` | `finish_reason === "content_filter"` |
| `llm-gemini` | `finishReason` 為 `"SAFETY"`／`"RECITATION"`，**以及**（同一家、同一輪）`promptFeedback.blockReason` 存在——**兩者都要**，因為被擋在輸入側時 `candidates` 可能整個缺席（今天連 `candidates?.[0]` 都讀不到） |
| `llm-anthropic` | `stop_reason === "refusal"` ⇒ `refused`；`stop_reason === "model_context_window_exceeded"` ⇒ **帶 `CONTEXT_WINDOW_EXCEEDED` 碼的 error 事件** |
| `llm-bedrock` | `messageStop.stopReason === "guardrail_intervened"` |
| `llm-mock` | 只加**欄位**（讓測試釘得住它），**不做 wire 判斷** |

**「缺席即缺席」也適用於這裡**：`refused` 只在該字面出現時被寫；其他停止原因（`STOP`／`end_turn`／`stop`／`stop_sequence`／`tool_use`…）**不寫**（那四家的既有斷言因此仍然為真）。

### 1.3 消費者：三個，與 `truncated` 逐點對稱

1. **`core-agent`**（`packages/core-agent/src/index.ts`）：`end` 且 `refused === true` ⇒
   - 記一個 `refusedThisStep`（與 `truncatedThisStep` 同一個形狀，`:431`）；
   - 發 **`provider/refused`** telemetry（與 `provider/truncated` 同一個形狀，`:433`）；
   - 把 `refused?: true` 寫進**耐久的** `step/end`（與 `:478` 同一個位置）；
   - **不再把空回應當成一般空答案**：日誌裡仍然要有東西（否則「模型沒說話」與「模型被擋」在**日誌**上仍然不可分），但**訊息文字要說明是拒絕**——`text: ""` 不變、`step/end.refused` 承載語意（與 `truncated` 完全同構：語意在欄位上，不在文字上）。
   - **不做**：不重試、不換模型、不自動改寫 prompt（那是產品決定，列為殘餘）。
2. **CLI**（`apps/cli/src/run.ts:825` 一帶）：與 `[truncated]` 逐點對稱——讀 `step/end.refused` ⇒ stderr 印 `[refused]`（`:885` 的形狀）＋ `result.refused`（`:888` 的形狀）。
3. **兩個內部消費者把訊息改準**：`compaction/src/summarizer.ts:272` 與 `session-title/src/index.ts:84` 的 throw 訊息在**看到 `refused` 時**說明是提供者拒絕（否則「空輸出」是誤導）。

### 1.4 schema 與 telemetry

- `core-session/src/index.ts:25` 的 `step/end` 加 `refused?: true`（與 `truncated?: true` 並列）。
- `telemetry/src/types.ts:23` 的聯集加 `provider/refused`，`telemetry/src/manifest.ts` 加對應列——**`telemetry/test/manifest.test.ts:7-16` 會斷言兩者一致**，所以兩處必須同時改（那是它的用途）。
- **`EMPTY_RESPONSE` 不動**：它的無生產者是既成事實，且**拒絕不該被重試**——把拒絕接到那個碼上會**引入**重試。記為殘餘（見 §5）。

## 2. 驗收（每一條都要**紅先 ＋ 變異證明**）

1. **五家的拒絕字面都被認出來**：每一家一個案例（fixture 用該家的 wire 字面）斷言 `end` 帶 `refused === true`；**同時**每一家一個「其他原因是乾淨結束」的對照（那四家的既有斷言就是這個對照）。
2. **`content_filter` 不再被繞開失敗臂**（openai）：既有的 `openai.test.ts:489-497` **必須改**，改成 `{ type: "end", refused: true }`；**這是本階段唯一被改的既有斷言，要具名**。
3. **gemini 的 `promptFeedback.blockReason`**：一個 `candidates` **缺席**、只有 `promptFeedback` 的 chunk ⇒ 仍然要認出拒絕（今天完全讀不到）。
4. **anthropic 的 context 超限**：`stop_reason === "model_context_window_exceeded"` ⇒ 一個帶 `CONTEXT_WINDOW_EXCEEDED` 碼的 **error 事件**（不是 `refused`），並斷言 `retryErrorCode()` 讀得出來（既有分類，不是新碼）。
5. **`core-agent` 三個後果**：telemetry 一則 `provider/refused`（形狀與 `provider/truncated` 對稱）、`step/end.refused` 為真、**乾淨結束時兩者都不出現**。
6. **CLI**：`[refused]` 上 stderr ＋ `result.refused`；乾淨的一輪兩者都沒有。
7. **缺席即缺席**：`refused` 只在該字面出現時被寫；`STOP`／`end_turn`／`stop` 的既有斷言全綠（**不得**改）。
8. `pnpm verify:all` 五步全綠、`--gate` 不得新增 row（**不新增 export**；`refused` 是欄位，新 telemetry 型別不產生 reachability 列——若它產生了，**回報而不要加 allowlist**）。

## 3. 刻意不做（YAGNI）

- **不新增聯集成員**（`core-agent` 的 defaultless `switch` 會靜默丟掉它，重試包會**轉發但不判斷**它，§1.1）。
- **不把 wire 詞彙帶進 seam**（M72 Ⅱ 的約束）：`refused` 是語意位元，五家的字面留在五家。
- **不把拒絕接到 `EMPTY_RESPONSE`**（會引入重試）。
- **不把 `model_context_window_exceeded` 接進預算階梯**（M75 的地盤，且需要自己的 spec）。
- **不重試、不換模型、不自動改寫 prompt**（產品決定，§5）。
- **不動 `EMPTY_RESPONSE` 的無生產者**（具名殘餘）。

## 4. 它不保證什麼（明說）

1. **不保證拒絕的「種類」可見**：seam 只有一個位元 ⇒ 使用者知道「被擋」，但**不知道**是安全過濾、版權、還是護欄。**代價明說**：要分辨就得把五家的詞彙帶進 seam，而那與 M72 Ⅱ 的約束衝突。若日後要種類，正確的做法是**再分一層語意類別**（例如 `refused: "content" | "policy"`），不是搬字面。
2. **不保證每一家都真的送得出那個字面**（沒有真 provider 的請求被跑過；fixture 是 wire 文件形狀）。
3. **不保證 CLI 之外的前端看得見**（今天的反應面只有 stderr 與 `result.refused`）。

## 5. 殘餘（寫出來，不是藏起來）

- **`EMPTY_RESPONSE` 沒有生產者**（`llm-seam:47`、`:93`；本階段不動）。
- **拒絕之後的行為是產品決定**：重試？換模型？把拒絕回報給使用者、還是當成一次普通的空回合？（本階段只讓它**可見**。）
- **`model_context_window_exceeded` 只到「出現」**：預算階梯沒有消費它（那是 M75 的地盤，且需要一條把「提供者說的」與「我們估的」對齊的設計）。
- **其他家的對等字面未查**：bedrock 的 `guardrail_intervened` 已認，但**其他**停止原因（例如 bedrock 的其他 guardrail 形狀、gemini 的 `OTHER`）沒有逐一查證。
- **`truncated` 與 `refused` 可能同時**嗎？（一個回應既被截斷又被擋）本階段**不假設互斥**，兩個位元各自獨立寫。

## 6. 取樣與自創

| 部分 | 來源 |
|---|---|
| 語意位元而不是新聯集成員 | **本樹的既有形狀**（`truncated`）＋**兩個 defaultless 消費者的量測**（`core-agent:416-419`、`llm-seam:204`） |
| context 超限走既有的 `CONTEXT_WINDOW_EXCEEDED` | **seam 已經有那個碼**且已分類（`llm-seam:42-49`、`:143`）——一條規則只落一處 |
| 五家的字面留在五家 | **M72 Ⅱ 的明文約束**（`provider-boundary-phase-2.md:22`） |
| 「缺席即缺席」 | 本樹的既有規則（`core-agent:430`） |
| 三個消費者與 schema 三點 | **`truncated` 的實際讀者清單**（偵察逐點量得） |
| 不作種類分辨＋重試是產品決定 | **自創的判斷**，代價寫在 §4 |
