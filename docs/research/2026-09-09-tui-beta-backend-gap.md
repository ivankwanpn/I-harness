# tui-beta（opencode 1.18.30 TUI）接 IH backend：能力矩陣與缺口

日期：2026-09-09 · 方式：唯讀走查（未執行、未安裝、未建置、未連網）
前作：`docs/research/2026-09-09-opencode-tui-graft-feasibility.md`（以下稱「前次 spike」）

**路徑慣例**
- 我們的側：`D:\I-harness-main\` 之下，寫成 `packages/...`、`apps/...`。
- 前端的側：`D:\I-harness-main\.worktrees\tui-beta-1\tui-beta\`，寫成 `tui-beta/src/...`。
- opencode 上游原始碼（本 TUI 期望的形狀出處，非我們側）：`D:\agent-complete\opencode-1.18.30\`，寫成 `oc/packages/...`。

**立場**：opencode 不是權威。凡是它的期望只是它自己設計的產物（不是真實使用者需求），本文明說，並提出我們該偏好的形狀。推論處一律標「（推論）」。

---

## 1. 一頁結論

**1. 能不能驅動？——能，但「驅動」不等於「能用」。**
tui-beta 的注入縫是真的：`TuiInput` 接受外部 `fetch` 與 `events: EventSource`（`tui-beta/src/app.tsx:142-152`），`SDKProvider` 把它們原樣傳進 client（`tui-beta/src/context/sdk.tsx:24-31, 119-132`）。所以**不需要起 HTTP server**：寫一個 `fetch` shim（把 opencode 的 URL 路徑路由到 `HarnessClient.request`）＋一個 `EventSource` wrapper（把 `session/event` 通知轉成 `GlobalEvent` 信封）就能讓它開機。**（推論）這個 shim 本身約 1,000–2,000 行。**

**2. 但它開機會死。** bootstrap 有 6 個 `throwOnError: true` 的請求（`config.providers`、`provider.list`、`app.agents`、`config.get`、`path.get`、`project.current`，`tui-beta/src/context/sync.tsx:458-478`、`tui-beta/src/context/project.tsx:31-46`），任何一個失敗就走 `exit(e)`（`sync.tsx:540-551`）——不是降級，是整個 TUI 退出。IH 的 wire 上這 6 條**一條都沒有**（`packages/sdk/src/server.ts:264-681` 的 method 清單）。

**3. 最大的結構性錯配：IH 的 wire 是「事件日誌」，tui-beta 的 store 是「message/part 投影」。**
tui-beta 的 `createStore` 以 **id 為鍵**做二分搜尋與就地更新（`tui-beta/src/context/sync.tsx:41-58, 321-431`），串流靠 `message.part.delta{field, delta}` 逐欄位追加（`sync.tsx:398-415`）。IH 的 `session/event` 送的是原始 `SessionEvent`（`packages/sdk/src/server.ts:171-177`），**沒有 message id、沒有 part id、沒有 delta**（`packages/core-session/src/index.ts:5-132` 的 union），而且 `assistant/chunk` 連生產者都沒有——core-agent 只 append `assistant/message`（`packages/tui/src/backend/embedded.ts:18-23` 明載）。這不是欄位對不上，是**一個投影平面不存在**。

**4. 第二大的錯配是 permission/question：IH 的 wire 上完全沒有這兩個平面。**
它們只存在於 in-process 的 plugin seam：`ApprovalRequest{name,reason,command?,argv?,dangerClass?,pathSummary?}` → `{approved: boolean}`（`packages/interaction/src/index.ts:5-28`），經 `service.onAssembly` 掛上（`packages/tui/src/backend/approval.ts:200-210`），而且**只有 embedded 模式有**（`apps/tui/src/index.ts:856` 的註解：remote/--attach 路徑沒有 local assembly）。tui-beta 的權限 UI 有 719 行、提問 UI 有 515 行，期望的是 request/reply round-trip、`once|always|reject`、多題多選（`tui-beta/src/routes/session/permission.tsx:111-441`、`question.tsx:14-515`）。IH 的布林 seam 連「always」都表達不了。

**5. 修正前次 spike 的一處事實。** 前次 spike 說 tui-beta 用 `permission.v2.asked` / `question.v2.*`。**這對 1.18.30 的 TUI 不成立**：實際的 reducer 與 UI 走的是 **legacy v1** 事件與形狀——`permission.asked` / `permission.replied`（`tui-beta/src/context/sync.tsx:181-225`）、`question.asked/replied/rejected`（`sync.tsx:227-263`）、`PermissionRequest{id,sessionID,permission,patterns,metadata,always,tool}`（`oc/packages/schema/src/v1/permission.ts:32-40`）、`QuestionRequest{id,sessionID,questions[],tool?}`（`oc/packages/schema/src/v1/question.ts:24-46`）。v2 平面只出現在沒被主流程消費的 `data.tsx`（唯一消費者 `autocomplete.tsx:90`，只用到 `reference` 與 `fs.find`）。**這對 adapter 是好事**：要實作的形狀比前次 spike 估的簡單。

**6. 建議策略：C（選擇性吸收），但把「若真要做這個前端」的最小門檻講清楚。**
真正的岔路不是「要不要搬 TUI」，而是「要不要在 IH core 補出 **permission/question wire 平面** 與 **message/part 投影平面**」。這兩件事**獨立於這個前端也對我們有益**（第 3 節詳述），值得做；但做完之後**不需要**連帶接受 opencode 的 provider catalog / workspace / console / 雙 v1+v2 平面。若產品決定「這個 TUI 就是我們的 TUI」，那 A 案（adapter）可行，前提是先完成上述兩個平面，並接受 Bun + @opentui 原生執行期與契約漂移稅。

---

## 2. 能力矩陣

缺口種類：**shape**（形狀對不上，可用 adapter 轉）／**missing plane**（整個平面不存在，要補 wire）／**different owner**（能力存在但屬於別的進程）／**no equivalent**（IH 沒有這個概念）。

| # | 能力 | tui-beta 期望（path:line） | IH 現況（path:line） | 缺口種類 | adapter 要做什麼 |
|---|---|---|---|---|---|
| 1 | 傳輸 | HTTP `fetch` + SSE `/global/event`，`GlobalEvent{directory,project?,workspace?,payload}` 信封（`sdk.tsx:24-31, 82-117`；`event.ts:9-20` 拆信封） | NDJSON JSON-RPC 2.0 over stdio，19 方法 / 2 通知（`packages/sdk/src/protocol.ts:25-39, 555-591`；`packages/sdk/src/client.ts:109-127`） | shape | 用 `TuiInput.fetch` 注入 shim：URL→`HarnessClient.request`；用 `TuiInput.events` 把 `session/event` 通知包成 `GlobalEvent`。**不需要真的 HTTP/SSE**（推論） |
| 2 | session 列表 | `session.list({start,limit,search,roots,scope,path})` → `Session[]`（含 `title/time.updated/parentID/directory/workspaceID/revert/share`）（`sync.tsx:170-174`；`dialog-session-list.tsx:24-33, 64-73`） | `session/list {}` → `{sessions:[{id,title?,updatedAt?,turnCount?,contextUsed?,contextTotal?}], listingUnavailable?}`（`protocol.ts:263-278`；`server.ts:488-504`） | shape | 補 `time:{created,updated}`、`parentID`、`directory`；丟掉 server 端沒有的 `search/scope/path`（改 client 過濾，或補 server 查詢——IH 已有 `session-query` SQLite 索引，`apps/cli/src/index.ts:19,210-213`） |
| 3 | session 單筆 | `session.get({sessionID})`（`sync.tsx:602`；`session/index.tsx:290`） | 無此方法；只有 `session/list` 與 `session/history` | missing plane（小） | 由 `session/list` 單列 + `session/status` 合成 |
| 4 | 歷史投影 | `session.messages({sessionID,limit})` → `[{info: Message, parts: Part[]}]`（`sync.tsx:601-654`） | `session/history {sessionId,afterSeq?,limit?}` → `{events: SessionEvent[], nextSeq}`（`protocol.ts:61-69`；`server.ts:455-487`） | missing plane + shape | **核心工作**：事件日誌 → Message/Part 投影器（見第 3 節） |
| 5 | 串流 | `message.updated` / `message.part.updated` / `message.part.delta{messageID,partID,field,delta}` / `message.removed` / `message.part.removed`（`sync.tsx:321-431`；`oc/packages/schema/src/v1/session.ts:632-641`） | `session/event {sessionId,event}`，event 為原始 `SessionEvent`（`server.ts:171-177`；`protocol.ts:32-35`）。**無 id、無 delta**（`core-session/src/index.ts:5-132`） | missing plane + shape | 合成穩定 id（建議 `msg-<turnIndex>`、`prt-<seq>`）；`assistant/chunk` 累積成 `text` part 並發 `message.part.delta`；`tool/call`+`tool/result` 合成 4 態 ToolPart |
| 6 | 工具渲染 | `ToolPart{callID,tool,state:{pending\|running\|completed\|error},input,output,title,metadata,time}`（`oc/packages/schema/src/v1/session.ts:259-320`）；14 個專屬 renderer + generic（`session/index.tsx:1709-1789, 2626-2645`） | `TuiEvent` tool 帶 `{callId,name,kind,status,args,result,progress}`（`contracts.ts:43`）；`tool/result` 的結構化 payload；fs 變更→unified diff 字串（`embedded.ts:136-154`） | shape | 映射 status→4 態；`args`→`state.input`；result→`state.output`（字串）＋`metadata` bag（`diff`/`diagnostics`/`output`/`count`/`matches`/`loaded`/`sessionId`…，見 `session/index.tsx:2051,2114,2125,2143,2157,2191,2210,2222,2348,2542,2246`） |
| 7 | 權限 | `permission.asked` 事件 + `PermissionRequest{id,sessionID,permission,patterns,metadata,always,tool}`；`permission.reply{requestID,reply:once\|always\|reject,message?}`（`sync.tsx:181-225`；`permission.tsx:168-186, 418-431`；`oc/.../v1/permission.ts:32-40`）；auto 模式自動回 once（`sync.tsx:198-206`） | **wire 上沒有**。只有 in-process 布林 seam（`interaction/src/index.ts:5-28`），經 `onAssembly` 掛載（`packages/tui/src/backend/approval.ts:200-232`），且只在 embedded 路徑（`apps/tui/src/index.ts:856`） | **missing plane** | 必須在 IH 補 wire（新方法 + 新通知）或 fork 掉 UI；且 `always` 的 pattern 語意現有 seam 表達不了 |
| 8 | 提問 | `question.asked` + `QuestionRequest{id,sessionID,questions:[{question,header,options:[{label,description}],multiple?,custom?}],tool?}`；`question.reply{answers:string[][]}` / `question.reject`（`sync.tsx:227-263`；`question.tsx:48-78`；`oc/.../v1/question.ts:24-46`） | `UserQuestion{id,prompt,options?:string[]}` → `Promise<string>`（`interaction/src/index.ts:32-56`）；單題、單選、不可 reject | **missing plane + shape 更弱** | 同上；且多題/多選/自訂在 seam 上是有損映射 |
| 9 | provider / model / agent | bootstrap 阻斷式讀 `config.providers`、`provider.list`、`provider.auth`、`app.agents`、`config.get`（`sync.tsx:458-478, 533`）；OAuth `provider.oauth.*`、`auth.set`、`instance.dispose`（`dialog-provider.tsx:185,266,326,397,281`）；model picker 讀 `sync.data.provider`（`dialog-model.tsx:32,62,133`）；agent picker 讀 `sync.data.agent`（`dialog-agent.tsx:12-14`；`local.tsx:78,224-237`） | wire 上只有 `session/model/{state,set}`（`protocol.ts:139-147`；`server.ts:333-370`）。provider runtime 在 CLI 主機（`apps/cli/src/index.ts:74-85,367`；`apps/tui/src/index.ts` 的 ProviderController） | **different owner + missing plane** | 需要 read-only 的 `config/providers` + `app/agents` + `config.get`（否則開機即死）；憑證/OAuth 留在主機 |
| 10 | MCP / LSP / formatter | `mcp.status/connect/disconnect`、`lsp.status`、`formatter.status`（`sync.tsx:524-529`；`local.tsx:514-517`；`dialog-mcp.tsx:59`；`dialog-status.tsx:15-99`） | 套件存在（`packages/mcp-client`、`packages/lsp`）且 assembly 會掛載（`packages/session-executor/src/assembly.ts:43-52, 503-506`），但**wire 上沒有任何事件或方法** | missing plane | 補 read-only 狀態端點；connect/disconnect 留在主機 |
| 11 | VCS / workspace / console | `vcs.get`、`experimental.workspace.*`、`experimental.console.*`、`project.*`、`path.get`（`sync.tsx:534`；`project.tsx:31-58`；`dialog-workspace-*.tsx`） | 單一 workspace per 進程（`apps/cli/src/index.ts:368`；`assembly.ts:89`）；無 wire | **different owner + no equivalent** | 建議不移植這些對話框（第 4 節） |
| 12 | diff | `session.diff` REST + `session.diff` 事件（`sync.tsx:269-271, 605`）；revert 的 `session.revert.diff`（`session/index.tsx:1130-1152`） | 無 session diff 平面；只有 tool result 內的 `TextDiff`（`embedded.ts:136-154`）與 rewind 的 file ops（`protocol.ts:394-441`） | missing plane | 由 tool/result 的 changes 累積出 per-session diff；或先不顯示 sidebar files |
| 13 | todo | `session.todo` REST + `todo.updated` 事件；item 有 `id/content/status/priority`（`sync.tsx:265-267, 604`；`plugin/adapters.tsx:131-132`） | `todo/write` 事件，item 只有 `{content,status}`、無 id（`core-session/src/index.ts:57, 139-142`）；bridge 合成 `${seq}-${i}`（`embedded.ts:263-276`） | shape | 合成 id；補 `session/todo` 查詢（可由 history 掃最後一個 `todo/write` 得到） |
| 14 | command | `command.list`（`sync.tsx:523`）＋ `session.command` 執行（`prompt/index.tsx:1083`） | `command/run`/`command/done` 事件（`core-session/src/index.ts:117-118`）、registry（`interaction/src/index.ts:64-107, 167-192`），但無 wire | missing plane | 補 `command/list` + `session/command`（或把命令降級成純 client 端） |
| 15 | status / idle / retry | `session.status` REST 回 **map**`{[sessionID]: SessionStatus}`（`sync.tsx:530-532`）；事件 `SessionStatus{idle\|busy\|retry{attempt,message,action,next}}`（`sync.tsx:316-319`；`oc/.../session-status-event.ts:11-31`）；retry 驅動 upsell 對話框與 subagent 重試行（`session/index.tsx:357-375, 2249-2253`） | 通知 `session/status{sessionId,status:"queued"\|"idle"\|"error"}`（`server.ts:179-181, 654-662`）；請求 `session/status{sessionId}` → `{running,queued}`（`server.ts:371-378`） | shape | `queued`→`busy`、`idle`→`idle`、`error`→toast；**retry 語意沒有**（`guard-retry` 只重試工具呼叫，不發 session 事件，`packages/guard-retry/src/index.ts:62-107`） |
| 16 | session 生命週期 | `create/fork/delete/update/move/revert/unrevert/abort/summarize/shell/share/unshare`（`prompt/index.tsx:1000,1061,415`；`dialog-session-rename.tsx:22`；`dialog-session-list.tsx:307`；`session/index.tsx:579,619,622,660,666`） | `session/create`、`session/fork`、`session/cancel`、`session/rewind/*`（`protocol.ts:101-147`；`server.ts:305-332, 432-454, 553-628`） | missing plane | delete/update/move/summarize/shell/share 沒有；rewind ≠ revert（turn-index vs message-id） |
| 17 | 子 session 導覽 | `session.parentID`、`ToolPart.metadata.sessionId`、子 session 出現在列表（`session/index.tsx:206-211, 2222-2227, 430-463`） | `SessionHeader.parentSession` 存在（`core-session/src/index.ts:169-174`），但 `session/list` 不回傳它（`protocol.ts:263-270`） | shape | 列表列補 `parentID`（server 端讀 meta） |
| 18 | 附件 / file part | prompt 帶 `parts:[{type:"text"},{type:"file"}]`（`prompt/index.tsx:1103-1108`）；訊息渲染 file part（`session/index.tsx:1384, 1420-1435`） | `session/prompt {sessionId,prompt:string}` 只有字串（`protocol.ts:28`；`server.ts:629-637`）；`user/message` 有 `images?: ImageInput[]`（`core-session/src/index.ts:12`） | shape | 圖片可映射；非圖片檔案附件在 wire 上不存在 |
| 19 | 檔案搜尋 / @-提及 | `v2.fs.find`、`find.files`、`v2.reference.list`（`autocomplete.tsx:324`；`dialog-tag.tsx:20`；`data.tsx:533`） | 無 wire（`packages/fs-search` 存在，但只在 assembly 內） | missing plane | 可先停用 @-提及，或補 `fs/find` 方法 |
| 20 | 分享 / 匯出 | `session.share/unshare`（`session/index.tsx:492-507, 596-606`）；export 是 client 端 `formatTranscript`（`:953-1019`） | 無 share；export 邏輯只要 Message/Part 投影成立就能純 client 跑 | no equivalent（share）／shape（export） | 拔掉 share；export 靠投影器即可 |
| 21 | TUI 指令 / 升級 | server 推 `tui.command.execute`、`tui.toast.show`、`tui.session.select`（`app.tsx:985-1006`）；`installation.update-available` + `global.upgrade`（`app.tsx:1031-1077`） | 無 | no equivalent | 不移植（產品產物） |
| 22 | plugin runtime / slots | client 端，12 槽（`app.tsx:1125-1127`；`plugin/runtime`） | 不涉及 backend | — | 無需 adapter |

**小結**：22 列中，**5 列是 missing plane**（權限、提問、provider/agent 讀取、MCP/LSP 狀態、command、diff、todo REST —— 嚴格說 7 條），**8 列是 shape**，**3 列 different owner**，**3 列 no equivalent**。真正擋住「能用」的是 4 條：**#7 權限、#8 提問、#4/#5 投影與串流、#9 provider/agent 讀取**。

---

## 3. 三個最難的錯配

### 3.1 權限 / 提問平面：不是欄位，是「平面不存在」

**為什麼難**
- IH 的權限是 **in-process 的布林 callback**：`ApprovalRequest` → `{approved: boolean}`（`packages/interaction/src/index.ts:5-28`），掛在 assembly 的 plugin ctx 上（`packages/tui/src/backend/approval.ts:200-232`）。它不是 wire 物件，沒有 request id、沒有 pending 狀態、沒有 reply 通道。
- tui-beta 期望的是 **非同步 request/reply**：server 推 `permission.asked`（`sync.tsx:196-225`），client 呼叫 `permission.reply({requestID, reply:"once"|"always"|"reject", message?})`（`permission.tsx:168-186, 418-431`），server 推 `permission.replied` 讓所有 client 收斂（`sync.tsx:181-194`）。
- 語意落差比形狀落差大：UI 的「Always allow」列出 `always` patterns 並說「until OpenCode is restarted」（`permission.tsx:143-161`），auto 模式自動回 `once`（`sync.tsx:198-206`）。IH 的 seam 只有一個 boolean，**「always」在語意上不存在**——我們自己的 TUI 已經在註解裡承認這是假的：`approval.ts:82-105` 明寫 scopes 是「suggested labels only」，`answerApproval` 的 `scope`/`feedback` 是「NO seam to carry them today」。
- 提問同理，而且更弱：`UserQuestion{id,prompt,options?}` → `Promise<string>`（`interaction/src/index.ts:32-56`）是**單題單選單一字串**；tui-beta 要 `string[][]`（多題 × 多選）＋可 reject（`question.tsx:48-78`）。

**我們要改什麼（IH 側）**
1. **protocol.ts 加方法與通知**（additive-only，`PROTOCOL_VERSION` 維持 2，符合 `protocol.ts:46-48` 的政策）：`session/permission/asked`、`session/permission/reply`、`session/permission/replied`；`session/question/asked`、`session/question/reply`、`session/question/reject`。
2. **server.ts 加 host seam**：`permissionAnswerer` / `questionProvider` 選項（與 `rewindFactory` 同款：absent → 誠實失敗或 auto-approve），並在 `service.onAssembly` 時把 wire 版 answerer 掛進 ctx（`server.ts:171-177` 已有同構的 assembly 訂閱可照抄）。
3. **interaction 的 seam 升級**：`ApprovalDecision` 從 `{approved}` 改成 `{verdict:"once"|"always"|"reject", scope?:string, feedback?:string}`（保留 `{approved}` 的相容層）。這會動到 `core-tools` 的檢查點（`interaction/src/index.ts:21-28` 的 normalize 註解就是為此存在），但**改法是把 normalize 從 boolean 換成 verdict**，不是重寫。
4. **question 的 seam 升級**：`UserQuestion` 加 `header`、`multiple`、`custom`，回傳 `string[][]`。現有 `ask_user_input` 工具（`interaction/src/index.ts:121-146`）與我們的 TUI（`packages/tui/src/views/question.ts`，236 行）都能受惠。

**這對我們自己是不是好事？——是，而且與這個前端無關。**
- 我們的 TUI 目前把「always/never/once/reject」壓成一個 boolean（`approval.ts:38-52` 的 `DECISION_MAP`），並在註解裡承認 scope 沒有去處。這是**真實的功能缺口**，不是移植需求。
- `--attach` 模式下權限 UI 根本不存在（`apps/tui/src/index.ts:856`），因為 wire 上沒有平面；這對「遠端 attach 一個 session」是真缺陷。
- 唯一要小心的是 **always 的持久化語意**：opencode 只做到「重啟前有效」（`permission.tsx:143-161`）。我們若要 `always`，應該讓它持久化到 settings（`packages/settings` 已存在），而不是照抄 ephemeral。

### 3.2 message/part 投影 + 逐欄位 delta：store 的鍵是 id，IH 沒有 id

**為什麼難**
- tui-beta 的 store 以 id 為鍵：`message[sessionID]` 依 `time.created + id` 排序並二分搜尋（`sync.tsx:54-58, 328-339`）；`part[messageID]` 依 `part.id` 二分搜尋（`sync.tsx:383-394`）。`message.part.delta` 直接把 `field` 當 `keyof part` 就地 `+=`（`sync.tsx:398-415`）。
- IH 的 `SessionEvent` 沒有 message/part 概念（`core-session/src/index.ts:5-132`）：`assistant/chunk` 是「整段文字」而非 delta，而且 core-agent 不 append 它（`embedded.ts:18-23`）；`tool/call` 與 `tool/result` 是兩個獨立事件，靠 `callId` 在 UI 端合併（`embedded.ts:207-246`）；`user/message` 沒有 id。
- 還有**順序與重放**：IH 的 seq 是 append 順序（`core-session` 的 `append` 蓋章），而 tui-beta 假設 message 以時間排序。投影器必須在 live 與 replay 兩條路徑產生**一致**的輸出（IH 自己在 `embedded.ts:71-80, 692-706` 就是用「同一個純 mapper 走兩次」達成這件事）。

**我們要改什麼（IH 側）**
- **最小方案（adapter 內）**：投影器放 adapter。id 用確定性合成：`messageID = msg-<turnIndex>-<user|assistant>`、`partID = prt-<seq>`。因為日誌 append-only、seq 單調，同一份日誌重放必得同一組 id（推論：這滿足了 tui-beta 的二分搜尋前提，只要投影器保證輸出的 `time.created` 單調不減）。
- **較大方案（IH 側）**：在 core-session 加正式的 `Message`/`Part` 投影（`deriveMessages` 已存在，但輸出是 `LLMMessage`，`core-session/src/index.ts:375-379`，不是 UI 形狀），並在 wire 加 `session/messages`。這會讓「歷史」變成契約的一部分，而不只是 client 的私事。
- **delta 不要照抄**：`message.part.delta` 的 `field: String` 是無型別的逃生口（`sync.tsx:409-411` 直接 cast）。我們該偏好的形狀是**型別化 delta**（`{kind:"text", partID, delta}`）或**整塊 part 更新**（IH 現況）。理由：`field` 這個洞讓 server 能改任何欄位，client 只能祈禱。

**這對我們自己是不是好事？——是（部分）。**
- 我們的 TUI 目前自己重做了一次投影（`packages/tui/src/scrollback` + `backend/embedded.ts:181-333` 的 mapper），所以「投影」這件事**已經在我們家存在**，只是綁在 TUI 的 scrollback 引擎裡，別的 client（web-host）看不到。
- 把它提升成一個共用、可測、確定性的投影層，對 web-host / ACP / 任何新前端都是淨收益。但**先做成 adapter 私有層**是更安全的順序：投影的形狀（哪些 part 型別、compaction 怎麼顯示、rewind 怎麼切）我們自己還沒定案，過早寫進 wire 會鎖死。

### 3.3 伺服器擁有 provider / agent / MCP / LSP / config 平面

**為什麼難**
- tui-beta 開機就把這幾條當**阻斷式依賴**：`config.providers`、`provider.list`、`app.agents`、`config.get` 都是 `throwOnError: true`（`sync.tsx:458-478`），加上 `path.get` / `project.current`（`project.tsx:31-46`），失敗即 `exit(e)`（`sync.tsx:540-551`）。
- 這些平面在 IH 是**主機側**：provider runtime 由 CLI 進程持有（`apps/cli/src/index.ts:367` 的 `loadProviderRuntime()`、`:74-85` 的 `modelBindingFor`），憑證在 `@i-harness/credentials`（推論：`packages/credentials` 的存在與 `apps/cli/src/provider-runtime.ts` 的角色），我們的 TUI 直接持有 ProviderController（`apps/tui/src/index.ts`）。server 只知道「這個 session 現在用哪個 model」（`session/model/state`，`server.ts:333-346`）。
- 這是**擁有權不同**，不是欄位不同：tui-beta 的 model picker 期待的是「整個 catalog + 每個 provider 的連線狀態 + OAuth 流程」（`dialog-model.tsx:32,62,133`；`dialog-provider.tsx:185,266,326,397`），IH 的 server 沒有任何一條能回答。

**我們要改什麼（IH 側）**
- **只補 read-only 的「這個 session 能用什麼」**：`session/model/catalog`（或 `provider/list` 的縮減版）回傳 `{providers:[{id,name,models:[{id,name}]}], default?}`，以及 `app/agents` 回傳 `{name,description,mode,native?}`。**不要**把 OAuth、憑證寫入、provider 增刪放到 server（那是主機職責，也是安全邊界）。
- 讓 tui-beta 的 provider connect / console-org / workspace 對話框**不存在**（隱藏或 fork 掉）。它們是 opencode 產品的產物，不是通用需求。

**這對我們自己是不是好事？——有條件的是。**
- 對 `--attach`（遠端 session）來說，**必須**有 read-only 的 model/agent 讀取平面，否則 attach 的 client 連「現在用哪個模型、有哪些 agent 可切」都不知道；目前只能靠 `modelLabel` 這種單一字串（`contracts.ts:247-249` 的註解自己承認「the wire cannot carry it」）。
- 但**不要**把 catalog 當成 server 的責任去維護。IH 的姿態應該是：**主機解析、server 只回報「本 session 已解析的結果」**（`session/model/state` 已經是這個形狀），再加上「主機願意公開的候選清單」。清單是唯讀的、可選的、缺席即誠實留白（與 `session/list` 的 `listingUnavailable` 同款紀律，`protocol.ts:274-278`）。

---

## 4. 我們不該照抄的地方

| # | opencode 的期望 | 為什麼是它的產物 | 我們該偏好的形狀 |
|---|---|---|---|
| 1 | `message.part.delta{field: String, delta}`（`oc/.../v1/session.ts:632-641`；`sync.tsx:398-415`） | 無型別欄位補丁；client 用 `field as keyof part` 硬轉。這是它為了避免送整塊 part 的效能權衡，不是使用者需求 | 型別化 delta（`{kind:"text"|"reasoning", partID, delta}`）或整塊 part 更新；IH 現行的事件粒度更誠實 |
| 2 | v1 與 v2 兩套平面並存（`permission.asked` vs `permission.v2.asked`；`session.message` 的 `parts` vs `content`；`sync.tsx` vs `data.tsx`） | 遷移中的雙軌，不是設計。`data.tsx` 的 v2 平面唯一消費者只用到 `reference`/`fs.find`（`autocomplete.tsx:90,280,324`），其餘是死重 | 一套平面；新增能力走 additive 欄位，不開第二條命名空間 |
| 3 | `session.list` 的 `{start, limit, search, roots, scope, path}` 由 client 傳、再 client 端 `.filter(title.includes)` 二次過濾（`sync.tsx:170-174`；`dialog-session-list.tsx:24-33, 80-95`） | 把查詢責任丟給 client，因為它的 server 是無狀態的 | server 端查詢 + 明確分頁；IH 已有 `session-query`（`apps/cli/src/index.ts:19,210-213`），該用它，而不是把整個列表拉到 client |
| 4 | 用 `id.localeCompare` 排序 session（`sync.tsx:173`）、用 `time.created + id` 當排序鍵（`sync.tsx:54-58`） | opencode 的 `SessionID` 是**時間編碼 + 反轉**的（`oc/.../session-id.ts:4-11` 用 `descending()`；`oc/.../identifier.ts:14-29` 把 timestamp 取 `~current`），所以純字串排序剛好等於「新的在前」。IH 的 id 是隨機/`sess-<uuid>`（`embedded.ts:930, 997`），照抄只會得到亂序 | 以 `updatedAt`（或 server 端明確排序）為準；把排序責任放 server |
| 5 | 「Always allow」只到重啟為止（`permission.tsx:143-161`） | 它的 permission 規則活在進程記憶體 | 我們若要 `always`，就持久化到 settings 並可撤銷；否則就不要在 UI 上承諾「always」 |
| 6 | provider catalog / console-org / workspace / project-copy 管理面（`dialog-provider.tsx`、`dialog-console-org.tsx`、`dialog-workspace-*.tsx`、`project.tsx`、`prompt/move.tsx`） | opencode 雲端/多專案/多 workspace 產品的產物；IH 是 local-first 單 workspace | 全部不移植；`--attach` 只需要「本 session 的模型與 agent」 |
| 7 | free-tier upsell 對話框（`session/index.tsx:87-113, 357-375`）、`installation.update-available` + `global.upgrade`（`app.tsx:1031-1077`） | 純產品行為 | 不移植 |
| 8 | client 端只保留最後 100 條 message 並丟掉其餘 part（`sync.tsx:340-358, 625-627`） | 任意上限，為了記憶體 | 由 server 分頁 + client 視窗化；上限應該是設定，不是硬編碼 |
| 9 | 權限 UI 依賴 `tool.messageID`/`tool.callID` 反查 `part.state.input` 來顯示內容（`permission.tsx:122-132`） | 因為它的權限事件本身不帶參數，得繞回 part store | 我們的權限 wire 事件應該**自帶**足夠的顯示資訊（command/path/diff），別讓 UI 反查 |
| 10 | `session.revert`（message-id 為界）與 IH 的 `session/rewind`（turn-index 為界）語意不同（`session/index.tsx:617-671` vs `protocol.ts:101-109`） | 兩邊的歷史模型不同（message/part vs 事件日誌） | 不要把 rewind 硬套成 revert；若要做 undo/redo，先定義「以 turn 為單位」的 UI 語意（IH 的 rewind 已經是對的切法） |

---

## 5. 三種適配策略

### A. Adapter / shim：對這個前端講 opencode 的形狀

**做法**：保留 tui-beta 原始碼，注入 `fetch` + `events`（`app.tsx:142-152`），在 IH 的 `HarnessClient` 前面寫一層「opencode 形狀」的 facade。

**成本（推論，依本報告的實測面）**
| 區塊 | 估計 | 依據 |
|---|---|---|
| `fetch` shim + `EventSource` wrapper | 1,000–2,000 行 | 實際打到 ~55 條 SDK 路徑（`grep sdk.client.*`，24 檔），扣掉可隱藏的管理面後約 30–40 條 |
| 事件投影器（SessionEvent → Message/Part + delta） | 1,500–3,000 行 | `sync.tsx` 19 個 case、`contracts.ts:31-54` 的 18 種 TuiEvent、`embedded.ts:181-333` 的 mapper 可重用 |
| IH 側平面補建（權限/提問/provider 讀取/command/todo/diff 查詢） | 2,000–4,000 行 + 設計工作 | 第 2 節的 7 條 missing plane |
| 執行期（Bun + `@opentui/solid/preload` + 原生二進位） | 200–600 行 shim + 未知風險 | `tui-beta/package.json:50-67`、`tui-beta/bunfig.toml:1-2` |
| **合計** | **約 4,700–9,600 行新程式** | 不含 IH core 的平面設計 |

**換得**：完整 UX（對話框生態、主題、keymap、command palette、diff viewer、插件槽）。
**代價**：契約漂移稅（無版本協商、型別編譯進去）、Bun/原生執行期、放棄 IH 的 27,249 行 TUI 測試與 PTY harness、每次要藏一個我們沒有的能力就得 fork 前端。
**何時合理**：產品決定「這個 TUI 就是我們的 TUI」，且接受它是**第二個前端**（不是取代 IH 現有 TUI）。

### B. 把這個前端的 UX 移植進我們自己的 renderer / backend 契約

**做法**：IH 的 `BackendClient`/`TuiEvent` 不動，重寫視圖層（把 `tui-beta/src` 的 27k 行當設計參考）。
**成本**：**L**——`tui-beta/src/component` 7,085 行、`routes` 4,660 行、`feature-plugins` 3,471 行、`ui` 1,719 行，多數綁 `@opentui` 原語；等於換掉 `packages/tui/src` 的視圖層（現有 `views/` 7,210 行）並可能連 renderer 一起換。
**換得**：不引入新契約、不動 runtime、保住 27k 行測試語意。
**代價**：最大的一次性投入，且「重寫出來的 UX」不一定等於原版。
**評**：若痛點是「渲染品質」，這條值得先做**只換 renderer** 的 spike（保留 `BackendClient`），但不要一次全換。

### C. 選擇性吸收（推薦）

**做法**：不搬 TUI 本體，把具體的 UX 模式與**我們真正缺的平面**逐項回填。優先序：

1. **權限 / 提問的 wire 平面 + seam 升級**（第 3.1 節）。獨立價值最高：解掉 `--attach` 無權限 UI、`always` 無法表達、我們 TUI 的 `DECISION_MAP` 假 scope。
2. **確定性的 message/part 投影層**（第 3.2 節），先做成 TUI 內的共用模組（不進 wire），形狀定案後再考慮上 wire。
3. **read-only 的 model/agent 讀取平面**（第 3.3 節），服務 `--attach` 與未來的 web client。
4. **UX 模式**：keybinding/which-key/command palette/dialog 堆疊（`tui-beta/src/config/keybind.ts`、`keymap.tsx`、`ui/dialog.tsx`）、權限/提問的呈現（`permission.tsx`、`question.tsx`）、工具 renderer 的資訊層級（`session/index.tsx:1709-2582`）、主題系統（`src/theme`）。每項 S–M（數百行）。

**成本**：每項 **S–M**；第 1–3 項合計約 **2,500–4,500 行 + 設計**，但**每一項都獨立可交付、可回退、不動 runtime、不影響現有測試**。
**風險**：最低（借模式、補自家平面，不引入依賴、不繼承契約）。

### 我的選擇

**選 C。** 但把話說清楚：**如果「這個 TUI 就是我們要的 TUI」是已定的產品決策**，那 A 是唯一路徑，而它的**第一個里程碑不能是 adapter，必須是 3.1 與 3.2 的 IH 側平面**——因為在 permission/question 上 wire 之前，這個前端的核心互動（權限提示、提問、串流文字）是**不能用**的，不是「少了幾個對話框」；而 6 條阻斷式 bootstrap 呼叫會讓它連開機都開不起來（`sync.tsx:540-551`）。B 是三者中最不划算的：投入最大，卻兩邊的好處都拿不到。

---

## 6. 不確定處

1. **未執行任何程式**。本報告全部是靜態走查。所有「行數估計」都是推論，不是實測。tui-beta 沒有 `node_modules`，無法 typecheck 或跑測試。
2. **未驗證 `fetch` shim 的可行性**。`createOpencodeClient`（`tui-beta/src/context/sdk.tsx:24-31`）來自 `@opencode-ai/sdk/v2`，其內部是否只用 `fetch`（而非 `EventSource`/`XMLHttpRequest`/`Bun.connect`）我無法確認——vendored 樹沒有該套件。`app.tsx:142-152` 的註解與前次 spike 的觀察（opencode CLI 自己就用 `createWorkerFetch` 偽裝）強烈支持可行，但**未實證**。
3. **SSE 的具體封包**未驗證。`sdk.tsx:91-105` 用 `sdk.global.event()` 回 async iterable；shim 要吐什麼形狀（`{data: JSON}` 的 AsyncIterable？）取決於 SDK 內部，未能確認。
4. **`assistant/chunk` 的生產者**：`embedded.ts:18-23` 說 core-agent 不 append、只有 web-host 會 pipe。我確認了 `grep assistant/chunk` 在 `packages/core-agent` 無命中，但**沒有**追進 `llm-*` adapter 的 mux 路徑去確認「chunk 到底在何時、由誰產生」；若要走「真串流」而非「整段 assistant/message」，這一條必須先查清。
5. **`tui-beta/src/context/data.tsx` 的 v2 平面是否真的可關**：目前唯一消費者 `autocomplete.tsx:90,280,324`，但 `DataProvider` 在 `app.tsx:308` 掛載且 `onMount` 會打 8 條 `v2.*`（`data.tsx:552-560`）。是否可在不 fork 的前提下停用它，未確認。
6. **`@opentui/solid` 在 Node 上能否跑**：`bunfig.toml` 的 `preload` 與原生二進位（`tui-beta/package.json:55-57`）指向 Bun 專用；我沒有查證是否有 Node 相容路徑。前次 spike 的判斷（不行）我沒有新的反證。
7. **IH 的 `guard-retry` 是否可能產生 retry 語意**：我只確認它重試工具呼叫、不 append session 事件（`packages/guard-retry/src/index.ts:62-107`）；model 層的 retry 是否在 `llm-*` 或 `core-agent` 有獨立路徑，未查。
8. **權限 `patterns` 在 IH 的語意對應**：IH 的 `guard-approval`（`packages/guard-approval`）有 policy 概念，我沒有展開它與 opencode `patterns` 的對應關係；3.1 節的「seam 升級」設計需要先做這件事。
9. **`session/list` 的 `parentID`**：IH 的 `SessionHeader.parentSession` 在 JSONL meta 裡，但 `session/list` 的 host 實作（`apps/cli/src/index.ts:473-517`）只用 `meta.title` 與檔案 mtime；要把 `parentID` 放上列表列，需要確認 `SessionMeta` 是否持久化 lineage（我未展開 `packages/session-persistence` 的 meta 定義）。
