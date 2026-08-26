# M19 Design — Subagent Teams（具名協作團隊）

Date: 2026-08-26. Milestone: M19. Status: design.

## 1. Framing

### 1.1 Problem

I-harness 的 `@i-harness/subagent`（M3/M6/M8/M9）已具備 continuable 子代理的
**90% 底子**：durable child session（`child-<uuid>` + lineage header + mirror
write-behind）、多輪 driver（`followup_task` + `driveFollowups` per-child 串行
鏈）、`interrupt_agent`/`close_agent`/`resume_agent` 全套、durable inbox
（`subagent/inbox` + `lastInboxSeq` 游標防重播）、jobs 生命週期、role/profile
抽象。

但**缺少 Team 域**（audit §5.2 / roadmap item 7「Subagent teams」）：
1. **具名持久 roster** 不存在——名字 = path（`root/<taskName>`），`agent-table.ts`
   的 `add` 靜默覆蓋同名，無「名字永不重用」語意，無 provisioning/recovery
   reconciliation。
2. **跨 session 的 team 域狀態**不存在——subagent 狀態是 M6 snapshot document
   （last-write-wins、fire-and-forget），**不是** lead session log events，
   不可審計、不可重放。
3. **mailbox 是 per-child 非全域**——無 delivered/ack、無去重、無恢復重送。
4. **task board 完全沒有**——無共享任務、無 CAS、無 DAG 依賴。
5. **wait 是 20ms 盲輪詢**——無 edge-driven wait、無 noProgress 短路。

### 1.2 參考與決策

M19 以 dsh `@deepseek-ai/dsh-experimental-agent-team`（v0.1.1-rc.2）為**主要
參考**，codex-rust v0.149.1 `multi_agents_v2` 為**次要參考**（其「更輕量/
更實用」的部分），並依 i-harness 既有架構**改良**兩者的已知缺點。三份研究
（`docs/superpowers/research/2026-08-26-{dsh-agent-team-domain,codex-multi-agents-v2,i-harness-subagent-reuse}.md`）
與綜合矩陣（`2026-08-26-m19-synthesis-matrix.md`）已載明逐項優缺點。

**對參考的改良（研究共識）**：
- dsh 每次讀取 `foldTeam` 全量重放整條 log（O(n) 無快取）→ **增量 fold 快取**
  （seq watermark，只重放新 suffix）。
- dsh `task-<n>` 計數器 + MAX_SAFE_INTEGER 邊界語意 → **UUID task id
  （`task-<uuid>`）**，revision CAS 仍保留。
- dsh noProgress 快路徑放在 tool 層（與 domain 語意分離）→ **下沉到 domain**
  （`waitForChange` 統一判定 `no-active-peer`）。
- dsh invariant 依賴 Cordis `internal/dispatch` pre-commit → **team transact 內
  先 fold 驗證候選事件再 append**（違反即 throw，不進 log）。
- codex 無 ack/去重（pending mail 不持久）→ **不取**；保留 dsh 的 durable
  queued→delivered。
- codex inject next-step / LRU residency / activity events → **不取（延後）**。

### 1.3 Goal

新增 `@i-harness/agent-team`（核心 Team 域），在既有 subagent 之上提供：
1. 具名持久 roster（隱式 Lead + durable teammates；名字永不重用）。
2. Durable mailbox（queued→delivered ack；per-target FIFO；恢復重送）。
3. 共享 task board（CAS revision；DAG blockers；tombstone；advisory write scopes）。
4. Edge-driven wait（`waitForChange` + noProgress 短路）。
5. 10 個模型面向工具（dsh 全套），Lead-only 權限區分。
6. `mountAgentTeams(ctx, tools, deps, config?)` 掛載 + CLI `team` 選項。

### 1.4 Non-goals（M19 明確不做）

- **inject（next-step quiet delivery）** — i-harness 投遞只用 next-turn（followup）；
  quiet 語意 = 「入 mailbox 不喚醒」。
- **LRU residency 併發上限** — 已有 `close_agent` + `maxMembers` 上限即為實際有界。
- **activity events**（Started/Interacted/Interrupted client 事件流）— 留 UI 里程碑。
- **完整 disposal settle 全套 + 28 個 TEAM_* 錯誤碼** — 簡化為統一的
  `TeamError { code }`（~15 碼）+ 清晰訊息；unmount 最小版（abort children +
  釋放 waiter）。
- **mailbox TTL / 過期回收** — 只有 pending 數量上限；無期限邏輯。
- **多進程 / 跨進程 exactly-once** — 單進程、單共享 checkout（與 dsh 非目標一致）。
- **嵌套 Team / rename / name reuse / 自動 owner 釋放** — 扁平不可變 roster；
  不自動釋放 task owner（與 dsh 非目標一致）。
- **新增 session event types 以外任何 CURRENT_FORMAT_VERSION 變更** —
  `CURRENT_FORMAT_VERSION` 維持 1（additive event types 不 bump）。

## 2. Confirmed decisions（brainstorm 2026-08-26）

| 決策 | Choice |
|---|---|
| 範圍 | 核心 Team 域（roster + mailbox + task board + edge wait；不做完整 dsh 域） |
| 嫁接策略 | 新 package `@i-harness/agent-team` 掛在 `@i-harness/subagent` 之上；**不擴充** subagent package（不污染 11 工具契約 / M6 snapshot format） |
| 狀態真源 | **Lead session log events**（team/member、team/task、team/message/queued、team/message/delivered；version: 1）+ 增量 fold 快取 |
| 恢復 | `coordinator.load(leadId)` → 完整 fold 重建（一次性 O(n)）；之後增量 |
| 工具面 | dsh 全套 10 工具（spawn_teammate/list_members/send_message/followup_task/wait_agent/interrupt_agent/team_task_create/list/get/update） |
| 權限 | dsh 模型：Lead-only spawn/interrupt；owner-or-Lead task mutations；Lead-only reassign；teammate 可 send/followup/task board/wait/list |
| teammate 工具面 | 無 spawn_teammate、無 interrupt_agent（Layer 1 僅 Lead） |
| delivered ack | target session 持久持有該 message id 後才 append（dsh 完整；恢復送 queued−delivered） |
| member status | 複用 subagent `entry.status`（running/waiting/completed/killed/error）→ team status（running→active、waiting→idle、completed/killed/error→inactive、provisioning→roster 維繫） |
| 定址 | codex AgentPath 模式：`AgentPath` 型別（resolve 相對/絕對、join、isRoot、嚴格校驗、唯一性錯誤） |
| task id | UUID `task-<uuid>` + revision CAS（丟棄 dsh `task-<n>` 計數器） |
| invariant | team transact 內 fold 驗證候選事件再 append（不用 Cordis pre-commit） |
| 依賴 | 零新外部（zod 已有）；改 core-session（union 加 team/* 型別）+ session-persistence（`registerEventType` 或最小 Set 加法） |
| 介面 | `mountAgentTeams(ctx, tools, deps, config?): Promise<TeamMountHandle>`（M17/M18 pattern）+ CLI `team?: TeamConfig` |

## 3. `@i-harness/agent-team` — package structure

```
src/agent-path.ts   # AgentPath 型別/解析（codex pattern; 嚴格校驗）
src/types.ts        # TeamConfig + TeamMemberSnapshot/View + TeamMessageSnapshot +
                    #   TeamTaskSnapshot/View + TeamWaitResult + TeamError/codes
src/fold.ts         # foldTeam(events) 增量重放 + applyTeamEvent + zod 結構驗證
src/transact.ts     # per-team promise 鏈串行化（read-check-append 原子）
src/roster.ts       # TeamRoster：spawnTeammate/reconcileProvisioning/listMembers
src/mailbox.ts      # TeamMailbox：sendMessage/delivery/delivered ack/recovery
src/task-board.ts   # TaskBoard：create/get/list/updateTask（CAS/DAG/tombstone/writeScopes）
src/activity.ts     # TeamActivity：waitForChange（edge-triggered + noProgress + disposal）
src/tools.ts        # createTeamTools(deps): Tool[]（10 個）
src/scheduler.ts    # mountAgentTeams + TeamMountHandle（M17/M18 pattern）
src/index.ts        # exports-only
```

### 3.1 Config（exact）

```ts
export interface TeamConfig {
  maxMembers?: number                    // default 8（含曾經 provisioned 的 failed 成員）
  maxTasks?: number                      // default 256（僅計非 deleted）
  maxPendingMessagesPerMember?: number   // default 64（queued−delivered 計數）
  maxMessageBytes?: number               // default 65_536（含傳遞框架 `Team message <id> from <name>:`）
  startupTimeoutMs?: number              // default 10_000（spawn 初始 prompt checkpoint 界）
  waitMinMs?: number                     // default 10_000
  waitMaxMs?: number                     // default 3_600_000
  waitDefaultMs?: number                 // default 30_000
}
```
每個 bound 必須是正整數（validateTeamConfig 同 M19 全程 fail-loud 慣例）。

### 3.2 Data model（Lead session log events，version: 1）

```ts
// core-session union 新增四種（teamId = lead session id = activeId 字串）
type TeamEvent = (
  | { type: "team/member"; version: 1; teamId: string; member: TeamMemberSnapshot }
  | { type: "team/task"; version: 1; teamId: string; task: TeamTaskSnapshot }
  | { type: "team/message/queued"; version: 1; teamId: string; message: TeamMessageSnapshot }
  | { type: "team/message/delivered"; version: 1; teamId: string; messageId: string; targetId: string }
) & { ignorable?: true }

export type TeamMemberPhase = "provisioning" | "active" | "failed"
export interface TeamMemberSnapshot {
  id: string                 // child session id
  name: string               // ^[a-z0-9]+(-[a-z0-9]+)*$，≤64，永不重用（含 failed）
  description: string
  provider: string
  context: "fresh" | "fork"
  phase: TeamMemberPhase
  error?: string
}
export interface TeamMemberView {
  id: string; name: string; role: "lead" | "teammate"
  status: "running" | "idle" | "inactive" | "provisioning" | "failed"
  description?: string; context?: "fresh" | "fork"; diagnostics: string[]
}
export type TeamTaskStatus = "pending" | "in_progress" | "completed" | "deleted"
export interface TeamTaskSnapshot {
  id: string                // task-<uuid>
  revision: number          // 1 起，每次 mutation +1
  subject: string; description: string
  status: TeamTaskStatus
  ownerId?: string          // member session id（claim 時設定）
  blockedBy: string[]       // 依賴的 task id（必須存在且非 deleted）
  writeScopes: string[]     // 規範化 workspace 相對前綴（advisory，非鎖）
}
export interface TeamTaskView extends TeamTaskSnapshot {  // 補 runtime 推導欄位
  ownerName?: string
  ready: boolean            // 所有 blockers completed
  writeScopeWarnings: string[]  // 與其它 in_progress tasks 的前綴重疊警告
}
export interface TeamMessageSnapshot {
  id: string                // msg-<uuid>
  senderId: string; senderName: string
  targetId: string          // member session id 或 lead id
  delivery: "quiet" | "wakeup"
  content: string           // 純文字（i-harness 無 ContentBlock[]）
}
```

### 3.3 AgentPath（codex pattern，調整為 i-harness path 慣例）

```ts
export class AgentPath {
  // Team 內 path 慣例：`lead` 保留字；root = `lead`；teammate = `lead/<name>`
  static root(): AgentPath
  static parse(s: string): AgentPath      // 嚴格：segment /^[a-z0-9]+(-[a-z0-9]+)*$/ 或保留 lead
  name(): string; isRoot(): boolean
  join(name: string): AgentPath
  resolve(ref: string): AgentPath         // 相對（以自身為基底）/絕對解析
  toString(): string
}
```
- 唯一性：spawn 時 teamId + name 全域唯一；重複 → `TEAM_MEMBER_NAME_TAKEN`。
- `lead` 是保留名（Lead 偽列 name）；teammate 名稱不可為 `lead`。

### 3.4 TeamFoldState（增量快取）

```ts
interface TeamFoldState {
  members: Map<string, TeamMemberSnapshot>      // by name
  tasks: Map<string, TeamTaskSnapshot>          // by id（含 tombstone）
  queued: Map<string, TeamMessageSnapshot[]>    // by targetId（FIFO）
  delivered: Set<string>                        // messageId（已 ack）
  nextTaskId: () => string                      // `task-<uuid>`
}
export function foldTeam(events: SessionEvent[], opts?: { watermark?: number }): { state: TeamFoldState; watermark: number }
export function applyTeamEvent(state: TeamFoldState, event: TeamEvent): void  // 結構+規則驗證，違反 throw
```
- 增量：runtime 持有 `watermark`；每次查狀態前對 `session.events.slice(watermark)`
  重放（跳過非 team/* 事件）；`watermark = events.length`。
- 恢復：`coordinator.load(leadId)` → `foldTeam(events)`（完整）；無 document 投影。

### 3.5 Transact（read-check-append 原子）

```ts
export function createTeamTransact(lead: { append: (e: TeamEvent) => void; flush: () => Promise<void> }): {
  transact<T>(fn: (state: TeamFoldState) => { events?: TeamEvent[]; result: T }, signal?: AbortSignal): Promise<T>
}
```
- per-team promise 鏈串行化（單進程排他）。
- transact 內：讀 fold state（增量）→ 呼叫 fn → 對每個候選 event 先
  `applyTeamEvent`（fold 驗證，違反 throw，不寫入）→ `append` → `flush`
  （durability point）→ 更新 watermark。
- 失敗：任何一步 throw → 事件完全不進 log（read-check-append 原子性由串行鏈保證）。

## 4. 元件規格

### 4.1 Roster（`roster.ts`）

API：
```ts
listMembers(): TeamMemberView[]            // lead 偽列 + members（建立順序）
spawnTeammate(name, { description, prompt, context, role?, signal? }): Promise<TeamMemberView>
interrupt(name): Promise<{ previousStatus: string }>   // Lead-only；keepInbox
```

spawnTeammate 流程（transact 內）：
1. 驗證 caller = Lead（`TEAM_LEAD_REQUIRED`）、name 合法（`TEAM_INVALID_MEMBER_NAME`）。
2. `team/member` provisioning 事件（name taken → `TEAM_MEMBER_NAME_TAKEN`；
   maxMembers → `TEAM_MEMBER_LIMIT`）→ append+flush。
3. `spawnChild`（subagent 導出）：`parentPath = lead`，`taskName = name`；
   `forkTurns` 按 context（fresh→"none"；fork→"all" 或 fork_turns 欄位）。
4. **checkpointInitialPrompt 等價物**：等待 child session 持久持有初始
   `user/message`（觀察 child session append hook 出現 role user 的
   user/message，或 `coordinator.load(childId)` 掃尾部）；界 = startupTimeoutMs，
   超時 → 視為 provisioning 失敗。
5. 成功 → `team/member` active；失敗 → `team/member` failed（含 error）→
   `stopTeammates`（由 subagent 的 close 語意清 child）→ 回傳錯誤給 Lead。
6. **reconcileProvisioning**：mount/恢復時對每個 provisioning 成員——
   若 child session 存在且 durable（coordinator.load 成功、header.parentSession
   = leadId、initial user/message 存在）→ re-append active；否則 re-append failed。
   （同進程 race 由 transact 串行化防護；若 creator 發現已 reconciliation →
   回報 `TEAM_PROVISIONING_CONFLICT` 並保留終態。）

member status 映射（runtime，不寫 event）：`entry.status==="running"→running`、
`"waiting"→idle`、`completed/killed/error→inactive`、`provisioning（roster 內）→
provisioning`、`failed（roster 內）→failed`。Source：`TeamDeps.subagents.table`
（map path→entry.status；teammate path = `lead/<name>`）。

### 4.2 Mailbox（`mailbox.ts`）

API：
```ts
sendMessage(caller, { target, message, delivery: "quiet"|"wakeup", signal? }): Promise<{ messageId: string; status: "accepted"|"queued" }>
```

sendMessage（transact 內）：
1. 驗證 caller 是 member（`TEAM_NOT_MEMBER`）；target 是 active member（
   `TEAM_MEMBER_NOT_FOUND`）；禁自送（`TEAM_SELF_MESSAGE`）。
2. `team/message/queued`（含 content + delivery）→ append+flush（durable；
   `status: "queued"` 是接受證明，非重發指令）。
3. 嘗試 dispatch：quiet → 僅在 target live（in memory table 有 entry）時寫
   `subagent/inbox` 到 target session（不喚醒，不觸發 turn）；wakeup →
   `followup_task` 語意（入 inbox + `driveFollowups` 喚醒 target；inactive 可
   cold-resume）。target 非 live → 保持 queued（quiet）；wakeup 冷恢復。
4. **delivered ack**：投遞後確認 target session 持久持有該 messageId
   （等同 dsh 的 messageAccepted：target session events 出現
   `subagent/inbox { messageId }` 或帶 team 源的 `user/message`）→ 再 append
   `team/message/delivered`。觀察者路徑：target session append hook 看到
   team message id → 異步 ack（同 dsh 的 session/event 觀察者）。
5. **recovery**（mount/恢復）：對每個 targetId 的 queued−delivered 訊息——
   quiet 對 inactive target 跳過；wakeup 重投（cold-resume）。
6. FIFO per target：dispatchTails promise 鏈按 targetId 串行（同 dsh）。

### 4.3 Task board（`task-board.ts`）

API：
```ts
createTask(caller, { subject, description, blockedBy?, writeScopes? }): TeamTaskView
getTask(caller, id): TeamTaskView
listTasks(caller, opts?: { status?, owner?, ready?, cursor?, limit? }): { tasks: TeamTaskView[]; nextCursor? }
updateTask(caller, { taskId, expectedRevision, action, ... }): TeamTaskView
```

規則（transact 內；全部先驗證再進 log）：
- id = `task-<uuid>`（每 task 一次 revision 1 起）；`maxTasks` 僅計非 deleted
  （超限 → `TEAM_TASK_LIMIT`）。
- create：subject/description 非空；blockedBy 每個必須存在且非 deleted
  （`TEAM_TASK_NOT_FOUND`）；無自環/重複（`TEAM_TASK_DEPENDENCY_CYCLE`/
  `TEAM_INVALID_ARGUMENT`）；writeScopes 規範化（`\`→/`、去 `./`、去尾 `/`、
  拒絕對路徑/`..`/空段/drive letter；違反 → `TEAM_INVALID_WRITE_SCOPE`）。
- update：`expectedRevision !== task.revision` → `TEAM_TASK_STALE_REVISION`
  （附當前 revision）；actions 授權：owner 或 Lead = edit/release/complete/reopen/
  delete；claim = pending + ready + 無 owner（`TEAM_TASK_ALREADY_CLAIMED`/
  `TEAM_TASK_BLOCKED`）；reassign = Lead-only；delete 有非 deleted dependent →
  `TEAM_TASK_HAS_DEPENDENTS`；對 deleted → `TEAM_TASK_DELETED`。
- 每次 mutation revision +1；寫完整快照 `team/task`（tombstone 保留 id 不佔
  maxTasks、getTask 仍可取、listTasks 不含）。
- ready = 所有 blockers 皆 completed；writeScopeWarnings = 對其它 in_progress
  任務的前綴重疊警告（advisory，不阻擋 claim、不授權寫入）。

### 4.4 Activity（`activity.ts`）

API：
```ts
waitForChange(caller, timeoutMs, signal?): Promise<{ timedOut: boolean; noProgress?: { reason: "no-active-peer"; message: string } }>
```

- edge-triggered：只在註冊後發生的 edge 喚醒（roster/mailbox/task/live-status
  變更——由 transact commit + member status 變化觸發 notify）；已發生不 replay。
- timeout：`waitMinMs`(10_000)..`waitMaxMs`(3_600_000)，界外 → `TEAM_INVALID_TIMEOUT`；
  超時只回 `{ timedOut: true }`。
- **noProgress 下沉 domain**：waiter 註冊前，若「無其他 member 處於
  running/provisioning」→ 立即回 `{ timedOut: false, noProgress: { reason:
  "no-active-peer", message: "..." } }`（訊息指引 re-list + followup_task）。
- abort：Error reason 保留；disposal → 釋放所有 waiter（立即回
  `{ timedOut: false }`；之後新 wait 立即回）。
- 喚醒後 caller re-list（不重播變更內容）。

### 4.5 Invariant（fold 驗證）

- 結構驗證：每個 event 過 zod 嚴格 schema（team/* 四種 + version: 1）。
- 規則驗證（applyTeamEvent 內，違反 throw）：
  - member：首 event 必須 provisioning；不可 provisioning→provisioning；
    active→failed 非法；identity（id/name/description/provider/context）不可變；
    name 重用非法。
  - task：revision 必須 1 起連續 +1；id 格式 `task-<uuid>`；依賴全圖
    （含非 deleted dependent 的 delete 拒絕）在 apply 時已驗證（mutation 前驗證）。
  - mailbox：queue 不重複；delivered 前必有同 id queue；delivered 不重複；
    delivered.targetId 必須與 queued.targetId 一致。
- 驗證位置：**transact 內 append 前**（候選 events 先對「當前 fold state」
  applyTeamEvent 驗證，違反則 throw，不進 log）——i-harness 無 Cordis
  pre-commit 攔截，此為替代機制（完整度一致：append 前擋下）。

## 5. Tools（10 個，exact）

每個 tool 需 exact calling agent 身份（caller 由 dispatch 傳入的 entry 解析；
Team 工具只註冊在 Team member scope）。

| name | Lead | Teammate | inputSchema（簡） | output |
|---|---|---|---|---|
| `spawn_teammate` | ✅ | ✖ | name, description, prompt, context?("fresh"\|"fork"), fork_turns?("none"\|"all"\|N), role? | `{ member: TeamMemberView }` |
| `list_members` | ✅ | ✅ | (none) | `{ members: TeamMemberView[] }` |
| `send_message` | ✅ | ✅ | target(分 member/lead), message | `{ messageId, status: "accepted"\|"queued" }` |
| `followup_task` | ✅ | ✅ | target, message | 同上 |
| `wait_agent` | ✅ | ✅ | timeout_ms? | `{ timedOut, noProgress? }` |
| `interrupt_agent` | ✅ | ✖ | target | `{ previousStatus }` |
| `team_task_create` | ✅ | ✅ | subject, description, blocked_by?[], write_scopes?[] | `TeamTaskView` |
| `team_task_list` | ✅ | ✅ | status?, owner?, ready?, cursor?, limit? | `{ tasks: TeamTaskView[], nextCursor? }` |
| `team_task_get` | ✅ | ✅ | task_id | `TeamTaskView` |
| `team_task_update` | ✅ | ✅ | task_id, expected_revision, action(claim\|release\|edit\|set_dependencies\|complete\|reopen\|reassign\|delete), subject?, description?, blocked_by?, write_scopes?, owner? | `TeamTaskView` |

- `send_message`/`followup_task` 現有 subagent 版本（M9）已定義語意——Team
  工具版本團隊域專用；**兩者共存**（subagent 的 11 工具保留給非 Team 子代理；
  Team 成員的 scope 內額外註冊這 10 個）。工具名跨 scope 不衝突。
- teammate 無 spawn/interrupt（Lead-only authority 在工具執行層檢查，非僅描述）。

## 6. 錯誤處理（fail-closed）

| 情境 | 行為 |
|---|---|
| spawn 失敗（child 建立/初始 prompt checkpoint 超時） | provisioning→failed；名字保留；錯誤回 Lead |
| name 重用 / 非法 name / maxMembers | `TEAM_MEMBER_NAME_TAKEN` / `TEAM_INVALID_MEMBER_NAME` / `TEAM_MEMBER_LIMIT` |
| 非 member 調用 | `TEAM_NOT_MEMBER` |
| Lead-only 操作被 teammate 調用 | `TEAM_LEAD_REQUIRED` |
| send 到不存在/非 active、自送、mailbox 滿、超 byte | `TEAM_MEMBER_NOT_FOUND` / `TEAM_SELF_MESSAGE` / `TEAM_MAILBOX_FULL` / `TEAM_MESSAGE_TOO_LARGE` |
| task CAS stale / not found / deleted / unauthorized / already claimed / blocked / invalid transition / limit / dependency cycle / has dependents | 對應 `TEAM_TASK_*`（附當前 revision 於 stale） |
| wait 界外 | `TEAM_INVALID_TIMEOUT` |
| provisioning race（creator vs recovery） | `TEAM_PROVISIONING_CONFLICT`（保留終態） |
| disposal 後調用 | `TEAM_DISPOSED` |
| 恢復時 fold 遇到遺失/損壞事件 | load 失敗 → mount throw（fail-closed，不靜默降級） |

全部事件 append 前驗證；任何 invariant 違反 throw（不進 log）；mount 失敗
throw（釋放 reservation）。

## 7. Integration（i-harness）

### 7.1 Package 依賴（零新外部）
- `@i-harness/agent-team` deps（workspace）：`core-plugin`、`core-tools`、
  `core-session`、`session-persistence`、`subagent`、`zod`。
- required 小改：
  - `core-session`：SessionEvent union 新增四種 team/* 型別（含
    `deriveMessages`/`deriveSearchText` 顯式分支——**決定：team/* 事件
    model-hidden（deriveMessages 無分支，default 跳過）；deriveSearchText
    subject/message 可 FTS**）。
  - `session-persistence`：`KNOWN_EVENT_TYPES` 加四字串（或新增
    `registerEventType` 擴充點——優先 registerEventType，修 M16 sandbox/mode
    同類坑；若時間不足，最小 Set 加法 + 註解）。
  - `subagent`：導出 `spawnChild`/`ChildAgentEntry`/`AgentTable` 等既已導出；
    可能加導出 `driveFollowups`（若 agent-team 需自己驅動）。

### 7.2 Mount（scheduler.ts）

```ts
export interface TeamDeps {
  parentSession: ReturnType<typeof createSession>   // lead session（teamId = 其 id）
  parentRegistry: ToolRegistry
  subagents: {
    table: AgentTable; jobs: JobRegistry; roles: RoleRegistry; agents: AgentRegistry
    exec: ExecService; providers: ProviderRegistry; parentCtx: PluginContext
    childSessions?: { coordinator: SessionCoordinator; parentSessionId: string }
  }
  parentModel: ModelClient
}
export function mountAgentTeams(
  ctx: PluginContext, tools: ToolRegistry, deps: TeamDeps, config?: Partial<TeamConfig>,
): Promise<TeamMountHandle>
// TeamMountHandle { teamName: string /* lead id 或固定 "team" */; unmount(): Promise<void> }
```

- 驗證 config（validateTeamConfig）；reservation（module-level Set，單一 team；
  第二 mount → throw，同 M18 一server 慣例；多 team 是後續里程碑）。
- `reconcileProvisioning` + mailbox recovery（讀 lead session 完整 fold）。
- 註冊 10 工具（tools.register）；unmount = 釋放 waiter + abort children +
  unregister + 釋放 reservation（idempotent，M17/M18 pattern）。

### 7.3 CLI（run.ts）

- `HeadlessOptions.team?: Partial<TeamConfig>`（與 mcp/lsp 一致用 config 物件）。
- 掛載點：**registerSubagent 之後、createAgent 之前**（依賴 subagent
  table/jobs/agents/childSessions）；`teamHandles` 併入 combined mounts
  （mcpHandles/lspHandles/teamHandles reverse unmount）。
- 恢復：resumeSessionId 時 mountAgentTeams 在 restoredState 之後掛載
  （team 狀態從 lead session log 重建——load 已在 run.ts 早晚發生）。

## 8. Testing

1. **agent-path.test.ts**：parse/join/resolve（相對/絕對、保留字、非法 name throw、`..` 拒絕）。
2. **fold.test.ts**：增量重放（sequential events→state；watermark 快取只重放
   新 suffix）；結構驗證（malformed event throw）；規則驗證（member 轉移/
   name 重用/task revision 連續/queue-ack 關係——違反 throw 不進 state）。
3. **roster.test.ts**：spawn 三態（provisioning→active/failed）；name 永不重用
   （含 failed）；maxMembers；reconcileProvisioning（child 持久存在→active；
   不存在→failed）；TL_LEAD_REQUIRED。
4. **mailbox.test.ts**：queued→delivered（target 持久持有後 ack）；FIFO per
   target；quiet 不喚醒 / wakeup 喚醒+cold-resume；recovery 重送
   queued−delivered；delivered 不重複；maxPending/maxBytes。
5. **task-board.test.ts**：CAS（stale revision throw）；DAG readiness；
   tombstone（不佔 maxTasks、delete 有 dependent throw）；writeScopes 規範化 +
   重疊警告；權限（owner/Lead、Lead-only reassign）。
6. **activity.test.ts**：edge wait（註冊後才醒）；timeout；noProgress
   no-active-peer；disposal 釋放 waiter；abort。
7. **tools.test.ts**：10 工具語意（Lead/teammate 權限差異；spawn 非同步；
   wait noProgress）。
8. **lifecycle.test.ts**：mount 註冊 10 工具 / unmount unregister+dispose
   （waiter 釋放）；duplicate mount throw；config validation throw。
9. **CLI e2e**（apps/cli/test/cli.test.ts）：`runHeadless({ team: {...} })`
   mock model 呼叫 spawn_teammate → teammate 完成 → Lead 收到 FINAL_ANSWER →
   assert exitCode 0 + tool/result 事件。
10. **Regression**：`pnpm -r test` + `pnpm -r typecheck` 全綠。

## 9. Files touched

- Create: `packages/agent-team/`（package.json、tsconfig.json、src/* 10 個、test/* 9 個）
- Modify: `packages/core-session/src/index.ts`（union + derive 分支）
- Modify: `packages/session-persistence/src/index.ts`（registerEventType / Set 加法）
- Modify (optional): `packages/subagent/src/index.ts`（導出 driveFollowups 若需要）
- Modify: `apps/cli/src/run.ts`（HeadlessOptions.team + mount/unmount）
- Modify: `apps/cli/package.json`（workspace dep）+ `pnpm-lock.yaml`
- No new external deps; zod 已在。

## 10. Global constraints（binding）

- 無 dsh/codex 私有包（`@deepseek-ai/*`）；手寫 domain；zod 已有。零新外部依賴。
- ESM + strict TS；test 下 `test/*.test.ts`；vitest；新 package 0.1.0；無版本 bump。
- **新 event types 僅限 M19 定義的 4 種**（team/member、team/task、
  team/message/queued、team/message/delivered；version: 1），經
  `registerEventType` 或最小 Set 加法註冊；`CURRENT_FORMAT_VERSION` 維持 1。
- fail-closed：mount 失敗 throw；invariant 違反不進 log；teardown 限界；
  single team per run。
- 行為不變當未配置 `team`（純增量掛載）。
- 單進程、單共享 checkout；advisory write scopes（非鎖）。
- 不修改 subagent 11 工具契約、不修改 M6 snapshot format。

## Appendix A — dsh 參考摘要（domain）

`packages/experimental/agent-team`（v0.1.1-rc.2）：TeamId=SessionId 隱式 Lead；
四種 v1 event 全量快照；journal transact per-Lead 串行化；spawn =
provisioning→startContinuable(childId 預留)→checkpointInitialPrompt→active/failed
+ reconcileProvisioning + `TEAM_PROVISIONING_CONFLICT`；mailbox 先 flush queued
再 dispatch；delivered 以 target log 為唯一真相（queued−delivered recovery）；
task board = snapshot + revision CAS + DAG + tombstone + advisory writeScopes；
waitForChange edge-triggered（10s-1h）+ disposal 釋放 waiter；invariant
companion 用 Cordis internal/dispatch pre-commit 重放；disposal =
admission cutoff→settle→drain roster live children。

## Appendix B — codex 參考摘要（multi_agents_v2）

工具面 6 個（v2 移除 close/resume，改 LRU residency）；AgentPath 定址（resolve
相對/絕對）；`fork_turns: none|all|N`（取代 fork_context，拷貝 rollout 後精選
過濾：只留 user/system/developer + assistant-final）；mailbox = per-thread
in-memory deque + trigger_turn（pending 不持久——不取）；wait = 單一 watch
channel edge wait（無 noProgress）；完成通知 = child 每 turn 回投 FINAL_ANSWER
給 parent（interrupted 不發）；status 純由事件導出。
