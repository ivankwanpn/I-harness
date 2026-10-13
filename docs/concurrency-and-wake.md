# 併發、輸入准入與喚醒契約

> 2026-10-13，外部審計修復及 event-driven steering 更新。這是 **agent 執行模型的單一權威描述**；能力概覽與原始碼註解只指向此處。背景判讀見 [外部安裝與實測報告 §11、§12.2、§12.4](audit/2026-10-13-external-install-and-verification.md)。新增契約用檔案及符號引用，既有外部審計行號是當時的讀碼紀錄。
>
> 證據標記：**`[讀碼／已核對]`** = 查核指定實作，不等於端到端、跨平台或斷電實測；**`[實測]`** = 列明實際執行的命令；**`[施工中／未保證]`** = 工作方向，不宣告已完成。**INVARIANT** 是指定實作範圍內由程式維持的不變量；**CONVENTION** 是宿主接線／命名約定，不能推成所有 embedder 的保證。
>
> 設定熱更正在同一分支遷移，§6 特別區分「輪詢出發點」與「fs-watch 接縫」，**不以本文件判定哪個是當前後端**。輪詢出發點的行號只指不可變基線 `5741a849f36ea2a56822147b516f649afe530b87`；其餘引用指本次核對的工作樹。

## 1. 四層准入不是四條執行 lane `[讀碼／已核對]`

**INVARIANT — `mapSubmitToAdmission` 的映射：** durable delivery 只有 `queue | steer`，intent 只有 `user | system`（`packages/core-session/src/inbox.ts:4-5`）。

| submit tier | durable delivery | intent / 附帶資料 | 已核對的映射 |
| --- | --- | --- | --- |
| `send` | `queue` | `user`；可攜帶 images / clientToken | `packages/core-agent/src/executor.ts:54-56` |
| `followup` | `queue` | 與 `send` 相同 | `packages/core-agent/src/executor.ts:54-56` |
| `steer` | `steer` | `user`；可攜帶 images / clientToken | `packages/core-agent/src/executor.ts:57-58` |
| `inject`，`scope: "turn"` | `steer` | `system`；`synthetic: { description, scope }` | `packages/core-agent/src/executor.ts:59-66` |
| `inject`，`scope: "session"` | `queue` | 同上 | `packages/core-agent/src/executor.ts:59-66` |

- **INVARIANT — 收件箱是 log 投影。** `admit()` 驗證後 append `agent/input/admitted`；promote / cancel 也 append marker。`pending()` 從 admission 與 consumed marker 重建，按 admission 順序返回（`packages/core-session/src/inbox.ts:53-87`、`packages/core-session/src/inbox.ts:90-112`）。這裡的 durable 指 **log-backed 格式與生命週期**，不是每次 admit 都已同步寫入磁碟的承諾（§7）。
- **INVARIANT — 活動 turn 的 steer 在 step 邊界領取。** `claimAtStepBoundary()` 依序 promote pending steer 並 append `user/message`（`packages/core-session/src/inbox.ts:119-137`）；agent 在每步的 provider 呼叫前領取，再 derive messages（`packages/core-agent/src/index.ts:366-394`）。queue 留給 turn 邊界；idle 時所有 delivery 都可作為 pump 下一個 turn 的輸入（`packages/core-agent/src/executor.ts:95-114`）。
- **CONVENTION — `send` 與 `followup` 的名稱表示呼叫者意圖，不構成優先級。** 此映射沒有兩者不同的 delivery、搶占或喚醒位元。`inject.scope` 在此決定 delivery 並記錄 metadata；本映射**沒有**提供 TTL／自動撤銷保證。steer 也**不是**中途打斷 provider 呼叫。

## 2. Wake 是 PUSH，不是定時器 re-pump `[讀碼／已核對]`

**INVARIANT — `SessionExecutor.submit()` 先准入，再在同一次同步呼叫內執行 `void pump()`**（`packages/core-agent/src/executor.ts:141-151`）。`pump()` 把工作接到 `chain.then(...)`，所以「同步 push」指同步排定 drain，**不是**同步執行完模型、也不是 wall-clock 零毫秒（`packages/core-agent/src/executor.ts:93-95`）。

`Inbox.admit()` 本身只寫 log，不會喚醒 executor（`packages/core-session/src/inbox.ts:53-70`）。繞過 `submit()` 的宿主必須另行 drive；不能把「任何裸 Inbox admission 都會 wake」當作保證。

**`[實測／靜態搜尋]`** 在 repo 根執行：

```sh
grep -R -n 'setInterval' packages/core-agent/src
# exit 1，零命中
```

這個結果與 `pump()` 的呼叫點共同支持 **core-agent 沒有 interval re-pump**：drive 入口是 `submit()` 與 `runAdmitted()`，`drain()` 只等待既有 chain（`packages/core-agent/src/executor.ts:134-151`、`packages/core-agent/src/executor.ts:165-167`）。**不宣稱 core-agent 完全沒有 timer**：reasoning delta 用 50ms `setTimeout` 發送 transient 更新，不是 pump（`packages/core-agent/src/index.ts:593-611`）。也不宣稱整個產品沒有輪詢（§6）。

### 子代理 → 父 session：admit 成功後才 wake

**INVARIANT — notification drain `await admit(...)`，更新交付狀態後呼叫 `wake(parentSessionId)`**（`packages/subagent/src/task-notification.ts:85-93`）；未提供 admission adapter 時直接返回，不用輪詢補交付（`packages/subagent/src/task-notification.ts:69-70`）。

**CONVENTION — adapter 必須分開描述，`wake` 並非全域 no-op：**

| 宿主 | admission / wake 接線 | 已核對證據 |
| --- | --- | --- |
| CLI `run` 預設 adapter | `admit` 呼叫 `lane.submit({ tier: "inject", scope: "turn", ... })`，已 push；`wake: () => {}` 現在是 no-op | `apps/cli/src/run.ts:489-497` |
| session-executor service 預設 adapter | 先 `assembly.inbox.admit(...)` 並等待 coordinator flush；`wake` 另行 submit 已准入的 inputId，**是真的 drive**，不重複 admission | `packages/session-executor/src/service.ts:304-321`、`packages/session-executor/src/service.ts:323-337` |

`ParentInputAdmission.wake` 成員註解保留獨立喚醒接縫：對 CLI 目前不需要，對需要分開准入／drive 的 executor（包括未來實作）有用途；service 已使用它（`packages/subagent/src/task-notification.ts:15-22`）。**不保證**自訂 adapter 的 `admit` 自帶 wake，也不把 notification 的 `woken` 標記等同於父模型已完成一個 step。

### 人類 steer → 釋放正在觀察的等待 `[讀碼／已核對]`

**INVARIANT — 觀察者只讀該次工具的精確 live Session。** `userSteerForTool` 只接受仍 pending 的 `intent: "user", delivery: "steer"`，訂閱 admission／promotion／cancellation 後重新讀取 Inbox。queue、system、已取消、已 promoted 或另一個 Session 的 input 不會釋放此觀察者。取消發生在已交付 wake 之後，不能撤回已返回的結果。來源在 `packages/core-tools/src/observation.ts`，Desktop 透過 `createDesktopInput.admit` 對真正 assembly Session 准入（`packages/desktop-gateway/src/input.ts`）。

| 直接工具／觀察面 | steer 時的結果 | 後續取得原工作 |
| --- | --- | --- |
| `wait_agent` target／all | `yielded:true, yield_reason:"user-steer", timed_out:false`；target 保留原 path／session／job ID | 同 target 再等，或用原 task／job ID |
| `spawn_agent background:false` | 同一 `agent_path, task_id, job_id`、目前 running 狀態及 steer marker | `get_task_output({task_ids:[task_id],wait:true})` |
| `get_task_output(wait:true)` | 原 task IDs 的當前 snapshot，加 steer marker | 同一組 IDs 再讀／等 |
| `job_output(wait:true)`，subagent／exec／workflow | 原 job 的當前 text、`status:"running"` 及 steer marker | 同一 job ID 再讀／等 |
| `workflow_run(wait:true)` | 同一 `job_id`、目前 workflow view 及 steer marker | `job_output` 讀同一 workflow ID |
| 前景 `bash`／`pwsh`／已選 `shell` | 同一 capture 註冊成 job，回 `job_id, promoted:true, ran_foreground_ms`；stdout 說明 `Yielded to new user input; command continues as job …` | `job_output`；`job_kill` 明確停止 |
| outer `code_exec`／`code_wait` | 同一 `cell_id, status:"running", yield_reason:"user-steer"` 與已可交付的新輸出 | 後續 `code_wait` 讀同一 cell |

Shell 的 model-facing promoted 結果沿用原 shape，原因寫在 stdout；它沒有 direct wait 的 `yielded`／`yield_reason` 欄位。Exec service 的 `PromotedRun.promotionReason` 是 service 契約。等待期限與既有 clamp 保留；只有 deadline 令 `wait_agent.timed_out` 為 true。target 被移除／替換時，`wait_agent` 返回原 identity 的 `yield_reason:"target-changed"`，不把新佔用者當作舊 child 完成。

**INVARIANT — steer 釋放 observation，owner 繼續。** 不 abort、重新 spawn、重新 dispatch、重執行，也不給原 call ID 第二個 result。下一個既有 model step 才由 `claimAtStepBoundary` promote input 並加入一次 user message。parent turn 可自然結束，原 task／job／cell 仍繼續；後來另一個 turn 用原 ID 取結果。foreground spawn 保持 durable `delivery:"tool"`，完成時沒有新建背景 parent-result 通知。

Code Mode 只釋放 outer observer。`resultConsumer:"code"` 令巢狀等待不讀 human-steer source；guest 的 `await tools.…` 繼續等待原本的真實結果，包括任意巢狀工具。模型不把 running/yield marker 當成該巢狀工具的實際完成值。每次 `code_wait` 只交付新的 output window；已消耗的輸出不重播。必須完成的 retention／spill I/O 仍可能延後 observation 返回。Stop／terminate／close／dispose 仍 cancel 並 join 原 owner，包含尚未回應 abort 的在途 producer。

前景 shell 的 threshold 與 steer 共用同一 capture promotion。steer 不更改 launch 時選定的 process-tree／sandbox lifetime；configured threshold 維持原 transport 限制，wake-only capture 保留 complete-tree cleanup。工具 observation 正常返回會清除該工具 guard 的觀察期限；dispose 仍透過原 owner 清理／等待程序（`packages/exec/src/service.ts`、`packages/shell/src/index.ts`）。

這條 observer release 不等於 completion wake。背景 child 原有 durable task outbox 仍在 admit 成功後 drive 父 lane；generic exec／workflow 完成只更新其 registry／view，沒有新增 idle-parent 自動 inference。foreground spawn 也不因 steer 轉成背景通知交付。

## 3. Promise lane：單 session 序列，跨 session 可並行 `[讀碼／已核對]`

- **INVARIANT — 每個 executor 一條 SERIAL chain。** `chain` 起始為 resolved promise；每次 pump 追加 `then`，內部 `for (;;)` 每次 `await agent.run(...)` 才考慮下一個 pending input（`packages/core-agent/src/executor.ts:79`、`packages/core-agent/src/executor.ts:93-114`）。同一 executor 的 turns 不重疊；**turn 內的工具並行不是第二條 turn lane**。
- **CONVENTION — 宿主對每個 session 使用一個 executor。** registry 是普通 `Map`，拒絕同一 sessionId 的重複 register；它沒有全域 semaphore，N 個 session 可同時推進（`packages/core-agent/src/executor.ts:181-190`）。「每 session 序列」建立在這個接線約定上；constructor 不阻止 embedder 自己對同一 Session 建兩個未註冊的 executor。這也不是跨程序互斥或 CPU 同時平行的保證。
- **INVARIANT — 一個失敗 turn 結束的是這次 pump，不是永久毒化整條 lane。** promote 在 `agent.run` 前；catch 記錄錯誤並 return，finally 清 running/current（`packages/core-agent/src/executor.ts:109-124`）。其餘 pending 沒有被此 catch 取消或消耗，等 **後續 pump**；後續 pump 可以是已排在 chain 後面的另一個 pump，也可以由新 submit / 明確 `runAdmitted()` 產生。**不保證每次失敗都會停滯**，但若沒有後續 drive，就會 idle 而仍有 pending。
- **INVARIANT — 觀測不等於重啟。** `pending()` 可讀剩餘輸入；`drain()` 等既有 chain 並傳遞 lane 的失敗，不會啟動新 pump（`packages/core-agent/src/executor.ts:162-167`）。錯誤／觀測面可以增加「尚有多少 pending」的資訊，**不改變上述剩餘輸入等待後續 drive 的語意**。本文件不綁定錯誤型別或診斷字段名，也不宣稱 promote 後失敗的輸入會自動 retry。

## 4. Step 續行與 hook 瀑布，不是 event-bus 控制流 `[讀碼／已核對]`

**已 dispatch 的 batch 仍須 drain。** 一個 eligible observer 已返回，不代表同一批任意 sibling 已完成；下一個 provider step 要等已開始的 sibling 收尾。shipped subagent wait／job 工具仍採 exclusive classification；只有明確標記 `isConcurrencySafe:true` 的工具可同組並行。整合 fixture 明確把原 `job_output` body 包成 parallel-safe alias 以測試「sibling 已 dispatch」邊界，沒有修改 shipped dispatch policy（`packages/core-agent/src/execute-tool-calls.ts`、`packages/session-executor/test/event-driven-steering.test.ts`）。child admission／policy／approval／model resolution 及任意 direct tool body 都沒有取得 detachment 授權。

**INVARIANT — 每步結束時 `needsContinuation = toolCallsThisStep > 0`**（`packages/core-agent/src/index.ts:761`）。有工具呼叫就再走一步；沒有工具呼叫且該步不是 refused / truncated / empty 時，才進 pre-stop 接縫（`packages/core-agent/src/index.ts:762-783`）：

1. `await ctx.emit("agent/pre-stop", stopInput)` 與 host hook runtime 的 `beforeStop()` 可提供 continuation reason。
2. 非空 reason 被包成 plugin feedback append 到 log，`needsContinuation = true`；仍受每步 AbortSignal / maxTurns 檢查限制（`packages/core-agent/src/index.ts:367-369`）。

**術語邊界：** `ctx.emit` 先執行 plain listeners，再執行已註冊的 waterfall，await 結果並向 parent 傳播；不是 fire-and-forget bus（`packages/core-plugin/src/index.ts:274-294`）。waterfall 必須 `next()`，cascade 則是包住 `final` 的 around hook，可不呼叫 `next()` 而 short-circuit（`packages/core-plugin/src/index.ts:181-218`）。因此不要把「cascade / waterfall hooks」泛稱誤讀成每個 hook 都直接呼叫 `ctx.cascade`：**pre-stop 呼叫的是 emit，工具 body 的 around seam 才是 `ctx.cascade("tools/execute", ...)`**（`packages/core-tools/src/index.ts:534-548`）。

工具的 `tools/pre-execute` / `tools/post-execute` 都經過可 await 的 emit／waterfall 面，但**閉集 `allow | deny | ask` 是 pre-execute 的 `ToolDecision`，不是 post-execute 的返回契約**：

- pre-execute 註冊 validator waterfall、驗證閉集並由 prepare 讀取 chain return；沒有 decision 時預設 allow（`packages/core-tools/src/index.ts:68-71`、`packages/core-tools/src/index.ts:310-326`、`packages/core-tools/src/index.ts:410-416`）。
- post-execute 收 `{ name, output }`，finalize await 它後返回原工具結果，**不讀取它作為 allow/deny/ask verdict**（`packages/core-tools/src/index.ts:551-554`）。hook 拋錯仍可令 await 失敗；這不是無副作用的 session 訂閱通知。

## 5. Session 訂閱無 replay；每步狀態從 log 重建 `[讀碼／已核對]`

**INVARIANT — `subscribe(session, listener)` 只加入 listener set，不走歷史 log。** durable event 在 append 到 `session.events` 後交給當時的 subscribers；新 subscriber 只收到訂閱後追加的 durable events，unsubscribe 停止交付（`packages/core-session/src/index.ts:385-396`、`packages/core-session/src/index.ts:449-452`）。

另外有 **transient** live chunks / model activity：`publishTransient()` 不走 durable append hook，而且移除 seq（`packages/core-session/src/index.ts:399-404`）。所以訂閱不只是 durable append 的通知，但兩者**都沒有歷史 replay**；transient 更新不能靠 log 重播。

模型輸入不是另一份靠通知逐步 mutate 的權威記憶體：agent 每步 `deriveMessages(session)` 並 `assertMessagesFromLog`（`packages/core-agent/src/index.ts:394-399`），projection 從 `session.events` fold（`packages/core-session/src/index.ts:585-586`、`packages/core-session/src/index.ts:689`）。需要歷史的消費端須讀 log，或用 SDK **`session/history`** 的事件頁（`packages/sdk/src/server.ts:605-637`）。本文件**不承諾** history 查詢與 subscribe 之間原子銜接、slow-consumer buffer、exactly-once 通知或 listener 例外隔離；這些須由宿主另訂契約。

### 子代理 durable history／狀態 push `[讀碼／已核對]`

`createChildObservation` 訂閱 owning AgentTable 以及每個精確 live child Session 的 durable events。新增／移除／狀態更新／Session 替換會 rebind；舊 identity 的晚到 events 不會更新新 child。Transient token chunks 不觸發此 invalidation，也不要求 parent 自己 append 新 event（`packages/session-executor/src/child-observation.ts`）。

Gateway `createDesktopSubagents` 透過 service `onAssembly(hook,{includeExisting:true})` 接上已存在及後來建立的 assembly，50ms coalescing timer 只在有 change 時啟動，idle 沒有定時 poll。`desktop/session/subagents/changed` 經 host／main／bridge 更新 pane 的 catalog 及 selected child history。讀取先驗證 root→child lineage、origin、權限與 sequence，再選 owning registry 的 actual live child Session；未 flush 的 durable tool/result 也可讀，不靠 flush-on-read，不把 child 暴露成普通 root `service.liveSession`／SDK authority。沒有 live owner 時維持 persisted snapshot／既有 unavailable 行為。元件與 read/control 的 disposers 清除 listener 和 pending coalescer（`packages/desktop-gateway/src/session-subagents.ts`、`packages/desktop/src/renderer/session/SubagentPane.tsx`）。

這條 UI durable push 與 §2 的 observer release／背景 child outbox 分別有自己的用途。其他 execution surface 的 active polling、UI clocks、provider retries、schedules、watchdog 與 write-behind 不因 child push 而消失。

## 6. 真正的輪詢點，以及不是輪詢的 timers `[讀碼／已核對]`

以下保留仍存在的 polling／timer 邊界；subagent／job／workflow 等待已改為事件觀察（§6.3），不能把舊等待的 10／20ms 輪詢描述套用到目前實作。

搜尋範圍是 `packages/*/src` 與 `apps/cli/src` 的 `.ts` / `.tsx`，排除 test、node_modules、release / gateway 打包副本；查核 `setInterval`、`setTimeout` 與 promise-delay 的實際控制流。**審計的五列不是整個產品所有輪詢的總數**，也不是「全都觀察外部檔案」：schedule 看 wall-clock / log，另外有 UI、登入與等待工具。

### 6.1 審計列出的五個位置（settings 是遷移出發點）

| 位置與證據 | 週期／啟用條件 | 為何不是 push wake |
| --- | --- | --- |
| `packages/desktop-gateway/src/host.ts:481-494` | 1000ms，並立即 sync 一次；timer unref | 重讀 agent settings / subagents / context；policy sync 有 in-flight guard，不是 executor pump |
| `packages/desktop-gateway/src/context-runtime.ts:57-62`、`packages/desktop-gateway/src/context-runtime.ts:84-87` | 30000ms，enabled + autoRefresh 時才設 timer，並立即 refresh；unref | 週期檢查／重建 Code Context；有 active job / refreshing guard |
| `packages/plugin-registry/src/managed.ts:31-42` | 250ms，並立即 tick；unref | stat `state.json` 的 mtime:size signature 再 onChange |
| `packages/schedule/src/driver.ts:117`、`packages/schedule/src/driver.ts:132-141`、`packages/schedule/src/driver.ts:188-194` | 預設 30000ms，可設 `pollMs`；start 先 tick；unref | fold log 並按 wall-clock 決定 due reminders，不是檔案通知，也不是 idle pump |
| **只指基線 `5741a849f36ea2a56822147b516f649afe530b87`**：`packages/settings/src/index.ts:1561-1613` | 原本預設 500ms，可設 `intervalMs`；初始只 snapshot；unref | stat mtime:size，比較 snapshot 後回呼；in-flight capture 不重疊。這是**輪詢 origin，不是工作樹現況斷言** |

**settings 的 fs-watch 遷移 `[施工中／未保證]`：** 同分支工作把 `watchSettings` 接到 `@i-harness/fs-watch` 的明確檔案 roots、`AsyncIterable` events / close 接縫。fs-watch 的介面與 chokidar 設定已可核對（`packages/fs-watch/src/index.ts:31-47`、`packages/fs-watch/src/index.ts:141-147`）；但**本文件不宣告 polling 或 fs-watch 哪個正在服役，也不以此宣告 migration gate 已綠**。遷移需保住初始 baseline 不重送、缺檔建立／刪除／原子替換、`.i-harness` 內明確 root、錯誤與 dispose 行為；是否完成應以該 worker 的接線與測試結果為準。chokidar 的 awaitWriteFinish 是寫入穩定化，不等於承諾底層永不輪詢。

### 6.2 補充：產品內的週期讀取，不在 core-agent idle pump 上

| 位置與證據 | 週期／條件 | 讀取對象 |
| --- | --- | --- |
| `packages/coding-plans/src/codex-management.ts:305-311`、`packages/coding-plans/src/codex-management.ts:366-370` | device sign-in pending 時輪詢；server interval 至少 1000ms，無有效值時 5000ms（test seam 可覆寫） | `/token` 回 403/404 後 delay 再查；直到取消／到期，不是只有一顆 expiry timer |
| `packages/desktop/src/renderer/browser/BrowserPane.tsx:47-62` | 每次讀取完成後延遲 500ms；mounted / unlocked | `browser/list` |
| `packages/desktop/src/renderer/session/SlashCommands.tsx:56-72` | active 時每次 refresh 後延遲 500ms | resource suggestions |
| `packages/desktop/src/renderer/session/execution-surface.ts:23-27` | `poll && active` 才啟動 1500ms interval | 呼叫者提供的 surface read |
| `packages/desktop/src/renderer/settings/CodingPlans.tsx:48-61` | active 且無 busy action；pending 1500ms、已連接帳號 60000ms | coding-plans state |

UI 時鐘也有 interval，但不讀外部狀態：`RuntimeFeedback` 的倒數／quiet 顯示 250ms（`packages/desktop/src/renderer/session/RuntimeFeedback.tsx:124-129`）；coding-plan reset 倒數 30000ms（`packages/desktop/src/renderer/settings/CodingPlans.tsx:110-115`）。它們不是 admission wake。

### 6.3 有條件的等待／重試：不能宣稱「都不在 turn 路徑」

| 位置與證據 | 等待／重試節奏 | 範圍 |
| --- | --- | --- |
| `packages/core-tools/src/observation.ts`，`waitForObservation` | owner event subscription；若有期限，最多一個 active deadline timer | subagent job／task／AgentTable、exec／workflow job observers；原 10／20ms sleep loops 已移除 |
| `packages/subagent/src/tools.ts`、`packages/workflow/src/tool.ts` | owner subscribe + pending human steer；workflow run 沒有新增 observer deadline | 工具仍位於 turn 路徑，事件釋放等待，不重啟 owner |
| `packages/code-mode/src/runtime.ts` | observer subscription + 有限 deadline；worker init／CPU watchdog 仍有 timer | outer cell observation，required output retention 與 owner drain 仍須完成 |
| `packages/fs-lock/src/win32.ts:179-222`、`packages/fs-lock/src/linux.ts:158-184` | `retryMs` 指數 backoff 至 `retryMaxMs`，有 deadline | 爭用的 OS lease 重試，不是常駐 file watcher |
| `packages/sandbox-windows-acl/src/spawn.ts:193-210` | 1ms | PeekNamedPipe / ReadFile drain 的背壓等待 |
| `packages/context-output/src/store.ts:22-27` | 5ms，有限次數 | Windows rename 被 EPERM / EBUSY / EACCES 拒絕時重試 |

另有 host 的 **Goal 自動續行節奏**：檢查 active goal、await 一個 service turn、再延遲 250ms 繼續（`packages/desktop-gateway/src/workflow.ts:84-99`）。這是宿主明確地再次 submit，不是 core-agent 在 idle 狀態按時 re-pump。

反例：`ContextUsage` 的 timer 是 dirty/event-triggered 的節流刷新，只有 dirty 才補排 read，不是固定 interval poll（`packages/desktop/src/renderer/session/ContextUsage.tsx:126-153`）；reasoning flush 見 §2。deadline、批次寫入、重試 backoff 不能僅憑出現 `setTimeout` 就全歸為週期 watcher。以上是本次查核出的相關位置，**不是對依賴內部／未來新增輪詢的封閉清單，也未實測每個 observer 的交付延遲**。

## 7. 判決、收益與不保證的事

**判決 `[讀碼／已核對]`：I-harness 是「log-driven agent loop + push wake + waterfall / around hooks + event notification observers」，不是以中央 event-bus EDA 決定 turn / step 控制流。** 明確的 promise chain、`for (;;)`、`while (needsContinuation)` 是執行控制；session log 是模型與 inbox 投影的權威；通知供消費端觀察，不替代 log。

**收益 `[由上述實作推得，不是 crash / latency 實測]`：** 已保存的 log 可還原 Session，再重建 messages / pending（JSONL 轉換在 `packages/core-session/src/index.ts:953-976`）；push 不必等一個 wake polling tick，故稱「零輪詢喚醒延遲」。**不保證** event loop 無延遲、provider 立即回應或 literal 0ms。crash recoverability 只涵蓋成功保存、可讀取的 log prefix，**不等於**未 flush 訊息不丟、工具外部副作用 exactly-once，或崩潰中途的 provider 呼叫可原地續傳；write-behind 確有 queued work 與明確 flush barrier（`packages/session-persistence/src/write-behind.ts:40-63`）。

**成本／消費方義務：** 新訂閱者看不到歷史，transient chunks 更不可重播；要歷史就讀 log / `session/history`。失敗 pump 的 pending 可能需要後續 drive，不可把「idle」當作「inbox empty」。單 session 序列依賴 one-executor-per-session 接線；本文沒有承諾跨程序鎖、全域公平排程、每個 observer 無損、所有 host 無輪詢或每種平台上的即時文件通知。

## 8. 重驗方式與證據範圍

**2026-10-13 event-driven 整合 `[實測]`：** real assembly + controlled ModelClient／QuickJS worker／本機 held process 證明 steer 出現在下一次 provider request 時，原 producer 仍 held；parent turn 自然結束後，下一個 turn 用同一 ID 取回結果。前景 shell 分別實跑本機 Bash、PowerShell 與 selected shell。`event-driven-steering.test.ts`、`shell-promotion.test.ts` 證明一個 execution／同一 identity／一個原 call result；`execute-tool-calls.test.ts` 明確等到 eligible observer 已返回再檢查 arbitrary sibling 仍 bounds batch；`input.test.ts` 走真正 Desktop admission／service Session；`session-subagents.test.ts` 走真正 child producer，未 flush 的結果已可從 lineage-validated history 讀取。這些是來源整合證據，不是所有平台、真 provider、crash／restart 或打包版驗收。

重跑時，各 native suite **依序**執行，保留 `--maxWorkers=2 --minWorkers=1`：

```sh
pnpm --filter @i-harness/session-executor exec vitest run test/event-driven-steering.test.ts test/shell-promotion.test.ts test/code-mode-children.test.ts test/code-mode.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-agent exec vitest run test/executor.test.ts test/execute-tool-calls.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/desktop-gateway exec vitest run test/input.test.ts test/session-subagents.test.ts --maxWorkers=2 --minWorkers=1
```

下列原有數字與 AST／行號核對是先前外部審計修訂的歷史證據；不代表此輪 integration、Desktop 或 frozen-head aggregate 的結果。

- `nl -ba <file>` 核對上述 file:line；settings origin 用 `git show 5741a849f36ea2a56822147b516f649afe530b87:packages/settings/src/index.ts | nl -ba`，**不要**把基線行號套到施工中的工作樹。
- source search 可用 `find packages/*/src apps/cli/src -type f \( -name '*.ts' -o -name '*.tsx' \) -exec grep -nHE 'setInterval|setTimeout|node:timers/promises' {} +`。零命中只對明示範圍／pattern 有效；本文件的 polling 判斷還閱讀了 timeout callback / delay loop，不把 grep 次數當成語意證明。
- **`[實測]` scoped regression gates（本次 comment-only 修訂後）**：`pnpm --filter @i-harness/subagent test --maxWorkers=2 --minWorkers=1` → **16 files / 217 tests passed**；`pnpm --filter @i-harness/core-agent test --maxWorkers=2 --minWorkers=1` → **23 files / 183 tests passed**；`pnpm --filter @i-harness/subagent typecheck` → **exit 0**。它們不是 Desktop、live provider、每個輪詢點或跨平台 crash recovery 的驗收替身。
- **`[實測／靜態檢查]`** 此文件 **77 個 file:line 引用（75 個唯一範圍）**逐一核對；另以讀檔檢查行號存在且非空（settings origin 讀固定基線），以 TypeScript 去註解 printer 比較兩個准許編輯的 source 與 HEAD 的 AST 輸出一致。這證明本次 source 修改只有註解，**不是**對上述所有行為新增執行測試。
