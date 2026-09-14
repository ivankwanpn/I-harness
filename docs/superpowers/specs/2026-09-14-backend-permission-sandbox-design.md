# I-harness 後端權限與沙箱模型設計

**日期** 2026-09-14 · **分支** `m62` · **依據** `docs/audit/2026-09-11-sevenway-backend-mechanisms.md`（434 列、七源機制矩陣）

---

## 0. 這份文件要解決什麼

`safety` 是 D3 裡缺口最大的域：**45 個缺口、其中 33 條是 `rewrite`**——意即 IH 沒有、需要自己建。同時那裡有三個我剛修完缺陷二之後仍留下的洞（`terminal` 的 PTY、`fs-search` 的 rg 子行程、讀取隔離）。

在動手之前，先把七個參考源**實際怎麼做**看清楚，再決定 IH 要走哪條路。以下每一條都有出處，不是印象。

---

## 1. 七源其實是三種架構，不是七種實作

看機制的**組成**而不是數量，七源清楚分成三類：

### A 類：OS 圍堵優先（ih、dsh、codex、grok）

安全邊界是**核心層**（bwrap／seatbelt／Windows restricted token），權限層是**審批**。

| 源 | 形狀 |
|---|---|
| **ih**（13） | OS 沙箱扎實且 fail-closed（無 provider 就 `SandboxUnavailableError`、runner 失敗 exit 125/127 轉成同樣的錯誤），**但權限層很薄**——只有三層審批政策＋一個**諮詢性**的危險指令分類器。升級階梯存在但無生產呼叫者 |
| **dsh**（16） | 這一類裡最完整的。**政策是 per-call 攜帶的**（`SandboxExecutionPolicy` 隨每次能力呼叫傳遞，**不固定在 provider 上**），platform runner chain 先選後探、per-runner dialect 合成、Windows SID 生命週期、**fs mutation containment fence**、審批政策與同回合稽核配對 |
| **codex**（6） | 精簡但有結構：permission profile model + requirement/allowed catalog、session 級審批快取、**sandbox violation classification** |
| **grok**（18） | 一半是 OS 圍堵，一半是**企業治理**（見 C 類） |

### B 類：權限引擎優先（opencode、cc-custom）

邊界是**可設定的規則引擎**，OS 沙箱**缺席**（opencode 明確是 `no-os-level-sandbox`）或**委外**（cc-custom 的 `os-sandbox-delegation`）。

| 源 | 形狀 |
|---|---|
| **opencode**（6） | permission rule engine＋ask queue＋session 持久化＋core permission service v2。**沒有 OS 沙箱**，靠規則與目錄閘（MCP、外部目錄） |
| **opencode-fork**（7） | 加上 V1→V2 遷移、remembered rules、**subagent grant 與 blocked permissions**、plugin 接縫 |
| **cc-custom**（16） | 規則階梯＋mode model＋**bypass killswitch**＋denial circuit breaker＋dangerous-allow stripping＋rule shadow detection＋LLM 危險分類器＋SSRF 防護。是七源中權限**UI／治理面最厚**的 |

### C 類：治理與來源信任（grok 的另一半）

這是**只有 grok 有**的一層，而且是為企業部署設計的：

- `root-owned-managed-policy-pin`、`macos-mdm-forced-managed-preferences`——政策由組織下壓，使用者改不動
- **`ed25519-signed-policy-at-rest-fail-closed-arm`**——靜態政策有簽章
- **`build-provenance-folder-trust-gate`**——**載入專案設定前先驗證資料夾信任**
- `config-overlay-confinement-allowlist`——環境覆寫需白名單收斂
- `managed-mcp-and-marketplace-denylists`、`enterprise-proxy-ca-bundle`

---

## 2. IH 的定位與四個結構缺口

**IH 屬於 A 類**，與 dsh 最接近。但與 dsh 相比，四個差距是**結構性**的，不是功能數量問題：

### 缺口 1：政策**不是 per-call 的**（最根本）

IH 在 `packages/session-executor/src/assembly.ts:298-303` 解析一次：

```js
const sandboxPolicy = opts.sandbox === undefined ? undefined
  : createSandboxPolicy({ mode: opts.sandbox, workspaceRoot: opts.workspace })
      .resolve({ session: opts.policySession })
```

之後 `writeGuard`（L368）與 `registerShell`（L304-310）**閉包捕獲了那個物件**。而 `packages/sandbox-policy/src/session-mode.ts:9` 明明會讀最後一個 `sandbox/mode` 事件——**機制存在，但只在建構時讀一次**。

**後果**：session 中途附加 `sandbox/mode` 事件**不會生效**，必須整個 session 重新組裝。而**升級階梯（escalation）本質上就是中途改模式**——所以缺口 3 不只是「沒有呼叫者」，而是**現有架構接不上**。

dsh 的做法是把政策**隨每次呼叫傳遞**。這一點值得直接取用。

### 缺口 2：拒絕沒有分類

dsh 有 `shell-confinement-wrap-and-denial-classification`、codex 有 `sandbox-violation-classification`、cc 有 `sandbox-violation-surfacing`。IH 在修缺陷二時我加了 `FS_SANDBOX_DENIED`——**那是起點，不是終點**：目前 shell 的拒絕與 fs 的拒絕是兩套不同的錯誤形狀，模型看到的話不一樣。

### 缺口 3：升級階梯不可達，且**現有架構接不上**

`packages/sandbox/src/index.ts:75-82` 有 `WIDER_MODES`、`approveEscalation`、`sandboxDenialMarker`、`escalationHintMarker`——**全部只在測試裡**。而且我在 D1 記過：**沒有任何 tool schema 宣告它廣告的 `sandbox_permissions`／`justification` 參數**。

缺兩塊：**（a）** 工具要用 schema 宣告參數並在拒絕時回傳標記；**（b）** 政策要能在同一 session 內改變（缺口 1）。

### 缺口 4：讀取隔離完全沒有實作——**而 grok 是唯一解掉的**

IH、dsh、codex、cc 都宣告 `readIsolation: false`：bwrap 用 `--ro-bind / /`（**寫入隔離了，內容沒有**），Windows 的 `WRITE_RESTRICTED` 只交寫入權限。IH 的 `requireReadIsolation` 閘**只被測試上膛**。

**grok 的 `bwrap-reexec-with-read-deny-placeholders` 是七源中唯一真正的讀取拒絕實作**——用不可讀的佔位掛載覆蓋敏感路徑。這是可以參考的具體做法。

---

## 3. 設計

### 3.1 政策改為 per-call 解析（先做這個）

**問題**：政策在 assembly 固定，中途改模式無效。

**設計**：把 `writeGuard` 從「捕獲一個 policy 物件」改成「每次呼叫解析」：

```
// 現在（固定）
const sandboxPolicy = resolve(...)
const writeGuard = (abs) => checkWrite(sandboxPolicy, abs)

// 改為（per-call）
const writeGuard = (abs) => checkWrite(resolvePolicyNow(session), abs)
```

代價是每次寫入多一次事件掃描。`effectiveSandboxMode` 是**反向掃描到最後一個事件**，所以最壞情況是 O(事件數)。**要先量測**——若太慢，改成「快取 + 在 `sandbox/mode` 事件時失效」。

**取用來源**：dsh `sandbox-mode-vocabulary-and-per-call-policy`（`packages/sandbox/sandbox-policy/src/index.ts:163-170`）與 `session-sandbox-mode-override-log`。

### 3.2 統一拒絕形狀

shell 與 fs 的拒絕要走同一個可分類的形狀，讓模型能用同一套邏輯反應：

- 穩定代碼（`SANDBOX_DENIED`，附 `surface: "shell" | "fs" | "search" | "terminal"`）
- **人可讀的原因**（現在的 `checkWrite` 已經有了）
- **升級提示**：拒絕時附上「若確需此操作，可用 `sandbox_permissions` 提出」——**並讓工具 schema 真的宣告那個參數**

**取用來源**：codex `sandbox-violation-classification`、dsh `shell-confinement-wrap-and-denial-classification`、cc `sandbox-violation-surfacing`。

### 3.3 完成升級階梯

**（a）** 工具 schema 宣告 `sandbox_permissions`／`justification`——這兩個名字**已經寫在標記文字裡**，只是沒有人宣告。
**（b）** `approveEscalation` 接上真實的審批服務（現在沒有生產呼叫者）。
**（c）** 政策 per-call 化（3.1）之後，升級才有意義。

**取用來源**：dsh `escalation-ladder-and-approval-choreography`（含稽核配對）、grok `permission-mode-projection-and-queue-drain`。

### 3.4 把 `terminal` 與 `fs-search` 納入圍堵

- **`terminal`**：`registerTerminal` 的簽名只有 `{ cwd? }`。PTY 要嘛走 OS 圍堵（spawn 時套用 runner，像 shell 那樣），要嘛明確**拒絕在受限模式下啟動**。**我傾向後者先做**——`registerTerminal` 在 `sandbox !== "danger-full-access"` 時不掛載，並回報「此模式下不可用」。**誠實的不可用勝過假裝的圍堵。**
- **`fs-search`**：它呼叫 `exec.run({ argv, cwd })` 跑 rg。rg 是**讀取**工具，所以讀取隔離未實作之前它無法被圍堵——**但可以走 shell 的同一條 exec 路徑**，至少讓它繼承同一套 runner 選擇與失敗語意。

### 3.5 讀取隔離：參考 grok，但先量測需求

grok 的 `bwrap-reexec-with-read-deny-placeholders` 用**不可讀的佔位掛載**覆蓋敏感路徑。方向上可參考，但 IH 要回答一個 grok 不必回答的問題：**要遮蔽什麼？**

grok 有企業政策來源可以列舉敏感路徑；IH 沒有。所以這一步**不應該先做**——先做會變成一個沒有輸入的機制。

---

## 4. 從各源取什麼（對照表）

| 設計項 | 主要參考 | 出處 |
|---|---|---|
| per-call 政策 | **dsh** | `sandbox-mode-vocabulary-and-per-call-policy`、`session-sandbox-mode-override-log` |
| 拒絕分類 | **codex** 最精簡、**dsh** 最完整 | `sandbox-violation-classification`、`shell-confinement-wrap-and-denial-classification` |
| 升級編排 | **dsh** | `escalation-ladder-and-approval-choreography` + `approval-service-policy-and-audit-pair` |
| fs 圍堵 | **dsh** | `fs-mutation-containment-fence`（我修缺陷二時已做，語意對齊它） |
| 權限規則引擎 | **cc-custom**／**opencode** | `permission-rule-decision-ladder`、`permission-rule-engine`（**只在 IH 決定要走向 B 類時才取**） |
| 安全閥 | **cc-custom** | `denial-tracking-circuit-breaker`、`dangerous-allow-rule-stripping`、`permission-rule-shadow-detection` |
| 來源信任 | **grok** | `build-provenance-folder-trust-gate`（若 IH 要載入專案設定） |
| 讀取拒絕 | **grok** | `bwrap-reexec-with-read-deny-placeholders` |

---

## 5. 刻意**不**取的部分

**權限規則引擎（B 類的核心）**——cc-custom 與 opencode 的規則階梯很完整，但 IH 的邊界是 OS 圍堵，不是規則。引入一套可設定規則會產生**兩個真相來源**：規則說可以、沙箱說不行。IH 該做的是**把沙箱的判定講清楚**，而不是在上面再疊一層可繞過的規則。

**grok 的企業治理層**——`root-owned-managed-policy-pin`、MDM、簽章政策，是為**組織部署**設計的。IH 的宿主是自己與開發者，沒有那個信任模型。**取了會是儀式而非安全。**

**`auto-mode-llm-danger-classifier`**——IH 已經有 guardian（同樣是 LLM 審批，但**只能收緊**）。cc 那個的存在目的是**放寬自主性**。方向相反，同時裝會互相抵消。

---

## 6. 建議順序

1. **3.1 per-call 政策**——沒有它，3.3 無處可依，而且它本身修掉一個真實的「中途改模式無效」
2. **3.2 統一拒絕形狀 + 3.3(a) 宣告參數**——低成本、讓模型能自我修正
3. **3.4 terminal 與 fs-search**——`terminal` 先做「受限模式下不掛載」，誠實且立刻有效
4. **3.3(b)(c) 完成升級階梯**——依賴 1
5. **3.5 讀取隔離**——**先回答「要遮蔽什麼」再動手**

---

## 7. 這份設計沒有回答的問題

- **3.1 的效能**：per-call 解析的事件掃描成本**未量測**。若太貴需要快取策略，而快取就必須處理失效——那會重新引入一部分複雜度。
- **`terminal` 不掛載的產品衝擊**：TUI 的 PTY 功能在受限模式下會消失。這是**產品決定**，不是技術決定。
- **`fs-search` 的 rg**：走 exec 路徑會讓它繼承 runner 選擇，但 **rg 的寫入面**（`--replace`？）我沒有查證。
- **IH 要不要有專案層設定信任**：grok 有明確答案（`build-provenance-folder-trust-gate`），IH 目前的 `settings` 是使用者層。這牽涉產品定位，我沒有足夠資訊下判斷。
