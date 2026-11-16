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
