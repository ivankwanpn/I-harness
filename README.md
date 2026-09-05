# I-harness

<div align="center">

**一款以「後端完整」為先、複刻 grok-build 工程細節的 Agent 開源框架** ——
TypeScript/ESM 單倉（pnpm workspace），Windows 一等，從模型對接到終端界面全鏈自持。

</div>

---

## 這是一套什麼

I-harness 是一個**完整的 Agent 產品後端 + 終端前端**：

- **引擎**（M1–M25）：事件驅動 Agent 迴圈、真實工具面、守衛五層、壓縮五路、JSONL 唯一真相持久化、子代理/團隊、Windows ACL 沙箱、MCP/LSP、技能/工作流
- **服務面**（M26–M34）：輸入分級、記憶體/會話管理、HTTP+WS 服務網關、NDJSON JSON-RPC **SDK（Wire v0–v1.1 凍結/加性體系）**、ACP、模型目錄與動態發現
- **終端界面**（M35–M47）：複刻 **grok-build 的工程細節**——渲染層、minimal 原生滾動模式、markdown 檢查點、Rewind 全鏈、**提供商/模型管理**、**完整 Slash 註冊表**、**鼠標全語義**、遠程附著
- **體驗**：`i-harness` / `ih` 全局命令（任意資料夾即啟動）+ **NSIS 自包含安裝器**

> 設計立場：**不默認任何提供商**；**append-only 日誌**（JSONL 唯一真相，遮罩/回滾皆不改寫）；**後端零新面地接前端**（TUI 只是 SessionService 的另一個客戶端）；源碼直跑（tsx），dіst 只在發布期產出。

---

## 快速開始

```bash
# 1. 安裝依賴
pnpm install

# 2. 用真實模型跑（以 DeepSeek 為例——任意 OpenAI 兼容/五協議提供商同法）
$env:DEEPSEEK_API_KEY = "sk-..."     # 或經 TUI /provider 三步錄入（存為憑證引用）
node --import tsx apps/tui/src/index.ts --model deepseek:deepseek-chat          # 全屏 TUI（真實模型會話）
node --import tsx apps/cli/src/index.ts run "say hi" --model deepseek:deepseek-chat --api-key $env:DEEPSEEK_API_KEY --yes

# 3. 全局命令（grok 式：任意文件夾敲名字）
cd apps/cli && pnpm link -g
i-harness           # 在當前文件夾啟動 TUI（workspace = cwd；模型取 settings/provider 默認）
ih --minimal        # 原生 scrollback 模式
ih --prompt "hello" --model deepseek:deepseek-chat
ih --attach <session-id>
ih help             # 全部子命令（run / web / sdk / acp / tui）
```

> 未配置任何提供商時回退 **mock 模型**（開發友好；解析鏈 `--model` > settings 默認 > mock，每一步缺都以醒目 warn 告知）。

**Windows 安裝器**（自包含——見「分發與打包」）：

```bash
node scripts/build-installer.mjs    # → build\I-harness-Setup-0.1.0.exe
```

---

## 終端界面（TUI —— grok 1:1 複刻）

| 面 | 亮點 |
|---|---|
| 渲染 | 雙緩衝 cell diff + **零字節 idle**（同幀 → 0 寫入；渲染/minimal/懸停/live-probe 全路徑復證）、DEC 2026、寬字符 vendor 表、GrokNight/GrokDay 量化（truecolor/256/16 + ANSI16 釘色 + Windows 對比提升） |
| 模式 | Fullscreen（alt-screen）/ **Minimal**（終端原生滾動 + print-once——提交後永不重繪）/ self-relaunch 切換 |
| 內容 | **markdown 檢查點**（段落/列表/圍欄閉合即刷）、hljs 極性安全高亮、mermaid Unicode 圖、`md_code_bg` |
| 交互 | **鼠標全語義**（5 模式捕獲、懸停 dirty 重繪、單/雙/三擊、拖拽+邊緣自動滾動+自動複製、滾動流式、permission 雙擊即發、最小化模式無捕獲）、鍵表（Ctrl+S 存草稿 / F3 會話 / Ctrl+G 模式拆分…）、**完整 Slash 註冊表**（45 條可見 + 21 條誠實跳過——**只做後端真支持的功能**） |
| 管理 | **/provider** 三步嚮導 + **/model** 選擇 + **8 分類設置面板**、會話選擇器、工作量面板、Rewind 六相位（檔案快照兩階段恢復） |
| 遠程 | `--attach`（SDK stdio 客戶端；v1.1 全 wire：歷史/列表/取消/Rewind） |

**PTY 屏幕級回歸**：`packages/tui/test/harness/` 下 13+ 個真實虛擬終端場景（`case-010…023`），以 **byte-budget**（主機側累計 ledger ≡ pty 實觀）定量證明零字節 idle 與渲染確定性——註：Windows ConPTY 傳送分塊間隙可達秒級，時間窗採樣被實際證明不可靠，這是我們定下的證據學。

---

## 命令一覽

### 全局（`i-harness` / `ih`）

| 命令 | 說明 |
|---|---|
| （裸） | 當前文件夾啟動 TUI（grok 式默認） |
| `tui [--prompt …] [--minimal\|--fullscreen] [--attach <id>] [--resume <id>]` | TUI 子命令 |
| `run <task> [--model p:m --api-key K --yes --session-dir D --resume ID --telemetry]` | 無頭運行 |
| `web [--port N] [--launch-token T] [--hmac-secret S]` | Web 服務（HTTP+WS） |
| `sdk [--session-dir D]` | NDJSON JSON-RPC stdio 伺服器 |
| `acp [--session-dir D] [--no-auto-approve]` | ACP 伺服器 |
| `help` / `--version` | 用法 / 版本（0.1.0） |

### TUI 常用斜杠

`/minimal` `/fullscreen` `/btw` `/theme` `/timestamps` `/multiline` `/compact-mode` `/find` `/jump` `/history` `/resume` `/new` `/delete` `/rename` `/session-info` `/context` `/usage` `/rewind` `/plan` `/view-plan` `/compact` `/queue` `/tasks` `/doctor` `/copy` `/export` `/transcript` `/help` `/quit` `/always-approve` `/auto` `/effort` `/model` `/provider` `/settings` `/skills` `/mcps` `/hooks` `/plugins` `/marketplace` `/personas` `/config-agents` `/workflow` `/tutorial` `/timeline` —— 完整清單見 `docs/CAPABILITIES-DETAIL.md` §TUI。

---

## 分發與打包

**兩種「安裝」途徑，產權一致**（同一 shim 啟動器）：

### 1. 全局鏈接（開發/源碼模式）

```bash
cd apps/cli && pnpm link -g
```

- 註冊 `i-harness` 與 `ih` 兩個命令名（同一個 bin shim）
- shim 以**自身安裝的絕對路徑**解析 tsx loader + CLI 入口——任意 cwd 可用；`pnpm link -g`/`npm i -g ./apps/cli` 皆可
- 要求：Node ≥ 22（源碼直跑無構建產物）

### 2. NSIS 自包含安裝器（發布模式）

```bash
node scripts/build-installer.mjs   # dist 構建 + Node 運行時下載 + makensis 編譯
node scripts/verify-installer.mjs  # 17 項安裝驗證（靜默裝 → 雙命令冒煙 → 淨卸載）
```

產物：`build\I-harness-Setup-0.1.0.exe`（**~50MB 自包含**——捆入 Node v22.16.0 運行時、esbuild 單捆 `dist/ih.mjs`、平台原生模塊（node-pty/koffi/ripgrep——平樹 hoisted 部署）；**目標機零前置**）。

安裝器行為（`installer/ih.nsi`，NSIS 3.x/MUI2）：

| 項 | 行為 |
|---|---|
| 安裝目錄 | `Program Files\I-harness`（管理員；測試模式為用戶級） |
| PATH | HKLM 追加（僅當不含；段級精確匹配），`WM_SETTINGCHANGE` 廣播 |
| 開始選單 | `I-harness` / `ih` 快捷方式 + README |
| 卸載器 | 文件/目錄清除 + 註冊表 + PATH 回寫 + 自刪 |
| 測試模式 | `-test.exe`（`IH_NSIS_TEST` 編譯變體：不寫 PATH/註冊表——供自動化驗證） |

**誠實限制**：dist 包中 `--attach` 的 SDK spawn、Windows-ACL 沙箱 runner 與 minimal `/minimal` 自重啟仍需源碼 + tsx（`I_HARNESS_HOME` 為開發覆蓋）——真機安裝的完整功能集以「純 TUI + 首選會話」為準。

---

## 模型與提供商

- **五協議一等**：openai-responses / openai-compatible（含 DeepSeek）/ anthropic / gemini（原生）/ bedrock（AWS Converse）+ mock
- **設置在 TUI**：`/provider` 添加（ID/Base URL/API Key 遮罩，≥註冊只存 **refs**——明文永不入設置）→ `/model` 選擇 → 目錄動態發現（`/v1/models` 候選鏈 + probe-apply 落定），每次選擇持久化進 settings
- **思考強度**：6 檔（off/low/medium/high/xhigh/max）× 四協議翻譯表（世代規則）
- 每會話窗口/輸出上限解析鏈：settings `userModel` > modelContexts > profile > `model-catalog.json` > undefined

---

## 架構與包

```
packages/  (~70 個包)
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
├── sdk / acp / web-host / web          服務面（wire 凍結/ACP/HTTP+WS）
├── tui-core                            渲染層（cell diff/輸入解析/終端/探測/主題——運行時 0 依賴）
└── tui                                 App 層（scrollback/views/slash/鼠標/後端橋）
apps/
├── cli                                 全局命令（run/web/sdk/acp/tui + bin shim）
└── tui-app                             TUI 宿主
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
| `node scripts/build-installer.mjs && node scripts/verify-installer.mjs` | 打包安裝器 + 17 項安裝驗證 |

> 已知瑕疵：vitest worker flake（M31 修復——`web-host` 用 forks pool；新包遇到同症狀照搬該配置）。

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

---

## 邊界與遠期

- **明確不做**：PTC/run_code、plugin 代碼執行、默認提供商、dashboard/leader 多進程、grok 賬戶登錄面
- **遠期隊列**：web/desktop 面（排在很後面）、mermaid PNG 評估、Rewind 冷啟動恢復、MCP OAuth 實線刷新、macOS 沙箱、R-B4 git undo、記憶（R-A10）
- 每個「後端沒有」的功能在 TUI 一律**誠實降級**（toast + 記錄），不捏造

---

## 致謝與許可

- 工程細節藍本：**grok-build（xai-grok-pager）**——界面 1:1 複刻與工程屬性（我們讀其源碼並實跑驗證；**配方/黑盒觀察均記錄於 `docs/research/`**）
- 提供商/模型界面機制參考：**cc-custom**（其 `providers.json` v2 形狀 + 三步嚮導；我們改為 refs 存儲）
- 體系參考：**deepseek-harness（dsh）**（事件驅動/審計鏈）/ **codex**（編譯架構）/ **opencode / cc-switch**（模型發現候選鏈）
- 本項目 MIT 許可——詳見 `LICENSE`。

---

*English technical README: [`README.en.md`](README.en.md)（同一項目英文版——含原始開發狀態詳表與已知瑕疵實錄）。*
