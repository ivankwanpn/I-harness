# 2026-08-26 — dsh Agent Teams Domain 深度研究報告

研究對象：`D:\agent-complete\deepseek-harness-dsh-v0.1.1-rc.2\deepseek-harness-dsh-v0.1.1-rc.2\packages\experimental\agent-team`（`@deepseek-ai/dsh-experimental-agent-team`，v0.1.1-rc.2）。所有行號為該版本實際原始碼。
（內容由並行研究子代理產出，協調代理落盤）

## 1. 整體設計：`ctx.agentTeams` API 面

`TeamService`（`src/index.ts:57-256`）是一個 Cordis `Service`，`static inject = ['agents','sessions','sessionPersistence','subagents']`（`index.ts:57`）。構造時掛三個全域觀察者（`index.ts:107-114`）：

- `session/event` → `mailbox.observeSessionEvent`（目標端 ack checkpoint）
- `agent/session-start` → `scheduleRecovery`（微任務排程，`index.ts:226-234`）
- `agent/status` → `activity.notify(TeamId(agent.id))`（喚醒 waiters）
- `ctx.effect` 註冊 `disposeRuntime`（`index.ts:113`），並對既有 `ctx.agents.list()` 逐一排 recovery。

| 方法 | 位置 | 語意 |
|---|---|---|
| `membership(agent)` | `index.ts:128-133` → `roster.ts:75-82` | 用 exact live Agent 當身分憑證；非成員拋 `TEAM_NOT_MEMBER` |
| `listMembers(agent)` | `index.ts:136-140` → `roster.ts:136-163` | Lead 偽列 + 成員列（建立順序）；`status` 由 durable phase 與 live Agent 混合（`roster.ts:151-160`） |
| `spawnTeammate(caller, req)` | `index.ts:145-150` → `roster.spawn` | 只限 Lead；見 §2 |
| `sendMessage(caller, req)` | `index.ts:154-159` → `mailbox.send` | 見 §3 |
| `createTask` / `getTask` / `listTasks` / `updateTask` | `index.ts:161-196` | 見 §4 |
| `waitForChange(caller, timeoutMs, signal)` | `index.ts:199-206` → `activity.wait` | 見 §5 |
| `interrupt(caller, targetName)` | `index.ts:211-219` → `roster.interrupt` | 只限 Lead；`TEAM_LEAD_REQUIRED` / `TEAM_INVALID_TARGET`（不可 interrupt 自己）；委派 `ctx.subagents.interrupt(target.id, {kind:'ancestor', agent:caller})`（`roster.ts:203-216`），**不清 inbox** |
| `tryMembership(agent)` | `index.ts:222-225` | 非拋出版本，供 scoped tool 安裝與生命週期觀察者 |

**錯誤碼全集**（`TeamError extends HarnessError`，`error.ts:10-16`；code 以字串散布各處）：
`TEAM_INVALID_CONFIG`、`TEAM_DISPOSED`、`TEAM_DISPOSAL_TIMEOUT`、`TEAM_NOT_MEMBER`、`TEAM_MEMBER_NOT_FOUND`、`TEAM_MEMBER_NAME_TAKEN`、`TEAM_MEMBER_LIMIT`、`TEAM_INVALID_MEMBER_NAME`、`TEAM_LEAD_REQUIRED`、`TEAM_INVALID_TARGET`、`TEAM_PROVISIONING_CONFLICT`、`TEAM_INVALID_ARGUMENT`、`TEAM_INVALID_WRITE_SCOPE`、`TEAM_SELF_MESSAGE`、`TEAM_MAILBOX_FULL`、`TEAM_MESSAGE_TOO_LARGE`、`TEAM_TASK_NOT_FOUND`、`TEAM_TASK_STALE_REVISION`、`TEAM_TASK_DELETED`、`TEAM_TASK_UNAUTHORIZED`、`TEAM_TASK_ALREADY_CLAIMED`、`TEAM_TASK_BLOCKED`、`TEAM_TASK_INVALID_TRANSITION`、`TEAM_TASK_LIMIT`、`TEAM_TASK_DEPENDENCY_CYCLE`、`TEAM_TASK_HAS_DEPENDENTS`、`TEAM_INVALID_TIMEOUT`、`TEAM_WAIT_ABORTED`。

Config（`index.ts:60-64`，正整數安全整數驗證 `index.ts:49-53`）：`maxMembers=8`、`maxTasks=256`、`maxPendingMessagesPerMember=64`、`maxMessageBytes=65536`、`disposalTimeoutMs=5000`。

## 2. Roster（`src/roster.ts`）

- **隱式 Lead**：`TeamId = root SessionId`（`types.ts:13-20`；brand 只是字串，無 Team creation event——Lead 偽列是 identity 存在本身，`list()` 硬編碼插一路 `{name:'lead', role:'lead', status: root.status}`，`roster.ts:141-149`）。`name === 'lead'` 是保留字（`roster.ts:452`）。
- **durable snapshot**：`TeamMemberSnapshot { id: SessionId, name (kebab ≤64, 不可變), description, provider, context: 'fresh'|'fork', phase: 'provisioning'|'active'|'failed', error? }`（`types.ts:31-39`）。名稱 regex `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`（`roster.ts:23`）。**名字永不重用**（含 failed）。`maxMembers` 計入所有曾經 provisioned 的成員（含 failed，`roster.ts:272-274` 是 `state.members.size`）。
- **spawn 流程**（`spawnAdmitted`，`roster.ts:246-335`）：
  1. 驗證 Lead/name/description/provider/abort（`roster.ts:248-257`）
  2. `childId = SessionId(randomUUID())` 由 caller 預留（`roster.ts:257`）
  3. `journal.transact` 內 **先 append+flush `team/member` provisioning**（`roster.ts:270-279`；name taken → `TEAM_MEMBER_NAME_TAKEN`，超限 → `TEAM_MEMBER_LIMIT`）
  4. `ctx.subagents.startContinuable({childId, provider, label, request:{prompt, parent:root}, signal})`（`roster.ts:282-288`）
  5. `checkpointInitialPrompt`：確保**初始 prompt 已在 child Session 持久**（live: 等 `session/event`/`session/disposed` + flush + 掃 suffix；detached: `sessionPersistence.inspect` 掃 suffix；`roster.ts:337-395`）
  6. 成功 → `settleProvisioning(active)`（`roster.ts:319-331`）→ 回 `memberView`；失敗 → 先 append **failed** snapshot 再 `stopTeammates` 清 child，若 creator 失敗但 recovery 已判 active → `TEAM_PROVISIONING_CONFLICT`（`roster.ts:292-313`），並 AggregateError 合併原始錯誤。
- **恢復**（`reconcileProvisioning`，`roster.ts:397-441`）：root 啟動時對每個 provisioning 成員——若 live child 存在（同進程還在做）就跳過；否則 `persistence.inspect` + `foldSubagentDescriptor(suffix)` 驗證 **parentSession === root.id && descriptor.mode==='continuable' && descriptor.provider===member.provider && 初始 user message 已 accepted（pending inbox 或 history）**（`roster.ts:410-421`）；不匹配 → failed（含原因）。settle 在 transact 內 re-check 仍是 provisioning 才寫入（`roster.ts:425-434`），這就是反向 race 的防護：creator 的 `settleProvisioning` 若看到已被 recovery 終結 → 回傳對方 phase → creator 判斷 `TEAM_PROVISIONING_CONFLICT` 並 drain child（`roster.ts:301-307, 321-329`）。
- **spawn 依賴 continuable-subagent**：`startContinuable` 的 `childId` 預留、`ContinuableStart{childId,messageId}`（`subagent/src/continuation.ts:112-143`）、`foldSubagentDescriptor`（`subagent/src/descriptor.ts:308`）、`drainContinuableChildren/drainContinuableDescendants`（`subagent/src/index.ts:304-326`）。
- **member 非 live → `inactive`**（`roster.ts:158`），wakeup delivery 會透過 `subagents.followup` 冷恢復。

## 3. Mailbox（`src/mailbox.ts`）

- **`sendMessage`**（`sendAdmitted`，`mailbox.ts:109-153`）：transact 內驗證 target 是 active member（`resolveActiveMember`，非 active → `TEAM_MEMBER_NOT_FOUND`）、禁自送（`TEAM_SELF_MESSAGE`）、pending = queued-minus-delivered 數量 ≥ 上限 → `TEAM_MAILBOX_FULL`、byte 上限（**含傳遞框架** `Team message <id> from <name>:` + 內容，`mailbox.ts:138-141`）→ `TEAM_MESSAGE_TOO_LARGE`，然後 **append+flush `team/message/queued`**（`mailbox.ts:143-146`），**在釋放 root 交易前註冊 dispatch**（`mailbox.ts:147-149`）──這保證並發 sender 以 durable queue 順序進入 target 本地隊列。回傳 `{messageId, status: accepted|queued}`；**queued 不是重發指令**。
- **quiet vs wakeup**：quiet → `target.inject(...)`（next-step、**不喚醒**；target live 才投、否則保持 queued）；wakeup → `target.followup(...)`（next-turn、喚醒，冷恢復）。Lead 自身當 target 時相同（`mailbox.ts:240-266`）。delivery 內容以 `createUserMessage({content, source})` 帶 `source.kind==='team-message'`（`mailbox.ts:233-238`）。
- **delivered ack**（`checkpointDelivered`，`mailbox.ts:282-289`）：**先 flush target Session**，再確認 target 的 suffix（pending inbox 或 history）真持有該 messageId（`targetRecorded` 用 `session-message.ts` 的 `messageAccepted` 折疊 `agent/inbox/spliced` + `user/message`），然後 Lead 才 append+flush `team/message/delivered`（`markDelivered` 冪等且驗證 queued.targetId 相符，`mailbox.ts:292-305`）。觀察者路徑：`session/event` 上看到帶 team-message source 的 `user/message` 時也會異步 ack（`mailbox.ts:67-80`）。
- **FIFO per target**：`dispatchTails` promise 鏈按 target 序列化（`serializeDispatch`，`mailbox.ts:200-224`）；quiet 對「已在 active dispatch 中且序號較前」的訊息走快速通道（`tryDispatchAdmitted`，`mailbox.ts:190-194`）。
- **恢復**（`recoverFor`，`mailbox.ts:84-99`）：對每個 queued-minus-delivered 且 (role==lead 或 targetId===自己) 的訊息重 dispatch；**lead 的 quiet 對 inactive target 跳過**（避免冷起 inactive，`mailbox.ts:94-96`）。
- **去重**：target 已記錄（persisted inspect，`persistedTargetRecorded` `mailbox.ts:323-331` 失敗回 `undefined` → 保持 queued）→ 只 markDelivered，不再投（`mailbox.ts:255-261`）。
- 保證等級：**process-local retry + target 端去重，非跨進程 exactly-once**（README + agent note）。

## 4. Task board（`src/task-board.ts` + `src/task-graph.ts`）

- `TeamTaskSnapshot` 完整快照 + `revision` CAS（`types.ts:56-63`）；每次 `updateTask` 需 `expectedRevision`，不符 → `TEAM_TASK_STALE_REVISION`（`task-board.ts:120-123`）。
- id `task-<n>`：`state.nextTaskNumber`（fold 掃描計算，`fold.ts:256-259`；MAX_SAFE_INTEGER 時不 +1）；`state.tasks.has(id)` 命中 → `TEAM_TASK_LIMIT`（id 空間耗盡，`task-board.ts:56-58`）。
- **maxTasks 只計非 deleted**（`task-board.ts:50`）；deleted 保留 tombstone、佔 id 但不出現在 `listTasks()`、`getTask` 仍可取（`task-board.ts:80-86, 89-96`）；對 deleted 做 update → `TEAM_TASK_DELETED`。
- **DAG 驗證**（`task-graph.ts:31-66`）：自環/重複邊 → `TEAM_TASK_DEPENDENCY_CYCLE` / `TEAM_INVALID_ARGUMENT`；blocker 必須存在且非 deleted → `TEAM_TASK_NOT_FOUND`；對**整張 active 圖**做 DFS 環檢查（不只候選快照）。刪除時若有非 deleted dependent → `TEAM_TASK_HAS_DEPENDENTS`（`task-board.ts:193-199`）。
- **授權**：owner 或 Lead 可 edit/release/complete/reopen/delete（`authorizeOwner`）；claim 需 pending + ready + 無人擁（`TEAM_TASK_ALREADY_CLAIMED`/`TEAM_TASK_BLOCKED`）；reassign 只限 Lead（`TEAM_LEAD_REQUIRED`），`owner: ''` 是 unassign；ready = 所有 blockers completed（`task-board.ts:252-254`）。
- **writeScopes**：norm 後去重（`writeScope`，`validation.ts:25-34`：`\`→/`、去 `./`、去尾部 `/`、拒絕對路徑/`..`/空段/`C:`）；`taskView` 對其它 in_progress 任務做 prefix 重疊警告 `write scopes overlap with <id>`（`task-board.ts:275-280`，`scopesOverlap` L14-16）；**advisory，不阻擋 claim、不授權寫入**。
- `wait_agent` 的 **noProgress** 在工具層（`experimental/tool-agent-team/src/index.ts:236-270`）：當 `listMembers` 沒有其他 running/provisioning 成員時**同步地**回 `{timedOut:false, noProgress:{reason:'no-active-peer'}}`，否則才呼叫 `waitForChange`。domain 層本身只有 `{timedOut}`。

## 5. waitForChange（`src/activity.ts`）

- `wait(id, timeoutMs, signal)`：timeout 限制 10,000–3,600,000 ms，否則 `TEAM_INVALID_TIMEOUT`（`activity.ts:24-25`）；**edge-triggered**——只在註冊後發生的事件喚醒（`activity.ts:29-70`），已發生的變更不 replay；回傳 `{timedOut: boolean}`。
- abort：Error reason 原樣保留，非 Error reason 包成 `TEAM_WAIT_ABORTED` 且用 `inspect` 結構化（`activity.ts:44-52`）。
- `close()`（disposal）：`closed=true` 且**釋放所有既有 waiter**（resolve `{timedOut:false}`，`activity.ts:84-88`）；之後新 wait 立即回 `{timedOut:false}`（`activity.ts:28`）。
- 喚醒來源：journal `onCommit`（**flush 成功後**才 `notify`，`journal.ts:66-69`）+ `agent/status` 事件（`index.ts:109-111`）。wait 完後 caller 要自己 re-list 認證狀態（README）。

## 6. invariant replay（`src/invariant.ts` + `src/fold.ts`）

- `./invariant` companion：`ctx.on('internal/dispatch', ..., {global:true})` 攔 `session/event` 的 **pre-commit** 階段（`invariant.ts:26-47`）；對候選 event 用「**當前已提交 prefix** 的 `foldTeam` + `applyTeamEvent(state, event)`」重放，任何違反 → `fail(...)` 阻止 append。測試證明 rejected event 不進 session（`tests/invariant.spec.ts`）。
- fold（`fold.ts:208-282`）重放檢查：**成員轉移**（`provisioning` 起點、不可 `provisioning→provisioning`、`active→failed` 非法；identity 欄位不可變；name 重用）；**任務 revision 連續**（必須 1 起、+1 遞增）；**任務 id 安全整數**（`task-(\d+)` suffix 超出 safe integer → schema 拒絕）；**依賴**（`assertTaskGraphCandidate` 全圖）；**queue 不重複 / delivered 不重複 / delivered 前必有 queue / ACK target 必須與 queued target 一致**（`fold.ts:263-274`）。
- **結構驗證**：每種 payload 先過 zod `.strict()` schema（`fold.ts:22-125`）；ContentBlock 對 5 個 core variant 嚴格、plugin variant 用 `{type: string}` loose + 排除 core type set 保留（`fold.ts:33-63`）。
- **TeamId 選擇**：非本 Team 的繼承記錄直接忽略；**unsupported version 若是繼承的先行忽略，若不屬本 Team 也忽略**，但屬於本 Team 的 v≠1 → 拋出（`fold.ts:209-217`）；繼承的 v1 仍需完整結構驗證（`fold.spec.ts` 有測試）。Session `seq`/`time` 是排序權威，Team snapshot 不自帶時間戳。

## 7. 持久化

- 全部 team 狀態在 **Lead Session log**，4 種 event，都 `{version:1, teamId, ...}`（`types.ts:160-175` 的 `SessionEventMap` 宣稱合併模組）：`team/member`、`team/task`、`team/message/queued`、`team/message/delivered`。
- `TeamJournal`（`journal.ts`）：`state(root) = foldTeam(root.id, root.session.events)`（`journal.ts:31-34`——**每次讀都重放整個 log**，無快取）；`transact(rootId, op)` 是 per-Lead **promise 鏈串行化**（`journal.ts:38-50`），保證 read-check-append 原子性；`appendAndFlush` = `session.append`（局部瘦身版，剔除 surface 參數）+ `sessions.flush` + `onCommit`（`journal.ts:55-70`）。
- `session-message.ts` 的 `messageAccepted` 折疊 `agent/inbox/spliced` 的 pending 投影（next-turn+next-step）+ 已記錄 `user/message`（`session-message.ts:10-32`）——這是「target 已持有」的判定金鑰。
- `foldTeam` 每次呼叫都重建 `TeamFoldState`（`fold.ts:287-291`），無增量投影；這是純函數 replay 設計。
- 對 Session 依賴：`SessionEventMap` merge（dsh-session/types）、`agent/inbox/spliced`、`user/message`（含 `source`）、`SessionId`/`SessionHeader.parentSession/seedLength`、`session.events`/`header.seedLength`、`sessions.flush`、`session/event`+`session/disposed` 事件、`sessionPersistence.inspect`（回 `{events, meta:{parentSession, seedLength}}`）。

## 8. 活動/生命週期（`src/lifecycle.ts` + `index.ts:243-255`）

- `TeamRuntimeLifecycle`：單一 `AbortController`，`close()` 以 `TEAM_DISPOSED` abort（`lifecycle.ts:46-47`）；`disposed` = signal aborted；`isCancellation` 沿 Error cause 鏈識別（`lifecycle.ts:33-43`）。
- `disposeRuntime`（`index.ts:243-255`）：`lifecycle.close()` + `activity.close()` → `settle(pendingCreations)`（`roster.inFlightCreations`）→ `settle(pendingDispatches)`（mailbox in-flight）→ 對每個 `liveChildrenByRoot()` 的 (root, childIds) 呼叫 `roster.stopTeammates`（`subagents.drainContinuableChildren`；**只放 roster 裡的 live direct children**，非 Team 的 continuable child 不動；`roster.ts:222-241`）；`settle` 只保留非取消的 rejection，`withTimeout`（`disposalTimeoutMs`）包住每個 settle/stop 操作，超時 → `TEAM_DISPOSAL_TIMEOUT`，失敗 → AggregateError。
- **冷恢復**：wakeup delivery 對 absent target 走 `subagents.followup`（內部 cold resume），delivery 失敗 → warn + `return false`（message 保持 queued）。

## 9. 限制/非目標（README「Known Limitations」）

1. **單進程、單共享 checkout**——無 worktree/remote/merge/fs lock。
2. **Advisory write scopes**——Bash/formatter/外部寫者可繞過；無鎖語意。
3. **扁平不可變 roster**——只有 Lead 建 direct children；無 nested Team/rename/delete/name reuse。
4. **無自動 owner 釋放**——idle/interrupt/process exit/failed 都不釋放 task owner。
5. **Mailbox 非跨進程 exactly-once**——單 Team 多進程不支援；本 release 無跨進程共享信箱交易、無 mailbox timeline UI。
6. （README 還有：pre-confirm 前不創建 Team 成員的 delegation policy 在 tool 層；Team 工具是 opt-in。）

## 10. 測試覆蓋（test 名稱層級）

- **tests/team.spec.ts**（47 個 it）：identity/provisioning 16 個——limit 驗證、pre-existing root 恢復、fresh/fork 建立與名稱管轄、**child-before-Lead flush 順序**、checkpoint live/detached/abort、checkpoint 失敗 drain、failed 計數+名稱保留、非 Error provider 失敗、倒轉 settlement race（AggregateError、durable 仍 active）、recovery 先 settle 的清理、continuation 先 settle 的 conflict、名字/權限、fork 換 root 過濾繼承、stale identity/non-Team subagent、orphan provider child；task DAG 6 個——id 空間耗盡、tombstone 不佔 maxTasks、CAS/ownership/deps/transitions/write-scope warnings、malformed scopes 與依賴、不完整 mutation、Lead reassign 權限、partial edit/unassign；mailbox/wait 12 個——busy Lead 的 wakeup 持久化順序（`agent/inbox/spliced`→`team/message/delivered`）、live receipt flush 不重複、busy target inbox ack、並發 wakeup 串行、target history 去重 + inspect/delivery 失敗收容、quiet 休眠 + wakeup FIFO + 去重、byte/count 限制不鼓勵重發、interrupt 保 inbox、wait 一次變更/取消/超時/HMR 釋放；disposal 10+ 個——dispose 釋放 waiter+child、admission 關閉、in-flight creation cleanup 失敗保留、wrapped/cyclic cancellation 識別、failed edge 後仍 dispose live child、cold dispatch abort、async ack 等待、drain 卡死超時、recovery 失敗收容、容器化 teardown 失敗、mismatch reconcile + concurrently settled。
- **tests/persistence.spec.ts**（JSONL + SQLite 兩個 backend × 5 個 it）：crash-only provisioning prefix 重建（active vs failed）、pending initial prompt 還原、**queued-minus-delivered FIFO 重送且 quiet 不喚醒**、**target 已記錄後 restart 不重複投**、**target durably pending 不 cold-resume 重複**。
- **tests/invariant.spec.ts**（2 個）：首 edge 必須 provisioning、非法依賴在 append 前被拒。
- **tests/fold.spec.ts**（10 個）：繼承記錄過濾、member 身份/生命週期、revision 連續、所有非法依賴、非標準 task id 不改 allocator、超 safe-integer id 拒絕、queue/ack 關係、payload 結構驗證、merge-extensible content block、unsupported version（本 Team 拒絕/繼承忽略/繼承 v1 仍驗證結構）。
- 測試揭示的設計決策：**durable 斷言用 fold 而非 service view**（durable() helper）；**同進程 race 用 journal transact + re-check 解決**；**「accepted 前後 crash」的視窗以 target log 為唯一真相**。

---

## 特別標註：若搬到 i-harness 需要什麼依賴（嫁接點）

i-harness 現有(主要對照 `packages/core-session`、`packages/core-agent`、`packages/subagent`、`packages/session-persistence`、`packages/core-plugin`)。

| dsh 依賴 | dsh 實作位置 | i-harness 現況 | 差距 |
|---|---|---|---|
| **Agent 模型**（status getter、`options.model`、`session`、`inject`/`followup`/`cancel({keepInbox})`/`whenIdle`、`ctx.agents.get/list/resume`） | `packages/core/agent-loop/src/agent.ts:83-200`；`ctx.agents` 在 agent package | `packages/core-agent/src/index.ts:35-45`：`Agent {run, followup, compact}`，無 status/session/options/inject/cancel/whenIdle；registry 只有 `register/get/remove`（`index.ts:168-180`） | **重大缺口**：team 的 `inactive` 判斷、quiet inject vs wakeup followup、interrupt keepInbox、agent/status 事件、await 冷恢復，全部缺 |
| **Session event map**（merge-extensible、`SessionEventMap` declare module、ignorable） | `packages/core/session/src/types.ts:236+` | `core-session/src/index.ts:8-38`：**closed union**，無 merge 機制；`subagent/inbox` 代替 `agent/inbox/spliced`；user/message 是 `string`（無 ContentBlock[]、無 source、無 message id） | **重大缺口**：需新增 event 型別（或擴充 union）；`agent/inbox/spliced` 未有；無 `session/event` 事件與 `session/disposed`（只有 createSession 的 appendHooks WeakMap，`core-session/src/index.ts:37-43`） |
| **ContentBlock**（text/reasoning/image/tool-call/tool-result + extension）、`MessageSourceMap` merge、`createUserMessage`、`UserMessage.id` | `@deepseek-ai/dsh-llm` | `llm-seam`/`core-session` 只有 `LLMContentPart {text|image}`；無 `source`、無 message id | 需自建 team-message source 投影或改用 text prefix 約定 |
| **Continuable subagent**（`startContinuable` 含 caller-reserved childId、`followup` 冷恢復、`interrupt(ancestor authority)`、`drainContinuableChildren/Descendants`、`foldSubagentDescriptor`） | `packages/subagent/subagent/src/{index,continuation,descriptor}.ts` | `packages/subagent`：`spawnChild`（角色/工具/model 解析）+ `followup_task`（`subagent/inbox` + `driveFollowups` 串行）+ `resume_agent`（cold resume）+ `interrupt_agent`（abort controller）；keyed by **path 名**，狀態 `running/waiting/completed/killed/error`；persistence 是 **M6 snapshot via putDocument**，非 per-event log 重放 | **半換不缺**：有 child session（M8 `child-<uuid>` + lineage header）與 followup 驅動，但無 childId 預留 API、無 durable descriptor event、無 「drain 只放特定 children」、無 ancestor authority 模型、無 agent/status 邊 |
| **Session persistence**（`inspect(id, signal)` → `{events, meta:{parentSession, seedLength}}`） | `packages/session/session-persistence/src/coordinator.ts:787` | `session-persistence/src/index.ts`：`coordinator.load(id)` 回 `{session}`（header 在 session.header）；無 `inspect(signal)`；寫入是 **write-behind 非精確 checkpoint**（M7，`write-behind.ts`） | 中等：需包一個 inspect 等價物，且**每條 team event 都強制 flush** 與 write-behind 延遲（200ms 視窗）衝突——為 team 語意可能需要同步 checkpoint 路徑 |
| **內建 invariant 機制**（`internal/dispatch` pre-commit + `ctx.invariants.register`） | `packages/core/session/src/invariant.ts:233`；`experimental/agent-team/src/invariant.ts` | `core-plugin` 只有 `on/emit/waterfall/cascade/guard`，**無 pre-commit dispatch 攔截、無 invariant registry** | 如需同級防護，在 append 掛鉤（appendHooks）做 fold 驗證是可替代點，但需注意 appendHooks 已存在可掛（`core-session/src/index.ts:37-43`） |
| **fold 重放** | `agent-team/src/fold.ts`（zod strict schema + 邏輯規則） | 無 fold 文化；session-query 是簡易投影 | 移植性中等：zod 已是專案未有的依賴；邏輯可平移 |
| **Cordis 服務/事件語意**（transact 串行化、ctx.effect disposal、AbortSignal.any） | `@deepseek-ai/cordis` | `core-plugin` 的 `PluginContext`（scope.mount/unmount、services.get） | 中等：服務註冊模式相似，但無 effect 型 disposer 鏈（有 unmount 5s timeout）、無 global listener 語意 |

**關鍵整合決策要點**：(a) i-harness 的 subagent 是「root 名下 registry + path 名 + snapshot 持久化」，dsh 是「SessionId 命名 + log 重放 + expiry-free」——搬 mailbox/task 層最省力的是**保留 dsh 的 team 事件記在 coordinator session log**，但 reader 重放；或搬 M6 snapshot 式。 (b) i-harness 沒有 Agent.status 邊，`waitForChange` 的 status edge 與 `inactive` 判定需先補。 (c) i-harness core-session 無 seq/time 權威時間戳（append 時給 seq，`core-session/src/index.ts:44-47` 有），fold 邏輯可用。

## 設計優缺點直觀評估

**好（值得對齊）**
1. **Lead log 即 team 狀態 + 整份快照事件**：四種 event 全量快照、無 delta 推導，配合 fold 純函數 replay——獨立可檢查、無投影失誤空間，對「agent 寫碼」場景是極佳的除錯基底。
2. **provisioning→active/failed + childId 預留 + checkpoint 順序**（child 先持久、Lead 後 active）：crash 視窗閉合得乾淨，`TEAM_PROVISIONING_CONFLICT` 用「creator 重讀終端 phase」處理同進程 race，比任何鎖都簡單可靠。名字永不重用 + failed 佔位也是「可解釋性優先」的正確取捨。
3. **delivered ack 以 target log 為唯一真相**（queued-minus-delivered = recovery mailbox；target 已在 inbox/history 即不重投）：去重金鑰落在 target Session 的 source 上，跨 crash 不重複，且不需要 distributed tx。
4. **CAS revision + 完整 DAG 驗證 + tombstone 不佔預算**：任務板語意精確，錯誤碼映射清楚（cycle/missing/duplicate 分離）。
5. **per-Lead transact promise 鏈 + flush 後才 notify**：同進程內排他、waiter 語意可預期。
6. **invariant pre-commit replay**（`internal/dispatch` + fold）：防護在 append 前，重放成本 O(log) 但只在事件寫入時發生；「Session seq/time 是排序權威」讓 payload 乾淨。
7. **Advisory write scopes 誠實化**：明確說「不是鎖」，避免 false mutual exclusion——比假鎖好。
8. **disposal 結構**（admission cutoff → settle admitted → 只放 roster 的 live children + 後代、不碰非 Team child）：HMR 安全，且「cleanup 失敗讓 disposal 失敗」是對的 fail-loud。

**反直覺/過重/脆（應改良或丟棄）**
1. **每次讀取都 `foldTeam` 重放整條 Lead log**（`journal.ts:31-34`）：`listMembers/getTask/listTasks` 都是 O(全 log) 且無快取；成員 8、任務 256、訊息 64 的上限下 log 會隨時間線性增長（delivered + deleted 歷史都在），長 session 上這些讀取會明顯退化。→ 我們應做「帶 seq watermark 的增量 fold 快取」，事件到達時只重放新 suffix。
2. **mailbox 完整保留內容直到 ack、且 quiet 對 inactive 可無限期 pending**：訊息 byte 上限只在 queued 時檢查；若 target 永不 materialize，Lead log 永久增長且無 TTL。→ 應加年輕化/回收規則（例如限 age 或數量的 pending 上限主動淘汰 + 警告）。
3. **任務刪除只 tombstone 但 revision 鏈仍連續、nextTaskNumber 只在 fold 時掃描**：`task-<n>` 依賴 MAX_SAFE_INTEGER 邊界處理（`fold.ts:256-259`）與「duplicate id → LIMIT」的隱晦等價，是為「id 穩定」付出的代價；兩者都可以用「無 limit 的 UUID task id + 獨立排序欄」取代，簡化得多。
4. **`TEAM_TASK_UNAUTHORIZED` vs `TEAM_TASK_STALE_REVISION` 在並發時的順序**：先查 revision 再查授權，意味著 owner 被換掉後舊 caller 得到的是 stale 而非 unauthorized——對模型來說可接受但不直覺；若模型重試會再撞 unauthorized。
5. **「單進程單共享 checkout」下 wakeup 冷恢復與 quiet inject 的語意分裂**：`delivery: quiet|wakeup` 兩個模式本質是「要不要喚醒」，但行為在「target 是否存在」上有四種組合（live/inactive × quiet/wakeup），導致的規則（inactive quiet 永遠 queued）對模型使用者不透明——tool 層 POLICY 文字很長就是證據。→ 我們可用單一 `delivery` 語意（一律 next-turn）並讓「是否喚醒」由工具層策略決定。
6. **連工具層都攔截的 noProgress 快路徑**做在 tool（`tool-agent-team/src/index.ts:236-270`）而**不在 domain**：好處是快，壞處是 domain 與 tool 兩處都有 wait 語意、且 noProgress 判斷與 wait 註冊必須保持同一個同步 span（測試也特別保護這個 gap）。屬可接受的權衡，但搬遷時應考慮把「是否可進步」的判斷下沉到 domain。
7. **錯誤碼 28 個、無集中表**：散在 8 個檔案；README 也未列全。→ 搬遷時集中一個 `codes.ts` 並生成 doc。
8. **隱式 Lead + 無 creation event**：省了 event 但讓「建立 team」變成「第一個 member 存在才成立」的隱晦推論（`tryMembership` 對任何 root agent 都成立 lead 角色），對查詢/統計不友好。若我們做 SPA/UI，建議補一個顯式 `team/create` 或至少 projection 層的 team 表。
9. **agent/status 事件觸發 notify 但 roster/status 變更沒有 payload**：waiter 醒來後必須 re-list（設計如此），但「什麼變了」不傳遞，導致每醒必重掃——可接受，但可考慮帶 changelog。
10. **`.invariant` 依賴 Cordis `internal/dispatch`**：這是 Cordis 內部事件，搬遷到 i-harness core-plugin 需要新造 pre-commit 掛鉤（append 前攔截），否則退化為「append 後驗證」（防護力下降）。

## 最終回報（short）

**10 個最重要發現（one-liners）**：
1. Team 狀態 100% 在 Lead Session log 的四種 v1 event（member/task/queued/delivered），無獨立 store，每次讀都 foldTeam 全量重放。
2. spawn 順序是「append provisioning→startContinuable(childId 預留)→child 初始 prompt 持久化成功→append active；失敗 append failed」，同進程 race 以 settleProvisioning 重讀 phase + `TEAM_PROVISIONING_CONFLICT` 閉合。
3. 名字 kebab≤64 永不重用（含 failed，也佔 maxMembers 額度）。
4. mailbox 先 flush `team/message/queued` 再投；delivered ack 必須在 target Session 持久持有該 messageId（inbox 或 history 折疊）之後才 append，recovery 送 queued-minus-delivered 且 FIFO per target。
5. queued 不是重發指令；quiet 對 inactive 永遠 queued、wakeup 才會冷恢復。
6. 任務板是 CAS revision + 完整快照；id `task-<n>` safe-integer、tombstone 保 id 不佔 maxTasks；DAG 檢查全圖（含未刪除 dependent 的 delete 拒絕）。
7. waitForChange 是 edge-triggered（註冊後才看）、10s–1h、timeout 只回 timedOut、disposal 立即釋放 waiter、「noProgress」快路徑其實在 tool 層。
8. invariant companion 用 Cordis `internal/dispatch` pre-commit 對「已提交 prefix + 候選 event」重放 applyTeamEvent，違反即拒絕 append。
9. disposal 是「admission cutoff → settle admitted creations/dispatches（withTimeout 5s）→ 只 drain roster 的 live direct children + 後代，不動非 Team continuable child，失敗拋 AggregateError」。
10. README 明示五大非目標：單進程單 checkout、advisory write scopes、扁平不可變 roster、無自動 owner 釋放、mailbox 非跨進程 exactly-once。

**搬來 i-harness 只保留 5 樣，我會選**：
1. **Lead-log 四事件 + 完整快照寫法**（member/task/queued/delivered，version:1）——可審計、可重放。
2. **provisioning→active/failed 三態 + childId 預留 +「child 先持久、Lead 後 active」checkpoint 順序**——crash 語意最乾淨。
3. **mailbox 的 target-端去重模式**（delivered 只在 target 已持有 message identity 後寫；recovery = queued−delivered）——process-local retry 下真正防重複。
4. **任務板 CAS revision + 完整 DAG 驗證 + tombstone**——若保留任務板，這是最划算且可測試的核心。
5. **per-Lead transact promise 鏈（read-check-append 串行化）**——同進程排他骨架，其餘（waiter 通知、invariant、lifecycle、advisory scopes）都可簡化或後補。

若要省：可以先丟「同進程 provisioning conflict 的雙向 race 處理」（i-harness 是 snapshot 恢復、單進程 CLI，取其中一半即可）、"noProgress" 模型快路徑、整份 zod ContentBlock 嚴格 schema（i-harness message 是純 text）、以及依賴 `internal/dispatch` 的 invariant companion（改用 append 掛鉤校驗）。
