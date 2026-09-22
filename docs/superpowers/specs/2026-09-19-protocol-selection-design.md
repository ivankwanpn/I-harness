# 協議與模型的選擇 — 設計

**日期：** 2026-09-19 · **分支：** `d4-endpoint-cache`
**性質：** 這份文件是**決定**。每個決定的理由都可檢查；**未決**的地方標出來了。
**前置：** `2026-09-19-provider-lifecycle-design.md`（路由／模型列／指令面已落地）。
**取代：** 前一份的 **§8 第一條**（「發送時的協議覆寫」—— 從「未決」升為「已決定」）。

---

## 0. 為什麼有這份文件

前一份把協議固定在設定面：**路由宣告一個，模型列可以覆寫**。使用者的下一個需求是：

> session（主代理）的**模型和協議也會切換**；而且**子代理的角色**（每個角色自己的模型／協議／推理）以後會加。

一個 fork（opencode 的）已經有那個 UI：每個角色一個模型下拉、**一個協議下拉**。**而它就是使用者口中的「屎山」** —— 因為它有**兩條解析路徑**（session 一條、role 一條），同一件事在兩個地方各有一套規則。

**這份設計唯一的結構目標：一條鏈、一個機制、三個觸發點。**

**IH 不對任何提供商做特別處理** —— 路由是使用者開的，名字是他取的，baseURL 是他填的。下面的例子只是例子。

---

## 1. 原則：**協議是宣告的，不是推斷的**

> 已經成立（D1/D2 一路的原則）：值被宣告，宣告什麼就選哪個適配器，不認識就 **throw**。

**但宣告之後，配對是使用者的事**：

```
路由： baseURL = https://…/anthropic      protocol = anthropic-messages   ✓
同一個 baseURL                            protocol = openai-responses     ✗
```

**第二列我們不擋，也不猜。** 那條路徑不存在，**提供者會在送出提示詞之後報錯** —— 大聲、在對的地方、帶著它自己的訊息。

**這是有意的分工**：

| | 誰負責 |
|---|---|
| 「這個 baseURL 對不對」 | 使用者（他填的） |
| 「這個協議對不對」 | 使用者（他選的） |
| **「這兩者的組合能不能用」** | **提供者** —— 只有它知道 |

在本地先驗證會需要一張「哪個 URL 服務哪些協議」的表，而**那張表就是猜**（閘道、代理、區域變體全部會讓它出錯）。**寧可讓對的一端說「不行」，也不要讓錯的一端說「可以」。**

---

## 2. 解析序：**一條鏈**

```
role.protocol            ← 子代理角色的宣告（未來 UI 的下拉）
  > session.protocol     ← 這一次 session 的選擇（發起時組進去，**不落地**）
  > 模型列 protocol      ← 既有
  > 路由 protocol        ← 既有
  > （都沒有 → 錯誤，不是預設）
```

**三個來源都寫在同一處**（`runtimeProfile`），所以「誰贏」永遠只有一個答案。

### 沒有尾巴：解析不到協議就是**錯誤**

今天兩層都沒寫時，`openai-completions` 會**安靜地**套上去（`sections.ts:116`）。**這條尾巴拿掉。**

理由（使用者）：協議是**使用者設的、而且必填** —— 前端是幾個按鈕，沒有「不填」的可能；CLI 的 `provider add` **強制 `--protocol`**（不給就報錯並列出五個）。**所以真實世界裡沒有「兩層都沒寫」的設定** —— 除了手寫的檔案，而那些檔案**本來就該被告知**。

**而失敗本來就會發生**：`buildClient` 的 `default:` 已經在 throw（`provider/src/index.ts:880`）。這份設計只是把它**搬到對的地方、給它一句能行動的訊息**：

```
runtime.resolveModel()
  → 解析不到協議 ⇒ invalid（不是 ready）
      reason: 路由 "X" 沒有宣告協議；用 `i-harness provider set X --protocol P` 指定
```

**在解析時失敗，不是在建 client 時** —— 早一步、訊息帶著路由名與修法。（`--max-tokens`／模型等其它 `invalid` 狀態走的是同一條路。）

**代價講清楚**：一個**手寫的、沒有 `protocol` 的舊設定**會從「默默用 `openai-completions`」變成「**大聲拒絕並告訴你怎麼修**」。**這是有意的** —— 沉默的預設正是 D1 一路在消滅的東西，而它就是使用者最初那個 bug 的成因。

**`provider list` 相應地把「這條路由沒有協議、不能使用」標出來**（它不是預設來的，是**壞的**）。
（`SEEDED_PROTOCOLS` 是空的鉤子，留著：它是「內建路由自己知道協議」的位置 —— 但**它不再是預設**，它只是一個寫死的宣告。）

---

## 3. 為什麼這在結構上很便宜：**接縫已經在了**

`@i-harness/llm-seam` 就是內部格式：

```ts
export interface ModelClient { stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> }
export type LLMStreamEvent =
  | { type: "text/chunk"; text } | { type: "reasoning"; text }
  | { type: "tool_call"; call } | { type: "usage"; usage }
  | { type: "end" } | { type: "error"; error }
```

**五個適配器各自把自己那一種線路翻譯成這 6 種事件**（`llm-anthropic` 解 SSE、`llm-bedrock` 解 AWS event stream）。`core-agent` 只看得到事件：

```ts
for await (const ev of deps.model.stream(request))   // core-agent/src/index.ts:290
```

**⇒ 接縫以上完全不知道協議是什麼。** 換協議 = 換一個 client 物件；換模型 = 同一個 client 型別、不同的 id。**翻譯層不用動，也沒有東西要遷移。**

**這份設計因此完全不碰 `llm-*`，也不改任何設定形狀。**

---

## 4. 機制：`rebind` —— 一個機制，三個觸發點

### 4.1 兩個消費者（今天的地雷）

`deps.model` 有**兩個**消費者，而它們的取得方式不同：

| 消費者 | 位置 | 取得時機 |
|---|---|---|
| 回合迴圈 | `core-agent/src/index.ts:290` | **每回合讀 `deps.model`** ✓ |
| **壓縮引擎** | `core-agent/src/index.ts:142` | **建立時就抓走**（`model: deps.model`）✗ |

**只換一個 → 摘要會留在舊端點上** —— 而那是要花錢的呼叫。

**解法有現成的先例**：同一支檔案已經為 `requestShape` 用了 getter，理由寫在註解裡（`core-agent/src/index.ts:134-139`）：

> the agent hands the engine a **getter** — read at compact time, matching the LAST request rather than whatever was true at construction

**⇒ `model` 也改成 getter**（`model: () => ModelClient`）。一個改動涵蓋兩個消費者。

### 4.2 三個觸發點

```
rebind(選擇) = 重解析（§2 那條鏈）→ buildModelClient → 換掉 client
   ├─ ① session 發起時      既有的 binding 路徑（assembly 建立時）
   ├─ ② session 進行中      主代理切模型／協議
   └─ ③ 子代理角色          建立子代理時（§5）
```

**觸發點 ② 今天不存在**：`setSessionModel`（sdk）只寫 session meta，**下一次 assembly 才生效**。這份設計讓它**當場生效**。

**而「當場」需要一個明確的介面**（不是隨手改 `deps`）：

```ts
interface Agent { setModel(client: ModelClient): void }
```

`SessionService` 已經持有活的 assembly（`service.onAssembly`，CLI 的 rewind 就是用它拿 handle 的），所以路徑是：**service → 活的 assembly → `agent.setModel(重解析出來的 client)`**。**唯一被改的狀態就是那個 client 物件** —— 對話、預算、工具都不動。

**選擇的型別也要帶上它**：`SessionModelSelection` 與 role 的 `model` 各加一個 `protocol?: SettingsProviderProtocol`（**同一個形狀**，因為 §5 讓它們餵進同一個 `resolveModel`）。

### 4.3 不落地

session 的協議**不寫進任何檔案**（使用者決定）。後果講清楚：

```
i-harness run --protocol P "任務"        ← 這一次 session 用 P
i-harness run "任務" --resume <id>       ← 沒有 --protocol 就回設定解析出來的
```

（要「這個 session 永遠用 P」的人，該寫的是**設定** —— `provider set --protocol` / `models set --protocol`，兩條路都已經有了。）

---

## 5. 子代理：**同一條鏈**（順帶接掉一條死路）

### 5.1 今天（實測）

```ts
// packages/subagent/src/child.ts:150-155
let model = opts.parentModel                            // 繼承：父的 client 物件 ✓
if (opts.role.model) {
  const profile = opts.providers.get(opts.role.model.provider)
  if (!profile) throw new Error(`role '…' references unknown provider '…'`)
  model = buildModelClient(profile, …)                   // ✗
}
```

而 `opts.providers` 來自 `packages/session-executor/src/assembly.ts:697`：

```ts
const providers = createProviderRegistry()              // 空 registry
```

**全 repo 沒有任何地方往它註冊。** ⇒ **role 自帶模型的那條路徑從來沒生效過**，而且它**繞過 settings、憑證、卡片**。這是「消費者被刪掉」模式的第四個實例。

### 5.2 應該

`registerSubagent` 拿到的 `providers: ProviderRegistry` **換成一個解析函式**：

```ts
// 與 ProviderRuntime.resolveModel 同一個契約：ready 帶著 binding，其餘是狀態
resolveModel(selection: { provider: string; model: string; protocol?: SettingsProviderProtocol; reasoningEffort?: string })
  : Promise<ModelResolutionState>
```

**跟 session 用的是同一個**（`providerModelBindingFor` 那條）。role 的 `{ provider, model, protocol?, reasoningEffort? }` 直接餵進去 ⇒ **同一條鏈、同一套憑證、同一張卡片、同一個 rebind**。

**這正是防屎山的那一條線**：fork 之所以爛，是因為它有兩條解析路徑。**一條，就沒有「哪個生效」這個問題。**

**繼承（沒有 role.model）不變** —— 子代理拿到的是父**已經建好的 client 物件**，所以協議、模型、rebind 全部自動繼承，零工作。

---

## 6. 介面

| 入口 | 形狀 |
|---|---|
| CLI 一次性 | `i-harness run --protocol P "任務"`（**不落地**） |
| SDK / ACP（前端的下拉） | `setSessionModel({ …, protocol? })` → **當場 rebind**（§4.2②） |
| 子代理角色 | role 宣告 `{ provider, model, protocol?, reasoningEffort? }` |
| 設定（持久那一層） | `provider set <id> --protocol P`／`models set <route> <id> --protocol P`（**既有**） |

**`--protocol` 在 CLI 永遠不預設**：不給就用鏈上的下一層。

---

## 7. 未決 / 不做

- **角色的 UI**（模型／協議／推理三個下拉）：這份只做**後端的解析與 rebind**。UI 是前端回來時的事 —— 而它需要的正是這條鏈。
- **session 的協議持久化**：**不做**（使用者決定）。
- **`reasoningEffort` 的 session 層**：`SessionModelSelection` 已經有它，走同一條 rebind 即可；**不另開機制**。
- **baseURL 與協議的相容性預檢**：**不做**（§1）—— 提供者才是權威。
- **`--max-tokens` 仍然沒有消費者**（前一份 §8 的第三條，未動）。

---

## 8. 測試

| 對象 | 測什麼 |
|---|---|
| 解析序 | role > session > 模型列 > 路由；每一層各一條，且**只有一個地方**在解析（`runtimeProfile`） |
| **沒有協議 → invalid** | 一條沒有宣告協議、也沒有 role/session 覆寫的路由 ⇒ `resolveModel` 回 **invalid**（不是 ready），訊息**帶著路由名與修法**；**絕不 fallback 到任何協議** ← **突變目標**（把尾巴加回去 → 必須紅） |
| **rebind 的兩個消費者** | 換 client 之後，**壓縮引擎也用新的** ← **頭號突變目標**（把 getter 改回值 → 必須紅） |
| 觸發點② | sdk 的 `setSessionModel` 之後，**下一回合**就用新 client（今天要等下一次 assembly） |
| 子代理 | role 宣告模型 → 走**同一條**解析（含憑證與卡片），不再是「unknown provider」；沒有 role.model → 繼承父的 client 物件 |
| 不落地 | `run --protocol P` 之後，**settings.json 一字不變** |
| 壞的路由看得見 | `provider list` 對一條沒有宣告協議的路由，**說得出它「沒有協議、不能使用」**（不是預設來的，是壞的） |
| 突變 | 把 `model` 的 getter 換回值 → 摘要用舊端點，必須紅 |

---

## 9. 與既有決定的關係

| 既有 | 狀態 |
|---|---|
| provider-lifecycle（路由／模型列／兩棵指令樹） | **不動**，本設計疊在上面 |
| **D1**（未知模型放行） | 不動 |
| **D2**（`catalog` 家族） | 不動 |
| **D3**（出處 + 別名） | 不動 |
| **`llm-*` 五個適配器** | **完全不碰**（§3） |
| **設定的形狀** | **完全不改** —— 沒有新欄位（見下） |
| 前一份 §8 第一條（發送時覆寫：未決） | **本設計決定它** |

### 被否決的替代方案：`baseURLs`（路由每個協議帶一條路徑）

第一版提議過，**撤掉**。理由：

1. **兩條路徑本來就是兩個提供商條目** —— baseURL 不是同一個 URL，而路由的定義就是端點。使用者已經有那個動詞（`provider add`）。
2. **它會需要一張「哪個 URL 服務哪些協議」的表** —— 那張表就是猜（閘道、代理、區域變體都會讓它出錯）。
3. **配錯了由提供者報錯**（§1）—— 那比本地擋掉更好：**對的一端說話**。

---

## 10. 施工順序（兩個階段）

```
階段 A  解析鏈 + 選擇型別        ← 可單獨出貨
        SessionModelSelection / role.model 加 protocol?、
        runtimeProfile 那條鏈多兩層、
        **拿掉硬編碼尾巴**（沒有協議 ⇒ invalid + 可行動的訊息）、
        provider list 標出「沒有協議、不能使用」的路由

階段 B  rebind 機制 + 子代理     ← 疊在 A 上
        core-agent 的 model getter、agent.setModel、
        service → 活 assembly、sdk 的 setSessionModel 當場生效、
        run --protocol、子代理走同一條 resolveModel
```

**A 單獨出貨的價值**：`models set --protocol` 的覆寫**在下次 session 就生效**，而且誰贏看得見。
**B 才是「切換」** —— 它需要 A 的那條鏈才有意義。
