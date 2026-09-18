# prompt 快取連續性 — 設計（M5／T2 第二半及其鄰居）

**日期：** 2026-09-18 · **分支：** `m65` @ `0e9f7d6` · **分級：M**
**輸入：** 四份原始碼調研（`2026-09-18-prompt-cache-prior-art.md`）、一份合成（`…-synthesis.md`）、
一份實證（`…-empirics.md`）、T2 第二半報告（`…-t2-prefix-half-report.md`）、T2 第一半（`bd3a26d`）。
**這份文件是決定，不是選單。** 每個決定的理由都可檢查；每一條「還沒量」的都標出來了。

---

## 0. 目標

> **一個長 session 不該在不知情的情況下付全額；而當它付的時候，那應該是一個決定，不是意外。**

不是「加 prompt 快取」。是**三件事**：**不要不必要地弄斷**（D1）、**斷了也別多付**（D2）、
**斷的時候看得到、且知道是誰弄斷的**（D3）。D4 只有**顯式斷點的兩條協議線**需要（Anthropic／Bedrock），D5 是刻意不做。

---

## 1. 動工前的重量（全部對 `0e9f7d6` 實測）

| # | 量到什麼 | 位置 |
|---|---|---|
| **1** | **工具陣列既沒排序，又會在 session 中途從中間長出東西** | `core-tools/src/index.ts:199-210`（`[...tools.values()]` ＝ 插入順序）＋ `:335`（`search()` 提升） |
| **2** | **摘要器是冷啟動的**：`tools: []`、`systemPrompt: ""`、整個 shadow 區**渲染成文字**塞進一則 user 訊息 | `compaction/src/summarizer.ts:170-174` |
| **3** | **壓縮恆斷在 index 0**（保留尾巴也一樣），因為 `selectShadowableRange` 從前面走、摘要按 log 順序注入 | 探針 `.superpowers/sdd/probe-prefix-break.mts`；`compaction/src/region.ts:18-40`、`core-session/src/index.ts:489-491` |
| **4** | **IH 不送任何快取線索** —— 零 `cache_control`、零 `prompt_cache_key` | `grep -rn "cache_control\|prompt_cache\|promptCacheKey" packages apps` → 零命中 |
| **5** | 壓縮閾值預設 **0.8**，CLI 不覆寫 | `compaction/src/config.ts:106`；`apps/cli/src/index.ts:339` |
| **6** | **兩條保留尾巴的路徑都會孤兒一個 tool block** —— 邊界逐**事件**算，而 `deriveMessages` 逐**block** 摺 | `compaction/src/index.ts:251`（`slice(-retainLast)`）、`compaction/src/region.ts:29-37`（token 走訪） |

**而 `deriveMessages` 已經在收集被 shadow 的 seq**（`core-session/src/index.ts:419-433`）——
D3 不需要新機制，只需要把已經算出來的東西說出來。

### 1.1 第 6 條：一個在量 D2 時撞到的**正確性**缺陷

`deriveMessages` 把 `assistant(toolCalls) + tool(result)` 摺成**一個單位**，但兩條「保留尾巴」的路徑
都是**逐事件**選邊界。切在 block 中間時，被保留的那一半會失去它的另一半 ——
最常見的形狀是**訊息串列以一個 `tool` 開頭**，而它的 `tool_call` 被 shadow 掉了。

**實測（掃過每一個值，不是抽樣）：**

| 路徑 | 壞掉的值 |
|---|---|
| `resetWindow(retainLast)`（M20 預算階梯第 2 層，**預設 20**） | **4／11／18／25**（1..25 之中）—— 正好每隔「每輪事件數」 |
| `compact()` 帶 `retainTokens`（**出貨設定裡沒有地方設它**） | **50／150／300／900**（500 安全） |

**而「安全」是算術運氣，不是保證** —— 取決於邊界落點對不對得上 block。

**我們把這變成什麼**（`llm-anthropic/src/index.ts:130-132`，實測）：
一個 `tool` 訊息被映射成 `{role:"user", content:[{type:"tool_result", tool_use_id}]}`
—— 放在**第一則**，而那個 `tool_use_id` **從來沒有被引入過**。
（**provider 會拒絕這點是協議知識，這裡沒有量測** —— 量到的是「我們送得出這個形狀」。）

**修法（`b95d1c4` 之後）：邊界往後退，直到它不是 `tool/call` 也不是 `tool/result`。**
寧可多留，不可切開。**同一條規則用在兩個地方**，因為它們是同一個缺陷的兩扇門。

---

## 2. 設計

### D1 — 工具清單變成「穩定前綴 ＋ 可追加尾巴」

**為什麼是第一條。** 工具**排在被快取前綴的最前面**，所以工具清單的任何變動都**斷在 byte 0** ——
整個快取，不只是工具那一段。**這是唯一一個有外部量測數字的槓桿**（【二級來源】，
Permafrost 在 Claude Code→DeepSeek 上量的）：工具穩定 **~89.6%**、被 MCP 攪動 **~33%**、
加上確定性排序回到 **~71%**。

**而 IH 現在兩個問題都有**（§1 第 1 條）：

1. **沒有排序** —— `[...tools.values()]` 是**註冊順序**，取決於外掛掛載與 MCP 連線次序。
   兩次組裝可能產生不同的位元組，而它們本來該一樣。
2. **`promoted` 讓工具從中間長出來** —— 一次 `tool-search` 呼叫把 `[A, C]` 變成 `[A, B, C]`，
   **B 之後的全部失效**。

**設計：**
- **基底工具按名稱排序。** 跨組裝確定性。
- **deferred 工具全部排在最後**，且它們之間也排序。
- 於是「提升一個工具」＝**在尾巴追加**，前面的前綴**逐位元組不變**。

**這不是發明。** cc-custom 已經在做前一半：內建工具保持**連續排序的前綴**，MCP 工具接在後面，
理由是伺服器的斷點就放在「最後一個前綴匹配的內建工具」之後。
**但據我所見沒有一家把「提升」也變成追加** —— opencode 只排序。
這一條把「append-only」從訊息歷史延伸到工具清單，而那正是它該在的地方。

**代價：** 小。一個比較函式 ＋ 一段排序。**而且它是推導的**（排序是確定性的，不可能被忘記）。

### D2 — 摘要器停止付全額

**為什麼。** 摘要器讀的是**整個 shadow 區** —— 壓縮當下約**視窗的 80%**，
是整個 session 裡**單次最大的讀取**。而 IH 現在讓它**完全冷啟動**（§1 第 2 條）。

**三家刻意不這樣做：**
- **grok**：摘要請求帶**同樣的 tools**，指令接在最後 —— *"**Omitting them would shift the entire prefix
  and force a full prefill on the summarizer call.** Attaching them keeps the request prefix byte-identical
  to the turn requests … **That reuse is the whole point of the verbatim input path.**"*
- **codex**：壓縮請求帶**同一個 `prompt_cache_key`**，**有測試斷言兩者相等**
- **cc-custom**：`CacheSafeParams` 快照精確位元組

**設計：** 摘要請求做成**上次主請求的 byte-prefix** ＋ 指令以**最後一則 user 訊息**追加。

**⚠️ 這裡原本列了三個「必須先量」的障礙。量完了，而答案是：兩個不存在，一個是真的，還有一個沒預料到的。**

| 障礙 | 量測結果 |
|---|---|
| **(b) `tool_use`／`tool_result` 配對** | **不存在。** `deriveMessages` 的折疊由 M10a 的 adjacency 規則**保證合法配對** —— 送它送出的陣列就是合法的 |
| **(c) thinking block** | **不存在。** IH 的訊息投影只有 `user`／`assistant`／`tool`；reasoning 走**另一個陣列**，從不進 messages |
| **(a) 圖片** | **是真的**，而且是唯一那個。IH 已經有 `llm-seam` 的 `projectImagesForTextModel`，但那個投影是給主路徑的，摘要器要不要沿用是一個決定 |

**⚠️ 而真正會擋住 D2 的是第四件，原本沒寫：**

**shadow 區的訊息只有在「沒有保留尾巴」時才是主請求的 byte-prefix。** 實測（探針 `.superpowers/sdd/probe-summarizer-prefix.mts`）：

```
無保留尾巴： region 36 則，是主請求的 PREFIX → YES
有保留尾巴： region 32 則，是 PREFIX → NO，在第 31 則分歧
```

原因是 `deriveMessages` 把 `assistant(toolCalls) + tool(result)` **摺成一個單位**，
而邊界是**逐事件**算的。**所以 D2 的前置條件是「邊界必須對齊 tool block」** ——
而那正好也是 §1.1 那個**正確性缺陷**的修法。**兩件事是同一件。**

**所以 D2 現在的狀態是：前置已具備（見 §1.1），剩下 (a) 圖片那一個決定。**

### D3 — 「前綴被改寫」變成一個**推導出來的**事實

**為什麼。** 這是**四家一起瞎的那一格**：codex 不吭聲、grok 不吭聲、opencode 不吭聲、
cc-custom 只能**等別人通知它**（`notifyCompaction()`）—— **沒有一家把「前綴被改寫了」當成自己看得見的事實。**
而它也正好是 T2 完成定義要的「自己的前綴比對」。

**而 IH 有別人沒有的便宜路：** 日誌是 append-only，改寫**只透過 shadow 標記發生** ——
所以「有沒有被改寫」可以**從日誌推導**，**不必雜湊任何位元組**。

**設計：**
- `deriveMessages` 已經在收集被 shadow 的 seq（`core-session/src/index.ts:419-433`）。
  同一個前處理多回報一件事：**這次投影有沒有被改寫、被哪個標記改寫**
  （`compaction/summary` ｜ `compaction/reset` ｜ rewind cut —— 三者共用同一個機制，所以**原因可指名**）。
- 掛在 `provider/call`（每請求一次，已經帶著 `messages: messages.length`）。
- 輸出與 T2-1 的 `reported:` **並排**：**原因與代價在同一行**。

**這比 cc-custom 的偵測器好在三點：**
1. **便宜** —— 不雜湊（它刻意不雜湊 `messages` 就是因為貴）
2. **涵蓋歷史改寫** —— 那是它**刻意排除**的一塊（它用通知，不偵測）
3. **推導而非維護** —— 沒有「忘記呼叫通知」這個失敗模式

**⚠️ 它測不到什麼，說出來：** 它回答「**是不是我們弄斷的**」，不回答「**對方有沒有真的命中**」。
後者由 T2-1 的 provider 回報回答。**兩者配對才是完整的句子** —— 而這個配對正好就是
cc-custom 的設計精髓（本地指紋說為什麼、provider delta 說是不是真的），只是我們用日誌結構代替雜湊。

**一個附帶的好處**（值得寫下來）：有了 D3，**「TTL 過期」與「被改寫」就可以分開了** ——
沒改寫卻沒命中 ⇒ 不是我們的錯，是時效或伺服器端。
（實證層說 DeepSeek 的保留期官方與量測互相矛盾，而**在那個矛盾解決之前，這個區分就是唯一能用的證據**。）

### D4 — **顯式斷點協議**需要斷點（不是「Anthropic」）

**⚠️ 這一節原本寫成「只有 Anthropic 需要」（2026-09-18 更正）。** 那是把**供應商**當成了**協議**。
正確的切法是**協議**，而 IH 的五條線裡有**兩條**是顯式斷點的：

| 協議 | adapter | 顯式斷點？ |
|---|---|---|
| Anthropic Messages | `llm-anthropic` | **是** —— `cache_control` |
| Bedrock Converse | `llm-bedrock` | **是** —— `cachePoint` |
| OpenAI Chat Completions | `llm-openai-compatible` | 否（自動前綴匹配） |
| OpenAI Responses | `llm-openai` | 否（自動；`prompt_cache_key` 是路由提示） |
| Gemini | `llm-gemini` | 否（隱式） |

**現況：IH 送零個 `cache_control`、零個 `cachePoint`。** 所以在**兩條顯式斷點的線上**，
**IH 根本沒有快取可失去** —— 每一個請求都付全額（調研 §5）。而另外三條線上 D1／D3 就是全部。

**設計（若 Anthropic 在支援範圍內）：**
- 照 **opencode 的失效順序**分配：`tools → system → messages`（*"Tools live highest in the cache hierarchy"*）
- 照 **grok 留一格**：*"a gateway that turns on automatic caching takes it, and five is rejected outright"*
- **每請求從當下的陣列重算、不儲存** —— 四家都這樣，所以「改寫後斷點怎麼辦」這個問題不存在

**這一條排在最後**，因為它取決於一個**產品決定**（IH 對 Anthropic 支持到什麼深度），不是技術障礙。

**⚠️ 但 2026-09-18 又量到兩件事，它們把「顯式斷點協議」這個判準本身修正了：**

**① 廠商 ≠ 協議 —— 一家可以同時開好幾條線。** 實際查證：DeepSeek 官方同時提供
**OpenAI 相容（`https://api.deepseek.com`）與 Anthropic 相容（`https://api.deepseek.com/anthropic`）** 兩條 base_url，
而側欄另有「使用 Responses API」一頁。**所以協議是 endpoint 的性質，不是廠商的** ——
我第一次把「DeepSeek」寫成一條協議、第二次把它寫成另一條協議，**兩次都錯在同一件事上。**

**② 而「協議」也不是判準 —— 「這條 endpoint 的快取是不是自動的」才是。**
【二級來源】多家閘道文件把 DeepSeek 與 OpenAI／Google 歸為「**自動，無需修改請求**」，
把 Anthropic／MiniMax 歸為「**需要顯式 `cache_control`**」。DeepSeek 的寫入免費、無斷點概念。

**所以判準從「協議」收緊成「endpoint 的快取機制」：**

| endpoint | 快取機制 | D4 買得到嗎 |
|---|---|---|
| `api.anthropic.com`（真的 Anthropic） | **顯式** | **買得到 —— 而且是 0 → 1** |
| Bedrock | **顯式**（`cachePoint`） | **買得到** |
| **`api.deepseek.com/anthropic`** | **自動**（Anthropic 相容層下仍然是自動） | **買不到，`cache_control` 惰性** |
| OpenAI / Gemini 各路 | 自動 | 買不到 |

**⚠️ 而最後一件是別的東西，它比 D4 更影響**我們怎麼讀數字**：**

> **DeepSeek 的快取單元不是我們選的。** 它在三處建立單元 —— **請求邊界**（使用者輸入末尾＋模型輸出末尾）、
> **長輸入的固定 token 間隔**、以及**系統偵測到的跨請求公共前綴**。匹配是**嚴格全前綴**，
> **部分重疊不命中**。而且有**冷啟動**：請求 1 送 A+B、請求 2 送 A+C **不命中**；
> 系統在**兩次請求之後**才偵測到公共前綴 A 並持久化，請求 3（A+D）才命中。【二級來源】

**這對 IH 的三個直接後果：**
1. **D1／D3 是「讓前綴值得被記住」，不是「決定它記在哪裡」** —— 單元邊界是對方決定的。
2. **冷啟動意味著「第一次不命中」是正常的** —— 所以 `prefix(rewritten/total)` **必須與 provider 回報配對讀**，
   否則前兩次會被誤判成「我們弄斷了」。**這正是 D3 設計成兩半合讀的理由，現在有了外部證據。**
3. **它解釋了 Permafrost 的「斷在 byte 0」**：工具在最前面，工具一變，最早的單元就失效。

### D5 — 刻意**不**做

- **不做 keepalive。** 實證層說：**在 DeepSeek 上它只買延遲，不買成本**（重新 prefill 太便宜，不值得保險）。
  而 DeepSeek 是實際使用的那一個。
- **不做執行期逐位元組偵測器。** 四家零；而我們**量到它退化**（斷恆在 index 0 → 輸出是常數）。
- **不動壓縮閾值**（現在 0.8）。**先讓代價可見，再調它** —— 否則是在優化一個看不見的東西。
  §6 記下了它是怎麼算的。
- **不引入 epoch／版本號。** 路線圖 Q3 已裁定，而四家都沒有。
- **不做 re-warm。** 四家都沒有，而它本身要付一次全額。

---

## 3. 施工順序與理由

```
D1  工具清單：排序 ＋ 尾巴追加      ← 最便宜、有外部數字（2.7×）、而且是推導的
D3  「被改寫」變成可觀測            ← 它讓 D2 與閾值討論有依據
D2  摘要器重播前綴                  ← 回報最大，但最侵入 → 先量 (a)(b)(c)
D4  顯式斷點協議（Anthropic／Bedrock）  ← 等你的產品決定
```

**D1 先，因為它同時是最便宜與最高槓桿的**（§2.D1），而且它是**推導的保證**：排序一旦寫對，
不可能被後來的改動忘記。
**D3 第二，因為它把「代價」變成可見** —— 而 D2 與閾值都是「值不值得付」的問題，
**沒有 D3 就只能憑感覺回答**。
**D2 最後，因為它是唯一一個「先量再決定」的**：如果 shadow 區充滿圖片與 tool 配對，
真正的 byte-prefix 重播可能不划算，那時候誠實的答案是**不做**，而不是硬做。

---

## 4. 完成定義與如何證明

1. **D1**：（a）同一組工具、不同註冊順序 → `schemas()` **位元組相同**；
   （b）提升一個 deferred 工具之後，**前面已送出的前綴逐位元組不變**。
   *突變*：拿掉排序 → 兩次組裝不同 → 紅；把 deferred 插回原位 → 前綴變了 → 紅。
2. **D3**：一次壓縮之後的 `provider/call` 帶著「被改寫＋原因」；**沒有改寫的兩步之間不帶**。
   *突變*：把原因拿掉 → 紅；把「沒改寫」也標成改寫 → 紅。
3. **D2**：*先量*。量的結果決定這一項是「做」還是「不做，並記下為什麼」—— **兩種都是完成**。

---

## 5. 這份設計**沒有**回答的

- **D2 的三個障礙 (a)(b)(c) 各有多大** —— 沒量。**它是 D2 的前置。**
- **工具排序會不會改變模型行為** —— 排序改變了工具在 prompt 裡的順序，而那可能影響模型選工具的偏好。
  **未量。**（cc-custom 與 opencode 都排序，所以先例是「不會有問題」，但那不是我們的量測。）
- **「壓縮閾值該不該是 0.85」** —— §6。
- **DeepSeek 的保留期矛盾** —— 官方說幾個小時到幾天，量測說約 5 分鐘（而且量的是第三方後端）。
  **未解**，而它決定「TTL 造成的 miss 佔多少」。
- **`prompt_cache_key` 對 DeepSeek 有沒有用** —— 它是自動前綴匹配，可能不需要。未量。

---

## 6. 附錄：為什麼壓縮閾值不是第一個槓桿（推導，非量測）

每一輪的形狀是：活的上下文長到 `threshold × W` → 壓縮 → 降回很小 → 再長。
所以一輪摘要掉的量 ≈ `threshold × W`，而一輪之間新增的量也 ≈ `threshold × W`。
**於是整個 session 的摘要總量 ≈ T（曾加入的總 token 數）—— 與閾值無關。**

**閾值改的不是總成本，是切法**：低閾值＝次數多、每次丟得少、活歷史少、離牆遠；
高閾值＝次數少、每次丟得多、活歷史多、離牆近。

**所以 0.85 是「用餘裕換歷史保留」。** 而回答它需要的唯一硬證據是**最大單步成長**
（一個工具結果可以把上下文一次推過 100%，而預算檢查在**步驟邊界**，中間沒有守衛）——
**那個數字沒量過**。

**而真正大的是 D2：** 壓縮現在付**全額**，而它可以付**一成**。
**在 D2 之前調閾值，是在優化一個比它大一個量級的成本旁邊的小項。**
