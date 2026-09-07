# M49 Grok Build / I-harness TUI 詳細盤點

日期：2026-09-06  
I-harness：`D:\I-harness-main\.worktrees\m49`，branch `m49`  
Grok Build：`D:\agent-complete\grok-build-main`（來源快照沒有 `.git`）

> **2026-09-07 交付更新（supersede）**：本盤點的 M46 時期結論——`tui.providers` provider plane、mock fallback 解析鏈與 fixture-only pane 狀態——已被 M49 全部落地/取代；交付後狀態以 `docs/CAPABILITIES.md` 的「八¾¾、Provider/模型 plane + TUI parity（M49）」節 + README M49 行為為準。**盤點時的「M49 補足」行現況**：canonical provider settings（required-model）、typed settings/provider flow、grapheme editor + 可見 cursor、typed tool blocks + viewers/copy、queue、tasks/subagents、主題 + minimal 生產化、local dashboard + 內建 status line、capability-gated slash + 鼠標捕獲切換——均已在 production composition 接線（各對應 PTY case-024..case-028）。**排除項維持**：Grok/xAI 帳號、訂閱、計費、account OAuth（僅型別擴展邊界）、billing、delete、跨機器 dashboard、自動 discovery 爬取——I-harness 不實作。（本盤點的「fixture-only」標記僅記錄盤點當下；後續任務已交付者以此注澄清。）

## 0. 方法與判定

本盤點同時閱讀兩邊 production source、使用者指南、既有研究、單元測試與 PTY harness。Grok 完整 TUI 的 live black-box 路徑被 xAI OAuth device-code gate 擋住，因此登入後畫面以 Rust production source、guide 與 snapshot/PTY tests 為準；登入牆本身已有 live 驗證。I-harness 的判定以 composition root 是否真正接線為準，不能因 renderer、fixture 或測試 fake 存在就宣稱功能已交付。

狀態標記：

- **真實**：production composition 已接到真實後端或本地資料源。
- **局部**：核心或 renderer 已有，但 executable host、資料投影或互動缺接線。
- **fixture-only**：畫面可畫，production 沒有資料或 action。
- **排除**：Grok/xAI 帳號、訂閱、計費或其他 I-harness 沒有且 M49 不會假造的產品能力。
- **M49 補足**：後端已有資料但缺公共契約，依既有 package 邊界新增投影或 adapter。

## 1. 核心結論

1. I-harness 已有成熟的 cell renderer、fullscreen scrollback、minimal print-once 引擎、mouse/selection/timeline、rewind、provider 基礎、settings/credentials、session service 與 subagent runtime；M49 不應移植 Grok Rust stack，也不應替換 agent 主骨架。
2. 當前最大的 product-integrity 問題是 production TUI 在 provider/model/credential 缺失或解析失敗時靜默執行循環 `"ok"` mock，並可能顯示真實模型標籤。M49 必須改為明確的 `unconfigured/invalid/ready` 狀態，未 ready 時禁止 prompt submit。
3. Provider 設定目前分裂：CLI/web 使用 `settings.llm.providers`，TUI 使用 `settings.tui.providers`。兩邊欄位名、protocol vocabulary、credential ref 與 discovery parser 均不同。M49 必須收斂到唯一 canonical plane：`llm.providers`；`tui` 只保留 UI preferences。
4. Queue、Tasks/Subagents、Dashboard 的 renderer 已存在或可重用，但 production 只提供 queue count，沒有 queue rows；subagent/job/team events 多數被丟棄；dashboard 完全沒有。這些不是「後端不支持」，而是現有真實 state 未形成 TUI projection。M49 會在 `session-executor`、`subagent`、`jobs` 的既有責任範圍內補 read/action surfaces。
5. Prompt 有 cursor index，卻沒有 terminal-visible caret、完整 keyboard movement、grapheme-safe deletion 或 undo/redo。Grok 的 prompt quality 來自獨立 editor model 與 renderer cursor state；M49 應採同樣分層，而不是繼續把文字編輯邏輯塞進 `loop.ts`。
6. Tool block renderer 比 production event mapping 更完整：`tool/call.args` 被丟棄，實際 edit result 只被 JSON stringify，因此測試中的 command/path/diff 資訊不會出現在真實 TUI。M49 要保留 typed args/result，並由 tool-presentation adapter 產生摘要與 diff。
7. Grok 的 account login、team identity、subscription usage、billing、ZDR/access gates、account privacy 與 managed connector deep links全部排除。I-harness 直接進本地 Welcome；未來 provider OAuth 只保留 auth resolver extension point，不出現假的 Login/Logout UI。

## 2. 架構對照

### 2.1 Grok Build

```text
xai-grok-pager-bin composition
  -> AppView (Welcome | Agent | AgentDashboard)
  -> input outcome -> typed Action -> reducer/router
  -> typed Effect -> async completion -> Action::TaskComplete
  -> typed RenderBlock / modal / viewer state
  -> xai-grok-pager-render terminal diff + cursor state
  -> xai-grok-pager-minimal hook for native scrollback mode
```

主要證據：`xai-grok-pager/src/app/app_view.rs:221,587,2406,4399`、`app/actions.rs:36,1318`、`app/dispatch/router.rs:147`、`xai-grok-pager-render/src/render/draw.rs:336`。

### 2.2 I-harness

```text
apps/cli routing
  -> apps/tui composition
  -> BackendClient (embedded | SDK remote)
  -> SessionEvent mapping
  -> ScrollbackEngine + TuiAppState
  -> present()
  -> tui-core renderer / terminal
  -> minimal inline writer when selected
```

主要證據：`apps/cli/src/index.ts:111`、`apps/tui/src/index.ts:188`、`packages/tui/src/contracts.ts:90`、`packages/tui/src/backend/embedded.ts:105`、`packages/tui/src/app/present.ts:718`、`packages/tui/src/app/loop.ts:2742`。

### 2.3 M49 採用方向

```text
Grok parity contract
  -> I-harness TUI state/views/interactions
  -> capability-backed BackendClient adapters
  -> provider-runtime / SessionService / subagent / jobs / settings / credentials
```

不移植 Rust、不引入 Grok account model、不建立第二套 agent runtime。新增 package 只限跨 host 的 provider composition 公共契約；session、queue、tasks 與 UI state 留在既有 ownership。

## 3. 全面矩陣

| Surface | Grok Build production | I-harness M49 起點 | 判定 | M49 決策 |
|---|---|---|---|---|
| Welcome/startup | 多 gate Welcome、prompt、resume、announcements、warnings | renderer 有；預設直接 Agent；startup 未 `backend.open()`；resume/listSessions 未接 | 局部 | 直接本地 Welcome；模型未設定時 CTA 到 Settings；修 startup/open/resume |
| Prompt editor | 獨立 TextArea、grapheme cursor、undo/redo、mouse、chips、visible terminal caret | insert/backspace/paste/history/stash/mouse 有；caret/完整 movement/undo 缺 | 局部 | 新 editor model + cursor-state rendering |
| Scrollback | typed blocks、follow/search/fold/raw/selection/timeline/links | fullscreen 已成熟 | 真實但有缺口 | 保留；補 typed data、viewer、input priority |
| Minimal | native scrollback，final block print-once，live region，不進 alt-screen | 引擎/PTY 有；production 仍 `terminal.init()` 進 alt-screen | 局部 | composition 真正分流；minimal 不捕獲 mouse、不進 alt-screen |
| Tool blocks | execute/read/edit/list/search/web/MCP/skill/bg/lifecycle typed variants | renderer taxonomy 有；production args/result 被壓平 | 局部 | typed tool presentation adapter |
| Edit diff | structured hunks、context merge、syntax worker、大小上限 | 測試可畫 diff；真實 fs event 沒有完整 diff input | fixture-only integration | fs result/args 保留可重建資料；context-limited unified diff |
| Queue | server+local FIFO、authoritative version、edit/cancel/send | backend 只有 count；pane rows fixture-only | fixture-only | 真實 pending rows + cancel；promote/send-now 只在真 capability 存在時顯示 |
| Tasks/Subagents | stable identity、child transcript、out-of-order lifecycle、kill、grouped pane | subagent runtime 真實；TUI 多數事件丟棄、rows fixture-only | backend 真實/UI 未接 | subagent/jobs projection + viewer + cancel/kill |
| Dashboard | AgentDashboard、filters、pins/order、attach/peek/new session | 無 dashboard，slash hidden | 缺失 | 以 coordinator/service 真值建本地 dashboard；不引入 Grok SQLite store |
| Settings | typed registry、preview/commit/rollback、bool/enum/string/int editors | 8 類外觀存在；多數 row placeholder 或未 live apply | 局部 | declarative registry；只顯示真旋鈕；Models/Providers 為 I-harness 專屬流程 |
| Provider/model | Grok catalog picker；custom providers 主要靠 config file | 五個真 adapter；兩套設定面；TUI discovery 未帶 auth；Bedrock 被 key gate 阻擋 | 架構缺陷 | canonical `llm.providers` + provider-runtime + dynamic/manual model management |
| Theme | 5 themes + auto、capability filtering、live/persist、minimal lock | GrokNight/GrokDay + auto detection；persist/live 分裂 | 局部 | 五主題 + system；startup/live/persist 同源 |
| Viewer/modal | typed modal union、block/file/plan/task viewers、search/raw/copy/selection | 多個 overlay renderer；generic viewer、clipboard、subagent viewer 未接 | 局部 | 統一 modal/viewer contract，minimal embedded chrome |
| Status line | disabled/builtin/command，cwd/model/context/cost/timer/session | renderer 可畫多 segment；cwd/model/tasks/MCP 多為假值或空值 | 局部 | 只顯示真值；builtin + optional command mode |
| Keyboard/mouse | context-aware action registry、vim-aware lookup、runtime mouse capture toggle | 大量 mouse parity 已有；keyboard editor 不完整；mouse off 不發 disable bytes | 局部 | action ownership、完整 editor keys、capture bytes、modal precedence |
| Slash commands | 大型 catalog + mode/capability/session visibility gates | 46 visible 中有多個 state-only；20 hidden；unknown slash 會送模型 | 誠信缺口 | capability registry；unsupported slash 絕不送模型；只顯示可執行命令 |
| System prompts | composable template context、project rules、roles/personas/catalogs | runtime context/instructions 有；base prompt 仍極簡 | 局部 | 保留 I-harness identity，補工程工作流/tool/testing/subagent/communication contract |

## 4. Welcome、啟動與會話

### Grok

- `WelcomeRenderParams` 與 `render_welcome` 支持 login/authenticating、consent、folder trust、access gate、normal welcome：`xai-grok-pager/src/views/welcome/mod.rs:606,683,717`。
- normal welcome 包含 prompt、session picker、announcement/changelog、update/resume hints、startup warnings 與帳號 CTA：`welcome/mod.rs:1659`。
- `ActiveView` 明確分 `Welcome | Agent | AgentDashboard`；Welcome 自己擁有 gate-aware input interceptor。

### I-harness

- `packages/tui/src/views/welcome.ts:23` 已能畫 hero、subtitle、menu、prompt 與版本列，寬度切換規則也存在。
- `packages/tui/src/app/loop.ts:342` 預設卻是 `agent` view；Welcome 不是 executable 的起始流程。
- production startup 沒有呼叫 `backend.open()`；`--prompt` 只在 embedded `open()` 路徑送出，remote history 與初始 session 也因此不完整：`packages/tui/src/backend/embedded.ts:399`、`loop.ts:2462`。
- executable 沒把 `listSessions` 傳給 app；Welcome resume action 還以按鍵字串誤判 `"Resume session"`：`loop.ts:2365,2581`。
- M48 已修 session ownership/recovery/close transaction；M49 應消費這些能力，不改回本地假 session。

### M49 gap classification

- Welcome renderer 是 **局部**，啟動 state machine 與 backend open 是 **缺失**。
- Grok 的 account gates 全部排除；folder trust 不是 account-only，但 M49 不新增第二個 startup gate，維持現有 sandbox/approval policy。
- 起始順序應為：load settings/credentials -> resolve provider/model state -> load session list -> render Welcome -> user new/resume/settings -> open backend -> Agent。

## 5. Prompt editor、可見游標與輸入

### Grok

- `PromptWidget` 管理動態高度、paste/image/chip、mouse 與 draw：`views/prompt_widget/mod.rs:546,1479,1544,2157,2205,2279,2826`。
- `xai-ratatui-textarea::TextArea` 管理 text、byte cursor、selection、scroll、atomic inline elements、undo/redo：`textarea.rs:190,609,641,680,1157,2245,2806`。
- `CursorState` 只在 visibility/position 真正變化或 frame 寫位移時送 `Show/Hide/MoveTo`，避免每幀重置 blink：`xai-grok-pager-render/src/render/draw.rs:336,369`。

### I-harness

- `PromptState` 已有 text/cursor、paste chips、history、stash、mouse mapping；production 可 insert、backspace/delete、paste、multiline、external editor：`packages/tui/src/views/prompt.ts:22,189`、`packages/tui/src/app/loop.ts:814,986,1358,1995`。
- `prompt.ts:5` 明確註記不畫 visible cursor。
- `AppAction` 沒有完整 left/right、word motion、home/end、undo/redo；newline 追加到尾端，不是插入 cursor；UTF-16 slicing 可切斷 surrogate/grapheme。
- PTY/單測覆蓋 key routing、paste、mouse positioning，沒有 cursor blink/position、grapheme deletion 或 keyboard selection proof。

### M49 gap classification

- 新增獨立 editor model 是必要的責任拆分；`loop.ts` 只路由 action，不再手寫字串 slicing。
- editor 以 grapheme boundaries 為最小單位，支持 insert/newline/backspace/delete、left/right、word-left/right、home/end、select-all、undo/redo、history/stash 與 inline paste element。
- prompt view 回傳 cursor cell；terminal/renderer 保存 cursor state。Overlay/viewer 開啟、prompt disabled、app unfocused 或 minimal native selection 時 cursor 隱藏。

## 6. Scrollback 與 Minimal

### Grok

- `RenderBlock` 是 closed typed union；`ScrollbackState` 管 entries/running ids/follow/offsets/selection/turns/layout cache/groups/folds/minimal frontier：`scrollback/block.rs:337`、`scrollback/state/mod.rs:53,1494`。
- fullscreen 支持 search、raw/rendered、sticky headers、group/fold、turn timeline、links、scrollbar drag 與 character selection。
- minimal 將 final blocks print-once 到 terminal native scrollback，只有 live region 可重畫；`Terminal::insert_before` 寫在 pinned live region 之前：`xai-grok-pager-minimal/src/lib.rs:1,69`、`commit.rs:50,91,338`、`xai-ratatui-inline/src/terminal.rs:855`。

### I-harness

- `ScrollbackEngineImpl` 已支持 seq dedupe、stream mutation、fold/group、search、selection、sticky prompt、timestamps、retention、rewind anchor 與 timeline turn anchors：`packages/tui/src/scrollback/engine.ts:34`。
- `MinimalCommits`、inline writer 與 live region 已有 print-once 邊界、500ms tail flush、resize/relaunch；PTY case-015 驗證的是直接建立 minimal host。
- production `apps/tui/src/index.ts:370` 無論 mode 都呼叫 `terminal.init()`；`tui-core` terminal init 會進 alternate screen。這使 production minimal 與 PTY proof 不同。
- `resolveScreenMode()` 已存在但 composition 沒使用；persisted mode 也沒有成為 startup truth。

### M49 gap classification

- fullscreen engine 保留，不重寫。
- composition 必須在 terminal init 前決定 `fullscreen|minimal`；minimal 不進 alternate screen、不發 mouse enable sequence，modals 用 embedded/borderless live region。
- `/minimal`、`/fullscreen`、CLI flag、persisted setting 使用同一 resolver；失敗才清楚 downgrade，不能表面顯示 minimal 實際仍 fullscreen。

## 7. Typed tool blocks 與 Edit diff

### Grok

- `ToolCallBlock` 有 execute/read/edit/list/search/web/MCP/use-tool/integration/memory/message/skill/background/lifecycle/generic variants：`scrollback/blocks/tool/mod.rs:152,604`。
- ACP tracker 處理 call/update race、field merge、completion 與相鄰同檔 edit coalescing：`acp/tracker.rs:876,1120,1207,1729`。
- diff leaf 建 structured hunks、before/after fallback、相鄰 hunk stitching、ACP edit extraction 與 unified patch：`xai-grok-pager-diff/src/lib.rs:19,155,186,300,373`。

### I-harness

- core agent 寫真實 `tool/call` / `tool/result`；TUI `toolKindOf()` 與 folding 已能畫 running/done/error、execute excerpt、read/search grouping、diff colors 與 `(+N/-M)`：`packages/core-agent/src/execute-tool-calls.ts:67`、`packages/tui/src/contracts.ts:49`、`scrollback/folding.ts:185`。
- embedded mapper 丟棄 `tool/call.args`；result 只做 generic JSON stringify：`packages/tui/src/backend/embedded.ts:76,124`。
- fs read/edit/apply_patch 返回 structured objects，但真實 edit block 沒收到 command/path/query/patch/before-after；現有 diff tests 直接注入理想字串，因此屬 fixture proof。

### M49 gap classification

- `TuiEvent.tool` 要保留 normalized args/result/error/progress，而不是只有 summary/output string。
- tool presentation adapter 依工具名和 schema 提取 command、path、query、URL、MCP server/tool、subagent target、job id；未知 shape 使用 generic fallback。
- edit/write/apply_patch 必須提供可重建 diff 的資料；context-limited hunk、行號、add/delete count、fold/raw viewer 都從同一 structured representation 產生。
- 大內容遵守既有 retention/spill，不在 session event 複製無界 file bodies。

## 8. Queue

### Grok

- shared queue row與 change payload：`xai-prompt-queue/src/types.rs:31,56`；local FIFO 在 `app/agent.rs:676`。
- QueuePane 合併 server-first/local-second，authoritative broadcast 會校正 optimistic echo：`views/queue_pane.rs:36,540`、`app/acp_handler/queue.rs:92`。
- queue edit 有 hold/save/cancel/draft restore/versioned update；merge eligibility 明確排除 synthetic、bash、empty、image/edit held rows。

### I-harness

- `SessionService.queueState()` 只回 `{running, queued}`；真實 per-session lane 的 `pending()` 已有 `inputId/text/delivery`，但 service 沒公開 rows：`packages/session-executor/src/service.ts:66,267`、`packages/core-agent/src/executor.ts:26,121`。
- status `+N` 是真值；`queue-pane.ts` 能畫 rows/action，production 卻從未設 `paneData.queue`，所以 `/queue` toggle 常不可見。

### M49 gap classification

- 在 `session-executor` 公開 queue snapshot，row 至少含 stable id、text preview、delivery、origin、state、created order。
- cancel 使用既有 `SessionExecutor.cancel()`；若 service-front queue 尚未進 lane，要保留 abort/cancel handle。
- edit 或 promote/send-now 只有在 backend 實作 atomic action 時才顯示；M49 不允許 toast 假成功。

## 9. Tasks、Subagents 與 Dashboard

### Grok

- `SubagentInfo` 保存 identity/role/model/prompt/progress/activity/status/kill/worktree/transcript；child transcript 可 replay/disk/memory：`app/subagent.rs:30,95,289,702`。
- TasksPane 以 stable ids 分 workflows/subagents/one-shot/watchers；lifecycle 能緩衝 out-of-order finish：`views/tasks_pane.rs:162,172,751`、`acp_handler/subagent_lifecycle.rs:47,116`。
- Dashboard 將 top-level agents、child agents、leader roster、unloaded workspace sessions 建 stable rows，支持 filter、pin/order、attach、peek、new session：`views/dashboard/state.rs:29,192,275,297,355,378,486`、`dispatch/dashboard.rs:33,303,1065`。

### I-harness

- `registerSubagent()`、job/task protocol、durable child sessions、cancel tree、resume/recovery 與 model-facing tools都是真實；`SessionAssembly` 目前只公開 `killJob()`，沒有 projection：`packages/session-executor/src/assembly.ts:142,493`。
- TUI 把 `subagent/start/end` 降成 system rows，丟棄 `team/*`、`job/status`、schedule/inbox；`tasks-pane.ts` production rows 只來自 `initialPanes` fixture。
- workflow list/run/status 是真實的獨立 surface；dashboard slash 仍 hidden。

### M49 gap classification

- `subagent` package 應提供 read-only projection（agents/jobs/tasks、parent/child、status、summary、timestamps）與既有 kill/cancel action，不把 registry internals複製到 TUI。
- `SessionAssembly` / `SessionService` 暴露 projection；embedded/SDK backend 映射成 TUI `TaskRow`。
- Dashboard 使用 coordinator session list + live service status + task counts；不建立 Grok 的 SQLite dashboard store，也不宣稱跨機 leader roster。
- 支持 new/open/resume/filter/peek；pin/order 可存 TUI prefs。只顯示本地可證實的 sessions/agents。

## 10. Settings、Providers、Models 與 Auth 擴展

### Grok

- settings 是 typed registry：key/owner/category/value kind/metadata/value 分離，modal 支持 browse/filter、enum preview/commit、bool sheet、string editor、integer stepper：`settings/registry.rs:20,36,151,193,215,391`、`views/settings_modal/state.rs:73,165`。
- UI 先更新記憶體，再發 persist effect；失敗套 captured rollback：`app/dispatch/settings/ui.rs:843`。
- custom model/provider 主要是 config/catalog path；TUI `/model` 選 catalog。完整 TUI 仍被 grok.com OAuth gate 約束，這一點不適合 I-harness。

### I-harness 現有 provider 能力

- `@i-harness/provider` 有五個真實 protocol adapter：OpenAI Responses、OpenAI-compatible completions、Anthropic Messages、Gemini、Bedrock；建 client 與 retry wiring 在 `packages/provider/src/index.ts:652,676,704`。
- ProviderRegistry、model cards、context resolution、static directory、probe registration、generic model discovery 已有：`provider/src/index.ts:100,226,537`。
- discovery 現在主要嘗試 OpenAI-style `/v1/models`、`/models`，可按 protocol 發 Bearer、`x-api-key`/Anthropic version 或 `x-goog-api-key`；native Bedrock catalog 沒有實作。
- credentials 只公開 describe/set/unset/resolve；env 值優先且會阻止 file overwrite，settings 只存 ref：`packages/credentials/src/index.ts:73,88,101,199`。

### 兩套設定面的衝突

| Canonical web/CLI | TUI-only M46 plane |
|---|---|
| `settings.llm.providers.<route>` | `settings.tui.providers.providers.<id>` |
| `baseURL` | `baseUrl` |
| `apiKeyEnv` credential ref | `apiKeyRef` credential ref |
| `openai-completions` / `anthropic-messages` | `openai-compatible` / `anthropic` |
| `models: SettingsModel[]` | runtime memo + `modelsUrl` |

TUI discovery還直接 `fetch`、不帶 credential auth且只接受較窄 response shape；model factory對所有 protocol 強制 API key，錯誤阻擋 Bedrock ambient AWS auth。production host又只在 keyboard attach 失敗時傳 `providerStore`：`apps/tui/src/index.ts:347`。

### M49 gap classification

- `settings.llm.providers` 成為唯一 canonical provider/model設定；`settings.tui.providers` deprecated，啟動時做 deterministic compatibility conversion，之後只寫 canonical plane。
- 新增 `@i-harness/provider-runtime`，因它是跨 TUI/web/SDK composition 的公共契約，具有獨立責任：settings profile merge、credential auth resolution、directory/probe/adopt、default/session selection、context/effort、client build。
- `@i-harness/provider` 仍只處理 provider protocol、probe primitive、model card 與 client construction；不直接讀 settings/secrets。
- `@i-harness/credentials` 增加 provider auth resolver interface，M49 實作 `api-key-ref` 與 `ambient`；保留 `oauth-account-ref` type extension，但不提供 OAuth UI、token store、login/logout/refresh/usage。
- Settings Models/Providers 流程必須支持：configured provider list、adapter template、add/edit/delete、protocol/base URL/models URL、credential ref或 masked key write、test/discover、manual model row、default model、reasoning effort、empty/error/unsupported discovery states。

## 11. Theme、Viewer/Modal、Status Line 與互動

### Theme

- Grok 有 GrokNight、GrokDay、TokyoNight、RosePineMoon、OscuraMidnight + auto，會按 terminal capability 過濾/quantize，auto 可輪詢 system appearance。
- I-harness `tui-core` 已有 GrokNight/GrokDay、truecolor/256/16/mono quantization與 OSC background detection；`/theme` live，但 startup忽略 persisted setting，Settings persist 又不 live apply。
- M49 將 theme id、palette resolution、minimal semantic colors、slash/settings live preview、persist/rollback 收斂為同一 source。

### Viewer/Modal

- Grok typed modal union、block viewer、line viewer支持 search/raw/copy/scroll/selection，modal在 minimal用 embedded borderless chrome。
- I-harness provider/model/settings/permission/question/cancel/rewind overlays 已有；approval bridge production未 pump，line viewer fallback 不真讀檔，subagent viewer/link open/clipboard callback 未完整接線。
- M49 建統一 `ModalState | ViewerState` precedence；viewer至少支持 tool raw/rendered、file/plan lines、task/subagent detail、search、scroll、copy。copy 必須走真 clipboard adapter並回報失敗。

### Status line

- Grok支持 disabled/builtin/command；builtin items含 cwd/model/context/cost/timer/session，command吃 JSON stdin、timeout並保留短暫失敗前值。
- I-harness status renderer 可畫 cwd/branch/tasks/plan/goal/MCP/context/queue/todo，但 production cwd硬編 `~/workspace`，branch/MCP/tasks缺 source，model可能顯示 `mock-model`，turn token/attempt常為固定值。
- M49 built-in只畫 backend可證實值；cwd/branch從 host，model從 resolved binding，context/queue/tasks/goal/todo從 projection。Optional command mode可由本地 exec service提供，失敗不得阻斷 TUI。

### Keyboard/mouse

- I-harness fullscreen mouse已包含 wheel/trackpad normalization、hover、selection、multi-click fold、drag/autoscroll/copy、scrollbar、prompt chips、timeline、permission/question hit areas。
- 缺口：mouse off只丟 app event，沒有發 terminal disable sequence；picker tabs/filter/expand、link open、keyboard editor movement與 input-owner precedence不完整。
- M49所有 key/mouse action先由 active modal/viewer取得，再 panes，再 prompt，再 scrollback；unsupported action不落到 model prompt。runtime mouse capture切換必須改 terminal bytes與 app state兩邊。

## 12. Slash commands 盤點

I-harness M49 起點通常可見 46 條：

```text
new home resume delete rename session-info find jump history
provider model settings effort rewind compact plan view-plan queue tasks btw
theme timestamps multiline compact-mode minimal fullscreen timeline
always-approve auto doctor copy export transcript help quit
skills mcps hooks plugins marketplace personas config-agents workflow usage tutorial goal
```

其中 `new/delete/plan/queue/tasks/always-approve/auto/compact-mode/personas/copy` 等有 state-only、toast、fixture-only或未接 backend問題。另有約 20 條 hidden entries；unknown/hidden slash 現在可能當普通 prompt送給模型，這是明確的誠信與安全缺口。

### M49 capability-backed 集合

| 類別 | M49 應提供 |
|---|---|
| Session | `/new` `/home` `/resume` `/dashboard` `/fork`（capability有才顯示）`/rename` `/session-info` `/compact` `/context` `/rewind` |
| Navigation/editor | `/find` `/jump` `/history` `/edit-prompt` `/queue` `/tasks` `/multiline` `/vim-mode` |
| Models/settings | `/settings` `/provider` `/model` `/effort` `/theme` `/timestamps` `/compact-mode` `/minimal` `/fullscreen` |
| Local tools | `/doctor` `/copy` `/export` `/transcript` `/help` `/quit` |
| Real inventories | `/skills` `/mcps` `/hooks` `/plugins` `/marketplace` `/workflow` `/workflows` `/usage`（local context only）`/goal` `/tutorial` |

每條命令要有 `visible(ctx)` capability gate、argument contract、真 action 與錯誤狀態。未支持的 slash 必須顯示 `Unsupported command: /name`，不得送給 LLM。

### 明確排除

```text
/login /logout /share /privacy /import-claude
/remember /recap /dream /flush /loop
/voice /imagine /imagine-video /gboom
/usage manage 或任何 subscription/billing action
/cd（session workspace immutable）
/delete（沒有 durable delete API）
```

`/plan`、`/always-approve`、`/auto` 只有在 M49 實作 live backend capability 後才可見；不能沿用目前單純改 UI state 的版本。

## 13. System prompts

Grok prompt build會組合 base template、project rules、skills/tools/MCP catalogs、memory、role/persona與 audience；I-harness 已有 runtime-context、instructions discovery、plan-mode fragment、skills/tool search與subagent工具，但 base prompt仍只是 `"You are a coding agent."`：`packages/session-executor/src/assembly.ts`。

M49 不複製 Grok persona，也不把 I-harness 改成 xAI agent。需要跟進的是工程契約：

- 先讀 repo/context，再做最小正確改動。
- tool使用、approval/sandbox、parallelism、long-running task與background語義。
- TDD、systematic debugging、verification、review與交付閉環。
- subagent delegation、task ownership、status reporting與結果整合。
- 不宣稱未執行/未驗證能力；不使用 mock作production答案。
- 終端互動文字與 slash/settings實際 capability 一致。

這些段落應經既有 `preset`/runtime-context 組裝，不在 TUI 裡硬編第二份 system prompt。

## 14. Package ownership 決策

| 改動 | Owner |
|---|---|
| canonical provider/model schema與compat normalization | `packages/settings` |
| API key ref、ambient auth、future OAuth resolver contract | `packages/credentials` |
| protocol/profile/probe/model card/client build primitives | `packages/provider` |
| 跨 host settings+credentials+provider composition | **new `packages/provider-runtime`** |
| session model binding、assembly invalidation、queue snapshot/action | `packages/session-executor` + `packages/core-agent` |
| subagent/job/task read projection與kill/cancel | `packages/subagent` / `packages/jobs` |
| typed UI events、editor、views、modal/dashboard/slash | `packages/tui` |
| terminal cursor/capture/theme palettes | `packages/tui-core` |
| executable composition、minimal/fullscreen startup、real bridges | `apps/tui` / `apps/cli` |
| fs diff-producing result（若 production input不足） | `packages/fs`；只有跨 consumer reuse成立才新增 diff leaf |

## 15. Baseline 與風險

- M49 起點 `pnpm typecheck` 通過。
- 第一次完整 test 曾在 SDK restart durability case 暫時失敗，focused 連續 5/5 通過；要保留為高負載 flake觀察項。
- 本環境沒有 `bash.exe`，揭露兩組把「Git Bash已安裝」當成跨平台前提的測試。M49 已以 `resolveShell()` 修正 `guard-timeout` 與 CLI guard/retry/retention cases，production行為未改。
- TUI PTY harness在高並行時仍會看到 `node-pty AttachConsole failed` helper noise；case本身可能通過。M49 final verification 必須單獨跑 PTY suite並保留 exit code，不以截斷 log判定。
- 最主要實作風險是一次改動 model resolution、session assembly與 TUI startup。計畫必須先建 provider-runtime與 explicit model state，再接 Welcome；不能直接刪 mock而讓所有測試/SDK composition崩潰。
