# D4 — the endpoint cache measurement, and what it decides

**日期：** 2026-09-19 · **分支：** `d4-endpoint-cache` · **基準：** `m65` @ `5f317641`
**上游設計：** `docs/superpowers/specs/2026-09-18-prompt-cache-continuity-design.md` §D4
**性質：** 一次實跑。**不是推論** —— 每個數字都是 `--telemetry` 印出來的。

---

## 0. 設計留下的那句話

> **D4 只差一個量測**：把 IH 指向 `api.deepseek.com/anthropic`，跑 `--telemetry`，讀
> `reported: cacheReadTokens`。前兩次是 0、之後 > 0 → 快取是自動的 → **D4 不做**；
> 一直 0 → 那條路要斷 → **D4 是 0→1**。

**做了，答案是前者，而且更強。**

---

## 1. 怎麼跑的

環境本來就已經指向那個 endpoint（`~/.i-harness/settings.json`：

```json
{ "provider": "deepseek1", "protocol": "anthropic-messages",
  "baseURL": "https://api.deepseek.com/anthropic" }
```

），所以**沒有改任何連線設定**。同一個 session 連續跑 **4 次**（`--resume`），
每次的任務是 `Reply with exactly: ok` —— **不觸發任何工具呼叫**，所以沒有東西會在中途改寫前綴，
量到的就純粹是 endpoint 的行為。

**⚠️ 不能用 `--model`。** `parseModel` 用的是**內建**的 provider profile
（`apps/cli/src/index.ts:69-81`），所以 `--model deepseek:…` 會走 `openai-compatible` 到
`https://api.deepseek.com` —— **不是** Anthropic endpoint。**只有 settings 那條路會到對的地方。**

---

## 2. 量到的

| run | `inputTokens` | **`cacheReadTokens`** | `cacheCreationTokens` | `prefix(rewritten/total)` |
|---:|---:|---:|---:|---|
| 1 | 161 | **4864** | 0 | 0/1 |
| 2 | 172 | **4864** | 0 | 0/1 |
| 3 | 183 | **4864** | 0 | 0/1 |
| 4 | 194 | **4864** | 0 | 0/1 |

**每一個請求都從快取讀了 4864 個 token —— 包括第一個。**
而 `inputTokens` 每次只長 ~11（對話在長），**前綴那 4864 完全來自快取。**

**IH 送出的 `cache_control` 是零個。** 所以那 4864 不是我們要來的。

## 2.1 第二半也確認了

`prefix(rewritten/total)` 四次都是 **`0/1`** —— **前綴一次都沒有被改寫。**
那是 D1／D3 在說「我們這邊沒問題」，而它與 provider 回報**可以配對讀**：
**我們沒弄斷，對方也真的命中。** D3 設計成兩半合讀的理由，這裡有了實跑證據。

---

## 3. 這決定了什麼

**D4 在 `api.deepseek.com/anthropic` 上：不做。** 理由是可量測的，不是偏好：
**這條 endpoint 的快取是自動的，而我們已經在吃它。** 加 `cache_control` 買不到東西。

**而這件事本身證實了設計 §D4 的那次更正。** 設計原本寫「只有 Anthropic 需要」，
後來改成「判準是 **endpoint 的快取機制**，不是協議也不是廠商」。這裡就是那個區分的實例：
**一條講 Anthropic 協議的 endpoint，快取卻是自動的。**

---

## 4. 這**沒有**決定的

- **真的 `api.anthropic.com` 與 Bedrock。** 兩者是**顯式斷點**的，那條路上 IH 送零個
  `cache_control`，所以**確實是 0 → 1**。本量測完全沒有涵蓋它們 ——
  它量的是一條**自動**端點，在那裡 D4 沒有作用。**要不要支持那兩條，仍是設計 §D4 說的產品決定。**
- **`cacheCreationTokens=0` 的意義。** 四個請求都是 0，包括第一個。
  可能是這條相容層不回報建立數、也可能建立發生在更早（我前面失敗的幾次）而這裡只看到讀取。
  **未解，而它不影響上面的結論** —— 結論只需要「有沒有讀到」。
- **TTL。** 設計 §5 記的 DeepSeek 保留期矛盾（官方說小時～天，量測說約 5 分鐘）**仍未解**。
  本量測四次是連續的，**測不到 TTL**。
- **`prompt_cache_key` 有沒有用。** 未測。既然快取本來就命中，它大概沒必要。

---

## 5. 順帶撞到的：一個 400，與設計 §1.1 是同一族

第一次嘗試（一個要求讀兩個檔案的任務）**被 provider 拒絕**：

```
400 messages.2: `tool_use` ids were found without `tool_result` blocks
    immediately after: call_2
```

**設計 §1.1 對這一類的措辭是**：*「provider 會拒絕這點是協議知識，**這裡沒有量測**」* ——
量到的是「我們送得出這個形狀」。**現在量到了：provider 會拒。**

**但方向與 §1.1 記的相反。** §1.1 記的是「一個 `tool_result` 而它的 `tool_use` 從沒被引入」
（`75d88dc9` 修掉的那兩扇門）。**這裡是一個 `tool_use` 沒有配對的 `tool_result`** ——
訊息裡有 `call_1`、`call_2`，而只有一個結果回來。

**未追。** 它不在 D4 的路徑上，而且它看起來是**另一個**缺陷（可能與平行工具呼叫有關），
不是 §1.1 修過的那個。**需要自己的調查，不該折進這一條。**
