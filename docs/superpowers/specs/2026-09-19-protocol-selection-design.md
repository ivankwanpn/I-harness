# 協議與路徑的選擇 — 設計

**日期：** 2026-09-19 · **分支：** `d4-endpoint-cache`
**性質：** 這份文件是**決定**。每個決定的理由都可檢查；**未決**的地方標出來了。
**前置：** `2026-09-19-provider-lifecycle-design.md`（路由／模型列／指令面已落地）。
**取代：** 前一份的 **§8 第一條**（「發送時的協議覆寫」—— 從「未決」升為「已決定」）。

---

## 0. 為什麼有這份文件

前一份把協議固定在設定面：**路由宣告一個協議，模型列可以覆寫**。使用者的下一個需求是：

> session（主代理）的**模型和協議也會切換**；而且**子代理的角色**（每個角色自己的模型／協議／推理）以後會加。

一個 fork（opencode 的）已經有那個 UI：每個角色一個模型下拉、**一個協議下拉**。**而它就是使用者口中的「屎山」** —— 因為它有**兩條解析路徑**（session 一條、role 一條），同一件事在兩個地方各有一套規則。

**這份設計唯一的結構目標：一條鏈、一個機制、三個觸發點。**

---

## 1. 原則：**不猜**

> 「東西都全了爲什麽要猜，用就是了。」

推論到三個層面：

| | 不猜的意思 |
|---|---|
| **協議** | 已經成立（D1/D2 一路的原則）：值被宣告，宣告什麼就選哪個適配器，不認識就 **throw** |
| **路徑** | **這份文件新增。** 路由若宣告了每個協議的路徑，選一個沒宣告的協議 → **拒絕**，不是回退到 `baseURL` |
| **模型** | 已經成立：未知的模型 id 放行（D1），但**那不等於猜**——它只是不擋；能力數字仍然只有卡片或宣告才有 |

**「不猜」不等於「永遠失敗」**：它是「**資料不全時不假裝知道**」—— 拒絕、或走一條被支援的降級路徑（例如沒有 contextWindow 就是沒有，assembly 會大聲說）。

---

## 2. 資料形狀：路由的**端點集**

現在的路由是**一個**端點：

```jsonc
{ "protocol": "anthropic-messages",
  "baseURL": "https://api.deepseek.com/anthropic" }
```

新增一個**選配**的對照表，讓一條路由可以宣告**多個端點**：

```jsonc
{ "protocol": "anthropic-messages",                    // 主要端點（不變）
  "baseURL": "https://api.deepseek.com/anthropic",
  "baseURLs": {                                        // ★ 新增：這條路由還服務哪些協議、各自在哪
    "openai-completions": "https://api.deepseek.com"
  } }
```

型別：`baseURLs?: Partial<Record<SettingsProviderProtocol, string>>` —— 鍵是**那五個協議名**，值是一條 baseURL。空字串／非字串的值在正規化時**逐項丟棄**（與 `normalizeProviderHeaders` 同一條規則：壞的一項消失，不讓整份文件失敗）。

**解析（不猜）**：

```
端點(路由, 協議) =
  協議 ∈ 路由.baseURLs         → baseURLs[協議]          ← 宣告過，用它
  路由.baseURLs 不存在         → 路由.baseURL             ← 舊形狀（單一端點），不變
  否則                         → 拒絕（這條路由不服務這個協議）
```

**換句話說**：`baseURLs` 一旦出現，它就是**完整的端點宣告** —— 沒列在上面的協議，這條路由**不服務**，而不是「大概可以用 baseURL」。

### 為什麼是選配的對照表，而不是「一個協議一條路由」

一條協議一條路徑 = 一個端點 = **本來就該是一條路由**，而 D2 的 `catalog` 已經讓第二條路由變便宜（共用卡片）。**那仍然是對的做法**，而且對「兩把金鑰」也成立。

`baseURLs` 存在是為了**同一個憑證、同一個模型清單、同一組能力數字**下的兩條路徑 —— 而模型清單與能力兩者都**與協議無關**（§4）。**兩條路由會把模型清單複製兩份**，那正是 D3 才剛消滅過的形狀（複製的資料有兩個地方要改）。

**兩個都支援，不衝突**：想要兩把金鑰／兩個模型清單 → 兩條路由；同一個東西兩種線路 → `baseURLs`。

---

## 3. 解析序：**一條鏈**

```
role.protocol            ← 子代理角色的宣告（未來 UI 的下拉）
  > session.protocol     ← 這一次 session 的選擇（發起時組進去，**不落地**）
  > 模型列 protocol      ← 既有
  > 路由的端點集          ← §2（宣告過才用；沒有 baseURLs 就是 baseURL）
  > 拒絕                  ← **不再有硬編碼的 openai-completions 尾巴**（見下）
```

**最後那一臂要拿掉**：今天兩層都沒寫時，`openai-completions` 會**安靜地**套上去（`sections.ts:116`）。

- **有 `baseURLs` 的路由**：沒有尾巴 —— 沒宣告的協議就是拒絕。
- **只有 `baseURL` 的舊路由**：尾巴**留著**（否則每個手寫的舊檔都會突然拒絕），但 `createProvider` **強制 `--protocol`**，所以 CLI 產生的設定永遠不會走到那裡。

**這條鏈的三個來源都寫在同一處**（`runtimeProfile`），所以「誰贏」永遠只有一個答案。

---

## 4. 為什麼這在結構上很便宜：**接縫已經在了**

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

**這份設計因此完全不碰 `llm-*`。**

---

## 5. 機制：`rebind` —— 一個機制，三個觸發點

### 5.1 兩個消費者（今天的地雷）

`deps.model` 有**兩個**消費者，而它們的取得方式不同：

| 消費者 | 位置 | 取得時機 |
|---|---|---|
| 回合迴圈 | `core-agent/src/index.ts:290` | **每回合讀 `deps.model`** ✓ |
| **壓縮引擎** | `core-agent/src/index.ts:142` | **建立時就抓走**（`model: deps.model`）✗ |

**只換一個 → 摘要會留在舊端點上** —— 而那是要花錢的呼叫。

**解法有現成的先例**：同一個檔案已經為 `requestShape` 用了 getter，理由寫在註解裡（`core-agent/src/index.ts:134-139`）：

> the agent hands the engine a **getter** — read at compact time, matching the LAST request rather than whatever was true at construction

**⇒ `model` 也改成 getter**（`model: () => ModelClient`）。一個改動涵蓋兩個消費者。

### 5.2 三個觸發點

```
rebind(選擇) = 重解析（§3 那條鏈）→ buildModelClient → 換掉 client
   ├─ ① session 發起時      既有的 binding 路徑（assembly 建立時）
   ├─ ② session 進行中      主代理切模型／協議
   └─ ③ 子代理角色          建立子代理時（§6）
```

**觸發點 ② 今天不存在**：`setSessionModel`（sdk）只寫 session meta，**下一次 assembly 才生效**。這份設計讓它**當場生效**。

**而「當場」需要一個明確的介面**（不是隨手改 `deps`）：

```ts
// core-agent：Agent 對外暴露一個換法，內部只換那一個箭頭指向的 client
interface Agent { setModel(client: ModelClient): void }
```

`SessionService` 已經持有活的 assembly（`service.onAssembly`，CLI 的 rewind 就是用它拿 handle 的），所以 rebind 的路徑是：**service → 活的 assembly → agent.setModel(重解析出來的 client)**。**唯一被改的狀態就是 client 物件本身** —— 對話、預算、工具都不動。

**而「選擇」的型別也要帶上它**：`SessionModelSelection` 與 role 的 `model` 各加一個 `protocol?: SettingsProviderProtocol`（兩者是同一個形狀，因為 §6 讓它們餵進同一個 `resolveModel`）。

### 5.3 不落地

session 的協議**不寫進任何檔案**（使用者決定）。代價要講清楚：

**resume 一個舊 session → 回到設定裡解析出來的協議**，除非再給一次。今天的 `run` 因此是：

```
i-harness run --protocol P "任務"        ← 這一次 session 用 P
i-harness run "任務" --resume <id>       ← 沒有 --protocol 就回設定
```

（要「這個 session 永遠用 P」的人，該寫的是**設定** —— `provider set` / `models set --protocol`，兩條路都已經有了。）

---

## 6. 子代理：**同一條鏈**（順帶接掉一條死路）

### 6.1 今天（實測）

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

### 6.2 應該

`registerSubagent` 拿到的 `providers: ProviderRegistry` **換成一個解析函式**：

```ts
// 與 ProviderRuntime.resolveModel 同一個契約：ready 帶著 binding，其餘是狀態
resolveModel(selection: { provider: string; model: string; protocol?: SettingsProviderProtocol; reasoningEffort?: string })
  : Promise<ModelResolutionState>
```

**跟 session 用的是同一個**（`providerModelBindingFor` 那條）。role 的 `{ provider, model, protocol?, reasoningEffort? }` 直接餵進去 ⇒ **同一條鏈、同一套憑證、同一張卡片、同一個 rebind**。

**這正是防屎山的那一條線**：fork 之所以爛，是因為它有兩條解析路徑。**一條，就沒有「哪個生效」這個問題。**

---

## 7. 指令面 / 介面

| 入口 | 形狀 |
|---|---|
| CLI 一次性 | `i-harness run --protocol P "任務"`（**不落地**） |
| SDK / ACP（前端的下拉） | `setSessionModel({ …, protocol? })` → **當場 rebind**（§5.2②） |
| 子代理角色 | role 宣告 `{ provider, model, protocol?, reasoningEffort? }` |
| 設定（持久的那一層） | `provider set <id> --protocol P`／`models set <route> <id> --protocol P`（既有） |
| 端點集 | `provider set <id> --base-url-for P=URL`（可重複；`--base-url-for P=` 空值 = 拿掉那一項） |

**`--protocol` 在 CLI 永遠不預設**：不給就用鏈上的下一層；鏈上沒有就**拒絕並列出可用的**。

---

## 8. 未決 / 不做

- **角色的 UI**（模型／協議／推理三個下拉）：這份只做**後端的解析與 rebind**。UI 是前端回來時的事 —— **而它需要的正是這條鏈**。
- **session 的協議持久化**：**不做**（使用者決定）。resume 回到設定的解析結果。
- **`reasoningEffort` 的 session 層**：`SessionModelSelection` 已經有它，走同一條 rebind 即可；**不另開機制**。
- **`--max-tokens` 仍然沒有消費者**（前一份 §8 的第三條，未動）。

---

## 9. 測試

| 對象 | 測什麼 |
|---|---|
| 端點集解析 | 宣告過的協議 → 用它；**宣告過但沒列出 → 拒絕**（不是回退）；**沒有 `baseURLs` 的舊路由 → baseURL，行為不變** |
| 解析序 | role > session > 模型列 > 端點集；每一層各一條，且**只有一個地方**在解析（`runtimeProfile`） |
| **rebind 的兩個消費者** | 換 client 之後，**壓縮引擎也用新的** ← **頭號突變目標**（把 getter 改回值 → 必須紅） |
| 觸發點② | sdk 的 `setSessionModel` 之後，**下一回合**就用新 client（今天要等下一次 assembly） |
| 子代理 | role 宣告模型 → 走**同一條**解析（含憑證與卡片），不再是「unknown provider」 |
| 不落地 | `run --protocol P` 之後，**settings.json 一字不變** |
| 突變 | 把 `model` 的 getter 換回值 → 摘要用舊端點，必須紅 |

---

## 10. 與既有決定的關係

| 既有 | 狀態 |
|---|---|
| provider-lifecycle（路由／模型列／兩棵指令樹） | **不動**，本設計疊在上面 |
| **D1**（未知模型放行） | 不動 |
| **D2**（`catalog` 家族） | 不動；它是「兩條路由共用卡片」的依據 |
| **D3**（出處 + 別名） | 不動 |
| **`llm-*` 五個適配器** | **完全不碰**（§4） |
| 前一份 §8 第一條（發送時覆寫：未決） | **本設計決定它** |

---

## 11. 施工順序（兩個階段，各自可出貨）

這份不是兩個獨立子系統，是**疊在一起的兩層**；但切成兩段的話，第一段單獨就有用：

```
階段 A  解析鏈 + 端點集        ← 可單獨出貨
        settings 的 baseURLs、runtimeProfile 的那條鏈、
        provider set --base-url-for、拒絕未宣告的協議
        （還沒有 rebind：協議仍然是綁定時定的，只是多了兩層來源可以之後接）

階段 B  rebind 機制 + 子代理   ← 疊在 A 上
        core-agent 的 model getter、agent.setModel、
        service → 活 assembly、sdk 的 setSessionModel 當場生效、
        run --protocol、子代理走同一條 resolveModel
```

**A 單獨出貨的價值**：DeepSeek 這種「一個憑證兩條路徑」立刻可用（設定裡宣告兩個端點，選哪個協議走哪條路）。**B 才是「切換」** —— 它需要 A 的那條鏈才有意義。
