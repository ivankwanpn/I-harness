# I-harness 外部契約（embedder / host 視角）

> 2026-08-31（M27-H-6）。本文件是外部 embedder / host / SDK 消費方賴以編程的**契約面**：命令與工具的名稱、輸入 shape、以及 fail-closed 行為。內部實作細節見各包 README / 設計文檔。
>
> 文法基準：命令走 DSH 文法（`/name json-payload`），工具走 JSON-RPC-style `execute({ args })`。命名沿 M26 正名結果（`session-send` 系列、`terminal_*` / `process_*`、`ask_user_input`、`get_context_remaining`）。

## 命令（interaction commands）

在執行器 lane（serial inbox）上操作；一律以 JSON 字符串作為輸入參數，執行成功回 `{ "queued": true }` 類 JSON。JSON 解析失敗 → 命令 throw（宿主顯示錯誤，不排隊）。

| 名稱 | 輸入（JSON） | 行為 | 時機 |
|---|---|---|---|
| `session-send` | `{ "text": string }` | 提交到執行器 lane（`send` 層級） | 執行器運行中 |
| `session-followup` | `{ "text": string }` | 提交到執行器 lane（`followup` 層級） | 執行器運行中 |
| `session-steer` | `{ "text": string }` | 提交到執行器 lane（`steer` 層級，step 邊界領取） | 執行器運行中 |
| `session-inject` | `{ "text": string, "description": string, "scope": "turn" \| "session" }` | 提交注入輸入；**description + scope 必填**（缺 → JSON 驗證失敗） | 執行器運行中 |
| `session-cancel` | `{ "inputId": string }` | 取消指定待處理輸入；回 `executor.cancel(inputId)` 結果 | 執行器運行中 |
| `session-pending` | （無） | 列出待處理輸入：`{ "inputId", "text", "delivery" }[]` | 執行器運行中 |

> 註：這些命令由 CLI 的 `run` 路徑在 assembly 上註冊（`apps/cli/src/run.ts`）；restore 的 pending 輸入在恢復時以 FIFO 先於新任務排出。宿主（web-host）經 `CommandBridge.run(sessionId, line)` 代理。

## 工具面（B 區，M26-B）

### 終端（node-pty，Windows ConPTY）

`registerTerminal` 掛載（`packages/terminal/src/tool.ts`），以 `ctx.services` 的 `terminal/service` 為後端：

| 工具 | 輸入 | 說明 |
|---|---|---|
| `terminal_open` | `{ command: string, args?: string[], cwd?: string, cols?: number, rows?: number }` | 開長效互動終端；回 `{ id }` |
| `terminal_send` | `{ id: string, data: string }` | 寫 stdin；`\n` 按字面送出 |
| `terminal_read` | `{ id: string, offset?: number, maxBytes?: number }` | 自 offset（UTF-16 code units）拉取 buffer，輸出正規化 LF；回 `{ id, data, nextOffset, eof? }` |
| `terminal_signal` | `{ id: string, signal: "INT" \| "TERM" \| "KILL" }` | 發訊號 |
| `terminal_close` | `{ id: string }` | 關閉終端並釋放 |
| `terminal_list` | （無） | `{ terminals: [...] }` |

### 進程控制（同 service 薄包）

| 工具 | 輸入 | 說明 |
|---|---|---|
| `process_spawn` | `{ command: string, args?: string[], cwd?: string, env?: object }` | spawn pty 後端進程 handle |
| `process_kill` | `{ id: string, signal?: "INT" \| "TERM" \| "KILL" }` | 終止進程（缺省 TERM） |
| `process_resize_pty` | `{ id: string, cols: number, rows: number }` | 調整 PTY 尺寸 |

### 檢索 / 交互

| 工具 | fail-closed 行為 |
|---|---|
| `webfetch` | 僅 http/https（`WEB_UNSUPPORTED_PROTOCOL` 拒止非絕對 URL / 非 http(s)）；響應截斷標記 `truncated` / `bodyTruncated`（無需 provider） |
| `websearch` | **無 search provider 時註冊但執行即 throw `NO_PROVIDER`（fail-closed），不靜默返回空結果** |
| `ask_user_input` | **無 user-questions provider → 執行 throw `NO_PROVIDER`（fail-closed）**；答案作為 tool result 回傳，模型可見 |
| `get_context_remaining` | **無 contextWindow 知識 → 不註冊（fail-closed）**；回應 `{ window, used, remaining, percentage }`（M27-R-A8） |

> 正名註記：M26 已將工具面統一為 `terminal_*` / `process_*` 字首；`webfetch` / `websearch` 沿用 M21 名稱；`ask_user_input` 為 M26-B14；`get_context_remaining` 為 M27-R-A8（對應 codex 同名能力）。

## 事件/遙測（telemetry）

宿主訂閱 `session/event` 等事件流（M25 sink 接口；web-host 的 live mux 亦承接）。事件碼 13+ 位，詳見 `packages/web-host` 與 `packages/telemetry`。命令/工具面事件（`command/run`、`command/done`）追加到 session live log，模型不可見。

## 版本 / 健康

`GET /api/health`（web-host）→ `{ "healthy": true, "version": string }`；version 源 = `apps/cli` package.json 常量（M27-H-1 注入）。
