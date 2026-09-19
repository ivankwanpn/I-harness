# provider × model × protocol 目錄 — 設計

**日期：** 2026-09-19 · **分支：** `d4-endpoint-cache`
**量測基準：** `m65` @ `5f317641`（每一個座標都在此修訂重讀）
**六個來源：** Codex v0.154.0 · Grok Build · Pi 0.85.1 · opencode 1.18.30 · cc-custom · DSH
**性質：** 這份文件是**決定**。每個決定的理由都可檢查；來源裡**互相矛盾**的地方標出來了。

---

## 0. 為什麼有這份文件

使用者把 `deepseek-flash` 加進設定，IH 回：

```
Model "deepseek1:deepseek-flash" is not in the configured catalog
```

**而那是官方叫你用的名字。** 而 `deepseek-v4-flash`（已下線的舊名）**可以過**。

**一次「官方改名」就把我們的預設模型路徑打斷了。** 這份文件是量完之後的處置。

---

## 1. 量測：四個缺陷，其中兩個是我自己找出來的

### 1.1 型號表用「使用者取的路由名」當 key

```ts
// packages/provider-runtime/src/index.ts:459-461
function runtimeProfile(view, apiKey, modelModalities) {
  return { ...template, name: view.id }      // ← 使用者取的路由名
}
// packages/provider/src/index.ts:112-114
function resolveModelCard(route, modelId) {
  return MODEL_CATALOG[route]?.[modelId]
}
```

**實測：**

```
route "deepseek"   → {contextWindow: 1048576, maxOutputTokens: 384000}
route "deepseek1"  → undefined          ← 使用者目前的預設模型就在這裡
```

**這解釋了跑 D4 時那行警告**（`no context window could be resolved`）—— 不是表沒有資料，是**查不到**。

### 1.2 表裡的 key 是已下線的名字

官方現行：`deepseek-flash` / `deepseek-v4-pro`。表裡：`deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`。

**而 DeepSeek 的文件說舊名「仍可調用，但對應模型已下線，由 V4.1-Flash 服務」** —— 所以三者其實**指向同一顆模型**。

### 1.3 閘門因為「我不認識這個名字」而拒絕

`packages/provider-runtime/src/index.ts:311`。而**它之後的每一行都已經容忍「這顆模型沒被宣告」**：

```ts
const userModel = view.user?.models?.find(...)          // '?.' 
const contextWindow = resolveEffectiveModelContext(...)?.contextWindow   // 可選
...(contextWindow !== undefined ? { contextWindow } : {})                // 可選
```

**`contextWindow` 在 binding 裡是可選的，「沒有窗口」是被支持的狀態。** 而 assembly 已經有一行專門的警告在負責它。

### 1.4 讓表不過期的機制，消費者被 M65 刪掉了

```
活的樹裡 discoverModels 的生產呼叫者：零
4ea5b5d^:packages/tui/src/app/provider-controller.ts:185   ← 被刪掉的 TUI
```

**這是本 repo 第三次出現同一個模式**（`runtimeInputs()`、`createHookRegistry`、`discoverModels`）。

---

## 2. 六個來源

### 2.1 未知名模型：**三種立場，不是兩種**

| | 立場 | 機制 |
|---|---|---|
| **Codex** | **放行** | `warn!("Unknown model … fallback model metadata.")` + **272k** fallback + `used_fallback_model_metadata: true` 旗標 |
| **Pi** | **放行** | `buildFallbackModel()` 複製該 provider 的預設模型、改寫 id，警告 `Using custom model id.`；自訂模型沒填數字時 **128000 / 16384** |
| **DSH** | **永不拒** | 目錄是 advisory，*"explicitly never controls routing or rejects a request"*；未編目模型用 adapter 預設（**1,000,000 / 256,000**），且**宣告成 text-only** 而不是宣稱未驗證的圖片能力 |
| **cc-custom** | **放行 + 探測** | `validateModel()` **發一個真的 1-token 呼叫**，只在 provider 回 404 時拒（`Model 'x' not found` + 3P 建議）；**非互動路徑完全跳過驗證** |
| **opencode** | **拒絕** | `ProviderModelNotFoundError` + **fuzzysort 建議** + `Try: opencode models` + config 提示 |
| **Grok** | **拒絕（在 `set_model`）** | `unknown model id`；其餘地方降級（換第一個可見模型） |
| **我們** | **拒絕** | `is not in the configured catalog` —— **沒有建議、沒有提示、沒有替代路徑** |

**所以是 4 放行 / 1 探測 / 2 拒絕。而拒絕的那兩家，訊息可以行動。**

> **cc-custom 的第三種立場值得注意**：它不查自己的表，**它問 provider**。那是「權威在對方」的直接實作。

### 2.2 型號資訊從哪來

| | 來源 | 出處 | 規模 |
|---|---|---|---|
| **Pi** | **產生的表**（models.dev + OpenRouter + Vercel + NVIDIA，**在產生時抓**） | **`.manifest.json`：`generatedAt` + per-file sha256** | 39 providers |
| **opencode** | **models.dev**，runtime 抓 + build 內嵌 + 磁碟快取 | 無 | **~159 providers / ~5,640 models** |
| **Codex** | 內建 11 條（515KB，`include_str!`）**+ 遠端 `/models`（300s TTL）** | 無 | 11 |
| **Grok** | 內建 **2 條** + 遠端 `/v1/models` | 無 | 2 |
| **cc-custom** | **一個常數 `200_000` 打天下** + substring if/else | 無（只有 pricing 有一行註解引文件） | 11 |
| **DSH** | adapter 自帶目錄 | — | — |
| **我們** | 手寫 `model-catalog.json` | **無** | **3 路由 / 8 模型** |

**只有 Pi 有出處 —— 而且它把出處當防護用**：遠端 overlay 只在 remote `Last-Modified` **比本地的 `generatedAt` 新**時才套用，所以伺服器不能把新發行版降級。

### 2.3 身分怎麼定

| | 身分 | provider 掛在哪 |
|---|---|---|
| **Grok** | `[model.<key>]` 的 key | **在每一列裡面**（base_url / api_backend / auth_scheme / env_key） |
| **Pi** | `(provider id, model id)`；**provider id 只是命名空間** | 每個 model 自帶 `api` + `baseUrl` |
| **opencode** | `(providerID, modelID)`，**local key ≠ wire id** | 每個 model 自帶 `api.npm` + `api.url` |
| **Codex** | 自由字串 slug | **目錄列沒有 provider 維度**（而且樹裡有 TODO 承認那是 bug） |
| **cc-custom** | 裸字串 | 另一個軸（`providers.json`）；**protocol 是全域的** |
| **我們** | `provider:model` 字串 | **route 名同時是命名空間與查表 key** |

### 2.4 「同一個 vendor 兩把 key」——**四家都有問題，但輕重不同**

| | 處置 |
|---|---|
| **Grok** | **不需要第二個 id** —— provider 在 model entry 裡 |
| **opencode** | 兩個 provider id。**代價：非 models.dev 的 id「inherits no npm/api/models/limits, so the user must restate the whole model list」** |
| **Pi** | 兩個 provider id；**而且重用內建 id 是 overlay 而不是第二份** |
| **cc-custom** | 兩個 id 可行 → **代價：OAuth 訂閱硬編碼自己的 id，會靜默覆蓋同名的 api-key provider** |
| **我們** | 兩個 id → **第二條線連型號表都拿不到（§1.1）** |

**四家都是「要重述」，只有我們是「拿不到」。重述是麻煩，拿不到是靜默退化。**

---

## 3. 決定

### D1 — 目錄是**建議**，不是許可證。移除 model 的成員資格檢查。

**拒絕未知的 PROVIDER，放行未知的 MODEL。**

- `view === undefined`（provider 沒設定）→ **維持拒絕**：沒有 baseURL、沒有 auth，真的跑不了
- model 不在目錄裡 → **放行**，用 §3.2 的 fallback，並在**該說話的地方**說話

**理由：**
1. **四家放行、一家探測**；拒絕的兩家都給可行動的訊息與替代路徑。我們什麼都沒給。
2. **閘門之後的每一行都已經容忍缺 metadata**（§1.3）—— 閘門拿掉的不是資訊，是服務。
3. **閘門承諾的價值它自己提供不了**：`deepseek-v4-flash` 是「已宣告」的，而它昨天照樣 `no context window`。**表是裸 id。**

**而「沒有 context window」的後果已經有負責人** —— assembly 那行警告，在正確的層、說正確的話。

> **不採用 cc-custom 的探測法**（發一次 1-token 呼叫）：那是**一次付費的網路請求**在選模型的路徑上，而它自己的 Responses 路徑因為 `sideQuery` 只支援 Messages **永遠失敗**。代價高於收益。

### D2 — metadata 的身分**不能是使用者取的路由名**

**建議：provider 條目自己宣告它用哪一套卡。**

```jsonc
"llm": { "providers": {
  "deepseek1": { "protocol": "anthropic-messages",
                 "baseURL": "https://api.deepseek.com/anthropic",
                 "catalog": "deepseek",        // ← 新增：卡片家族
                 "models": [...] }
}}
```

**理由：**
- **四個來源裡，只有 Codex 把 provider 名當目錄 key，而它樹裡有 TODO 承認那是 bug**（`models_cache.json` 沒有 provider 分區）。**沒有一家把「使用者取的名字」當查表 key。**
- DSH 把它掛在 **settings namespace** 上，理由是「**a provider being ADDED has no route to name**」。
- **顯式欄位而非推導**（不用 baseURL 猜）：推導會在自訂閘道、代理、區域變體上出錯，而那些正是這個欄位存在的理由。**顯式也讓它可被檢驗。**

**而 `catalog` 缺席時的行為必須明確定義**：**不推導、不猜** —— 落回 §3.2 的 fallback，並記錄。**「猜一個」比「沒有」糟。**

### D3 — 表要有出處，名字要有別名

**（a）`generatedAt` + 來源**，照 Pi 的 `.manifest.json` 形狀。**不只要能讀，要能拿來做決定**（Pi 用它擋遠端降級）。

**（b）名字別名**：`deepseek-flash` 與 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` **並存** —— DeepSeek 自己說舊名仍可調用、由同一顆模型服務。**DSH 的目錄就是新舊並列**，那是先例。

**（c）fallback 值。** 未編目模型的數字，三家的選擇：

| | context | output |
|---|---|---|
| Codex | 272,000 | **不建模** |
| DSH | 1,000,000 | 256,000 |
| Pi（自訂模型） | 128,000 | 16,384 |

**建議取 Pi 的保守值（128k/16k）當預設**，因為**低估只會提早壓縮，高估會撞上 provider 的 400**。而 DSH 的 1M 是 **DeepSeek adapter 專屬**的預設，不是通用值。

### D4 — discovery 要有消費者

`i-harness models [--discover]`。

**理由：** 這是**第三次**同一個模式（§1.4），而前兩次的處置都是「把它接上」。**而它今天有六家的先例**：Codex 的 `/models` + TTL、opencode 的 60 分鐘 loop + `opencode models --refresh`、Pi 的 `pi update --models`、cc-custom 的啟動自動發現。**四家都有可達的呼叫者。**

**依「CLI 是開發/測試 harness」的裁定**：這是**宿主維運面**（設定與憑證的處置），不是產品功能 —— 與 `i-harness hooks` 同一個位置。

---

## 4. 施工順序

```
D1  移除 model 成員資格檢查        ← 最便宜，而且今天就讓 deepseek-flash 可用
D2  catalog 欄位 + 不推導的缺席語意  ← 讓第二條線恢復
D3  別名 + generatedAt             ← 讓它不再過期
D4  i-harness models --discover    ← 讓它能被刷新
```

**D1 先，因為它單獨就修好了症狀**，而且它是唯一一個**移除**而非新增的改動。

---

## 5. 紅先測試

| 測試 | 先紅於 |
|---|---|
| 一個不在目錄裡的 model id **解析成功**（不是 `invalid catalog`） | §1.3 的閘門 |
| 一個**未知的 provider** 仍然拒絕 | 反向：不能一起放寬 |
| 未編目模型拿到 **128k/16k**，而**不是** `undefined` | 沒有 fallback |
| `catalog: "deepseek"` 的 provider 拿到卡片，**即使它的 id 是 `deepseek1`** | §1.1 |
| **沒有 `catalog` 欄位**時**不推導** —— 落回 fallback 並記錄 | 「猜一個」的誘惑 |
| 別名：`deepseek-flash` 與 `deepseek-v4-flash` **都**命中同一張卡 | §1.2 |
| 表帶著 `generatedAt` | 沒有出處 |

**Mutation proof**：把成員資格檢查加回去 → 第一條轉紅；把 `catalog` 的缺席語意改成「推導」→ 第五條轉紅。

---

## 6. 這份設計**沒有**解決的

- **「同一個 vendor 兩把 key」的根因。** §2.4 說得很清楚：**四家都有問題**，只是輕重不同。Grok 是唯一不需要第二個 id 的，代價是**整個架構不同**（provider 在 model entry 裡）。**把我們的架構改成那樣是另一個里程碑**，而 D2 只讓第二條線「能用」，沒有讓它「不需要」。
- **`deepseek-v4-flash-vision-exp` 要不要留。** D3(b) 說留成別名，但**官方說它已下線** —— 留著是兼容、拿掉是乾淨。**產品決定。**
- **真 Anthropic / Bedrock 的 D4。** 見 `2026-09-19-d4-endpoint-cache-measurement.md`。
- **`max_output_tokens` 我們送不送、送多少。** Codex 完全不建模它；Pi/DSH/Grok 都有。**未查。**
- **六個來源的數字都是讀原始碼得到的，沒有一家被實跑驗證。** 除了 D4 那份量測。
