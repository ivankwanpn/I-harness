# M72 — provider 邊界要說真話（請求帶得住、失敗浮上來、事實讀進來）Design

**一句話**：讓 IH 送出去的請求**帶得住它該帶的東西**（輸出上限、system prompt、Anthropic 的必填欄位），讓 provider 的**失敗浮上來**而不是變成一次乾淨的空成功，並讓 provider 回報的**事實**（usage、reasoning）真的進到紀錄。

**來源**：使用者 2026-09-22 的三個裁定（**照 Pi／DSH 送輸出上限**——「模型是真的有輸出上限」；**檢查轉接器有沒有設計問題**；其餘照判斷）＋ 孤兒列 **C3**（`--max-tokens` 沒有消費者）與 **B4**（`stream_options`）＋ 使用者要求的**轉接器審計（16 條）**。

**分級**：**L**（改變別人依賴的介面：seam 的請求型別 ＋ `SessionModelBinding`）⇒ 完整 spec ＋ 計畫 ＋ 互不重疊 scope 的最終審查。照 **M5/T4 的先例**：**一份 spec、三個可各自出貨的階段**。

---

## 0. 它讓什麼變得不一樣（全部是量測，每一條都有 `path:line`）

今天，IH 的 provider 邊界有**一整叢沉默的錯誤**——不是「還沒做」，是**送出去的東西與它自己宣稱的不是同一件事**：

| 事實 | 讀數 |
|---|---|
| **預設 profile 的每一次請求都沒有 system prompt** | `llm-openai-compatible/src/index.ts:72-89` 的 `toWireMessage` 只有 `tool`／`assistant`／其他三個分支，`systemPrompt` **全檔未被讀**；而測試把這件事**釘成正確**（`test/openai-compatible.test.ts:25` 的 `expect(body.system).toBeUndefined()`，同一條斷言的 `body.messages` 裡也沒有 system 訊息）。內建的 `deepseek` profile 走的就是這條線 |
| **anthropic 的 POST body 沒有 `max_tokens`** | `grep max_tokens packages/llm-anthropic` **零命中**（原始碼與測試都是）；Messages API 將它列為**必填**。而 legacy thinking 分支送 `budget_tokens`，API 要求它**必須小於 `max_tokens`** ⇒ 那條路徑**沒有合法對應值** |
| **串流內的錯誤事件被丟掉** | anthropic 對 `type:"error"` 沒有分支（`:234` 落進 `return []`，之後照樣 `end`）；openai 對 `response.failed`／`error` 同樣 `return []`（`:197`、`:202`）。**失敗的一回合讀成一次乾淨的空成功** |
| **bedrock 對請求層失敗直接 throw** | `llm-bedrock/src/index.ts:156-159` **沒有任何 `try`/`catch`** ⇒ 沒有 `error` 事件、沒有 `describeTransportError`（其餘四個都有） |
| **四個 SSE 解析器的 `JSON.parse` 無防護** | `json` 壞掉時**拋出**（`openai-compatible:66`／`openai:78`／`anthropic:115`／`gemini:65`），而同一個轉接器的 HTTP 失敗是**事件** ⇒ 同一個 provider 的可觀測失敗通道取決於壞在哪裡 |
| **沒有任何轉接器檢查自己的終止符** | `end` 是無條件的（`:241`／`:241`／`:269`／`:266`／`:250`）⇒ **截斷與完成分不出來** |
| **usage 只有 anthropic 回報** | `llm-anthropic:182-189` 是唯一的讀者；`llm-openai` **收到了卻丟掉**（`:197`）；gemini／bedrock **沒讀**，而它們的註解宣稱「seam 沒有 usage 事件」——**假話**（`llm-seam/src/index.ts:34` 有），且被 `test/bedrock.test.ts:159` 的標題**釘住那個假前提** |
| **`reasoning` 在 openai-compatible 從不發** | `reasoning_content` 在 `packages/` **全樹零命中** ⇒ DeepSeek 的推理內容被丟掉 |
| **5.x／未知模型 id 走 legacy 分支** | `anthropic:80` 與 `bedrock:56` 的 regex 只認 `-4[-.](6|7|8|9|…)`，而註解宣稱涵蓋「anything later」⇒ 新版模型拿到 `budget_tokens`／`budgetTokens`，**那是 400** |
| **`--max-tokens` 到不了任何地方** | 解析 → 兩次驗證 → 寫進 settings → provider 的鏈**真的算出 `maxOutputTokens`**（`provider/src/index.ts:300`）→ **在 `provider-runtime/src/index.ts:646-650` 被丟掉**（`SessionModelBinding:65-72` 沒有那個欄位）⇒ **五個 provider 都收不到**。而**沒有任何指令顯示你設的值**（`models list` 只印卡片的數字） |
| **死面與逃生口** | `LLMRequest.model` **沒有任何讀者、也沒有生產者**；`config.options` 只被文件化一次、**從不驗證、生產上從不填**，而且在四個轉接器裡**可以覆蓋必填欄位**、在 bedrock 不能 |

**⇒ 這一輪不是「補兩個孤兒」，是三件事：把請求修對、把失敗修響、把事實修進來。**

## 1. 設計

### 1.1 輸出上限的來源鏈（照 Pi 的形狀）

值走一條**明確的鏈**，每一個來源都已經存在於本樹：

1. **請求／設定列的覆寫** —— 使用者寫的 `--max-tokens`（`settings` 的 `models[].maxTokens`，已經被解析、驗證、算出來）；
2. **卡片的 `maxOutputTokens`** —— 模型的**能力上限**（`model-catalog.json` 已有 deepseek 384000、gemini 65536/8192、bedrock 8192）；
3. **協定要求時的退路** —— **Anthropic 的 Messages API 必填**，所以那條線**必須**永遠解析出一個數（DSH 的 `?? connection.maxTokens` 就是為此）。本樹採一個**具名常數**當最後手段，而它的**語意要明寫**：它是「**實質無上限**」的意思（取值要對齊該 provider 文件上的輸出上限），**不是**一個「聽起來合理的」猜測值 —— 常數的**形狀**在此定案，**數字**由計畫依 provider 文件定案並具名其出處。

**為什麼照 Pi 而不是 DSH 的「能力不當預設」**：使用者的理由是「模型真的有上限」，而送一個**等於模型上限**的數在語意上是**無操作**（provider 本來就會那樣夾），卻讓**意圖顯式**：日誌裡看得到我們送了什麼，而 Anthropic 那條線的必要欄位因此有值。DSH 的顧慮（「把一個沒人挑過的數字變成請求預設」）在本樹**不成立**，因為卡片的數字就是模型的真實上限。

### 1.2 wire 映射（五個，各用自己 provider 的參數）

| 轉接器 | 欄位 | 位置 |
|---|---|---|
| `llm-anthropic` | `max_tokens` | body 頂層（**必填**，走完整鏈） |
| `llm-openai-compatible` | `max_tokens` | body 頂層 |
| `llm-openai` | `max_output_tokens` | body 頂層 |
| `llm-gemini` | `generationConfig.maxOutputTokens` | **需要新建 `generationConfig`**（今天沒有這個鍵） |
| `llm-bedrock` | `inferenceConfig.maxTokens` | **需要新建 `inferenceConfig`**（今天是不可達的——options 全被塞進 `additionalModelRequestFields`，所以 Converse 的 `maxTokens`／`temperature`／`topP`／`stopSequences` **今天一個都送不出去**） |

`LLMRequest` 加一個可選欄位 **`maxOutputTokens?: number`**（沿用卡片與 `SessionModelBinding` 既有的詞彙，不引入第三個名字），`SessionModelBinding` 加對應欄位，`provider-runtime` 的 drop site 改為**傳下去**；`models list`／`provider list` 開始**顯示使用者寫的值**（不只是卡片）。

### 1.3 截斷要看得見（上限工作**暴露出來**的缺口）

Pi 與 DSH 都把「被上限截斷」當**一等結局**（Pi：`stopReason: "length"` ⇒ 一次有界的 compact-and-retry；DSH：`max-tokens` 讓 turn 的結局**黏住**、從被截斷的訊息裡**剔除工具呼叫**、摘要 fail-closed）。**IH 今天分不出截斷與完成**——所以只送上限等於讓輸出**無聲地變短**。

**形狀**：seam 的終止事件加一個可選位 —— `{ type: "end"; truncated?: true }`。**一個位，不是一個 finish-reason 詞彙**：每個轉接器只需要回答「provider 是不是說它撞到輸出上限了」（`stop_reason: "max_tokens"`／`finishReason: "MAX_TOKENS"`／Responses 的 `incomplete`…），而**多一個 provider 詞彙的聯集**會把五個供應商的差異漏進 seam——那正是 seam 存在的理由要擋掉的東西。缺席 ⇒ 與今天逐位元組相同。

**可見度**：`truncated` 至少進得了 telemetry 與 `run` 的輸出；**不做**自動重試（那是 Pi 的產品選擇，不在本輪）。

### 1.4 usage（三個免費、一個有閘）

| 轉接器 | 做法 | 風險 |
|---|---|---|
| `llm-openai` | 讀 `response.completed` 上**已經收到**的 usage | 無 |
| `llm-gemini` | 讀最後一個 chunk 的 `usageMetadata` | 無 |
| `llm-bedrock` | 讀 `metadata` 成員（型別已宣告、今天是 `return []`） | 無 |
| `llm-openai-compatible` | 送 `stream_options: {include_usage: true}`，**預設送、可用 per-route 能力欄位關**（照 Pi；先例是 `inputModalities`） | **有**：不支援的 gateway 可能拒絕 |

並修掉兩句**假註解**與那條**釘住假前提的測試**（`bedrock.test.ts:159`）。

### 1.5 沉默失敗的修法（第 Ⅰ 階段）

- **system prompt 的映射**：openai-compatible 補 `{role:"system"}` 訊息（測試的「沒有頂層 system 欄位」前提是真的，但**該做的映射不是它**）。
- **串流內的錯誤事件**：anthropic 補 `type:"error"` 分支；openai 補 `response.failed`／`error`。
- **bedrock 的 throw**：包成與其餘四個一致的 `error` 事件 ＋ `describeTransportError`。
- **`JSON.parse` 的防護**：四個解析器把壞 chunk 變成 `error` 事件（與 HTTP 失敗同一條通道）。
- **終止符檢查**：見 §1.3。

### 1.6 本輪**不動**的死面（寫出來，不是忘了）

`LLMRequest.model` 是死欄位、`config.options` 不驗證且能覆蓋必填欄位、M59 的 headers 從未到 bedrock、五個都沒有自己的 timeout。四者都在 §4／§5 具名，**本輪不動**——理由各異（見 §3）。

## 2. 驗收

每一階段都由**行為**驗收，而且都要求**紅先測試 ＋ 變異證明**（本樹硬約束）：

1. **Ⅰ**：一則回答**至少四條**：①用 openai-compatible 送出的 body 裡**有 system 訊息**（且內容等於 `systemPrompt`）；②anthropic 收到 `type:"error"` 的串流**產生一個 `error` 事件**（不是空的成功）；③三個 SSE 轉接器收到**壞掉的 chunk** ⇒ `error` 事件（不是拋出）；④bedrock 的請求層失敗 ⇒ `error` 事件 ＋ 診斷字串。**突變**：把每一個修法拿掉 ⇒ 對應案例紅。
2. **Ⅱ**：①五個轉接器**各自**的 body 在給定上限時帶**自己的** wire 欄位（逐一斷言，含 gemini／bedrock 的父物件）；②**沒有**給上限且**沒有**卡片時，**只有** anthropic 仍送出一個值（鏈的最後手段），其餘四個不送；③`models list` 顯示**使用者寫的值**；④截斷**可觀測**（至少一條：被上限截斷的一回合在 telemetry／輸出裡看得出來）。
3. **Ⅲ**：①usage 從**四個**轉接器各自到達 `provider/usage`（四個獨立案例）；②`stream_options` **預設送**、能力欄位關掉時**不送**（兩條）；③openai-compatible 的 `reasoning_content` 變成 `reasoning` 事件；④兩句假註解與那條假前提測試已修（測試改成斷言**真的事實**）。
4. **`pnpm verify:all`** 五步全綠（母體 67；`--gate` 不得新增 row——本輪**不新增 export**，`LLMRequest` 是既有型別的 additive 欄位）。

## 3. 刻意不做（YAGNI）

- **自動 compact-and-retry on truncation**（Pi 有）：那是產品選擇，且 IH 的 compact 有自己的觸發；本輪只讓截斷**看得見**。
- **cap 與 context window 的夾取**（Pi 的 `clampMaxTokensToContext`）：IH 的 `token-meter` 已經用**比例**保留輸出空間（`reserveRatio` 0.9，量的是**輸入**）。再加一層夾取會產生**兩個決定誰先誰後的地方**——那是下一個單元要一起看的事，不在這裡。
- **改 `config.options` 的語意**（驗證它、或禁止它覆蓋必填欄位）：那是一個**獨立的契約決定**，而且它今天**在生產上從不被填**。
- **`"off"` 在 anthropic／bedrock 的表達**（今天 `off` ≡ unset，而 API 的關法是 `{type:"disabled"}`）：需要產品決定，且與 5.x 的 reasoning 分支同一個地方。
- **bedrock 的 headers 路由**（M59 宣稱「每個轉接器」但從未送到它）：那是**接線缺一條**，不是本輪的契約。
- **轉接器層的 timeout**：契約本來就是 `signal`（seam 自己的註解說明了為什麼）。

## 4. 它不保證什麼（明說）

1. **不保證每個 provider 都接受我們送的東西**——`stream_options` 與 `max_output_tokens` 都有已知會拒絕的 gateway（Pi 的 `supportsMaxOutputTokens` 註解為此存在）。本輪的閘門是**per-route 的能力欄位**，不是自動退讓。
2. **不保證截斷一定被 provider 誠實回報**——有些端點就是回一個「正常結束」。本輪只保證**我們這一側不再把已收到的訊號丟掉**。
3. **不保證 usage 的數字可比**——Pi 與 DSH 都示範了同一件事：不同 provider 對「沒回報」與「真的是 0」的處理不一致。本樹的 seam 已明說 **absent ≠ 0**，本輪維持那條。
4. **不保證既有 session 的行為不變**：送上限**會**讓輸出在原本會更長的地方變短。這是這一輪的**目的**，不是副作用——但它是**行為改變**，記錄要這樣寫。

## 5. 殘餘（寫出來，不是藏起來）

- `LLMRequest.model` 仍是死欄位（沒有讀者、沒有生產者）。
- `config.options` 仍可覆蓋 adapter 設定的必填欄位（四個可、bedrock 不可）。
- bedrock 仍收不到 `profile.headers`／`region`／`profile`。
- 五個轉接器都沒有自己的 timeout（契約是 `signal`）。
- `reasoning` 的語意不一致：三個會發的轉接器取自三個**無關**的 wire 概念，其中 openai 的只是 **summary**，而 mock **一個都發不出來**（測試替身覆蓋不到 reasoning 的消費者）。
- `"off"` 在 anthropic／bedrock 仍等於 unset。

## 6. 取樣與自創

| 部分 | 來源 |
|---|---|
| 送輸出上限（值鏈、每 API 的欄位、必填協定的退路） | **取樣**（Pi ＋ DSH，兩者的機制都逐行讀過；使用者裁定照它們做） |
| 「上限是能力還是請求預設」的區分 | **取樣**（DSH 的 `catalog.ts:806-816` 明文寫了理由）——本樹**採用 Pi 的取法**，理由記在 §1.1 |
| 截斷是一等結局 | **取樣**（兩家都有；本樹只取「看得見」那一半） |
| `stream_options` 的閘 | **取樣**（Pi 的 `supportsUsageInStreaming`，預設 true） |
| **請求層缺陷的修法**（system 映射、串流內錯誤、終止符） | **自創**——審計是本樹自己做的，拿到的是一組**沉默失敗**，而兩家參考在這些點上沒有可抄的東西（它們沒有這些洞） |
