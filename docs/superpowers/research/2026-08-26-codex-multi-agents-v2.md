# Codex Rust v0.149.1 — MultiAgentV2 多代理協作實作研究報告

日期：2026-08-26 ｜ 範圍：`D:\agent-complete\codex-rust-v0.149.1\codex-rs`（core / protocol / features / tools / agent-graph-store / context-fragments）＋ dsh rc.8 `packages/experimental/*agent-team*`（對照）＋ i-harness M3/M6/M8/M9 spec（對照）。全部唯讀。
（內容由並行研究子代理產出，協調代理落盤）

## 0. 結論速覽

- MultiAgentV2 是**「純對話式 + 淺結構化」**模型：agent = 一個 thread（ThreadId + AgentPath + nickname/role），mail = 一個**每個 thread 自己的 in-memory mailbox deque**（`InputQueue.mailbox_pending_mails`），狀態 = 由事件流**導出**（`agent_status_from_event`），跨 agent 的唯一結構化持久資料是 **SQLite spawn-edge graph（open/closed）**與各 thread 自己的 rollout 歷史。
- 沒有 roster 快照、沒有 durable queued/delivered ack、沒有 task board、沒有 CAS、沒有 invariant replay、沒有 provisioning reconciliation——這些全是 dsh agent-team 的。codex 的協調是「**重 concurrency 控制 + 輕結構化**」：靠 `max_concurrent_threads_per_session=4` 的 LRU residency 換入換出、路徑式定址、mail 信封格式。
- `multi_agents_spec.rs` 是 **code（tool schema builder + 大量常數與提示詞文字）**，不是設計文檔；設計決策藏在函式與測試斷言裡。
- **codex v2 沒有 noProgress 概念**；noProgress / "no-active-peer" 捷徑是 dsh tool-agent-team 的設計。codex v2 wait 只有 `MailboxActivity / Steered / TimedOut` 三種 outcome。
- v2 工具面 = 6 個（spawn_agent / send_message / followup_task / wait_agent / interrupt_agent / list_agents），**沒有 close_agent / resume_agent**（那是 v1 的；v2 用 residency LRU evict + `ensure_v2_agent_loaded` 隱式換回）。

---

## 1. 工具面（V2 "collaboration" namespace）

namespace = `collaboration`（config `multi_agent_v2.tool_namespace`，預設 `DEFAULT_MULTI_AGENT_V2_TOOL_NAMESPACE = "collaboration"`，`core/src/config/mod.rs:225`）。v2 handler 藉 `MultiAgentV2NamespaceOverride` 包成 `ToolSpec::Namespace`（`core/src/tools/spec_plan.rs:1185-1340, 1300-1340`）。v1 則是 `multi_agent_v1` namespace（`multi_agents_spec.rs:19`）。

### 1.1 spawn_agent（`multi_agents_v2/spawn.rs` + `multi_agents_spec.rs create_spawn_agent_tool_v2` L125-146）

參數（property 名 + required）：

| 參數 | 型別 | required | 說明 |
|---|---|---|---|
| `task_name` | string | ✅ | `msg` 說明 "Use lowercase letters, digits, and underscores"；join 到 parent path（見 §2） |
| `message` | string | ✅ | `with_encrypted()`（spec.rs:195-199） |
| `agent_type` | string | – | role override；未設→繼承（full-history fork 時仍可 override，與 v1 不同） |
| `fork_turns` | string | – | `"none"` / `"all"`（預設）/ 正整數字串如 `"3"`（spec.rs:213-219；spawn.rs:291-318） |
| `model` / `reasoning_effort` / `service_tier` | string | – | 依 `expose_spawn_agent_model_overrides` / `hide_spawn_agent_metadata` 增刪（spec.rs:137-145） |

回傳（`spawn_agent_output_schema_v2`，spec.rs:379-399）：`{ task_name: string, nickname?: string | null }`；若 `hide_spawn_agent_metadata`（預設 true，config/mod.rs:1249）則只剩 `{ task_name }`（spawn.rs:227-232 `SpawnAgentResult::HiddenMetadata`）。

語意：**非同步 spawn**。`spawn_agent_with_communication`（control/spawn.rs:246-260）建立 thread + 以 `InterAgentCommunication(trigger_turn=true)` 作為 initial input（NEW_TASK）交付，立即回傳（不回傳 thread id，只回 task_name）。tool description 明說 "It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes"（spec.rs:749-780）。**「does not block」是設計核心**：parent 繼續做別的事，child 完成時用 mailbox 通知 parent（見 §4）。

### 1.2 send_message（`multi_agents_v2/send_message.rs` + `message_tool.rs`）

參數：`target: string`（"Relative or canonical task name to message (from spawn_agent)"）、`message: string`（encrypted）。回傳 schema：**None**（spec.rs `send_message_tool_requires_message_and_has_no_output_schema` 測試）。語意：`MessageDeliveryMode::QueueOnly` → `trigger_turn=false`（message_tool.rs:24-31, 63-68, 109-112）。**queue-only、不喚醒 idle agent**；若 agent 正在跑，mail 會在「message boundary 或目前 tool call 完成後」注入（delivery phase 機制，見 §3）。可對 root 發送（child → root 送結果）。空 message 被拒（message_tool.rs:52-58）。

### 1.3 followup_task（`multi_agents_v2/followup_task.rs`）

參數同 send_message（target/message encrypted），`MessageDeliveryMode::TriggerTurn` → `trigger_turn=true`、`AgentCommunicationKind::Followup`。**禁止 target root**（message_tool.rs:77-84："Follow-up tasks can't target the root agent"）。tool description（spec.rs:222-233）：「trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes.」

→ **i-harness 對照**：i-harness 的 send_message=queue / followup_task=queue+wake 與 codex v2 完全同構（M9 spec 已採此設計；codex 證實了方向正確）。

### 1.4 wait_agent v2（`multi_agents_v2/wait.rs`）

參數：**只有 `timeout_ms`（optional）**——與 v1 `targets[]` 完全不同（compare `create_wait_agent_tool_v1/v2`，spec.rs:247-280）。回傳：`{ message: string, timed_out: bool }`（wait.rs:121-135）。三種 message（wait.rs:139-143）：
- `"Wait completed."`（MailboxActivity）
- `"Wait interrupted by new input."`（Steered）
- `"Wait timed out."`（TimedOut）
- 若 `requested_timeout_ms < 實際使用值`（被 clamp 到 min），附加 "\n\nRequested timeout of Xms was clamped to the minimum of Yms."（wait.rs:144-154）

**不回傳任何 agent 內容**，spec 明述 "Does not return the content"（spec.rs:272-280）；`to_response_item(..., success=None)`（wait.rs:158-162）→ 對模型是中性成功。超時範圍（multi_agents_common.rs:29-31 + config/mod.rs:221-227）：min 10,000ms / default 30,000ms / max 3,600,000ms（configurable `multi_agent_v2.{min,max,default}_wait_timeout_ms`；hard max 同 1h）。**timeout 參數超出 hard max → 直接 error**；低於 min → clamp 而非 error（wait.rs:48-63；測試 `multi_agent_v2_wait_agent_clamps_timeout_below_configured_min`）。

### 1.5 interrupt_agent（`multi_agents_v2/interrupt_agent.rs`）

參數 `target: string`；回傳 `{ previous_status: AgentStatus }`。**root 與 self-target 都拒絕**（interrupt.rs:59-70；"an agent cannot interrupt itself; return your result and let the parent interrupt you if needed"）。對已關閉 agent 視為成功（ThreadNotFound/InternalAgentDied → Ok，interrupt.rs:78-89）。v1 版本用 interrupt 前必先 `resolve_agent_target`；v2 同。

### 1.6 list_agents（`multi_agents_v2/list_agents.rs`）

參數 `path_prefix?: string`（"Task-path prefix filter without a trailing slash"）。回傳 `{ agents: [{ agent_name, agent_status }] }`；`agent_status` 是 oneOf：字串 enum `["pending_init","running","interrupted","shutdown","not_found"]` | `{completed: string|null}` | `{errored: string}`（spec.rs:455-479）。按 path 排序、含 root 行（`/root`）；prefix 比對＝精確或 `path + "/"` 前綴（control.rs:814-818）。**只列 live（registry 內）agents**；已 unload 但 edge 仍 open 的 agent 不在 list 中（測試 `multi_agent_v2_list_agents_omits_closed_agents`、`..._keeps_interrupted_resident_agents`）。descendants 只在 spawn 時入 registry，list 不展開 tree —— 每個 agent 各看各的。

### 1.7 V1 工具面（對照，`multi_agents.rs` + spec）

namespace `multi_agent_v1`：`spawn_agent`（message/items/agent_type/fork_context: bool 全歷史 fork/model/reasoning_effort/service_tier，spec.rs:26-86）、`send_input`（interrupt: bool + items，spec.rs:88-120）、`wait_agent`（targets[]，v1 wait.rs 對每個 target subscribe_status 等到 final）、`close_agent`、`resume_agent`。V1 沒有 send_message/followup_task/interrupt/list_agents。V1 有 `agent_max_depth`（預設 1）限制（multi_agents/spawn.rs:69-75）；**V2 忽略 depth 限制**（測試 `multi_agent_v2_spawn_agent_ignores_configured_max_depth`，tests:2472-2519）。

**差異標註**：V2 移除 close/resume——把「收斂」改成「residency 隱式 unload + 需要時 reload」；tool 面更小、模型要記的語意更少（「更簡單/更實用」值得抄）。V1 wait 是 per-target status poll；V2 wait 是「任何 mailbox 邊」的 edge wait（更簡單但更模糊——模型不知道是誰動了，要先 list_agents）。

---

## 2. Agent 生命週期與身份

### 2.1 AgentPath（`protocol/src/agent_path.rs`）

`AgentPath(String)`，絕對路徑必須 `/root/...`（或特殊 `/morpheus`）；segment 只允許 `[a-z0-9_]`；保留字 `root`/`.`/`..`（L30-91）。API：`root()`、`is_root()`、`name()`（末段）、`join(name)`、`resolve(ref)`——relative 會以當下 path 為基底拼出 child（L54-76）。

### 2.2 spawn 身份

`thread_spawn_source`（multi_agents_common.rs:87-105）：`task_name` → `parent_session_source.get_agent_path().unwrap_or_else(AgentPath::root).join(task_name)` → `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { parent_thread_id, depth, agent_path, agent_nickname: None, agent_role })`（protocol.rs:2657-2674）。**path 只在 spawn 時由 task_name 決定，唯一性靠 AgentRegistry.reserve_agent_path**（registry.rs:324-347，Occupied → "agent path `...` already exists"）。nickname 是裝飾性（隨機 AGENT_NAMES 池 + 重置計數 "X the 2nd"，registry.rs:250-322）；v2 預設 `hide_spawn_agent_metadata=true`，**模型只看 task_name，不看 nickname/thread_id**。

### 2.3 agent_target 解析（`agent_resolver.rs` + control.rs:384-396）

```
resolve_agent_target(session, turn, target):
  register_session_root(session.thread_id, turn.parent_thread_id)   // 根 thread 註冊進 registry
  if ThreadId::from_string(target).is_ok() → 直接用 thread id
  else → agent_control.resolve_agent_reference(session.thread_id, turn.session_source, target)
         = 當前 agent path（session_source.get_agent_path() ?? root）resolve(target)
          → registry.agent_id_for_path(path) → thread_id
          → 找不到：UnsupportedOperation("live agent path `X` not found")
```

→ **i-harness 缺口對照**：i-harness 的 subagent path 是 `root/helper`（無前導 slash），target 解析靠自己改 path；codex 的 `AgentPath::resolve`（relative 以 sender 身份為基底）＋「relative vs canonical 可互用」的規則很乾淨（spec 描述：`/root/task1` 下 spawn `task_3` → `/root/task1/task_3`，可寫 `task_3` 或完整 path；別處的同名 `task_3` 必須用完整 path）。

### 2.4 AgentStatus（protocol.rs:1740-1752 + agent/status.rs）

`PendingInit | Running | Interrupted | Completed(Option<String>) | Errored(String) | Shutdown | NotFound`——**完全由事件流導出**（status.rs:9-29：TurnStarted→Running；TurnComplete→Completed(last_agent_message)；TurnAborted(Interrupted|BudgetLimited)→Interrupted 否則 Errored；Error→Errored；ShutdownComplete→Shutdown）。`is_final = !(PendingInit|Running|Interrupted)`（status.rs:32-38）。每個 thread 有 `watch::Sender<AgentStatus>`（session/mod.rs:2167-2170 `deliver_event_raw` 內 send_replace），v1 wait 靠它 subscribe（v2 wait 不用）。

### 2.5 在 context 寄存器中的表示

- **AgentRegistry**（registry.rs，每 root session 一個，`AgentControl` 持有）：`agent_tree: HashMap<String /*path*/, AgentMetadata{agent_id, agent_path, agent_nickname, agent_role}>` + `thread_paths: HashMap<ThreadId, RegisteredAgent>` + nickname 池 + `total_count`（atomic，配合 `try_increment_spawned` 即 CAS 式限額，registry.rs:355-369）。
- **持久**：`agent-graph-store`（SQLite，`LocalAgentGraphStore`，types.rs:1-16 `ThreadSpawnEdgeStatus::{Open,Closed}`）存 `(parent, child, open/closed)` 邊；spawn 時 `persist_thread_spawn_edge_for_source`（control.rs:756-780），close_agent 標 Closed（control/legacy.rs:47-60）。process 重啟後 `restore_v2_agent_metadata`（control/spawn.rs:141-207，由 thread_manager.rs:1011 resume 時呼叫）從 stored thread metadata（agent_path/nickname/role）重建 registry + Open 邊 → **agent 身份/路徑是持久的**。
- **模型可見**：世界狀態的 `format_environment_context_subagents`（control.rs:415-435）把 open children 以 `- <name>: <nickname>` 行注入（world_state.rs:72, 133）；v2 的 usage hint 則把「team 規則」灌進 developer instructions（session/multi_agents.rs:14-73，含 "Message Type: NEW_TASK | MESSAGE | FINAL_ANSWER..."、"All agents share the same directory..."、concurrency slot 數）。

### 2.6 SubAgentActivityItem（活動事件）

`protocol/items.rs:325-330`：`{ id, kind: SubAgentActivityKind::{Started,Interacted,Interrupted}, agent_thread_id, agent_path }`。由 v2 handler 在 spawn/send_message/interrupt 成功後以 `emit_sub_agent_activity`（multi_agents_v2.rs:47-55）發出 `TurnItem::SubAgentActivity`（ItemStarted + ItemCompleted）。**純 client 可視（TUI/app-server），非模型可視**（turn.rs:1849 從模型相關 event 列表排除）。legacy 轉 `EventMsg::SubAgentActivity`（legacy_events.rs:405-418）。i-harness 沒有這個——值得搬（見 §9）。

---

## 3. InterAgentMessage：內容結構與注入路徑

### 3.1 內容結構（`protocol.rs:738-830`）

```rust
InterAgentCommunication {
  id: Option<ResponseItemId>, author: AgentPath, recipient: AgentPath,
  other_recipients: Vec<AgentPath>,           // 多播（目前 v2 未用）
  content: String,                             // 明文（DirectPlaintextMessage 來源）
  encrypted_content: Option<String>,           // 加密路徑（v2 預設）
  internal_chat_message_metadata_passthrough: Option<...>,
  trigger_turn: bool,
}
```

v2 產生路徑（multi_agents_v2.rs:59-85 `communication_from_tool_message`）：
- 來源 `ToolCallSource::DirectPlaintextMessage`（= tool schema `with_encrypted()` 且 model 傳回空的 `encrypted_function_args`，router.rs:44-52）→ 明文。content = `InterAgentMessage::new(type, recipient, author, message).render()`；
- 否則 encrypt：`InterAgentCommunication::new_encrypted(author, recipient, vec![], message, trigger_turn)`，content 為空。

`InterAgentMessage`（context/inter_agent_message.rs:21-49）：`{ message_type: Message|NewTask, task_name: AgentPath(recipient), sender: AgentPath, payload }`，body render 格式：
```
Message Type: MESSAGE | NEW_TASK
Task name: <recipient>
Sender: <author>
Payload:
<text>
```
`role()="assistant"`。child 完成通知另用 `InterAgentCompletionMessage`（context/inter_agent_completion_message.rs:37-44）：
```
Message Type: FINAL_ANSWER
Task name: <parent path>
Sender: <child path>
Payload:
<final message 或錯誤/關閉文案>
```
（錯誤訊息的 next-action 文案在 session_prefix.rs:7-14, 27-47，`ERROR_NEXT_ACTION`："This agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task."，內容截斷到 1,000 tokens。）

### 3.2 注入目標 agent context 的路徑

```
AgentControl.send_inter_agent_communication (control.rs:213-232)
  → state.send_op(agent_id, Op::InterAgentCommunication{communication})   // 每 thread 一條自己的 op queue
  → session/handlers.rs:82-107 inter_agent_communication:
        input_queue.enqueue_mailbox_communication(communication, parent_turn_id, root_turn_id)
          → mailbox_pending_mails: VecDeque<PendingMailboxCommunication>  // per-session in-memory queue
          → activity_tx.send_replace(InputQueueActivity::Mailbox)          // 喚醒任何 wait_agent
        if trigger_turn || has_outstanding_durable_sleep() → maybe_start_turn_for_pending_work_with_sub_id
          // 只對 trigger_turn 或 durable sleep 才自動開新 turn（tasks/mod.rs:463-486）
  → 下一輪 turn：run_hooks_and_record_inputs → record_pending_input (hook_runtime.rs:579-621)
        TurnInput::InterAgentCommunication → sess.record_inter_agent_communication (session/mod.rs:3257-3287)
          → communication.to_model_input_item() → ResponseItem::AgentMessage{role:"assistant", content: [InputText(prefix) 或 InputText+EncryptedContent]}
          → 進入 conversation history → 送給模型
```

**Per-target inbox 的真相**：不是「每 sender 一個 mailbox」，而是**每 thread 自己的 session input queue**（`mailbox_pending_mails` + watch activity channel）。send_message 到 target 只能進 target 的 queue；完成通知同樣只是「child → parent 的 mail」。delivery 時機由 `MailboxDeliveryPhase` 控制（input_queue.rs:193-247 `defer_mailbox_delivery_to_next_turn` / `accept_mailbox_delivery_for_current_turn`）：target 在跑 → 在 sampling 訊息邊界或 tool call 結束後注入（`get_pending_input` 會 split_off pending + drain mailbox，input_queue.rs:294-360）。

### 3.3 context 內只讀 invariant

mail 以 `ResponseItem::AgentMessage` **落進目標 thread 自己的 rollout 歷史**（RolloutItem::ResponseItem + `InterAgentCommunicationMetadata`，session/mod.rs:3278-3284），所以**已交付的 mail 是持久的**（resume/replay 都重現）；rollout_reconstruction.rs:336-346 也把 `RolloutItem::InterAgentCommunication` 重建成 agent message。但 **InputQueue 的 pending mail deque 本身不持久**——未交付 mail 在 process 重啟時遺失（見 §8）。

---

## 4. 並發 / 等待模型

### 4.1 wait_agent v2 怎麼等：edge wait，不是 poll

`wait.rs:62-72`：
```
turn_state = input_queue.turn_state_for_sub_id(session.active_turn, turn.sub_id)  // 只有「目前正在跑的同一個 turn」才算
(activity_rx, pending_activity) = input_queue.subscribe_activity(turn_state.as_deref())
// pending_activity：該 turn 已有 pending user input → Steer；mailbox 非空 → Mailbox；否則 None
```
`subscribe_activity`（input_queue.rs:98-118）回傳 `watch::Receiver<InputQueueActivity>` + 立即值。`wait_for_activity`（wait.rs:184-202）：
- pending 已存在 → **立即返回**（測試 `multi_agent_v2_wait_agent_returns_for_already_queued_mail`，3553 行）；
- 否則 `timeout_at(deadline, activity_rx.changed())`——單一 watch channel，任何 `enqueue_mailbox_communication`（send）或 `Steer`（extend_pending_input_and_accept_mailbox_delivery_for_turn_state，input_queue.rs:230-239）都會 `send_replace` 喚醒。

→ **跨 agent 廣播的真相**：不是事件廣播，是「**該 thread 自己的 InputQueue watch channel**」。child 完成 → child 把 FINAL_ANSWER mail 送進 **parent thread 的 queue** → 若 parent 正在跑 wait_agent，該 channel `changed()` 喚醒。（`multi_agent_v2_wait_agent_wakes_on_any_mailbox_notification` 測試，3639 行。）v1 才是真正的每-target `subscribe_status` watch + `FuturesUnordered`（multi_agents/wait.rs:139-171）。

### 4.2 "noProgress / progress" 概念

**codex v2 完全沒有**——全 repo `noProgress|no_progress` 零命中；wait 只有三 outcome（MailboxActivity/Steered/TimedOut）。**noProgress 是 dsh tool-agent-team 的**：`wait_agent` execute 先同步檢查「是否有 *其他* member 處於 running/provisioning」，沒有 → 立即回 `{ timedOut:false, noProgress:{ reason:'no-active-peer', message: NO_ACTIVE_PEER_MESSAGE } }`（`packages/experimental/tool-agent-team/src/index.ts:40, 249-266`），且 tool description 先講明 "This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling."（索引:243-247）。i-harness M3 的 wait_agent 是「poll 所有 entry 20ms」（research/2026-08-26-i-harness-subagent-reuse.md `wait_agent | poll 20ms`）——**dsh 的 noProgress 正是 i-harness 最該補的**（見 §9）。

### 4.3 時限

| 項 | 值 | 出處 |
|---|---|---|
| min wait | 10,000ms（configurable；hard min 0） | config/mod.rs:221, 227；multi_agents_common.rs:29 |
| default | 30,000ms | multi_agents_common.rs:30 |
| max | 3,600,000ms（1h，hard max 同值） | config/mod.rs:223, 227；multi_agents_common.rs:31 |
| 超出 max | **error**（"timeout_ms must be at most ..."） | wait.rs:49-54 |
| 低於 min | **clamp 到 min + 訊息註明**（非 error） | wait.rs:55-57, 144-154 |
| 並發 | v2 `max_concurrent_threads_per_session` 預設 4，`effective_agent_max_threads = N-1`（留一給 root） | config/mod.rs:220, 1504-1514 |

### 4.4 完成通知（活動觸發的另一半）

v2 的 child 完成通知在 **session/mod.rs:1955-2049**：每次 `TurnComplete/TurnAborted` 事件由 `maybe_notify_parent_of_terminal_turn` 攔截 → `forward_child_completion_to_parent` → 以 `AgentCommunicationKind::Result`、`trigger_turn=false` 送 `InterAgentCommunication(FINAL_ANSWER)` 給 parent（**每 turn 一次**，測試 `multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn` 1887 行；interrupted turn **不**通知，測試 2096 行）。所以 parent 的 wait_agent / 下一輪 prompt 都會看到 child 的進度。「wait_agent blocks until mailbox delivery」是 `subagent_notifications.rs:2011-2035` 的整合測試：parent 第二個 turn 開跑時 child 還在跑 → wait_agent 先等 mail → 後續 request 才含 FINAL_ANSWER。

---

## 5. fork / context

- v2 唯一 fork 語意是 **`fork_turns: none|all|N`**（spawn.rs:291-318；`SpawningAgentForkMode::{FullHistory, LastNTurns(N)}`，control.rs:88-91）。`fork_context`（v1 bool）被**明確拒絕**：「fork_context is not supported in MultiAgentV2; use fork_turns instead」（spawn.rs:296-301；測試 multi_agents_tests.rs:1178）。
- 實作 `spawn_forked_thread`（control/spawn.rs:652-839）：
  1. 取 parent rollout 完整 items（`load_agent_model_context`，legacy 或 paginated history）；
  2. `LastNTurns(N)` → `truncate_rollout_to_last_n_fork_turns`（只留最近 N turn）；
  3. **過濾**（`keep_forked_rollout_item`，spawn.rs:74-95）：system/developer/user message 全留；assistant 只留 `FinalAnswer` phase；**所有 tool call/tool output/reasoning/AgentMessage/InterAgentCommunication 全丟**；`TurnContext/WorldState` 只在 FullHistory（preserve_reference_context_item）保留；compaction 的 replacement history 也過濾；`SecurityRiskScore` 丟；`EventMsg/SessionMeta` 留；usage-hint developer fragment 替換為 child 版（`subagent_developer_instructions`，multi_agents_common.rs:186-196 從 config 注入）；v2 的 `multi_agent_usage_hint` world-state key 移除（spawn.rs:823-826）。
  4. FullHistory fork：**model/role 不適用 model override**（spec 與 usage hint：「Full-history forks ... inherit the parent model and reasoning effort and do not accept overrides」——`DEFAULT_MULTI_AGENT_V2_MODEL_OVERRIDE_USAGE_HINT_TEXT`，session/multi_agents.rs:55-59）；但 **agent_type override 與 service_tier 在 v2 的 full fork 是被允許的**（測試 `multi_agent_v2_spawn_fork_turns_all_applies_agent_type_override`、`multi_agent_v2_full_history_fork_accepts_explicit_service_tier`），與 v1 的 `reject_full_fork_agent_type_override`（common.rs:140-149）相反。
- **配置繼承**：`build_agent_spawn_config` / `build_agent_shared_config`（common.rs:157-235）＝parent turn 的 model/model_provider/reasoning_effort/reasoning_summary/developer_instructions（v2 可換 `subagent_developer_instructions`）+ `apply_spawn_agent_runtime_overrides`（approval_policy、approvals_reviewer、**cwd**、permission-profile snapshot）+ role config + model/reasoning/service_tier override（對 available models 驗證並限 5 個、檢查 reasoning effort 支援、service tier 支援）。**"runtime-only state 以 live turn 為準、不複製 stale config" 是明確設計意圖**（common.rs:146-156, 200-235 doc comments）。
- **fresh vs fork 的預設**：`fork_turns` 未給 → `"all"`（spawn.rs:299-304）；`"none"` = 全新 context（只帶 NEW_TASK message + base instructions + role 系統提示）。
- **`multi_agents_spec.rs` 是 code 不是設計文檔**——它是 tool schema 建構器＋內嵌 prompt 文案（`spawn_agent_tool_description_v2` 約 500 行 prompt 設計：當善用 vs 當阻塞、何時 delegate、非重疊 write scope、spawn 後先做本地工作、wait_agent 要克制、parallel delegation pattern，spec.rs:751-800）。設計選擇摘要：① spawn 面朝「bounded sidecar task」；② 明確要求「while subagent is running, do meaningful non-overlapping work immediately」；③ "Do not redo delegated subagent tasks yourself"；④ 提示語還要求「僅在 user/AGENTS.md/skill 明確授權時才 spawn」（spec.rs:675-680——這是安全相關的非目標）。

---

## 6. codex vs dsh agent-team 對照

| 維度 | codex MultiAgentV2 | dsh Agent Teams（rc.8 experimental） |
|---|---|---|
| 身份 | ThreadId + AgentPath（spawn 路徑）＋nickname/role 存 thread metadata；spawn-edge 存 SQLite（open/closed） | durable named roster（lead + teammates），名稱保留制、provisioning 快照、reconciliation |
| mailbox | **session-scoped in-memory deque** + watch channel；無 ack、無 retry、無 de-dup；已交付 mail 以 AgentMessage 進入 rolling rollout | **Lead-log durable** `team/message/queued` → `team/message/delivered` ack；per-target dispatch tails；maxPending/maxBytes；recovery 重試；目標 de-dup |
| task | **無 task board**；「task」= followup_task 的 NEW_TASK mail ＋ 子代理持久的 rollout | TeamTaskBoard：team/`team/task` snapshot、revision、**CAS（expectedRevision）**、DAG blockedBy、tombstone、writeScopes |
| wait | edge wait 於**本 thread input queue**（mail/steer/timeout 三 outcome）；**無 noProgress** | `waitForChange`：activity waiter（10s-1h）、**noProgress: no-active-peer 立即短路**、source 含 roster/mailbox/task/live-status 邊 |
| 持久化 | spawn graph + 各 thread rollout；**無 invariant replay、無 reconciliation**；registry 重啟後 restore | journal 全事件化 + `invariant.ts` companion + 重啟 reconciliation |
| 一致性 | path 唯一性靠 in-memory reserve（spawn 瞬間）；無 revision | CAS + tombstones + 完整快照 |
| 檔案共享 | 同一 container/同一 cwd（usage hint 明諭「edits ... immediately visible」） | 同；writeScopes 僅 advisory（"advisory, not a lock"） |
| 檔名/規模 | codex 單進程、每 root 一個 AgentControl、LRU residency 4 槽 | dsh 實驗性質（private package、release 排除） |

**判定**：
- **codex 更輕量、更實用（值得抄）**：① path-based 定址＋`resolve()`（相對/絕對統一）；② `fork_turns` 三元語意取代 bool fork_context；③ spawn 非同步＋「完成即 FINAL_ANSWER mail 到 parent」天然回饋迴路；④ LRU residency（併發上限=資源上限，不強制 close）；⑤ wait = edge wait on single watch channel（零輪詢、零 per-target subscription）。
- **codex 更粗糙（dsh 更完整值得搬）**：① **mail 不持久**（pending deque 在記憶體；只有已交付的才在 rollout）；② **無 noProgress**（模型會盲等 30s 才學到「沒人在跑」）；③ **無 task/roster 投影**（並行 worker 之間無法共享任務狀態，只剩對話式協調——模型要自己記/轉述）；④ **等待結果不帶內容**（wait 只回「完成」——模型必須 list_agents 或靠 FINAL_ANSWER mail 才知道內容；這其實是刻意的:防 CoT/內容回流，spec 明述）；⑤ **無去重/ack/重試**（process 內一次投遞，失敗即 error "agent with id X not found"/"collab manager unavailable"）。
- codex 的協調模型定位：**「結構化長度恰到好處的對話式」**——有 path identity、mail envelope 格式、activity events、spawn graph 持久化（這些是結構化部分）；但 team 的「狀態域」（roster snapshot、task board revisions、mailbox ack）全部不存在，狀態純由 session events / tool calls / 每 thread rollout 重現。**沒有 durable domain session；狀態全靠 replay（rollout history）+ 事件導出 status**。
- 附註：dsh roadmap 亦將這些 agent-team 定位為 experimental 且 i-harness 已視為「參考性」（`docs/audit/2026-08-20-dsh-rc8-delta.md`：「Reference for a future subagent-teams milestone」）。

---

## 7. 測試掃描（多代理檔案）

### multi_agents_tests.rs（~4600 行，v1+v2 handler 單元級）重點群組
- spawn 參數驗證：reject empty message / message+items 兩者 / non-function payload / depth limit（v1）/ `task_name` missing / legacy `items` 欄位（v2 用 deny_unknown_fields）/ 非法 `fork_turns` 字串與 `0` / legacy `fork_context`（`multi_agents_v2_spawn_rejects_legacy_fork_context`）。
- 角色／model：`spawn_agent_uses_explorer_role_and_preserves_approval_policy`（**approval policy 與 provider 沿用 parent**）、`..._reapplies_runtime_sandbox_after_role_config`、service tier 三連測（explicit/inherit/fallback/unsupported→clear）。
- 定址：`multi_agent_v2_spawn_returns_path_and_send_message_accepts_relative_path`（驗證 `task_name=="/root/test_process"`、`resolve_agent_reference("test_process")` 成功、communication 欄位 author/recipient/encrypted/trigger_turn 全斷言）、`multi_agent_v2_send_message_accepts_root_target_from_child`、`multi_agent_v2_followup_task_rejects_root_target_from_child`（還驗證 root 未收到 Interrupt/InterAgentCommunication op）。
- wait：`multi_agent_v2_wait_agent_*` 一組（timeout-only 參數、clamp below min、at min/at max/above max、default、zero-default allowed、already-queued mail 立即返回、**wakes on any mailbox notification**、**does not return completed content**）。
- 完成通知：`multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn`（一次 turn 一封）、`multi_agent_v2_interrupted_turn_does_not_notify_parent`。
- list：completed status / path_prefix 過濾 / omits closed / keeps interrupted resident。
- v1 保留段：send_input/resume/close（`tool_handlers_cascade_close_and_resume_and_keep_explicitly_closed_subtrees_closed`）、wait 的 not-found/時限/final-status。
- 揭露的限制：測試設 `Feature::MultiAgentV2` 時**手動構造 handler**（無完整 tool plan）；depth 限制在 v2 被忽略是**被測的契約**（`multi_agent_v2_spawn_agent_ignores_configured_max_depth`）。

### multi_agents_spec_tests.rs（純 schema 單元測）
斷言：`task_name`+`message` required；`message.encrypted == Some(true)`；無 `items`/`fork_context`；model summary 只列 picker-visible 且 **上限 5 個**（`spawn_agent_tool_caps_visible_model_summaries`）；reasoning effort 描述截斷 64 字元；hide 模式下的增刪欄位矩陣（`expose_agent_type` / `hide_agent_type_model_reasoning` / `expose_spawn_agent_model_overrides` 4 組合）；v1 保留 `fork_context`；send_message/followup 無 output schema；wait v2 output schema；list_agents status schema 含 interrupted。

### 整合測試（core/tests/suite）
`subagent_notifications.rs`（**標竿**）：spawn 後 child 收到 `agent_message` input（明文 vs encrypted_content 兩種形狀，`multi_agent_v2_spawn_sends_agent_message_to_child` 1743-1871 行）；leaf workers **不**收到 collaboration tools（1885-1886 行）；parent turn 內 wait_agent 與 FINAL_ANSWER 的時序（2011-2035 行）；`spawn_agent_uses_configured_subagent_defaults`（model/reasoning 繼承與 independent subagent defaults）。`spawn_agent_description.rs`：wait_agent 依 `wait_agent_enabled` 開關且**跨 resume 保持一致**。`spec_plan_tests.rs:2255-2395`：v1/v2 工具族互斥可見、v2 namespace 內六工具齊全、`non_code_mode_only=true` 時 code-mode 下隱藏。

---

## 8. 限制 / 非目標

1. **單進程、單 ThreadManager**：所有 agent 同一 process；`AgentControl` 每 root 一個並共享給整棵樹（control.rs:87-94 doc comment）。無跨 process 通訊、無分佈式隊列。
2. **共用 filesystem / cwd**：usage hint 明文承諾（session/multi_agents.rs:62-65 "All agents share the same directory ... edits made by one agent are immediately visible to all other agents"）；寫入衝突管理不在系統內（dsh task board 的 writeScopes 也是「advisory, not a lock」）。
3. **mail 不持久（重點缺口）**：`InputQueue.mailbox_pending_mails` 純記憶體（input_queue.rs:72-91）；process 重啟只保「已交付」的（寫入各 thread rollout 的 AgentMessage）。**pending send 在 crash 時靜默遺失**；無 re-drive/死信。
4. **無 queue ack / 去重 / 重試**：`enqueue` 一次成功即算送達（返回空），target thread 缺貨時 error（`ThreadNotFound`/`InternalAgentDied`→"agent with id X is closed"）。dsh 的 queued→delivered ack + recovery 不存在。
5. **wait 無內容、無 target、無 noProgress**：模型無法只靠 wait 得知「哪個 agent 完成了/內容是什麼」→ 依賴 list_agents＋FINAL_ANSWER mail；也沒有 dsh 的 no-active-peer 短路（30s 空等是常見成本）。
6. **v2 無 close/resume 工具**：收斂只能靠 LRU residency（completed/errored/interrupted 且 idle 且無 pending mail 才可被 evict，residency.rs:186-191；否則 spawn 撞 `AgentLimitReached`）。**重啟後：root 從 rollout resume，`restore_v2_agent_metadata` 重建 Open 邊的 agent 身份**（thread_manager.rs:1011），但 agent 的**執行狀態變為未載入**——第一次 send/followup 時 `ensure_v2_agent_loaded` 從 stored rollout 重新載入（control/spawn.rs:263-370，需 history、role config、model/provider 還原）；故「重啟後找回 child」是 codex v2 明確支持的路徑（但沒有 resume_agent 工具名稱）。
7. **模型依賴面大**：spawn_agent 的 tool description + usage hints 有上千字 prompt 責任（何時 delegate、write 領域拆解、防止重複等，spec.rs:749-800）；這些提示是「非目標」的載體（禁止未授權 spawn：spec.rs:675-681）。模型被封裝為 codex 產品（同 provider 同 auth）。
8. **並發上限 4（預設）且 root 佔一席**：`effective_agent_max_threads = max_concurrent - 1`（config/mod.rs:1504-1514）；`wait_agent` 提示「prefer longer waits (minutes) to avoid busy polling」（multi_agents.rs:60-62）。
9. **v2 只在 plugin/model 支援時出現**：`model.multi_agent_version != Disabled` 才顯示（common.rs:34-40）；non-code-mode 預設 `non_code_mode_only=true`（code mode 下 model 看不到，spec_plan.rs:1147-1151）；工具不能在 `functions.exec` 內使用（usage hint：session/multi_agents.rs:56-61）。

---

## 9. 我們（i-harness）可以從 codex 學什麼

i-harness 現況：durable mailbox（M8 `subagent/inbox` + `mailbox[]`）＋ jobs＋ M9 的 continuable multi-turn 模型（spawn/wait/list/send/followup/interrupt/close/resume，`waiting` status、followupChain、cold resume）＝ **已經是 dsh-style 的 continuable 模型，且比 codex 更持久**（mail 落 session log）。以下為缺口與可搬設計：

**a. noProgress 短路（最重要的缺口）**：i-harness `wait_agent` 是 20ms 輪詢 + 盲等（M3/research 記載）。搬 dsh tool-agent-team 的 `NO_ACTIVE_PEER_MESSAGE` 模式：wait 前同步檢查「是否有其他 member running/provisioning」，沒有 → 立即回 `{ noProgress: { reason: "no-active-peer", message } }`（附行動指引：`followup_task` 喚醒後再 wait）；同時把 tool description 改為 dsh 的措辭（"never wakes inactive members... Re-list after wakeup or timeout instead of polling"）。i-harness status 已含 running/waiting，映射很容易。

**b. AgentPath resolve（定址統一）**：i-harness path 是 `root/helper`、spawn 也是 `parentPath/taskName`（research 1.1），但 **label 為相對/前導 slash 的處理、`..` 保留、與 siblings 同名時的消歧規則**都未成文。搬 `AgentPath::{resolve(relative|absolute), name, is_root, join}` 的嚴謹校驗（lowercase/digit/underscore、保留字、`%s` 路徑唯一性錯誤訊息）——把「命名與解析」做成單一類型，測試 6 個 case 直接可抄（agent_path.rs tests:203-235）。

**c. Activity events（SubAgentActivityItem）**：i-harness 無「spawn/intercepted/interrupted」的可視化事件流。搬 `SubAgentActivityKind::{Started, Interacted, Interrupted}` — 在 spawn/send_message/followup/interrupt 成功後 emit；TUI/client 可以畫 agent 樹；**不進模型 context**（這是 codex 的紀律：client-visible ≠ model-visible）。對應 i-harness 是新增 `subagent/activity` 類事件（durable log 可加，不 bump format 的話可放 session event）。

**d. Per-target queue 的「投遞資料夾」語意**：codex 的 mailbox 是**每 thread 一個**（send 只能進 target 的 queue），i-harness 是每 entry 一個 `mailbox[]`（相同的 per-target 語意，但持久）。可抄的是 codex 的**投遞時機控制**（MailboxDeliveryPhase：sample boundary / tool-call-end 注入；running agent 不收中斷）與 **`send_message` 不喚醒、`followup_task` 喚醒**的對分——i-harness M9 已對齊，但「正在跑時 message 何時進模型」的控制器（等同 codex 的 pending input split + accept_mailbox_delivery_for_current_turn）值得參考其實作（input_queue.rs:193-247, 294-360）。

**e. LRU residency（併發上限與 evict 政策）**：i-harness 無「併發上限」概念。codex 的 `max_concurrent_threads_per_session=4`（root 佔 1）+ LRU evict（僅 completed/errored/interrupted、idle、無 pending mail 才 evict；evict 前 flush rollout、保留環境選擇）讓「開著不關」也有界——比「close_agent 必須顯式」更不易忘。對 i-harness：jobs 已可 re-open；可在 subagent table 加 `maxRunning` + LRU `evicting` 狀態，避免 unbounded 併發。

**f. 其他值得抄的小件**：
- `fork_turns: none|all|N`（取代 bool fork_context；i-harness M3 已有 forkTurns，但 codex 的「N= 以 turn 為切割」＋ `truncate_rollout_to_last_n_fork_turns` 的 filer 規則（只留 user/system/developer + assistant-final，丟工具/理由/AgentMessage）是精準的內容策略）。
- `InterAgentMessage` 的**統一文字信封**（`Message Type: MESSAGE|NEW_TASK|FINAL_ANSWER\nTask name:...\nSender:...\nPayload:`）——i-harness 目前用 `subagent/inbox` 事件 + deriveMessages 呈現；若模型要看到 who/when，此信封格式是穩定、可 assertion 的（codex 的 template 測試就是逐字元比對）。
- **完成通知 = mailbox 回投**（codex：child 的 TurnComplete 自動轉 FINAL_ANSWER mail 到 parent，每 turn 一封、interrupted 不發）——i-harness M9 的 followupChain 由 driver 回寫 job；「每 turn 通知 parent」這個 edge 目前靠 jobs wait(); 若要做 wait_agent edge，應以「mailbox 收到 completion event」為邊（而非輪詢 job）。
- **spawn 回傳不含 thread id（v2 只回 task_name）**：模型永遠用 path 說話，無「id 漂移」問題——i-harness 目前 spawn 回 `{agent_path, job_id}`，已符合。

**g. 不要搬的**：codex 的「wait 不帶內容」是為防 CoT 洩漏/訊息回流而設計；i-harness 的 jobs `output` 已拿最終文字，保留。也不建議搬「無 ack」——i-harness 的 durable inbox 是優勢，保留 queued/delivered 語意。

---

## 關鍵檔案索引

- `D:\agent-complete\codex-rust-v0.149.1\codex-rs\core\src\tools\handlers\multi_agents_v2.rs`（entry、activity emit、communication_from_tool_message）
- `...\multi_agents_v2\spawn.rs`（fork_turns、HiddenMetadata、config/spawn 流程）
- `...\multi_agents_v2\wait.rs`（edge wait、clamp、three outcomes）
- `...\multi_agents_v2\message_tool.rs`（QueueOnly vs TriggerTurn、root 禁止）
- `...\multi_agents_v2\{send_message,followup_task,interrupt_agent,list_agents}.rs`
- `...\multi_agents_common.rs`（timeout 常數、spawn source、config build）
- `...\multi_agents_spec.rs`（**code**：schema＋prompt；非設計文檔）
- `...\multi_agents.rs` + `multi_agents\*`（v1 對照）
- `...\multi_agents_tests.rs` / `...\multi_agents_spec_tests.rs`（測試名掃描見 §7）
- `D:\agent-complete\codex-rust-v0.149.1\codex-rs\core\src\agent\agent_resolver.rs`、`agent\control.rs`、`agent\control\{spawn,residency,legacy}.rs`、`agent\registry.rs`、`agent\status.rs`
- `...\core\src\session\input_queue.rs`（mailbox deque + watch）、`session\handlers.rs:82-107`、`session\mod.rs:1955-2049,3257-3287`、`session\multi_agents.rs`（usage hints）、`session\turn.rs:1849`、`hook_runtime.rs:579-621`
- `...\core\src\context\inter_agent_message.rs`、`inter_agent_completion_message.rs`、`subagent_notification.rs`、`session_prefix.rs`
- `...\protocol\src\protocol.rs`（InterAgentCommunication:738、AgentStatus:1740、SessionSource/SubAgentSource:2579-2737、SubAgentActivityKind/Event:4103）、`protocol\src\items.rs:325-330`、`protocol\src\agent_path.rs`、`protocol\src\legacy_events.rs:405-418`
- `...\agent-graph-store\src\*.rs`（SQLite spawn edge）
- `...\features\src\feature_configs.rs:234-278`、`core\src\config\mod.rs:220-229,1219-1259,1504-1514`
- dsh 對照：`...\deepseek-harness-master-rc8\deepseek-harness-master\packages\experimental\agent-team\src\{index,mailbox,task-board,activity,journal,invariant}.ts`、`...\experimental\tool-agent-team\src\index.ts:30-266`
- i-harness 對照：`D:\agent-complete\I-harness\docs\superpowers\specs\2026-08-18-i-harness-m9-subagent-multiturn-design.md`、`docs\superpowers\research\2026-08-26-i-harness-subagent-reuse.md`

---

## Short Report（回報）

**10 個最重要發現**：
1. V2 工具面只有 6 個（spawn/send_message/followup_task/wait_agent/interrupt_agent/list_agents），**沒有 close_agent/resume_agent**——改用 LRU residency（預設並發 4，root 佔 1）自動 unload/reload。
2. spawn 非同步＋只回 `{task_name, nickname?}`（nickname 預設隱藏），**不回 thread id**；模型全程用 AgentPath 說話。
3. wait_agent v2 = 單一 watch channel 的 **edge wait**（Mailbox/Steer/TimedOut），**不是 poll**；但**無 noProgress 概念**——noProgress/no-active-peer 是 dsh 的設計。
4. mailbox = **每 thread 自己的 in-memory deque**＋`trigger_turn` 旗標；send_message=queue-only、followup_task=wake；**pending mail 不持久**（已交付才落地 rollout）。
5. mail 注入＝`Op::InterAgentCommunication` → target input_queue → 下輪 turn 時 `record_inter_agent_communication` → `ResponseItem::AgentMessage`（信封 `Message Type: MESSAGE|NEW_TASK|FINAL_ANSWER`）進模型 context。
6. 狀態**純由事件導出**（AgentStatus 由 TurnStarted/Complete/Aborted/Error/Shutdown 換算，is_final 判定）；唯一持久結構化資料是 SQLite spawn-edge graph（open/closed），重啟靠 `restore_v2_agent_metadata` 重建身份、`ensure_v2_agent_loaded` 從 rollout 熱載回。
7. `fork_turns: none|all|N` 取代 v1 的 bool fork_context；fork=拷貝 rollout 後**精選過濾**（只留 user/system/developer + assistant-final，丟工具/推理/AgentMessage），N 以 turn 為切割。
8. child 每 turn 完成自動發 FINAL_ANSWER mail 給 parent（interrupted 不發）——完成通知是「回投 mailbox」，不是 job 查詢。
9. `multi_agents_spec.rs` 是 **code（schema＋上千字 prompt/usage hints）**，不是設計文檔；prompt 明禁未授權 spawn、要求 spawn 後做非重疊工作、wait 要克制。
10. 無 roster 快照/task board/CAS/ack/回收 reconciliation——codex 協調是「結構化恰到好處的對話式」，dsh agent-team 的 durable 領域才完整。

**codex 最值得搬進 i-harness 的 5 樣**：
1. **AgentPath 定址類型**（resolve/name/is_root/保留字/唯一性錯誤，含 6 個現成測試）— 修 i-harness path 解析缺口。
2. **wait_agent noProgress 短路**（dsh 的 `no-active-peer` 才是有動作性的；codex 證明 edge-wait 可行，i-harness 應改成 edge + noProgress 兩者）— 修 20ms 盲輪詢。
3. **fork_turns 內容過濾規則**（「只留 user/system/developer + assistant-final」+ N-turn 切割）— 精準控 context 拷貝。
4. **Spawning 完成回投**（child 每 turn → parent mailbox FINAL_ANSWER；interrupted 不發）— 讓 i-harness 的 wait/list 有真 edge 可等。
5. **LRU residency 併發上限**（max 4、僅 completed/errored/interrupted+idle+空 mail 可 evict、flush 再退）— 省掉「忘了 close」的資源洩漏，且伴隨 `hide_spawn_agent_metadata`（模型只看 path）與 activity events（Spawn/Interact/Interrupt client 事件流）一起抄更划算。
