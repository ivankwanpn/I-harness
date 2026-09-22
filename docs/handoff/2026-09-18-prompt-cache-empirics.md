# prompt 快取的**實證層** —— 合成文件缺的那一塊

**日期：** 2026-09-18 · **分支：** `m65` @ `59768a0`
**來源性質：⚠️ 全部是網路搜尋摘要，原文一律未取得。** 這份文件的方法與另外四份**不同**，見 §0。

---

## 0. ⚠️ 來源與可信度 —— 先講清楚，因為這份和前四份不同

前四份（cc-custom／grok／codex／opencode）是**我直接讀原始碼**，每條都有 `file:line`，載重的我還親手複驗。

**這一頁不是。** 全部來自 `WebSearch` 的摘要，而**所有原文抓取都被這台機器的網路政策擋掉**：

```
WebFetch arxiv.org/abs/2601.06007            → Unable to verify if domain is safe to fetch
WebFetch ar5iv.labs.arxiv.org/html/2607.19214 → 同上
WebFetch victorinollc.com/…                   → 同上
WebFetch web.archive.org/…                    → 同上
```

**所以下面每一個數字都是【二級來源，未經原文核實】。** 我把它們寫下來是因為**它們是這一題目前唯一
量出來的東西**，而且其中一項與官方文件**互相矛盾**（§4）—— 那個矛盾本身就是發現。
**要用之前必須自己重測。**

唯一在**我們自己機器上**核實過的，是 §5 那條（cc-custom 的 TTL 閘門）。

---

## 1. 合成文件漏掉的一整個維度：**時間**

八層設計講的都是「**送什麼**」。**沒有一層講「什麼時候送」。**

而快取**過期**和快取**被改寫**一樣致命，而且**與你送了什麼無關** —— 一個字都沒改的前綴，
放超過 TTL 照樣全額。

### 1.1 各家保留期（【二級來源】）

| 供應商 | 量到的閒置逐出 | 形狀 |
|---|---|---|
| **Anthropic** | **5 分鐘**（懸崖在 5–6 分之間，**沒有寬限期**） | 準時斷崖 |
| **DeepSeek** | **約 5 分鐘**（但見 §4 的矛盾） | 10 分內消失 |
| **OpenAI** | ~10 分鐘（**不是黏，是慢**：20 分還半溫，30 分全冷） | 「你不能規劃的紅利」 |
| **Google** | **從不收斂** —— 每個間隔都是 33–83% | 「比較像路由樂透，不像保留曲線」 |

### 1.2 Keepalive 的經濟學（【二級來源】）

暫停期間**重送同一個前綴、最小生成**，把 TTL 刷新。論文標題就是結論：*Keeping the Cache Warm Pays*。

- **30 秒的慣例在每一個供應商上都賠錢。** 每次 ping 付**讀價**（約輸入的 10%），
  所以每小時花費隨 `1/τ` 下降 → **最佳間隔是「安全地低於 TTL 的最大值」≈ 4 分鐘**，
  比 30 秒便宜約 **8 倍**。
- **損益兩平**：`idle_breakeven ≈ τ · (w/r − 1)`（`w` 寫倍率、`r` 讀倍率）
  → **Anthropic ~46 分、OpenAI／DeepSeek ~36 分、Google ~12 分**。**超過就讓它死。**
- 反直覺的實例（Anthropic 100k 前綴、600 秒閒置）：**讓它死 $0.667 ／ 每 30 秒 ping $0.867 ／
  每 4 分鐘 ping $0.414**。慣例買到的是「更貴的、或不需要的」留存。
- **⚠️ 但對 DeepSeek，keepalive 只買延遲，不買成本** —— 它的重新 prefill 太便宜，不值得保險
  （40k／600 秒：30 秒 ping $0.100 **對比** 基線 $0.017；240 秒 ping $0.022）。
  買到的是 TTFT 5398 ms → 1950 ms。

### 1.3 官方文件與量測**互相矛盾**（DeepSeek）

| 來源 | 說法 |
|---|---|
| **DeepSeek 官方文件** | *「缓存不再使用后会自动被清空，时间一般为**几个小时到几天**」* —— 而且是**盡力而為，不是保證** |
| 論文的量測 | **約 5 分鐘**（但註明：量的是 **OpenRouter 上的 DeepInfra 後端，不是 DeepSeek 第一方**） |
| 第三方教材 | 5 分鐘，且「每次命中就重置」 |
| Ruan Yifeng 週報 | 10 分鐘（而且它的留言區自己標了與官方文件的衝突） |

**矛盾沒有解決。** 對規劃的意義：**用最短的那個當假設**（論文的建議）。

**而 DeepSeek 沒有開發者可控制的 TTL** —— 沒有 cache handle、沒有 `ttl` 欄位、沒有 release API；
社群在 issue 裡要一個 Gemini 式的 `CachedContent`（[DeepSeek-V3 #1655](https://github.com/deepseek-ai/DeepSeek-V3/issues/1655)）。

---

## 2. 合成文件裡「免費」的那一層，其實是**量到槓桿最大**的一層

我在合成文件把「確定性序列化／工具排序」列為**免費**。**它是免費，但它不是小事。**

**Permafrost**（一個已經出貨的 Claude Code 外掛，做的是「凍結前綴讓 DeepSeek 的自動快取一定命中」，
自稱**在真實 Claude Code 流量上量到便宜 64%**）公布了三組命中率：

| 情境 | 命中率 |
|---|---|
| 原版 session，工具穩定 | **~89.6%** |
| **MCP server 讓工具清單一直變** | **崩到 ~33%** |
| **加上確定性工具排序** | **回到 ~71%** |

而它把原因講白了：***"Cache breaks at byte 0 because tools render first in the cached prefix."***

**這一條把三件事接起來了：**
1. opencode 的 `tools → system → messages` 失效順序（*"Tools live highest in the cache hierarchy"*）
2. codex 的 `prompt_cache_key` 與工具穩定性
3. **一個可量的數字：33% vs 89.6%** —— 一個「免費」的紀律值 **2.7 倍**

---

## 3. 成本模型**反過來了**：不要縮短提示詞

社群共識（六個 agent、24 小時運行，命中率穩定 **97–99%**）：

> **「傳統思維為了省錢而縮短 System Prompt，但在快取時代那是錯的。」**
> 他們用的是**極大的 system prompt ＋ 工具定義**。

**而在快取之下這是算得通的**：前綴**長度**幾乎免費（命中的部分付 10–25%），
前綴**變動**才貴（全額 ＋ 重寫）。

**學術支持**（arXiv 2601.06007，*Don't Break the Cache*，PwC，2026-01）【二級來源】：
- 在 **500+ 個 agent session、10,000-token system prompt** 上量到**成本降低 41–80%**、**TTFT 改善 13–31%**
- **「策略性地控制快取邊界勝過天真地全上下文快取」** —— 全快取甚至會**讓延遲變差**
  （GPT-4o 全上下文：TTFT **上升** 8.8%），因為動態的工具結果觸發了**不會被重用的寫入**
- **純 system prompt 快取在各項上最一致**
- **最低快取門檻**：OpenAI／Anthropic **1,024 token**、Google **4,096 token** ——
  **低於門檻，快取等於不存在**
- 建議：動態內容放**尾端**、避免動態 function calling、排除動態工具結果

> **「天真全快取會變慢」這一條解釋了兩件我們已經看到的事**：cc-custom 的 `skipCacheWrite`
> （側呼叫刻意**不寫**），以及 grok 的「第 4 個斷點空著」—— **寫入是要錢的，而寫一個不會被讀的東西是純虧。**

---

## 4. 這改變了合成文件的什麼

| 合成文件原本 | 現在 |
|---|---|
| 八層，全是「送什麼」 | **加一層：時間（TTL／keepalive）** —— 而且它與前綴內容**無關** |
| L1「確定性序列化」= 免費 | **免費，但量到是槓桿最大的之一**（33% → 89.6%），因為**工具排在最前面，所以斷在 byte 0** |
| L3「斷點」提到 TTL 只是順帶 | **TTL 是一個獨立維度**，而且**在 DeepSeek 上沒有開發者可控制的手段** |
| 「不做偵測器」 | **不變**，而且更強了：實證層關心的是**命中率**，不是「前綴有沒有變」 |
| 沒有數字 | **有了**（但都是二級來源）：41–80% 成本、13–31% TTFT、89.6% vs 33%、5 分鐘 TTL、4 分鐘 ping |

---

## 5. 唯一在我們自己機器上核實的一條

使用者的截圖說 Claude Code 的社群解法是改 `subagentPromptCacheTtl`（5m → 1h）。

**那個設定名不在我們手上的 cc-custom 版本裡**，**但機制是真的**：

```ts
// D:/cc-custom/src/services/api/adapters/messagesAdapter.ts:202
function should1hCacheTTL(querySource?: QuerySource): boolean {
  if (getAPIProvider() === 'bedrock' && isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)) return true
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible = process.env.USER_TYPE === 'ant'     // ← 預設只有 Anthropic 員工
    setPromptCache1hEligible(userEligible)
  }
  if (!userEligible) return false
  // …再過一層 server 推下來的 allowlist（tengu_prompt_cache_1h_config）
}
```

**1 小時 TTL 被三道閘擋住**（員工身分 → server allowlist → bedrock env），
閘門沒過時 `getCacheControl` 展開成 `{type:'ephemeral'}` —— **正是預設的 5 分鐘**。

**所以社群的抱怨在程式碼層面成立，而他們「改本機設定」的解法，本質是繞過一個員工／allowlist 的閘門。**
**而這也解釋了為什麼長 build 的 sub-agent 會出事**：5 分鐘的懸崖（§1.1）＋ 一次超過 5 分鐘的工具呼叫。

---

## Sources

- [Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks (arXiv 2601.06007)](https://www.alphaxiv.org/abs/2601.06007)
- [Keeping the Cache Warm Pays: Keepalive Economics for Agentic Workloads (arXiv 2607.19214)](https://ar5iv.labs.arxiv.org/html/2607.19214)
- [Your Agentic Workflow's Cache Keepalive Costs 8x Too Much (v2: the interval frontier)](https://web.archive.org/web/20260726042242/https://blog.mempko.com/your-agentic-workflows-cache-keepalive-costs-8x-too-much-v2-the-interval-frontier/)
- [The 30-Second Keepalive Is Folklore: Cache Economics Are a Per-Provider Policy](https://victorinollc.com/thinking/prompt-cache-keepalive-per-provider)
- [Permafrost — freeze Claude Code's prompt prefix for DeepSeek](https://github.com/jianzhichun/permafrost)
- [DeepSeek API Docs — 上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)
- [Explicit Context Caching for the DeepSeek API (DeepSeek-V3 #1655)](https://github.com/deepseek-ai/DeepSeek-V3/issues/1655)
- [科技爱好者周刊（第 408 期）：你需要知道的 AI 缓存知识](https://www.ruanyifeng.com/blog/2026/08/weekly-issue-408.html)
- [Stop shortening your prompts. Six agents, 97-99% cache hit rate (r/AI_Agents)](https://www.reddit.com/r/AI_Agents/)
