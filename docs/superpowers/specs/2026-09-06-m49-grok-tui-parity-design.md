# M49：Grok Build TUI 對齊與真實能力閉環

日期：2026-09-06  
Branch：`m49`  
起點：M48 final `e9e6530aaabe6c39d93bed22b77a60adc31d5a36`  
詳細盤點：`docs/research/2026-09-06-m49-grok-tui-parity-inventory.md`

## 0. 目標

M49 將 I-harness TUI 的畫面、資訊密度、互動模型與 Grok Build 對齊，但所有資料與 action 必須來自 I-harness 真實後端。保留 I-harness 自有 agent/runtime；不移植 Grok Rust crates；不實作 xAI/Grok 帳號、訂閱或計費。

完成後：

1. Bare `i-harness` 直接進本地 Welcome；沒有 provider/model/credential 時清楚顯示未設定，prompt disabled，使用者由 Welcome 或 `/settings` 進 Models & Providers。
2. Production TUI、其內建 SDK subprocess與 executable composition 不再靜默建立 mock model。測試仍可明確 dependency-inject mock/fake。
3. Provider/model 只有一套 canonical settings，支持多 provider、多 model、手動 model、動態 discovery、credential refs與 Bedrock ambient auth；保留未來 OAuth resolver extension point，但不顯示假的 OAuth login。
4. Prompt editor、visible cursor、scrollback/minimal、typed tool blocks/edit diff、queue、tasks/subagents、dashboard、settings/theme、viewer/modal、status line、keyboard/mouse與 slash commands形成真實交付閉環。
5. System prompt 跟進成熟 coding-agent 工程契約，但身份、agent skeleton與 package architecture仍屬 I-harness。

## 1. 不可違反的原則

### 1.1 真實能力原則

- Production 不得以 `llm-mock`、循環 `"ok"`、fixture rows、toast-only action 或 hardcoded display value冒充完成。
- 每個可見 command、setting、pane action與 status segment都必須有 capability source；沒有 capability就隱藏或顯示明確 unavailable state。
- unknown/unsupported slash command絕不送給模型，固定顯示 `Unsupported command: /<name>`。
- 不知道 context total、cost、MCP status、branch、task count等值時省略，不估算成真值。

### 1.2 Package ownership

- Session lifecycle/model binding/queue：`session-executor`，低層 lane admission：`core-agent`。
- Session durable metadata/log：`session-persistence`。
- Provider protocol/profile/probe/client：`provider`。
- Secret refs/auth resolution：`credentials`。
- Durable declarative config：`settings`。
- Subagent/task/job projection與 action：`subagent` / `jobs`。
- TUI state/views/actions：`tui`；terminal cells/cursor/capture/theme：`tui-core`。
- Composition：`apps/tui`、`apps/cli`。
- 新 package只有：
  - `provider-runtime`：跨 host 的 settings + credentials + provider 公共 composition契約。
  - `text-diff`：fs producer與 TUI consumer共用的 structured diff 公共契約。

### 1.3 相容與遷移

- `settings.llm.providers` 是唯一 provider/model truth。
- 舊 `settings.tui.providers` 在 normalize/load 時 deterministic soft-migrate；讀到後可使用，但所有新寫入只更新 `llm.providers`。
- `tui` section只保留 presentation/input/dashboard preferences。
- 現有 SDK/ACP方法保持相容；新增 wire capability採 additive protocol version/capability negotiation，舊 server誠實降級。

## 2. Scope

### 2.1 納入

- Welcome與 executable startup/open/resume/new/settings flow。
- Production model gate與 canonical provider-runtime。
- Multi-provider/model settings、discovery/manual catalog、credential refs、default與per-session model/effort。
- Prompt editor、visible terminal cursor、grapheme-safe editing、undo/redo、history/stash/paste chips。
- Fullscreen scrollback收尾與 production minimal真正 native scrollback。
- Typed tool presentation與 structured edit diff。
- Queue rows/cancel與 capability-gated action。
- Tasks/subagents/jobs projection、kill/cancel、detail viewer。
- Local session dashboard、filter/open/new/resume/peek、persisted pin/order。
- Typed settings registry、五 themes + system、live preview/persist/rollback。
- Modal/viewer統一、real clipboard/file viewer、approval/question bridge composition。
- Builtin/optional-command status line真值聚合。
- Keyboard/mouse action ownership、runtime mouse capture bytes、Grok-like interaction priority。
- Backend-supported slash commands與 system prompt工程契約。
- Unit/integration/PTY/e2e/dist驗證與 docs更新。

### 2.2 明確不做

- Grok/xAI account login/logout、device code、browser auth、account/team identity。
- Subscription tier、credits、billing、paywall、usage quota、account privacy/ZDR/access gate。
- 假 OAuth provider登入。M49只落 resolver interface與現有 API key/ambient adapter。
- Cross-machine leader dashboard、Grok dashboard SQLite store。
- Durable session delete；session workspace runtime `cd`。
- Memory/dream/recap/remember/flush、voice/image/video generation、Claude import。
- 未由 production composition掛載的 plugin executable claims或 managed connector deep links。

## 3. Provider、Auth 與 Model Architecture

### 3.1 Canonical settings

`SettingsProviderConfig` 保留既有欄位並增加 discovery override：

```ts
export interface SettingsProviderConfig {
  apiKeyEnv?: string
  baseURL?: string
  modelsURL?: string
  displayName?: string
  protocol?: SettingsProviderProtocol
  models?: SettingsModel[]
}
```

`apiKeyEnv` 在現行版本仍代表 credential ref name，不存 raw key。Protocol vocabulary固定沿用 settings/provider既有值：

```text
openai-completions | openai-responses | anthropic-messages | gemini | bedrock
```

舊 TUI mapping：`baseUrl -> baseURL`、`modelsUrl -> modelsURL`、`apiKeyRef -> apiKeyEnv`、`openai-compatible -> openai-completions`、`anthropic -> anthropic-messages`。Provider key就是 route/id；舊 `activeProviderId`只有在 `llm.defaultModel.provider` 未設定時作 migration hint，不再作第二個 active pin。

### 3.2 Auth resolver

`credentials` 增加不暴露 secret的公共契約：

```ts
export type ProviderAuthRef =
  | { kind: "api-key-ref"; ref: string }
  | { kind: "ambient" }
  | { kind: "oauth-account-ref"; accountId: string }

export type ResolvedProviderAuth =
  | { kind: "api-key"; value: string }
  | { kind: "bearer"; accessToken: string; expiresAt?: number }
  | { kind: "ambient" }

export interface ProviderAuthResolver {
  describe(ref: ProviderAuthRef): Promise<{
    configured: boolean
    source: "env" | "file" | "ambient" | "oauth"
    writable: boolean
  }>
  resolve(
    ref: ProviderAuthRef,
    context: {
      providerId: string
      purpose: "discovery" | "inference"
      signal?: AbortSignal
    },
  ): Promise<ResolvedProviderAuth | undefined>
}
```

M49 production adapter只實作 `api-key-ref` 與 `ambient`。`oauth-account-ref` 若無注入 resolver，`describe`必須是未設定或明確 unsupported，不能產生 login action。

### 3.3 `@i-harness/provider-runtime`

新 package不做 transport/UI，公開一個跨 host service：

```ts
export type ModelResolutionState =
  | { status: "unconfigured"; reason: string }
  | { status: "invalid"; reason: string; providerId?: string; modelId?: string }
  | { status: "ready"; binding: SessionModelBinding }

export interface SessionModelBinding {
  client: ModelClient
  providerId: string
  modelId: string
  label: string
  reasoningEffort?: ReasoningEffort
  contextWindow?: number
}

export interface ProviderRuntimeEntry {
  id: string
  displayName: string
  protocol: SettingsProviderProtocol
  configured: boolean
  auth: {
    configured: boolean
    source?: "env" | "file" | "ambient" | "oauth"
    writable: boolean
  }
  models: ModelDescriptor[]
  defaultModel?: string
  discovery: "available" | "manual-only"
}

export interface ProviderRuntime {
  directory(): Promise<ProviderRuntimeEntry[]>
  upsertProvider(id: string, config: SettingsProviderConfig): Promise<void>
  removeProvider(id: string): Promise<void>
  setApiKey(id: string, value: string): Promise<void>
  clearApiKey(id: string): Promise<void>
  discoverModels(id: string, options?: { force?: boolean; signal?: AbortSignal }): Promise<ModelDescriptor[]>
  setDefaultModel(selection: SettingsDefaultModel): Promise<void>
  resolveModel(input: {
    sessionSelection?: { provider: string; model: string; reasoningEffort?: string }
    override?: string
  }): Promise<ModelResolutionState>
}
```

Resolution precedence：explicit `--model provider:model` -> `session.meta.modelSelection` -> `llm.defaultModel` -> `unconfigured`。Provider profile為 built-in registry template與 user config merge；user欄位逐欄勝出。模型必須存在於 user/discovered/static catalog之一，或由使用者明確手動輸入並存入 settings。

Discovery統一走 `provider` registry/probe primitives與同一 auth resolver，不允許 TUI另寫無 auth `fetch` parser。Native discovery缺失時顯示 `Discovery is not available for this provider; add a model ID manually.`。Bedrock無 API key時以 ambient auth繼續，不得被 generic key gate阻擋。

## 4. Production Model Gate 與 Session Binding

### 4.1 Assembly policy

`AssemblyOptions` 增加：

```ts
modelPolicy?: "required" | "test-mock"
```

- 缺省為 `required`；沒有 `model` 時拋 typed `ModelUnavailableError`。
- `test-mock` 只能由unit/PTY harness明確opt in；可使用caller提供的 `mockScript`，未提供時使用單一 `"ok"` test fixture。Production composition不得傳此值。
- `apps/tui`、TUI spawned SDK、production SDK/ACP/web composition使用 `required`。
- unit/PTY tests必須明確注入 fake/model或 `mockScript`；測試名稱與 fixture不得暗示 production fallback。

### 4.2 Session service binding

`SessionServiceOptions` 以單一 binding resolver取代 host內分散的 builder/window/effort判定：

```ts
export type SessionModelBindingResult =
  | { status: "unconfigured"; reason: string }
  | { status: "invalid"; reason: string; providerId?: string; modelId?: string }
  | { status: "ready"; binding: {
      model: ModelClient
      providerId: string
      modelId: string
      label: string
      reasoningEffort?: ReasoningEffort
      contextWindow?: number
    } }

modelBindingFor?: (
  sessionId: string,
  meta: SessionMeta | undefined,
) => Promise<SessionModelBindingResult>
```

`SessionModelBindingResult` 由 `session-executor` 定義，避免 engine package依賴 `provider-runtime` composition package；apps中的 adapter將結構相容的 `ModelResolutionState` 映射進來。ready binding一次供應 client、label、context window與reasoning effort；invalid/unconfigured阻止 assembly build。舊 `modelBuilder/contextWindowFor/reasoningEffortFor`暫保相容，`modelBindingFor`存在時優先。

Backend需提供 `modelState()`，讓 Welcome/prompt在建立 assembly前知道 `ready|unconfigured|invalid`。`/model`/`/effort`更新 current session metadata；只在 session idle且queue empty時 `closeSession()` 使下一個 turn用新 binding。Busy時拒絕並顯示 `Wait for the current turn and queue to finish before changing the model.`，不在半個 turn中熱換 client。

### 4.3 Backend capability surface

`packages/tui/src/contracts.ts` 使用 additive optional capabilities；wire不支持的member不存在：

```ts
export interface BackendModelState {
  status: "unconfigured" | "invalid" | "ready"
  reason?: string
  providerId?: string
  modelId?: string
  label?: string
}

export interface DashboardSessionRow extends SessionSummary {
  live: boolean
  running?: boolean
  queued?: number
  tasks?: number
  modelLabel?: string
}

export interface BackendClient {
  createSession?(): Promise<{ sessionId: string }>
  forkSession?(sessionId: string): Promise<{ sessionId: string }>
  modelState(): Promise<BackendModelState>
  setSessionModel?(selection: SettingsDefaultModel): Promise<void>
  queue?(): Promise<SessionQueueItem[]>
  cancelQueued?(id: string): Promise<{ cancelled: boolean }>
  tasks?(): Promise<AgentTaskView[]>
  cancelTask?(id: string): Promise<"cancellation-requested" | "already-finished">
  dashboard?(): Promise<DashboardSessionRow[]>
}
```

實際 interface會與既有 `BackendClient` members合併，不重複建立第二個 client type。SDK/ACP extension只傳 serializable view，不傳 `ModelClient`或registry物件。

## 5. Welcome 與 Startup State Machine

### 5.1 View states

頂層 state固定為：

```ts
type ActiveView =
  | { kind: "welcome" }
  | { kind: "agent"; sessionId: string }
  | { kind: "dashboard" }
```

Bare launch流程：

1. 載入 settings/credentials/provider runtime與 terminal capability。
2. 解決 screen mode、theme與 model state。
3. 建 backend與 session list source，但不為未選 session預建 model assembly。
4. 顯示 Welcome。
5. `New session`建立/open session；`Resume session`開 picker；`Settings`直達 Models & Providers；prompt submit在 ready時建立/open session並送出。

`--resume`直接 open該 session後進 Agent；`--prompt`仍先完成 model gate，ready才自動建立/open並submit；unconfigured/invalid留在 Welcome並保留 prompt文字，不丟失。

### 5.2 Welcome layout

沿用 Grok normal welcome的視覺順序並移除 account區：

```text
top padding
startup/model error slot
hero box: I-harness logo + version + local-agent label
announcement/changelog or provider status
menu: New session / Resume session / Settings / Quit
prompt chrome
model/provider status line
version/update line
```

- `cols >= 90` 使用橫向 hero，否則縱向；內容最大寬120。
- 沒有 model：prompt border/placeholder顯示 disabled，文字為 `No model configured. Open Settings > Models & Providers.`；Enter與paste都不submit，`Enter`或CTA開 Settings。
- ready：顯示 `<provider>:<model>`，prompt可用。
- invalid：保留具體原因，例如 missing credential、unknown provider、unknown model或client build failure；不得顯示 `mock-model`。
- Welcome不顯示 login/account/subscription/privacy/team badge。

### 5.3 Executable composition

- `providerStore`/provider-runtime無條件傳給正常TTY與non-TTY；不可再依 `attachInput` 成敗決定。
- production startup必須呼叫正確的 `backend.open()`；session list透過 backend，不另掃描一份互相漂移的 store view。
- approval/question bridge在 `onAssembly` 掛載並由 TUI pump；未提供 UI provider時仍 fail-closed。
- embedded與spawned SDK兩路都用同一 provider runtime/model policy；remote capability不足時UI顯示 unavailable，不用本地 label覆蓋遠端真值。

### 5.4 Agent screen visual contract

Fullscreen自上而下固定為：

```text
status line (optional, stable 1 row)
tasks/todo bands when open
scrollback (takes all remaining height, minimum 5 rows)
btw overlay row when active
queue band when open
turn status row when active
prompt chrome
shortcut row when space permits
```

- 外層padding、status/prompt寬度、timeline/scrollbar位置與 `docs/research/2026-09-03-tui-grok-ui-spec.md` 的 Grok layout contract一致；窄屏依序drop shortcuts、次要status segments、pane detail，不縮到文字重疊。
- Prompt是底部主要焦點，非浮動card；scrollback與page sections不包多層decorative border。Modal只用一層window chrome，minimal用embedded borderless版本。
- Tool/user/assistant/system blocks沿用現有glyph與semantic colors；同類連續read/search/web calls可group，execute/edit/error保留獨立可展開block。
- 所有固定格式元素（prompt rows、status row、pane columns、timeline rail、icon/action cells）有穩定尺寸，hover/label/status更新不得推動整體layout。
- `cols < 60` 隱藏timeline與次要pane columns；`rows`不足時保住prompt、至少5行scrollback與當前permission/question，其他surface改為全屏modal而非互相覆蓋。
- Welcome、Agent、Dashboard、Settings、Viewer在GrokNight/GrokDay下都需PTY screen snapshot；256-color量化後仍須可辨識focus、selection、diff add/delete與error/warning。

## 6. Prompt Editor 與 Cursor

### 6.1 Editor model

新增 `packages/tui/src/editor/`，production API至少為：

```ts
export interface PromptEditor {
  value(): string
  cursor(): number
  selection(): { anchor: number; focus: number } | undefined
  insert(text: string): void
  newline(): void
  backspace(): void
  deleteForward(): void
  move(direction: "left" | "right" | "word-left" | "word-right" | "home" | "end", extend?: boolean): void
  undo(): boolean
  redo(): boolean
  insertPaste(paste: { display: string; source: string }): void
  expandPasteAtCursor(): boolean
  replaceAll(text: string): void
  clear(): void
}
```

- cursor index永遠落在 grapheme boundary；`Intl.Segmenter`不可用時使用 code-point fallback，不能退回 UTF-16 code unit。
- insert/newline/backspace/delete/mouse click/paste/history/stash/external editor都經同一 editor transaction。
- undo unit是一次 printable burst、paste chip展開、newline、delete或external-editor replace；history/stash restore建立可undo transaction。
- prompt chips是 atomic inline elements，cursor不能落入其顯示文字中；source在submit/clear後釋放。

### 6.2 Key contract

- ArrowLeft/Right：grapheme；Ctrl/Alt+Left/Right：word；Home/End：visual line；Ctrl+A/E兼容行首/行尾；Ctrl+Z undo；Ctrl+Y或Ctrl+Shift+Z redo。
- Enter：submit；multiline mode或Shift+Enter：newline；busy Enter依真實 `busyEnter` setting選 steer或queue。
- Ctrl+S：stash/pop；F3：sessions；Ctrl+G：fullscreen tasks、minimal external editor；Ctrl+B只有 backend background capability存在才可用。
- Vim mode只在 editor實作 normal/insert與 escape ownership後顯示 `/vim-mode`；否則命令不可見。

### 6.3 Visible terminal cursor

- prompt renderer回傳 `{x,y,visible}`；`tui-core`保存上一個 cursor state，只在必要時發 `Show/Hide/MoveTo`。
- cell diff寫到 cursor cell後必重設位置；zero-byte idle不重發 cursor control bytes。
- active modal/viewer、disabled prompt、selection drag、unfocused app或shutdown時隱藏；回到prompt恢復。
- PTY必驗證 ASCII、CJK、emoji/ZWJ、combining mark、wrapped multiline與resize後位置。

## 7. Scrollback、Minimal、Tool Blocks 與 Diff

### 7.1 Scrollback

- 保留現有 `ScrollbackEngineImpl`、fold/group/search/selection/timestamps/retain/rewind/timeline。
- 增加 typed tool payload與viewer anchor；stream update在 base call前到達時要暫存，base到達後合併。
- input precedence固定為 modal/viewer -> pane -> prompt -> scrollback；Esc先關最內層surface，再清selection/search，最後才觸發cancel/rewind arm。
- fullscreen follow mode、sticky latest user block、timeline/scrollbar互斥與zero-byte idle不得回歸。

### 7.2 Production minimal

- mode resolver precedence：CLI explicit -> persisted `tui.prefs.screenMode` -> fullscreen default。
- minimal不呼叫 alternate-screen terminal init，不啟用mouse reporting；finalized block只commit一次，live region可重畫。
- modal/viewer在 minimal使用embedded borderless chrome；不能覆寫已commit terminal history。
- `/expand`在 minimal對已commit folded block採reprint semantics，不能假裝修改舊rows。
- inline engine unavailable時顯示一次明確warning並回fullscreen，persisted mode不在失敗時悄悄改寫。

### 7.3 Typed tool event

```ts
export interface TuiToolEvent {
  callId: string
  name: string
  kind: ToolKind
  status: "running" | "done" | "error"
  args?: unknown
  result?: unknown
  progress?: unknown
  error?: string
  seq: number
  ts: number
}
```

- embedded/remote mapper保留 session event的 args/result，並在UI boundary redaction已知 secret keys：`apiKey`、`api_key`、`token`、`authorization`、`password`。
- presentation adapter輸出typed title/summary/body而不修改原始payload；execute/read/edit/list/search/web/MCP/skill/subagent/job/todo有專門formatter，unknown走generic JSON viewer。
- running -> progress -> done/error更新同一 stable block；相鄰同檔 edit可合併，但call ids仍可追溯。

### 7.4 Structured diff

新 `@i-harness/text-diff` 公共契約：

```ts
export interface DiffLine {
  kind: "context" | "add" | "delete"
  text: string
  oldLine?: number
  newLine?: number
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface TextDiff {
  path: string
  hunks: DiffHunk[]
  added: number
  deleted: number
  truncated: boolean
}
```

- 使用成熟 line-diff library建立 hunks；預設 context 3行。
- 2 MiB或50,000 lines以上不做整檔syntax/highlight，回 context-limited/truncated representation；絕不阻塞turn完成。
- fs write/edit回傳或session presentation可取得 before/after時產生 `TextDiff`；apply_patch優先解析其patch text，無法解析時保留raw viewer。
- collapsed block顯示path與 `(+A/-D)`；expanded顯示hunk header、行號、add/delete colors；Enter開viewer，支持raw unified patch、search與copy。

## 8. Queue、Tasks/Subagents 與 Dashboard

### 8.1 Queue contract

`SessionService` 增加真實snapshot/action：

```ts
export interface SessionQueueItem {
  id: string
  text: string
  delivery: "queue" | "steer"
  intent: "user" | "system"
  state: "queued" | "running"
  order: number
}

queue(sessionId: string): SessionQueueItem[]
cancelQueued(sessionId: string, id: string): { cancelled: boolean }
```

- service-front尚未進lane的turn也必須有stable id與AbortController，cancel後promise正常settle且不執行。
- lane `pending()` rows與service-front rows合併後去重；running row固定第一，其他FIFO。
- QueuePane只顯示真prompt/system injection rows；shell/background/schedule不混入這個queue。
- edit/promote/send-now在沒有atomic backend action時不畫按鈕。M49最低交付是live rows、cancel、refresh與empty state。

### 8.2 Tasks/subagents projection

`subagent` package新增不洩漏mutable registry的projection：

```ts
export interface AgentTaskView {
  id: string
  parentId?: string
  group: "subagent" | "job" | "workflow" | "schedule"
  label: string
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
  summary?: string
  startedAt?: number
  updatedAt?: number
  canCancel: boolean
}
```

- `SessionAssembly`公開 `tasks()`與既有 kill/cancel action；`SessionService`按session轉發。
- TUI不再把subagent lifecycle降成純system文字後丟棄資料；pane按stable id更新。
- 選row開detail viewer：role/model/parent prompt/status/result/error與可取得的child transcript；disk replay不可重建時顯示原因。
- cancel只對backend `canCancel` true顯示，結果重新讀projection確認。

### 8.3 Local dashboard

- Dashboard rows來自 `BackendClient.listSessions()` + live service/model/queue/task projection，stable id為session id。
- 每row顯示可知的title、updated time、model、running/idle/error、queue count、task count；未知欄位省略。
- 支持filter、up/down、Enter open/resume、new session、peek最近turn、pin/order；pin/order只存 `tui.prefs.dashboard`。
- 不建新database、不跨機聚合、不顯示Grok leader/team欄位。
- `/dashboard`與Welcome menu共用同一view；Agent返回Dashboard時保留filter/cursor。

## 9. Settings、Theme、Modal、Status 與 Interaction

### 9.1 Typed settings registry

Settings UI 使用 declarative rows，不再以 category switch硬編 placeholder：

```ts
export type SettingsCategory =
  | "Models & Providers"
  | "Appearance"
  | "Editor & Input"
  | "Scrollback & Mouse"
  | "Sessions"
  | "Safety"
  | "Integrations"
  | "Advanced"

export interface SettingsCapabilityContext {
  has(capability: string): boolean
}

export interface SettingsContext extends SettingsCapabilityContext {
  settings: SettingsStoreSurface
  providers: ProviderRuntime
  backend: BackendClient
}

export type SettingValueKind =
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "integer"; min: number; max: number; step: number }
  | { kind: "string"; secret?: boolean }
  | { kind: "action" }
  | { kind: "dynamic-list" }

export interface SettingDefinition {
  key: string
  category: SettingsCategory
  label: string
  description: string
  valueKind: SettingValueKind
  visible(ctx: SettingsCapabilityContext): boolean
  read(ctx: SettingsContext): unknown
  preview?(ctx: SettingsContext, value: unknown): void
  commit(ctx: SettingsContext, value: unknown): Promise<void>
  rollback?(ctx: SettingsContext, previous: unknown): void
}
```

可見 categories：

1. `Models & Providers`
2. `Appearance`
3. `Editor & Input`
4. `Scrollback & Mouse`
5. `Sessions`
6. `Safety`
7. `Integrations`
8. `Advanced`

Category沒有任何 visible row時不顯示。不得用純未來承諾或 unavailable-only rows填滿分類。

Models & Providers 使用專用 master/detail flow：provider list -> provider editor/test/discovery -> model list/manual add -> default/session selection。Raw API key只在secret editor當次存在，commit後清空；畫面只顯示 credential ref與source/mask。

### 9.2 Durable UI preferences

`tui.prefs` 增加或正式消費：

```ts
screenMode: "fullscreen" | "minimal"
multiline: boolean
vimMode: boolean
statusLine: {
  mode: "disabled" | "builtin" | "command"
  items: Array<"cwd" | "branch" | "model" | "context" | "turn-timer" | "session" | "queue" | "tasks">
  command?: string
  refreshMs?: number
}
dashboard: { pinned: string[]; order: string[] }
```

現有 timestamps、compact、scrollSpeed、scrollMode、scrollLines、invertScroll、keepTextSelection、wordSeparators、mouseReportingToggle繼續沿用，但每個可見設定都要在 current app live apply，或明確標 `Applies to new sessions`；不可默默只寫檔。

### 9.3 Theme

`SettingsTheme` 擴成：

```text
system | grok-night | grok-day | tokyo-night | rose-pine-moon | oscura-midnight
```

舊 `dark -> grok-night`、`light -> grok-day` soft-normalize。五套palette都經現有 capability quantization；low-color terminal只提供可辨識的 GrokNight/GrokDay/system。Settings與 `/theme` 使用同一 preview/commit/rollback；startup讀 persisted value。Minimal從active semantic palette產生ANSI色，不另有永遠固定的配色表。

### 9.4 Modal/viewer

- 單一 active surface union管理 permission/question/settings/provider/model/session/queue-edit/confirm與viewer；不能多個 overlay互相覆蓋但都吃input。
- input優先序：confirm/permission/question -> viewer -> modal/picker -> panes -> prompt -> scrollback。
- 通用 picker支持 up/down、j/k、Enter、Esc、search/filter、Tab切區；mouse hit areas與keyboard使用同一 action。
- Block viewer支持 rendered/raw、search next/prev、copy、scroll、selection；line viewer真讀檔並定位line；task viewer顯示child/task資料。
- clipboard adapter失敗時顯示 error，不得固定回 `Copied!`。

### 9.5 Approval/question composition

- `apps/tui` 對每個新 assembly掛真 approval與question bridge並pump requests。
- One-shot approve/reject與freeform/question answer是真實；persistent Always/Never scope在 guard backend未支持前不顯示。
- `alwaysApprove`只作明確的 new-session assembly policy；變更 current session時遵守 idle rebind規則。

### 9.6 Status line

Builtin status聚合資料：workspace cwd、git branch、resolved model label、context used/total、turn timer、session title/id、queue count、task count、todo/goal。只保留有source的segment並按可用寬度由右向左drop，row高度固定1。

Command mode：

- 使用本地 exec service，cwd為workspace，JSON context從stdin輸入。
- default timeout `1000ms`，refresh default `1000ms`、minimum `300ms`。
- 只取第一個非空行，最多4096 bytes；ANSI/control chars sanitize。
- 兩次連續暫時失敗前保留上一個good value，第三次顯示一次error indicator；不能阻塞frame/event loop。

### 9.7 Mouse capture與互動

- fullscreen init啟用既有 mouse modes；runtime toggle同時發enable/disable bytes、清hover/drag state並切換app routing。
- capture off後terminal native selection恢復；minimal永遠off。
- hover不改變時保持zero-byte idle；visible cursor control不計作重畫但也只在state變化時輸出。
- link/file/tool/task/status/pane actions必須有真callback；沒有callback就不建立hit area。

## 10. Slash Command Contract

### 10.1 Registry規則

每個 command 定義：`name/aliases/description/argumentHint/visible/run`。`visible` 同時檢查 active view、screen mode、session存在、backend capability與feature setting。Dropdown只列 visible commands；submitted hidden/unknown command進 error path，絕不成為 user prompt。

### 10.2 必須交付

| Group | Commands | 真實 action |
|---|---|---|
| Session | `/new` `/home` `/resume` `/dashboard` `/rename` `/session-info` | backend create/open/list/meta/dashboard |
| Conditional session | `/fork` `/compact` `/context` `/rewind` | capability存在才顯示 |
| Navigation | `/find` `/jump` `/history` `/edit-prompt` | scrollback/editor/file viewer |
| Runtime panes | `/queue` `/tasks` | backend projections；沒有rows仍顯示真empty state |
| Model/settings | `/settings` `/provider` `/model` `/effort` | provider-runtime與session metadata |
| Appearance/input | `/theme` `/timestamps` `/multiline` `/compact-mode` `/minimal` `/fullscreen` | live setting + persist |
| Conditional editor/safety | `/vim-mode` `/always-approve` | live capability完成才顯示 |
| Local tools | `/doctor` `/copy` `/export` `/transcript` `/help` `/quit` | 真probe/clipboard/file/process/lifecycle |
| Inventories | `/skills` `/mcps` `/hooks` `/plugins` `/marketplace` `/workflow` `/workflows` | production來源；未mount狀態要明示 |
| Local info | `/usage` `/goal` `/tutorial` | context/session goal/local docs；不含account quota |

`/plan`、`/view-plan`、`/auto` 只有在 live backend switching/guardian capability完成時才加入 visible集合；M49不得保留目前只改 UI state的假實作。

### 10.3 永久排除於 M49

`/login`、`/logout`、`/share`、`/privacy`、`/import-claude`、`/remember`、`/recap`、`/dream`、`/flush`、`/loop`、`/voice`、`/imagine`、`/imagine-video`、`/gboom`、`/cd`、`/delete`與account `/usage manage`。

## 11. System Prompt Contract

Default prompt由 `preset` package提供可測的 template，`session-executor`組裝：

```text
default I-harness base
then project instructions/runtime context
then tool/skill/MCP catalogs
then plan-mode fragment when real mode active
then role/persona only when backend真的選定
```

Base contract必須包含：

- 身份：I-harness local coding agent，不宣稱Grok/xAI/OpenAI account能力。
- 先讀現有repo與規範，按既有pattern最小修改。
- tool與approval/sandbox語義；不假裝執行未執行的action。
- 遇bug先重現與追根因；feature/bugfix走test-first；完成前做verification。
- 使用subagent時清楚scope、ownership、結果整合，不重複工作。
- 長任務提供短而具體的進度更新；final回報變更、驗證與未完成項。
- 不把production mock、placeholder、hardcoded UI值當真實能力。

Project rules與human instructions保持最高優先；default prompt不可覆蓋使用者明確要求。Readable source是authoritative，不做Grok式obfuscation。

## 12. Error 與安全語義

- Model unconfigured/invalid：不build assembly、不submit；Welcome/Agent顯示原因與Settings action。
- Discovery network/auth/shape failure：保留現有settings，顯示每個candidate的摘要；不清空已存model list。
- Settings persist failure：rollback live preview並保留editor input供重試。
- Queue/task cancel競態：backend結果為準；已完成回 `already-finished`，UI refresh。
- Viewer/diff parse failure：回raw payload，不丟tool result。
- Remote capability/version不足：command/segment/action隱藏或明確 unavailable，不用local假資料補。
- Secret值不得進settings、status、tool summary、logs或snapshot；known secret fields在presentation boundary redact。
- Status command與external editor/pager沿用exec lifecycle/timeout；退出TUI前等待或終止owned child。

## 13. 驗證契約

### 13.1 TDD與focused tests

- 每個production behavior先有能在舊code失敗的test，再最小實作。
- provider-runtime：canonical migration、auth source、Bedrock ambient、discovery auth/shape/manual model、resolution precedence、no mock。
- session-executor：required model、binding metadata、idle rebind、queue rows/cancel、task projection。
- editor/tui-core：grapheme editing、undo/redo、cursor position/visibility、capture bytes與zero-byte idle。
- tool/diff：real fs tool -> session event -> TUI block/viewer integration，含large-file fallback與secret redaction。
- settings/theme/status：preview/commit/rollback、startup persist、command timeout/sanitize。
- slash：每個visible command有真capability test；hidden/unknown永不submit。

### 13.2 PTY cases

- `case-024`：bare Welcome、unconfigured gate、Settings入口、配置後submit。
- `case-025`：visible cursor、CJK/emoji/combining、movement、undo/redo、resize。
- `case-026`：real execute/read/edit/apply_patch typed blocks與diff viewer。
- `case-027`：live queue rows/cancel、subagent/tasks、dashboard open/peek。
- `case-028`：production minimal無alt-screen/mouse bytes、theme persist、modal/status/slash capability。

PTY保留現有 byte budgets、zero-byte idle、resize與UTF-8/codepage gate。測試不依賴外網；provider discovery用local HTTP fixture或injected transport。可另記錄真provider手動smoke，但不是CI成功條件。

### 13.3 Final verification

```text
pnpm typecheck
pnpm test
pnpm e2e
node scripts/build-dist.mjs
node scripts/verify-dist.mjs
node scripts/build-installer.mjs
node scripts/verify-installer.mjs
```

另單獨跑 `packages/tui`、`apps/tui`、`apps/cli`、`packages/session-executor`、`packages/provider-runtime`、`packages/text-diff`，並確認 `git diff --check`、無未追蹤generated output、無 production `mock-model`/`falling back to the mock`文字。

## 14. 交付切片

1. Canonical provider-runtime、auth boundary、production model policy與cross-platform baseline。
2. Welcome/startup、session model binding、settings Models & Providers。
3. Prompt editor、visible cursor、minimal production split與theme persistence。
4. Typed tool events、text-diff、viewer/modal與real clipboard/file view。
5. Queue、tasks/subagents、dashboard與status aggregation。
6. Slash capability registry、system prompt、interaction parity、PTY/e2e/dist/docs收尾。

每個切片都需獨立TDD、focused verification、commit、spec compliance review與code quality review；最後做whole-branch review。

## 15. 完成定義

- Bare production TUI在零設定時不能完成任何LLM turn，且畫面清楚引導Settings。
- 配置任一真provider/model後，embedded與spawned SDK TUI均使用同一 resolved binding，顯示與實際client一致。
- Provider settings只有一份canonical persisted truth；舊TUI設定可soft-migrate。
- 所有本spec列入的pane/view/command/action都由真backend或本地真source驅動；fixture-only與toast-only路徑已移除或隱藏。
- Welcome、editor/cursor、scrollback/minimal、tool/diff、queue/tasks/dashboard、settings/theme/modal/status/interaction與system prompt均有unit + integration/PTY證據。
- Final verification全綠，final reviewer沒有Critical或Important finding。
