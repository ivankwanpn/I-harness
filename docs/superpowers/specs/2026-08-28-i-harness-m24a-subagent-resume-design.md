# I-harness M24a 設計：Subagent/Team 恢復一致性與補全

> 2026-08-28。依 M20-M25 設計檔 §7.1③④ + M24 研究（4 組件，本設計對應 M24a = resume 一致性 + subagent 補全；M24b = skills + workflows 另起）。
> 決策產出於 2026-08-28 brainstorming 對話；依「吸收而非移植」原則。研究輸入：`2026-08-28-m24-resume-consistency-ai-research.md`、`2026-08-28-m24-subagent-ai-research.md`。

## 1. 目標與範圍

### 1.1 目標
- 補 M23 的 `ensureResidentAgent` 未覆蓋的四個 resume 一致性契約缺口（G1-G4），讓「恢復後 wakeup 不再 no-op」的完整語意成立——**wakeup 跑在對的 session/job/status 上**。
- 補 subagent 缺失的**巢狀委派**（子代理再生子代理，三家參考一致支援；I-harness 機制已備、只差開關與深度 guard）。

### 1.2 範圍（components）
- **組件 A：統一 restoreSubagentState**（G1 假空 session / G2 job id 契約 / G3 status 保真 / G4 pending-inbox sweep）。
- **組件 B：nested delegation enablement**（delegationDepth 遞推 + `max_depth` config + role.tools 開關）+ `wait_agent`/`list_agents` 擴充（純加法）。
- **組件 C：main session header 恢復**（G7，一行）。

### 1.3 明確不做（deferred——記錄）
- settlement push（dsh/opencode 的 push 模型——需 session event 基建，M24+）。
- 併發上限 config（subagent_max_concurrency——研究標「順手做」，M24 deferred / M24b）。
- durable jobs backend（jobs=in-process 契約，只修 id 連結正確性）。
- 新 session event type、session-persistence format 變更、agent-team 域 resume 邏輯變更（fold/recoverRoot 已正確）。
- 跨行程 mailbox、Activation 抽象、子代理中途轉錄（YAGNI）。

## 2. 研究關鍵發現（輸入）

### 2.1 resume 一致性（`2026-08-28-m24-resume-consistency-ai-research.md`）
- **G1（最重）**：`persist.ts:93,118-121` 的 `createSessionFromEmpty()` 回 `{formatVersion:1, events:[]}` **無 append hook**。連鎖：① `send_message`/`followup_task`/team `realDeliver` append `subagent/inbox` → 進影子 session、永不 enqueue → `realDeliver` 仍 flush+回 true → mailbox ack 說已送達、訊息實丟——**違反 M19 Ruling 22 fail-closed ack 契約**。② `driveFollowups` 的 pending filter 讀不到 durable inbox → stranded。③ `ensureResidentAgent` 綁空歷史 → resume 後 turn 不落盤、log 分叉。
- **G2**：jobs id 恢復靠「註冊順序巧合」（`persist.ts:104-114`，`registerJob` per-kind counter 重啟，註釋自承 drift + jobId 連結 advisory；`jobs.ts:29` updateJob 對未知 id 靜默 no-op）。
- **G3**：`persist.ts:88-96` `wasRunning = "running" || "waiting"` → 兩者都 `error`；**waiting（活著閒置=正常穩態）被當中斷** → list_agents 滿屏假錯誤、wait_agent 判定全 settled、team `realMemberStatus` error→inactive → quiet 訊息被 recoverRoot 永久 skip。
- **G4**：team mailbox mount 重播（recoverRoot at-least-once）；subagent pending inbox **無** mount 補償——兩面消費語意不一致。
- **G7**：main session resume 不恢復 `session.header`（run.ts:174-190）——潛伏雷，一行修。
- 三源共性（正解形狀）：身分/目錄/消費游標持久、runtime 永遠 lazy、恢復輸入=child 自身 durable log、未消費佇列損失語意明文。

### 2.2 subagent 補全（`2026-08-28-m24-subagent-ai-research.md`）
- 三家（codex v2 / opencode / dsh）**都支援子代理再生子代理**（深度+1 會計 + 上限 + 併發上限）。
- I-harness 機制已備（child 工具面 = role.tools 自 parent registry 解析）——只差：builtin roles 無 spawn_agent、`child.ts:55,65` delegationDepth 寫死 1、無 max_depth guard。
- **`agent_prompt`/`subagent_get`/`await` 三候選全該丟棄**（重複：spawn_agent 同語意、job_output/list_agents 已覆蓋、wait_agent 已是 await）。

## 3. 設計

### 3.1 組件 A：統一 restoreSubagentState

#### A1 — restoreState 內建鏡像重建（G1a，消除假空 session）
- `restoreState(state, snapshot, persistence?)` 簽名加第三參數 `persistence?: { coordinator: SessionCoordinator; parentSessionId: string }`（即 `SubagentPersistence` 或子集）。
- 對每個 `entry.sessionId` 存在的條目：`await persistence.coordinator.load(entry.sessionId)` → 用 `createSession` + hook（`(ev) => { coordinator.enqueue(entry.sessionId, [ev]); if (ev.type === "turn/end") void coordinator.flush(entry.sessionId).catch(() => {}) }`）建 mirror → `events.push(...loaded.session.events)` + `formatVersion` + `header` → `entry.session = mirror`。
- **load 失敗**（缺/損 child log）：保留 stub（現狀）+ status → `error` + error `"child log unavailable after resume"`（fail-visible，非 silent）。
- 無 coordinator（`persistence` 未傳）→ 行為同現狀（stub）。
- **registerSubagent 接線**：restore 呼叫（`index.ts:80-84`）改傳 `opts.persist`（若有）；時序維持 restore-before-wrap 不變（coordinator 是外部傳入、不依賴 wrap）。

#### A2 — job id 契約化（G2）
- `DurableJobRecord.id` 為權威 id；restore 時 `registerJob(owner, kind, label, { id: rec.id })` 直接復用 persisted id。
- `registerJob` 加可選 `id` 參數（或 `restoreJob` 方法）；id 重複 → fail-loud。
- `updateJob` 對未知 id 回 `false`（caller 可觀察）而非 throw；`driveFollowups` 對回 false 記錄 warning（fail-visible log）但不中斷 turn。
- snapshot `formatVersion` 維持 1（id 欄位本已存在——行為修正非格式變更）。

#### A3 — status 保真（G3）
- `wasRunning = status === "running"`（去掉 waiting）；`waiting → waiting`；僅 `running → error` + "interrupted by resume"。
- 恢復後的 waiting 條目 = 活著、可被 wakeup。

#### A4 — pending-inbox sweep（G4，裁定 A：mount 自動）
- 掛點：`registerSubagent` 在 restore 完成後（且 persistence wired）、`mountAgentTeams` 之前；只在「restoredState 存在」時跑。
- 語意：對 `status === "waiting"` 且存在 `seq > lastInboxSeq` 的 durable inbox 事件的條目 → `ensureResidentAgent(deps, entry)`（若無 resident）+ 呼叫一次 `driveFollowups(deps, entry, sessionId)`。
- guard：只掃 waiting（running→error 中斷需顯式 resume_agent——sweep 不處理）；無 sessionId 跳過；`driveFollowups` 失敗記錄 warning（fail-visible）、不中斷 restore。
- 副作用防重複：`lastInboxSeq` 游標 + followupChain 序列化（同一訊息不會跑兩次）。
- 與 team recoverRoot **各管各的（不重複）**：sweep 管 subagent 域、recoverRoot 管 team mailbox。
- **可測試性**：抽出 `sweepPendingInbox(deps, table)` 純函數（或等價可注入點）供測試。

### 3.2 組件 B：nested delegation enablement

#### B1 — delegationDepth 遞推
- `child.ts:55,65`（coordinator.create meta + header）`delegationDepth: 1` → `parentDepth + 1`（`opts.parentSession.header?.delegationDepth ?? 0` 為基底）。
- 單調規則（dsh）：取 `max(runtime, header)`——resume 後不重算為頂層。

#### B2 — `max_depth` host config（預設 1=現狀）
- `SubagentToolDeps`（或 `createSubagentTools` 參數）加 `maxDepth?: number`（預設 1）。
- `spawn_agent` execute（L54-64 呼叫 spawnChild 前）：呼叫者深度（`deps.parentSession.header?.delegationDepth ?? 0`）≥ maxDepth → 拒絕（fail-loud 錯誤「子代理已達最大嵌套深度」）。

#### B3 — role.tools 允許含 spawn_agent（開啟巢狀）
- builtin roles 維持不含（預設安全=opencode 預設 depth 1）；客製 role 可含 `spawn_agent`（+ job 系）。
- 文件/工具描述明示：要巢狀，需 custom role + maxDepth 調升。

#### B4 — wait_agent 擴充（純加法）
- 加 `target?: string`（child path）——等特定 child settle（現只能等全部）；回該 child 的 `{path, status, finalText?, error?}` 摘要。
- `timeout_ms` clamp `[100, 300000]`（預設 30000）——防 0ms 忙輪詢（codex L1090 經驗）。
- 無 target 時現狀（全部 settled）。

#### B5 — list_agents 擴充（純加法）
- 每列加 `{roleName, jobId, sessionId?, finalText?, error?}`。
- 加 `scope?: "children" | "descendants"`（descendants = path prefix 掃描；I-harness path `root/a/b` 階層）。
- `path_prefix` 保留（向後相容）。

### 3.3 組件 C：main session header 恢復（G7）
- run.ts main resume（L174-190）補 `session.header = restored.header`（鏡像迴圈刪除後只剩這行）。

### 3.4 host 薄殼化
- run.ts L246-262 鏡像迴圈**刪除**（收進 restoreState）；main header 恢復保留（G7）。

## 4. 整合時序（registerSubagent 內）

1. `restoreState(state, snapshot, opts.persist)` — roles/table/jobs + A1 鏡像重建 + A2 job id + A3 waiting 保真。
2. `if (opts.persist) wireSubagentPersistence`（既有）。
3. 建 subagentDeps + agents registry + ensureResident（M23）+ maxDepth 傳遞。
4. A4 sweep（restoredState 存在才跑；mountAgentTeams 前）。
5. run.ts 薄殼：刪鏡像迴圈 + main header（G7）。

## 5. 測試策略

### A. resume consistency（`packages/subagent/test/resume.test.ts` 或併入 persist.test.ts）
1. **G1a 鏡像重建**（套件級核心回歸）：restoreState 帶 `persistence.coordinator` → 恢復的 `entry.session` 有 append hook（enqueue 被呼叫——假 coordinator/spy）+ events 含 child log。
2. **G1a mail 不丟**（team 面完整性）：恢復 → append 到 entry.session → coordinator enqueue 被呼叫（durable）——套件級（非 CLI）。
3. **G2 job id 契約**：snapshot 內 `DurableJobRecord.id`（如 `subagent-5`）→ restore 後 `jobs.get("subagent-5")` 存在（非新產生的 id）。
4. **G3 waiting 保真**：`waiting` 條目 → restore 後 status 是 `waiting`（非 error）；`running` → error。
5. **G4 sweep**：`waiting` + `seq > lastInboxSeq` 的條目 → `driveFollowups` 被呼叫（spy on sweepPendingInbox / 注入點）。
6. **G7 main header**：cli.test.ts resume 後 `session.header` 存在。

### B. nested delegation（`packages/subagent/test/child.test.ts` / `tools.test.ts`）
7. delegationDepth：parent depth 0 → child 1；parent depth 1 → child 2。
8. max_depth：deps.maxDepth 未設（預設 1）→ depth 1 parent spawn → 拒絕；maxDepth 2 → 允許。
9. wait_agent target：等特定 child 完成回摘要。
10. list_agents：欄位 + descendants scope。

### C. 既有測試不破
- persist.test.ts restoreState round-trip（L72 waiting 條目——斷言 roleName 非 status；**implementer 需驗證** A3 waiting→waiting 改動不破既有（若破→調整斷言至新語意但保測試意圖）。
- cli.test.ts resume e2e（L433/L530）——鏡像迴圈刪除後 behavior 同（host 薄殼）。

## 6. 風險與取捨

- **A1 套件化是最可能的 regress 點**（現 run.ts 鏡像迴圈只跑在有 coordinator 時；套件化後 restoreState 跑——無 coordinator → stub（同現狀）；有 → 同 run.ts 現行）。差異：restore 在 wire 前跑——coordinator 外部傳入、無依賴。
- **A2 job id 契約化**：舊 snapshot（無 id 或 id 漂移）→ 僅「碰巧一致」——v1 snapshot 已有 id 欄位（formatVersion 1 內含），在此版內做無格式升級。
- **B2 max_depth 預設 1** = 維持「子代理不能再子代理」（現狀）——零行為破壞；調升 + custom role 才開啟，低風險。
- **A4 sweep 時序**（restore → sweep 在 registerSubagent 內，mount 前）→ team recoverRoot 在後；sweep 後 resident agent 可供 realDeliver（各管各域）。

## 7. 歸屬（Attribution）

- 「身分持久 + runtime lazy」分工：codex `restore_v2_agent_metadata`/`ensure_v2_agent_loaded`（Apache-2.0）——概念採用（M23 已落地 ensureResidentAgent；M24a 完成身分/連結面）。
- 「恢復輸入 = child 自身 durable log + descriptor/游標」：dsh `coldResume`/`foldSubagentDescriptor`（MIT）——概念採用於統一 restoreSubagentState。
- 「未消費佇列損失語意明文化」：codex InputQueue + dsh README——作為 G4 裁定（A：mount 自動 sweep）的兩面先例；I-harness 因 `lastInboxSeq` 游標 + followupChain 序列化已防重複，自動 sweep 與 M19 recoverRoot 對齊。
- 無逐行移植——全部為機制對照後的 I-harness 原生實作建議；THIRD_PARTY_NOTICES 於 M24a 完成時補（codex-multi-agents + dsh-subagent 段落新增，若採代碼片段）。

## 8. 交付檔清單

- `packages/subagent/src/persist.ts`（A1/A2/A3、restoreState 簽名）
- `packages/subagent/src/index.ts`（registerSubagent 接線：restore 傳 persistence + A4 sweep 掛點 + maxDepth 傳遞）
- `packages/subagent/src/child.ts`（B1 delegationDepth 遞推）
- `packages/subagent/src/tools.ts`（B2 max_depth guard + B4 wait_agent target/clamp + B5 list_agents 欄位/scope）
- `packages/subagent/src/jobs.ts`（A2 registerJob id 參數 + updateJob 回 false）
- `apps/cli/src/run.ts`（鏡像迴圈刪除 + main header 恢復）
- 測試：`packages/subagent/test/{resume-consistency,child,tools,persist}.test.ts`、`apps/cli/test/cli.test.ts`

## 9. 研究文件索引

- `packages/subagent/src/persist.ts:88-96`（G3 wasRunning）、`:93,118-121`（G1 createSessionFromEmpty）、`:104-114`（G2 jobs drift）
- `packages/subagent/src/child.ts:53-65`（B1 delegationDepth 寫死）
- `packages/subagent/src/tools.ts:73-103`（B4 wait_agent / B5 list_agents）、`:54-64,233-296`（max_depth guard / ensureResidentAgent）
- `apps/cli/src/run.ts:174-190`（G7 main header）、`:246-262`（鏡像迴圈——A1 收進套件）
- `packages/agent-team/src/scheduler.ts:263-270`（realMemberStatus waiting→idle——G3 修後 quiet 不再 skip）、`:316-323`（recoverRoot——G4 對齊對象）
