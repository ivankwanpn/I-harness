# M19 Subagent Teams — 研究綜合與採用/改良/丟棄矩陣

日期：2026-08-26。彙整三份研究：
- `research/2026-08-26-dsh-agent-team-domain.md`（dsh domain 參考）
- `research/2026-08-26-codex-multi-agents-v2.md`（codex-rust v2 參考）
- `research/2026-08-26-i-harness-subagent-reuse.md`（i-harness 重用面）

使用前提：i-harness 已有 dsh-style 的 continuable subagent 模型（spawn/wait/list/send/followup/interrupt/close/resume + durable `subagent/inbox` + jobs + cold resume），**比 codex 更持久**（mail 落 session log）。因此 M19 的定位不是「重寫」，而是「在現有 subagent 之上加 Team 域」。

---

## 採用矩陣（逐項：來源 | 決策 | 理由）

| # | 能力 | 來源 | 決策 | 理由與權衡 |
|---|---|---|---|---|
| 1 | **具名持久 roster**（Lead 隱式 = root；teammate = durable named child；kebab 名稱、永不重用；provisioning/active/failed） | dsh | ✅ 採用 | 這是「Team」的本體；i-harness 現有 path 名無唯一性保護（table.add 靜默覆蓋）。改良：名稱規則直接取 dsh regex（`^[a-z0-9]+(-[a-z0-9]+)*$`、≤64），但改放**自己的 namespace** 不與既有 path 相撞（新 package 自己的 roster 表）。 |
| 2 | **transact 串行化（read-check-append）** | dsh | ✅ 採用 | per-Lead promise 鏈是防同進程 race 的骨架；i-harness 無等價物。改良：不 copy 整份 journal，做緊急場景的 `transact(fn)` helper（module-level 或 per-lead）。 |
| 3 | **Lead-log events 作為 team 狀態真源**（team/member、team/task、team/message/queued、team/message/delivered） | dsh | ◑ 選用（改良） | 完全 copy 需要改 6 個套件（KNOWN_EVENT_TYPES、core-session union、repair、recovery）——搬 dsh 的 *值得保留的*「完整快照事件 + fold 純函數 replay」，但是 **增量 fold 快取**（改進 dsh 的 O(n) 全量重放），且**只用 required 的新 event types**（避免碰 repair/missingClosers）。**備選**：M6 snapshot document（`<sessionId>.team`）承擔 team 投影、events 只記「有意義的變更邊」。設計階段決定（見問題）。 |
| 4 | **mailbox：queued（先 flush）→ dispatch → delivered ack（target 已持有 message id 後才寫）** | dsh | ✅ 採用（改良） | 這是防重複投遞的最乾淨模式；i-harness 已有 `subagent/inbox` 耐久但無 delivered/ack。改良：i-harness 的 target sessions 都有 append hook，把「delivered ack」做在**target session 事件觀察**（session log 看到帶 team-message source 的 user/message → append delivered）——與 dsh 的 async ack 觀察者一致；**不重寫** dsh 的 checkpointDelivered/persistedTargetRecorded 全套（i-harness 有 coordinator.load 可做到等價 inspect）。 |
| 5 | **quiet vs wakeup delivery（send_message 不喚醒、followup_task 喚醒 + cold-resume）** | dsh + codex | ✅ 採用（既有語意擴充） | i-harness M9 已同構（send=queue / followup=queue+wake / resume）。改良：在 team 層面**保留 per-target FIFO 串行**（現有 driveFollowups 已做 per-child 串行），並補 **noProgress 短路**（dsh 的設計）到 team wait。 |
| 6 | **task board：CAS revision（expectedRevision）+ DAG blockers + readiness + tombstone + write scopes（advisory）** | dsh | ✅ 採用 | 這是「共享任務狀態」的本體；i-harness 完全沒有。改良：task id 改用 **UUID（`task-<uuid>`）** + 獨立排序欄（revision 仍做 CAS）——**丟棄 dsh 的 `task-<n>` 計數器**（避免 MAX_SAFE_INTEGER 邊界 + id 空間耗盡的隱晦語意；研究建議 UUID 更簡單）。CAS 用 memory revision 比較（同進程串行）——**不做**跨進程 CAS（dsh 也承認單進程）。 |
| 7 | **waitForChange：edge-triggered（post-registration）+ timeout 只回 timedOut + disposal 釋放 waiter** | dsh（改良） | ✅ 採用 | 研究共識：i-harness 的 20ms poll 盲等是最大摩擦。改良：**noProgress 下沉到 domain**（dsh 放在 tool——研究標為「可改良」），且不做 28 個錯誤碼的表（我們用清晰 Error message + 少量 code）。 |
| 8 | **invariant replay（pre-commit 驗證成員轉移/名字重用/任務 revision 連續/queue-ack 關係）** | dsh | ◑ 選用（改良為 append-hook 驗證） | i-harness 無 Cordis `internal/dispatch`——用 **core-session 的 appendHook** 做「append 前 fold 驗證」（研究建議的替代點）。強度：append-prefix 有效；比 dsh 的 pre-commit 稍弱但可行。**
| 9 | **AgentPath 定址類型**（resolve/name/is_root/join + 嚴格校驗 + 唯一性錯誤） | codex | ✅ 採用 | 修 i-harness path 解析缺口（相對/前導 slash/`..`/同名消歧）；codex 有現成 6 個測試模式。改良：適當放寬（i-harness path 目前沒有前導 slash；決定：team 內用 `lead/<name>` 或維持 `root/<taskName>`——設計階段決定）。 |
| 10 | **fork_turns 內容過濾規則**（只留 user/system/developer + assistant-final，丟工具/推理/AgentMessage；N 以 turn 為切割） | codex | ✅ 採用 | i-harness M3 已有 forkTurns（none/all/N）但無「copy 後過濾」——codex 的守則是精準內容策略。改良：在同一個 fold 中套用（i-harness fork.ts 只切 turn，未過濾 assistant/tool 內容）。 |
| 11 | **完成通知 = mailbox 回投**（child 每 turn 完成自動 FINAL_ANSWER 給 parent；interrupted 不發） | codex | ✅ 採用 | 讓 team wait/list 有真 edge 可等（不必輪詢 job）。改良：i-harness 已有 followupChain 回寫 job——把「完成 edge」接到 team activity 上即可。 |
| 12 | **Activity events（Started/Interacted/Interrupted）** | codex | ◑ 選用（若做 client 事件流才用） | codex 紀律：client-visible ≠ model-visible。i-harness 目前無此事件；M19 若維持「無 UI 核心」可**延後**到 client/UI 里程碑。 |
| 13 | **LRU residency 併發上限** | codex | ◑ 選用（評估後） | 好處（資源有界、省 close 心）但 i-harness 已有 close_agent 工具 + jobs 可 re-open；M19 若採 task board + 上限 maxMembers=8 已實際有界。**建議：M19 不搬（YAGNI），留 maxMembers 上限即可**；LRU 是 codex 因為沒有 close 工具才需要。 |
| 14 | **disposalTimeoutMs 限界清除** | dsh | ◑ 選用（簡化） | i-harness 已有 unmount handle 模式（M17/M18）。**只做最小版**：unmount 時 dispose instance + settle（abort children + 釋放 waiter）——不做 dsh 的完整 settle(creations/dispatches)/drain descendants 全套（研究建議那些可以簡化）。 |

---

## 改良/丟棄清單（我們 vs 參考的差異決策）

| 差異點 | 參考做法 | M19 我們的做法 | 理由 |
|---|---|---|---|
| **fold 重放** | dsh 每次讀全量重放（O(n log) 無快取） | **增量 fold 快取**（seq watermark；新 suffix 才重放） | 研究評價 dsh 這一項「反直覺/過重」；快取讓長 session 讀取 O(1) 攤銷。 |
| **task id** | `task-<n>` safe-integer 計數器 + MAX_SAFE_INTEGER 隱晦語意 | **UUID `task-<uuid>`** + revision CAS 仍做 | 研究評價計數器「為 id 穩定付出代價」；UUID 簡化且無耗盡。 |
| **wait noProgress** | dsh 放 tool 層 + 28 錯誤碼 | **放 domain 層**（`noProgress: no-active-peer` 統一回報）+ 少量錯誤碼 | 研究標 tool-layer noProgress 為「可改良」；統一在 domain 避免兩處語意。 |
| **invariant** | dsh 靠 Cordis `internal/dispatch`（pre-commit）+ zod 嚴格 schema | **core-session appendHook 驗證** + zod 結構 schema | i-harness 無 internal/dispatch；appendHook 是等價替代點（研究建議）。 |
| **mailbox byte 上限含框架** | dsh 含 `Team message <id> from <name>:` 整個傳遞框架 | 含框架但**簡化**（i-harness 無 ContentBlock[]；純 text） | dsh 的 ContentBlock schema 對 i-harness 是沉重的（message 純字串）；信封用純 `messageId/senderName/content`。 |
| **mailbox TTL** | dsh 對 inactive 可無限期 pending（無 TTL） | 設 **pending 上限 + 過期回收規則**（簡單版：target 永不 materialize → 保留警告但不無限制成長） | 研究評價「mailbox 無 TTL」為反直覺；但 M19 先做上限即可（過期規則留後續）。 |
| **authority** | dsh 強大的 `ctx.agentTeams` service 依賴 dsh-agent 全套（status/inject/cancel/whenIdle） | i-harness **只依賴現有**：entry.status 已列 run/waiting；用 followup（turn）不用 inject（step） | 研究標「Agent.status / inject / cancel 全套」是搬 dsh 的重大缺口；i-harness 走「現有語意小步」即可，**不做 inject next-step**（那是大工程，非必要）。 |

---

## 嫁接策略（三選一，研究推薦 (a)+(c) 子集）

- **(a) 新 package `@i-harness/agent-team` 掛在 subagent 之上**（推薦 main）
- **(c) 子集：增量寫 Lead session log 的 team/* events**（member/task/queued/delivered；經 parentSession append + 既有 write-behind；session-persistence 加 `registerEventType` + core-session union 加型別）
- (b) 擴充 subagent package = 污染 11 工具契約 + snapshot format；**(不取)**
- (c) 全事件化重寫 = 2-3 倍工作量、動 6 個套件核心；**(只取其中的 lead-log mailbox 子集)**

**最終建議**：**M19 = `@i-harness/agent-team` 新 package**：
- 重用 subagent 的 spawnChild/driveFollowups/jobs/roles/agents registry/child mirror（導出必要內部或複製最小面）
- 新 package 內做 TeamRoster（具名 + provisioning 三態 + 名字永不重用）、TeamMailbox（durable queued→delivered + per-target FIFO + recovery）、TaskBoard（CAS + DAG + tombstone + writeScopes advisory）、TeamActivity（edge wait + noProgress）
- 只改 core-session（union 加 team/* 型別）+ session-persistence（registerEventType 或最小 Set 加字串）——**不動** subagent 既有 11 工具契約、不動 M6 snapshot format
- 狀態真源：**Lead session log events**（可審計）＋ **增量 fold 快取**（效能）＋ 必要時獨立 document key（`<sessionId>.team`）承載投影（研究建議的混合）
