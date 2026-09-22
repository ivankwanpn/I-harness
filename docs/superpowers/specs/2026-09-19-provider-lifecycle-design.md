# Provider 生命週期 — 設計

**日期：** 2026-09-19 · **分支：** `d4-endpoint-cache`
**性質：** 這份文件是**決定**。每個決定的理由都可檢查；**未決**的地方標出來了。
**取代：** `2026-09-19-provider-model-catalog-design.md` 的 **D4**（`i-harness models [--discover]`）。

---

## 0. 為什麼有這份文件

使用者原本設想的流程（有前端時）：

> 輸入 provider 名字 → base_url → api key → **按按鈕發現模型** → **在列表裡多選要加入的模型** → 加入 → **設最大上下文窗口與最大輸出** → 保存

**M65 刪掉了 TUI 與 web，這個流程沒有介面了。** 而它剩下的後端是一組**完整卻無法行使**的方法：

| 方法 | 生產呼叫者 |
|---|---|
| `directory()` | **0** |
| `upsertProvider()` | **0** |
| `removeProvider()` | **0** |
| `setApiKey()` | **0** |
| `clearApiKey()` | **0** |
| `discoverModels()` | **0** |
| `setDefaultModel()` | **0** |

**七個零。** 而 reachability 儀器**看不到它們** —— 它們是介面方法，不是頂層 export，跟 `probeModels` 那條已知盲點同一類。

**「CLI 是開發／測試 harness」不是限制，是理由**：一個完整卻無法行使的後端會爛掉而沒有人知道 —— M65 刪掉唯一的呼叫者，沒有任何東西發現。`i-harness hooks approve` 當初就是為此存在的。

---

## 1. 資料形狀

### 1.1 路由（`llm.providers.<id>`）

| 欄位 | 誰寫 | 語意 |
|---|---|---|
| `baseURL` | `provider add/set` | host root；`/v1` 尾綴會被 strip |
| `protocol` | 同上 | **路由的預設協議**（見 §1.3） |
| `catalog` | 同上 `--catalog` | 卡片家族；**缺席 = 路由名** |
| `displayName` | 同上 | 顯示標籤 |
| `modelsURL` | 同上 | 發現端點覆寫 |
| `apiKeyEnv` | `provider key` | 憑證的**名字**，不是值 |
| `models[]` | `models add/set/rm/refresh` | 見 §1.2 |
| `headers` | **不在 CLI** | settings 專屬（會話／租戶標頭） |

### 1.2 模型列（新增一個欄位）

```jsonc
{ "id": "…",              // 必
  "protocol"?: Protocol,  // ★ 新增：覆寫路由的預設
  "contextWindow"?: number,
  "maxTokens"?: number,
  "name"?: string,
  "inputModalities"?: ("text"|"image")[] }
```

### 1.3 協議的三層解析

```
模型列 protocol  >  路由 protocol  >  openai-completions（既有硬編碼預設）
```

**最後那一臂是已知的陷阱**（見 §5）。CLI 的流程**永遠不依賴它**（`provider add` 強制 `--protocol`）；它留著只為了相容手寫的舊檔案。

### 1.4 數字的兩層 —— 沒有第三層

| 層 | key | 來源 | 優先 |
|---|---|---|---|
| ① 模型列 | (路由, 模型) | **使用者**（`models set`） | 最高 |
| ② 卡片 | **(家族, 模型)** | 廠商文件（`model-catalog.json`） | ① 缺席時 |
| ③ —— | — | **沒有** | **不猜** |

**③ 缺席的代價已經量過**：assembly 會大聲說「no context window could be resolved」並關閉自動壓縮（[assembly.ts:836-842](../../packages/session-executor/src/assembly.ts#L836-L842)、[service.ts:266-272](../../packages/session-executor/src/service.ts#L266-L272)）。**那是被支援的狀態，不是 bug。**

**④ 全域不存在，永遠不加。**

---

## 2. 為什麼協議放在「模型」，而不是「發送時」

三個有先例的形狀：

| | 協議在哪一層 | 一個 provider 多協議 | 發現時要不要猜協議 |
|---|---|---|---|
| **Pi 0.85.1** | **模型**（provider 給預設，model 可覆寫 `api` + `baseUrl`） | **✓ 在用** | 不用 —— **協議是資料** |
| **DSH 0.1.6** | adapter 的 config（`protocol?: DeepSeekProtocol`，預設 `messages`） | ✗ | 不用 |
| **IH 現況** | 路由 | 兩條路由 | 不用 |
| **發送時決定** | 請求 | ✓ | **要** |

**Pi 的證據**（`packages/ai/src/models.ts:788-792`）：

```ts
const single = typeof input.api.stream === "function" ? input.api : undefined
const byApi = single ? undefined : input.api          // ← 按協議名索引的 map
const apiFor = (model) => single ?? byApi?.[model.api]  // ← dispatch 看 MODEL 的 api
```

**而它真的在用 —— 7 個 provider 全部是閘道**（`openrouter`、`opencode`、`opencode-go`、`fireworks`、`github-copilot`、`cloudflare-ai-gateway`、`faux`）：

```ts
// src/providers/openrouter.ts
api: {
  "anthropic-messages": anthropicMessagesApi(),
  "openai-completions": openAICompletionsApi(),
},
```

**決定：採用 Pi 的形狀。** 理由：

1. **它是唯一有出貨先例的**，而且用的正是我們要解的那個情況（一個 host 多協議）。
2. **協議變成資料** —— 可檢驗、可重現、**發現不必猜**。（先前反對「下移到模型」的理由是「發現要猜協議」；**Pi 推翻了它**：協議跟著模型資料一起來，沒有東西要猜。）
3. **與 IH 既有的分工一致**：路由給預設，模型列覆寫 —— `contextWindow` 已經是這個形狀。
4. **改動小**：`resolveModel` 已經在 `runtimeProfile` 裡把協議寫進 profile；改成「模型列的協議優先」是一行。

**「發送時決定」不採用，但資料模型不妨礙它**（見 §8）。

---

## 3. 後端能力（`@i-harness/provider-runtime`）

### 3.1 新增五個

```ts
probeModels(id, options?: { signal?: AbortSignal }): Promise<ModelDescriptor[]>
addModels(id, rows: ModelDescriptor[]): Promise<ModelDescriptor[]>
removeModel(id, modelId: string): Promise<void>
createProvider(id, fields: CreateProviderFields): Promise<void>
patchProvider(id, patch: PatchProviderFields): Promise<void>
```

**`probeModels`** — 讀 view；路由未設定 → throw；`bedrock` → throw（manual-only）；無憑證 → throw；解析憑證 → `registry.probeModels({protocol: 路由的協議})`。**不寫 settings、不碰 memo。** 探到空陣列是合法結果。

**`addModels`** — 每列 `id` 非空。合併**沿用 `mergeDiscoveredModels`**（既有欄位優先，探測只補沒有的）。**一次 `persistLlm`。**

**`removeModel`** — 不存在 → throw。**不動 `llm.defaultModel`**：D1 之後沒有成員資格檢查，移除一顆不會讓執行壞掉，只會讓它從清單消失。

**`createProvider` / `patchProvider`** — 都建在既有的 `upsertProvider` 上（**一條寫入路徑**）。
`createProvider`：已存在 → throw。
`patchProvider`：不存在 → throw；**`models` 不在 patch 的欄位裡** —— 這是它存在的**全部理由**：改協議不會順手清空模型清單。TUI 的 `saveProvider` 就是為了這件事才把 current 的欄位全部帶回去，**而它住在刪掉的 UI 裡**。

### 3.2 改一個

```ts
discoverModels(id, opts) = memo/force 語意 + addModels(id, await probeModels(id, opts))
```

**一份 merge 實作，兩個動詞。** 既有 25 條測試的斷言**不改**（它們是重構的守衛）。

### 3.3 改一行（協議解析）

```ts
// resolveModel
const profile = runtimeProfile(view, apiKey, userModel?.inputModalities, userModel?.protocol)
//                                                        ↑ 模型列的協議優先
```

### 3.4 `@i-harness/settings`

`SettingsModel` 新增 `protocol?: SettingsProviderProtocol`；`normalizeProviderConfig` 沿用既有的 `PROVIDER_PROTOCOLS` 白名單（不合法 → 缺席，與 `protocol` 路由欄位同一條規則）。

---

## 4. 指令面

```
provider                                       端點
  list                                         讀：路由 + 實際家族 + 卡片命中 + 表的出處
  add  <id> --base-url URL --protocol P [--catalog F] [--display-name N] [--models-url URL]
  set  <id> [--base-url URL] [--protocol P] [--catalog F] [--display-name N] [--models-url URL]
  key  <id>                                    金鑰從 stdin 讀
  rm   <id>

models                                         端點上的模型
  [<route>]                                    讀：每顆模型命中哪張卡、實際協議、能不能 discovery
  probe <route> [--protocol P]                 ★ 唯讀探測，不寫入
  add   <route> <id…> [--protocol P] [--context-window V] [--max-tokens V]   ★
  set   <route> <id>  [--protocol P] [--context-window V] [--max-tokens V]   ★
  rm    <route> <id>                                                          ★
  use   <route>:<model> [--reasoning-effort E]
  refresh <route>                              探測 + 全部併入（＝舊 discoverModels）
```

**值 `V`**：`131072` / `128k` / `1m` / **`auto`**（＝清掉覆寫，落回**下一層**）。

> **`auto` 是刻意的** —— 要能設定，也要能取消設定。沒有它，寫下去的數字就再也回不到卡片。
> **`auto` 的意義依欄位而定**：`--context-window auto` 落回卡片；**`--protocol auto` 落回路由的預設**（不是落回硬編碼的 `openai-completions`）。

**`add`／`set` 帶多個 id 時，旗標套用到清單裡的每一顆。** 不支援逐顆不同的值（要不同就發多次指令 —— 那是一個指令一次網路寫入，不是猜）。

**`probe --protocol P` 是一次性參數，不落地** —— 它只決定這一次探測請求的 auth 標頭形狀。預設是**路由的協議**。

**輸出紀律**：stdout = 資料；stderr = 診斷；退出碼 0/1。**金鑰永不進 stdout**（顯示 `x…8f2a`）。

**`provider key`**：從 stdin 讀一行；**stdin 是 TTY 時警告**（會被回顯），建議 `printf %s "$KEY" | …`。**argv 永不碰金鑰。**

---

## 5. 錯誤處理

| 情況 | 行為 | 退出 |
|---|---|---|
| `provider add` 的 id 已存在 | 錯誤 + 指向 `provider set`；**不寫入** | 1 |
| `provider set` 的 id 不存在 | 錯誤 + 指向 `provider add` | 1 |
| `provider --protocol` 不在五個內 | 錯誤 + **列出五個**；**絕不預設、不接受 `auto`** | 1 |
| `models --protocol` 不在五個內也不是 `auto` | 錯誤 + 列出五個與 `auto` | 1 |
| `--base-url` 空 | 錯誤 | 1 |
| probe：無憑證／bedrock／全候選失敗 | runtime 的原訊息（逐候選摘要） | 1 |
| `models add` 空清單／空 id | 錯誤；**不寫入** | 1 |
| `models rm` 不存在 | 錯誤 | 1 |
| `models set` 在沒有該列的模型上 | 錯誤 + 指向 `models add` | 1 |
| `--max-tokens` 大於卡片的 `maxOutputTokens` | **警告，不阻擋** | 0 |
| 移除 `defaultModel` 指到的模型 | **不阻擋、不改預設**（執行不會壞） | 0 |

**倒數第二條是刻意的**：卡片是**文件值**，不是牆。既有立場是不合併、不夾限 —— 超出在模型端 fail-loud。

---

## 6. 完整流程走一遍

```
$ i-harness provider add deepseek2 \
    --base-url https://api.deepseek.com/anthropic \
    --protocol anthropic-messages --catalog deepseek
created provider "deepseek2" — anthropic-messages → https://api.deepseek.com/anthropic
card family: deepseek (declared)
next: i-harness provider key deepseek2

$ printf %s "$DEEPSEEK_API_KEY" | i-harness provider key deepseek2
stored DEEPSEEK2_API_KEY for "deepseek2" (x…8f2a)

$ i-harness models probe deepseek2
probing https://api.deepseek.com/anthropic (anthropic-messages) …
2 model(s) found — NOTHING was written:
  deepseek-flash        card 1,048,576 / 384,000
  deepseek-v4-pro       card 1,048,576 / 384,000
next: i-harness models add deepseek2 <id> …

$ i-harness models add deepseek2 deepseek-flash deepseek-v4-pro
added 2 row(s) to "deepseek2" — numbers come from the card, no override written

$ i-harness models set deepseek2 deepseek-v4-pro --context-window 128k
"deepseek2"/"deepseek-v4-pro": contextWindow 131,072 — OVERRIDES the card's 1,048,576

$ i-harness models use deepseek2:deepseek-flash
default model: deepseek2:deepseek-flash
```

**閘道（一個 host 兩種協議）：**

```
$ i-harness provider add my-gw --base-url https://gw.example --protocol openai-completions
$ i-harness models add my-gw anthropic/claude-sonnet-4 --protocol anthropic-messages
$ i-harness models add my-gw deepseek/deepseek-v3
"my-gw"/"anthropic/claude-sonnet-4" → anthropic-messages (overrides the route's openai-completions)
"my-gw"/"deepseek/deepseek-v3"       → openai-completions (the route's default)
```

> **「多選」在指令面上就是 `add` 後面接多個 id —— 免費。**

---

## 7. 測試

| 對象 | 測什麼 |
|---|---|
| `probeModels` | **settings 前後快照相等**（證明沒寫）；memo 不受影響；bedrock／無憑證拒絕 |
| `addModels` | 只動指定列；**既有 caps 不被探測值覆蓋**；一次寫入 |
| `removeModel` | 對稱；不存在 → 拋 |
| `patchProvider` | **模型清單與 `apiKeyEnv` 不被清掉** ← 突變證明的頭號目標 |
| **協議解析** | 模型列的協議勝過路由；模型列缺席 → 路由的；兩者都缺席 → 既有預設（**這一條要有，因為它是陷阱本身**） |
| `discoverModels` | 重構後 **25 條既有斷言全綠、一字不改** |
| CLI | 解析（`k`/`m`/`auto`）、渲染、退出碼、**金鑰不出現在 stdout** |
| **突變** | 拆掉 `patchProvider` 的合併 → 模型清單從設定消失；拆掉協議優先序 → 閘道那條紅 |

---

## 8. 未決 / 另案

- **發送時的協議覆寫。** 資料模型不妨礙它：模型列的協議是**預設**，一個 session 級的覆寫可以疊在上面而不動資料。**但它是另一個單元**，而且它要回答「缺席時怎麼辦」（今天的答案是一個靜默的 `openai-completions`）。
- **閘道多廠商的卡片。** 一條路由代理多個廠商時，一個 `catalog` 家族蓋不住所有模型。**出口是不要宣告 `catalog`，用逐顆數字**（§1.4 的①），不是給路由掛多個家族 —— 那會製造「同一顆 id 在兩個家族都命中時誰贏」的歧義。**這個出口夠不夠好，未決。**
- **`--max-tokens` 目前沒有消費者。** 卡片的 `maxOutputTokens` 被解析、驗證、穿過五層鏈，然後在 [provider-runtime:403-407](../../packages/provider-runtime/src/index.ts#L403-L407) 被丟掉（`?.contextWindow`）。**這份設計讓它可被設定，但沒有讓它被使用。**

---

## 9. 與既有決定的關係

| 既有 | 狀態 |
|---|---|
| **D1**（移除成員資格檢查） | **是這份設計的前提**：`models rm` 不會弄壞執行，`models add` 不是許可證 |
| **D2**（`catalog` 家族） | 保留。**「每顆模型獨立」不必手工重複的唯一原因** |
| **D3**（出處 + 別名） | 保留。`provider list` 印出表的出處 |
| **D4**（`i-harness models [--discover]`） | **被這份取代** |
| **協議在路由** | 改成**路由是預設、模型可覆寫** |
