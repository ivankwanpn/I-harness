# I-harness 七源命令級對比矩陣（2026-09-11）

> 基準：I-harness `m62` @ `a3487952` · 方式：機械抽取命令註冊點 ＋ 逐源並行子代理補機制 ＋ 對抗式引註驗證

本文件是**嚴格聯集**的命令級對比：七個 harness 的每一個命令各佔一列，欄位為各源是否有此命令、實作機制、以及對 I-harness 的處置建議。姊妹文件為 `docs/audit/2026-09-11-ih-backend-inventory.md`（I-harness 後端逐包盤點）。

## 七源身份表（版本為本次實測，非目錄名）

| # | 源 | 路徑 | 語言／棧 | 命令模型 | 命令數 |
|---|---|---|---|---|---|
| 1 | **I-harness** | `D:\I-harness-main`（`m62`） | TS ESM strict、零外部依賴 | 集中 registry ＋ 能力門控 | **50** |
| 2 | **dsh** | `D:\agent-complete\deepseek-harness-dsh-v0.1.5-rc.2` | TS、Cordis 外掛 | 每包一命令 ＋ 領域包內聯註冊 | **6** |
| 3 | **codex-rust** | `D:\agent-complete\codex-rust-v0.149.1` | Rust 2024（104 crates） | 集中 enum ＋ dispatch | **58** |
| 4 | **opencode** | `D:\agent-complete\opencode-1.18.30` | Bun ＋ Effect 4 | 內建 2 ＋ 使用者/config markdown | **2** |
| 5 | **opencode-fork** | `D:\agent-complete\opencode-fork-private-999.0.15` | 同上（fork） | 同上；registry 改為 source-composed | **2** |
| 6 | **grok-build** | `D:\agent-complete\grok-build-main` | Rust | 一命令一模組（三種宣告形式） | **71** |
| 7 | **cc-custom** | `D:\opencode-bugfix\cc-custom` | TS（Claude Code 系） | 中央 `commands.ts` ＋ 巢狀目錄 | **67** |

**版本陷阱（實測）**：`opencode-fork-private-999.0.15` 的 `package.json` 是 **999.0.19**。目錄名不等於版本，本表一律採 manifest。抽取腳本會自動對此發出警告。

## 讀這張表之前必須知道的三件事

### 1. 七源在命令層**根本不同構**

這不是修辭，是算術。命令數從 **2 到 71**，因為「命令」在七個專案裡是**不同的東西**：

- **dsh 只有 6 個 slash 命令**，因為它的命令面主要不在 slash——它用 Typert `@Remote` RPC 平面（`session.*`、`commands.list/execute`、`subagent.*`、`goals.*`…）加上瀏覽器 `/` 選單，兩者都坐在四個 in-process Agent 投遞層（`send`／`followup`／`steer`／`inject`）之上。CLI 只是啟動器。
- **opencode 只靜態註冊 2 個命令**（`init`、`review`）。其餘命令是**使用者與設定以 markdown 模板在執行期定義**的資料，另有 MCP prompt 與 skill 進場。它的命令面是「資料」而非「程式」。
- **grok 有 71 個**，且其中約 25 個（`cd`、`delete`、`login`、`logout`、`share`、`privacy`、`remember`、`recap`、`voice`、`imagine`、`personas`、`import-claude`、`release-notes`、`announcements`、`gboom`、`expand`、`loop`、`debug`、`scroll-debug`…）是 I-harness **刻意不註冊**的。

因此：**「✗」不等於缺陷，「—」不等於不支援**。dsh 沒有 `/compact` 之外的幾十個命令，是因為它壓根不採用那種命令面；把它讀成「dsh 功能少」是誤讀。

### 2. 異名對帳（crosswalk）是這張表的智力核心

`/compact`（IH、grok、cc-custom）、`command-compact`（dsh）、`Compact`（codex enum）、markdown 模板（opencode）**是同一件事**。沒有對帳規則，聯集會重複計數、parity 欄會說謊。本表的規則：

- `canonical name` 取該能力最常見的 kebab-case 人臉名。
- 名字正規化**刻意保守**：只做大小寫、分隔符、dsh 的 `command-` 前綴。任何語意性合併（去掉動詞、單數化）都**不做**，因為那正是會靜默合併兩個不同命令的猜測。
- 對不上的**不硬湊**，各自成列並進附錄 B。

**已抓到並修正的對帳事故**（記於此以免重演）：codex 的 `Btw` 與 `Side` 曾被雙雙正規化為 `side-conversation`，這會**靜默丟掉一個命令**，並讓 I-harness 自己的 `/btw` 列失去 codex 欄位。現在同源碰撞會退回各自的名字並回報。

### 3. codex 的「命令名」有兩個不同的概念

`SlashCommand::command()` 是 `IntoStaticStr`，所以**顯示名**是 `to_string` > `serialize` > `serialize_all(kebab)`；而 `EnumString` 的**可解析名**是 `serialize` ∪ `to_string`（兩者都有時都可解析；只有 `to_string` 時**只有它可解析**）。兩者會分歧：

| 變體 | 顯示名 | 可解析名 |
|---|---|---|
| `AutoReview` | `approve` | `approve`（`auto-review` **不可解析**） |
| `Stop` | `stop` | `clean`、`stop` |
| `Pwd` | `pwd` | `cwd`、`pwd` |
| `Pets` | `pets` | `pet`、`pets` |

本表採**顯示名**為命令名，可解析別名記於該源的附錄 A。抽取器早期版本誤用 `serialize_all` 推導，**發明了無法被呼叫的 `auto-review`**；由 repo 內測試 `auto_review_command_is_approve` 證實並修正。

## 方法與驗證

1. **機械抽取**（`scripts/audit/extract-commands.mjs`）：逐源解析**權威註冊點**，非檔名、非 README。grok 的檔名不是命令名（`plugin.rs` 宣告 4 個、`screen_mode_switch.rs` 建構 2 個），抽取器並與 `builtin_commands()` 交叉核對，數量不符即**拋錯拒絕產出**。
2. **逐源補機制**（7 個並行子代理，一源一代理）：每個命令補上家族、摘要、機制、閘門、後端模組、`file:line`。硬規則：**無出處即標未驗證**。
3. **聯集折疊**（`scripts/audit/lib-union.mjs`）：**結構不經 LLM**，可重跑、可 diff。
4. **對抗式驗證**：無利益關係的獨立代理抽樣重讀原文，判定引註是否真的支撐主張。

| 關卡 | 結果 |
|---|---|
| 聯集列數 | **147** 列（50 列含 IH 欄位；**97 列為參考源獨有**） |
| 引註（機械） | 985 條主張 / **3,047** 條引註，**全部解析成功，0 越界、0 空白行** |
| 引註（對抗第一輪） | 抽 27 格：**0 條造假或過期行號**，但 4 條引註位置承載不了主張（已修正） |
| 引註（對抗第二輪） | 抽 22 格：`SUPPORTED 9 / PARTIAL 7 / WRONG_LINE 4 / UNSUPPORTED 0 / UNCERTAIN 2`。**又是 0 條造假或過期行號** |
| **合計** | 兩輪 49 格、**35 格可評分**、**UNSUPPORTED 0** |
| 載體分佈 | 786 條機制主張的領頭引註：implementation **47%** ／ registry-listing 37% ／ doc-comment 10% ／ alias 3% ／ type-decl 3% |

**關於載體分佈**：兩輪驗證都發現同一件事——**行號從來沒錯，錯的是那行承載不了主張**。11 個非 SUPPORTED 的格子全部落在三種形狀：manifest 條目、registry/exports 清單、同檔輔助函式或裸 alias。本表顯示時採**可得的最佳載體**，但上表量測的是原始資料：**不到一半的機制主張，其領頭引註是實作它的程式碼**。

**第一輪對抗驗證抓到的實例**（詳見姊妹文件的驗證記錄）：dsh `/goal` 的機制主張曾引到 `packages/bundle/web-app/cordis.patch.yml:411`——一條 bundle manifest 條目，**下一行是 `disabled: true`**，讀成證據反而在說該外掛被關掉了。

## 處置詞彙（disposition）

| 值 | 意義 |
|---|---|
| `已存在` | I-harness 已實作此列。**不發明工作。** |
| `improved-writing` | IH 有，且其做法不遜於任何參考源——指示是「保留，不要退步」。 |
| `reuse` | IH 沒有，但某參考源的實作夠乾淨，可直接採用或緊密參考。 |
| `rewrite` | IH 沒有，但概念值得有——以 I-harness 自身的語彙重寫（TS ESM、零外部依賴紀律、fail-closed 文化），不是移植。 |
| `遠期` | 產品級或大工程；真實但不在此刻。 |
| `不做` | 與 I-harness 的既定原則衝突。 |
| `路線差異` | 該源的缺席反映**不同的設計哲學**，不是 I-harness 的缺口。 |

**已尊重的 I-harness 既定立場**（視為約束，不在本次重新爭辯）：不做 PTC/run_code；不執行外掛程式碼；不預設任何 LLM provider；實務上維持零外部依賴；Windows 優先；寧可誠實失敗也不要靜默降級；壓縮採 append-only。

---

以下是聯集矩陣本體。

## 圖例

| 符號 | 意義 |
|---|---|
| `✓` | 該源有此命令，語意相同 |
| `✗` | 該源有此命令層，但沒有這個命令 |
| `—` | 該源的命令模型不提供靜態內建（見下），「無」不等於「不支援」 |

> `—` 只用於 **opencode / opencode-fork**：它們靜態註冊的內建命令僅 2 個（`init`/`review`），其餘命令由使用者與設定以 markdown 模板在執行期定義。因此這兩欄的「無」是**命令模型差異**，不是功能缺口。其餘五源皆有可枚舉的靜態命令表，缺席記為 `✗`。

## 會話生命週期（`session`，15 列）

| 命令 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | 機制／出處 | disposition |
|---|---|---|---|---|---|---|---|---|---|
| `archive` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | dispatch 先顯示 SelectionView 確認（'Yes, archive and exit'），選項 action 送 AppEvent::ArchiveCurrentThread（slash_dispatch.rs:183-211）。事件由 app/event_dispatch.rs:281 處理。available_during_task() 為 false，任務進行中會被 sl `codex-rs/tui/src/slash_command.rs:34` | **rewrite** — 仿 codex 歸檔退出；後端已有 |
| `branch` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/branch/branch.ts `call` (line 223) delegates to the private `createFork` (line 62), which reads the current transcript, filters to non-sidechain messages with isTranscriptMessage, rewrite `src/commands/branch/index.ts:6` | **路線差異** — IH /fork 已做同一件事 |
| `cd` | ✗ | ✗ | ✓ | — | — | ✓ | ✗ | bare 形式在 dispatch 內遞迴呼叫帶參數版本並帶入 '~'（slash_dispatch.rs:468-470）；帶參數走 request_working_directory_change（slash_dispatch.rs:710）。前置條件由 can_change_working_directory 檢查：必須是同一 thread、非側聊、非 blocks_direct_input `codex-rs/tui/src/chatwidget/slash_dispatch.rs:468` | **不做** — §10.3 明文排除 /cd |
| `clear` | ✗ | ✗ | ✓ | — | — | ✗ | ✓ | bare 送 AppEvent::ClearUi { name: None }（slash_dispatch.rs:240-242）；帶參數送 AppEvent::ClearUi { name: Some(trimmed) }（slash_dispatch.rs:773-777）。事件在 app/event_dispatch.rs:144 處理。available_during_task() 為  `codex-rs/tui/src/slash_command.rs:73` | **路線差異** — IH 以 /new 表達，不設別名 |
| `delete` | ✗ | ✗ | ✓ | — | — | ✓ | ✗ | dispatch 顯示確認 SelectionView，subtitle 明示 'Cannot be undone. Subagent threads will also be deleted.'，確認項送 AppEvent::DeleteCurrentThread（slash_dispatch.rs:212-239），由 app/event_dispatch.rs:284 處理。!availab `codex-rs/tui/src/slash_command.rs:35` | **不做** — 無 durable delete API，排除 |
| `exit` | ✗ | ✗ | ✓ | — | — | ✗ | ✓ | 與 /quit 共用 arm：Quit \| Exit => request_quit_without_confirmation()（slash_dispatch.rs:398-400；chatwidget.rs:1408）。兩者描述同為 'exit Codex'（slash_command.rs:101）。 `codex-rs/tui/src/chatwidget/slash_dispatch.rs:398` | **路線差異** — IH 以 /quit 表達，不設別名 |
| `feedback` | ✗ | ✓ | ✓ | — | — | ✓ | ✗ | Exports `name = 'command-feedback'` and `inject = ['commands']`; `apply()` registers `/feedback` with `input: { hint: '<text>' }` and `recordInput: false` so the invocation payload is not duplicated i `packages/feedback/command-feedback/src/index.ts:39` | **rewrite** — 仿 dsh 日誌級回饋，不外送 |
| `fork` | ✓ | ✗ | ✓ | — | — | ✓ | ✗ | Registered in sessions.ts:56-72, visible() = hasCapability(ctx,'fork') (sessions.ts:63). run() guards on the optional ctx.fork member ('fork: backend fork seam absent') and otherwise passes an optiona `packages/tui/src/app/slash/impl/sessions.ts:56-72` | **已存在** — IH 已實作 |
| `login` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() returns `Action::Login` (login.rs:13-15); the dispatcher owns the interactive flow. Auth state feeds other command gates: `AppView::apply_auth_meta` calls `apply_tier_restrictions`, which recomp `crates/codegen/xai-grok-pager/src/slash/commands/login.rs:8` | **不做** — §10.3 排除；無帳號層 |
| `logout` | ✗ | ✗ | ✓ | — | — | ✓ | ✗ | dispatch 送 AppEvent::Logout（slash_dispatch.rs:401-403）；由 app/event_dispatch.rs:661 以 app_server.logout_account() 執行。!available_during_task（slash_command.rs:225）。 `codex-rs/tui/src/chatwidget/slash_dispatch.rs:401-403` | **不做** — §10.3 排除；無帳號層 |
| `new` | ✓ | ✗ | ✓ | — | — | ✓ | ✗ | Registered in sessions.ts:15-26, visible() = hasCapability(ctx,'session-create') (sessions.ts:18). run() guards on the optional ctx.createSession member, toasting 'new session: backend create seam abs `packages/tui/src/app/loop.ts:2520` | **已存在** — IH 已實作 |
| `rename` | ✓ | ✗ | ✓ | — | — | ✓ | ✓ | Registered ungated in sessions.ts:87-105. With an argument run() calls ctx.renameSession(title) directly (sessions.ts:94); without one it opens a bindTextInput overlay prefilled with app.title whose s `packages/tui/src/app/loop.ts:2494` | **已存在** — IH 已實作 |
| `resume` | ✓ | ✗ | ✓ | — | — | ✓ | ✓ | Registered in sessions.ts:34-41, visible() = hasCapability(ctx,'session-list') (sessions.ts:37). run() calls ctx.openSessions() (sessions.ts:39), wired in the loop (loop.ts:2454-2456) to toggle the se `packages/tui/src/app/slash/impl/sessions.ts:37` | **已存在** — IH 已實作 |
| `session-info` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in sessions.ts:106-125. run() probes the OPTIONAL backend.context member with a catch-to-undefined (sessions.ts:110) and opens the 'session-info' panel built by sessionInfoRows with `packages/tui/src/app/slash/impl/sessions.ts:110` | **已存在** — IH 已實作；缺值誠實省略 |
| `tag` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/tag/tag.tsx `call` dispatches on arguments: info/help or empty arguments render `<ShowHelp>` (lines 207-212), otherwise `<ToggleTagAndClose tagName={args} />` (line 213). That component r `src/utils/sessionStorage.ts:2331` | **遠期** — ant-only 標籤；IH 有 FTS 查詢 |

## 上下文與壓縮（`context`，12 列）

| 命令 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | 機制／出處 | disposition |
|---|---|---|---|---|---|---|---|---|---|
| `auto-compact-window` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | Declared twice in src/commands/limit-controls.ts: the interactive `autoCompactWindow` (lines 274-284, `type: 'local-jsx'`) and `autoCompactWindowNonInteractive` (lines 286-299, `type: 'local'`). Both  `src/services/compact/autoCompact.ts:41` | **rewrite** — 仿 cc：設定自動壓縮窗 |
| `compact` | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | Registered in run.ts:25-42, visible() = hasCapability(ctx,'compact') (run.ts:29). run() first guards on the OPTIONAL BackendClient.compact member and toasts 'compact: backend seam absent (session-comp `packages/tui/src/backend/embedded.ts:822` | **rewrite** — 引擎 append-only，缺 host 接線 |
| `context` | ✓ | ✗ | ✗ | — | — | ✓ | ✓ | Registered in sessions.ts:73-86, visible() = hasCapability(ctx,'context') (sessions.ts:78). run() guards on the optional SlashContext.openContext member and toasts 'context: backend context seam absen `packages/tui/src/app/loop.ts:2528` | **已存在** — IH 已實作 |
| `files` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/files/files.ts `call` (line 7) reads `context.readFileState` through `cacheKeys()` (line 11) and returns a text result joining paths relativised with `relative(getCwd(), file)` (line 17), `src/commands/files/index.ts:5` | **rewrite** — 仿 cc 列已讀檔，日誌推導 |
| `ide` | ✗ | ✗ | ✓ | — | — | ✗ | ✓ | bare dispatch 呼叫 handle_ide_command：切換 self.ide_context 的 enable/disable 並同步狀態指示（slash_dispatch.rs:482-484；ide_context.rs:34-43）。帶參數支援 on/off/status（ide_context.rs:45-64）。真正的 context 注入在送出 user turn 前 `codex-rs/tui/src/chatwidget/slash_dispatch.rs:482` | **遠期** — 需編輯器擴充，規模大 |
| `init` | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | dispatch 以 include_str!('../../prompt_for_init_command.md') 取得固定提示（常數 INIT_PROMPT），直接 submit_user_message 成一般使用者訊息，讓模型自己去產生 AGENTS.md（slash_dispatch.rs:260-263）。!available_during_task（slash_command.rs `codex-rs/tui/src/slash_command.rs:39` | **reuse** — 仿 codex：內建提示直接送 |
| `memories` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | dispatch 呼叫 open_memories_popup（slash_dispatch.rs:395-397）。若 Feature::MemoryTool 未開，改開啟用提示，'yes' 送 AppEvent::UpdateFeatureFlags{MemoryTool:true} 並提示需要新 session 才生效（chatwidget.rs:1110-1146）。已開啟時建立 Memo `codex-rs/tui/src/chatwidget/slash_dispatch.rs:395` | **不做** — 記憶族為 §10.3 排除項 |
| `memory` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/memory/memory.tsx `call` (line 83) calls `clearMemoryFileCaches()` then awaits `getMemoryFiles()` (lines 86-87, src/utils/claudemd.ts:790, memoized) to prime the list, and renders a Dialo `src/commands/memory/memory.tsx:33` | **rewrite** — IH 載入 AGENTS.md，缺編輯入口 |
| `mention` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | dispatch 只呼叫 self.insert_str('@')（slash_dispatch.rs:440-442；chatwidget.rs:1760），把 @ 放進 composer 以觸發 mention 選單；實際 mention 編碼／解碼在 tui/src/mention_codec.rs 與 codex-rs/utils/plugins 的 mention_syntax。avai `codex-rs/tui/src/chatwidget/slash_dispatch.rs:440` | **rewrite** — 仿 codex：@ 觸發檔案選單 |
| `recap` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() returns `Action::SendRecap{auto: false}` (recap.rs:21-23). Dispatch emits `Effect::SendRecap` (app/dispatch/notes.rs:799), which fires the ACP ext method `x.ai/recap` with sessionId and auto=fal `crates/codegen/xai-grok-pager/src/app/dispatch/notes.rs:783` | **不做** — §10.3 明文排除 /recap |
| `remember` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() returns `Action::EnterRememberMode` for empty args and `Action::SendRememberNote(text)` otherwise (remember.rs:16-23). Dispatch special-cases the note action into `send_remember_note`, which ope `crates/codegen/xai-grok-shell/src/extensions/memory.rs:68` | **不做** — §10.3 明文排除 /remember |
| `usage` | ✓ | ✗ | ✓ | — | — | ✓ | ✗ | Registered ungated in surfaces.ts:15-29. run() awaits the OPTIONAL backend.context member with catch-to-undefined (surfaces.ts:22) and opens the 'usage' panel titled 'Usage · this session' with usageR `packages/tui/src/app/slash/impl/surfaces.ts:22` | **已存在** — IH 已實作 session 用量；帳號面不做 |

## 計劃與目標（`plan`，3 列）

| 命令 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | 機制／出處 | disposition |
|---|---|---|---|---|---|---|---|---|---|
| `goal` | ✓ | ✓ | ✓ | — | — | ✗ | ✗ | Registered ungated in surfaces.ts:37-43; run() opens the 'goal' light panel with rows built by goalRows(ctx.app.status.goal) (surfaces.ts:41). The value is not probed from the backend at run time — it `packages/tui/src/app/slash/impl/surfaces.ts:41` | **已存在** — IH 已實作（事件＋面板） |
| `plan` | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | Registered in run.ts:43-53 with visible() = hasCapability(ctx,'plan-mode') (run.ts:49). The run body is a single toast, 'plan: live backend switching capability not wired' (run.ts:51) — the M46a UI-st `packages/tui/src/app/loop.ts:2419` | **rewrite** — 引擎已有，缺 TUI 模式切換 |
| `view-plan` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered in run.ts:54-61 with visible() = hasCapability(ctx,'plan-mode') (run.ts:57). The run body is the same toast as /plan, 'plan: live backend switching capability not wired' (run.ts:59). 'plan- `packages/tui/src/app/loop.ts:2460` | **已存在** — IH 已有計畫面板（chip） |

## 執行控制（`execution`，11 列）

| 命令 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | 機制／出處 | disposition |
|---|---|---|---|---|---|---|---|---|---|
| `code-review` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | A prompt command with no `load`; its builder module is imported eagerly at index.ts:2. src/commands/code-review/code-review.tsx defines CODE_REVIEW_PROMPT (line 3), interpolating user-supplied paths w `src/commands/code-review/index.ts:5` | **rewrite** — 仿 cc：送審查提示（diff） |
| `commit` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | A prompt command defined entirely in the declaration file (no `load`). `getPromptForCommand` (commit.ts:65) calls getPromptContent (line 12), which embeds live shell substitutions (`!`git status``, `g `src/commands/commit.ts:58` | **rewrite** — 仿 cc：提示走既有審批 |
| `commit-push-pr` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | A prompt command defined in its declaration file. `getPromptForCommand` (commit-push-pr.ts:119) resolves the default branch with `await getDefaultBranch()` and PR attribution with `await getEnhancedPR `src/commands/commit-push-pr.ts:109` | **rewrite** — 依賴 git/PR 整合，成本較高 |
| `imagine` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | The name comes from a constant, not a literal: `name: IMAGINE_COMMAND_NAME` (imagine.rs:14), defined as "imagine" in crates/codegen/xai-grok-tools-api/src/slash_commands.rs:102. run() returns `Message `crates/codegen/xai-grok-tools-api/src/slash_commands.rs:99` | **不做** — IH 無影像生成，明文排除 |
| `imagine-video` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | Like `/imagine`, the name is a constant: `name: IMAGINE_VIDEO_COMMAND_NAME` (imagine_video.rs:15), defined as "imagine-video" in crates/codegen/xai-grok-tools-api/src/slash_commands.rs:108. run() mirr `crates/codegen/xai-grok-tools-api/src/slash_commands.rs:105` | **不做** — IH 無影像生成，明文排除 |
| `loop` | ✗ | ✗ | ✗ | — | — | ✓ | ✓ | run() returns `CommandResult::InjectSkill` with `display_as_skill: false`: it builds a `prompt_blocks` text from `loop_schedule_instruction(args, fire_mode)` while `display_text` is the literal `/loop `crates/codegen/xai-grok-pager/src/app/dispatch/prompt.rs:721` | **不做** — §10.3 明文排除 /loop |
| `ps` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | dispatch 呼叫 add_ps_output（slash_dispatch.rs:500-502），實作把 self.unified_exec_processes 映射成 UnifiedExecProcessDetails{command_display, recent_chunks} 後寫 history cell（chatwidget.rs:1470-1480）。資料源是 TUI 追蹤的 `codex-rs/tui/src/chatwidget/slash_dispatch.rs:500` | **rewrite** — 仿 codex：列已追蹤程序 |
| `review` | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | bare dispatch 呼叫 open_review_popup 並在 MCP 啟動中就先把輸入延後（slash_dispatch.rs:276-281）。popup 提供四個 preset：Review against a base branch（開分支挑選）、Review uncommitted changes（直接送 ReviewTarget::UncommittedChanges）、R `codex-rs/core/src/tasks/review.rs:36` | **rewrite** — 仿 codex：子代理審查變更 |
| `rewind` | ✓ | ✗ | ✗ | — | — | ✓ | ✓ | Registered in run.ts:17-24, visible() = hasCapability(ctx,'rewind') (run.ts:20). run() calls ctx.openRewind() (run.ts:22), wired to Loop.openRewind (loop.ts:2458, implemented at loop.ts:3727-3742): it `packages/tui/src/app/loop.ts:2458` | **improved-writing** — IH 還原檔案＋對話，優於 grok |
| `stop` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | 兩段式註冊：serialize 'clean'＋to_string 'stop'，故 `/clean` 與 `/stop` 都可解析（slash_command.rs:71、slash_commands.rs:201-207），popup 顯示 stop。dispatch 呼叫 clean_background_terminals（slash_dispatch.rs:503-505），它 subm `codex-rs/tui/src/chatwidget/slash_dispatch.rs:503` | **rewrite** — 仿 codex：停背景程序並清單 |
| `workflow` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered in workflow2.ts:131-177 with the 'workflows' alias (workflow2.ts:134). run() resolves ctx.workflow and toasts 'workflow: surface not wired' if absent (workflow2.ts:138-141); 'run <name>' va `packages/tui/src/app/loop.ts:2517` | **已存在** — IH 已實作 |

## 模型與供應商（`model`，9 列）

| 命令 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | 機制／出處 | disposition |
|---|---|---|---|---|---|---|---|---|---|
| `context-window` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | Declared twice in src/commands/limit-controls.ts: the interactive `contextWindow` (lines 220-230, `type: 'local-jsx'`) and `contextWindowNonInteractive` (lines 232-245, `type: 'local'`); both `load` i `src/commands/limit-controls.ts:176` | **rewrite** — IH 有解析鏈，缺命令面 |
| `effort` | ✓ | ✗ | ✗ | — | — | ✓ | ✓ | Registered in g1.ts:45-66, visible() = hasCapability(ctx,'provider-settings') (g1.ts:49). A bare /effort calls ctx.effort?.('') to report the current level (g1.ts:56-59); an unknown level is rejected  `packages/tui/src/app/loop.ts:2510` | **已存在** — IH 已實作 |
| `fast` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | fast.tsx `call` (line 248) handles 'on'/'off' through handleFastModeShortcut() (line 226) and otherwise renders FastModePicker. Both converge on `applyFastMode` (fast.tsx:16), which calls clearFastMod `src/commands/fast/fast.tsx:16` | **路線差異** — provider 商業分層，IH 無此概念 |
| `max-output` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | Declared twice in src/commands/limit-controls.ts: the interactive `maxOutput` (lines 247-257, `type: 'local-jsx'`) and `maxOutputNonInteractive` (lines 259-272, `type: 'local'`); both `load` inline wi `src/commands/limit-controls.ts:191` | **rewrite** — 同 context-window，缺命令面 |
| `model` | ✓ | ✗ | ✓ | — | — | ✓ | ✓ | Registered in g1.ts:28-36, visible() = hasCapability(ctx,'provider-settings') (g1.ts:32). The run body is a single forwarding call ctx.model?.(ctx.arg.trim()) (g1.ts:34) — the registry entry is the in `packages/tui/src/app/loop.ts:3463` | **已存在** — IH 已實作 |
| `personality` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | dispatch 呼叫 open_personality_popup（slash_dispatch.rs:291-294）。popup 先檢查 session 已設定、且 current_model_supports_personality()，否則報錯；選項為 Personality::Friendly/Pragmatic（settings_popups.rs:19-87）。每個選項的 acti `codex-rs/tui/src/chatwidget/slash_dispatch.rs:291` | **路線差異** — IH 走 preset，非執行期切換 |
| `protocol` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/protocol/protocol.tsx `call` (line 150): info arguments render ShowProtocolAndClose; 'messages'\|'responses' renders SetProtocolAndClose, whose effect sets AppState `{ protocol }` via set `src/commands/protocol/index.ts:8` | **路線差異** — IH 協定屬 provider 設定 |
| `provider` | ✓ | ✗ | ✗ | — | — | ✗ | ✓ | Registered in g1.ts:19-27, visible() = hasCapability(ctx,'provider-settings') (g1.ts:23); the run body forwards ctx.provider?.(arg) (g1.ts:25). The live path is the text interception: tryG1SlashModal  `packages/tui/src/app/loop.ts:3202` | **已存在** — IH 已實作 |
| `settings` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered in g1.ts:37-44, visible() = hasCapability(ctx,'provider-settings') (g1.ts:40); the run body forwards ctx.openSettings?.() (g1.ts:42). The live path is the interception: tryG1SlashModal matc `packages/tui/src/app/loop.ts:3387` | **已存在** — IH 已實作 settings modal |

## 權限與安全（`safety`，12 列）

| 命令 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | 機制／出處 | disposition |
|---|---|---|---|---|---|---|---|---|---|
| `add-dir` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | The lazily loaded backend src/commands/add-dir/add-dir.tsx exports `call`, which validates the path with validateDirectoryForWorkspace (validation.ts:31) and then uses the inner helper handleAddDirect `src/commands/add-dir/add-dir.tsx:80` | **路線差異** — cc 以權限規則擴目錄；IH 單根 |
| `always-approve` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered in approval.ts:23-31 with visible() = hasCapability(ctx,'guardian') (approval.ts:27); the gate is a hard gate in CommandRegistry.matches (registry.ts:107). run() calls applyStance(ctx,true) `packages/tui/src/app/loop.ts:2513` | **已存在** — IH 已實作；guardian 閘未開 |
| `approve` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | 命令字面值修正：variant 只有 #[strum(to_string='approve')]（slash_command.rs:25-26），無 serialize，EnumString 只註冊 to_string，因此使用者要打 `/approve`；`auto-review` 不可解析（slash_command.rs:321-327 的測試即斷言 from_str('approve')） `codex-rs/core/src/session/handlers.rs:695` | **rewrite** — codex 列近期拒絕並注入重試 |
| `auto` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered in approval.ts:32-39 gated on the same 'guardian' capability (approval.ts:35) and routed through the identical applyStance helper as /always-approve (approval.ts:36-38 -> approval.ts:14-21) `packages/tui/src/app/slash/impl/approval.ts:35` | **已存在** — IH 已實作；同 always-approve |
| `permission` | ✗ | ✓ | ✗ | — | — | ✗ | ✗ | Registered by the permission-presets package itself, not by a `command-*` package: `ctx.inject(['commands'], commandCtx => commandCtx.commands.register({ name: 'permission', ... }))`. The handler retu `packages/client/ui-commands/src/client/service.ts:68` | **rewrite** — dsh preset 一命令切政策 |
| `permissions` | ✗ | ✗ | ✓ | — | — | ✗ | ✓ | dispatch 呼叫 open_permissions_popup() + defer_input_until_settings_applied()（slash_dispatch.rs:322-325）。popup 讀 builtin_approval_presets()，每組 preset 綁定 AskForApproval 與 PermissionProfile/ActivePermissi `codex-rs/utils/approval-presets/src/lib.rs:28` | **rewrite** — codex 綁審批與 profile |
| `privacy` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() returns `Action::OpenSettingsFocus{key: "coding_data_sharing"}` (privacy.rs:6, :20-24). It declares no args and deliberately ignores trailing text rather than rejecting it, so `/privacy opt-in`  `crates/codegen/xai-grok-pager/src/slash/commands/privacy.rs:6` | **不做** — IH 無帳戶面；明示不註冊 |
| `sandbox-add-read-dir` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | is_visible 僅 Windows（slash_command.rs:268）。bare dispatch 只回 'Usage: /sandbox-add-read-dir <absolute-directory-path>'（slash_dispatch.rs:384-388）；帶參數送 AppEvent::BeginWindowsSandboxGrantReadRoot { path:  `codex-rs/tui/src/slash_command.rs:22` | **遠期** — 需 elevated 讀隔離後端 |
| `sandbox-toggle` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/sandbox-toggle/sandbox-toggle.tsx `call` renders `<SandboxSettings>` with no arguments; selecting a mode calls `SandboxManager.setSandboxSettings({...})` (src/components/sandbox/SandboxSe `src/commands/sandbox-toggle/index.ts:6` | **rewrite** — cc 寫入 sandbox.* 設定 |
| `security-review` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | `export default createMovedToPluginCommand({...})` (src/commands/security-review.ts:198-242). The factory RETURNS a plain Command object literal (src/commands/createMovedToPluginCommand.ts:30-64) with `src/commands/security-review.ts:198` | **路線差異** — IH 不內建 prompt；走 skill |
| `setup-default-sandbox` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | dispatch 受 cfg(target_os='windows') 包住，且只在 level==RestrictedToken 時才繼續；否則直接 return（slash_dispatch.rs:332-343）。接著從 builtin_approval_presets() 找 id=='auto' 的 preset，用 permissions.approval_policy.can_set `codex-rs/tui/src/chatwidget/slash_dispatch.rs:332` | **遠期** — IH 無 elevated 後端 |
| `test-approval` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | is_visible 限 cfg!(debug_assertions)（slash_command.rs:271）。dispatch 直接構造 ApplyPatchApprovalRequestEvent（call_id/turn_id '1'、兩個 /tmp 檔案：Add 與 Update、grant_root=/tmp），呼叫 self.on_apply_patch_approval_requ `codex-rs/tui/src/slash_command.rs:75` | **rewrite** — 以既有 approval seam 送假請求 |

## 工具與擴展（`extension`，18 列）

| 命令 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | 機制／出處 | disposition |
|---|---|---|---|---|---|---|---|---|---|
| `agents-platform` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | There is no external backend module: the `load` field is an inline async function (index.ts:7-18) resolving an object with `call`, which returns a literal `{ type: 'text', value }` string stating the  `src/commands/agents-platform/index.ts:2` | **不做** — 原後端缺席的內部 stub |
| `apps` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | dispatch 呼叫 add_connectors_output（slash_dispatch.rs:515-517），實作在 chatwidget/connectors.rs:160。popup 清單受 BuiltinCommandFlags.connectors_enabled 控制（slash_commands.rs:75），該旗標由 ChatWidget::builtin_command `codex-rs/tui/src/chatwidget/slash_dispatch.rs:515` | **路線差異** — IH 以 MCP 為整合面 |
| `config-agents` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in eco.ts:112-123. run() calls builtinRoles() from @i-harness/subagent (eco.ts:120, imported at eco.ts:20), maps them through configAgentRows and opens the 'config-agents' light pan `packages/tui/src/app/slash/impl/eco.ts:120` | **已存在** — IH 已實作（builtinRoles） |
| `hooks` | ✓ | ✗ | ✓ | — | — | ✓ | ✓ | Registered ungated in eco.ts:72-85. run() resolves the hooks config path with resolveHooksConfigPath(), loads it with loadHooksConfig(path, dirname(path)) from @i-harness/hooks (eco.ts:77-78, imports  `packages/tui/src/app/slash/impl/eco.ts:77` | **已存在** — IH 已實作（含 sha256 驗證） |
| `import` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | dispatch 只送 AppEvent::OpenExternalAgentConfigMigration（slash_dispatch.rs:446-449），由 app/event_dispatch.rs:233 處理並驅動 external-agent-migration 流程（crate codex-rs/external-agent-migration，state 端落點 state/ `codex-rs/tui/src/slash_command.rs:29` | **遠期** — 產品級遷移；含對話匯入 |
| `import-claude` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() warns via tracing when arguments are supplied (they are ignored) and returns `Action::ImportClaudeSettings` (import_claude.rs:20-26). The dispatch handler scans `.claude/settings*.json`, `~/.cla `crates/codegen/xai-grok-pager/src/slash/commands/import_claude.rs:15` | **遠期** — 同 import；掃 .claude 設定 |
| `init-verifiers` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | A prompt command: `getPromptForCommand()` (src/commands/init-verifiers.ts:11) returns one static text block (line 15) containing a five-phase instruction set. The command itself does no I/O and change `src/commands/init-verifiers.ts:4` | **路線差異** — 內部 prompt；IH 走 skill |
| `marketplace` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in eco.ts:99-110. run() constructs PluginRegistry({root: <workspace>/.i-harness/plugins}), awaits registry.catalog() and opens the 'marketplace' panel with marketplaceRows(plugins)  `packages/tui/src/app/slash/impl/eco.ts:104` | **improved-writing** — IH 真掃描目錄；勿退化 |
| `mcp` | ✗ | ✗ | ✓ | — | — | ✗ | ✓ | bare dispatch 呼叫 add_mcp_output(McpServerStatusDetail::ToolsAndAuthOnly)（slash_dispatch.rs:512-514）；add_mcp_output 先放 loading spinner 再送 AppEvent::FetchMcpInventory { detail, thread_id }（chatwidget.rs `codex-rs/tui/src/chatwidget/slash_dispatch.rs:512` | **rewrite** — cc 可 toggle MCP 伺服器 |
| `mcps` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in eco.ts:54-71. run() builds the workspace PluginRegistry and reads registry.runtimeInputs().mcpServerConfigs (eco.ts:59-60), deriving each server's transport from url (streamable- `packages/tui/src/app/slash/impl/eco.ts:59` | **已存在** — IH 已實作；不捏造掛載態 |
| `personas` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() returns `Action::OpenConfigAgentsModal(Some(AgentsTab::Personas))` (personas.rs:17-19), i.e. the same modal as `/config-agents` but pre-selected on the Personas tab; the tab type comes from `cra `crates/codegen/xai-grok-pager/src/slash/commands/personas.rs:12` | **不做** — IH 明示不註冊：無 preset 目錄 |
| `plugin` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/plugin/plugin.tsx `call` (line 4) renders `<PluginSettings onComplete={onDone} args={args} />` (line 5). PluginSettings parses the raw arguments with parsePluginArgs (PluginSettings.tsx:7 `src/commands/plugin/index.tsx:4` | **rewrite** — cc 四頁管理；IH 後端已有 |
| `plugins` | ✓ | ✗ | ✓ | — | — | ✓ | ✗ | Registered ungated in eco.ts:86-98. run() constructs PluginRegistry({root: <workspace>/.i-harness/plugins}) and awaits registry.catalog(), then opens the 'plugins' panel with pluginRows(plugins) (eco. `packages/tui/src/app/slash/impl/eco.ts:91` | **已存在** — IH 已實作（四態目錄） |
| `reload-plugins` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/reload-plugins/reload-plugins.ts `call` (line 5) awaits `refreshActivePlugins(context.setAppState)` (line 6). refreshActivePlugins (src/utils/plugins/refresh.ts:72-73) loads enabled/disab `src/commands/reload-plugins/index.ts:8` | **rewrite** — cc refresh 後即時套用 |
| `skills` | ✓ | ✗ | ✓ | — | — | ✓ | ✓ | Registered ungated in eco.ts:42-53. run() creates the skill registry with createSkillRegistry({workspace: ctx.workspace ?? process.cwd()}) (eco.ts:47, :33-35), lists it and opens the 'skills' panel th `packages/tui/src/app/slash/impl/eco.ts:47` | **已存在** — IH 已實作（registry 掃描） |
| `think-back` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | It is a plugin/marketplace feature plus an animation runner. ThinkbackFlow first renders `<ThinkbackInstaller>` (src/commands/thinkback/thinkback.tsx:518), whose effect checks loadKnownMarketplacesCon `src/commands/thinkback/thinkback.tsx:1` | **不做** — 遠端旗標動畫；本 build no-op |
| `thinkback-play` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | The load target's `call` loads the installed-plugin registry with `loadInstalledPluginsV2()` and looks up `v2Data.plugins['thinkback@' + marketplace]` (src/commands/thinkback-play/thinkback-play.ts:20 `src/commands/thinkback-play/index.ts:8` | **不做** — 同 think-back；隱藏 no-op |
| `workflows` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() returns `Action::OpenExtensionsModal{tab: ExtensionsTab::Workflows, trigger: SlashCommand}` (workflows.rs:18-23). Unlike `/workflow` it does not consult `workflows_available`: visibility is deli `crates/codegen/xai-grok-pager/src/slash/commands/workflows.rs:13` | **路線差異** — IH workflow 別名即此 |

## 檢視與輸出（`inspect`，21 列）

| 命令 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | 機制／出處 | disposition |
|---|---|---|---|---|---|---|---|---|---|
| `copy` | ✓ | ✗ | ✓ | — | — | ✓ | ✓ | Registered ungated in tools.ts:37-43; run() calls ctx.copy() (tools.ts:41), wired in the loop to copySelectedBlock (loop.ts:2497). That reads engine.selection(), slices the display lines for the selec `packages/tui/src/app/loop.ts:2497` | **已存在** — IH 已實作；toast 非成功訊號 |
| `cost` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/cost/cost.ts is a 6-line shim: `call` (line 4) returns `{ type: 'text', value: formatTotalCost() }` (line 5), importing formatTotalCost from '../../cost-tracker.js' (line 1). src/cost-tra `src/commands/cost/cost.ts:5` | **遠期** — 需定價來源，暫不硬編碼 |
| `dashboard` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered in sessions.ts:42-55, visible() = hasCapability(ctx,'dashboard') (sessions.ts:47). run() guards on the optional ctx.dashboard member and toasts 'dashboard: backend projection absent' otherw `packages/tui/src/app/loop.ts:2521` | **improved-writing** — IH 每列真值；勿退化 |
| `debug` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() switches on the trimmed arg: empty -> `Action::ShowDebugStatus`, `scroll` -> `ToggleScrollDebugHud`, `fps` -> `ToggleFpsHud`, `log` -> `ToggleScrollLog`, anything else -> an Error listing the va `crates/codegen/xai-grok-pager/src/slash/commands/debug.rs:22` | **遠期** — grok dev HUD；IH 暫無覆蓋層 |
| `debug-config` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | dispatch 呼叫 add_debug_config_output（slash_dispatch.rs:485-487），實作呼叫 crate::debug_config::new_debug_config_output(&self.config, self.session_network_proxy.as_ref()) 並寫入 history（chatwidget.rs:1463-1468） `codex-rs/tui/src/chatwidget/slash_dispatch.rs:485` | **rewrite** — 印出 settings 分層與來源 |
| `debug-m-drop` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | enum 註解明確標示 // Debugging commands（slash_command.rs:78-80），描述為 'DO NOT USE'（slash_command.rs:121）。dispatch 只呼叫 add_app_server_stub_message('Memory maintenance')（slash_dispatch.rs:506-508），該函式 warn! 後寫入 `codex-rs/tui/src/chatwidget/slash_dispatch.rs:506` | **不做** — codex 僅 stub，無可採用 |
| `debug-m-update` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | 與 debug-m-drop 同一個 stub arm（slash_dispatch.rs:509-511），add_app_server_stub_message('Memory maintenance') → 錯誤 cell（chatwidget.rs:1571-1574）。available_during_task() 為 false（slash_command.rs:227），佇列分類為  `codex-rs/tui/src/chatwidget/slash_dispatch.rs:509` | **不做** — 同為 stub，無實作 |
| `diff` | ✗ | ✗ | ✓ | — | — | ✗ | ✓ | dispatch 先 add_diff_in_progress()（僅 request_redraw，chatwidget.rs:1455-1457），再 clone workspace_command_runner 與 cwd，tokio::spawn 非同步執行 get_git_diff，結果以 AppEvent::DiffResult(cwd, text) 回送（slash_dispatch `codex-rs/tui/src/chatwidget/slash_dispatch.rs:414` | **rewrite** — 借 cc 無鎖 git diff 面板 |
| `doctor` | ✓ | ✗ | ✗ | — | — | ✓ | ✓ | Registered ungated in tools.ts:20-36. run() opens the doctor panel in the Probing… state first (tools.ts:32) so that frame paints, then awaits the OPTIONAL ctx.probeReport member (tools.ts:33) and re- `apps/tui/src/index.ts:764` | **已存在** — IH 已實作 live probe 面板 |
| `export` | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | Registered ungated in tools.ts:44-51. run() awaits ctx.exportTranscript() and toasts 'exported: <path>' or 'export failed' depending on whether a path came back (tools.ts:48-49), wired to Loop.exportT `packages/tui/src/app/loop.ts:2499` | **已存在** — IH 已實作 transcript 匯出 |
| `find` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in navigation.ts:15-23; run() reads ctx.arg and calls ctx.startSearch(pattern) with undefined for an empty argument (navigation.ts:20-21), wired in the loop to activateSearch (loop. `packages/tui/src/app/loop.ts:2459` | **已存在** — IH 已實作可預填搜尋 |
| `heapdump` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/heapdump/heapdump.ts `call` (line 3) awaits `performHeapDump()` from src/utils/heapDumpService.ts (line 221) and returns heapPath/diagPath. The service sets `dumpDir = getDesktopPath()` ( `src/commands/heapdump/heapdump.ts:3` | **reuse** — cc 的 v8 heap snapshot 可直搬 |
| `insights` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | A prompt command: `getPromptForCommand()` (src/commands/insights.ts:2843) awaits `generateUsageReport()` (line 2844) — implemented at insights.ts:2606, which aggregates session facets and writes the H `src/commands/insights.ts:2836` | **遠期** — 可分享報表；IH 分享面遠期 |
| `jump` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in navigation.ts:24-52. With a numeric argument it validates /^\d+$/ (toasting 'jump: expected a turn number (1..N) or no arg' otherwise, navigation.ts:32-35), indexes ctx.jumpAncho `packages/tui/src/app/loop.ts:2448` | **已存在** — IH 已實作，含參數驗證 |
| `pwd` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | serialize 'cwd' + to_string 'pwd'，兩者皆可解析（slash_command.rs:53），popup 顯示 pwd。bare dispatch 直接以 config.cwd 組 info message（slash_dispatch.rs:471-476）；帶參數時回 'Usage: /pwd' 錯誤（slash_dispatch.rs:711-713）。屬 in `codex-rs/tui/src/slash_command.rs:53` | **路線差異** — IH 以狀態列 cwd chip 呈現 |
| `rollout` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | is_visible 限制為 cfg!(debug_assertions)（slash_command.rs:271）。dispatch 讀 rollout_path()（回傳 self.current_rollout_path）並印 'Current rollout path: ...'，尚無則印 'Rollout path is not available yet.'（slash_dispat `codex-rs/tui/src/chatwidget/slash_dispatch.rs:521` | **遠期** — codex 限 debug；價值低暫緩 |
| `scroll-debug` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | visible() returns false so it is never listed (scroll_debug.rs:21-23); run() returns `Action::ToggleScrollDebugHud` for a bare invocation and `CommandResult::PassThrough("/scroll-debug {args}")` for a `crates/codegen/xai-grok-pager/src/slash/commands/scroll_debug.rs:14` | **遠期** — grok 捲動 HUD；暫緩 |
| `stats` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | The load target returns `<Stats onClose={onDone} />` (src/commands/stats/stats.tsx:5). Stats.tsx calls `aggregateClaudeCodeStatsForRange('all')` (src/components/Stats.tsx:65, and line 153 for other ra `src/commands/stats/stats.tsx:5` | **遠期** — 跨 session 統計報表，暫緩 |
| `status` | ✗ | ✗ | ✓ | — | — | ✗ | ✓ | dispatch 用 should_prefetch_rate_limits 決定是否附帶刷新：需要時配置 request_id、以 refreshing_rate_limits=true 產生 status cell，並送 AppEvent::RefreshRateLimits{origin: StatusCommand{request_id}}；否則直接產生靜態 status（slash_di `codex-rs/tui/src/chatwidget/slash_dispatch.rs:453` | **路線差異** — IH 拆為 session-info/usage |
| `transcript` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in tools.ts:52-59; run() awaits ctx.openTranscriptPager() and toasts 'transcript: pager opened' or 'transcript failed' (tools.ts:56-57), wired to Loop.openTranscriptPager (loop.ts:2 `packages/tui/src/app/loop.ts:2500` | **已存在** — IH 已實作 |
| `version` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | Fully self-contained: the `load` returns a resolved module `{ call }` instead of an import (src/commands/version.ts:19), and `call` is an in-file LocalCommandCall returning a text result built from th `src/commands/version.ts:3` | **路線差異** — IH 以 --version／Welcome 呈現 |

## 介面與外觀（`interface`，39 列）

| 命令 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | 機制／出處 | disposition |
|---|---|---|---|---|---|---|---|---|---|
| `announcements` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() takes the first whitespace token and maps `hide` -> `Action::AnnouncementsHide`, `show` -> `Action::AnnouncementsShow`, anything else -> a usage Error (announcements.rs:41-47). `takes_args: true `crates/codegen/xai-grok-pager/src/slash/commands/announcements.rs:12` | **不做** — 需伺服器公告面；IH 無帳號面 |
| `app` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | is_visible 只允許 macOS/Windows（slash_command.rs:270）。dispatch 先要求已有 thread_id，否則報 'Session is still starting'，然後送 AppEvent::OpenDesktopThread { thread_id }（slash_dispatch.rs:250-259）。事件在 app/event_dispa `codex-rs/tui/src/slash_command.rs:38` | **遠期** — web/desktop 在 IH 遠期隊列 |
| `brief` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | The `load` returns an inline component with no separate module (brief.ts:58-122). Its `call` reads `context.getAppState().isBriefOnly` (line 64), flips it, refuses the on-transition when `!isBriefEnti `src/commands/brief.ts:29` | **不做** — 帳號權益功能；IH 不做帳號面 |
| `color` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/color/color.ts `call` (line 20) refuses swarm teammates via isTeammate() (line 26). Reset words ('default','reset','none','gray','grey', line 18) write the sentinel 'default' with `await  `src/commands/color/color.ts:51` | **遠期** — per-session 顏色識別，暫緩 |
| `compact-mode` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in visual.ts:77-84. run() negates app.compactMode and calls ctx.setCompactMode(next) (visual.ts:81), wired in the loop to set app.compactMode directly (loop.ts:2489-2491). The toast `packages/tui/src/app/slash/impl/visual.ts:81` | **已存在** — IH 已實作本地狀態切換 |
| `config` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/config/config.tsx is a small shim: `call` returns `<Settings onClose={onDone} context={context} defaultTab="Config" />`. The state web is src/components/Settings/Settings.tsx (`Settings`, `src/commands/config/config.tsx:5` | **路線差異** — 同 IH /settings 面，非缺口 |
| `docs` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() resolves the arg three ways: empty or a how-to synonym -> `Action::OpenHowtoGuides`; a web synonym -> `Action::OpenUrl(BUILD_DOCS_URL)` where the URL is the hardcoded `https://docs.x.ai/build/ov `crates/codegen/xai-grok-pager/src/slash/commands/docs.rs:14` | **路線差異** — IH 以 /tutorial 承載指南 |
| `edit-prompt` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in navigation.ts:60-69; run() calls ctx.editPromptInEditor() (navigation.ts:67), wired to Loop.editPromptInEditor (loop.ts:2498, implemented at loop.ts:3068) — the same $EDITOR roun `packages/tui/src/app/loop.ts:2498` | **已存在** — IH 已實作 $EDITOR 往返 |
| `expand` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() errors without a session, else returns `Action::MinimalExpandLast` (expand.rs:26-31). The mechanism exists because minimal mode prints finalized blocks once into the terminal's native scrollback `crates/codegen/xai-grok-pager/src/slash/commands/expand.rs:17` | **rewrite** — minimal 印一次；需重印展開 |
| `experimental` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | dispatch 呼叫 open_experimental_popup（slash_dispatch.rs:389-391）；實作掃 FEATURES，只保留 spec.stage.experimental_menu_name() 有值的（即 Stage::Experimental），用 config.features.enabled(spec.id) 標示現況，組成 ExperimentalFe `codex-rs/tui/src/chatwidget/slash_dispatch.rs:389` | **路線差異** — IH 以能力門控取代實驗旗標 |
| `fullscreen` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in visual.ts:92-98; run() calls ctx.relaunch() and quits this process when the host reports it spawned (visual.ts:96). ctx.relaunch is wired to Loop.relaunchSlash(input) (loop.ts:24 `packages/tui/src/app/loop.ts:2495` | **已存在** — IH 已實作 host relaunch |
| `gboom` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | visible() returns false unconditionally, so it is never listed in the dropdown (gboom.rs:25-27). run() checks the args: with any non-whitespace argument it returns `CommandResult::PassThrough("/gboom  `crates/codegen/xai-grok-pager/src/slash/commands/gboom.rs:16` | **不做** — 彩蛋遊戲，非 IH 產品面 |
| `help` | ✓ | ✗ | ✗ | — | — | ✓ | ✓ | Registered ungated in tools.ts:60-76. run() reads ctx.visibleCommands?.() and ctx.keyBindings?.() (tools.ts:66-67) and builds a two-section cheatsheet panel (Commands / Keys) opened as kind 'cheatshee `packages/tui/src/app/slash/impl/tools.ts:66` | **improved-writing** — IH 即時推導可見清單，勿退化 |
| `history` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in navigation.ts:53-59; run() calls ctx.openHistoryPanel() (navigation.ts:57), wired in the loop to openHistoryPicker (loop.ts:2457, implemented at loop.ts:2631). The picker is driv `packages/tui/src/app/loop.ts:2457` | **已存在** — IH 已實作 history picker |
| `home` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in sessions.ts:27-33; run() calls ctx.setScreen('welcome') (sessions.ts:31), wired in the loop (loop.ts:2463-2478) to activateWelcome(), rebuild the welcome menus/modelState and req `packages/tui/src/app/slash/impl/sessions.ts:31` | **已存在** — IH 已實作 |
| `keybindings` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/keybindings/keybindings.ts `call` (line 11) re-checks `isKeybindingCustomizationEnabled()` and returns an explanatory string when disabled (lines 12-18); otherwise it resolves `getKeybind `src/commands/keybindings/index.ts:5` | **遠期** — keybindings.json 覆蓋層未規劃 |
| `keymap` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | bare dispatch 呼叫 open_keymap_picker（slash_dispatch.rs:329-331；keymap_picker.rs:31）。帶參數只接受 'debug'：用 RuntimeKeymap::from_config(&self.config.tui_keymap) 解析設定，成功則 open_keymap_debug，失敗則顯示 'Invalid `tui.k `codex-rs/tui/src/slash_command.rs:18` | **遠期** — 鍵表重映射需設定層，暫緩 |
| `minimal` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in visual.ts:85-91; run() calls ctx.relaunch() and quits the process only when the host reports the spawn happened (visual.ts:89). Same seam as /fullscreen: Loop.relaunchSlash forwa `packages/tui/src/app/loop.ts:2495` | **已存在** — IH 已實作 print-once 重啟 |
| `multiline` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in visual.ts:69-76; run() negates app.prompt.multiLine and calls ctx.setMultiline(next) (visual.ts:73), wired in the loop to write app.prompt.multiLine and refresh the shortcuts bar `packages/tui/src/app/slash/impl/visual.ts:73` | **已存在** — IH 已實作 multiline 切換 |
| `output-style` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/output-style/output-style.tsx `call` (line 2) only invokes onDone with the deprecation string '/output-style has been deprecated. Use /config to change your output style, or set it in you `src/commands/output-style/index.ts:5` | **不做** — cc 已棄用 stub，無可採 |
| `pets` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | serialize 'pet' + to_string 'pets'，兩者可解析（slash_command.rs:60）。bare dispatch 呼叫 open_pets_picker（slash_dispatch.rs:497-499；pets.rs:141-161，先 warn_if_pets_unsupported，再以 build_pet_picker_params 開選單並啟動預覽 `codex-rs/tui/src/slash_command.rs:60` | **不做** — 裝飾動畫，IH 不引入 |
| `queue` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in run.ts:62-72. run() guards on the optional ctx.queue member, toasting 'queue: pane seam absent' (run.ts:66-69), else calls it; the loop wires queue to togglePane('queue') (loop.t `packages/tui/src/app/loop.ts:2522` | **已存在** — IH 已實作 |
| `quit` | ✓ | ✗ | ✓ | — | — | ✓ | ✗ | Registered ungated in tools.ts:77-83; run() calls ctx.quitApp() (tools.ts:81), wired to Loop.requestQuit (loop.ts:2496) — the same quit path the key binding uses (it closes the backend and tears the t `packages/tui/src/app/slash/impl/tools.ts:77-83` | **已存在** — IH 已實作 |
| `raw` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | bare dispatch 呼叫 toggle_raw_output_mode_and_notify() 並送 AppEvent::RawOutputModeChanged{enabled}（slash_dispatch.rs:410-413、emit_raw_output_event 在 :129-132）。set_raw_output_mode 會改 self.raw_output_mode  `codex-rs/tui/src/chatwidget/slash_dispatch.rs:410` | **路線差異** — IH 用 minimal＋mouse 捕獲 |
| `release-notes` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() fetches synchronously through `xai_grok_shell::util::changelog::ChangelogManager::new().fetch()` and maps a markdown body to `Action::ShowReleaseNotes{title: "Release Notes", content}` or, when  `crates/codegen/xai-grok-pager/src/slash/commands/release_notes.rs:8` | **遠期** — 需自帶 changelog，暫緩 |
| `statusline` | ✗ | ✗ | ✓ | — | — | ✗ | ✓ | dispatch 呼叫 open_status_line_setup（slash_dispatch.rs:491-493）。實作以 configured_status_line_items()、config.tui_status_line_use_colors 與 status_surface_preview_data() 建 StatusLineSetupView 後 show_view（sta `codex-rs/tui/src/slash_command.rs:58` | **路線差異** — IH 設 statusLine.items |
| `stickers` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | The load target is a 16-line module: `call()` sets `const url = 'https://www.stickermule.com/claudecode'` (stickers.ts:5) and calls `openBrowser(url)` (line 6) from src/utils/browser.ts:39; on success `src/commands/stickers/index.ts:5` | **不做** — 行銷貼紙頁，與 IH 無關 |
| `tasks` | ✓ | ✗ | ✗ | — | — | ✓ | ✓ | Registered ungated in run.ts:73-83. run() guards on the optional ctx.tasks member, toasting 'tasks: pane seam absent' (run.ts:77-80), else calls it; the loop wires tasks to togglePane('tasks') (loop.t `packages/tui/src/app/loop.ts:2523` | **已存在** — IH 已實作（live 投影） |
| `terminal-setup` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/terminalSetup/terminalSetup.tsx `call` short-circuits when the terminal natively supports the CSI u / Kitty keyboard protocol (lines 144-150), refuses unsupported terminals (lines 153-182 `src/commands/terminalSetup/index.ts:14` | **路線差異** — IH 以 /tutorial 指引＋探測 |
| `theme` | ✓ | ✗ | ✓ | — | — | ✓ | ✓ | Registered ungated in visual.ts:44-59. A bare /theme advances through THEME_ORDER (system → grok-night → grok-day → tokyo-night → rose-pine-moon → oscura-midnight → system) via nextTheme and calls ctx `packages/tui/src/app/slash/impl/visual.ts:57` | **已存在** — IH 已實作主題循環與持久化 |
| `timeline` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in timeline.ts:10-19; run() negates app.showTimeline and writes it directly on the app state (timeline.ts:15-17) with an on/off toast. The rail is additionally gated at DRAW time by `packages/tui/src/app/slash/impl/timeline.ts:15` | **已存在** — IH 已實作；另有繪製門檻 |
| `timestamps` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in visual.ts:60-68; run() negates app.timestamps and calls ctx.setTimestamps(next) (visual.ts:64-65), wired to Loop.setTimestamps (loop.ts:2484, implemented at loop.ts:2883). The to `packages/tui/src/app/loop.ts:2484` | **已存在** — IH 已實作時間戳切換 |
| `title` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | dispatch 呼叫 open_terminal_title_setup（slash_dispatch.rs:488-490）。實作先把 config.tui_terminal_title 存入 terminal_title_setup_original_items（供取消還原），再用 configured_terminal_title_items() 與 preview data 建 Term `codex-rs/tui/src/chatwidget/slash_dispatch.rs:488` | **遠期** — IH 從不寫終端標題，暫緩 |
| `toggle-mouse-reporting` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Built by toggleMouseReportingCommand and spread into the registry through mouseCommands() (mouse.ts:17-38, registry.ts:58). The gate is a FEATURE setting, not a backend capability: visible() = ctx.mou `packages/tui/src/app/loop.ts:2514` | **improved-writing** — IH 翻轉時清 hover/scroll 串流 |
| `tui` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/tui/tui.ts `call` parses on\|off\|toggle (lines 24-33; anything else returns usage text at lines 35-42), then does two things: `setUserFullscreenPreference(newPref)` for immediate in-sess `src/commands/tui/index.ts:4` | **路線差異** — IH 用 /minimal、/fullscreen |
| `tutorial` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered ungated in surfaces.ts:30-36; run() calls the exported openTutorialIndex(ctx) (surfaces.ts:34, defined at surfaces.ts:46-61), which opens the 'tutorial' panel from tutorialIndexRows(); sele `packages/tui/src/app/slash/impl/surfaces.ts:34` | **已存在** — IH 已實作 tutorial 主題面板 |
| `vim` | ✗ | ✗ | ✓ | — | — | ✗ | ✓ | dispatch 呼叫 toggle_vim_mode_and_notify()（slash_dispatch.rs:326-328；chatwidget.rs:1738），切換 composer 的 vim 編輯模式並提示。!available_during_task（slash_command.rs:215）。 `codex-rs/tui/src/chatwidget/slash_dispatch.rs:326` | **rewrite** — codex/cc 有真切換，IH 無 |
| `vim-mode` | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | Registered in the editorSafetyCommands array (text-input.ts:63-72) which the registry spreads last (registry.ts:61), visible() = hasCapability(ctx,'vim-mode') (text-input.ts:67). The run body is a sin `packages/tui/src/app/slash/impl/text-input.ts:67` | **rewrite** — IH 僅 stub toast，未接線 |
| `voice` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() returns `Action::VoiceToggle` (voice.rs:39-42). description() is dynamic rather than constant: it reports "Dictation (Ctrl+Space/F8; Esc/Enter to stop)" when the terminal reports kitty key relea `crates/codegen/xai-grok-pager/src/slash/commands/voice.rs:20` | **不做** — IH 明文排除名單含 voice |

## 協作與多智能體（`collab`，7 列）

| 命令 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | 機制／出處 | disposition |
|---|---|---|---|---|---|---|---|---|---|
| `agents` | ✗ | ✗ | ✓ | — | — | ✗ | ✓ | bare dispatch 送 AppEvent::OpenAgentsOverview（slash_dispatch.rs:316-318）；由 codex-rs/tui/src/app/agents_overview.rs 的 App::open_agents_overview 處理（agents_overview.rs:43）。狀態放在 AgentsOverviewState：visible `codex-rs/tui/src/chatwidget/slash_dispatch.rs:316` | **遠期** — IH dashboard 已有；編輯遠期 |
| `btw` | ✓ | ✗ | ✓ | — | — | ✓ | ✓ | Registered ungated in run.ts:84-96. With an argument the run calls ctx.toggleBtwWith(question) (run.ts:91), wired in the loop to toggleBtwWith (loop.ts:2461): it writes app.paneData.btw {question,stat `packages/tui/src/app/loop.ts:2461` | **已存在** — IH 已實作；走 steer 進對話 |
| `install-slack-app` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/install-slack-app/install-slack-app.ts `call` (line 8) logs tengu_install_slack_app_clicked (line 9), increments a global-config counter via `saveGlobalConfig(current => ({ ...current, sl `src/commands/install-slack-app/index.ts:5` | **不做** — 開瀏覽器的產品推廣面 |
| `pr-comments` | ✗ | ✗ | ✗ | — | — | ✗ | ✓ | src/commands/pr_comments/index.ts default-exports `createMovedToPluginCommand({ name: 'pr-comments', pluginName: 'pr-comments', pluginCommand: 'pr-comments', getPromptWhileMarketplaceIsPrivate })` (in `src/commands/pr_comments/index.ts:3` | **路線差異** — 同 moved-to-plugin 路徑 |
| `share` | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | run() ignores its context and returns `CommandResult::Error("Session sharing is temporarily disabled")` (share.rs:14-17) — the capability is stubbed in this revision rather than implemented. The regis `crates/codegen/xai-grok-pager/src/slash/commands/share.rs:8` | **不做** — IH 明示不做共享；grok 僅 stub |
| `side` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | 與 /btw 同一 arm（slash_dispatch.rs:313-315），描述共用 'start a side conversation in an ephemeral fork'（slash_command.rs:132-134）。bare 走 request_empty_side_conversation → AppEvent::StartSide{parent_thread_id,  `codex-rs/tui/src/slash_command.rs:44` | **路線差異** — codex /side≡/btw；IH 單一 |
| `subagents` | ✗ | ✗ | ✓ | — | — | ✗ | ✗ | dispatch 送 AppEvent::OpenAgentPicker（slash_dispatch.rs:319-321；slash_command.rs:76 以 serialize='subagents' 讓字面值為 subagents，而非變體名 multi-agents）。事件在 app/event_dispatch.rs:2414 處理；picker 以 root thread 為範 `codex-rs/tui/src/app/event_dispatch.rs:2414` | **rewrite** — codex 以 root 過濾挑選 |

## 附錄 A — 各源自身命令清單（原樣抽出，不合併）

### IH（50）

`always-approve`、`auto`、`btw`、`compact`、`compact-mode`、`config-agents`、`context`、`copy`、`dashboard`、`doctor`、`edit-prompt`、`effort`、`export`、`find`、`fork`、`fullscreen`、`goal`、`help`、`history`、`home`、`hooks`、`jump`、`marketplace`、`mcps`、`minimal`、`model`、`multiline`、`new`、`plan`、`plugins`、`provider`、`queue`、`quit`、`rename`、`resume`、`rewind`、`session-info`、`settings`、`skills`、`tasks`、`theme`、`timeline`、`timestamps`、`toggle-mouse-reporting`、`transcript`、`tutorial`、`usage`、`view-plan`、`vim-mode`、`workflow`

### dsh（6）

`compact`、`feedback`、`goal`、`permission`、`plan`、`export`

### codex（58）

`agents`、`app`、`apps`、`archive`、`approve`、`btw`、`cd`、`clean`、`clear`、`compact`、`copy`、`cwd`、`debug-config`、`debug-m-drop`、`debug-m-update`、`delete`、`diff`、`exit`、`experimental`、`export`、`feedback`、`fork`、`goal`、`hooks`、`ide`、`import`、`init`、`keymap`、`logout`、`mcp`、`memories`、`mention`、`model`、`new`、`permissions`、`personality`、`pet`、`plan`、`plugins`、`ps`、`quit`、`raw`、`rename`、`resume`、`review`、`rollout`、`sandbox-add-read-dir`、`setup-default-sandbox`、`side`、`skills`、`status`、`statusline`、`subagents`、`test-approval`、`theme`、`title`、`usage`、`vim`

### opencode（2）

`init`、`review`

### ocode-fork（2）

`init`、`review`

### grok（71）

`always-approve`、`announcements`、`auto`、`btw`、`cd`、`compact`、`compact-mode`、`config-agents`、`context`、`copy`、`dashboard`、`debug`、`delete`、`docs`、`doctor`、`edit-prompt`、`effort`、`expand`、`export`、`feedback`、`find`、`fork`、`gboom`、`help`、`history`、`home`、`hooks`、`import-claude`、`jump`、`login`、`logout`、`loop`、`marketplace`、`mcps`、`model`、`multiline`、`new`、`personas`、`plan`、`plugins`、`privacy`、`queue`、`quit`、`recap`、`release-notes`、`remember`、`rename`、`resume`、`rewind`、`scroll-debug`、`session-info`、`settings`、`share`、`skills`、`tasks`、`theme`、`timeline`、`timestamps`、`toggle-mouse-reporting`、`transcript`、`tutorial`、`usage`、`view-plan`、`vim-mode`、`voice`、`workflow`、`workflows`、`imagine`、`imagine-video`、`minimal`、`fullscreen`

### cc-custom（74）

`add-dir`、`agents`、`agents-platform`、`auto-compact-window`、`branch`、`brief`、`btw`、`clear`、`code-review`、`color`、`commit`、`commit-push-pr`、`compact`、`config`、`context`、`context-window`、`copy`、`cost`、`diff`、`doctor`、`effort`、`exit`、`export`、`fast`、`files`、`heapdump`、`help`、`hooks`、`ide`、`init`、`init-verifiers`、`insights`、`install-slack-app`、`keybindings`、`loop`、`max-output`、`mcp`、`memory`、`model`、`output-style`、`permissions`、`plan`、`plugin`、`pr-comments`、`protocol`、`provider`、`reload-plugins`、`rename`、`resume`、`review`、`rewind`、`sandbox`、`security-review`、`skills`、`stats`、`status`、`statusline`、`stickers`、`tag`、`tasks`、`terminal-setup`、`theme`、`think-back`、`thinkback-play`、`tui`、`version`、`vim`、`src/commands.ts is the single central registry for all 67 commands (memoized COMMANDS() array + INTERNAL_ONLY_COMMANDS + per-command isEnabled) — the mechanism this source was chosen to illustrate.`、`src/commands/createMovedToPluginCommand.ts implements the 'command moved to a plugin' migration shim used by pr-comments and security-review.`、`CLI subcommand surface found in src/main.tsx (commander) and src/entrypoints/cli.tsx (bootstrap fast-paths), with handlers in src/cli/handlers/* plus src/cli/{print,structuredIO,ndjsonSafeStringify,exit}.ts.`、`src/services/compact/ contains three distinct compaction layers (compactConversation, sessionMemoryCompact, microCompact) plus autoCompact threshold logic and autoCompactWindow.`、`src/utils/sandbox/sandbox-adapter.ts shows real OS-level confinement delegated to @anthropic-ai/sandbox-runtime (seatbelt on macOS, bubblewrap+socat+seccomp on Linux/WSL2) rather than policy-only prompts.`、`src/utils/fileHistory.ts implements per-user-message file checkpoints with content backups at {configDir}/file-history/{sessionId}/{hash}@vN — the storage behind /rewind.`、`The thinkback pair (/think-back, /thinkback-play) is a plugin-marketplace-installed animation feature gated by a remote Statsig flag that is a no-op stub in this build.`

## 附錄 B — 未對帳與存疑對帳

本附錄列出**自動折疊做過判斷、但值得人工複核**的列。空著不代表對帳完美，而代表沒有觸發以下三種訊號。

### B1. 同源名稱碰撞（1）

同一源的兩個命令被抽取代理正規化為同一個名字。**兩者都已退回自己的命令名**，否則其中一個會靜默消失。

| 源 | 命令 A | 命令 B | 曾共同被正規化為 |
|---|---|---|---|
| codex | `btw` | `side` | `side-conversation` |

### B2. 跨源家族不一致（19）

同一列在不同源被歸入不同家族。這**不一定是錯**（不少命令合理地跨家族），但它是最便宜的「這兩者真的是同一個東西嗎」訊號。

| 命令 | 各源家族 | 參與的源 |
|---|---|---|
| `feedback` | session / interface | dsh=session, codex=interface, grok=interface |
| `fork` | session / collab | ih=session, codex=session, grok=collab |
| `session-info` | session / inspect | ih=session, grok=inspect |
| `ide` | context / extension | codex=context, cc-custom=extension |
| `usage` | context / inspect | ih=context, codex=inspect, grok=inspect |
| `review` | execution / collab | codex=execution, cc-custom=collab |
| `rewind` | execution / session | ih=execution, grok=session, cc-custom=session |
| `settings` | model / interface | ih=model, grok=interface |
| `copy` | inspect / interface | ih=inspect, codex=interface, grok=interface, cc-custom=interface |
| `dashboard` | inspect / collab | ih=inspect, grok=collab |
| `export` | inspect / interface / session | ih=inspect, dsh=inspect, codex=interface, grok=interface, cc-custom=session |
| `find` | inspect / interface | ih=inspect, grok=interface |
| `jump` | inspect / interface | ih=inspect, grok=interface |
| `transcript` | inspect / context | ih=inspect, grok=context |
| `home` | interface / session | ih=interface, grok=session |
| `queue` | interface / execution | ih=interface, grok=execution |
| `quit` | interface / session | ih=interface, codex=session, grok=session |
| `tasks` | interface / collab / execution | ih=interface, grok=collab, cc-custom=execution |
| `agents` | collab / extension | codex=collab, cc-custom=extension |

### B3. 單源獨有列（80）

只出現在一個源的命令。多數是該源真正獨有，但這也是**同義異名最難被發現的一類**——沒有第二個源可以反駁。

分佈：codex 25 · cc-custom 36 · grok 18 · dsh 1

清單：`archive`、`branch`、`login`、`tag`、`auto-compact-window`、`files`、`memories`、`memory`、`mention`、`recap`、`remember`、`code-review`、`commit`、`commit-push-pr`、`imagine`、`imagine-video`、`ps`、`stop`、`context-window`、`fast`、`max-output`、`personality`、`protocol`、`add-dir`、`approve`、`permission`、`privacy`、`sandbox-add-read-dir`、`sandbox-toggle`、`security-review`、`setup-default-sandbox`、`test-approval`、`agents-platform`、`apps`、`import`、`import-claude`、`init-verifiers`、`personas`、`plugin`、`reload-plugins`、`think-back`、`thinkback-play`、`workflows`、`cost`、`debug`、`debug-config`、`debug-m-drop`、`debug-m-update`、`heapdump`、`insights`、`pwd`、`rollout`、`scroll-debug`、`stats`、`version`、`announcements`、`app`、`brief`、`color`、`config`、`docs`、`expand`、`experimental`、`gboom`、`keybindings`、`keymap`、`output-style`、`pets`、`raw`、`release-notes`、`stickers`、`terminal-setup`、`title`、`tui`、`voice`、`install-slack-app`、`pr-comments`、`share`、`side`、`subagents`

## 附錄 C — crosswalk 對照表

只列出**至少一個源的命令名與本列 key 不同**的列；名字一致的列不需要對照。

| 列 key | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom |
|---|---|---|---|---|---|---|---|
| `branch` |  |  |  |  |  |  | `branch` · `fork` |
| `clear` |  |  | = |  |  |  | `clear` · `reset` · `new` |
| `exit` |  |  | `exit` · `quit` |  |  |  | `exit` · `quit` |
| `new` | = |  | = |  |  | `new` · `clear` |  |
| `rename` | = |  | = |  |  | `rename` · `title` | = |
| `resume` | = |  | = |  |  | = | `resume` · `continue` |
| `recap` |  |  |  |  |  | `recap` · `summarize` |  |
| `usage` | = |  | = |  |  | `usage` · `cost` |  |
| `view-plan` | = |  |  |  |  | `view-plan` · `show-plan` · `plan-view` |  |
| `rewind` | = |  |  |  |  | `rewind` · `undo` | `rewind` · `checkpoint` · `undo` |
| `stop` |  |  | `clean` · `stop` |  |  |  |  |
| `workflow` | `workflow` · `workflows` |  |  |  |  | = |  |
| `model` | = |  | = |  |  | `model` · `m` | = |
| `settings` | = |  |  |  |  | `settings` · `config` · `preferences` · `prefs` |  |
| `permissions` |  |  | = |  |  |  | `permissions` · `allowed-tools` |
| `sandbox-toggle` |  |  |  |  |  |  | `sandbox` |
| `config-agents` | = |  |  |  |  | `config-agents` · `agents` |  |
| `plugin` |  |  |  |  |  |  | `plugin` · `plugins` · `marketplace` |
| `plugins` | = |  | = |  |  | `plugins` · `plugin` |  |
| `dashboard` | = |  |  |  |  | `dashboard` · `agents-dashboard` · `sessions` |  |
| `doctor` | = |  |  |  |  | `doctor` · `terminal-setup` · `terminal-check` · `terminal-info` | = |
| `pwd` |  |  | `cwd` · `pwd` |  |  |  |  |
| `transcript` | = |  |  |  |  | `transcript` · `log` |  |
| `config` |  |  |  |  |  |  | `config` · `settings` |
| `docs` |  |  |  |  |  | `docs` · `howto` · `guides` |  |
| `fullscreen` | = |  |  |  |  | `fullscreen` · `full` |  |
| `home` | = |  |  |  |  | `home` · `welcome` |  |
| `multiline` | = |  |  |  |  | `multiline` · `ml` |  |
| `pets` |  |  | `pet` · `pets` |  |  |  |  |
| `quit` | = |  | `quit` · `exit` |  |  | `quit` · `exit` |  |
| `release-notes` |  |  |  |  |  | `release-notes` · `changelog` |  |
| `tasks` | = |  |  |  |  | = | `tasks` · `bashes` |
| `theme` | = |  | = |  |  | `theme` · `t` | = |
| `tutorial` | = |  |  |  |  | `tutorial` · `tour` · `onboarding` |  |
| `btw` | = |  | `btw` · `side` |  |  | = | = |
| `side` |  |  | `side` · `btw` |  |  |  |  |

> `=` 表示該源以同名列參與此列。共 36 列涉及異名映射。

## 附錄 D — dsh 的 RPC 平面（22 項，**不計入聯集**）

dsh 只有 6 個 slash 命令，因為它的命令面主要不在 slash。下表是它的 Typert `@Remote` RPC 方法——**這是與 slash 命令不同的層**，所以**不併入上方的聯集**，也不計入 dsh 的欄位覆蓋數。列於此是為了完整呈現 dsh 的實際操作面。

| 方法 | 家族 | 機制 | 出處 |
|---|---|---|---|
| `agent.send` | 會話生命週期 | Declared on the Agent interface as `send(message: UserMessage, target: InboxTarget, wakeup: boolean): void`. The implementation carries the whole admission policy: waking input that arrives  | `packages/core/agent/src/runtime-types.ts:215` |
| `agent.followup` | 會話生命週期 | Declared as `followup(message: UserMessage): void` with the contract that the item becomes the sole ordinary message of its own turn. Implemented as the literal single call `this.send(input, | `packages/core/agent/src/runtime-types.ts:222` |
| `agent.steer` | 會話生命週期 | Declared as `steer(message: UserMessage): void`: an idle driver starts a turn, a running driver consumes the item at its next step boundary, a rejected step leaves steering parked in the inb | `packages/core/agent/src/runtime-types.ts:231` |
| `agent.inject` | 上下文與壓縮 | Declared as `inject(message: UserMessage): void`: a running driver claims it at the nearest later step boundary, an idle driver leaves it pending until a follow-up or steer wakes it, it may  | `packages/plan/plan-mode/src/index.ts:430` |
| `session.prompt` | 會話生命週期 | Published as `@Remote('prompt')` on the session controller and typed by `SessionPromptRequest` whose `mode` is `'queue' \| 'steer'`. The implementation rejects empty content, canonicalizes/v | `packages/api/session-controller/src/index.ts:345` |
| `session.updateQueue` | 會話生命週期 | Published as `@Remote('updateQueue')`; the implementation refuses non-text edits and blank edits, requires a live Agent, and enforces continuable-subagent ownership. It then locates the item | `packages/api/session-controller/src/index.ts:366` |
| `session.cancel` | 執行控制 | Published as `@Remote('cancel')` and documented as 'cancel one active Agent turn without dropping its pending inbox'. It resolves the live Agent from the session id and delegates to the Agen | `packages/core/agent-loop/src/agent.ts:149` |
| `session.fork` | 會話生命週期 | Published as `@Remote('fork')` on the session controller and delegated to the commands module, which creates the child Session from the source prefix (optionally anchored at a given event) a | `packages/api/session-controller/src/index.ts:334` |
| `session.rename` | 會話生命週期 | Published as `@Remote('rename')` and delegated to the commands module, which resumes the Session and appends the title as durable session state, returning both the accepted title and the `se | `packages/api/session-controller/src/index.ts:324` |
| `session.create` | 會話生命週期 | Published as `@Remote('create')` and delegated to the commands module, returning the Session identity and the resolved preset when one is configured. Idempotent adoption means a repeated cre | `packages/api/session-controller/src/index.ts:243` |
| `session.list` | 檢視與輸出 | Published as `@Remote('list')` and implemented by delegating to the list-state reader with the caller's signal, returning `{ items }` of Session summaries ordered by activity. The explicit n | `packages/api/session-controller/src/index.ts:222` |
| `session.search` | 檢視與輸出 | Published as `@Remote('search')`; the handler forwards the request query and signal to the list-state search reader and returns bounded authorized results. It shares the no-resume property w | `packages/api/session-controller/src/index.ts:233` |
| `session.page` | 檢視與輸出 | Published as `@Remote('page')` and served by the history module, which returns one chronological page for a durable address plus backward cursor. 'Cold-safe' and 'message-aligned' are the lo | `packages/api/session-controller/src/index.ts:387` |
| `session.follow` | 檢視與輸出 | Declared as `@Remote({ mode: 'stream' })`, i.e. a Typert logical stream method, and served by the history module as an `AsyncIterable<SessionFollowFrame>`. The caller supplies the last commi | `packages/api/session-controller/src/index.ts:399` |
| `session.control` | 檢視與輸出 | Declared as `@Remote({ mode: 'stream' })` and implemented over the control-state module as an `AsyncIterable<SessionControlFrame>`. The stream opens with one complete baseline and then emits | `packages/api/session-controller/src/index.ts:409` |
| `session.attachment` | 檢視與輸出 | Published as `@Remote('attachment')`; the handler first builds the authoritative session read state, scans the referenced events for the attachment id, rejects with `session/attachment-inval | `packages/api/session-controller/src/index.ts:356` |
| `session.selectModel` | 模型與供應商 | Published as `@Remote('selectModel')` and delegated to the commands module, which validates and installs the selection, then returns the normalized `{ provider, model }` that was actually in | `packages/api/session-controller/src/index.ts:253` |
| `session.modelCatalog` | 模型與供應商 | Published as `@Remote('modelCatalog')` and implemented by `buildModelCatalog(ctx)`, which walks the composed LLM adapters and returns provider-grouped models plus the deployment default; a p | `packages/api/session-controller/src/index.ts:262` |
| `commands.list` | 工具與擴展 | Published as `@Remote` on `CommandRuntime`, which is constructed as `super(ctx, 'commands')`, i.e. the wire namespace is the Cordis service key `commands`. `list(agent)` resolves `this.view( | `packages/interaction/commands/src/index.ts:258` |
| `commands.execute` | 工具與擴展 | Published as `@Remote` on the same `commands` service. `parseCommand` applies the `/^\/([a-z][a-z0-9_-]*)(?=$\|[\t\n\r ])/u` grammar and returns undefined on a syntax or unknown-name miss, i | `packages/interaction/commands/src/index.ts:122` |
| `subagent.prompt` | 協作與多智能體 | Published as `@Remote('prompt')` with `SubagentPromptRequest` typed `mode: 'continuable'` and `delivery: 'queue' \| 'steer'`. The handler validates the address, canonicalizes the client time | `packages/subagent/subagent/src/inbox.ts:53` |
| `subagent.interruptByParent` | 協作與多智能體 | Published as `@Remote('interruptByParent')` taking the child id, the claimed parent id and the `mode: 'continuable'` discriminator. The implementation deliberately runs no catalog, history,  | `packages/subagent/subagent/src/index.ts:479` |

