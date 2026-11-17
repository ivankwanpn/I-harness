# I-harness 測試修復與重寫：最終報告（進行中）

## 2026-11-16 接手審查註記

原始全庫日誌確認 `cf92d076` 的 215 項失敗。舊清單 `verify-final2-file-failures.json` 共 94 列、failed 加總 184；**P0-A 已完成對帳**：31 項差額全部來自 31 個 file-summary 使用單數 `(1 test | 1 failed)` 而被舊解析規則（要求複數 `tests`）漏掉。對帳後清單為 215 項／125 檔，另列 5 筆 hook/cleanup 同名額外條目與 7 筆 unhandled errors（獨立通道）。skipped 104 項亦已逐項完成原因分類（0 unresolved），並核對舊基線 86 項之差異（+18，含 predecessor fixture 與 pwsh PATH 的執行環境差異）。詳見「P0-A 對帳」章節與證據目錄 `p0a-report.md`。下文的逐檔清單及掛起、WIP、flake 分類仍以原始失敗與正常入口進一步核實；兩個不同 HEAD 的全庫結果差異仍需配對證據才能完成根因判定。

下一輪先完成失敗清單對帳與 target pins 的部分失敗／重試驗證，再處理掛起、持久化恢復及公開 JSONL selected-results 整合。[下一階段修復決策](D:/codex-ih-development/docs/design/2026-11-16-stability-next-stage.md)

本報告依 `docs/design/2026-11-15-test-rewrite-handoff.md` 的交接要求整理。最終全庫驗證結果於文末「固定版本全庫驗證」章節填入。

## 一、範圍與起點

- 分支：`codex/runtime-stability-redesign`（交接起點 `20e30ad0`）。
- 基線 inventory（`21f8d861` 固定版本全庫驗證）：16,001 passed、434 failed、86 skipped、9 unhandled；失敗分布以 session-executor（264）、desktop-gateway（112）、context-output（60）為主。
- 交接第一批指定的三個 selected-results 測試已完成重寫並全綠（10 項）：`host-commit-log-selected-fork`、`host-commit-log-selected-read`、`selected-fork-seed`；另以 `7a15e67b` 補上 target pins，child 在 source archive 後仍能讀取。

## 二、已完成的批次

| 批次 | 檔案（executor 為主） | 結果 | 提交 |
|---|---|---|---|
| selected-results | host-commit-log-selected-fork／selected-read／selected-fork-seed | 10/10 | `7a15e67b`、`b7f67b8d` |
| gateway 第一批 | selected-results host fixture（真實工具回合與 V2 負向控制） | 37/37 迴歸 | `40395f70`、`b660dee6` |
| managed document | archive ownership 修正、`hasManagedDocument` 共用 | session-persistence 1249/1249 | `b298a960` |
| prepared writer | prepared-session-writer 清理契約 | 9/9 | `1ec2a6ae` |
| session-management | 兩個 gateway fork 案量測 5.1/6.1 秒 → 30 秒 | 27/27 | `554ad012` |
| retained-mcp-result | host MCP call 後以明確 yield 視窗觀察完成；量測 6.2–10.9 秒案例給 30 秒 | 10/10 | `7c40234a` |
| notification-stop-owner | 全部改走 `wrapOwnedBatch`／`wrap` 建構縫隙（原 patch 造成 3 案 120 秒掛起） | 9/9 | `6ebae59b` |
| delivery-receiver | 宣告注入故障的 recovery 診斷；pre-claim 排程改以事件與 queue 邊緣觀測 | 17/17 | `604c1e89`、`c5e35a76` |
| managed-input-readiness | 以 queue row 為等待邊緣，取代失效的 readiness mock | 8/8 | `3df83fe9` |
| result-ordering | 非擁有者探測改用 read-only coordinator | 16/16 | `df1bcc88` |
| physical-recovery-trace | cap20／cap9 量測 6.7 秒 → 30 秒 | 3/3 | `fb135850` |
| instruction initial/fresh | 清理順序改為現行 `lease, lease, scope` 等審計值 | 5/5、4/4、3/3 | `b90f6261`、`5f19c4d0` |
| result-store-close | native close fault 改在 open-time handle seam 注入；對齊保留失敗契約 | 5/5 | `2f16faad` |
| seam 批次 | nested-broker-retention、managed-context-output、retention-grants、instruction-unstarted-recovery、main-instruction-publication | 15/15 | `d0fe0871`、`3dc14af2` |
| observation seam | code-output-owner-lifetime、code-observation-owner-bridge | 3/3 | `2b431ab2` |
| 其他 | managed-ticket-close（量測 3.3 秒）、default-parent-writer（保留 coordinator 身分）、main-instruction-construction（run-end seam，剩 1 案） | 1/1、1/1、9/10 | `ed5e5eac`、`cfa87827`、`73293e2b` |

合計：**26 個檔案全綠、145 項通過**（另有 `main-instruction-construction` 9/10 與 `service-instruction-close` 1/2 的部分修復）。所有期限調整均在檔內記錄原量測與新值；未以期限掩蓋掛起。

## 三、共同缺陷類別（交接文件所列）

1. **建構後替換被身分保護的方法**：backend batch／managed document／coordinator 方法在建構後被替換，canonical-path guard 或 WeakMap 身分使替換失效（表現為 `PROCESS_READ_UNAVAILABLE`、計數全零、held resolver 永不釋放）。修正一律改走 `createJsonlBackend(root,{wrapOwnedBatch,wrapOwnedReconcile,wrap})`、open-time `node:fs/promises` seam 或保留原 coordinator 身分。
2. **最終期限與真實工作不符**：physical-recovery、managed-ticket-close、retained-mcp、session-management 等以實測值重新設定上限（30 秒），並在檔內記錄量測。
3. **過時 oracle**：readiness 訂閱、cleanup 順序、error 形狀、session/error telemetry 等改以現行可觀測邊緣（queue row、committed events、fd 狀態）驗證。
4. **注入位置未達真實路徑**：spy 打在與產品不同的模組實例／handle 上；改為建構縫隙後故障才真正到達 journal 或 native I/O。

## 四、仍待處理（可接續證據）

### 真實掛起（非期限）

- `execution-fs-ack`：單案在 120 秒後仍掛起。
- `resident-instruction-activation`：單案在 120 秒後仍掛起。
- `fork-handoff`：首案超過自身 15 秒預算。
- `instruction-diagnostics`：一個 60 秒逾時案例（基線未失敗）。

### 產品契約待核對

- `managed-runtime-context`：未知 publication 被分類為 `FACT_PRECONDITION_STALE` 而非 `FACT_RECOVERY_REQUIRED`（source guard 吞掉 domain recovery 失敗）。
- `title-action`：post-turn callback 持有 action 時提交第二輪，`settleFinishedActions` 拋 `Managed facts require reconciliation`。
- `main-instruction-targets`：257 目錄讀取案例在真實 turn 中被 abort。
- `managed-instruction-handoff`：首次 instruction publish 的 guard 取得「Original issued write needs reconciliation」。
- `service-instruction-close`：cold reader 在 held native cleanup 下仍讀到結果而非 `unavailable`。
- `delivery-lifecycle`：fault-path fixture close 回報 `Delivery fixture cleanup failed`。
- `instruction-isolated-review`：approval close append 早於測試取得 actionId，注入時序未解。
- `main-instruction-construction`：`openCliInput` mock 在現行 headless mount-fault 路徑不再被呼叫。

### 第二輪全庫驗證後的接續修復（head 之後）

- `chat-stream-terminal-error`：capacity retry waiting fact 需約 1.5 秒才可觀察，改以 5 秒上限等待；**11/11 通過**（`2b5cd052`）。此檔在第二次全庫驗證時列 1 失敗。
- `observed-settings`：`loadObserved` 對同一檔案讀取兩次（存在性探測＋observed bytes），改為斷言所有讀取都指向同一 settings 路徑；**6/6 通過**（`8d3f9fdd`）。
- 其餘 215 項失敗的逐檔清單見 `verify-final2-file-failures.json`；每個檔案的最後 triage 記錄於接續狀態與 `docs/design/2026-11-10-runtime-stability-redesign.md` 第二十四批。
### WIP 產品能力（測試先於實作）

- owned/native Task host：`project-context`、`event-driven-steering`、`native-context-child`、`retained-child-scope`、`retained-batch-continuation`、`native-dependency-observer`、`guardian-generation`（部分）等卡在 `Original prepared task caller unavailable`、native execution 未接、child session identity 或 agentTable 空。
- `session-persistence`／`context-output` 其餘 failures 屬同類（見最終驗證 inventory）。

### issue 125：公開 JSONL selected-results 入口

- 現況補正。`host.ts` 僅在 commit-log store 安裝 `createSelectedForkController`。JSONL 已有專用 `public-results-v1` kernel，現有 native helper 使用 `createSelectedSourceHolder`、`captureFirst`、`publishWarm`，冷恢復使用 `inspectColdSelectedTarget` 與 `beginColdSelectedFinalization`。
- 實作方向更新。公開 JSONL selected-results controller 沿用上述 public route 與原始持有者，整合 V2 DTO、選取範圍、同 operation 重試、取消、關閉及 cold qualification。private Task child birth 的 request／admission 契約另有用途。完整 C67 正向順序及 commit-log 相容性由正常 Gateway／SDK 入口驗證，細節見 2026-11-16 決策文件。
- 狀態：尚未實作。

## P0-A 失敗清單與 skipped 對帳（2026-11-16，head `cf92d076`）

依 `2026-11-16-stability-next-stage.md` 完成；原清單保留為 `verify-final2-file-failures.old.json`。

### 失敗清單

| 口徑 | 數量 |
| --- | ---: |
| Runner `Tests ... failed` 加總（82/82 packages） | **215** |
| 舊清單 94 列 failed 加總 | 184 |
| 對帳後逐案例清單（125 檔） | **215** |
| 原始 FAIL 標頭列數 | 220 = 215 + 5 筆同名 hook/cleanup 條目 |
| Unhandled errors（獨立通道） | 7（全在 session-executor） |

31 項差額**單一原因**：31 個 file-summary 使用單數 `(1 test | 1 failed)`，舊解析要求複數 `tests` 而整檔漏計；apps/cli 1、context-output 1、desktop 1、desktop-gateway 13、guard-approval 1、session-executor 14。逐檔漏計清單與原始日誌行號見證據目錄 `p0a-gap-attribution.json`／`p0a-report.md`。

計數口徑：`Tests X failed` 只計 test result；5 筆額外 `FAIL` 是 hook/afterEach cleanup 對同一失敗案例的重複條目（review、sandbox.e2e 各 1 筆 EBUSY；managed-instruction-handoff 3 筆 cleanup）；7 筆 `Unhandled Errors` 為獨立通道。三者皆使 suite exit 1。

### skipped

104 項分佈 37 檔（整檔跳過 19 檔／72 項、部分跳過 18 檔／32 項）；以 JSON reporter 對 33 檔實跑取得 100 個精確案例名，4 個重檔以日誌 item-level 詳情或原始碼條件補足，**0 unresolved**。

| 原因分類 | 數量 | 例子 |
| --- | ---: | --- |
| 環境資格 opt-in（`IH_*` gate） | 23 | ACL 系列、WSL exit、legacy outer、conpty resize、fork electron |
| Git Bash shim 不在審核 manifest | 22 | msys-pty-resolution（實測 SHA-256 不在 audited set） |
| 缺 predecessor fixtures | 20 | task-transition-original13 9、entries 3、selected-cold 3、retry 3、其他 2 |
| 缺工具／發行版 | 14 | 無 playwright 6、無 jq 1、無 Node-可辨識 pwsh 1、無 WSL distribution 6 |
| Windows symlink 權限（EPERM） | 13 | context-output legacy/integrity、instructions applicable-proof |
| 平台限制 | 12 | fs-lock linux-only 5、posix-execution 2、credentials POSIX mode 1、M16 bwrap 1、bwrap.e2e 3 |

舊基線 86 → 104（+18，10 檔）：其中 +20 是 `IH_TASK_D_PREDECESSOR_FIXTURES` 執行環境差異（基線該檔 9 項實際執行、本次未配置）、+1 是 pwsh App Execution Alias 在 Node `existsSync` 下不可見（環境漂移），-3 是條件不再成立。逐項原因、condition、原始碼行號與日誌位置在 `p0a-skip-items.json`。

證據：`p0a-failure-list.json`、`p0a-reconciliation.json`、`p0a-gap-attribution.json`、`p0a-skip-items.json`、`p0a-skip-delta-attribution.json`、`p0a-report.md`（`C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/`）。
## P0-B target pins 的失敗與重試契約（2026-11-16）

審查 `7a15e67b` 與三個第一輪 selected-results 測試後，於 `packages/desktop-gateway/src/selected-fork.ts` 補齊 recovery 契約：

- 每個 operation 以 durable document 保存 first authorized capture、逐批 grant 進度與 acknowledged outcome；重試沿用首次捕獲，不再重新捕獲已變動的 source。
- 已確認操作重試先驗證 target profile 身分（parentSession/origin/createdAt/semanticSeed operationId/requestDigest），回 `kind:'adopted'` 與相同 receipt，不重複 capture/grant/seed write；target archive → `refused target-policy`，身分不符 → `refused conflict`。
- grant 分批（100 refs）成功後持久化 `granted`；中途失敗的 retry 從第一個未 grant 批次 resume，不重複已生效批次。
- `selection.atSeq` 真正傳入 `createCompletedPassiveContext`，completed boundary 會排除邊界後結果。
- 有 managed refs 但無 retention port 時回 `not-issued unsupported`，不建立 child；source project binding 在 prepare→begin 間變動時回 `not-issued policy`。

驗證：4 個 selected-results 檔案 **19/19 通過**（fork 2、read 3、recovery 7、seed 7），gateway typecheck 0。九項控制（grant 失敗、多批部分失敗、ACK 遺失、source 變更、重啟＋archive/clear、未完成操作 resume、project 漂移、缺 port、atSeq）逐項對照見證據目錄 `p0b-report.md`；仍待處理：grant 執行中關閉 host、grant 永久失敗的 blocked token、result-reader ancestor fallback 與大型選取文件成本。
## P1 掛起與持久化恢復（2026-11-16 進行中）

### 已修復

- `execution-fs-ack`：fixture 的 pause 點改為 `writeFileAtomic` 實際寫入的 hidden sibling temp（原本比對最終路徑永遠不觸發）；2/2 通過。
- `resident-instruction-activation`：`prior-result` 案改以 task-result-retention seam 持有原始回合的 result settlement，在 settle 中排入 followup 後撤銷；22/22 通過。

### 未修復但已定位

- `delivery-active-wait`：foreground handoff 被稍後的 notification save 阻擋（19.9s timeout）。
- `delivery-lifecycle`：body 成功復原後，close 仍 join 舊的 task-save EPERM cleanup debt（Subagent settlement requires recovery）。
- `managed-runtime-context`：admit 在 append 前以 FACT_PRECONDITION_STALE 拒絕（probe.appends=0）；guard/currentness 來源待查。
- `service-instruction-close`：cold reader cleanup 案仍讀到 page，而非 `{kind:'unavailable'}`。
- `title-action`：post-turn 期間 cancel 後，下一個 submit 於 settleFinishedActions 得到 FACT_RECOVERY_REQUIRED（pending frame 的 authorization action 不再 eligible）。
- `fork-handoff` 第一案：第一次 fork 成功；nested fork（source=child）在 header 已 issued 後卡在 `context-output` `confirmLegacyForkTransfer`，15 秒 timeout。屬 nested legacy L1 transfer 的產品級等待，尚未修；證據見該檔 triage 與 `p1-*.log`。
## 四之一、剩餘失敗的結構化清單（215 項／125 檔，head `cf92d076` 驗證；P0-A 對帳後）

| 類別 | 代表檔案／數量 | 判定 | 可接續位置 |
|---|---|---|---|
| 真實掛起（非期限） | execution-fs-ack、resident-instruction-activation、fork-handoff、main-instruction-targets、approval-rules、host-fixture-model、execution-source-prereq（各 1） | 長預算後仍不完成；不得以放寬期限掩蓋 | 各檔 triage 記錄於接續狀態與 redesign 文件 |
| 產品契約待核 | managed-runtime-context（未知 publication 分類）、title-action（post-turn 持有時第二輪提交）、delivery-active-wait（後續 notification save 阻擋 handoff）、delivery-lifecycle（fault-path cleanup）、service-instruction-close（cold reader 讀取契約）、r6-private-input-cutover（unsupported private context 被接受）、native-context-jobs（archive 拒絕原因） | 需產品層決定或修正，非 fixture 放寬 | 同上，含每次重現指令與 log |
| WIP owned/native Task 能力 | project-context、event-driven-steering、native-context-child、retained-child-scope、retained-batch-continuation、retained-code-output、wsl-assembly、instruction-views、native-dependency-observer、owned-* 系列等 | 卡在 `Original prepared task caller unavailable`、child session identity／agentTable、native execution 未接 | redesign 文件批次紀錄與 inventory |
| 既有環境／觀察點 | mixed-retention-quota（SQLite disk full，磁碟充足）、observed-settings（已修）、native-context-output（Exec 觀察點） | fixture/環境或觀察點需更新 | 各檔 triage |
| 併發 flake（全庫 `--maxWorkers=2`） | usage-protocol-aux-host、interaction-resume、current-unfinished-catalog、retention-grants、selected-native-source 等 | 單獨執行通過；兩次全庫結果差異即此類 | `verify-final*.log` 與單獨執行收據 |

- issue 125（公開 JSONL selected-results 入口）仍未實作；現況、kernel 證據與實作計畫見上文「## 四、仍待處理」。
- 上述失敗皆已保存逐檔清單（`verify-final2-file-failures.json`）、重現指令與日誌，可在固定 head 上接續。
## 五、提交與身分

- 提交作者／committer：`ivankwanpn <213307026+ivankwanpn@users.noreply.github.com>`。
- 所有提交已非強制推送至 `origin/codex/runtime-stability-redesign`；CI（`.github/workflows/verify.yml`）每個 head 的結果記錄於證據目錄 `ci-*.log`。
- 每批均通過對應套件 typecheck 與 `git diff --check`；boundary gate 於本輪全庫驗證中一併執行。

## 六、固定版本全庫驗證（2026-11-15，第二次即最終）

- 指令：`node scripts/test-env.mjs pnpm run verify:all`，最終 head **`cf92d076`**，日誌 `verify-all-final2.log`。
- **suite：16,220 passed｜104 skipped｜215 failed**（82/82 projects reported）。
- typecheck：**exit 0**（全部 workspace 專案）。
- e2e：**exit 0**，10 檔 127 項。
- reachability gate：**PASS**（374 rows，baseline 337，無新增）。
- package boundaries：**exit 0**（128 筆，與 baseline 一致）。
- compiled gateway + Windows ACL：**exit 0**（`IH_COMPILED_GATEWAY_OK`、`IH_COMPILED_ACL_OK`）。
- 與基線 `21f8d861` 比較：**failed 434 → 215（-219）**、passed 16,001 → 16,220（+219）；unhandled 9 → 0；skipped 86 → 104。
- 同 head 的 CI（`.github/workflows/verify.yml`）為 **success**（run `43705003360`）。
- 先前同指令驗證（head `e6dad10d`）：16,215 passed／105 skipped／219 failed；兩次皆為 82/82 專案報告，差距 4 項屬並發負載下的 flake（例如 `usage-protocol-aux-host`、`interaction-resume`、`current-unfinished-catalog` 單獨執行通過）。
- 第二次逐套件失敗數：session-executor 101、desktop-gateway 82、context-output 19、apps/cli 4、acp 2、guard-approval 2、session-persistence 2、desktop 1、sandbox-windows-psec 1、terminal 1。
- 逐檔清單：`verify-final2-file-failures.json`（94 個檔案列有失敗）。第一次驗證清單保留於 `verify-final-file-failures.json`。
- 判讀：`desktop-gateway` 兩次差異（74 → 82）主要為長時/掛起案例在 `--maxWorkers=2` 下的不穩定，不是新引進的失敗；`context-output` 28 → 19 為實際改善。

## 七、證據位置

- 接續狀態（每次批次更新）：`C:/Users/IvanKwan/AppData/Local/Temp/ih-runtime-stability-progress-latest.json`。
- 測試收據（JSON）與日誌：`C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/`。
- 設計／批次紀錄：`docs/design/2026-11-10-runtime-stability-redesign.md` 第十二至十九批。

## 八、P1 之後 executor 套件現況（2026-11-16，head `4f1391ab`）

- 指令：`node scripts/test-env.mjs pnpm --filter '@i-harness/session-executor' test --maxWorkers=1 --minWorkers=1 --testTimeout=120000 --reporter=json`（單一 worker，避免並發 flake）。
- 結果：**231 檔、1,405 項：1,359 passed／46 failed／0 skipped**；`session-executor` typecheck **exit 0**。
- 基線（`cf92d076` 最終全庫驗證的 executor 部分）：62 檔／101 failed → **25 檔／46 failed（-55 項）**，37 個原失敗檔已全綠。
- 本輪已修並留存的主要群組：Task prepared-spawn 正常入口（`spawnDurable`＋task child host＋composed coordinator）、runtime-context snapshot 新形狀、Code Mode async cell／`code_wait` 觀察、pre-bind backend fault seam、背景保留 approval、service/execution-state async admission、search 期限與 fixture 縮減、native-context-output 的 artifact-set 觀察等。
- 剩餘 46 項分佈（`p1-executor-full-fails.json`）：
  - 4：`retained-state-negative`；3：`managed-instruction-handoff`、`project-context`；2：`delivery-retry`、`event-driven-steering`、`execution-authority`、`instruction-isolated-review`、`inherited-context-budget`、`publication-pins`。
  - 1：`bounded-file-production`、`owned-code-service`、`owned-service-shell`、`retained-batch-continuation`、`retained-child-scope`、`retained-hook-recovery`、`retained-state-cold`、`service-instruction-close`、`owned-code-nested-shell`、`native-dependency-observer`、`managed-runtime`、`mixed-retention-native`、`title-action`、`managed-runtime-context`、`main-instruction-construction`、`instruction-diagnostics`、`generation-actions`、`fork-handoff`、`execution-source-prereq`、`exec-direct-source`、`delivery-lifecycle`、`delivery-active-wait`、`mixed-retention-quota`、`wsl-assembly`。
- 產品級待修（已以故障注入定位、非 fixture 放寬）：title action abort 後 settlement source 未 `closeRequested`（`settleFinishedActions` 見 2 required pending／0 eligible）；delivery falsey ack 的 close recovery 未在一次 `close()` 完成；publication-pins 首次 delete pin／access 的 `Original deletion recovery required`；isolated source 在 close recovery 後未 retire；child native job receipt owner 仍記為 parent session；mixed-retention revocation inventory recovery 與 SQLite logical-full。
- 證據：JSON `p1-executor-full.json`、失敗清單 `p1-executor-full-fails.json`、日誌 `p1-executor-full.log`（皆在 `C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/`）。

### 八之一、第二輪 executor 全套件實測（2026-11-16，head `0716eafe`）

- 指令同上（單一 worker）。結果：**231 檔、1,405 項：1,367 passed／38 failed／0 skipped**（第一輪 46 failed）。
- 本輪新增全綠：`execution-authority`、`main-instruction-construction`、`delivery-retry`、`owned-code-service`、`owned-code-nested-shell`、`retained-child-scope`、`wsl-assembly`、`retained-code-output`（全跑時因 async cell 回到 running，已補 `yield_time_ms:30000` 修正）。
- 仍存 38 項／26 檔；product 級主因：title settlement source ownership、delivery close/handoff recovery、publication-pins deletion recovery、retained coordinator cleanup。
- 證據：`p1-executor-full2.json`、`p1-executor-full2-fails.json`、`p1-executor-full2.log`。

## 九、P2（issue 125）交付：JSONL selected-results 公開 route

- 新增 `createJsonlSelectedForkController`：JSONL store 的 v2 selected fork 走專用 `public-results-v1` route（`captureSelectedResultsRoute`），以 selected-source holder 完成 `captureFirst`→`publishWarm`；durable operation outcome 讓重試回 `adopted`＋原 receipt，不重複 capture；project intent 漂移回 `not-issued policy`。
- 既有 target 不再重建，改以 `inspectColdSelectedTarget`＋`beginColdSelectedFinalization` 做 cold qualification（status ready/conflict/blocked 均為契約合法分類）；partial publication 回誠實 blocked token（`phase:'header'`、`manifest:'unknown'`），重啟後 cold 可 adopted。
- `context-runtime`：holder cleanup 完成後釋放 operation key，同一 operation 可重試、並行 duplicate 仍拒絕；construction 失敗不殘留 key。
- `host`：JSONL 也安裝 selected-fork controller、傳遞 `ForkExecutionControl.signal`、關機先 join controller 再關 native context；測試 helper `storedSession` 支援 JSONL read-only coordinator。
- 驗證：新測試 3 檔（host-jsonl-fork 3、recovery 3、holder-retry 2）＋既有 selected-fork 回歸（commit-log fork/read/recovery、selected-source-holder、selected-fork-seed）共 **42/42**；host 回歸 4 檔 **15/15**；gateway typecheck 0；package boundaries PASS（128=baseline）。
- 已知 kernel 缺口（已誠實回 blocked／not-issued，未造假）：同 process warm header 發佈被 blocked 無法 cold resume（重啟後可）；capture reservation 已寫但 header 未發的 crash 視窗無 resume API；outcome persist 失敗時效果已 commit 但同 process retry 可能 blocked。

## 十、P1 殘餘（38→36）與 P3 計畫

`p1-executor-full2.json` 的 38 failed 在動態 project cwd 修正（`680617ad`）後，`project-context` 由 3→1，實際約 36 項；依根因分類：

1. **legacy state restore（5）**：`retained-state-negative`(4)、`retained-state-cold`(1)。v14 任務轉換要求每個 session 有一致 task document，舊 v2 state doc 冷開被拒 `TASK_TRANSITION_RECOVERY_REQUIRED`；需以 v3 Task 生命週期重建 fixture 或產品提供 v2→v3 遷移。
2. **instruction/handoff 持久化（10）**：`managed-runtime`(1)、`managed-runtime-context`(1)、`instruction-diagnostics`(1)、`instruction-isolated-review`(2)、`managed-instruction-handoff`(3)、`title-action`(1)、`generation-actions`(1)。含 private runtime bootstrap 入口未建立、post-turn title 取消後 settlement source 無 `closeRequested`、isolated source recovery 後未 retire、legacy seed import 任務生命週期等。
3. **delivery recovery（3）**：`delivery-lifecycle`(1)、`delivery-active-wait`(1)、`owned-service-shell`(1)。Stop receipt 的 never-issued capture 重試、falsey acknowledgement 的 close/handoff debt。
4. **context-output 刪除/保留（5）**：`publication-pins`(2)、`mixed-retention-native`(1)、`mixed-retention-quota`(1)、`service-instruction-close`(1)。首次 delete pin/access 的 `Original deletion recovery required`、SQLite logical-full、cold reader 契約。
5. **Task/child native（6）**：`native-dependency-observer`(1)、`exec-direct-source`(1)、`execution-source-prereq`(1)、`bounded-file-production`(1)、`inherited-context-budget`(2)。child job owner、prepared Exec issuer、fake-timer registration 等。
6. **project/steering（3）**：`project-context`(1)、`event-driven-steering`(2)。child followup live scope、foreground model-driven spawn 的 service wiring。
7. **fork/retained（2）**：`fork-handoff`(1)、`retained-hook-recovery`(1)。nested legacy L1 transfer、coordinator retained cleanup debt。
8. **other（2）**：`retained-batch-continuation`(1)、`instruction-isolated-review` 已列於 2。

> 後續進展（第五十五～六十七批）：owned-service-shell(1)、delivery-lifecycle(1)、mixed-retention-quota(1)、publication-pins(2)、	itle-action(1)、instruction-diagnostics(1)、managed-instruction-handoff(3)、managed-runtime-context(1) 已修復；第 3 類 delivery recovery 只剩 delivery-active-wait(1)，context-output 類剩 0；executor 定點殘餘 **0**；fixed-HEAD verify:all 16,341 passed／104 skipped／112 failed（typecheck/e2e/gates/boundaries/artifact 全綠；112 failures 分佈於 7 個 package，其中 58 個 30s timeout）。

P3 執行計畫（在固定 HEAD）：
- `node scripts/test-env.mjs pnpm run verify:all`（上次同指令於 `cf92d076` 約 4h44m，含 suite／typecheck／e2e／reachability／boundaries／compiled gateway）。
- 負載敏感單獨比較：`selected-native-source`、`usage-protocol-aux-host`、`interaction-resume`、`current-unfinished-catalog`、`retention-grants`（單獨 vs 全庫 `--maxWorkers=2`）。
- 效能群組：legacy-funding-batch、legacy-fork-scale／performance、10,001 observations。
- 完成後更新本報告 totals、CI 結果與殘餘清單；CI 需在推送 head 上 success。

### 八之二、第三輪 executor 全套件實測（2026-11-16，head `bc0e93a2`）

- **231 檔、1,405 項：1,373 passed／32 failed／0 skipped**（第二輪 1,367/38）。
- 第三輪新增全綠：`publication-pins`（18/18）、`main-instruction-construction`、`execution-authority`、`owned-code-service`、`owned-code-nested-shell`、`delivery-retry`、`delivery-lifecycle`、`owned-service-shell`、`retained-code-output`、`project-context`（9/10）。
- `service.test` 與 `main-instruction-targets` 兩案為負載敏感：lane promotion 等待由 5s→20s；257 次目錄讀取實測 538.7s，`AbortSignal.timeout` 由 540s→900s。修正後預期殘餘約 30。
- 證據：`p1-executor-full3.json`、`p1-executor-full3-fails.json`、`p1-executor-full3.log`。