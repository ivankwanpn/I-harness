# opencode 1.18.30 TUI 移植可行性（graft feasibility）

日期：2026-09-09 · 方式：唯讀走查（兩棵樹皆未執行、未安裝、未建置）
範圍：`D:\agent-complete\opencode-1.18.30`（以下路徑省略此前綴）與 `D:\I-harness-main`（以下簡稱 IH）
問題：把 opencode 的 TUI 整個複製到 `tui-beta-1` 並改接 IH backend，是否可行？

---

## 一頁結論

**1. opencode 的 TUI 是純前端嗎？——是，而且邊界比預期乾淨。**
TUI 是 SolidJS + OpenTUI（`@opentui/core` / `@opentui/solid` / `@opentui/keymap`）寫的終端機應用
（`packages/tui/package.json:50-67`），執行期只透過 **HTTP + SSE** 跟一個 opencode server 說話
（`packages/tui/src/context/sdk.tsx:24-31, 82-117`）。整個 `packages/tui/src`（27,044 行 / 152 檔）
對 agent core 的依賴只有 10 個檔案、且只用到 `Global`（家目錄/state 路徑）、`Flag`（環境開關）、
`InstallationVersion`、`util/glob`、`util/flock`——**沒有任何一行碰 provider、session 持久化、
tool 執行或 agent loop**。

**2. 但「移植」的可行性不取決於 TUI，而取決於它期望的 server 形狀。**
TUI 的注入縫隙是真的：`TuiInput` 接受外部 `fetch` 與 `events`（`packages/tui/src/app.tsx:142-152`），
opencode CLI 自己就用這條縫把 in-process Worker 的 RPC 偽裝成 fetch/EventSource
（`packages/opencode/src/cli/cmd/tui.ts:24-50, 238-249`）。所以**不需要 fork TUI 本體**。
代價是：你必須實作一個「opencode server 形狀」的 HTTP/SSE facade。這個形狀的量體是
**61 個 v2 endpoint（`packages/protocol/src/groups/*.ts`）＋ legacy instance API（生成型別裡另有
188 條非 `/api/` URL）＋約 70 種事件（`packages/schema/src/event-manifest.ts:57-82` 展開）**；
TUI 實際打到 **55 條不同的 SDK 路徑**（24 個檔案、109 個呼叫點）、`sync.tsx` 的 store 認得
19 種事件（`packages/tui/src/context/sync.tsx:176-446`）。

**3. IH 的邊界跟它不同構，而且缺的樓層不是「欄位」而是「平面」。**
IH 是 NDJSON JSON-RPC 2.0 over stdio、`PROTOCOL_VERSION = 2`、19 個方法、2 個通知
（`packages/sdk/src/protocol.ts:216`、`packages/sdk/src/server.ts` case 清單），外加
capability 行做加法協商（`packages/sdk/src/server.ts:276-295`）。差異最大的三處：
- **permission / question 根本不在 IH 的 wire 上**——它們是 in-process seam
  （`packages/interaction/src/index.ts:5-19, 32-44`，經 `service.onAssembly` 掛上，
  `packages/tui/src/backend/approval.ts:1-20`）。opencode TUI 的權限 UI（`routes/session/permission.tsx`
  719 行）與提問 UI（`question.tsx` 515 行）**在 `--attach` 模式下無事可做**。
- **串流粒度不同**：opencode 是 message/part 模型 + 逐欄位 delta 補丁
  （`message.part.delta`、`session.next.text.delta`、`session.next.tool.progress`…），
  IH 是 `assistant/chunk` / `tool/call` / `tool/result` 的事件流，**沒有 message id、沒有 part id、
  沒有 tool progress、沒有 tool input streaming**（`packages/tui/src/backend/embedded.ts:181-333`
  的 mapper 就是全部介面）。
- **provider / agent / MCP / LSP / VCS / workspace / console 管理面**在 IH 屬於本地主機
  （`apps/tui/src/index.ts` + `ProviderController`），不在 server 上；opencode TUI 預期 server 擁有它們。

**4. 結論：不做全量移植。** 真正要寫的不是「適配層」而是**第二個 backend**（估計 6,000–12,000 行），
而且必須先替 IH core 補出權限/提問/provider 的 wire 平面；同時整個 TUI 要換到 **Bun runtime
＋ @opentui 原生二進位**，並放棄 IH 的 27,249 行 TUI 測試、PTY harness（57 檔）、minimal 模式
（822 行）、以及 M59/M60 的 grok 1:1 parity 成果。

**建議：選項 C（選擇性吸收），不是 A（全量移植）。** 詳見文末。

---

## 2. opencode TUI 的架構（含證據）

### 2.1 堆疊與進入點

| 項目 | 內容 | 證據 |
|---|---|---|
| 語言/框架 | TypeScript ESM + **SolidJS 1.9**（細粒度響應式） | `packages/tui/package.json:66` |
| 終端渲染 | **OpenTUI**：`@opentui/core` 0.4.5（原生渲染核心）、`@opentui/solid`（Solid renderer）、`@opentui/keymap` | `packages/tui/package.json:55-57`、根 `package.json:43-45` |
| 執行期 | **Bun**（`packageManager: bun@1.3.14`、`bunfig.toml`、`packages/tui/bunfig.toml` 的 `preload = ["@opentui/solid/preload"]`） | 根 `package.json:7`、`packages/tui/bunfig.toml:1-2` |
| 原生依賴 | `@opentui/core-{win32-x64,win32-arm64,darwin-x64,darwin-arm64,linux-x64,linux-arm64,...}` 平台二進位 | 根 `bunfig.toml:6-7` |
| 其他相依 | effect、clipboardy、open、diff、fuzzysort、remeda、strip-ansi | `packages/tui/package.json:58-66` |
| 進入點 | `packages/tui/src/index.tsx:1` → `app.tsx` 的 `run(TuiInput)` | `packages/tui/src/index.tsx:1` |
| 渲染樹 | `run()` 建 renderer → 一大串 Provider → `<App/>`；路由只有 `home` / `session` / `plugin` 三態 | `packages/tui/src/app.tsx:186-363, 1087-1133` |

### 2.2 資料流（單向）

```
opencode server (HTTP+SSE)
   │  REST（sync bootstrap，13 個並行請求）
   │  SSE  /global/event  → GlobalEvent{ directory, project?, workspace?, payload: Event }
   ▼
SDKProvider  ──►  EventEmitter（16ms 批次，flush 時 Solid batch()）
   │                     │
   │                     ├─► SyncProvider：createStore 正規化
   │                     │     provider / agent / session / message / part /
   │                     │     permission / question / todo / diff / mcp / lsp / vcs
   │                     └─► 各元件 event.on(...) 直接監聽
   ▼
SolidJS 元件樹（@opentui/solid 的 <box> / <text> ...）
```

證據：
- REST bootstrap：`packages/tui/src/context/sync.tsx:451-552`（`config.providers`、`provider.list`、
  `experimental.capabilities`、`experimental.console`、`app.agents`、`config.get`、`session.list`、
  `command.list`、`lsp.status`、`mcp.status`、`experimental.resource.list`、`formatter.status`、
  `session.status`、`provider.auth`、`vcs.get`）。
- SSE 訂閱：`packages/tui/src/context/sdk.tsx:82-117`；事件封包型別
  `GlobalEvent`（`packages/sdk/js/src/v2/gen/types.gen.ts:730-734`）。
- 16ms 批次：`packages/tui/src/context/sdk.tsx:48-80`（`elapsed < 16` → setTimeout，flush 內 `batch()`）。
- 正規化 store：`packages/tui/src/context/sync.tsx:70-144`（store 形狀）、`:176-446`（19 個 case 的 reducer）。
- 事件訂閱封裝：`packages/tui/src/context/event.ts:9-36`。

### 2.3 子系統大小（`packages/tui/src`，27,044 行 / 152 檔）

| 目錄 | 行數 | 性質 |
|---|---:|---|
| `component/` | 7,085（含 `component/prompt/` 2,890） | 幾乎全部 opencode 專屬：model/provider/session/workspace/mcp/agent/skill/variant/stash 對話框、command palette |
| `context/` | 3,254 | 伺服器資料平面 + 主題 + KV + 權限 + 路由 |
| `routes/` | 4,660（`session/index.tsx` 2,706、`permission.tsx` 719、`question.tsx` 515） | session 主視圖 + 工具專屬渲染器 |
| `ui/` | 2,108 | **終端機通用**：dialog/toast/spinner/border/link/select |
| `feature-plugins/` | 3,471 | 側欄（context/files/lsp/mcp/todo）、diff viewer、which-key、通知 |
| `theme/` | 1,089 | 主題系統（33 內建 + JSON） |
| `util/` | 915 | 多為通用（format/path/selection/scroll…） |
| `plugin/` | 662 | TUI 插件 API（`@opencode-ai/plugin/tui` 634 行） |
| `config/` | 619 | `TuiConfig` schema + keybind（471 行） |
| `prompt/` | 386 | prompt 顯示 |
| 根檔（`app.tsx`、`keymap.tsx`…） | 2,795 | 啟動、keymap、剪貼簿、音效、win32 輸入 |
| 測試 | 4,777（51 檔） | `packages/tui/test/**` |

---

## 3. 邊界：協定、傳輸、訊息形狀（含證據）

### 3.1 傳輸

| 面向 | opencode | 證據 |
|---|---|---|
| 主傳輸 | **HTTP**（`fetch`），由 `createOpencodeClient({ baseUrl, fetch, headers, directory })` 建立 | `packages/tui/src/context/sdk.tsx:24-31` |
| 事件傳輸 | **SSE**（`sdk.global.event()` 回 async iterable，`for await (const event of events.stream)`） | `packages/tui/src/context/sdk.tsx:91-105` |
| 內建替代通道 | CLI 可注入 `fetch` + `EventSource`：預設走 **in-process Worker + RPC**（`createWorkerFetch` / `createEventSource`），`--port/--hostname/--mdns` 時走真 HTTP + `ServerAuth.headers()` | `packages/opencode/src/cli/cmd/tui.ts:24-50, 234-249` |
| 事件端點 | TUI 用 `/global/event`（legacy，帶 `{directory, project, workspace, payload}` 信封）；v2 另有 `/api/event`（純 `Event`） | `packages/sdk/js/src/v2/gen/types.gen.ts:7261`；`packages/protocol/src/groups/event.ts:35-43` |

### 3.2 協定面

- **v2 契約**：Effect `HttpApi`，18 個 group、**61 個 endpoint**（`packages/protocol/src/api.ts:26-64`；
  各 group 的 `HttpApiEndpoint.` 計數：session 17、pty 7、permission 7、integration 7、question 4…）。
- **legacy 契約**：生成 SDK 內另有 188 條非 `/api/` URL（`packages/sdk/js/src/v2/gen/types.gen.ts`
  的 `url:` 統計），TUI 大量使用（例如 `sdk.client.session.list({ start, scope, path })`，
  `packages/tui/src/context/sync.tsx:170-174`，對應 legacy `/session`，型別 `SessionListData`
  `packages/sdk/js/src/v2/gen/types.gen.ts:9442-9456`）。
- **版本協商：沒有。** TUI 不做 protocolVersion 握手，它是**用生成型別編譯進去的**（`@hey-api/openapi-ts`
  `packages/sdk/js/package.json:26`）。這是與 IH 最大的契約哲學差異。
- **訊息形狀**：`Session.Info`、`Message`（user/assistant）、`Part`（`text` / `reasoning` / `tool` /
  `file` / `compaction` / `agent-switched` / `model-switched` / `synthetic` / `shell`…，
  `packages/schema/src/session-message.ts:20-193`）、`Permission.Request{action, resources, save, metadata, source}`
  與 `Reply = once|always|reject`（`packages/schema/src/permission.ts:25-51`）、
  `Question.Request{questions[], multiple, custom}`（`packages/schema/src/question.ts:22-86`）。
- **事件**：`Event.inventory(...)` 展開約 70 種（`packages/schema/src/event-manifest.ts:57-82`）；
  session 串流事件命名為 `session.next.*`（text.delta/ended、reasoning.*、tool.called/failed/success/progress/
  input.*、step.started/ended/failed、compaction.*、prompt.admitted/prompted、retried、moved…）。
- **TUI 真正用到的**：55 條 SDK 路徑（`grep sdk.client.*`，24 檔）、`sync.tsx` 19 個事件 case、
  `event.on` 20 處 / 14 種型別。

---

## 4. 通用 vs opencode 專屬清單

### 4.1 可重用（與 opencode 語意無關）

| 區塊 | 證據 | 備註 |
|---|---|---|
| `src/ui/`（dialog/toast/spinner/border/link/select）2,108 行 | `packages/tui/src/ui/*` | 終端機通用元件，但綁 `@opentui` 原語 |
| `src/theme/` 1,089 行 | `packages/tui/src/theme/index.ts` | 主題模型通用 |
| `src/config/keybind.ts` 471 + `keymap.tsx` 290 | 同左 | **keybinding/UX 模型**，最有移植價值 |
| `src/util/` 多數（format/path/selection/scroll/record/collapse-tool-output） | `packages/tui/src/util/*` | 純函式 |
| `src/plugin/`（slot/keymap/dialog/prompt 擴充點） | `packages/tui/src/plugin/*` | 插件槽位模型（12 槽） |
| `feature-plugins/system/which-key.tsx`、`notifications.ts` | 同左 | 通用 UX |
| `feature-plugins/system/diff-viewer*` | 同左 | 與 opencode diff schema 有耦合（`session.diff`） |

### 4.2 opencode 專屬（與 server 語意綁死）

| 區塊 | 綁定什麼 | 證據 |
|---|---|---|
| `context/sync.tsx` 全體 | session/message/part/permission/question/todo/diff/provider/agent/mcp/lsp/vcs store 形狀 | `packages/tui/src/context/sync.tsx:70-144, 176-446` |
| `routes/session/index.tsx` 2,706 行 | `Message`/`Part` 投影；工具渲染器按 opencode 工具名分派：Shell/Write/Glob/Read/Grep/WebFetch/WebSearch/Task/Execute/Edit/ApplyPatch/TodoWrite/Question/Skill/Diagnostics | `:2046-2582` |
| `routes/session/permission.tsx` 719 行 | `permission.v2.asked` + `permission.reply(once/always/reject)` | `:1-60`；`packages/tui/src/context/sync.tsx:196-225` |
| `routes/session/question.tsx` 515 行 | `question.v2.*` 多題/多選/自訂 | `packages/schema/src/question.ts:52-86` |
| `component/dialog-model|provider|agent|variant|skill|mcp|workspace|console-org|stash|tag|move-session|session-*` | server 端 provider/agent/MCP/workspace/console 管理面 | `packages/tui/src/component/*` |
| `feature-plugins/sidebar/{lsp,mcp,context}.tsx` | `lsp.status` / `mcp.status` / `session.diff` | 同左 |
| `context/project.tsx` | `path.get` / `project.current` / `project.directories` / `experimental.workspace.*` | `packages/tui/src/context/project.tsx:41-58` |
| `attention.ts` / `audio.ts` | `@opencode-ai/ui` 的 mp3 資產 | `packages/tui/src/attention.ts:17-22` |
| 10 個檔案 | `@opencode-ai/core` 的 `Global`/`Flag`/`InstallationVersion`/`util/glob`/`util/flock` | `packages/tui/src/{app.tsx,clipboard.ts,context/kv.tsx,context/theme.tsx,...}` |

---

## 5. 對照表：opencode 邊界 → IH 邊界

IH 側的權威檔案：`packages/sdk/src/protocol.ts`（wire 契約，`PROTOCOL_VERSION = 2`，`:216`）、
`packages/sdk/src/client.ts`（`HarnessClient`，`:100-445`）、`packages/sdk/src/server.ts`（方法實作與
capability 行，`:276-295`）、`packages/tui/src/contracts.ts:192-270`（`BackendClient`）、
`packages/tui/src/backend/embedded.ts`、`packages/tui/src/backend/remote.ts`、`apps/cli/src/index.ts`。

| # | opencode TUI 期望 | IH 現況（file:line） | 缺口性質 |
|---|---|---|---|
| 1 | HTTP `fetch` + SSE（`/global/event`） | NDJSON JSON-RPC over stdio，`JsonRpcLineTransport`（`packages/sdk/src/protocol.ts:555-591`）；2 個通知 `session/event`、`session/status`（`:32-35`） | **傳輸層**：需 HTTP+SSE facade（或注入 shim `fetch`/`EventSource`，見 `app.tsx:142-152`） |
| 2 | `session.list/get/create/fork/delete/update/move`、`session.messages`、`session.message`、`session.todo`、`session.diff`、`session.status/active`、`session.revert.*`、`session.summarize/shell/command/abort/interrupt`（17 endpoint） | `session/list`、`session/create`、`session/fork`、`session/history`、`session/status`、`session/prompt`、`session/cancel`、`session/queue(+cancel)`、`session/tasks(+cancel)`、`session/dashboard`、`session/model/{state,set}`、`session/rewind/{points,plan,execute}`（19 方法，`packages/sdk/src/server.ts` case 清單） | **投影模型**：IH 給的是**事件日誌**，不是 message/part 投影；沒有 delete/update/move/shell/summarize REST |
| 3 | `Message` + `Part[]`（有 messageID/partID） | `SessionEvent` union 36 型（`packages/core-session/src/index.ts:5` 起）；mapper 只輸出 18 種 `TuiEvent`（`packages/tui/src/contracts.ts:30-55`） | **無 id**：IH 事件沒有 message id / part id，opencode store 以 id 為鍵 → adapter 必須合成穩定 id |
| 4 | 逐欄位 delta：`message.part.delta{field, delta}`、`session.next.text.delta`、`reasoning.delta`、`tool.input.delta`、`tool.progress` | `assistant/chunk`（整段文字）、`reasoning`、`tool/call`、`tool/result`；**無 progress、無 input streaming**（`packages/tui/src/backend/embedded.ts:193-247`） | **粒度**：UI 的 spinner/串流游標會失真或需自造 |
| 5 | `session.next.step.*`、`session.next.retried`、`session.idle`、`session.status{type: busy|idle|retry}` | `session/status` 通知只有 queued；`session/status` 請求回 `{running, queued}`（`packages/sdk/src/protocol.ts:30`）；**無 retry 狀態** | **生命週期**：缺 retry/step/idle 語意 |
| 6 | `permission.v2.asked/replied`（action/resources/save/metadata/source）+ `permission.reply(once/always/reject)` + 7 endpoint | **wire 上完全沒有**。權限只存在 in-process seam：`ApprovalRequest{name,reason,command?,argv?,dangerClass?,pathSummary?}` → `ApprovalDecision{approved: boolean}`（`packages/interaction/src/index.ts:5-19`），經 `service.onAssembly` 掛載（`packages/tui/src/backend/approval.ts:1-20`），**只有 embedded 模式有** | **平面缺失**：opencode 權限 UI 在 `--attach` 下無來源；IH 的布林 seam 也表達不了 once/always/scope |
| 7 | `question.v2.asked/replied/rejected`（多題、多選、custom）+ 4 endpoint | `UserQuestion{id,prompt,options?}` → `Promise<string>`（`packages/interaction/src/index.ts:32-44`），同樣 in-process only | **平面缺失 + 形狀更弱** |
| 8 | `config.providers` / `provider.list` / `provider.auth` / `provider.oauth.*` / `app.agents` / `command.list` / `config.get` | wire 上只有 `session/model/{state,set}`；provider 管理在本地主機（`apps/tui/src/index.ts` 的 `ProviderController`、`packages/tui/src/app/provider-controller.ts`） | **擁有權不同**：IH 的 provider 平面在 CLI 進程內 |
| 9 | `lsp.status`、`mcp.status/connect/disconnect`、`experimental.resource.list`、`formatter.status`、`vcs.get/status`、`workspace.*`、`console.*`、`global.upgrade` | 全部不在 IH wire 上（MCP/LSP 存在於 core，但沒有 wire 事件） | **平面缺失** |
| 10 | 憑證由 server 持有（OAuth callback、`auth.set`） | 憑證在 CLI 主機（`@i-harness/credentials`、`provider-runtime`） | **架構不同** |
| 11 | 無版本協商；生成 SDK 綁死 | `initialize` 握手回 `{protocolVersion: 2, capabilities}`；capability 行閘控可選方法（`packages/tui/src/backend/remote.ts:951-992, 1083-1141`） | IH 較嚴謹；**移植後這套紀律會失效**（opencode 端不讀它） |
| 12 | session 狀態 = server 持久化（SQLite，多專案/多 workspace/location 中介層） | 每 session 一個 JSONL + 一個 live assembly（`packages/session-persistence-jsonl`、`packages/session-executor`） | **語意**：opencode TUI 假設 server 是長期狀態持有者 |

---

## 6. 成本／風險估計（數字）

### 6.1 量體

| 側 | 元件 | 行數 / 檔數 |
|---|---|---|
| opencode | `packages/tui/src` | **27,044 行 / 152 檔** |
| opencode | `packages/tui/test` | 4,777 行 / 51 檔 |
| opencode | `packages/protocol/src` | 1,582 行（61 endpoint） |
| opencode | `packages/schema/src` | 3,387 行 / 64 檔（約 70 事件） |
| opencode | `packages/sdk/js/src/v2/gen`（生成） | 20,862 行 |
| opencode | `packages/server/src` | 1,682 行 |
| opencode | `packages/opencode/src`（CLI/server/routes） | 81,202 行 |
| opencode | `packages/core/src`（agent 本體） | ≥32,974 行 |
| IH | `packages/tui/src` | 26,062 行 / 97 檔 |
| IH | `packages/tui/test` | **27,249 行** / 111 檔（含 harness 57 檔） |
| IH | `packages/tui-core/src` | 2,755 行 |
| IH | `packages/tui/src/minimal` | 822 行 |
| IH | `apps/tui/src` | 917 行 |
| IH | `apps/cli/src` | 1,617 行 |
| IH | `packages/sdk/src` | 1,881 行（19 方法 / 2 通知） |

### 6.2 adapter 層估計

以 TUI 實際用到的面計算（55 條 SDK 路徑、19 個 store 事件、約 14 種 `event.on`）：

- **HTTP/SSE facade**：實作 opencode 形狀的 endpoint 子集（估計 30–40 條）＋ legacy 信封
  `{directory, project?, workspace?, payload}`。**推估 2,500–5,000 行。**
- **投影/映射層**：`SessionEvent` → `Message`/`Part` 模型（合成 messageID/partID、把 `assistant/chunk`
  累積成 `text` part、把 `tool/call`+`tool/result` 合成 `ToolPart` 的 4 態 status、補 delta 補丁）。
  **推估 1,500–3,000 行。**
- **缺失平面的最小補建**（權限/提問上 wire、provider/agent/MCP/LSP 狀態端點）：若要做到 TUI 的
  對話框不整批閹掉，需動 IH core + SDK wire（**additive 可行，但每個平面都是一個里程碑**）。
  **推估 2,000–4,000 行 + IH 側設計工作。**
- **執行期移植**：Bun（8–9 處 `Bun.*` API：`Bun.stringWidth`×4、`Bun.file`×2、`Bun.write`×2 等，
  `packages/tui/src/util/persistence.ts:5-25`、`component/prompt/*.tsx`）＋ `@opentui/solid/preload`
  ＋ Worker 語意。若堅持 Node/tsx（IH 現況），需逐一 shim；**推估 200–600 行 + 未知風險**。
- **合計：約 6,200–12,600 行新程式**，不含 IH core 的平面補建。

### 6.3 不能不改就搬的東西

1. **message/part id 與 delta 語意**：opencode TUI 的 store 以 id 為鍵做二分搜尋與就地更新
   （`packages/tui/src/context/sync.tsx:41-58, 321-431`）。IH 的事件流沒有這些 id → 一定要 adapter
   合成，或 fork TUI 改 reducer。
2. **權限/提問平面**：不補 wire 就只能 fork TUI 拔掉 `permission.tsx`(719) + `question.tsx`(515)
   ＋ `component/dialog-*` 的 provider/agent/mcp/workspace 對話框（合計數千行）。
3. **provider/agent/MCP/LSP/VCS/workspace/console**：同上，只能「補 server 面」或「拔 UI」二選一。
4. **Bun + 原生 OpenTUI**：無法在 Node 上原樣跑（見 6.2）。

### 6.4 會失去什麼

- **PTY harness**：`packages/tui/test/harness/`（57 檔，node-pty/ConPTY 真 PTY 驅動，
  `packages/tui/test/harness/runner.ts:1-20`）——opencode TUI 的 45 個測試跑在 Bun + `@opentui/solid/preload`
  下，兩套測試基礎設施不相容。
- **27,249 行 TUI 測試**與 `packages/tui-core/test`（2,855 行）的迴歸保護。
- **minimal 模式**（`packages/tui/src/minimal`，822 行 + inline engine）——opencode 的 `--mini` 是完全
  不同的實作（`packages/opencode/src/cli/cmd/tui.ts:152-175`）。
- **grok 1:1 parity 工作**：`docs/research/2026-09-06-m49-grok-tui-parity-inventory.md`、
  `docs/audit/2026-09-09-ih-m59-parity-handoff.md`、`docs/audit/2026-09-09-ih-m60-integration-handoff.md`
  （M59/M60 才剛落地）。
- **`BackendClient` 的雙 backend 契約**（embedded/remote 共用同一 mapper，`packages/tui/src/backend/remote.ts:73-84`）
  與 capability 協商紀律。
- **Windows ConPTY 實戰**（`packages/terminal/src/service.ts:1-10`、`terminal-win32.ts`）。

### 6.5 風險排序

1. **上游漂移（最高）**：opencode TUI 無版本化契約，改版即破壞；IH 必須跟著追（且它同時有
   legacy + v2 兩套面）。
2. **平面缺失（高）**：權限/提問/provider 不是「欄位對不上」，是「整個平面不存在」。
3. **執行期（中高）**：Bun + 原生 OpenTUI 二進位是新的發行/CI/Windows 風險面。
4. **語意（中）**：opencode server 是長期狀態持有者，IH 是單進程 stdio + 每 session JSONL。

---

## 7. 替代解讀與建議

### 7.1 使用者真正想要的是哪一種？

| 解讀 | 可行性 | 成本 | 說明 |
|---|---|---|---|
| **(a) 渲染引擎**（OpenTUI + SolidJS） | 技術上可行 | **L**（重寫 ~15.6k 行 view + 換 Bun/原生依賴） | 這不是「複製 TUI」，而是「換掉 IH 的 tui-core + 所有視圖」；IH 現有渲染是手寫 ANSI（`packages/tui-core/src` 2,755 行） |
| **(b) 元件庫** | 部分可行 | **M** | opencode 的 `packages/ui`（33,664 行）與 `packages/session-ui`（21,424 行）是 **web/DOM** 元件，**終端機不能用**；可參考的是 TUI 自己的 `src/ui/`（2,108 行） |
| **(c) keybinding / UX 模型** | **最可行** | **S–M** | `config/keybind.ts`(471) + `keymap.tsx`(290) + command palette + which-key + dialog 堆疊；不需換 runtime |
| **(d) 全量 TUI 替換** | **不可行（除非接受 fork + 第二個 backend）** | **XL** | 即 §5/§6 的 A 案 |

### 7.2 三個現實選項

**A. 全量移植（複製 `packages/tui` 到 `tui-beta-1` + 寫 opencode 形狀的 server facade）**
- 做法：保留 TUI 原始碼，注入 `fetch` + `events`（`app.tsx:142-152`），在 IH 前面加一層 HTTP/SSE
  adapter，映射到 `@i-harness/sdk`。
- 成本：6,200–12,600 行 adapter + IH 平面補建；執行期換 Bun + @opentui 原生。
- 換得：opencode 的完整 UX（dialog 生態、主題、插件槽位、diff viewer、command palette）。
- 失去：§6.4 全部。
- **不推薦。**

**B. 只換渲染層（用 OpenTUI/SolidJS 取代 `tui-core` + views，保留 IH 的 `BackendClient`/`TuiEvent`）**
- 做法：IH 的 backend 契約不動，重寫 present/views 層。
- 成本：**M–L**（12k+ 行視圖重寫），但**保留 27k 行測試的語意**（多數測試是 backend/事件層）。
- 風險：Bun + 原生依賴照樣進場；PTY harness 需重寫（它驅動的是 stdout 位元流，理論上可保留）。
- 中立。

**C. 選擇性吸收（不搬 TUI；把 opencode 的具體 UX 模式逐項回填 IH）**
- 做法：按優先序移植 `keybinding/which-key/command palette/dialog 堆疊/增量 markdown/viewport culling/
  16ms 批次策略`（IH 已有 16ms 批次，見 `packages/tui/src/backend/embedded.ts:431-447`）。
- 成本：每項 **S–M**（數百行），可切片、可回退、不動 runtime、不影響測試。
- 風險：最低（只借模式，不引入依賴）。
- **推薦。**

### 7.3 選擇

**選 C。若「渲染品質」是真正痛點，先做 B 的可行性 spike（只換 renderer、保留 BackendClient），
但不要做 A。**

理由：opencode TUI 的價值在**產品完成度**（對話框生態、插件槽位、主題、keymap），這些是**模式**，
可以學；它的成本在**第二套 server 契約 + Bun/原生執行期 + 拋棄 IH 已驗證的測試資產**，這些是**負債**。
IH 的邊界（19 方法 / 2 通知 / capability 協商 / 事件日誌）比 opencode 的更小、更嚴謹，把 opencode 的
TUI 搬過來等於用一個更大的契約覆蓋一個更小的契約——方向是反的。

---

## 附錄：一句話問答

- **是純前端嗎？** 是。27k 行裡對 core 的依賴只有 10 檔、5 個 util 入口。
- **邊界可插拔嗎？** TUI 側可（`fetch` + `EventSource` 注入）；server 側不可（無版本協商，生成 SDK 綁死）。
- **要 fork 嗎？** TUI 本體不用；但若不補 IH 的權限/提問/provider 平面，就必須 fork TUI 拔 UI。
- **最大單一風險？** 權限/提問平面在 IH wire 上不存在（`packages/interaction/src/index.ts:5-19, 32-44`
  只在 in-process），opencode 的 permission/question UI 在 `--attach` 下無事可做。
