# Roadmap B — 執行與工具面（execution & tools）

> 2026-08-31 · 基於 `docs/audit/2026-08-31-fiveway-comparison.md`。候選清單，取捨記 §6。

## 1. 該區現狀 vs 目標

**現狀**：bash/pwsh（timeout/retention/sandbox）、fs（read/write/edit/apply_patch/read-image 系）、glob/grep（ripgrep）、todo、tool_search（BM25 deferred）、MCP client（stdio+http+重連、無 OAuth）、LSP（四操作）、skills（SKILL.md deferred 檢索）、workflow（YAML 靜態）、spill（per-tool M21）。

**目標**：補「現代 agent 工作流」的工具面：遠程 MCP（OAuth）、PTY/terminal、web、git undo、模型可問的進程控制/受權。**標記兩項範式決策**（PTC/code-mode、workflow 引擎升級）——這些不是補齊，是方向選擇。

## 2. 候選里程碑表

| # | 名稱 | 一句話 | 五源來源 | 成本 | 依賴 | 建議節點 |
|---|---|---|---|---|---|---|
| R-B1 | MCP 強化 | OAuth 2.1（PKCE+dynamic registration+回調）+ roots + 資源工具 + blocked/direct + server 沙箱啟動 | opencode（深度）/ codex（安全啟動）/ dsh（基本） | M | mcp-client | 第一優先（工具面對外性） |
| R-B2 | PTY/terminal | terminal_open/send/read/signal/close/list 六工具（含長駐） | dsh（terminal 家族 + node-pty） | M | exec、subprocess | 與 R-B8 同批 |
| R-B3 | web 存取 | webfetch（正文抽取）+ websearch（provider 可插拔） | opencode（exa/parallel）/ dsh（web 能力） | S–M | provider | 可插空 |
| R-B4 | git 快照/undo | turn 級 capture + revert（回滾消息/檔案） | opencode（snapshot+undo）/ codex（revert/rollback） | L | fs、llm | 中長期 |
| R-B5 | LSP 擴充 | documentSymbol/workspaceSymbol/callHierarchy/incoming+outgoingCalls | opencode | S | lsp | 可插空 |
| R-B6 | skills 增強 | 影子選擇器（離線評估）、插件技能根、隱式調用 policy | codex（shadow BM25/ngram） | M | skills、plugin-registry | 隨 R-E4 |
| R-B7 | 統一 output spill | registry 級上限 + 統一落盤目錄 + GC + outputPaths | opencode / dsh（spill policy） | S | core-tools、output-retention | 可插空 |
| R-B8 | 進程控制面 | process/spawn|kill|resizePty + 背景任務 + backgroundTerminals | codex | M | exec、subagent | 與 R-B2 同批 |
| R-B9 | fs watch | 檔案系統監看事件（watcher.ignore 尊重） | opencode（parcel-watcher）/ dsh / codex | M | filesystem | 中長期 |
| R-B10 | 執行策略深化 | execpolicy/PermissionProfile/shell-escalation/process-hardening | codex | L | guard-approval、sandbox | 遠期 |
| R-B11 | **（範式決策）PTC/code-mode** | 工具收斂到 run_code + 生成式 SDK prompt；受限腳本執行 | dsh（PTC）/ codex（code-mode+GRPC）/ opencode（codemode interpreter） | L | core-tools、sandbox | **先決策後動工** |
| R-B12 | **（範式決策）workflow 引擎升級** | worker-thread 跑模型寫 JS + ralph 循環 | dsh（workflow-worker-thread） | L | workflow、subagent | **先決策後動工** |
| R-B13 | apply_patch AST 驗證 | tree-sitter 語法驗證 patch 命令注入 | codex | S | fs-tools | 遠期（mtime 已成立） |
| R-B14 | ask_user_input / request_permissions 工具化 | 模型主動問使用者（結構化問題/授權） | codex（request_user_input/request_permissions） | S | interaction | 可插空 |

## 3. 每項詳情

### R-B1 MCP 強化 ★建議首選
- **為什麼**：遠程 MCP（現行標準必需 OAuth 2.1）；resource 工具把 MCP 資源捲入模型視野；blocked/direct 列表是安全策略層。
- **機制源**：opencode `core/src/mcp`（auth.ts TokenStore、oauth-provider/callback、roots 聲明、blockedTools/directTools、status 五態）；codex 的 MCP server 以獨立二進制 + 平台沙箱啟動（`mcp-server` 經 EnvironmentManager 傳 sandbox exe）——安全姿態更高。
- **IH 化**：mcp-client 加 auth 存儲（coordinator documents 或檔案 + flock 對齊現有 fs-lock）、回調頁（node:http）、PKCE（node:crypto 零依賴）；resources 工具走 deferred 曝光；工具黑白名單在 catalog 層。
- **邊界**：OAuth 需要本地回調端口；失敗=未授權（fail-closed），不自動省略。

### R-B2 PTY/terminal
- **機制源**：dsh `terminal/*`（Terminal service + tool-terminal 六工具、Persistent PTY session owner-scoped）；codex 的 exec_command + backgroundTerminals（異步 stdin 注入）。
- **IH 化**：dependency `node-pty` 為唯一新外部依賴（與 `koffi` 同類——或標記為例外依賴）；exec 加 Terminal 服務 + 六工具。
- **與現有**：與 bash/pwsh（一次性）並存，terminal 是長駐語義。

### R-B3 web 存取
- webfetch ~150 行（fetch + body 抽取 + 上限）；websearch 用 provider seam（opencode exa/parallel、dsh web providers、codex hosted spec）——**IH 零依賴下用可插拔 provider + 預設無實現 fail-closed**（同 skills 模式）。

### R-B4 git 快照/undo
- opencode：content-addressed git trees 每 project、capture/files/diff/preview/restore/checkout + revert 工具（消息截斷邊界）；codex：thread/revert（drop N user turns）+ rollback checkpoint。
- IH 化：新包（git 模式 + 快照樹）+ revert 工具；成本 L（跨 fs/subagent/compaction）。

### R-B6 skills 增強
- codex selector（BM25/ngram 影子離線跑，測量檢索器品質）；plugin 技能根（R-E4 的 plugin-registry 分支已 materialize）；隱式調用 policy（allow_implicit_invocation 門控）。
- IH 化：影子評估可先做（確定性、無副作用）；policy 一行配置。

### R-B8 進程控制面
- codex `process/spawn|writeStdin|kill|resizePty` app-server ops、backgroundTerminals（後台任務化 + get_task 輪詢）。
- IH 化：exec 服務加 ProcessHandle 接口 + 背景任務表（對齊 D 區任務協議）。

### R-B9 fs watch
- opencode parcel-watcher（win/linux 原生綁定）；dsh chokidar（settings/credentials 熱更）；codex fs/watch。
- IH 化：零依賴語意下**可選**——用 polling 或標記「外部依賴例外」；收益在「上下文變化感知」（配合 A4）。

### R-B11/R-B12（範式決策）
- 兩者都是「改變工具的供給哲學」：PTC = 全收斂到 run_code（dsh 立場，生成式 SDK 詳情已備）；code-mode = 受限腳本調用工具（codex v8/GRPC + opencode 的 acorn interpreter——**後者有沙箱風險**）。
- IH 目前 YAML workflow + 分類工具。**不建議現在動；若動，以 dsh worker-thread 為概念源**（模型寫 JS 跑在 worker + subagent 注入，比 codemode interpreter 安全）。

## 4. 排序建議

1. R-B1（首選）→ R-B3、R-B5、R-B7、R-B14（快贏組）
2. R-B2 + R-B8（PTY+進程控制同批）→ R-B6（等 R-E4）
3. R-B9 → R-B4（中長期）
4. R-B10、R-B13 遠期；R-B11/R-B12 標記「範式決策，先拍板」

## 5. 依賴交叉

- R-B1 不阻任何區；R-B2/R-B8 依賴 A 區的 session 執行器（R-A2）。
- R-B6 依賴 E 區 plugin-registry（R-E4）。
- R-B4 依賴 R-A3（回滾要修復鏈語義一致）。
- R-B11/R-B12 會影響 core-tools 曝光面（與 A 區 tool_search 交互）。

## 6. 取捨紀錄（待填）

| # | 決策 | 註記 |
|---|---|---|
| R-B1 | **M26 立即** | MCP 強化（OAuth 2.1 + roots + 資源工具 + blocked/direct） |
| R-B2 | **M26 立即** | 引入 node-pty（首個新外部依賴，與 koffi 同例；註明理由） |
| R-B3 | **M26 立即** | web 存取（webfetch + 可插拔 websearch provider） |
| R-B4 | 後補 | 待 UI 產品反饋定 undo 形狀（M27+） |
| R-B5 | **M26 立即** | LSP 擴充（symbol/call hierarchy） |
| R-B6 | 後補 | 隨 R-E4（插件技能根生效後） |
| R-B7 | **M26 立即** | registry 級統一 output spill |
| R-B8 | **M26 立即** | 與 R-B2 同批（進程控制面 + backgroundTerminals） |
| R-B9 | 後補 | 消費方未定（A4 用 turn 前檢查即可；真正收益在 UI 面） |
| R-B10 | 遠期 | 執行策略深化（codex execpolicy 級），待授權產品場景 |
| R-B11 | **不做** | 範式決策：維持分類工具 + deferred + BM25 tool_search |
| R-B12 | 後補 | 範式決策：workflow worker-thread 升級，先調研 dsh 實效再定 |
| R-B13 | 後補 | AST 驗證（B1 之後工具面穩定時隨手補） |
| R-B14 | **M26 立即** | ask_user_input 工具化 |
