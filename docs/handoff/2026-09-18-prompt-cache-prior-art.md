# prompt 快取連續性 —— 四源調研（2026-09-18）

**問的是什麼**：路線圖 §3.M5 的 T2 說「快取連續性可從 provider 回報與**自己的前綴比對**兩方面觀察」。
第一半已經做完（`bd3a26d`）。這份文件問的是**第二半該長什麼樣**：別人有沒有做？做了什麼？

**方法**：四個唯讀參考專案，各派一個獨立代理、各自回報 `file:line`；**本文件每一條載重的主張都由我對原始碼重新驗證過**，
驗證指令與結果寫在對應段落。四個專案都不是我方程式碼，**沒有修改任何檔案**。

---

## 1. 三個出貨產品，零個「訊息前綴偵測器」

| | 偵測自己的位元組 | provider 回報 | 避免斷裂 |
|---|---|---|---|
| **cc-custom** | ✅ 雜湊 `system` ＋ `tools` ＋ `cache_control` ＋ beta/effort/extra-body —— **`messages` 一次都沒被雜湊** | ✅ 極廣（analytics／OTel／cost／`/cost` UI／Perfetto） | ✅ 極多（見 §4） |
| **dsh** | ❌ 零雜湊 | ✅ 讀、顯示「Cache hit %」、**沒有消費者用它做決定** | ✅ 結構性（見 §3） |
| **codex-rust** | ❌ 只有 identity 的 `prompt_cache_key`（＝ session id） | ✅ 極廣，**零決策**；壓縮後**歸零並改成估計值** | ✅ 最強（見 §3） |
| **grok-build** | ❌ 零指紋 | ✅ 三個協議都讀進同一個 `TokenUsage` | ✅ 紀律 ＋ **測試斷言**（見 §3） |

**這張表就是這一節的結論：四家沒有任一家做「這次送出的 `messages` 和上次一不一樣」。**
最接近的 cc-custom **刻意停在 `system`＋`tools`**。

**驗證（cc-custom）**：`computeHash` 的六個呼叫點全部列舉過 ——
`src/services/api/promptCacheBreakDetection.ts:188,267,268,272,287` 分別是逐工具、`strippedSystem`、
`strippedTools`、`cache_control`、`extraBodyParams`。**`messages` 不在其中**；它只被用來取最後一則
assistant 訊息的時間戳（`:446-451`）。

**而且 cc-custom 對已知的斷裂是「抑制警報」而不是「偵測」**：`notifyCompaction()`（`:672-681`）把
`prevCacheReadTokens` 設成 `null`，讓下一次的低命中**不被當成異常**。它的註解說得很直白：
*"We just changed the prompt content — the next response's cache read will be low, but that's us, not a break."*

---

## 2. 我們自己的審計捏造了一個識別字

路線圖 §3.M5 的取樣依據寫著 **`canonical-request-epoch`（dsh）**。

**這個識別字不存在。**

```
grep -rn "canonical-request-epoch|canonicalRequest|canonical_request|cacheEpoch|CacheEpoch|requestEpoch" \
     --include="*.ts" --include="*.md" --include="*.json" .   →  No matches found
```

真正存在的是兩個相鄰但不同的名字：

| 真名 | 是什麼 | 位置 |
|---|---|---|
| `EpochHeader` | 一個**記錄**：`{config, adapterDefaults?, tools?}` —— 「衍生歷史**之外**會變的東西」的快照。**不是**計數器、雜湊或時間戳 | `packages/core/session/src/types.ts:232-239` |
| `canonicalHeader()` | 只做一件事：**拿掉空的可選欄位**，讓寫方與讀方對同一個表示法有共識。**不排序、不剝 volatile、不碰 `messages`** | `packages/core/session/src/request-header.ts:21-30` |

它被記成 session 事件 `request/header`，`reason` ∈ `initial` | `resume` | `change` | `series`
（`packages/core/agent-loop/src/agent.ts:562-581`）。**沒有任何「epoch 數」被遞增或比較。**

**這一條要進路線圖的更正** —— 一份自稱量出來的文件，引用了不存在的識別字。

---

## 3. 三家的共同答案：把穩定變成**斷言**，不是偵測器

| 源 | 機制 | 位置 |
|---|---|---|
| **codex** | 測試斷言 **`input2[..input1.len()] == input1`** | `core/tests/suite/prompt_caching.rs:355-441` |
| **grok** | 測試輔助 **`assert_prefix_stable`** —— *"serialized input of request N must be a prefix of request N+1"* | `xai-grok-sampling-types/src/conversation/test_support.rs:201-226` |
| **dsh** | **結構性**：append-only 日誌 ＋ 逐節點純函數投影 | `.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md:19` |

dsh 的立場原文（**已逐字驗證**）：

> *"Prefix-cache stability is corollary #1, not the headline: an append-only log projected by a per-node pure
> function yields requests that are append-extensions of their predecessors whenever the header is unchanged —
> **stability is emergent, not managed**."*

**grok 明確說這是測試而不是執行期**：*"Nothing enforces this at runtime — a regression would be caught by tests, not by the harness."*

### ⚠️ 而 IH 已經有 dsh 那個結構

IH 的日誌是 append-only，模型可見訊息是 `deriveMessages(session)` 的**純函數投影**（`core-session/src/index.ts:387-555`），
組裝點只有一個（`core-agent/src/index.ts:213`）。**所以 IH 在「什麼都不改寫」的情況下，前綴本來就是延伸的。**

**唯一打破它的是壓縮的 shadowing**（`compaction/*` 附上 shadow 標記 → `deriveMessages` 在 `:419-433` 收起它們，
並在 `:489-491` 按 log 順序注入一則 `user` 摘要）。**一個打破點，不是一堆。**

---

## 4. 「避免」那一欄，才是四家真正花力氣的地方

只列**有程式碼或測試**的，且標出機制：

### cc-custom
- 工具集**排序後**再送出（`assembleToolPool()`，`docs/research/cc-custom-research.md:36`）
- 臨時檔路徑用**內容雜湊**而不是 UUID —— 註解：*"because a random UUID would … invalidate the prompt cache prefix"*（`utils/tempfile.ts:10-16`）
- **整段移除** billing-header fingerprint，因為它 *"changed the prefix hash on every request and destroyed prompt cache hit rates"*（`constants/system.ts:48-64`）
- 工具結果替換凍結成 *"guaranteed byte-identical"* 的預覽（`utils/toolResultStorage.ts:402-447`）
- **一個實測到的回歸**：*"PR #18143 tried effort:'low' and caused a **45x spike in cache writes**（92.7% → 61% hit rate）"*（`services/PromptSuggestion/promptSuggestion.ts:295-315`）

### grok（最會「付代價時說出來」的一家）
- `image_budget.rs:38-60` —— **四份文件裡最好的一段註解**：
  > *"Below this threshold every image stays in place so the KV-cache prefix is byte-stable across turns;
  > eviction rewrites earlier turns and busts the prefix cache, so we only pay that cost when a 413 is actually near."*
- `session_recap.rs:102`：*"Over budget: strips reasoning (**the prefix cache is lost once we trim**)"*
- 系統提示不可變：*"Invariant: once placed, never replaced (**replacing it would bust the KV-cache prefix**)"*（`conversation.rs:116-118`）
- 副呼叫**刻意重播父前綴**；`prompt_cache_key` 用父的；effort 必須一致，否則 *"would share no prefix with the main turn"*
- **Anthropic `cache_control` 斷點每請求重算**（3 個：最後一個 system 區塊、tip、前一請求的結尾），
  且**刻意留第 4 個空位**給 gateway 的自動快取（`conversation/messages.rs:36-67`）

### codex
- **`AGENTS.md:91-98` 是明文審查規則**：
  > *"1. No history rewrite - the context must be built up incrementally.
  > 2. Avoid frequent changes to context that cause cache misses."*
- `prompt_cache_key` 跨 turn／retry／subagent／fork**以及壓縮請求本身**都帶著（測試釘住）
- **`BodyAfterPrefix`**：自動壓縮只計算「前綴之後的成長」，所以不變的前綴不會把 session 推向壓縮
- **transport 層最強的檢查**：Responses-over-WebSocket 只在「非 input 欄位不變**且**新 input 是舊 input 的嚴格延伸」時才送 delta（`core/src/client.rs:1331-1373`）；不符就**整份重送**

### dsh
- 摘要器**重播 byte-prefix**：`buildSummarizationInput` 重建上次路由請求的可快取前綴，
  指令接在最後 —— 註解：*"the call is a genuine prefix of the conversation and **reuses the provider's KV cache**"*（`compaction-basic/src/region.ts:516-545`）
- `systemPromptUpdate: 'in-history'`：**改變的系統提示附加在已快取歷史之後，而不是改寫 message 0**（`runtime-context.ts:88-95`）
- 時間文字**排除在 header 之外**，並且有不變式擋住順序：`if (requestStarted) fail('time-context reading must precede request/header')`

---

## 5. ⚠️ 路線圖前提的更正：IH 在 Anthropic 上根本沒有快取

**量測**：`grep -rn "cache_control|cacheControl|prompt_cache|promptCacheKey" --include="*.ts" packages apps` → **零命中**。

而 Anthropic 的快取**需要顯式 `cache_control` 斷點**（grok 的實作就是證明：它必須自己放 3 個）。
所以：

| 協議 | IH 今天的快取狀態 |
|---|---|
| **Anthropic** | **不存在。** 沒有斷點就沒有快取 —— 每一個請求都付全額，不是「壓縮後才付全額」 |
| **DeepSeek／OpenAI-compatible** | 自動前綴匹配 → **路線圖的前提成立**（這是我們實際用的） |
| **OpenAI Responses** | 自動快取；`prompt_cache_key` 可選（codex 用它路由） |
| **Gemini** | 隱式快取 |

**所以路線圖 §3.M5 的「長 session 不再在每次壓縮後默默付全額」要分成兩句**：
對自動前綴的協議成立；對 Anthropic **它比描述的更糟** —— 那裡沒有快取可以失去。

---

## 6. 這份調研**沒有**回答的

- **`cache_control` 斷點該放哪裡**（若要做）—— grok 放了 3 個並說明理由，但那是**它的**負載形狀；
  IH 的（工具在 `body.tools`、系統提示在 `body.system`、無 reasoning siblings）不同，**未量**。
- **各家實際的快取命中率** —— 四份報告都只有機制，沒有數字（除了 cc-custom 那個 45x 回歸）。
- **`prompt_cache_key` 對 DeepSeek 有沒有用** —— 未量。DeepSeek 是自動前綴匹配，可能不需要。
- **cp-custom 的偵測器為什麼不含 `messages`** —— 程式碼沒說。最可能是**成本**（歷史很長，逐請求雜湊很貴），
  但這是推測，**不是量測**。
