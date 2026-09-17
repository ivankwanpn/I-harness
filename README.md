# I-harness

<div align="center">

**一款以「後端完整」為先、複刻 grok-build 工程細節的 Agent 開源框架** ——
TypeScript/ESM 單倉（pnpm workspace），Windows 一等，從模型對接到服務面的全鏈自持。

</div>

---

> **要接手這個專案？** 先讀 [`docs/handoff/HANDOFF.md`](docs/handoff/HANDOFF.md)：目前分支／commit 狀態、驗證指令與**實測基準**、實際踩過的九個陷阱，以及「刻意沒做」的清單。同目錄另有 [`FINAL-REPORT.md`](docs/handoff/FINAL-REPORT.md)（上一個 goal 的完整報告）與 [`what-the-design-does-not-answer.md`](docs/handoff/what-the-design-does-not-answer.md)（設計未回答與已裁決不做的部分）。

## 這是一套什麼

I-harness 是一個**完整的 Agent 產品後端**：

- **引擎**（M1–M25）：事件驅動 Agent 迴圈、真實工具面、守衛五層、壓縮五路、JSONL 唯一真相持久化、子代理/團隊、Windows ACL 沙箱、MCP/LSP、技能/工作流
- **服務面**（M26–M34）：輸入分級、記憶體/會話管理、HTTP+WS 服務網關、NDJSON JSON-RPC **SDK（Wire v0–v1.1 凍結/加性體系）**、ACP、模型目錄與動態發現
- **體驗**：`i-harness` / `ih` 全局命令 + **NSIS 自包含安裝器**

> **界面：TUI 與 web 前端已於 2026-09-17（M65）移除。** 產品立場是**後端必須在沒有界面附著時照常工作**，而**前端真就應該是純前端**——所以先移除，重建另計（重建不在 M65 範圍內）。移除的是 `apps/tui`、`packages/tui`、`packages/tui-core`、`packages/web-host` 與 `apps/cli/src/web.ts`；**`packages/web` 不是前端**（它是 `web_search` / `web_fetch` 工具包，仍在生產路徑上），原樣保留。**裸啟動回到 M44 之前的行為**：用法印到 **stderr**、**exit 1**，不再是「啟動 TUI」。完整記錄見 [`docs/handoff/2026-09-17-remove-tui-and-web-frontends.md`](docs/handoff/2026-09-17-remove-tui-and-web-frontends.md)。

> 設計立場：**不默認任何提供商**；**append-only 日誌**（JSONL 唯一真相，遮罩/回滾皆不改寫）；**後端零新面地接前端**——前端只是 SessionService 的另一個客戶端，這正是它能被移除而不動後端的原因；源碼直跑（tsx），dіst 只在發布期產出。

---

## 快速開始

```bash
# 1. 安裝依賴
pnpm install

# 2. 用真實模型跑（以 DeepSeek 為例——任意 OpenAI 兼容/五協議提供商同法）
$env:DEEPSEEK_API_KEY = "sk-..."     # 存為憑證引用
node --import tsx apps/cli/src/index.ts run "say hi" --model deepseek:deepseek-chat --api-key $env:DEEPSEEK_API_KEY --yes

# 3. 全局命令（任意文件夾敲名字）
cd apps/cli && pnpm link -g
ih run "say hi" --model deepseek:deepseek-chat --yes   # 無頭運行（workspace = cwd）
ih sessions list                                       # 會話清單
ih help             # 全部子命令（run / sdk / acp / sessions）
```

> **M49 起（superseded）**：模型解析是**必需**——未配置任何提供商時按 `No model configured` 拒絕啟動（Welcome 頁開放 Settings），不再有 mock 回退。解析鏈（`provider-runtime.selectModel`：override 先判，再 session selection，最後 defaultModel）：明確的 `--model` override > session model selection > `llm.defaultModel`；provider 設定走**canonical settings 平面**（`llm.providers` 為唯一真源；M46 的 `tui.providers` 布局僅以 read-pin 方式被兼容讀取，永不寫回主力平面）。

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
| `sdk [--session-dir D]` | NDJSON JSON-RPC stdio 伺服器 |
| `acp [--session-dir D] [--no-auto-approve]` | ACP 伺服器 |
| `sessions [list] [--session-dir D] [--json]` / `sessions show <id> [--last N]` | 會話清單與檢視 |
| `help` / `--version` | 用法 / 版本（0.1.0） |

**裸啟動，或缺席／未知的子命令，是用法錯誤**：用法印到 **stderr**、**exit 1**。沒有「預設啟動某個界面」這回事——那是 M44–M64 的舊行為，M65 已還原成 M44 之前的形狀（權威：`db3d1e7^:apps/cli/src/index.ts`）。

---

## 已移除：終端界面（TUI）與 web 前端

> **M35–M47 的 TUI**（雙緩衝 cell diff + 零字節 idle、minimal 原生滾動、markdown 檢查點、完整 Slash 註冊表、鼠標全語義、`--attach` 遠程附著、PTY byte-budget 回歸）與 **`i-harness web`**（HTTP+WS 主機、內建 L3 對話頁）**已於 2026-09-17 隨 M65 一併刪除**。
>
> **為什麼**：產品立場是後端必須在沒有界面附著時照常工作，前端應該是純前端——TUI 的引擎是在 TUI 進程內組裝的，那正是要拆掉的耦合。**這是移除，不是廢棄**：重建是另一個里程碑，被刪掉的能力**不會**從這份 README 復原，也**不該**被當成後端退步。
>
> **留下了什麼**：前端孤立出來的 34 個 wire 契約（view model、DTO、approval／question／command 接縫）被**具名保留**為重建前端的契約，不是後端腐化的證據；完整處置見 [`docs/handoff/2026-09-17-remove-tui-and-web-frontends.md`](docs/handoff/2026-09-17-remove-tui-and-web-frontends.md)。

---

## 分發與打包

> **前置**：Node ≥ 22.18 與 **pnpm ≥ 10**。倉庫的 `pnpm-workspace.yaml` 用 pnpm-10 語法（`allowBuilds` / `ignoreWorkspaceCycles`）；且 dist 的原生部署要求 pnpm 10 的 hoisted linker——**pnpm 9 會靜默漏裝平台原生包**（`@koromix/koffi-win32-x64`、`@vscode/ripgrep-win32-x64`），產物啟動即失敗。`build-dist` 現在對 pnpm < 10 fail-loud（M59 修復）。

**兩種「安裝」途徑，產權一致**（同一 shim 啟動器）：

### 1. 全局鏈接（開發/源碼模式）

```bash
cd apps/cli && pnpm link -g
```

- 註冊 `i-harness` 與 `ih` 兩個命令名（同一個 bin shim）
- shim 以**自身安裝的絕對路徑**解析 tsx loader + CLI 入口——任意 cwd 可用；`pnpm link -g`/`npm i -g ./apps/cli` 皆可
- 要求：Node ≥ 22.18（源碼直跑無構建產物；`engines.node` 下限——`node:sqlite` 的 `readOnly`）

### 2. NSIS 自包含安裝器（發布模式）

```bash
node scripts/build-installer.mjs   # dist 構建 + Node 運行時下載 + makensis 編譯
node scripts/verify-installer.mjs  # 19 項安裝驗證（靜默裝 → 雙命令冒煙 + dist 自足 → 淨卸載）
```

產物：`build\I-harness-Setup-0.1.0.exe`（**~50MB 自包含**——捆入 Node v22.23.2 運行時（滿足 `engines.node ≥ 22.18` 下限）、esbuild 捆 `dist/ih.mjs` + `dist/runner.mjs`、平台原生模塊（node-pty/koffi/ripgrep——平樹 hoisted 部署）；**目標機零前置**）。

安裝器行為（`installer/ih.nsi`，NSIS 3.x/MUI2）：

| 項 | 行為 |
|---|---|
| 安裝目錄 | `Program Files\I-harness`（管理員；測試模式為用戶級） |
| PATH | HKLM 追加（僅當不含；段級精確匹配），`WM_SETTINGCHANGE` 廣播 |
| 開始選單 | `I-harness` / `ih` 快捷方式 + README |
| 卸載器 | 文件/目錄清除 + 註冊表 + PATH 回寫 + 自刪 |
| 測試模式 | `-test.exe`（`IH_NSIS_TEST` 編譯變體：不寫 PATH/註冊表、**預設裝到 `%LOCALAPPDATA%\I-harness`**——用戶級可寫；原 `Program Files` 預設在未提權下寫不進去，雙擊即報 `Error opening file for writing`） |

**dist 自足（M55）**：Windows-ACL 沙箱 spawn 同捆的 `dist/runner.mjs`，以及 `node ih.mjs sdk` **重入自身 bundle**——都不再需要源碼或 tsx。`I_HARNESS_HOME` 僅是**源碼模式**的開發覆蓋（指向非標準路徑的 checkout），dist 不讀它。

> **M65 更正**：這條 bullet 原本還列舉三個探針——`--attach` 的 SDK spawn、`/minimal` 自重啟、minimal 內聯引擎。**它們是隨其主體（被刪除的 `@i-harness/tui-app`）一併移除的，不是失效**：沒有東西可測了。`scripts/verify-dist.mjs` 的標頭記著這件事。**SDK 重入本身仍有覆蓋**——`verify-dist.mjs` 的 (f) 區塊直接驅動 `node <out>/ih.mjs sdk`（平台無關，且帶反向控制），所以上面留下的那一半不是空話。

---

## 模型與提供商

- **五協議一等**：openai-responses / openai-compatible（含 DeepSeek）/ anthropic / gemini（原生）/ bedrock（AWS Converse）+ mock
- **設置面**：`llm.providers` 是唯一真源（註冊只存 **refs**——明文永不入設置），目錄動態發現（`/v1/models` 候選鏈 + probe-apply 落定），每次選擇持久化進 settings。**M65 之前**這條路徑的錄入界面是 TUI 的 `/provider` 三步嚮導，該嚮導已隨前端移除；重建前端時見 `docs/CAPABILITIES-DETAIL.md` 的移除註記
- **自訂請求標頭（M59）**：`llm.providers.<route>.headers`——網關要求的固定標頭（例：OpenCode Zen 的 `x-opencode-session`）。settings 平面直填（嚮導暫無此欄位；重新保存 provider 不會清掉它），適配器自身標頭（Authorization 等）優先
- **思考強度**：6 檔（off/low/medium/high/xhigh/max）× 四協議翻譯表（世代規則）
- 每會話窗口/輸出上限解析鏈：settings `userModel` > modelContexts > profile > `model-catalog.json` > undefined

### 連不上模型（公司網路 / 代理 / 企業 CA）

**症狀**：任何模型都連不上，錯誤只說 transport failure。這**幾乎不是 API key 的問題**——先分辨網路層與憑證層。

Node 的 `fetch` **不讀** `HTTP_PROXY` / `HTTPS_PROXY`，而且**只在進程啟動時**讀代理與 CA 設定。所以「瀏覽器打得開、curl 打得開、只有 harness 連不上」是典型症狀——**瀏覽器與 curl 不是有效的對照組**，它們有自己的代理與憑證信任來源。

用**跑 harness 的同一個 Node** 做探針（會印出真正的原因）：

```bash
node -e "fetch('https://api.deepseek.com').then(r => console.log('HTTP', r.status)).catch(e => { console.error(e.message, e.cause); process.exit(1) })"
```

| 結果 | 意義 | 處置 |
|---|---|---|
| 任何 HTTP 狀態（401/403/404/429…） | DNS/TCP/TLS **都通了** | 停止調代理與 CA，改查 **key / 配額 / 網關政策** |
| `fetch failed` + cause `ENOTFOUND` | DNS | 查 DNS / VPN |
| `fetch failed` + cause `ECONNREFUSED` | 有代理但沒走 | 見下方代理設定 |
| `fetch failed` + cause 憑證碼（如 `DEPTH_ZERO_SELF_SIGNED_CERT`、`UNABLE_TO_VERIFY_LEAF_SIGNATURE`） | 企業 TLS 檢測 | 見下方 CA 設定 |

**代理**（公司強制走代理時）：

```powershell
$env:NODE_USE_ENV_PROXY = "1"          # 等價 CLI：--use-env-proxy
$env:HTTPS_PROXY = "http://proxy:port"
$env:HTTP_PROXY  = "http://proxy:port"
$env:NO_PROXY    = "localhost,127.0.0.1,::1"
ih web                                  # 必須在設好之後「重新啟動」
```

**企業 CA**（TLS 檢測閘道）：優先用系統信任庫，這是 Windows 上最省事的一條：

```powershell
$env:NODE_USE_SYSTEM_CA = "1"
```

或指定 PEM（**路徑必須是 PEM 檔**，不是 `.crt` 的 DER）：

```powershell
$env:NODE_EXTRA_CA_CERTS = "C:\path\company-root.pem"
```

**不要**用 `NODE_TLS_REJECT_UNAUTHORIZED=0`——那等於關掉整個 TLS 驗證。

> 驗證環境是否支援：`node --help | Select-String use-env-proxy`（本倉庫 pin 的 **v22.23.2 與安裝器捆入的 Node 都支援**）。
> 本專案的 provider 適配器會把 Node 的 `cause` 鏈接出來（`llm-seam` 的 `describeTransportError`），所以上面探針看到的層級，在 harness 的錯誤訊息裡也看得到。

---

## 架構與包

```
packages/  (65 個包 + apps/cli)
├── core-{plugin,session,agent,tools}   引擎核心（事件驅動/日誌唯一真相/工具註冊表）
├── llm-{seam,openai,openai-compatible,anthropic,gemini,bedrock,mock} + provider
├── exec / shell / fs / fs-search / tool-search / output-retention / todo
├── guard-{approval,timeout,retry,repeat-tool} / sandbox{-local,-windows-acl} / sandbox-policy
├── mcp-client / lsp / terminal / fs-lock / fs-watch
├── subagent / agent-team / goal / feedback / jobs / schedule / skills / workflow
├── compaction / token-meter / session-{persistence*,query,executor,title}
├── session-persistence-jsonl           JSONL 唯一真相 + file-backed 索引（reconcile-on-search）
├── interaction / instructions / plan-mode / runtime-context / preset
├── credentials / settings / workspace / plugin-registry / hooks / telemetry
├── rewind                              檔案快照/兩階段回滾引擎
└── sdk / acp / web                     服務面（wire 凍結/ACP；`web` 是 web_search/web_fetch **工具**包，不是前端）
apps/
└── cli                                 全局命令（run/sdk/acp/sessions + bin shim）
```

詳細能力全景：`docs/CAPABILITIES.md`（九節）+ `docs/CAPABILITIES-DETAIL.md`（工具 schema 級粒度 + 已知缺口表）。

---

## 開發

| 命令 | 用途 |
|---|---|
| `pnpm test` | 全倉 vitest（~2400 測試，0 失敗線） |
| `pnpm typecheck` | 全倉 `tsc --noEmit`（0 錯誤） |
| `pnpm e2e` | 端到端（真實 CLI + 真實工具） |
| `pnpm verify:store` | pnpm store 完整性（e2e 前建議） |
| `pnpm verify:reachability` | 可達性棘輪（對**新增**的孤兒行失敗；基線 `scripts/audit/reachability-baseline.json`） |
| `node scripts/build-installer.mjs && node scripts/verify-installer.mjs` | 打包安裝器 + 19 項安裝驗證 |

> 已知瑕疵：vitest worker flake（M31 修復——`web-host` 用 forks pool，**該包已於 M65 移除**；新包遇到同症狀照搬該配置）。

---

## 里程碑與品質

每一輪走完整審計鏈：**研究 → 取捨（與你逐項確認）→ spec → plan → 子代理 worktree 執行 → 調和審查 → 全量驗證 → 推送**。研究/規格/計劃全存 `docs/`：

| 里程碑 | 主題 |
|---|---|
| M1–M25 | 後端完整（核心/守衛/壓縮/沙箱/MCP/LSP/團隊/可靠性/持久化/技能/工作流/端到端） |
| M26 | 運行時交互輪：輸入分級、終端 PTY、MCP OAuth、目標/任務/憑證/設置/工作區…引擎網關 |
| M27 | 穩定化 + 集成：外部契約、健康面、崩潰修復鏈、`@i-harness/sdk` |
| M28 | 清理：SDK Wire v0 凍結、fs-watch、ACP、真 AS OAuth 集成 |
| M29 | SQLite 拆分：JSONL 唯一真相 + 索引（移除 `--session-backend` fail-loud） |
| M30 | 一等提供商：gemini（原生）/ bedrock（Converse）/ 雙分派 |
| M31 | 模型/網絡面：統一窗口解析、probe-apply、零硬編碼目錄 |
| M32 | 模型卡 + 6 檔思考強度 × 4 譯表 |
| M33 | 壓縮四路吸收：錨定摘要 + 8 節提示、剪枝、計數完整、磁滯熔斷 |
| M34 | 壓縮策略：per-model、attempt 統計、退化地板、until-success 斷路 |
| M35 | TUI 研究：四路對比 + grok 藍本 + 界面 1:1 規格 |
| M36 | `tui-core`：渲染層（零字節 idle 紅線證明） |
| M37a/b | 全屏 1:1 + 交互面（真實鍵面/permission 矩陣） |
| M38a/b | minimal print-once + markdown 檢查點 + `--attach` 遠程 |
| M39 | 質量：12 屬性核對 + 交互矩陣 + HUD + retain + bench |
| M40 | 盤點收割：`read_image`/todo 掛載/CLI 接線/斷路/主題旋鈕/mermaid/plan-review 適配 |
| M41a/b | Wire v1/v1.1：history/list/cancel/Rewind 遠程 + 真 in-flight 中止 |
| M42 | Rewind 引擎（快照/recorder/服務 + shadow 投影） |
| M43 | Rewind UI 1:1（六相位 + 引擎隱藏 + 磁盤證明） |
| M44 | 全局命令 `i-harness`/`ih`（裸命令默認 TUI——grok 式） |
| M45 | 分發：esbuild 捆包 + NSIS 自包含安裝器 |
| M46a/b/c | 提供商/模型管理 + Slash 註冊表 + 鍵表真理 + **鼠標全 parity** + 選區/時間線軌/粘貼源/workflow 面 |
| M47 | 質量輪 2：鼠標/hover bench + live 探測 + line-viewer |
| M48 | 可靠性與 TUI 交付：G1 chain rejection 推進；配置 session-dir 時 TUI session 建立/列表/resume/close flush；transactional session switch + scrollback/app reset；SDK/ACP 跨進程恢復舊 history 並延續 seq；ACP per-session close/lease release；durable Rewind bridge（僅 recorder-backed 檔案變更）；PTY case-010 修復 Windows `chcp` codepage 命令解析 |
| M49 | Grok TUI parity 收官：canonical provider settings（`llm.providers` 唯一真源 + M46 `tui.providers` read-pin）、required-model gate、Welcome 面、typed settings/provider 流、grapheme editor + cursor、主題（system/grok-night/grok-day/tokyo-night/rose-pine-moon/oscura-midnight）+ minimal 生產化、typed tool 塊 + viewers/clipboard/bridges、真實 prompt queue、tasks/subagents 投影、本地 dashboard + 內建 status line（模型標籤為 runtime 真綁定）、capability-gated slash + prompts + Ctrl+R mouse 捕獲切換；PTY case-028 整合 parity 證明（最低啟動無 alt-screen/mouse 位元組、theme/screen/status 持久化重啟、unsupported `/login` 零提交） |
| **M65** | **移除 TUI 與 web 前端**（`apps/tui`、`packages/tui`、`packages/tui-core`、`packages/web-host`、`apps/cli/src/web.ts`），還原 **pre-M44 裸啟動**（用法 → stderr、exit 1），淘汰 19 個 TUI-only settings、21 個只剩前端的 export，並把前端留下的 104 列孤兒當**一個具名類別**定價（T 刪／B 退場／C 契約／? 待決）。**M35–M49 的界面能力因此不再存在**——重建是另一個里程碑 |

---

## 邊界與遠期

- **明確不做**：PTC/run_code、plugin 代碼執行、默認提供商、dashboard/leader 多進程、grok 賬戶登錄/賬單/共享/刪除面、remote/session 刪除、跨機器 dashboard 同步、account OAuth 綁定
- **明確限制**：未配置 store root 的 session 仍是 ephemeral fallback；Rewind **不還原** shell/外部編輯器等未經 recorder 的變更（M58 起以 `plan().unseen` 唯讀列出，永不進 `ops`）；PTY 時間窗採樣仍不可靠；dashboard 為**本地機器**面（durable session store + 真實 backend 投影——無跨機同步）；Bedrock ambient 認證（無 API key 環境即用；OAuth-account 類型為未來擴展邊界，本期未實作）；發現機制 = **手動添加 + 明確 discovery（probe）**——入門教程/自動爬取不支持
- **遠期隊列**：web/desktop 面（排在很後面）、mermaid PNG 評估、Rewind 冷啟動恢復、MCP OAuth 實線刷新、macOS 沙箱、R-B4 git undo **B 案**（checkpoint 引擎——A 案 M58 已落地：`plan().unseen` 唯讀 git 對照）、記憶（R-A10）、provider OAuth 賬號綁定
- 前端存在時，每個「後端沒有」的功能一律**誠實降級**（toast + 記錄），不捏造——**這條立場不因前端被移除而改變**，重建時照用

---

## 致謝與許可

- 工程細節藍本：**grok-build（xai-grok-pager）**——界面 1:1 複刻與工程屬性（我們讀其源碼並實跑驗證；**配方/黑盒觀察均記錄於 `docs/research/`**）
- 提供商/模型界面機制參考：**cc-custom**（其 `providers.json` v2 形狀 + 三步嚮導；我們改為 refs 存儲）
- 體系參考：**deepseek-harness（dsh）**（事件驅動/審計鏈）/ **codex**（編譯架構）/ **opencode / cc-switch**（模型發現候選鏈）
- 本項目 MIT 許可——詳見 `LICENSE`。

---

*English technical README: [`README.en.md`](README.en.md)（同一項目英文版——含原始開發狀態詳表與已知瑕疵實錄）。*
