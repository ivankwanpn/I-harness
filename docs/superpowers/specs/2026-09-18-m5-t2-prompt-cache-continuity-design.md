# I-harness M5／T2：prompt 快取的兩半（設計）

**日期：** 2026-09-18 · **分支：** `m65` @ `462c75d` · **分級：M**
**輸入：** 路線圖 `docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md` §3.M5（T2 證據）＋ §5 Q3（「不發明統一 epoch」的判斷）
**方法：** 本文件每一條引用都對 **`462c75d`** 重新量測過。**沒有任何一條是從路線圖或稽核文件繼承的。**

---

## 0. 一句話

路線圖對 T2 的完成定義是：「**快取連續性可從 provider 回報與自己的前綴比對兩方面觀察**」。

量測結果是：**這兩半今天都是零，而且它們的缺口是同一個位置。**

- **provider 回報從未被讀過** —— 六個 adapter 沒有一個讀 `usage`；`cache_read` / `cache_creation` / `cached_tokens` / `prompt_cache` 這組欄位名在 `packages` ＋ `apps` 的原始碼裡**零命中**（§1.2）。
- **我們自己的前綴從未被比對過** —— 全樹沒有任何指紋；唯一序列化 message 陣列的地方是一次 `JSON.stringify` 相等檢查（§2.3）。
- **而缺口的位置是現成的**：seam 的 union 只有五個成員，而**三個 adapter 的註解已經把這個洞寫下來了**，其中一個的字面是 *"a future usage seam slot"*（§2.2）。

**這一項的價值不是省錢，是可見**（路線圖自己寫的）。本文件把「可見」定義成一個**有分母的數字** —— 沒有分母的 `cacheReadTokens: 0` 分不出「零命中」與「沒人回報」，而那正是本 repo 一路在移除的缺陷類別：**一個在缺陷下仍然通過的偵測器**。

---

## 1. 動工前的重量

路線圖 §1.1 要求「任何引用自稽核文件的東西，進 spec 前必須對現行 HEAD 重量」。

### 1.1 「IH 完全沒有 prompt cache 的概念」——**成立，而且比原文更強**

原文的理由是「全 inventory grep `cache` 只得到 instruction 檔的 stat cache、模型發現快取、Windows ACE」。**重量：**

```
grep -rEn "cache_read|cache_creation|cached_tokens|prompt_cache|input_tokens|output_tokens|
           prompt_tokens|completion_tokens|inputTokens|outputTokens|promptTokens|
           completionTokens|cacheRead|cacheCreation" --include="*.ts" packages apps
```

**在 `src` 裡只有一個命中，而且是一句註解**（`packages/llm-bedrock/src/index.ts:227`）。
```
packages/llm-bedrock/src/index.ts:227        ← 註解
packages/llm-bedrock/test/bedrock.test.ts:161 ← 一個餵進去、然後被丟掉的 fixture
```
**所以不是「沒有快取概念」而已：整個 usage 詞彙在生產程式碼裡不存在。**

### 1.2 一個現成的紅燈已經在樹裡

`packages/llm-bedrock/test/bedrock.test.ts:161` 餵的是
`{ metadata: { usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, … } }`，
而 adapter 的處理是**落到 `return []`**。**這是一個已經寫好、今天被靜默吞掉的測試輸入** —— 第一半的 RED 不需要憑空造一個 fixture。

### 1.3 路線圖的取樣歸因——**這一節不重述**，因為它是關於**別人的** repo（dsh 的 `canonical-request-epoch`、cc-custom 的偵測那一半）。本文件只對**我們自己的** HEAD 負責。

---

## 2. 缺口（實測）

### 2.1 六個 adapter，零個讀 usage

seam 的串流詞彙（`packages/llm-seam/src/index.ts:5-10`）只有五個成員，**沒有任何一個與用量有關**：

```ts
export type LLMStreamEvent =
  | { type: "text/chunk"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: { name: string; args: unknown } }
  | { type: "end" }
  | { type: "error"; error: Error }
```

**所以 adapter 即使解析了也無處可放。** 而它們連解析都沒有 —— `anthropic` 的 `handleEvent`（`packages/llm-anthropic/src/index.ts:148-195`）只處理 `content_block_start|delta|stop`，**帶著用量的 `message_start` 與 `message_delta` 直接落到 `:195` 的 `return []`**。

### 2.2 三個 adapter 已經把這個洞寫在自己的註解裡

| 檔案 | 字面 |
|---|---|
| `packages/llm-gemini/src/index.ts:237-241` | `usageMetadata … arrives on the LAST chunk … The LLMStreamEvent vocabulary carries NO usage event … (a future usage seam slot).` |
| `packages/llm-bedrock/src/index.ts:225-229` | `metadata carries the usage snapshot … the seam's LLMStreamEvent vocabulary has NO usage event (same gap as llm-anthropic / llm-gemini), so the wire position is documented here.` |
| `packages/llm-anthropic/src/index.ts:148-195` | （無註解，但行為同上：`return []`） |

**這是這一項最好的一條證據**：缺口不是推論出來的，是**三個獨立的實作者各自撞到、各自記下來的**。它也決定了第一半的形狀 —— **不是發明一個用法，是把一個已經被指名三次的插槽補上。**

### 2.3 我們自己的前綴，從來沒有被比對過

唯一的序列化在 `packages/llm-seam/src/index.ts:228-233`（`assertMessagesFromLog`）：它把 `messages` 與日誌投影各做一次 `JSON.stringify` 再比字串。**那是一個不變式檢查（模型只能看見來自日誌的訊息），不是連續性偵測** —— 它比的是**同一瞬間**的兩份資料，不是**這次與上次**。

**前綴的組裝點只有一個**：`packages/core-agent/src/index.ts:213` 的 `deriveMessages(deps.session)`，每步一次。

**而壓縮改寫前綴的時機是良性的**（這一條讓第二半可以做得比想像中簡單）：壓縮是往 `step/start` 之後、`deriveMessages` 之前跑的（`core-agent/src/index.ts:204` 的 `maybeCompact`、`:209` 的 `enforceBudget`，兩者都在 `:213` 之前），所以**一個請求的前綴有沒有效只在步驟邊界改變，永遠不會在請求中途被改掉**。

---

## 3. 設計

### 3.1 第一半：以 provider 回報為事實

**（a）seam 長出一個成員。** `packages/llm-seam/src/index.ts`：

```ts
export interface LLMUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}
// union 增加：
| { type: "usage"; usage: LLMUsage }
```

**四個決定，每一個都有理由：**

1. **每個欄位都是選填，而且「缺席」不等於「0」。** 一個不回報快取的 provider 必須產生**欄位不存在**的記錄，所以 `cacheReadTokens: 0` 的意思**只會是「對方說零」**。這是本 repo 的既有紀律（M3 spec：「回報 unknown，不要編造一個 0」），而它正好是這一項最容易做錯的地方。

2. **這是欄位名正規化，不是 Q3 禁止的那個抽象。** Q3 禁止的是**「一個 epoch 概念」** —— 一個關於快取結構的語意模型（「第幾代前綴」）。這裡正規化的只有**欄位名**，而且**不對快取結構推論任何事**。seam 已經在做同一件事：`text/chunk` 與 `tool_call` 就是五種線協議的正規化。

3. **不把回報合成一個總數。** 各協議對「`input` 是否已含 cache」的定義不同（Anthropic 的 `input_tokens` **不含** cache 讀寫）。所以每個欄位**獨立回報、獨立累加，永不合成**。合成一個總數會發明一個 Q3 剛剛拒絕的抽象，而且會是錯的。

4. **一個請求可以回報多次，consumer 負責合併。** Anthropic 的 `message_start` 帶輸入側、`message_delta` 帶輸出側；Gemini 的 `usageMetadata` 在最末塊。所以 **adapter 收到就發、不留緩衝狀態**，而**合併在 consumer**。理由：adapter 一旦開始緩衝，就多了一個「什麼時候該吐出來」的狀態機，而那個狀態機在串流被截斷時**沒有正確答案**。

5. **一次「沒跑完的」往返不發出任何東西。** 這一條是實作時才量到的，原本的設計理由（「死了也要留下已知的那一半」）**是錯的**，寫在這裡免得復發：`llm-seam` 的重試包裝是**靜默的**（`core-agent` 看不到它），所以一個失敗後被重試的嘗試如果也發一筆，就會**把分母灌大** —— 而分母是這一項的全部意義。所以 `provider/usage` 只在**串流正常結束**且**至少有一個數字**時發出。**「沒有回報」是誠實的結果** —— 一個被重試的失敗嘗試，從來就不是一次「有回報的往返」。

   **⚠️ 而它必須在兩處強制，不是一處。** 消費者端的「只在正常結束時發出」**擋不住**重試：失敗被包裝吸收之後，`core-agent` 看到的是一次**成功的**串流，只是裡面混了兩個嘗試的報告。這一條的實際強制點因此是 **`createRetryingClient` 自己** —— 它把用量事件**扣住到該次嘗試證明自己跑完為止**，失敗的嘗試那一份直接丟棄。

   **這是一個實測到的缺陷，不是推論**：第一版把用量即時 `yield` 出去，測試量到**一次完成的往返收到兩份報告**（`expected [ {…}, {…} ] to deeply equal [ {…} ]`），而且那個形狀正是最常見的失敗——Anthropic 在 `message_start` 就回報，所以一條早死的連線**回報了用量、卻沒有產生任何其他東西**，`produced` 因此維持 false，重試**靜默**發生，洩漏完全沒有痕跡。

**（b）consumer 端：`core-agent` 合併並發出恰好一筆。** 在 `packages/core-agent/src/index.ts:245` 的 `for await` 內新增：

```ts
case "usage":
  for (const [k, v] of Object.entries(ev.usage)) if (typeof v === "number") merge[k] = v
  break
```

串流結束後，**若且唯若至少收到一個 usage 事件**，發出**一筆** `provider/usage`：

```ts
deps.telemetry?.emit({ type: "provider/usage", ts: Date.now(), data: { step: steps, ...merged } })
```

**「恰好一筆」是設計，不是實作細節**：`snapshot().events["provider/usage"]` 於是**正好是分母** —— 「有幾個請求真的回報了」。有了它，`cacheReadTokens: 0` 才可解讀。

**（c）telemetry code。** `packages/telemetry/src/types.ts` 與 `manifest.ts` 各加 `provider/usage`（domain `provider`，與 `provider/call`／`provider/error` 同域）。

> **⚠️ 閘門約束，不是禮貌：manifest 的規矩是「never a code without a producer」，而 instrument 會把它報成 `producerless-event`。所以 union 成員、event code、生產者必須落在同一個 commit。**

**（d）新的 `reported` 區，而不是併進既有的 `tokens` 區。** `packages/telemetry/src/metrics.ts` 的 `MetricsSnapshot` 增加：

```ts
/** provider 回報的用量，按欄位分開累加。分母是 events["provider/usage"]。 */
reported: Record<string, number>
```

**為什麼不併進 `tokens`**：`tokens` 裝的是**我們自己的估計**（`activeTokens`，`core-agent/src/index.ts:307`），而 `reported` 裝的是**對方說的**。T2 存在的全部理由就是分開這兩件事；把它們放進同一個袋子會**抹掉這個里程碑唯一要建立的區別**。

**（e）`token/usage` 不動。** 它今天的語意是「turn 邊界的估計」，維持不變。回報走新碼。**改一個既有事件的語意，正是這棵樹一直在刪的那種缺陷。**

### 3.2 第二半：以自己的位元組為偵測

**比對的對象是「送出的東西」，不是日誌。** 也就是 `core-agent/src/index.ts:220-231` 組出來的那個 `request.messages`。

**（a）指紋與狀態。** 逐訊息做 canonical JSON 字串，狀態存在 agent closure（`runTurn` 所在的 `createAgent` 作用域，與 `steps`／`callSeq` 同層 —— 它們的既有註解說明了為什麼要跨 turn 存活）。比較的結果是**這次的前綴相對於上一次**：

- `shared` —— 前導**逐位元組相同**的訊息數；
- 一個請求是**純擴張（append）** ⟺ `shared === 上次的 messages.length` 且 `messages.length > shared`。

**（b）沒有上一次時，兩者都不報。** 行程重啟（`--resume`）後的第一個請求**沒有前一次可比**，所以欄位**缺席**，而不是 `shared: 0`。**一個被續行的 session 不可以讀起來像一次退化。**

**（c）可觀測量必須是可加的。** sink 是累加器，所以「最後一次的值」或「分布」不屬於它。`provider/call` 的 data 增加兩個可加欄位：

```ts
{ step, messages, tools, prefixKept, prefixBroke }   // 後兩者只在有前一次時出現
```

`sink` 增加 `prefix` 區：`{ requests, observed, kept, broke }`。
`[metrics]` 行於是印得出 `prefix: broke=2/observed=7` —— 一個**有分母**的數字。

**（d）為什麼掛在 `provider/call` 而不是新碼。** `provider/call` 已經是「一次 provider 往返開始」，而且**已經帶著 `messages: messages.length`**（前綴的大小）。前綴與前一次的關係是**同一族的事實**，掛在別處才是發明。而 sink 本來就認識三種事件形狀（`token/usage` 的數字、`tool/*` 的成敗、其餘的計數），加第四種是**同一個模式**，不是新的抽象。

### 3.3 六個 adapter 的映射（native → normalized）

| adapter | 來源位置 | 對應 |
|---|---|---|
| `llm-anthropic` | `message_start.usage`（輸入側）、`message_delta.usage`（輸出側） | `input_tokens`→`inputTokens`、`cache_read_input_tokens`→`cacheReadTokens`、`cache_creation_input_tokens`→`cacheCreationTokens`、`output_tokens`→`outputTokens` |
| `llm-openai` | `response.completed.response.usage` | `input_tokens`／`output_tokens`／`input_tokens_details.cached_tokens` |
| `llm-openai-compatible` | 尾端 usage-only chunk | `prompt_tokens`／`completion_tokens`／`prompt_cache_hit_tokens` |
| `llm-gemini` | 末塊 `usageMetadata` | `promptTokenCount`／`candidatesTokenCount`／`cachedContentTokenCount` |
| `llm-bedrock` | `metadata.usage` | `inputTokens`／`outputTokens` |

**⚠️ `llm-openai-compatible` 有一個別人都沒有的前置**：這個協議**預設不送 usage**，要 `stream_options: { include_usage: true }`。那是一個**請求形狀的改變**，對不支援它的 gateway 有風險。**所以它是 T2-3 的第一個決定，不是一個順手加上的欄位**（§8）。

---

## 4. 切片與順序

```
T2-1  契約 ＋ 第一半          seam union ＋ provider/usage ＋ core-agent 合併
                              ＋ sink reported 區 ＋ [metrics] 讀者 ＋ anthropic ＋ mock
T2-2  第二半                  前綴比對 ＋ provider/call 欄位 ＋ sink prefix 區
T2-3  其餘 adapter            openai／openai-compatible／gemini／bedrock
                              （openai-compatible 的 stream_options 是它的第一個決定）
```

**為什麼 T2-1 先**：它是契約，而契約決定另外兩個切片長什麼樣。**T2-2 的資料形狀會依賴 `MetricsSnapshot` 在 T2-1 之後的樣子。**

**為什麼 anthropic 是 T2-1 的那一個 adapter**：它的用量**不需要改請求形狀就會到**（`message_start` 無條件送出），而且它是快取語意**最顯式**的協議（顯式斷點），所以 `cacheReadTokens` 在它身上是一個真欄位而不是推測。`llm-mock` 同切片補上，讓測試不必打真網路。

---

## 5. 刻意**不**做

- **不發明統一的 cache epoch**（路線圖 §5 Q3）。正規化的只有欄位名。
- **不把回報與估計合成一個總數。** 各協議對 `input` 是否含 cache 的定義不同。
- **不改 `token/usage` 的語意。** 回報走新碼。
- **不把 redaction／診斷日誌那一半綁進來。** 那是 M3 未完成的兩項，與本項無關。
- **不做 OTLP 匯出**（M3 §5 已裁定）。
- **不取消或重試任何東西。** 這一項只觀察。
- **不保證省到錢** —— 路線圖自己寫的：它保證的是**看得見**。

---

## 6. 介面影響

| 部分 | 影響 |
|---|---|
| `LLMStreamEvent`（`llm-seam`，已發布的 union） | **加法**。但**六個 adapter ＋ 約六個串流 consumer 會重新 typecheck** |
| `provider/usage`（新 telemetry code） | `types.ts` ＋ `manifest.ts` ＋ 生產者**必須同 commit**（閘門會紅） |
| `MetricsSnapshot`（`+reported`、`+prefix`） | **加法**；既有讀者不受影響 |
| `provider/call` 的 data（`+prefixKept`／`+prefixBroke`） | **加法**；既有 sink 只看 `ev.type` |
| `core-agent` 的 step 迴圈 | 一個 `case`（見 §7 的警告） |
| 凍結的 `tui`／`web`／`tui-core` | **零改動** |

---

## 7. 完成定義與如何證明

路線圖的完成定義（兩半都可觀察）＋ 本文件因 M 分級而加的三條：

1. **一次執行之後，`[metrics]` 行同時印得出 provider 回報的欄位與前綴的分母/分子。**
2. **突變：刪掉 `case "usage"` 必須變紅。**
3. **突變：把「沒回報」改成 `0` 必須變紅。** —— 這條是這一項的靈魂：**「沒人回報」絕不可以讀成「回報了零」。**
4. （第二半）**純擴張不紅、壓縮之後紅、行程重啟後的第一個請求兩者皆非。**

**T2-1 的四個突變，實跑結果**（每一個都先改壞、跑、再還原）：

| 突變 | 結果 |
|---|---|
| `case "usage"` 改成不可達（等同刪除） | 3 紅 |
| 無條件發出（把「至少一個數字」的守衛拿掉） | 2 紅 |
| 未回報的欄位補成 `0` | 3 紅 |
| `reported` 併回 `tokens` 那個袋子 | 2 紅 |
| `cache_read_input_tokens` 缺席時補成 `0`（adapter） | 2 紅 |
| `message_start` 不處理（回到舊的 fall-through） | 2 紅 |
| 用量即時 `yield`（拿掉重試包裝的扣留） | 1 紅 |
| mock 不再吐出用量 | 1 紅 |

> **⚠️ 一個真實的失敗模式，寫下來免得被當成細節：`core-agent` 的 `switch (ev.type)`（`:247-273`）沒有 `default`，也沒有窮舉斷言。新增一個 union 成員會被靜默忽略。** 它不會是型別錯誤，也不會是執行期錯誤 —— **它看起來完全像成功**（一切照常，只是永遠沒有數字）。所以第 2 條的突變測試不是禮貌，是唯一能證明那個 `case` 真的在跑的東西。

**測不了、說出來而不是提議一個安慰的測試形狀：**
- **真實 provider 的快取行為** —— 需要真金鑰與真實的前綴重用，這一台主機上不可重現。
- **省了多少錢** —— 見 §5。

---

## 8. 這份設計沒有回答的問題

- **`llm-openai-compatible` 的 `stream_options: { include_usage: true }`** —— 要不要送、送了之後不支援的 gateway 會怎樣，**未量、未決定**。這是 T2-3 的第一個決定。
- **前綴比對的成本** —— 每一步 O(前綴) 的字串化。既有的 `assertMessagesFromLog` **每一步已經做兩次全量 stringify**，這是**結構上的比較，不是量測**。M3 的 harness 可以量它。
- **`provider/usage` 的成本** —— 每個回報的請求多一個事件，未量。
- **前綴中斷與真實快取命中率的相關性** —— 從來沒量過，而這正是兩半合起來才能回答的東西。**在答案出現之前，`broke` 是一個觀察，不是一個結論。**
- **`shared` 的粒度對不對** —— 逐訊息相同是**充分**條件，不是**必要**條件（一個 provider 可以用比訊息更細的邊界切快取）。這一條要等 T2-3 之後才有資料。
