# IH 設計偏離與潛在問題審計（2026-11-04）

對照 `D:\ih_reference_project` 的 Codex（`codex-rust-v0.166.0`）、opencode（`opencode-2.1.4`），以及本輪實際重現的故障。**只列設計層或新發現的問題**；程式級 bug 清單見 `docs/handoff/2026-11-04-audit-fixes/I-harness-audit-v0.1.13.md`（F 系列）。

嚴重度：**C** = 會讓功能不可用或資料錯亂；**H** = 常見情境下不穩定；**M** = 可維護性／可診斷性；**L** = 體驗或一致性。

---

## D-01 同一個子代理任務有三份事實來源（C）

- **現況**：父 journal 的 `subagent/start`／`subagent/end`、父會話的 `task-<parent>.doc.jsonl`（v3）、child session（header `parentSession`/`origin`）各自記錄同一件事。
- **證據**：`packages/subagent/src/task/registry.ts:76`、`persistence.ts`；child header 由 session-executor 寫入。
- **參考**：Codex 只有 child thread + rollout，父 thread 收到一筆 SubAgentActivity 通知（`core/src/agent/control/completion.rs`）；opencode 只有 child session（`session.parent_id`）+ job record（`core/src/job.ts`）+ 父會話的 completion 訊息（`session/subagent-completion.ts`）。
- **問題**：三份狀態必須在 spawn 時同步；任一寫入失敗就破壞一致性，且恢復語義各自不同。
- **方向**：child session + job record 作唯一來源；父只 append。

## D-02 父會話的可變 task document 參與 spawn 交易（C）

- **現況**：每次 task 狀態變化都重寫整份 document，走父會話的 owned-write／單寫入者契約。
- **證據**：`TaskPersistence.save()`；`putDocument` 序列化；失敗留 debt（`execution-state.ts` 的 `pendingWrite`/`debt`）。
- **參考**：沒有任何參考實作在 spawn 交易中改寫父層 registry document。
- **問題**：並行 spawn 直接互撞；第一次失敗後 debt 永久卡住，連序列 spawn 都失敗（實測 5 次全敗）。
- **方向**：document 改 write-behind projection，或直接廢除。

## D-03 child 繼承父的 context-bound 工具（C）

- **現況**：`resolveRoleTools` 把父 registry 的 tool 物件直接註冊到 child（`packages/subagent/src/child/role-tools.ts`）；shell 的 direct entry 綁父 plugin context（`session-executor/src/scoped-exec.ts` 的 `directContexts`）。
- **結果**：child 的 `bash`/`shell`/`pwsh` 一律 `Original scoped Exec context unavailable`；`code_exec` 是 `GENERATION_STALE`；read/write 正常。
- **參考**：Codex 每個 thread 有自己的 config/session/sandbox；opencode 每個 session 有自己的服務實例。
- **方向**：per-child exec context（`assembleChild` 依 child session 建 scoped exec），或明確限制 child 無 shell 並在 UI 說明。

## D-04 owned 與 host 兩套審批權限語義（H）

- **現況**：host assembly 的 `attach()` 有 child-caller 表；managed 的 `attachOwned()` 沒有，child 呼叫一律被 `prepared approval authority or policy changed before dispatch` 拒絕。本輪用「registry/tool binding」fallback 修復（`approval-rules.ts`）。
- **參考**：權限快照屬於呼叫者所在 session；不存在 host/owned 兩套。
- **問題**：fallback 是補丁；真正的 child 身分驗證（child 屬於此 parent）在 owned 路徑仍缺。
- **方向**：把 child-caller 表帶進 owned owner，統一兩條路徑。

## D-05 審批 policy identity 雜湊了活的工具表面（H）

- **現況**：`approval-policy-identity.ts` 把 `catalog`、`deferred`、`modelTools`、`mcp`、`agents` 一起雜湊；任何工具註冊／延遲索引變化都會讓 in-flight 審批失效。
- **證據**：`approvalPolicyIdentityFromSources`；本輪 dispatch 被拒的錯誤訊息即來自這個比對。
- **參考**：審批決策綁定「policy 輸入」（sandbox、approval mode、規則、hooks），不綁工具目錄。
- **方向**：identity 只雜湊 policy 輸入；工具面變動不應使已準備的呼叫失效。

## D-06 RPC 錯誤沒有 machine code（H）

- **現況**：SDK error frame 只有 message；desktop 只能比對字串（本輪新增 `isRecoveryFailure` 就是字串比對）。
- **證據**：`sdk/src/server.ts` 的 `makeFailure`；`desktop/src/main/session-recovery.ts`。
- **參考**：Codex/opencode 都是 typed error／status。
- **問題**：訊息一改，恢復邏輯就失效；也無法區分「可重試」與「不可重試」。
- **方向**：failure frame 加 `data: { code, retryable }`，desktop 用 code。

## D-07 fail-closed 的 recovery 狀態不持久（H）

- **現況**：`FACT_RECOVERY_REQUIRED` 來自記憶體的 `pendingWrite`/`debt`；重啟或 reload 就消失，但 durable journal 沒有對應的 reconciliation 記錄。
- **證據**：`core-session/src/managed/execution-state.ts`；本輪驗證 store 可正常載入（322 events）。
- **參考**：opencode 的 job recovery 是 durable（job table）；Codex 從 rollout 恢復。
- **問題**：宣告 fail-closed，實務上靠「重啟清狀態」——恢復動作與安全語義不一致。
- **方向**：把未解決的寫入意圖持久化，並提供明確 reconcile 流程（或把 debt 降級為 job-level error）。

## D-08 單一輔助文件的寫入失敗會封鎖整個 session（H）

- **現況**：task document 的 debt 會讓父會話拒絕所有新工作。
- **參考**：失敗是 per-job／per-record，不影響其他工作。
- **方向**：失敗隔離在 job；父會話只 append。

## D-09 task document 沒有共用 schema／codec 契約（M）

- **現況**：writer（v1/v2/v3）與 reader（desktop catalog）各自手寫版本判斷；catalog 落後 v3 造成整片「不可用」（本輪已修）。
- **參考**：opencode 用 schema.gen.ts + migration；Codex 用 serde + versioned rollout。
- **方向**：共用 codec／schema 套件，reader/writer 同源。

## D-10 gateway stderr 被丟棄（M）

- **現況**：`drainChildStream()` 只 `resume()`，gateway 崩潰／recovery 沒有 stack。
- **證據**：`desktop/src/main/sdk-runtime.ts`。
- **方向**：寫入 runtime diagnostics（至少 error 級）。

## D-11 UI 事件投影沒有型別白名單（M，已修）

- **現況**：任何未處理的 journal event 都變成 timeline row，fallback「會話狀態已更新」。
- **證據**：`renderer/session/project.ts`（本輪改白名單）。
- **方向**：事件投影應是 typed、allowlist，未知事件不渲染。

## D-12 測試基礎無法回歸這類 bug（H）

- **現況**：317 個測試依賴外部 evidence fixtures；290 個 fixture 仍用 legacy coordinator（`TASK_TRANSITION_UNSUPPORTED`）。本輪所有恢復／並行修復都只能用手動或單檔測試驗證。
- **方向**：自足 fixture（composed coordinator）遷移、CI 可跑；否則並行 spawn／recovery 永遠沒有回歸保護。

## D-13 原生資產不可從源碼重建（M）

- **現況**：`sandbox-windows-acl/native/build-bridge.ps1` 綁私有 MSVC 路徑與輸出授權；打包需要從官方 release 取 5 個檔案。
- **參考**：Codex/opencode 的 CI 從源碼建置。
- **方向**：CI 可重建的 native build（釘版本工具鏈），或把已驗證的二進位納入 release 流程。

## D-14 恢復入口不一致（M，已緩解）

- **現況**：只有工作狀態提示有「重新載入會話」；其他 RPC 直接顯示紅字。本輪在 main process 加自動重載。
- **方向**：統一的 error contract（D-06）＋單一恢復 UI。

## D-15 並行上限存在，但與寫入競態脫節（M）

- **現況**：subagent 有 `maxConcurrency`（`subagent/src/index.ts:121-124`，超過以 `TaskConcurrencyLimitError` fail-closed）與 `maxDepth`；但允許的並行 spawn 仍會同時改父 task document，上限只限制「同時幾個」，不限制「誰先寫」。
- **參考**：Codex 的 max threads 由 registry 統一配額；opencode 用 job queue 排隊。
- **方向**：admission registry 同時做配額與 idempotency（callEventSeq）；child 執行仍可並行。

## D-16 排程觸發模型受限（L）

- **現況**：非 managed 會話只在下一次互動時處理到期提醒（先前審計已記錄）。
- **方向**：明確 UI 說明，或獨立 timer 服務。

---

## 決策與順序（子代理）

採 **方案 A（漸進）**：

1. **Job store + 拆出 task document 交易**：spawn 只寫 child session + job record + `subagent/start`；task document 改 write-behind projection。並行 spawn 不再互撞。
2. **Per-child exec context**：child 自己的 shell/exec，不再複製父工具物件。
3. **Catalog 改讀 projection**（含 legacy v1–v3）。
4. **D-05／D-06**：審批 identity 只雜湊 policy 輸入；RPC error 帶 code。
5. 測試基礎（D-12）與 native build（D-13）另行排程。

每一步都以「3 並行 + 2 序列 spawn 全成功、單一失敗不影響其他、child 可執行 shell」為驗收。
