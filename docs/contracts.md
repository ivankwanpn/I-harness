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

## SDK（`@i-harness/sdk` NDJSON JSON-RPC — Wire Contract v0）

> M28 S-1（2026-09-01）**凍結**。`i-harness sdk`（stdio）與內嵌 harness 走同一條線規約；事實來源：`packages/sdk/src/protocol.ts`（framing + 錯誤碼,頭部 JSDoc = 完整契約註釋）與 `src/server.ts`（方法語義）。漂移哨兵測試：`packages/sdk/test/server.test.ts` 的「initialize wire contract v0 (field-level lock)」。

**Framing**：每行一條 JSON-RPC 2.0 訊息（`JSON.stringify` + `\n`，NDJSON）。畸形行**靜默忽略**（不回應、不崩潰——絕不會 echo）；請求 `id` 原樣進響應。

**Wire Contract v0**：

| 方向 | 方法 / 通知 | 參數 | 響應 |
|---|---|---|---|
| call | `initialize` | `{}` | `{ name, version, protocolVersion, capabilities }`（預設 `version: "0.1.0"`；`protocolVersion: 1` = 契約錨定常量；capabilities = `{ session: ["prompt","status"], notifications: ["session/event","session/status"] }`） |
| call | `session/prompt` | `{ sessionId, prompt }` | `{ sessionId, ok: true }`（turn 跑完歸還）;turn 失敗 → `-32603`，`data.event` 帶已收集事件 |
| call | `session/status` | `{ sessionId }` | `{ running, queued }` |
| call | `shutdown` | `{}` | `{ ok: true }`（響應後宿主 teardown） |
| notify（S→C） | `session/event` | `{ sessionId, event }` | —（僅追加滾動流：訂閱後的事件即時推送） |
| notify（S→C） | `session/status` | `{ sessionId, status, error? }` | —（`queued`/`idle`/`error` 生命周期） |

**錯誤碼表**（JSON-RPC 常量,protocol.ts；shape：`{ jsonrpc: "2.0", id, error: { code, message, data? } }`）：

| 碼 | 名稱 | 觸發 |
|---|---|---|
| `-32700` | `PARSE_ERROR` | 解碼出非請求/響應形狀的行 |
| `-32600` | `INVALID_REQUEST` | 常量定義（v0 伺服器不發——畸形行靜默忽略） |
| `-32601` | `METHOD_NOT_FOUND` | 未知方法 |
| `-32602` | `INVALID_PARAMS` | `sessionId`/`prompt` 缺失、空或非字串 |
| `-32603` | `INTERNAL_ERROR` | turn / handler 拋錯 |

**回放語義**：`session/event` 流**僅追加、不重放**——新連接只看到訂閱後追加的事件；session 的持久化狀態可跨連接恢復（同 `sessionId`），但歷史事件不回放在新訂閱上。

**凍結後變更流程（v1 起）**：只做**加性**變更——新方法、新通知字段、新錯誤碼可加；既有字段 shape / 錯誤碼**只加不改**。改變或刪除既有 surface = breaking：`PROTOCOL_VERSION` bump + migration 註記。

## 版本 / 健康

`GET /api/health`（web-host）→ `{ "healthy": true, "version": string }`；version 源 = `apps/cli` package.json 常量（M27-H-1 注入）。

## ACP wire（R-C7，M28）

`i-harness acp`（`packages/acp`，官方 `@agentclientprotocol/sdk`）serves **ACP v1**（`protocolVersion` = 1）的 automation 子集——stdin/stdout NDJSON JSON-RPC，stdout 僅 ACP 幀（日志一律 stderr）。A session-driven 面（A4/A5 等 turn 前檢查）不變。

### Agent 面（我們 = ACP Agent）

| 方法 | 行為 |
|---|---|
| `initialize` | `{ protocolVersion: 1, agentInfo: { name: "i-harness", version }, agentCapabilities: { sessionCapabilities: { list: {}, close: {}, resume: {} } } }` |
| `session/new` | `{ sessionId }`（`--session-dir` 給定 → `SessionCoordinator` 持久化；否則 in-memory） |
| `session/list` | `{ sessions: [{ sessionId, cwd }] }`（coordinator ∪ 本會話新建；adopted 的 cwd 回報 harness workspace） |
| `session/resume` | `{}`；未知 id → 錯誤（fail-closed） |
| `session/close` | `{}`（v0 no-op；v1 掛點：flush + lease 釋放） |
| `session/prompt` | 提交文本（text content block 拼接；非 text 塊 v0 拒收）到 `SessionService.submit`（tier send），run 結束回 `{ stopReason: "end_turn" }`；被 cancel/連線中斷 → `{ stopReason: "cancelled" }` |
| `session/cancel`（notification） | 中止該 session 的 in-flight submit（閒置時 no-op） |

### Client 面 / 未用（v0 排除項）

- **權限面（v0）**: `autoApprove`（預設 `true`）＝ **allow-once**——prompt 直接 admission，不呼叫 `session/request_permission`。`autoApprove: false`（CLI `--no-auto-approve`）＝ **拒絕 prompt**（fail-closed：v0 無 request/approval 回環）。**v1 掛點**：guardian/approval 接線 + `session/request_permission` round-trip。
- **v0 省略（文檔化）**: session/new 的 `mcpServers`、per-session cwd（service 固定於 CLI workspace）、`session/update` 通知鏡像（session 事件 == `session/event` 流，ACP 側 v0 不轉發）、`session/delete`/`fork`/`set_mode`/`set_config_option`、terminal/fs/elicitation client 方法、`authenticate`。

### 與 SDK 的界線

`i-harness sdk`（NDJSON JSON-RPC v0 自家協議）是原生宿主協議；`i-harness acp` 是標準外部 ACP。二者只用 `--session-dir` 旗標（M29 起 `--session-backend` 已移除——JSONL 是唯一持久化後端，旗標傳入即 fail-loud 拒絕）、stdout 純幀紀律一致。ACP v1 下 `session/prompt` 是 request（回 `PromptResponse`）——舊版「fire-and-forget + `sessionUpdate{messageId}` admission 回執」的設計由「await submit + stopReason」取代（SDK 1.4 高階 client 面即此形狀）。
