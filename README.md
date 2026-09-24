# I-harness

<div align="center">

**一款以「後端完整」為先、複刻 grok-build 工程細節的 Agent 開源框架** ——
TypeScript/ESM 單倉（pnpm workspace），Windows 一等，從模型對接到服務面的全鏈自持。

</div>

---

> **▶ 狀態（2026-09-24）：後端收線完成——判決是「打磨完成、可以進前端」。**
> 入口是 **[`docs/handoff/2026-09-24-m80-backend-readiness.md`](docs/handoff/2026-09-24-m80-backend-readiness.md)**（後端就緒紀錄：判決在 §5、殘餘在 §6）；**逐條分類**（200 條：30 條沿鏈關閉／162 條落四鍵＝①1｜③8 產品決定｜④151 已計價的接受成本｜UNMEASURED 2）在 **[`docs/handoff/2026-09-24-m80-residual-audit.md`](docs/handoff/2026-09-24-m80-residual-audit.md)**。收線的計畫與五個單位（M76–M80）見 **[`docs/handoff/2026-09-23-backend-closure-plan.md`](docs/handoff/2026-09-23-backend-closure-plan.md)**。
>
> **要接手這個專案？** 讀上面那份就緒紀錄，再照需求分流：能力全景 [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) ／逐項細節 [`docs/CAPABILITIES-DETAIL.md`](docs/CAPABILITIES-DETAIL.md) ／本 README 只負責「這是什麼＋怎麼跑＋現在到哪」。`docs/handoff/HANDOFF.md` 是 **2026-09-15 的快照**（它自己已加 dated 指針），只當歷史讀。

## 這是一套什麼

I-harness 是一個**完整的 Agent 產品後端**：

- **引擎**（M1–M25）：事件驅動 Agent 迴圈、真實工具面、守衛五層、壓縮五路、JSONL 唯一真相持久化、子代理/團隊、Windows ACL 沙箱、MCP/LSP、技能/工作流
- **服務面**（M26–M34 及後續）：SDK 上的 **NDJSON JSON-RPC**（`PROTOCOL_VERSION = 3`，v0–v1.1 凍結/加性體系）、ACP、模型目錄與動態發現；**HTTP+WS 服務網關（`web-host`）已於 M65 隨前端一併移除**（見下）
- **預算鏈**（M72–M75）：每一條離開行程的請求都**帶著自己的預算**（窗口／輸出上限／成本），加上超窗的摘要化與子代理的可活預算
- **體驗**：`i-harness` / `ih` 全局命令 ＋ **NSIS 自包含安裝器**

> **界面：TUI 與 web 前端已於 2026-09-17（M65）移除。** 產品立場是**後端必須在沒有界面附著時照常工作**，而**前端真就應該是純前端**——所以先移除；**重建另計**（判決已下：後端已就緒）。移除的是 `apps/tui`、`packages/tui`、`packages/tui-core`、`packages/web-host` 與 `apps/cli/src/web.ts`；**`packages/web` 不是前端**（它是 `web_search` / `web_fetch` 工具包，仍在生產路徑上）。**裸啟動回到 M44 之前的行為**：用法印到 **stderr**、**exit 1**。完整記錄見 [`docs/handoff/2026-09-17-remove-tui-and-web-frontends.md`](docs/handoff/2026-09-17-remove-tui-and-web-frontends.md)。

> 設計立場：**不默認任何提供商**；**append-only 日誌**（JSONL 唯一真相，遮罩/回滾皆不改寫）；**後端零新面地接前端**——前端只是 SessionService 的另一個客戶端，這正是它能被移除而不動後端的原因；源碼直跑（tsx），dist 只在發布期產出。

---

## 快速開始

```bash
# 1. 安裝依賴（Node ≥ 22.18、pnpm ≥ 10）
pnpm install

# 2. 用真實模型跑（以 DeepSeek 為例——任意五協議提供商同法）
$env:DEEPSEEK_API_KEY = "sk-..."
node --import tsx apps/cli/src/index.ts run "say hi" --model deepseek:deepseek-chat --api-key $env:DEEPSEEK_API_KEY --yes

# 3. 全局命令（任意文件夾敲名字）
cd apps/cli && pnpm link -g
ih run "say hi" --model deepseek:deepseek-chat --yes   # 無頭運行（workspace = cwd）
ih sessions list                                       # 會話清單
ih help                                                # 全部子命令
```

> **模型解析是必需的**：未配置任何提供商時按 `No model configured` 拒絕啟動（不再有 mock 回退）。解析鏈：明確的 `--model` override > session model selection > `llm.defaultModel`；provider 設定走 **canonical settings 平面**（`llm.providers` 為唯一真源）。

**Windows 安裝器**（自包含——見「分發與打包」）：

```bash
node scripts/build-installer.mjs    # → build\I-harness-Setup-0.1.0.exe
```

---

## 命令一覽

### 全局（`i-harness` / `ih`）

| 命令 | 說明 |
|---|---|
| `run <task> [--model p:m --api-key K --yes --session-dir D --resume ID --telemetry --no-compact --sandbox MODE]` | 無頭運行 |
| `sdk [--session-dir D]` | NDJSON JSON-RPC stdio 伺服器（Protocol 3） |
| `acp [--session-dir D] [--no-auto-approve]` | ACP 伺服器 |
| `sessions [list] [--session-dir D] [--json]` / `sessions show <id> [--last N]` | 會話清單與檢視（`LAST RUN` 欄讀耐久的 `operator/run-end`） |
| `hooks list \| approve \| revoke` | hook 信任管理（共用 `<home>/hook-trust.json`） |
| `provider` / `models probe\|refresh` / `roles` / `plugins` | 提供商與模型面（`models probe` 只印不寫；`refresh` 才落定） |
| `help` / `--version` | 用法 / 版本（0.1.0） |

**裸啟動，或缺席／未知的子命令，是用法錯誤**：用法印到 **stderr**、**exit 1**——沒有「預設啟動某個界面」這回事（那是 M44–M64 的舊行為，M65 已還原）。

---

## 現在的狀態與入口

**閘門 `pnpm verify:all`（2026-09-24，最終樹）**：

| 步驟 | 讀數 |
|---|---|
| suite | **3140 passed｜9 skipped｜0 failed** |
| population | **67 of 67** |
| typecheck | exit 0 |
| e2e | exit 0 · 5 檔 |
| reachability | **456 列** · `gate PASS -- no new rows` |

**文件地圖**（由入口分流）：

| 想知道 | 讀 |
|---|---|
| **後端做完了沒／可以進前端嗎** | [`2026-09-24-m80-backend-readiness.md`](docs/handoff/2026-09-24-m80-backend-readiness.md)（判決 §5、殘餘 §6） |
| 每一條殘餘的處置 | [`2026-09-24-m80-residual-audit.md`](docs/handoff/2026-09-24-m80-residual-audit.md)（200 條逐條） |
| 能力全景 | [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) ＋ [`docs/CAPABILITIES-DETAIL.md`](docs/CAPABILITIES-DETAIL.md) |
| 收線計畫與五個單位 | [`2026-09-23-backend-closure-plan.md`](docs/handoff/2026-09-23-backend-closure-plan.md) |
| 各里程碑的交付紀錄 | [`docs/handoff/`](docs/handoff/)（每份都是它自己那個 commit 的量測） |
| 設計與計畫的全文 | [`docs/superpowers/`](docs/superpowers/) |

---

## 模型與提供商

- **五協議一等**：openai-responses / openai-compatible（含 DeepSeek）/ anthropic / gemini（原生）/ bedrock（AWS Converse）＋ mock
- **設置面**：`llm.providers` 是唯一真源（註冊只存 **refs**——明文永不入設置）；目錄動態發現走 `probeModels` → `discoverModels`（CLI：`ih models probe` / `ih models refresh`），每次選擇持久化進 settings
- **自訂請求標頭**：`llm.providers.<route>.headers`——網關要求的固定標頭（例：OpenCode Zen 的 `x-opencode-session`）；適配器自身標頭（Authorization 等）優先
- **思考強度**：6 檔（off/low/medium/high/xhigh/max）× **5** 張協議翻譯表（anthropic / bedrock / gemini / openai-compatible / openai）
- 每會話窗口/輸出上限解析鏈：settings `userModel` > modelContexts > profile > `model-catalog.json` > undefined
- **可見性**：提供者的拒絕（`refused`）與空成功（`empty`）都有通道——telemetry 碼 **24** 個（`provider/refused`／`provider/empty`／`provider/truncated`…）、耐久的 `step/end` 位元、CLI 的 `[refused]`／`[empty]` 行與 `HeadlessResult` 欄位

### 連不上模型（公司網路 / 代理 / 企業 CA）

**症狀**：任何模型都連不上，錯誤只說 transport failure。這**幾乎不是 API key 的問題**——先分辨網路層與憑證層。

Node 的 `fetch` **不讀** `HTTP_PROXY` / `HTTPS_PROXY`，而且**只在進程啟動時**讀代理與 CA 設定。所以「瀏覽器打得開、curl 打得開、只有 harness 連不上」是典型症狀——**瀏覽器與 curl 不是有效的對照組**。

用**跑 harness 的同一個 Node** 做探針（會印出真正的原因）：

```bash
node -e "fetch('https://api.deepseek.com').then(r => console.log('HTTP', r.status)).catch(e => { console.error(e.message, e.cause); process.exit(1) })"
```

| 結果 | 意義 | 處置 |
|---|---|---|
| 任何 HTTP 狀態（401/403/404/429…） | DNS/TCP/TLS **都通了** | 停止調代理與 CA，改查 **key / 配額 / 網關政策** |
| `fetch failed` + cause `ENOTFOUND` | DNS | 查 DNS / VPN |
| `fetch failed` + cause `ECONNREFUSED` | 有代理但沒走 | 見下方代理設定 |
| `fetch failed` + cause 憑證碼（如 `DEPTH_ZERO_SELF_SIGNED_CERT`） | 企業 TLS 檢測 | 見下方 CA 設定 |

**代理**（公司強制走代理時）：

```powershell
$env:NODE_USE_ENV_PROXY = "1"          # 等價 CLI：--use-env-proxy
$env:HTTPS_PROXY = "http://proxy:port"
$env:HTTP_PROXY  = "http://proxy:port"
$env:NO_PROXY    = "localhost,127.0.0.1,::1"
ih run "say hi" --model deepseek:deepseek-chat --yes   # 必須在設好之後「重新啟動」
```

**企業 CA**（TLS 檢測閘道）：優先用系統信任庫：

```powershell
$env:NODE_USE_SYSTEM_CA = "1"
```

或指定 PEM（**路徑必須是 PEM 檔**，不是 `.crt` 的 DER）：

```powershell
$env:NODE_EXTRA_CA_CERTS = "C:\path\company-root.pem"
```

**不要**用 `NODE_TLS_REJECT_UNAUTHORIZED=0`——那等於關掉整個 TLS 驗證。

> 驗證環境是否支援：`node --help | Select-String use-env-proxy`（pin 的 **v22.23.2 與安裝器捆入的 Node 都支援**）。
> provider 適配器會把 Node 的 `cause` 鏈接出來（`llm-seam` 的 `describeTransportError`），所以探針看到的層級，在 harness 的錯誤訊息裡也看得到。

---

## 分發與打包

> **前置**：Node ≥ 22.18 與 **pnpm ≥ 10**。倉庫的 `pnpm-workspace.yaml` 用 pnpm-10 語法；且 dist 的原生部署要求 pnpm 10 的 hoisted linker——**pnpm 9 會靜默漏裝平台原生包**（`@koromix/koffi-win32-x64`、`@vscode/ripgrep-win32-x64`），產物啟動即失敗。`build-dist` 對 pnpm < 10 fail-loud。

### 1. 全局鏈接（開發/源碼模式）

```bash
cd apps/cli && pnpm link -g
```

- 註冊 `i-harness` 與 `ih` 兩個命令名（同一個 bin shim）
- shim 以**自身安裝的絕對路徑**解析 tsx loader + CLI 入口——任意 cwd 可用
- 要求：Node ≥ 22.18（源碼直跑；`engines.node` 下限——`node:sqlite` 的 `readOnly`）

### 2. NSIS 自包含安裝器（發布模式）

```bash
node scripts/build-installer.mjs   # dist 構建 + Node 運行時下載 + makensis 編譯
node scripts/verify-installer.mjs  # 19 項安裝驗證（靜默裝 → 雙命令冒煙 + dist 自足 → 淨卸載）
```

產物：`build\I-harness-Setup-0.1.0.exe`（**~50MB 自包含**——捆入 Node 運行時、esbuild 捆 `dist/ih.mjs` + `dist/runner.mjs`、平台原生模塊；**目標機零前置**）。

`installer/ih.nsi`（NSIS 3.x/MUI2）：`Program Files\I-harness`、PATH 追加（段級精確匹配）、開始選單、完整卸載器；測試模式 `-test.exe`（`IH_NSIS_TEST`：不寫 PATH/註冊表、預設裝到 `%LOCALAPPDATA%\I-harness`）。

**dist 自足**：Windows-ACL 沙箱 spawn 同捆的 `dist/runner.mjs`，`node ih.mjs sdk` **重入自身 bundle**——都不需要源碼或 tsx。`I_HARNESS_HOME` 僅是**源碼模式**的開發覆蓋，dist 不讀它。

---

## 架構與包

```
packages/  (66 個包) + apps/cli
├── 引擎核心     core-agent / core-session / core-tools / core-plugin
├── 模型對接     llm-seam + llm-{openai,openai-compatible,anthropic,gemini,bedrock,mock}
│                provider / provider-runtime（目錄、探測、動態發現）
├── 工具面       exec / shell / fs / fs-search / fs-lock / tool-search / text-diff
│                terminal / output-retention / todo / attachment / web（web_search/web_fetch）
├── 安全         guard-{approval,timeout,retry,repeat-tool} / sandbox-policy
│                sandbox / sandbox-local / sandbox-windows-acl
├── 子代理       subagent / agent-team / goal / jobs / schedule / skills / workflow
├── 會話與持久化 session-executor / session-persistence(-jsonl) / session-query / session-title
│                compaction / token-meter / rewind
├── 服務面       sdk / acp / interaction / preset / plan-mode / runtime-context / instructions
├── 基礎設施     settings / credentials / workspace / plugin-registry / hooks / harness-home
│                telemetry / diagnostics / mcp-client / lsp / fs-watch
apps/
└── cli          全局命令（run/sdk/acp/sessions/hooks/provider/models/roles/plugins + bin shim）
```

詳細能力全景：`docs/CAPABILITIES.md`（九節）+ `docs/CAPABILITIES-DETAIL.md`（工具 schema 級粒度 + 已知缺口表）。

---

## 開發

| 命令 | 用途 |
|---|---|
| `pnpm verify:all` | **閘門**：suite ＋ 母體 ＋ typecheck ＋ e2e ＋ reachability 五步（見「現在的狀態」） |
| `pnpm test` / `pnpm typecheck` / `pnpm e2e` | 各步單跑 |
| `pnpm verify:reachability` | 可達性棘輪（對**新增**的孤兒列失敗；基線 `scripts/audit/reachability-baseline.json`） |
| `pnpm verify:store` | pnpm store 完整性（e2e 前建議） |
| `node scripts/build-installer.mjs && node scripts/verify-installer.mjs` | 打包安裝器 + 19 項安裝驗證 |

**本樹的寫作紀律**（給貢獻者）：**沒有量過的數字不寫**；被超越的紀錄用 **dated 更正**，不改寫歷史;「註解宣稱超過量測」是一個具名缺陷類別——發現就具名。

---

## 歷程（壓縮）

每一輪走完整審計鏈：**研究 → 取捨 → spec → plan → 子代理執行 → 調和審查 → 全量驗證 → 推送**；研究/規格/計劃/交付紀錄全存 `docs/`。

| 時代 | 內容 |
|---|---|
| **M1–M25** | 引擎：事件驅動迴圈、工具面、守衛、壓縮、沙箱、MCP/LSP、子代理/團隊、持久化、技能/工作流 |
| **M26–M34** | 服務面：SDK wire 凍結、ACP、一等提供商（gemini/bedrock）、模型目錄與動態發現、壓縮策略 |
| **M35–M64** | TUI 與 web 前端的完整建造與 parity（逐里程碑紀錄在 `docs/handoff/`）——**這些能力已於 M65 移除** |
| **M65** | **移除 TUI/web 前端**；裸啟動還原為用法錯誤；19 個 TUI-only settings 淘汰；104 列孤兒資產具名定價 |
| **M66–M71** | 移除後的穩定化：schedule 交付、`PROTOCOL_VERSION 3`、`operator/run-end`、派送邊界（崩潰後 `outcome-unknown`）、結構化診斷日誌（W6） |
| **M72–M75** | provider 邊界三階段（靜默失敗的通道化：`truncated`／usage）、**預算鏈**（每條請求帶自己的預算）、子代理可活預算、超窗摘要化 |
| **M76–M80** | **後端收線**：走位守衛、拒絕與空成功的通道、prune-before-summarise、覆蓋率與儀器、文件債——**判決：打磨完成、可以進前端**（就緒紀錄） |

> 逐里程碑的完整表格在 git 歷史的 README 版本裡（`git log --oneline -- README.md`）。

---

## 邊界與遠期

- **明確不做**：PTC/run_code、plugin 代碼執行、默認提供商、dashboard/leader 多進程、grok 賬戶登錄/賬單/共享/刪除面、remote/session 刪除、跨機器 dashboard 同步、賬號 OAuth 綁定
- **等前端**（判決是「可以進」，不是「已經有」）：五個零消費者套件（`fs-watch`／`goal`／`jobs`／`workspace` 等）、`settings/*` 上 sdk 線（Q7：等前端走到需要它的那一步）、hooks 核准的 UI、前端重建本體——**逐條在就緒紀錄與稽核表**
- **明確限制**：未配置 store root 的 session 仍是 ephemeral fallback；Rewind **不還原** shell/外部編輯器等未經 recorder 的變更（`plan().unseen` 唯讀列出）；PTY 時間窗採樣仍不可靠；Bedrock ambient 認證（無 API key 環境即用）；發現機制＝**手動添加 + 明確 probe**
- **遠期隊列**：mermaid PNG、Rewind 冷啟動恢復、MCP OAuth 實線刷新、macOS 沙箱、R-B4 git undo B 案（A 案已落地）、記憶（R-A10）、provider variants、bedrock live probe

---

## 致謝與許可

- 工程細節藍本：**grok-build（xai-grok-pager）**——界面 1:1 複刻與工程屬性（配方/黑盒觀察記錄於 `docs/research/`）
- 提供商/模型界面機制參考：**cc-custom**（`providers.json` v2 形狀；我們改為 refs 存儲）
- 體系參考：**deepseek-harness（dsh）**（事件驅動/審計鏈）/ **codex**（編譯架構）/ **opencode / cc-switch**（模型發現候選鏈）
- 本項目 MIT 許可——詳見 `LICENSE`。

---

*English README: [`README.en.md`](README.en.md)（**內容停在 M65 之前**——當前的入口是上面那份就緒紀錄與本文件）。*
