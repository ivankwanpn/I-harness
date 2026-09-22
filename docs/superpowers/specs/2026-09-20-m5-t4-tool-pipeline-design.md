# M5／T4：工具管線 —— 信封、參數 schema、界（設計）

**日期：** 2026-09-20 · **分支：** `d4-endpoint-cache`（`c80ccbb0`）
**性質：** 這份文件是**決定**。每個決定都可檢查；**未決與不做的都標出來了。**
**前置：** `docs/handoff/2026-09-20-queued-work.md` §6（W5 的來源）· `docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md` §M5（完成定義）· `docs/superpowers/specs/2026-09-18-m5-t2-prompt-cache-continuity-design.md`（同一個 M5 的另一半，已交付）
**這不是施工計畫。** 本文件不連任何線；計畫等這份被核准之後才寫。

---

## 0. 為什麼有這份文件

roadmap 對 M5 的完成定義是一句話：

> **每個工具呼叫都在同一處被驗證／設界／可取消。**

三個詞，三種現況 —— **而三者都不是推論出來的**：

| | 現況 | 量到的 |
|---|---|---|
| **可取消** | ✅ **已交付** | `4c85a04`（M5 T4 的兄弟取消：一個失敗的工具呼叫會取消它的兄弟） |
| **驗證** | ❌ **零** | `outputSchema?: unknown`（`core-tools/src/index.ts:14`）**全樹含測試只有 1 處出現 —— 就是那行宣告本身**。`inputSchema` **81 行、30 個檔、60 個真的工具 schema**，而**零處強制** |
| **設界** | ⚠️ **散落，且有一處從未掛上** | `outputSpill` 全樹 **4 處**：宣告（`assembly.ts:175`）、`if (opts.outputSpill)`（`:740`）、`run.ts:174` 與 `:543` 的轉送。**沒有任何呼叫者設它** |

**⇒ 所以「同一處」三個字今天一個都不成立。** 而 roadmap 的字面（「統一的 **tool-result** schema 驗證層」）**比樹本身窄**：結果那一半**零主體**，有主體的是**參數**那一半。這份設計以量測為準，**並把 roadmap 的字面記在 §5 當作被取代的段落。**

---

## 1. 量過的地形

### 1.1 一個「丟出」的工具呼叫，今天產生**零個結果**

這不是我的推論 —— **`packages/fs/src/error.ts:20-31` 自己把它寫下來了**：

> `A THROWING tool body fails the whole turn (core-agent M13/M25: the results of the batch are discarded, no tool/result and no turn/end are appended), so the call just sat in the scrollback with no answer and read as "hung".`

而 `execute-tool-calls.ts` 把這條寫成一條**有名字的裁定**：

> `:45-46` **Failure (throw-fails-turn, ruling A)**: stop starting, drain started calls, rethrow the first error — **NO fabricated results for unstarted calls**.
> `:255` **Failure: drain started (results discarded), rethrow the first error.**
> `:228-229` …**Abort path ONLY** — the non-abort failure path still discards (M13).

**⇒ 所以 IH 的失敗語意是刻意選的，而它的後果被明白地記在隔壁套件裡。** `softFail()`（`fs/src/error.ts:59-71`）是**每一個工具自己實作**的因應 —— 那是慣例，不是管線保證。

### 1.2 接縫**沒有**「錯誤結果」這個通道

`packages/core-session/src/index.ts:385`：

```ts
| { role: "tool"; toolCallId: string; content: string | LLMContentPart[] }
```

**沒有錯誤欄位。** 而 `grep -rn "is_error\|isError" packages/llm-*/src` → **零命中**（五個適配器全部）。

**⇒ 而三個既有的生產者早就都同意「錯誤在文字裡」**：`softFail()` → `{error, code}`；中止合成 → `{error: message}`（`:236`）與 `{error, code}`（`:249`）；崩潰復原 → `repair.ts:44-55` 的兩個 payload。

### 1.3 中止路徑**已經**實作了軟失敗需要的機制

`execute-tool-calls.ts:233-237` —— 替「已開始但沒有輸出」的格子填一筆合成失敗，**理由自己寫著**（`:224-229`）：

> `M51 B3: every STARTED slot that produced no output failed; leaving it undefined stalled the head-of-line cursor forever, so a sibling that had already settled successfully never got a tool/result.`

`:243-251` 替「從未開始」的呼叫填 `TOOL_ABORTED_BEFORE_DISPATCH`（`:7` 的常數）。

**⇒ 這兩段就是軟失敗的全部機制，而它們已經在樹裡、已經有測試、已經在跑。** 失敗路徑缺的只是**不要 rethrow、然後走同一條路**。

### 1.4 參數的方言：IH 用的關鍵字是**十個**，而 dsh 的子集**不是**它的超集

dsh 是 roadmap 指名的取樣來源。它的子集是**九個關鍵字**：

> `json-schema.ts:76-85` `CONSTRAINT_KEYWORDS` = `type, oneOf, properties, required, additionalProperties, items, enum, const` ＋ `ANNOTATION_KEYWORDS = ['description','title','default','examples']`

**而 IH 的 61 個字面宣告普查出來是**（schema 位置，含所有巢狀深度）：

| 關鍵字 | 次數 | | 關鍵字 | 次數 |
|---|---|---|---|---|
| `type` | **220** | | `items` | **9** |
| `properties` | **61** | | `minimum` | **4** |
| `required` | **50** | | `additionalProperties` | **2** |
| `description` | **45** | | `maxItems` | **1** |
| `enum` | **17** | | `maximum` | **1** |

**而以下全部是零**：`oneOf`、`anyOf`、`allOf`、`not`、`const`、`$ref`、`$defs`、`definitions`、`format`、`pattern`（作為關鍵字）、`minLength`、`maxLength`、`minItems`、`uniqueItems`、`multipleOf`、`exclusiveMinimum`、`exclusiveMaximum`、`propertyNames`、`patternProperties`、`prefixItems`、`default`（作為關鍵字）、`title`、`examples`、`if`/`then`/`else`。

> **兩個近乎誤判的已排除**：宣告裡的 `pattern`（2 次）是 `properties: { pattern: … }` 的**屬性名**，不是關鍵字；`default`（4 次）全部是 `description` 字串裡的**散文**。

**⇒ 兩個子集互不包含：**

| | dsh 有、IH 沒有 | IH 有、dsh 沒有 |
|---|---|---|
| | `oneOf`、`const` | `minimum`、`maximum`、`maxItems`、**型別陣列** |

**所以「照 dsh 抄」在兩個方向都會錯** —— 抄過來會禁用 IH 用了六次的數字／長度約束，而 dsh 支援的 `oneOf`／`const` 在 IH **一次都沒用過**。

### 1.5 而**原樣移植 dsh 的斷言層會拒絕 IH 自己的工具**

dsh 有一條明文規則：

> `json-schema.ts:304-306` —— **`type arrays are not supported`**

**而 IH 有這個，而且它是對的用法：**

```ts
// packages/subagent/src/tools.ts:66   ← TS 型別
{ …; fork_turns?: string | number; background?: boolean },

// :77                                  ← JSON Schema 宣告
fork_turns: { type: ["string", "number"], description: "none, all, or N." },

// :118                                 ← 工具本體自己正規化
const turns = parseForkTurns(args.fork_turns)
```

**全樹恰好一處**（`grep -rn 'type: \[' packages/*/src apps/cli/src` → 那一行）。**而 `type` 作為陣列是 JSON Schema 的合法用法**（`agent-team/src/roster.ts:191` 自己寫著它正規化 `"none" | "all" | N`）—— **dsh 禁它是 dsh 的房屋規則。**

**第二個衝突**：`plan-mode/src/index.ts:25` 是

```ts
inputSchema: { type: "object", properties: undefined, required: undefined },
```

**兩個鍵在場、值為 `undefined`**（它的 `description` 自己寫著 `"No arguments."`）。**dsh 的斷言要求 `.properties must be an object of schemas`（`:330`）⇒ 這一條也會被拒。**

**⇒ 所以子集必須由量測決定，不能由抄襲決定。** 這一節就是那個量測。

### 1.6 註冊邊界只有一個，而 MCP 的 schema **不是 IH 寫的**

`packages/core-tools/src/index.ts:177-181`：

```ts
function register(tool: Tool): void {
  if (tools.has(tool.name)) throw new Error(`duplicate tool registration: ${tool.name}`)
  tools.set(tool.name, tool)
}
```

**`inputSchema` 在這裡從未被看過。** 生產程式碼裡 **24 個 `ToolRegistry.register` 呼叫點、17 個檔**。

**而其中一條送進來的是遠端的東西** —— `packages/mcp-client/src/bridge.ts:20`：

```ts
inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
```

值來自 `client.ts:225` 的 MCP `tools/list` 回應，**原樣轉送、零驗證**。

**⇒ 如果 schema 斷言對每一個註冊的工具跑，一個用了 `format` 的第三方 MCP 伺服器會讓 IH 拒絕掛載它** —— 而錯誤訊息會說它的 schema 不合法。**那不是它的 schema 的問題，是 IH 沒有那個關鍵字。**

### 1.7 界：一個宣告了、接線了、而**從來沒有掛上**的護欄

`packages/output-retention/src/spill-guard.ts` 是 dsh spill policy 的移植。**它有自己的測試**（`test/spill-guard.test.ts`，三個掛載點）。**而生產裡零個掛載。**

而它與 dsh 原版有**兩處量到的差異**（兩處都是 dsh 有、IH 沒有）：

| | dsh | IH |
|---|---|---|
| **跳過 `read`** | **有** —— 註解寫明是為了避免 `read → spill → read` 的迴圈 | **零命中**（`grep -n "'read'\|\"read\"" spill-guard.ts` → 空） |
| **替代品不得大於上限** | **有** —— 「the policy NEVER emits a replacement larger than the cap」，超了就放棄、保留原文 | **沒有** —— 只有進入時的 `<= maxBytes`（`:35`、`:43`），而 `kept.text + "\n" + notice` **可以超過它** |

**而第三個差異是形狀上的、也是最重要的**：**dsh 改的是 `content`（模型面的呈現），IH 改的是 `output`** —— 也就是**寫進日誌的東西**。所以打開它改的是**durable 的記錄**，不只是顯示。

---

## 2. 決定 A：**信封** —— 每一個工具呼叫都終於一筆結果（軟失敗）

### 2.1 決定

**失敗路徑走中止路徑已經走過的那條路：**

1. **停止啟動新的呼叫**（不變 —— `:190`、`:208`）
2. **取消在飛的兄弟**（不變 —— `:161-164`，這是 `4c85a04` 的裁定）
3. **`drain` 之後不再 rethrow**（**新**）
4. **失敗的那一格填一筆合成失敗**（新 —— 用 `:233-237` 同一個機制）
5. **已經落地的兄弟照樣 commit 它們真的結果**（新 —— 頭部游標因此能前進）
6. **從未開始的呼叫填一筆結果**（**新** —— 用 `:243-251` 的形狀，但訊息不同，見 §2.3）

### 2.2 為什麼「取消兄弟」與「軟失敗」不衝突

它們是兩件事：

- **取消兄弟**回答「**要不要繼續做**」—— 答案是不（`:161-164`，`4c85a04`）。
- **軟失敗**回答「**已經發生的事要怎麼寫進日誌**」—— 答案是誠實地寫。

**今天失敗路徑兩者都做了一半**：它取消，然後把已經有結果的兄弟**也丟掉**（`:255-256` 的 `throw` 讓 `commitReady` 沒有第二次機會）。**所以 `4c85a04` 的取消今天被自己的後果抵銷掉了** —— 兄弟被取消得**毫無意義**，因為它們的結果不管有沒有落地都會被丟棄。

**⇒ 軟失敗讓取消第一次真的有意義。**

### 2.3 從未開始的呼叫：要填，而`ruling A` 的「不要捏造」仍然成立

`ruling A` 說「**NO fabricated results for unstarted calls**」。**而中止路徑已經替同一批呼叫填了結果**（`:243-251`），**那不叫捏造** —— 那一句是事實陳述（「這個呼叫在派送之前就被中止了」）。

**⇒ 失敗路徑的填法沿用同一個判準，但訊息必須不同**：一個是「被中止」，一個是「被取消，因為同批的兄弟失敗了」。**兩件不同的事不可以共用一句話** —— 那是這條分支一路在消滅的東西。

**⇒ 而這是這一節的界線，必須說準**：它保證的是「**進入批次、而且 `prepare` 成功**的呼叫，每一個都有結果」。**它不保證日誌裡沒有懸空的 `tool/call`** —— 一個被 `prepare` 的政策丟出擋下的呼叫仍然不會有結果（§6.1），而`ruling A` 的「不捏造」在那一種上仍然完全成立（那個呼叫**從來沒有被派送過**，而它也沒有被取消 —— 它是被拒絕的，那是第三件事）。

**⇒ 所以「每一個工具呼叫都有一筆結果」這句話是假的，而這份設計不寫它。** 真的那句是：**每一個被派送的呼叫都有一筆結果。**

### 2.4 代價（接受的）

| | |
|---|---|
| **`ruling A` 被推翻** | 那是一條有名字的裁定。**留痕在 §5，不在這裡默默改掉** |
| **模型現在會看到失敗並可能重試** | 一個真的壞掉的工具會被模型一直重試，而 turn 不會大聲失敗。**緩解**：這是既有的 `softFail()` 行為，現在只是變成管線保證而不是每個工具自己實作 |
| **錯誤變成 tool result 之後會被壓縮／剪枝** | 一條「這個工具壞了」的訊息在長 session 裡會像其他結果一樣被 `compaction/prune` 剪掉 |
| **`agent/post-tool` 的語意** | 今天只對「完成的分派」發（`:107-110` 的註解）。**合成失敗不跑 `finalize`、不發 `post-tool`** —— 沿用中止路徑已定的規則（`:63-64`、`:93-99`） |
| **`tools/post-execute` 因此看不到參數違反** | §3.7.1 的具型錯誤在 `prepare` 就結束了，所以**一個 `tools/post-execute` 監聽者永遠不會看到一筆參數違反**。**這與 dsh 一致**（它明文禁止 post-execute 替一個失敗的結果換值），而代價是：**想在事後觀察畸形呼叫的監聽者要改用 `tools/pre-execute` 或 telemetry**（**← 這半句錯了，見更正**） |

> **更正（2026-09-21，全分支複審量到的）。** 上面最後一格原本的緩解建議是「**想在事後觀察畸形呼叫的監聽者要改用 `tools/pre-execute` 或 telemetry**」，**而兩個管道都到不了**。量到（一筆畸形呼叫、八條計數器全開；這組數字現在由 `packages/core-agent/test/execute-tool-calls.test.ts` 的 §7 pin 釘著）：**`tools/pre-execute` 0 次**（§3.7 的強制點在 emit **之前** —— 那正是它存在的理由）、**`tools/post-execute` 0 次**、**`agent/post-tool` 0 次**、**guard 0 次**、**telemetry 0 筆**（`startCall` 的拒絕分支不發任何遙測）、**工具本體 0 次**。**⇒ 唯一的痕跡是 session log 裡那筆合成的 `tool/result`**（`{ error, code: TOOL_FAILED }`、`synthetic: true`）。**想觀察的人讀那裡；而唯一能「觀察到」的時機是事後讀 log。** §3.7 **本身**照設計實作（強制點就在那裡，順序也對）—— **錯的只有這一格的緩解句。**

### 2.5 **不做**：接縫的錯誤旗標（這一條要寫清楚，因為它最容易被想當然）

**`is_error` 是一個真實存在的東西**（Anthropic 的 `tool_result` 有它，Bedrock 有 `status: error`），**而 IH 的接縫沒有它**（§1.2）。**要加上去就是改訊息型別 ＋ 五個適配器**（其中 Gemini 與兩個 OpenAI 沒有原生旗標）。

**決定：v1 不加。** 理由有三，而第三條是紀律：

1. **模型今天就看得到錯誤** —— `toolResultText`（`core-session/src/index.ts:699-713`）把物件 `JSON.stringify` 成模型可見的文字。**`{error, code}` 已經送達。**
2. **dsh 自己證明了它對模型不是必要的** —— 它的 `isError` 是**給宿主看的**，模型看到的仍然是 `content: [{type:'text', text: "Error: …"}]`。
3. **如果我加了 `isError` 到訊息型別而沒有適配器讀它，那就是這份設計正在消滅的那種欄位** —— 與 `outputSchema`（零讀者）與 `outputSpill`（零呼叫者）**同一個缺陷類別**。

**⇒ 代價寫下來：日誌分不出成功與失敗，除非看形狀。** 而這是**一個可以被下一個單元用一次五適配器改動消掉的代價** —— 不是一個永久的限制。

---

### 2.6 **後補（2026-09-20，實作時量到的）**：cascade 裡的政策否決

**這一節是施工期間才發現的問題，而不是設計時想到的。** 它記在這裡因為**它改了 §2 的形狀**。

**問題**：§2 的分類原本靠**丟出點** —— dispatch 的 `.catch`（工具本體）軟，外層 catch（`prepare` 的拒絕）大聲。**那條線看得見 `prepare`，看不見另一種拒絕：**

`packages/hooks/src/index.ts:343-345` 自己寫著：

> `pre-tool/post-tool → tools/execute cascade wrap (gate)`

**⇒ 一個 `pre-tool` 的否決是在 `dispatch` 裡面丟出的**（`:379-393` 的 `ctx.onCascade("tools/execute", …)` ＋ `runHandlers(…, true)` ⇒ `:295` 的 `throw new HookBlockedError`）。**所以站點規則把它判成「工具本體」，於是它變軟了。**

**量到的**：`packages/hooks/test/hooks.test.ts:358`（*"a pre-tool handler that blocks 'read' fails the agent turn fail-closed"*）轉紅。

**裁定：政策否決維持大聲。** 這**不是新決定** —— §6.1 已經說了「那些是 fail-closed 的安全態勢，不是模型可以重試的東西」，而那句話對一個 `pre-tool` 否決**逐字成立**。**是這一節的機制沒有實作它。**

#### 2.6.1 機制：**一個有名標記**，住在 `core-tools`

**靠 `instanceof` 不行** —— 那會讓 `core-agent` 依賴 `hooks`，而依賴方向是 `hooks → core-tools`、`core-agent → core-tools`，兩者互不依賴（無環，量過）。

**決定：標記住在 `core-tools`**（它擁有 `tools/execute` 這條縫），形狀是**鴨子型別的欄位**：

```ts
// core-tools
/** 一個「你不准做這件事」的拒絕 —— 與「工具試了但失敗」不同。
 *  政策否決維持大聲（spec §2.6）：它們是 fail-closed，不是模型可以重試的東西。 */
export interface PolicyRefusal { readonly policyRefusal: true }
export function isPolicyRefusal(err: unknown): err is PolicyRefusal
```

**`HookBlockedError`（`hooks/src/types.ts:121`）帶上它** —— 它**已經**有 `readonly code = "hook-blocked"`，所以這是把一個既有的意圖變成可檢查的東西。

**⇒ 而失敗模式要寫下來**：**一個將來的政策機制若否決而沒有帶標記，它的否決會變成軟的。** 緩解是這個約定**寫在 spec 裡**（而 block ② 的 `INVALID_ARGS` 也走同一條路 —— 只是它的處置是軟的，因為那一種是**模型可以修**的）。

**⇒ 所以「哪一些拒絕是軟的」由三件事決定，而每一件都是結構性的：**

| 丟出點 | 型別 | 處置 |
|---|---|---|
| `prepare` | 任何 | **大聲**（站點） |
| `dispatch` 的 cascade | **`PolicyRefusal`** | **大聲**（標記） |
| `dispatch` 的 cascade | 其他 | **軟**（預設） |

#### 2.6.2 而它量出了這一塊真正的爆炸半徑

**9 條既有測試轉紅，散在 5 個套件**（計畫原本寫「改寫一條」—— **那是錯的，而錯的方式是低估**）：

| 條數 | 套件 | 是什麼 | 處置 |
|---|---|---|---|
| **1** | `hooks` | `pre-tool` 否決 | **修分類**（§2.6.1）—— 它該維持大聲 |
| **8** | `core-agent`／`sdk`／`session-executor` ×5／`cli` | **工具本體丟出**（`"disk exploded"`、`SKILL_NOT_FOUND` 在 skill 工具裡、role／spawn 在 subagent 工具裡） | **改寫測試** —— 它們編碼的是**被推翻的那條契約**，而它們的**實質主張保留**（「原因必須看得見」），改的是**通道**（結果裡，不是 turn 的失敗） |

**⇒ 而那 8 條的實質主張在新契約下仍然成立，只是換了地方** —— 這正是「改寫而不是刪除」的理由，與 §2 對第一條測試的處置同一條規則。

**⇒ 代價（接受的）**：**block ① 因此跨 5 個套件，不是 1 個。** 計畫的 File Structure 說「只有 `core-agent`」是錯的，而那個錯是**沒有先量爆炸半徑就寫下它**造成的 —— 這條分支一路在消滅的就是這個。

---

## 3. 決定 B：**參數 schema 層** —— 兩層，而子集是量出來的

### 3.1 兩層的分工（dsh 的形狀，理由是它自己寫的）

dsh 的設計有一句是整個移植的負載軸承：

> **unsupported keywords are rejected only if the port also ports the assertion. Port `validateJsonSchemaValue` alone and unknown keywords are silently ignored.**

| 層 | 什麼時候跑 | 對未知關鍵字 | 對誰 |
|---|---|---|---|
| **`validateJsonSchemaValue(schema, value, path): string[]`** | **每一次 `prepare`** | **忽略**（只看它認得的） | **每一個工具，含 MCP** |
| **`assertSupportedJsonSchema(schema)`** | **註冊時，一次** | **拒絕** | **只有 IH 自己寫的 schema** |

**⇒ 兩層的差別不是「嚴格程度」，是「誰訂的契約」。** 值那一層是**全函式**（total）：它對任意值都不拋、不強制轉型，只回一份路徑限定的違反清單。所以它可以安全地跑在遠端送來的 schema 上 —— 它認得的就檢查，不認得的就當作沒宣告。

### 3.2 子集：**十個關鍵字**，逐個有出處

| 關鍵字 | IH 用幾次 | 語意 |
|---|---|---|
| `type` | **220** | 單一字串，**或**型別陣列（§3.4） |
| `properties` | **61** | 只走已宣告的鍵 |
| `required` | **50** | 缺席或缺值都算缺 |
| `description` | **45** | **註解 —— 值那一層不讀** |
| `enum` | **17** | 成員判定 |
| `items` | **9** | 對每一個元素套同一個 schema |
| `minimum` | **4** | 數字下界（`lsp/src/tools.ts:52,53,119,120`） |
| `additionalProperties` | **2** | 一次是 `false`（`core-tools/src/context-remaining.ts:28` 的根）—— **v1 只支援這一種**；另一次是 `{type:"string"}`（`workflow/src/tool.ts:73` 的 `params`）—— **見 §3.6，它會被斷言層拒** |
| `maxItems` | **1** | `interaction/src/index.ts:205` |
| `maximum` | **1** | `web/src/index.ts:100` |

**⇒ 這十個就是上界，而它是完備的**：普查對照過 dsh 全集與常見的 draft-07 關鍵字，**其餘全部是零**。

**⇒ 而 `oneOf` 與 `const` 不在裡面** —— dsh 支援它們，IH 一次都沒用過。**（`additionalProperties` 在 IH 有一處是 `{type:"string"}` 而不是布林，見 §3.5。）**

### 3.3 三個必須沿用的 dsh 決定（它們是對的，而且有理由）

1. **`validateJsonSchemaValue` 回 `string[]`，不回布林、不拋、不轉型。** 路徑限定的字串是可操作的；布林不是。
2. **`integer` 與 `number` 分開。** IH 用 `integer` **恰好 2 次**（`session-query/src/tools.ts:14` 的 `limit`、`:38` 的 `depth`）。
3. **物件與陣列通過之後還要「是無損 JSON」。** 這是 `undefined` 值的屬性、稀疏陣列、迴圈、怪原型被抓到的地方。**`-0`、`NaN`、`Infinity` 不是 JSON 數字。**（**← 最後這半句的 `-0` 錯了，見更正**）

   **更正（2026-09-21，全分支複審量到的）。** 原文寫「**`-0`、`NaN`、`Infinity` 不是 JSON 數字**」，**而 `-0` 那一項與量測相反**：`JSON.parse('{"n":-0}')` **回 `-0`**（`JSON.parse('-0')` 亦然，`Object.is(...)` 為 `true`）—— **`-0` 是 JSON 文法裡的數字**；只有 `NaN` 與 `±Infinity` **沒有 JSON 拼法**。**拒絕 `-0` 的決定不變、也照舊釘著**（`json-schema.ts:434` 的 `isJsonNumber` 以 `Object.is` 排除它，`json-schema.test.ts:22` 斷言它被拒），**理由是它無損不了**：`JSON.stringify(-0)` 是 `"0"`，**它過不了往返**。**⇒ 對的理由是「JSON 載不動它」，不是「JSON 產生不了它」—— 前者對 `-0` 成立，後者只對 `NaN`／`±Infinity` 成立。**

**⇒ 而 IH 不需要 dsh 的跨 realm 防護**（`hasIntrinsicConstructor` 那一套）—— **IH 是單一 realm**，那些測試存在是因為 dsh 在 `runInNewContext` 裡跑。

### 3.4 **擴充一**：型別陣列（`type: ["string","number"]`）

**dsh 拒絕它，IH 用它一次，而那一處是對的用法。**

**決定：支援型別陣列**，語意是「值必須符合其中一個」。**理由**：那個宣告是**合法的 JSON Schema**，而 IH 自己的 TS 型別（`subagent/src/tools.ts:66` 的 `string | number`）與它一致 —— **為了遷就一個驗證器的房屋規則去改一個正確的宣告，是尾巴搖狗。**

**代價：** 子集因此**不是** dsh 的子集，兩邊的差異必須寫在驗證器的檔頭（**這是下一個移植者會踩的地方**）。

### 3.5 **擴充二**：`undefined` 值的關鍵字等於**缺席**

`plan-mode/src/index.ts:25` 是 `{ type: "object", properties: undefined, required: undefined }`。

**決定：值為 `undefined` 的關鍵字當作沒宣告。** 理由與這條分支上已經裁定過的一條**逐字相同** —— W4 的 F1（`c621567c`）：

> **判定鍵在「欄位是否帶著值」，不在「鍵是否存在」。**

**⇒ 同一個規則，同一個理由，只是換了一個檔案。** 而它與 `JSON.stringify` 的行為一致（`undefined` 會被丟掉），所以它也是**持久化之後讀回來的那個形狀**。

**⇒ 因此 `plan-mode` 那一條不需要改** —— 它是「沒有屬性」的合法表達，而驗證器讀出來的正是那個意思。

### 3.6 **擴充三**：`additionalProperties` 是 schema 時**不支援**

IH 有一處是 `additionalProperties: { type: "string" }`（`workflow/src/tool.ts:73` 的 `params` 物件），**不是布林**。

**決定：v1 只支援 `additionalProperties: false`（與 dsh 同）；一個 schema 形式的 `additionalProperties` 在斷言層被拒。**

**為什麼是拒絕而不是支援**：支援它要多一條「對每一個未宣告的鍵套子 schema」的路徑，而 IH **只有一個站點**。**拒絕會讓它大聲失敗，然後我們知道那一站點需要什麼** —— 而「一個大聲的拒絕」比「一個我猜你要什麼的實作」便宜。

**⇒ 這是本設計裡唯一一條會讓既有宣告在斷言層失敗的地方**（除 §1.5 的兩個之外），而它是一個**待辦**，不是一個驚喜：**§9 的 ① 把它列為要一起處理的第三項。**

### 3.6.1 **後補（2026-09-20，施工前量到的）**：§3.6 的「現在知道了」

**§3.6 選「拒絕 `additionalProperties: {schema}`」的理由是：**

> **拒絕會讓它大聲失敗，然後我們知道那一站點需要什麼** —— 而「一個大聲的拒絕」比「一個我猜你要什麼的實作」便宜。

**⇒ 那個問題現在有答案了，而答案是：那個站點需要的是**真的**約束。**

`packages/workflow/src/tool.ts:73`：

```ts
params: { type: "object", additionalProperties: { type: "string" }, description: "Values for the workflow's declared ${param} slots…" },
```

**而 `:91` 把它當 `Record<string, string>` 用**（`deps.executor.runWorkflow(def, args.params ?? {}, …)`，而它的 TS 型別在 `:23` 就是 `params?: Record<string, string>`）。

**⇒ 它的兩個替代方案都更差：**
- **`additionalProperties: false`** ⇒ **錯的** —— `params` 的鍵是工作流程自己宣告的 `${param}` 插槽，**在 schema 的時候是任意的**
- **拿掉 `additionalProperties`** ⇒ **失去「值必須是字串」**，而那不是一個形式主義的約束：一個 `{count: 5}` 會被餵進字串替換

**⇒ 所以：v1 **支援** `additionalProperties: {schema}`。** 它是一條「對每一個未宣告的鍵套這個子 schema」的路徑，而**子集因此多一個分支**。

**⇒ 而這一條的可檢查結果是好的**：**三個既有宣告，一個都不需要遷移。**

| # | 宣告 | 處置 |
|---|---|---|
| 1 | `subagent/src/tools.ts:77` 的型別陣列 | §3.4 支援它 ⇒ **不動** |
| 2 | `plan-mode/src/index.ts:25` 的 `properties: undefined` | §3.5 的規則涵蓋它 ⇒ **不動** |
| 3 | `workflow/src/tool.ts:73` 的 `additionalProperties: {schema}` | **§3.6.1 支援它 ⇒ 不動** |

**這正是 §3.6 那個決定想要的東西** —— **它先拒絕，讓那一站點大聲說出它要什麼，而不是替它猜。** 而答案不是「它寫錯了」。

### 3.7 強制點與**拒絕的語意**

**位置：`prepare()` 裡，`tools.get` 成功的下一步**（`core-tools/src/index.ts:229-231`）。

```ts
const tool = tools.get(call.name)
if (!tool) throw new Error(`unknown tool: ${call.name}`)
// ← 這裡
```

**為什麼在這裡而不是在 registry 外面**：它在**政策之前**，所以**一個畸形的呼叫永遠不會走到審批提示** —— 不會有人被要求批准一坨垃圾。而它對 `guard` 與 `approval` 完全不影響（那些看的是 `call.args`，而 args 沒被動過）。

**違反的處置：一筆軟失敗的結果**（§2）—— **不是一個殺掉整個 turn 的丟出**。訊息要**指名那一個欄位**（dsh 的路徑語法：`"value.nested.line" must be an integer`、`missing required property "path"`、`"tags[1]" must be a string`）。

#### 3.7.1 機制：**一個具型的錯誤**，不是一個新的回傳型別

`prepare()` 的契約是「回 `PreparedCall` 或丟出」。**為了參數違反去改它的回傳型別，會讓每一個呼叫者都要處理一個新的分支。**

**決定：`prepare` 丟一個具型的錯誤**（形狀照 dsh 的 `ToolArgsError`：`code = "INVALID_ARGS"` ＋ `readonly violations: string[]`），**而 `execute-tool-calls.ts` 只把那一種轉成軟失敗。**

```ts
// execute-tool-calls.ts 的 startCall 外圍（今天：prepare 的丟出直接流到 :210 的 catch）
catch (err) {
  if (isArgsViolation(err)) { /* 填一筆軟失敗的結果 */ }
  else throw err            // 其餘全部照舊：殺掉 turn
}
```

**⇒ 這個形狀讓「哪一些拒絕是軟的」變成結構性的，而不是一份清單。** §6.1 的界線（政策拒絕仍然大聲）**因此不需要被記得** —— 它是型別的直接後果。**而「一份要記得的清單」正是這條分支一路上抓到的東西。**

**⇒ 而這是本設計裡最重要的一條一致性**：**參數驗證失敗是一種工具呼叫失敗，而工具呼叫失敗是軟的（§2）。** 兩半是同一個決定。

### 3.8 **MCP 的處置**（§1.6 的解）

**決定：斷言層只對「IH 自己寫的 schema」跑。** 形狀是 `Tool` 上一個**選用欄位**，而它**恰好一個寫者、一個讀者**：

| | |
|---|---|
| **寫者** | `mcp-client/src/bridge.ts:20`（唯一一個把遠端 schema 裝進 `Tool` 的地方） |
| **讀者** | `createToolRegistry.register`（`:177-181`） |

**它不是幽靈欄位** —— 它有一個讀者，而那個讀者就是它存在的理由。

**⇒ 而 MCP 的工具**照樣**拿到值那一層的驗證**（§3.1）：它認得的關鍵字就檢查，不認得的就當作沒宣告。**那比今天好**（今天是完全沒有），**而且它不會拒絕任何一個合法的伺服器。**

### 3.9 代價（接受的）

| | |
|---|---|
| **驗證的成本未量** | 每一次 `prepare` 走一次 schema。**與既有的 `tools/pre-execute` waterfall 同一個量級，而那個已經在每一次呼叫上跑** —— 但**未量** |
| **子集是 IH 的，不是 JSON Schema 的** | 一個新工具用了 `format` 會在**註冊時**失敗。**這是刻意的**（失敗要大聲），但它是一個新人會踩的牆 |
| **`additionalProperties: {schema}` 不支援** | 一個站點（`workflow/src/tool.ts:73`）會失敗，見 §3.6 |
| **參數驗證不覆蓋 `prepare` 的政策丟出** | `unknown tool`／`guard denied`／`denied`／approval-denied **仍然殺掉整個 turn**（`:230`、`:264`、`:267`、`:276`、`:279`，而 `execute-tool-calls.ts:210` 把它們收進 `firstError`）。**那些是政策層的 fail-closed —— 改它們是安全態勢的變更，不是信封的事。** 見 §6 |

---

## 4. 決定 C：**界** —— 把一個從未掛上的護欄掛上（獨立小塊）

**這是 owner 裁定的第三塊，而它是三者裡最小、最可證、也最容易被忽略的一個。**

### 4.1 決定

**在 CLI 掛上 `outputSpill`。** 它已經宣告、已經轉送兩層、**已經有自己的測試**，只是**沒有呼叫者**（§1.7）。

### 4.2 而掛上之前要先補兩個 dsh 有、IH 沒有的東西

| # | 補什麼 | 為什麼 |
|---|---|---|
| **1** | **跳過 `read`** | dsh 的理由逐字適用：不跳會產生 `read → spill → read` 的迴圈 —— **模型為了看被截斷的檔案再去讀一次，然後再被截斷一次** |
| **2** | **替代品不得大於上限** | 今天 `kept.text + "\n" + spillNotice(...)` **可以超過 `maxBytes`**。**一個為了設界而存在、結果自己越界的替代品**，正是這個設計要消滅的形狀 |

### 4.3 而第三件事是**形狀**：它改的是 `output`，不是 `content`

**dsh 的版本改的是模型面的呈現；IH 的版本改的是工具的回傳值** —— 也就是**寫進 `tool/result` 的東西**。

**⇒ 這是一條要明說的取捨**：IH 的形狀讓界**可持久化**（重播時界還在），代價是**日誌裡不再是工具真的回傳的東西**。**這與「日誌是唯一真相」有張力**，所以它必須是**寫下來的決定**，不是一個實作細節。

**⇒ 而它與決定 A 有一條互動，要一起想**：一筆**軟失敗**的結果**不應該被界** —— 錯誤訊息很短，而截斷一個錯誤會讓模型看不到它為什麼失敗。**§7 有一條測試釘這個。**

### 4.4 代價（接受的）

| | |
|---|---|
| **它改變每一個既有工具結果的行為** | 超過 64 KB 的結果會變成 `spill` 信封。**所以它值得自己一條紅線**（owner 的裁定原文：「它會改變每一個工具結果的行為，所以值得自己一條紅線」） |
| **它寫檔到 `<tmpdir>/i-harness-spill`** | 一個新的檔案系統副作用，而 GC 只在**掛載時**跑一次（`spill-guard.ts:25`）—— **長命行程的 GC 時機未量** |
| **散落的界沒有收斂** | §6 明說不做：`shell` 的 64 KB、`exec` 的 64 KB、`web` 的 128 K chars、`compaction` 的 8,192 chars **維持原位** |

---

## 5. 本設計**推翻**的既有決定（留痕，不默默改）

| 在哪 | 原文 | 為什麼不成立 |
|---|---|---|
| **`execute-tool-calls.ts:45-46`** | **Failure (throw-fails-turn, ruling A)** … rethrow the first error — **NO fabricated results for unstarted calls** | **rethrow 那一半被 §2 推翻。**「不捏造」那一半**保留** —— 從未開始的呼叫拿到的是一句**事實**（「因為兄弟失敗而被取消」），不是捏造 |
| **`execute-tool-calls.ts:255`** | **Failure: drain started (results discarded), rethrow the first error.** | 「results discarded」正是 §1.1 記下的那個後果的來源 |
| **`execute-tool-calls.ts:228-229`** | …**Abort path ONLY** — the non-abort failure path still discards (M13). | 那一段的**機制**（填補讓頭部游標前進）本來就該兩條路共用；**被推翻的是它的範圍，不是它的理由** |
| **roadmap §M5 的字面** | 「統一的 **tool-result** schema 驗證層」 | **結果那一半零主體**（`outputSchema` 全樹 1 處，就是宣告）。**有主體的是參數那一半。** 這份設計以量測為準 |
| **dsh 的 `type arrays are not supported`** | `json-schema.ts:304-306` | IH 用它一次（`subagent/src/tools.ts:77`），而那一處是合法的 JSON Schema。**見 §3.4** |
| **dsh 的 `.properties must be an object of schemas`** | `json-schema.ts:330` | IH 有一處是 `properties: undefined`（`plan-mode/src/index.ts:25`）。**見 §3.5** |

---

## 6. 不做、與留給計畫的

### 6.1 不做（附代價）

- **接縫的錯誤旗標**（`is_error` / `status: error`）—— 見 §2.5。**代價：日誌分不出成功與失敗，除非看形狀。**
- **`outputSchema` 的強制** —— **零主體。** 要它有意義得先**遷移 30 個檔的工具去宣告輸出 schema**，那是另一個量級。**而 roadmap 的「完成定義」不含它**（它說的是「被驗證」，而參數就是被驗證的那個面）。
- **`prepare()` 的政策丟出改成軟的** —— `unknown tool`／`guard denied`／`denied`／approval-denied。**那些是 fail-closed 的安全態勢**，把它們變軟是一個**要單獨裁定的問題**，不是信封的副作用。**代價：模型仍然看不到「我被拒絕了」，而 turn 仍然會因為一次拒絕而整個失敗。**
- **把散落的界收斂到同一處** —— `shell` 64 KB、`exec` 64 KB、`web` 128 K chars、`compaction` 8,192 chars **維持原位**。**它們服務不同的東西**（shell 保留、exec 記憶體、web 擷取、壓縮剪枝），把它們併成一個常數會讓四個不同的東西假裝是同一個。
- **dsh 的跨 realm 防護** —— IH 是單一 realm（§3.3）。
- **dsh 的 `value` / `content` 分離** —— IH 的 `output` **同時是**回傳值與模型可見的文字（`toolResultText`）。**拆開它是動每一個工具 ＋ 每一個既有的日誌**，而且**它不是本設計任何一條缺陷的成因**。

### 6.2 留給計畫

- **違反清單的路徑語法**（沿用 dsh 的 `value.nested.line` ／ `tags[1]` ／ `missing required property "path"` —— 但根標籤要不要叫 `arguments` 是計畫的事）
- **驗證器住在哪個套件**（`core-tools` 內部？一個新的 `tool-schema`？）—— **它不能住在 `core-tools` 之外**，因為 `prepare` 要用它，而那會是循環依賴
- **`Tool` 上那個標記遠端 schema 的欄位叫什麼**
- **`outputSpill` 在 CLI 的預設值與旗標名** —— **注意它有一個「缺席即不掛」的既有語意**（`assembly.ts:740` 的 `if (opts.outputSpill)`），所以「預設打開」意味著**呼叫者要主動傳一個空物件**，那是刻意的還是彆扭的，是計畫要處理的
- **`additionalProperties: {schema}` 那一站點的處置**（§3.6）
- **`minimum`/`maximum`/`maxItems` 的違反訊息措辭**

---

## 7. 測試

| 對象 | 測什麼 |
|---|---|
| **§2 的信封（頭號突變目標）** | **一個丟出的工具呼叫產生恰好一筆 `tool/result`**；**同一批裡已經落地的兄弟仍然 commit 它們真的結果**；**從未開始的呼叫拿到的訊息與「被中止」那一個不同**；把 rethrow 加回去 ⇒ 必須紅 |
| **§2 的取消仍然成立** | 一個失敗仍然**取消在飛的兄弟**（`4c85a04` 的行為不變）—— **把 `batchAbort.abort()` 拿掉 ⇒ 必須紅** |
| **§2 的誠實性** | **每一個 `tool/call` 都有對應的 `tool/result`** —— 這條要用 `deriveMessages` 的輸出斷言（**不是**掃日誌），因為那才是模型真的看到的東西 |
| **§2.5 的邊界** | `tool/result` **不帶**任何錯誤旗標（v1 的決定）—— **加了 ⇒ 必須紅**，因為那會是一個零讀者的欄位 |
| **§3.2 的子集** | 61 個字面宣告**全部通過斷言** —— 用**註冊真實 registry** 的方式跑，不是讀原始碼 |
| **§3.4 的擴充一** | `type: ["string","number"]` 接受 `"3"` 與 `3`，**拒絕** `true` 與 `{}`；把型別陣列改成「取第一個」⇒ 必須紅 |
| **§3.5 的擴充二** | `properties: undefined` 通過斷言，且**語意等於沒有 properties** —— 一個 `{type:"object", properties: undefined}` 接受 `{}` 也接受 `{x:1}` |
| **§3.7 的位置** | **一個畸形的參數永遠走不到審批提示** —— 用一個 `ask` 政策 ＋ 一個畸形呼叫斷言 answerer **零次被呼叫** |
| **§3.7.1 的結構性** | **只有** `INVALID_ARGS` 被轉成軟失敗 —— 一個 `guard denied` 在同一條路徑上仍然殺 turn（兩個都要斷言，因為只測一邊就證明不了「分開」，而那正是 §6.1 的界線靠什麼成立的） |
| **§3.8 的 MCP** | 一個 schema 用了未知關鍵字的工具**照樣註冊成功**，而**它認得的那些關鍵字仍然被檢查** —— 兩個 assert 都要有，因為只測一邊就證明不了「分開」 |
| **§4.2 的兩個補丁** | `read` 不被界（⇒ 紅）；**替代品的位元組數永遠 ≤ 上限**（餵一個 notice 很長的情形） |
| **§4.3 的互動** | **一筆軟失敗的結果不被界**（錯誤訊息完整到達模型） |
| **驗證器的全函式性** | 對任意（值, schema）配對**不拋** —— 遍歷一組對抗性輸入（`undefined`、`null`、迴圈、`NaN`、`-0`、代理） |

---

## 8. 與既有決定的關係

| 既有 | 狀態 |
|---|---|
| **`4c85a04`（M5 T4 的兄弟取消）** | **不動，而且第一次真的有意義** —— §2.2 |
| **`tool/dispatch`（M4，`core-session/src/index.ts:16-23`）** | **不動。** 它的註解自己寫著它存在的理由就是分辨「從未派送」與「派送了、下落不明」—— **而 §2 讓後者變得更少** |
| **`softFail()`（`fs/src/error.ts:59-71`）** | **不動。** 它從「每個工具自己實作的因應」變成「管線的保證」—— **既有呼叫者一行不改** |
| **`tools/pre-execute` / `tools/post-execute` 兩個 waterfall** | **不動。** 參數驗證**在 `pre-execute` 之前**（§3.7） |
| **`finalize` / `agent/post-tool` 的順序裁定（M10a）** | **不動。** 合成失敗沿用中止路徑已定的「不跑 finalize、不發 post-tool」 |
| **`Tool.outputSchema`** | **不動、仍然零讀者** —— 而 §6.1 明說這一項不做它，**所以它繼續是一個幽靈欄位**。**這是一個要留給 backlog 的事實，不是這份設計的成就** |
| **M13 的頭部游標（`commitReady`）** | **不動。** §2 只是讓失敗路徑也走到它 |
| **`createOutputSpillGuard`** | **第一次在生產裡被掛上**（§4） |

---

## 9. 施工順序（**計畫**等這份被核准之後才寫；這裡只給相依順序）

```
① 信封（`core-agent`，可單獨紅綠）
   a. 失敗路徑不再 rethrow：填補失敗那一格 ＋ 讓落地的兄弟 commit
   b. 從未開始的呼叫填一筆「因兄弟失敗而被取消」（訊息與「被中止」不同）
   （兩者共用 `:233-237` 與 `:243-251` 已經在跑的機制）

② schema 層（新套件或 `core-tools` 內，可單獨紅綠）
   a. `validateJsonSchemaValue`：全函式、回 `string[]`、子集十個關鍵字、
      型別陣列（§3.4）、`undefined` 值等於缺席（§3.5）
   b. `assertSupportedJsonSchema`：註冊時一次；`additionalProperties: {schema}` 被拒（§3.6）
   c. 掛進 `register` ＋ MCP 的標記（§3.8）
   d. 掛進 `prepare`，位置在 `tools.get` 之後、政策之前（§3.7）；
      違反丟 `INVALID_ARGS`，而 `execute-tool-calls` 只把那一種
      轉成 ①的軟失敗（§3.7.1）—— **②d 是 ① 與 ② 的黏合點**

③ 界（`output-retention` ＋ CLI，可單獨紅綠）
   a. 跳過 `read`（§4.2-1）
   b. 替代品不得大於上限（§4.2-2）
   c. 在 CLI 掛上並釘住（§4.1）

④ 一起處理的三個既有宣告（在 ②b 之前必須決定，否則註冊會失敗）
   • `subagent/src/tools.ts:77` 的型別陣列 → ②a 支援它，所以不動
   • `plan-mode/src/index.ts:25` 的 `properties: undefined` → ②a 的規則涵蓋它，所以不動
   • `workflow/src/tool.ts:73` 的 `additionalProperties: {type:"string"}` → **②b 會拒它**，
     所以這一條要**在 ②b 之前**決定：遷移它，或支援它
```

**①②③ 可以分開出貨** —— 它們碰不同的套件，而且各自有獨立的紅線。
**⇒ 而 ① 是唯一一個修補當下使用者可見缺陷的**（§1.1 的「讀起來像掛住」），**所以它是第一個。**

**① 與 ② 的接縫**：②d 的違反要變成一筆軟失敗 —— **那條路只有在 ① 落地之後才存在。** 所以 **① 必須先完成**，而 ②d 是兩者的黏合點。

**這正是 backlog 說「W5 未開始、無阻塞」的理由**（`docs/handoff/2026-09-20-queued-work.md` §1）。
