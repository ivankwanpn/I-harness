# 合成：一個高命中率、設計合理、代價不高的 prompt 快取設計

**日期：** 2026-09-18 · **分支：** `m65` @ `0f18da2`
**輸入：** 四份獨立調研 —— Claude Code（`D:/cc-custom`）、grok build（`D:/grok-build-main`）、
codex（`D:/codex-rust-v0.154.0`）、opencode（`D:/opencode-1.18.30`）。
**方法：** 按**層**拆開，逐層問「**幾家做、做了什麼、代價多少**」。
每一條都有 `file:line`；我在原始碼親手複驗過的標 **【已驗】**。**四個 repo 都沒有被修改。**

---

## 0. 一句話

**四家在六件事上收斂，其中五件幾乎免費。** 第六件（**摘要／側呼叫重播父前綴**）是唯一一件
**「不做就等於每次壓縮都付一次全額的整個對話」**——三家人做了，一家沒做，而那一家在別的層都很強。
**而「偵測自己的前綴有沒有斷」——四家沒有一家做。**

---

## 1. 收斂表（●=做了 ◐=部分 ○=沒有）

| | cc-custom | grok | codex | opencode |
|---|---|---|---|---|
| **L0 黏性身分鍵** | ○（協議不需要） | ● | ● | ● |
| **L1 確定性序列化 ＋ 排序** | ● | ● | ● | ● |
| **L2 不變的頭、變動推到尾端** | ● | ● | ● | ◐（V1 每天午夜會變） |
| **L3 顯式斷點（每請求重算、不儲存）** | ● | ● | ○（不必） | ● |
| **L4 破壞性路徑要說出來／煞車** | ●（抑制＋清 derived state） | ●（hysteresis ＋ 明說代價） | ○ | ◐（偵測 provider 側 churn） |
| **L5 側呼叫重播父前綴** | ● | ● | ● | **○** |
| **L6 前綴穩定的測試斷言** | ○ | ● | ● | ○ |
| **L7 執行期「前綴變了」偵測器** | ◐（只 system+tools） | ○ | ○ | ○ |
| **L8 provider 回報可見** | ● | ● | ● | ● |

---

## 2. 逐層

### L0 — 一個身分，一個序列化（免費）

**一個對話一個穩定的鍵，不是內容雜湊。**

| 源 | 做法 |
|---|---|
| codex | `prompt_cache_key` = session id；**跨 turn／retry／subagent／fork／壓縮請求都帶著** 【已驗：`core/src/client.rs:504-516`；測試 `core/tests/suite/compact_remote.rs:1340` 斷言壓縮請求與正常請求的 key 相等】 |
| grok | Responses 用 conv id；副呼叫顯式用**父的** key（`side_call.rs:104-132`） |
| opencode | session id → `prompt_cache_key`（openai 系）／`promptCacheKey`（其他）；V2 從 `ses_<64hex>` 推導 |

**共識：鍵是身分，不是內容。** 內容雜湊會在你**想讓它命中**的時候變（重試、續行、fork），
而身分鍵在那些情況下**本來就不該變**。

**⚠️ opencode 的反例值得記住**：它的子代理**開新 session → 新 key → 子代理永遠冷啟動**
（`tool/task.ts:156-212`），而 codex 的子代理**沿用父的 thread id**（測試 `prompt_cache_key.rs:40-157` 釘住）。**同一件事，兩種做法。**

### L1 — 確定性序列化（免費）

工具集**排序**、鍵序**固定**、**不插入時間戳或隨機 id**：

- opencode：`Object.entries(tools).toSorted(...)`（`session/llm/request.ts:184`）、system-context 來源排序（`system-context/registry.ts:40`）
- cc-custom：`assembleToolPool()` 排序（審計 `docs/research/cc-custom-research.md:36`）
- grok：emission order byte-stable（`conversation/responses.rs:3-5`）；**有一個 regression 測試守著「一個先前的排序 bug 打敗了 server 端前綴快取」**（`conversation.rs:4404-4413`）
- codex：`serde_json` 的 `preserve_order` **canary 測試**；以及 **UUIDv5 合成 id**，註解：*"Changing this value would change model-visible IDs and **invalidate prompt caches**"*（`core/src/context_manager/normalize.rs:18-19`）

### L2 — 不變的頭，變動的內容推到尾端（免費）

**四個人都同意：頭不能改。**

| 源 | 機制 | 原文 |
|---|---|---|
| grok | system head 不可變 | *"Invariant: once placed, never replaced (**replacing it would bust the KV-cache prefix**)"*（`conversation.rs:116-118`） |
| opencode V2 | baseline 渲染一次，之後的變更 **append** 成 `ContextUpdated` | `system-context/index.ts:197-215` ＋ `context-epoch.ts:72-77` |
| codex | turn settings 一律**加到尾端** | `prompt_caching.rs:355-441` 斷言 `input2[..input1.len()] == input1` |
| cc-custom | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 之後才是 session 專屬文字 | `constants/prompts.ts:96-97,298-306` |
| grok | 日期不在頭，是尾端的 user turn | `builtins.ts` 對照 |

**opencode V1 是反例**：整個 system message 每請求重組，含 `Today's date: ${new Date().toDateString()}`
—— *"the head is byte-stable within a day and silently changes at midnight."*（`session/system.ts:69-83`）

### L3 — 顯式斷點：每請求重算、**不儲存**（中）

**協議需要它的地方（Anthropic／Bedrock），三家都放，而且都沒把位置存起來。**

| 源 | 放幾個、放哪 | 為什麼 |
|---|---|---|
| cc-custom | 最後一個 system 區塊 ＋ tip ＋ 前一請求的結尾；`skipCacheWrite` 讓側呼叫不寫入 | 覆蓋三種讀取模式 |
| grok | 3 個（同上），**刻意留第 4 個空位** | *"a gateway that turns on automatic caching takes it, **and five is rejected outright**"*（`conversation/messages.rs:36-38`） |
| opencode V2 | 預設 `tools: true, system: true, messages: "latest-user-message"`；**4 個上限，依失效順序分配：`tools → system → messages`** | *"**Tools live highest in the cache hierarchy**"*（`protocols/anthropic-messages.ts:511-514`） |

**兩個可帶走的原則：**
1. **不儲存斷點位置。** 四家都是從當下的陣列重算 —— 所以「歷史被改寫後斷點要更新」這個問題**不存在**。
2. **超過上限時先丟哪個有答案**：opencode 的 `tools → system → messages` 失效順序。

**⚠️ 但四家都有一個共同的洞**：斷點重算之後，如果底下的位元組被改過（opencode 的 prune 把舊工具輸出換成
`"[Old tool result content cleared]"`，`message-v2.ts:293-295`），**新斷點指向的內容 provider 從來沒快取過**。
*"markers are simply recomputed onto the new array."*

### L4 — 破壞性路徑：說出來，或煞車（免費）

**改寫歷史是不可避免的；四家的差別在於「知不知道自己在付什麼」。**

| 源 | 做法 | 原文 |
|---|---|---|
| **grok**（最好） | 圖片逐出加 **hysteresis**：只在真的快 413 時才逐出 | *"Below this threshold every image stays in place so the KV-cache prefix is byte-stable across turns; eviction rewrites earlier turns and busts the prefix cache, so **we only pay that cost when a 413 is actually near**"*（`image_budget.rs:38-60`） |
| grok | 修裁時明說代價 | *"Over budget: strips reasoning (**the prefix cache is lost once we trim**)"*（`session_recap.rs:102`） |
| cc-custom | **抑制已知斷裂的警報**，免得雜訊淹掉真訊號 | *"that's us, not a break"*（`promptCacheBreakDetection.ts:461-469`） |
| cc-custom | 壓縮後**清 derived state**（在一個地方，讓每條壓縮路徑行為一致） | `postCompactCleanup.ts:11-62` |
| opencode | **偵測 provider 側的 churn**（被丟掉的 thinking blocks） | *"Prefix mismatches mean opencode changed history behind a signed block; log them so the churn can be tracked down."*（`processor.ts:438-450`） |
| codex | **幾乎沒有** —— 唯一一條 cache 註解還是錯的（它說「preserve cache」但實際改的是頭部，`compact.rs:317-326`） | — |

**⚠️ opencode 的審計列要更正**：`post-compaction-derived-state-invalidation` **不成立**（全樹 grep 零命中），
`retained-tail-and-window-preserving-compaction` **數字錯**（真的是 2k/15k 與 8k，不是 10k/40k）。

### L5 — 側呼叫重播父前綴 ← **回報最大的一層**（小）

**摘要器讀的是整個對話。它是整個 session 裡單次最大的一次讀取。**

| 源 | 做法 | 原文 |
|---|---|---|
| **grok** | 摘要請求帶**同樣的 tools／images**，指令接在**最後** | *"**Omitting them would shift the entire prefix and force a full prefill on the summarizer call.** Attaching them keeps the request prefix byte-identical to the turn requests so the engine reuses the session's KV cache. **That reuse is the whole point of the verbatim input path.**"* 【已驗】(`session_compact.rs:436-446`) |
| **codex** | 壓縮請求帶**同一個 key** | 【已驗】測試斷言相等（`compact_remote.rs:1340`） |
| **cc-custom** | `CacheSafeParams` 快照精確位元組，供 fork／btw／suggestion／compact 共用 | `utils/forkedAgent.ts:51-86` |
| **opencode** | **不做** —— `tools: {}`, `system: []`, 單一 user 訊息 | `compaction.ts:420-448`（V1）、`core/session/compaction.ts:201-209`（V2） |

**這是四家分歧最大的一層，也是唯一一個「不做就直接多付一個數量級」的。**

### L6 — 斷言，不是偵測器（免費）

| 源 | 機制 |
|---|---|
| codex | `input2[..input1.len()] == input1`（`prompt_caching.rs:355-441`） |
| grok | `assert_prefix_stable` —— *"serialized input of request N must be a prefix of request N+1"*；**明說執行期不強制** |

### L7 — 執行期偵測器（只有一家，而且是**部分**的）

**cc-custom 是唯一有偵測器的**，而它雜湊的是 `system`＋`tools`＋`cache_control`＋beta/effort/extra-body
—— **`messages` 一次都沒被雜湊**（【已驗】`computeHash` 六個呼叫點全部列舉）。
它的設計精髓是**兩半配對**：本地指紋說**為什麼**，provider 的 delta 說**是不是真的**，
再分類成 client change／TTL／server-side。

**其他三家：零。** 沒有一家比較兩次相鄰請求的訊息陣列。

### L8 — provider 回報可見（免費）

**4/4。** 這是唯一所有人都做的事，而且它是**唯一的地面真相**：
本地的任何推論都要跟它對帳。（cc-custom 的 `/cost`、grok 的 status line、codex 的 `"(+ N cached)"`、
opencode 的 TUI context 面板。）

---

## 3. 代價排序 —— 建議的施工順序

| 順序 | 層 | 代價 | 為什麼在這個位置 |
|---|---|---|---|
| **1** | **L5 側呼叫重播** | **小** | 回報最大：摘要器讀整個對話，是一次全額。三家做了 |
| **2** | **L2 不變的頭** | **免費** | 純紀律；而它是「不要自己製造斷裂」 |
| **3** | **L1 確定性序列化** | **免費** | 同上；工具排序 ＋ 不用隨機 id |
| **4** | **L0 黏性身分鍵** | **免費** | 一個欄位；但要**一致**地帶（含子代理，見 opencode 的反例） |
| **5** | **L6 斷言** | **免費** | 守住 2／3／4 不退化 |
| **6** | **L8 provider 回報可見** | **免費** | 前面所有的對帳基準 |
| **7** | **L3 斷點** | **中** | 只在協議要求時做；**不做等於零快取** |
| **8** | **L4 破壞性路徑** | **免費** | hysteresis ＋ 一句註解 |
| — | **L7 偵測器** | **高** | **四家沒有一家做**。先做完 1–8 再回頭問還需不需要 |

**前六項幾乎全部免費，而且它們覆蓋了「自己造成的斷裂」的絕大部分。**

---

## 4. 這份合成**沒有**解決的

- **L3 的斷點數與位置是別人的負載形狀。** grok 放 3 個、opencode 依 `tools→system→messages` 分配 ——
  但那是**它們的** prompt 佈局（工具在不在 system 區塊、有沒有 reasoning siblings）。**換一個佈局就要重推**。
- **L5 的「重播」在文字化之後對不上位元組。** 若摘要器把對話**渲染成文字**塞進一則訊息，
  它與主請求的位元組**不同**，重播就無效。dsh／grok 走的是**真正的訊息陣列**那條路。
  那條路有代價（不能任意裁剪、圖片的處理、被改寫過的 thinking block 可能被 provider 拒絕
  —— grok 為此有 `strip_reasoning`）。
- **沒有一家量給我們看。** 四份報告只有機制，沒有命中率數字（唯一的數字是 cc-custom 的
  *"PR #18143 … caused a **45x spike in cache writes**（92.7% → 61%）"*）。
  **所以「高命中率」在這份文件裡是一個設計論證，不是一個量測結果。**
- **L4 的 hysteresis 閾值怎麼定** —— grok 說「只在 413 真的近了才付」，但沒有公式。
- **L7 到底需不需要。** 四家不做，可能是因為不需要，也可能是因為沒人想到 ——
  **這份調研分不出這兩者。**
