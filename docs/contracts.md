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

## LLM provider 協議（M30）

`--model provider:model` / settings `llm.providers.<route>` 的五個 wire 協議（registry marker 與 wire 詞彙在 gemini/bedrock 兩邊同字串；openai 系既有「openai-compatible」marker vs「openai-completions」wire 不對稱保留）：

| protocol | adapter 包 | 認證 | 端點/形狀 |
|---|---|---|---|
| `openai-completions` | `llm-openai-compatible` | Bearer | `{base}/v1/chat/completions` |
| `openai-responses` | `llm-openai` | Bearer | `{base}/v1/responses` |
| `anthropic-messages` | `llm-anthropic` | `x-api-key` | `{base}/v1/messages` |
| `gemini` | `llm-gemini` | `x-goog-api-key` | `{base}/v1beta/models/{model}:streamGenerateContent?alt=sse`（原生 Google GenAI REST；baseUrl 缺省 `https://generativelanguage.googleapis.com`） |
| `bedrock` | `llm-bedrock` | **無 apiKey**（AWS 憑證鏈：`AWS_ACCESS_KEY_ID/SECRET`／`~/.aws/credentials`+profile／IMDS；region = `AWS_REGION`→缺省 `us-east-1`） | AWS SDK `ConverseStreamCommand`（SigV4 由 SDK 處理，不走 HTTP 可替代端點） |

- bedrock 路由無 key 亦可 `--model bedrock:...`（CLI 鑰匙門檻例外）；其餘路由仍 `--model` 必須帶 `--api-key`（fail-loud，不回退 mock）。
- gemini/bedrock 的 model probe（模型清單）：gemini v0 走通用 discovery（如配置了 baseURL + key）；bedrock 無 live probe，以 profile 的靜態 catalog（CLI 內建 bedrock profile 預填）兜底，無 catalog → `ProbeUnavailableError`。

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

### Wire Contract v1 addendum（M41a，2026-09-04 — ADDITIVE-only）

> 上文 v0 全部內容**不變**；v1 = 只加：`PROTOCOL_VERSION` 1 → **2**（`SDK_SERVER_PROTOCOL_VERSION` 同步）。break 流程（凍結後變更流程）不變——v1 起仍**只加不改**。v0 客戶端（僅 initialize / session/prompt / session/status / shutdown）不受影響：其方法面照 v0 shape 應答，新方法不存在於其調用面。

| 方向 | 方法 / 通知 | 參數 | 響應 |
|---|---|---|---|
| call | `session/history` | `{ sessionId, afterSeq?, limit? }` | `{ events: SessionEvent[], nextSeq }`（`afterSeq` **內斥**（exclusive），預設 0；`limit` 預設 500，clamp 上限 1000；`nextSeq` = 下一個未回傳事件的 seq（全回傳時 == log 長度）；未知 sessionId → `-32602` + 明確「session not found」（fail-closed：read 永不 auto-create）；log 空 → `{ events: [], nextSeq: 0 }`） |
| call | `session/list` | `{}` | `{ sessions: SessionListEntry[], listingUnavailable? }`（source 為 server 選配 `listSessions`；缺省 → `{ sessions: [], listingUnavailable: true }` 誠實「未知」，絕不偽造空表；source throw → `-32603` fail-closed） |
| call | `initialize`（v1 響應） | `{}` | 同 v0 外殼不變，且 `protocolVersion: 2`；capabilities **增加** `"session-history": ["1"]`、`"session-list": ["1"]`（v0 行 byte-identical）。 |

**`session/history` 語意**：server 以 `service.liveSession(sessionId)` 解析（in-process live log——session/prompt 同一 session 源之 assembly log；seq 為 0-based 追加位置，故 walk = slice `[afterSeq, nextSeq)`）。

**`session/list` 組態**：apps/cli 的 `sdk` 命令在 `--session-dir` 給定時以 **coordinator 面** 注入 listing（`coordinator.list()` + `profile()` 逐行 header 讀，web-host 鏡像）；profile 敗行仍呈 `{ id }` 行（誠實行）並 loud 於 stderr；未給 `--session-dir` → 無源 → `listingUnavailable: true`。

**`SessionListEntry`**：`{ id, title?, updatedAt?, turnCount?, contextUsed?, contextTotal? }`——`title` 以外均為**可選**（header-only profile 只給 `id`/`title`；`updatedAt`/`turnCount`/context 需要完整 log 讀，不在 v1 源面承諾）。消費端須容忍缺省字段。

### Wire Contract v1.1 addendum（M41b，2026-09-05 — v1 的附錄，**additive-only**）

> v1.1 是 v1 的**附錄**：`PROTOCOL_VERSION` **保持 2**（新面走 capabilities 行）；v0/v1 全部 shape 不變。break 流程（凍結後變更流程）不變——仍只加不改。v0/v1 客戶端不受影響。

| 方法 | 參數 | 響應 | 語意 |
|---|---|---|---|
| `session/cancel` | `{ sessionId }` | `{ cancelled: boolean, reason?: "not-running" \| "not-found" }` | 服務端持有每 session 的 in-flight `AbortController`（`session/prompt` 建、submit 前入槽、submit 落定後清槽）→ `abort()`。`cancelled:true` = 已中止（in-flight 槽存在）；`false` + `not-running` = 已知 session 且閒置；`false` + `not-found` = 服務端從未見面（無 live assembly / 本服務端未建過）。未知 session **不回錯誤幀**——誠實 `{ cancelled: false, reason: "not-found" }`。中止語意到引擎：queued turn（未開跑）被 service.submit 的 `signal.aborted` 擋下——**永不開跑**（加性驗證）；running turn 的流中止依賴引擎 lane 的 signal 注入（session-executor 現況未注入——見 M41b 偏差註記）。 |
| `session/rewind/points` | `{ sessionId }` | `{ points: [{ turnIndex, preview, files }] }` | host `rewindFactory` 直調（每請求解析當前 assembly 的 rewind handle——embedded 橋模式）。未知 session → `-32602` 明確「session not found」（read 永不 auto-create）；缺 factory / factory 回 undefined → `-32603`「rewind not enabled」。 |
| `session/rewind/plan` | `{ sessionId, target, mode? }` | `{ clean: [{ path, op }], conflicts: [{ path, kind }], unTracked: [string], ops: [{ path, op }] }` | 引擎 lazy 兩階段 dry-run（clean = 仍可純重放；conflicts = 外部已漂移但仍會執行；unTracked = 記錄在 target 之後、restore 不覆蓋的後續路徑；ops = 可執行文件操作——conversation 模式為空）。`mode` 缺省 `all`；enum 非法 / target 非 non-negative integer → `-32602`。 |
| `session/rewind/execute` | `{ sessionId, target, mode? }` | `{ revertedFiles: number, conflicts: [{ path, kind }], error? }` | 文件還原（conflict 照樣執行、如實標記）+ `appendEvent` → **服務端落 live session log**（rewind/point 標記 → 既有 `session/event` 通知流，無新通知；投影語意 G2 屬）。`error` = 引擎 had_errors（points.jsonl 保留重試數據）。 |
| `initialize`（v1.1 響應） | `{}` | 同 v1 外殼不變、`protocolVersion: 2`；capabilities **增加** `"session-cancel": ["1"]`、`"session-rewind": ["1"]`（v0/v1 行 byte-identical）。 |

- **rewind wire shape 鏡像引擎**：`session/rewind/*` 的 shape 是 packages/rewind 類型的**結構鏡像**（wire 不能依賴 rewind 包——獨立）；宿主側（apps/cli）factory 於請求時做引擎型 → wire 型映射；引擎內部鍵（blob id）永不洩漏——wire 文件操作為 `{ path, op: "restore-blob" \| "delete-added" }`。
- **list 行豐富（v1.1 源面）**：apps/cli `sdk` 命令的 `listSessions` 源在 `--session-dir` 給定時補 `updatedAt`（artifact mtime——M37b store-listing 慣例；stat 失敗回退 `meta.createdAt` 解析）+ `turnCount`（`coordinator.load` 的 turn/start 計數——唯讀路徑，非 mutating）。其餘 context 字段（contextUsed/contextTotal）仍可選缺省；單行 load 失敗 → 行保留（無 turnCount）並 loud 於 stderr（profile 敗行維持 M41a 的「唯 id 誠實行」）。

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

## M29 變更註記（2026-09-02，SQLite 持久化分離）

> 本節記錄 M29（JSONL-only 持久化 + 獨立可重建搜索索引）帶來的**外部語意**變化；內部實作見 `docs/research/2026-09-02-ih-sqlite-removal-study.md` 與 `docs/superpowers/specs/2026-09-02-m29-sqlite-split-design.md`。

- **持久化唯一權威**：JSONL。`--session-backend` 旗標已移除；傳入即 fail-loud 拒絕（見上）。鎖（fs-lock）、`profile` / `updateMeta`、文檔側車不受影響。

- **搜索面語意（D1 一致性模型替換）**：`session_search` / `lineage`（及 web `/api/sessions/search`、`/lineage`）不再吃「與持久化**同事務、永不偏離**」的 SQLite FTS，而由**文件級 file-backed 索引**承載（`reconcile-on-search`）：
  - 每次搜索前對帳 `storeRoot`（目錄掃 + 首行 header + stat revision）；僅對**變更的 session** 全量 decode 重建，未變者以 revision 指紋跳過。
  - **搜索永不舊於自身 reconcile**——比「永不偏離」更強：過期數據絕不呈現（對異步寫入者也成立）。
  - 對帳 / 讀取失敗 → `SESSION_QUERY_OBSERVE_FAILED`，**不回退舊行**（fail-closed）。
  - 索引文件 schema 版本不符 / 外來 DB（`application_id != 0x49485155`）→ `SESSION_QUERY_INDEX_FOREIGN`，拒絕不碰。

- **搜索默認態（D3）**：`--session-dir`（storeRoot 已知）→ 搜索工具**出廠可用**（`first-search` 語意：首次搜索建索引，進程內持久）；無 `--session-dir` → 不掛載（與舊語意一致，web 對無 seam 的請求仍 `409 search_not_enabled`）。

- **`searchBackend` 設置語意（D2，降級）**：`settings.searchBackend` 字符串保留（`"jsonl"` = 搜索索引開啟，默認），不再對應任何多後端旗標；舊值 `"sqlite"` **相容讀取為開啟**；未知值（如 `"postgres"`）歸屬默認 `"jsonl"`。
