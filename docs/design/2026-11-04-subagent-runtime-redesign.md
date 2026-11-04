# 子代理執行模型重設計（2026-11-04）

> 決策（2026-11-04）：採 **方案 A（漸進）**。理由：child session 已是 durable，job store 與 write-behind projection 能在不破壞 legacy 讀取的前提下拆掉 spawn 交易；方案 B 的 migration（cold recovery／fork／v1–v3）風險過高，等 A 穩定後再評估。

> 觸發事件：同一個 session 內 3 個並行 + 2 個序列 `spawn_agent` 全數失敗（`Original writer dependency cleanup unresolved`、`Original issued write needs reconciliation`、`Earlier owned task save requires resolution`），且失敗會累積、越試越糟。這不是權限或 prompt 問題，是資料模型問題。

## 1. IH 目前的做法（問題所在）

- 父會話有一份**可變的 task registry document**：`task-<parentSessionId>.doc.jsonl`（formatVersion 3），由 `TaskPersistence` 在每次 task 狀態變化時重寫（`packages/subagent/src/task/registry.ts:76`、`startup-facade.ts:27`）。
- 同一份狀態又會以 append-only facts 寫進父會話 journal（`subagent/start`、`subagent/end`）。
- 這份 document 的寫入走父會話的 **owned-write / managed execution** 契約：一次只允許一個未完成的寫入，失敗就留下 debt，整個 session 進入 `FACT_RECOVERY_REQUIRED`。
- 子代理工具是**直接複製父 registry 的 tool 物件**（`packages/subagent/src/child/role-tools.ts`）。shell 的 direct entry 綁在父 assembly 的 plugin context（`packages/session-executor/src/scoped-exec.ts` 的 `directContexts`），child 執行時 context 不符 → `Original scoped Exec context unavailable`；`code_exec` 同理（`GENERATION_STALE`）。

**結果**：並行 spawn 在父會話的同一份 document/execution 上互撞；第一個失敗就把父會話的 persistence 卡死，後面連序列 spawn 都失敗。child 也沒有自己的執行環境。

## 2. 參考實作怎麼做

### Codex（`codex-rust-v0.166.0/codex-rs`）

- 子代理是**獨立 thread**：`SessionSource::SubAgent(ThreadSpawn { parent_thread_id, depth })`（`core/src/agent/control.rs`）。
- 每個 thread 有自己的 session/config/rollout store；child 的模型與角色由 `child_config.rs` 決定。
- 父 thread 只收到一筆 **SubAgentActivity 通知**（`core/src/agent/control/completion.rs` 的 `notify_parent_of_terminal_turn`），沒有「父 task registry document」。
- 並行度由 thread registry 的 guard（max threads）控制，不是靠父資料交易。

### opencode（`opencode-2.1.4/packages/core`）

- 子代理是**獨立 session**：`session.parent_id`；`session.ts` 建 child session。
- 背景工作有獨立的 **job 記錄**（`src/job.ts` 的 `Background`/`Recovery`，`kind: "subagent"`），由 `SubagentJob` 管理與恢復。
- 完成時把一筆 `<subagent sessionID=… state=…>` 訊息寫進**父會話**（`session/subagent-completion.ts`），父會話只 append。
- 深度限制在工具層檢查（`tool/plugin/subagent.ts`）。

共同點：**child 狀態的事實來源在 child 自己（thread/session/job）**；父會話只 append 少量事件；沒有任何「父會話的可變 registry document」參與 spawn 交易。

## 3. 重設計原則

1. 每個 child 的唯一事實來源 = child session（已存在、可冷讀）+ child job record。
2. 父會話只 append：spawn 記錄與完成通知（沿用現有 `subagent/start`／`subagent/end`）。
3. 父層 task 列表是 **projection**，可從 child session headers（`parentSession`、`origin: subagent`）+ parent journal 重建；document 只能是 write-behind cache，**不得在 spawn 的同步路徑上**。
4. 每個 child 建立自己的 execution/tool context（workspace policy + child session identity），不繼承父的 context-bound tool。
5. 任何 child 的失敗只標記該 job 失敗；不得把父會話推進 `FACT_RECOVERY_REQUIRED`。

## 4. 方案 A（建議，可漸進）

**目標**：把「父 document 交易」從 spawn 路徑移除，讓並行 spawn 天生安全；child 有真正自己的執行環境。

1. **Job store**：新增 `subagent/job-store`（append-only，key = child session id），記錄 task 的 role/description/model/狀態/結果；可存成 child session 的附屬 document 或獨立 JSONL。spawn 只寫這個 store + 父 journal 的 `subagent/start`。
2. **移除 spawn 路徑的 `TaskPersistence.save()`**：`TaskPersistence` 改為 write-behind projection（背景/下一次讀取時才寫），或直接由 job-store 產生 `task-<parent>.doc.jsonl` 供舊 UI 讀。
3. **Admission**：spawn 註冊只有一個短交易（job-store + `subagent/start`），並行 spawn 互不阻塞；child 執行完全並行。
4. **Child exec context**：`assembleChild` 依 child session 建 shell/exec 的 scoped context（新的 child exec attachment），role tools 不再直接複製父 shell tool；若 host 未提供 child exec，明確回報「此角色不支援 shell」，而不是 context 錯誤。
5. **Recovery**：job-store 寫入失敗 = job error；父會話的 managed execution 不參與。

**改動面**：`subagent/src/task/{persistence,registry,startup-facade}.ts`、`subagent/src/child/{assembly,role-tools}.ts`、`session-executor` 的 child assembly 建立路徑、`desktop-gateway/src/subagents/catalog.ts`（改讀 projection/job store）。

## 5. 方案 B（完整對齊參考架構）

- 廢除 `task-<parent>.doc.jsonl`：catalog/UI 直接從 coordinator sessions（parentSession）+ parent journal 的 subagent events 建 projection。
- 刪除 `TaskPersistence` 的 owned-write 路徑與 v3 文件格式。
- 需要处理 cold recovery、fork/rewind、legacy v1/v2 文件的 migration，以及 desktop catalog 的資料來源切換，工程量與風險最大。

## 6. 建議順序

1. 方案 A 的第 1–3 步（job store + 拆出 task document 交易）→ 先讓並行 spawn 穩定。
2. 第 4 步（child exec context）→ 讓子代理真的能跑命令。
3. 第 5 步（catalog 改 projection）。
4. 穩定後再評估方案 B（移除 document）。

## 7. 驗收標準

- 同一會話 **3 個並行 + 2 個序列 spawn 全部成功**；其中一個失敗不影響其他。
- 失敗 spawn 之後，同一個 session 不需重啟/重載即可再 spawn。
- child 可執行 `bash`/`pwsh`（在支援的平台）與 `code_exec`。
- 右側子代理面板從 projection 顯示任務（含 v3 與 legacy）。
- 回歸測試：並行 spawn、失敗隔離、child exec、catalog v1/v2/v3。

## 8. 風險

- 並行 spawn 的順序與重複：以 `callEventSeq` 做 idempotency key。
- Cold recovery：目前 `subagent/start`/`subagent/end` 只帶部分資訊，job store 要補齊 role/model/result。
- fork/rewind 與 projection 的一致性。
- 過渡期雙寫（document + job store）可能有短暫不一致，catalog 需容忍。
