# T2 的第二半（「自己的前綴比對」）—— 設計報告

**日期：** 2026-09-18 · **分支：** `m65` @ `ee52214`
**前置：** 四源調研在 `docs/handoff/2026-09-18-prompt-cache-prior-art.md`（`ee52214`）；T2 第一半在 `bd3a26d`。
**這份文件的角色**：在動手之前把**選項**和**證據**攤開。**它不是 spec，也還沒有決定。**

---

## 0. 一句話

**量完之後，我原本的草案是退化的。** IH 的前綴在壓縮時**恆斷在 index 0**（兩個情境實測），
所以「逐位元組比對 messages」的輸出是一個**常數** —— 它每次都說同一句話，而那句話日誌已經說了。
**四個出貨專案裡沒有一家做這件事**，三家把穩定變成**斷言**。所以建議換形狀。

---

## 1. IH 自己量到的 —— 這一節是這份報告的主體

### 1.1 壓縮**一定**斷在 index 0

探針：`.superpowers/sdd/probe-prefix-break.mts`（gitignored）。形狀是 12 輪、每輪含 user／tool-call／
tool-result／assistant，然後**強制壓縮**，前後各做一次 `deriveMessages` 並逐則比對。

| 情境 | 壓縮前 | 壓縮後 | 被 shadow 的 seq | **共享的前導訊息** |
|---|---|---|---|---|
| `compact()`（預設） | 36 | **1** | 85 | **0** |
| `compact({retainTokens: 300})` | 36 | 6 | 74 | **0** |

**保留尾巴沒有幫助。** 原因是結構性的，不是探針的形狀：

1. `selectShadowableRange`（`packages/compaction/src/region.ts:18-40`）**從前面走**
   （`for (const ev of session.events)`），被 shadow 的**必定是一個前綴**；
2. 摘要在 `deriveMessages` 裡按 **log 順序**注入（`packages/core-session/src/index.ts:489-491`），
   而它的 seq 在被 shadow 前綴的**後面**；
3. 所以推導出來的陣列恆為 **`[摘要] + [存活的尾巴]`** —— **訊息 0 永遠是那則新摘要**。

**而這不是 IH 的 bug，是前綴快取的本質。** 快取從請求的**開頭**逐位元組匹配，所以
**任何從開頭移除東西的改寫，都必然讓整段快取失效** —— 不只是被移除的那一段。
保留 6 則尾巴沒有救回任何快取，因為那 6 則的**位置**變了。

### 1.2 所以「逐位元組比對」的輸出是常數

一個每次壓縮都回報 `shared = 0` 的偵測器，**資訊量等於「壓縮跑過了」**。
代價是每步 O(前綴) 的序列化，換來一句日誌已經寫過的話。**這是退化的。**

（它仍然能分辨「壓縮造成的斷裂」與「其他原因」—— 但見 §1.4：其他原因在訊息陣列上**看不到**。）

### 1.3 兩次壓縮之間，append 性質**是**成立的（同一個探針）

```
next request extends it? : shared=1  after=1  next=2  →  YES
```

**IH 的結構本來就是好的。** append-only 日誌 ＋ `deriveMessages` 純函數投影 ＋ 單一組裝點
（`core-agent/src/index.ts:213`）—— 這正是 dsh 說的 *"stability is emergent, not managed"* 的前提。
**唯一打斷它的就是壓縮**（以及共用同一個 shadow 機制的 prune 與 rewind，`core-session/src/index.ts:419-433`）。

### 1.4 有一類斷裂**不在訊息陣列裡**

IH 的系統提示是**請求的獨立欄位**，不是訊息 0：

```
packages/llm-anthropic/src/index.ts:126-129
  const body = { …, system: request.systemPrompt, messages: messages.map(…) }
```

而它是**每步重讀的函式**（`core-agent/src/index.ts:223`），由 `systemPromptNow()` 提供 ——
沙箱模式一變就換字串（`session-executor/src/assembly.ts:797-804`）。
**那會讓整個前綴失效，但在 `messages` 陣列上完全看不到。**
→ 所以**逐位元組比對 messages 連這一類都抓不到**，而它的成本還照付。

---

## 2. 四個出貨專案讀到的

（完整版在 `docs/handoff/2026-09-18-prompt-cache-prior-art.md`；這裡只放會影響決定的三條。）

**① 零個 message-prefix 偵測器。** cc-custom 最接近，但它雜湊的是 `system`＋`tools`＋`cache_control`
＋beta/effort/extra-body，**`messages` 一次都沒被雜湊**；而且它對已知的斷裂是**抑制警報**
（`notifyCompaction()` 把 `prevCacheReadTokens` 設成 `null`），不是偵測。dsh／codex／grok 三家**零指紋**。

**② 三家的共同答案是把穩定變成斷言，不是偵測器。**

| 源 | 機制 |
|---|---|
| codex | 測試斷言 **`input2[..input1.len()] == input1`**（`core/tests/suite/prompt_caching.rs:355-441`） |
| grok | **`assert_prefix_stable`** —— *"request N 的序列化必須是 N+1 的前綴"*，且**明說執行期不強制** |
| dsh | 結構性 —— append-only ＋ 純函數投影 |

**③ 你的資料點把這一節的證據補上了。** 你說 **dsh 在 DeepSeek 上命中率很高** ——
那正是「湧現」在真實負載下成立的直接證據，而且你是**透過 dsh 的 provider 回報顯示**看到的
（`token-meter` → UI 的 "Cache hit %"），也就是 T2 的兩半在真實使用中是什麼樣子。

**由此有一個可檢驗的預測**：IH 的結構與 dsh 同型（§1.3），
**所以在 IH 上、在 DeepSeek 上，命中率應該也高** —— 而損失**集中在壓縮那一步**。
這個預測**還沒量**（需要真金鑰），但它不是推論，是從結構相同推出來的。

---

## 3. 選項（重排之後）

| | 做什麼 | 成本 | 對 IH 的資訊量 |
|---|---|---|---|
| **A** | **結構標記 ＋ 請求面小指紋** —— 看日誌上有沒有改寫標記（壓縮/prune/rewind 共用 shadow），加上 `system`＋`tools` 的指紋 | 近零 | **高**：能**指名原因**，而且 §1.4 那一類只有它抓得到 |
| **B** | 逐位元組比對 `messages`（我原本的草案） | 每步 O(前綴) | **零** —— §1.2 實測退化，且 §1.4 抓不到 |
| **C** | 只做測試斷言（`assert_prefix_stable`），不做執行期 | 近零 | 開發期；覆蓋不到 resume／中途改模式 |
| **D** | 先做 Anthropic 的 `cache_control` 斷點（調研 §5） | 未量 | 對 Anthropic 才是根本問題 |

**建議：A ＋ C，不做 B。**

- **不做 B**：唯一能支持它的理由是「沒有前人做」—— 那不叫理由。而**實測顯示它的輸出是常數**，
  且抓不到 §1.4 那一類。**四家不做它，可能是對的。**
- **做 A**：它和 B 回答同一個問題（「這次的請求面是不是延伸」），但用**結構**回答而不是**位元組**，
  所以便宜、且能指名原因。cc-custom 的形狀（小指紋）加上 IH 特有的那一半（改寫標記）。
- **做 C**：codex 與 grok 都證明它便宜，而且它是**防止退化**的閘門 —— 不是取代 A。

**⚠️ 但 A 有一個 cc-custom 沒有的問題：它會回報「已知會發生的事」。** 壓縮一定斷前綴，
所以每一次壓縮都會產生一條記錄。**那不是缺陷，是設計**：grok 的註解寫得很清楚 ——
*"we only pay that cost when a 413 is actually near"* ——
**要知道自己什麼時候付了這個代價，才有辦法討論該不該在那一刻付。** 而 T2-1 剛剛讓那個代價
**可以量**（provider 回報的 `cacheReadTokens`）。**兩半合起來才是完整的句子。**

---

## 4. 建議的設計（草案，**待你核**）

**這一節是提案，不是決定。** 你核過再進 spec。

1. **標記的來源**：`deriveMessages` 已經在收集被 shadow 的 seq（`core-session/src/index.ts:419-433`）。
   同一個前處理可以多回報一件事：**這次投影有沒有被 shadow 改寫、以及是哪個標記造成的**。
   （三個觸發共用同一個機制，所以「誰造成的」是可指名的：`compaction/summary`｜`compaction/reset`｜rewind cut。）
2. **請求面指紋**：`system` ＋ `tools` 的短雜湊（cc-custom 的形狀），每請求一次，貴的是它**很小**。
3. **掛在哪**：`provider/call`（每請求一次，已經帶著 `messages: messages.length`）。
4. **輸出**：`[metrics]` 多一段 `prefix: rewritten=1/requests=7 (cause: compaction)`，
   **緊接著 T2-1 的 `reported: cacheReadTokens=…`** —— 原因與代價並排。
5. **測試**：`assert_prefix_stable` 形式的斷言；**在壓縮處刻意紅**，並在那裡明確寫下「這裡允許斷」。

---

## 5. 刻意**不**做

- **不做 Anthropic 的斷點**（選項 D）—— 那是**另一件事**，而且它比 T2-2 更根本。
  它需要你先決定 IH 對 Anthropic 的支持要到什麼深度（調研 §5：IH 在 Anthropic 上**根本沒有快取**）。
- **不做 re-warm** —— 四家都沒有。而「重送一次前綴去預熱」本身要付一次全額。
- **不改壓縮策略** —— 見 §6。
- **不引入 epoch／版本號** —— 路線圖 Q3 已裁定，而調研再次證明：四家都沒有。

---

## 6. 這份報告**沒有**回答的

- **壓縮的時機對不對。** grok 的教訓是「只在真的快爆的時候付這個代價」；IH 有 hysteresis
  （`compaction/src/index.ts:170-198`），但**它的閾值有沒有過早，未量**。這是這一題**最大的未量項** ——
  如果壓縮太早，觀測只是把一個不必要的代價顯示出來。
- **真實命中率。** 需要真金鑰。§2 的可檢驗預測（IH 在 DeepSeek 上應該也高）**未驗**。
- **`system` 變更的實際頻率。** 只有沙箱模式中途改變才會動（§1.4），未量。
- **cc-custom 為什麼不雜湊 `messages`。** 程式碼沒說。最可能是成本，但**那是推測**。
- **`prompt_cache_key` 對 DeepSeek 有沒有用。** DeepSeek 是自動前綴匹配，可能不需要。未量。
