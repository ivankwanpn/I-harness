# 代理角色 — 設計

**日期：** 2026-09-19 · **分支：** `d4-endpoint-cache`
**性質：** 這份文件是**決定**。每個決定的理由都可檢查；**未決**的地方標出來了。
**前置：** `2026-09-19-protocol-selection-design.md`（§5 是這份的**機制**：role 的選擇餵進同一條 `resolveModel`）。

---

## 0. 為什麼有這份文件

使用者的需求：

> 先把那四個角色預設在項目裡；後面使用者想怎麼加是他自己的事。
> **現在先讓主代理有子代理用 —— 不然只能派跟主代理同一個模型的子代理，還是有點不方便的。**

**四個角色已經在了**（`general` / `explore` / `research` / `worker`，`roles.ts` 的註解自己寫著 *patterned on opencode's built-in agent prompts*）。**缺的是「指定每個角色用哪顆模型」這件事能成立。**

---

## 1. 一個張力，它決定了「預設」能是什麼

**我們不默認提供商。** 所以一個內建角色**不可能自帶模型** —— 那等於替使用者選了廠商，而且每個廠商的「便宜模型」名字都不一樣。

| | |
|---|---|
| 四個角色存在 | ✓ **已經是了** |
| 它們的模型**由宿主指定** | ✗ ← 這份文件補的就是這塊 |
| 沒有指定 | **繼承父的 client**（今天的行為，一個字不改） |

**「預設」因此是**：四個角色是專案的預設角色，而**每個角色用哪顆模型是設定**。使用者之後自己加角色、自己配，都是同一條路。

---

## 2. 資料形狀：新分區 `agents`

```jsonc
"agents": {
  "roles": {
    "general":  { "provider": "deepseek1", "model": "deepseek-flash",
                  "protocol": "anthropic-messages", "reasoningEffort": "max" },
    "explore":  { "provider": "deepseek1", "model": "deepseek-flash", "reasoningEffort": "off" },
    "research": { "provider": "deepseek1", "model": "deepseek-v4-pro" },
    "worker":   { "provider": "deepseek1", "model": "deepseek-v4-pro", "reasoningEffort": "max" }
  }
}
```

**型別**：條目 = **`SettingsDefaultModel`**（既有的 `{ provider, model, reasoningEffort? }`）**加 `protocol?`** —— **不發明新的形狀**。它跟 session 的模型選擇是同一組欄位（settings 套件不依賴 session-persistence，所以兩邊各有一份同形狀的型別，這件事已經存在，不會變得更糟）。

**形狀跟 `llm.providers.<id>` 同一個模式**（一個平面，底下一個以名稱為鍵的表）。
（上面那個 provider 只是**例子** —— 這份設計不對任何提供商做特別處理。）

**三條規則**：

1. **`provider` 與 `model` 一起給**。半個不是設定，是猜（「同一個廠商換顆模型」也要明寫廠商）。CLI 對半個的輸入**拒絕**。
2. **`roles set` 整條取代**，不是逐欄位合併 —— 沒給的欄位就是**清掉**（與 `models set` 的「給了才動」不同，因為這裡的單位是「這個角色用什麼」，不是一堆獨立欄位）。要逐欄位改就先把現值寫進去。
3. **未知的角色名 → 拒絕**，並列出已知的四個。（新增角色是 §11 的事，不是這條路的副作用。）

**正規化**：逐欄位、壞的丟掉，跟 `normalizeProviderConfig` 同一條規則；**空物件 = 沒有指定**（不是「指定了空的」）。

---

## 3. 解析（**spawn 時**，不是組裝時）

```
spawn_agent(agent_type) 的那一刻：
  ① settings.agents.roles[role]         ← 宿主宣告的（這份文件）
  ② 已註冊的 role.model                  ← session 快照 / 插件帶的（今天永遠沒有，見 §5）
  ③ 都沒有 → 繼承父的 client              ← 今天的行為
  ①② 有 → resolveModel(選擇)             ← protocol spec §5 那條**同一條鏈**
```

**為什麼在 spawn 時讀**：角色是 spawn 那一刻查的（`deps.roles.get(...)`），所以在 spawn 時解析，**設定改了在下一次 spawn 就生效** —— 不必重開 session、也不必 rebind。

**而解析走的是同一條鏈**（protocol spec §2）：`role > session > 模型列 > 路由 > 錯誤`。所以角色指定的 provider 拿到的是**同一套憑證、同一張卡片、同一個協議解析** —— 不是第二條路。

---

## 4. 兩個來源，以及為什麼 settings 優先

角色今天**已經有**一個持久化的家：**session 快照**（`coordinator.putDocument(stateId, snapshotState(...))`，`persist.ts:286`）。那是 TUI 時代的形狀 —— 你在 session 裡編輯角色，它跟著 session 存。

**但使用者要的是宿主層的東西**（「讓專案的主代理有子代理用」），而 session 快照是**每一個 session 各自一份**。

**所以**：

| 來源 | 層級 | 誰寫 |
|---|---|---|
| **`agents.roles.<name>`（settings）** | **宿主** | 使用者（今天：檔案／CLI；以後：那一頁 UI） |
| session 快照裡的 role | 每個 session | 今天沒有介面寫它（TUI 已刪） |

**優先序：settings 先。** 理由是**它是宿主刻意的設定，而快照是 per-session 的殘留** —— 一個 session 的舊副本不該蓋掉宿主現在的決定。

**今天兩者的內容不衝突**（快照裡的 role 從來沒有 model），所以這個優先序今天不改變任何行為；它是在為「未來有一個 in-session 編輯器」先把規則定好。

---

## 5. 邊界：**插件仍然不能指定 provider**（既有決定，不動）

`packages/plugin-registry/src/mount.ts:87-90` 已經寫死了：

> **`model` is deliberately NOT carried.** A role naming a MODEL would be fine, but `SubagentRole.model` also carries a `provider`, and **the provider belongs to the host**.

**這份文件不開那道門**（那句「只指定 model 倒是可以」留著不動）。理由：一個插件若能替宿主的角色挑模型，就是替**宿主花錢** —— 那是宿主的決定，跟 provider 是同一個邊界。**要開是另一件事，需要它自己的邊界分析。**

---

## 6. 消費者（三個，今天兩個是死的）

| 位置 | 今天 | 之後 |
|---|---|---|
| `child.ts:150-155`（spawn） | `opts.providers.get()` → **空 registry → 一定 throw** | **§3 那條鏈** |
| `tools.ts:553-563`（resident / resume 的路徑） | 同上（同一段程式碼形狀，`deps.providers`） | 同上 |
| `projection.ts:163`（job row 的顯示） | 印 `role.model`（**永遠不會有值**） | 印**解析出來的**選擇 |

**三個都要改到同一個解析** —— 兩個「取得模型」的地方各寫一份，就是那個 fork 的屎山。

---

## 7. 失敗

角色指定了**不存在的 provider／model**（或那條路由沒有協議）⇒ **spawn 失敗**，訊息可行動：

```
cannot spawn 'worker': provider "deepseek9" is not configured
  set it with: i-harness provider add deepseek9 …
  or clear the role's model: i-harness roles unset worker
```

**用 protocol spec §2 那條 `invalid` 狀態**，不新增錯誤型別。

---

## 8. 介面

| 入口 | 形狀 |
|---|---|
| **設定檔** | `agents.roles.<name>`（今天就能手寫） |
| **CLI** | `i-harness roles list` · `roles set <role> --provider P --model M [--protocol X] [--reasoning-effort E]` · `roles unset <role>` |
| 前端（以後） | 那一頁「代理程式」＝這張表的 UI |

`roles list` 要印**每個角色的有效模型**：宣告的、還是**繼承來的** —— 「誰贏」看得見（跟 `provider list` 印家族同一個規矩）。

**`roles set` 的旗標**：`--provider` 與 `--model` **必填**（§2 規則 1）；`--protocol`、`--reasoning-effort` 選填。**`roles unset <role>`** 把整條拿掉（回到繼承）。**未知的角色名 → 拒絕並列出四個**（§2 規則 3）。

---

## 9. 測試

| 對象 | 測什麼 |
|---|---|
| 解析的順序 | settings > 已註冊 role.model > 繼承；三條各一 |
| **同一條鏈** | 角色指定的 provider 走的是**憑證 + 卡片**（不是那個空 registry）← **頭號突變目標**：改回 `providers.get()` → 必須紅 |
| 兩個消費者 | spawn **和** resident/resume 兩條路徑拿到同一個解析結果 |
| 繼承不變 | 四個角色都不指定 → 行為與今天**逐位元相同** |
| 壞的指定 | 未知 provider／沒有協議 → spawn 失敗，訊息**帶著角色名與修法** |
| 正規化 | 空物件 = 沒指定；壞的欄位逐個丟掉 |
| `roles list` | 印得出「繼承來的」vs「宣告的」 |

---

## 10. 與其他 spec 的關係 / 施工順序

| 既有 | 狀態 |
|---|---|
| provider-lifecycle | 不動 |
| **protocol-selection §2**（那條鏈） | **依賴它** —— 這份的 §3 是那條鏈的一個呼叫者 |
| **protocol-selection §5**（role 餵進同一個 `resolveModel`） | **就是這份的機制** |
| 插件的 provider 邊界 | **不動**（§5） |
| `llm-*` 五個適配器 | 不碰 |

**順序**：protocol-selection 的**階段 A**（那條鏈）必須先落地，這份才有東西可接。**它的階段 B（rebind）不是必要條件** —— 角色在 spawn 時解析，不需要 rebind。

---

## 11. 未決 / 不做

- **使用者自訂角色**（加新的、改 prompt／工具）：「後面使用者想怎麼加是他自己的事」——**這份不做**，但資料形狀（一個以名稱為鍵的表）已經為它留好了位置。
- **角色層的 `tools` / `systemPrompt` 設定**：同上一條。
- **插件指定 model（不指定 provider）**：**不做**（§5）。
- **in-session 的角色編輯器**：快照那條路留著，但沒有介面；**不做**。
