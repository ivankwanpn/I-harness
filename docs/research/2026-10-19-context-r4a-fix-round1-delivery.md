# R4A external delivery — Fix Round 1 (F1–F5)

狀態：**UNACCEPTED。** 本輪只修正 Codex 驗收（`CHANGES REQUESTED`）指出的 3 個已重現 P1、1 個 reader 缺口與 2 個證據問題；原 R4A A3–A6 仍未完成。沒有 merge／tag／release、沒有開始 R4B。

## 1. 範圍與固定點

| 項目 | 值 |
| --- | --- |
| 分支 | `codex/v0.1.13-development` |
| 驗收 HEAD（本輪起點） | `b0e84da724eb5a55cff253441d10ee800e4ad60a` |
| 上輪產品 HEAD | `41e97ecb80149bfe99bb7151c3bd5a0b7c11a9e7` |
| 外部增量 BASE | `f362c6387a40fbb8d4a0e60184c3040e9f01d5fb` |
| full R4A BASE | `91d8fef04253272a437c68f5f2f84a657fa53d3b` |
| 產品版本 | `0.1.13-rc.1`（未改） |
| 本輪 evidence | `.tmp/context-r4a-fix-round1-20261019/`（logs／scripts／probes） |
| 隔離 baseline worktree | `.tmp/context-r4a-fix-baseline-f362c638/`（detached `f362c638`，tree `d2b928227953332ef5049b7b832a0be85db0cb06`） |

舊證據（`.tmp/context-r4a-external-20261019/` 53 檔、`.tmp/context-r4a-evidence-20261018-a/`、review 目錄）全部原樣保留，未被覆寫。

## 2. 三個獨立 probe：修正前／修正後

命令（各自獨立執行、獨立 raw log；review 目錄未修改）：

```powershell
Set-Location 'D:/I-harness-main'
$r4aNode = 'C:/Program Files/nodejs/node.exe'
$r4aReview = 'D:/I-harness-main/.superpowers/sdd/2026-10-19-context-r4a-external-review'
& $r4aNode 'node_modules/vitest/vitest.mjs' run --root $r4aReview --config "$r4aReview/vitest.config.ts" <probe>.probe.test.ts --maxWorkers=1 --minWorkers=1
```

| Probe | 修正前 | 修正後 | 原始 log（before → after） |
| --- | --- | --- | --- |
| `task-roundtrip`（2 cases） | **2 failed**：`Unsupported retained task publication metadata` | **2 passed** | `probe-1-task-roundtrip-before.*` → `probe-1-task-roundtrip-f1.*` |
| `background-catalog` | **1 failed**：`startupDependencies=null, readerDependencies=null` | **1 passed**：reader catalog `artifact-set, count 1` | `probe-2-background-catalog-before.*` → `probe-2-background-catalog-f2.*` |
| `background-retry` | **1 failed**：`apiAttempts=1`（永久快取） | **1 passed**：`apiAttempts=2, launches=1` | `probe-3-background-retry-before.*` → `probe-3-background-retry-f3.*` |

修正後再以 `probe-final-*` 三個 label 重跑，全部 exit 0、sourceStable=true。

## 3. F1 — Task publication domain schema

- `packages/subagent/src/result-publication.ts`：把 closed descriptor 拆成可共用的 `validPublicationDescriptor` / `validSavedObservation` / `validResultExecution`；state／job 仍用自己的 status 詞彙且不接受 `outcome`。
- `packages/subagent/src/task/publication.ts`：新增 `validTaskResultPublication`，使用 Task 自己的 `TaskStatus`（accepted/running/completed/error/cancelled/recovery-required）與 `TaskOutcome`（completed/error/cancelled/recovery-required）。
- `packages/subagent/src/task/validation.ts`：改用該 domain validator。
- 沒有刪掉 `outcome` 去遷就 state validator，也沒有放行任意 extra key。

Package 控制（實際 coordinator／registry）：

- `packages/subagent/test/retained-task-cold.test.ts`：第一次 cold restore → `save()` → 第二次 cold restore，committed 與 unqualified 都必須通過，且 revision/ref/publication/savedObservation 保持原值、`subagent/end` 不增加、`captures=1`。
- `packages/subagent/test/retained-task-negative.test.ts`：completed/error/cancelled/recovery-required 四種合法列可 round-trip；非法 outcome、缺 outcome、extra key、v1 帶 v2 descriptor 仍拒絕。

## 4. F2 — 原 capture 保存與真正 observer 註冊分離

- `packages/exec/src/capture/frames.ts`：port 分為 `settle(capture)`（被動保存，不冒充 observer）與 `observe(capture)`（在**當前** prepared `ToolExec` 內註冊同一來源）。
- `packages/session-executor/src/lifecycle/exec-result-retention.ts`：`settle` 只走原 capture；`observe` 依 `currentToolResultProducer()` 建每個 observer 自己的 dependency handle（同一 `sourceId`、各自 grant target），先同步 `registerToolResultDependency` 再 settle；沒有 observer 時退回被動路徑。
- `packages/exec/src/jobs/records.ts`：背景完成時只做被動保存與 live view 更新；任何 query/list/close 都會再次 `observe`，因此正式 `job_output` 會拿到自己的 catalog。`BackgroundJobView.retained` 僅供顯示，不是授權。

Package 控制（`packages/session-executor/test/retained-background-exec.test.ts`，真實 assembly＋pwsh＋process）：

- startup 在 EOF 前回傳 `job_id`，startup 的 envelope 沒有 dependencies（不等待）；
- 只靠 `subscribeJob` 就自動提交 artifact；9 raw bytes 的 frame 順序／內容／digest 以獨立 oracle 核對；
- 第二、第三個真正 Agent 回合呼叫 shipping `job_output`：兩次結果各自有 `dependencies = {kind:'artifact-set', count:1}`；catalog 的 `sourceId` 等於自動保存來源、entry ref 等於同一個自動 retention；用 catalog ref cold 讀出的 bytes 與原 body byte-identical；
- 撤銷授權後 cold 讀取被拒，但 descriptor 與 artifact 不變；恢復後可再讀同一 bytes。

## 5. F3 — unknown settlement 保留恢復入口

- `packages/exec/src/jobs/records.ts`：移除永久 void promise 快取；`record()` 每次重入原 capture，只有 capture 自己有 known terminal 快取。舊 promise 不再刪掉較新的 in-flight handle（沒有 job-level in-flight 物件可被覆蓋）。
- `dispose()`：先 join 每個 job 的 `capture.complete` 與一次 honest retry；仍 `recovery-required` 時丟 `ARTIFACT_RECOVERY_REQUIRED`，不假稱必要保存已完成。

Package 控制（`packages/exec/test/background-recovery.test.ts`，真實 exec service＋controlled backend＋真實 `createExecFrameCapture`）：

| 控制 | 結果 |
| --- | --- |
| unknown → query/list/close → known `storage-refused` | attempts ≥ 2、launches = 1、dispose 不 throw |
| unknown → 真正 artifact ready | 第二次進入 committed ref，view `retained` 為 artifact |
| 持續 unknown + dispose | rejects `ARTIFACT_RECOVERY_REQUIRED`，launches = 1 |
| observer 首次 throw → 下一次真正查詢恢復 | `retained` 變成 artifact，無新 process |

## 6. F4 — 以真實 reader capability 判斷可讀性

- `TaskResultStore.available?(): boolean`（契約）；`TaskResultOwner.available()` 轉發。
- `createTaskResultRetention(...)` 以 `service !== undefined && parentSessionId !== undefined` 實作（`forSource` 衍生 store 亦同）。
- `task/registry.ts`：restored retention 只在 `available() === true` 時標 `durable`；否則 `failed` + 明確 reason，保留 v2／原 revision/ref／execution。

Package 控制（`packages/session-executor/test/retained-reader-capability.test.ts`，真正 factory）：

| 組合 | 結果 |
| --- | --- |
| 有 service | `durable`、read 成功、內容正確 |
| 真正 factory 但無 service（不是省略 `results`） | `failed`、reason 為 reader unavailable、descriptor 保留、read 明確拋錯、re-save 保持 v2 |
| 有 service 但 current ACL 撤銷 | 仍誠實標 `durable`（能力存在），read 被拒，descriptor 不被刪除 |

## 7. F5 — 證據更正與固定 source 回歸驗證

### 7.1 E1 更正（混合 source）

原報告 §3.1 的完整套件比較**不成立**：candidate 與 handoff baseline 兩次全套件執行重疊約 64.9 秒，期間同一 checkout 的 8 個產品檔＋1 個測試檔由 candidate 內容切換為 handoff 內容再切回（RED 證據的 stash/revert/apply）。原「65 vs 67、沒有可歸因新失敗」作廢；[原交付文件](context-r4a-external-delivery.md) 頂部已加帶日期更正，原文與 receipts 保留。

### 7.2 E2 更正（9 bytes ≠ 1MiB）

原背景 fixture 只有 9 raw bytes（stdout `A + NUL + emoji` = 6、stderr `ff 00 7f` = 3），不是「1MiB 級」。原文件同處已加更正。**本輪沒有新增 1MiB 背景控制**；`managed-frames` 的 2MiB 是不同 foreground／stub 流程，不能互換。

### 7.3 隔離 baseline 與順序執行

- Baseline：`git worktree add --detach .tmp/context-r4a-fix-baseline-f362c638 f362c638…`（HEAD `f362c638`、tree `d2b92822…`）。
- 依賴隔離：root `node_modules` 只 junction 第三方安裝；每個 package 的 `@i-harness/*` 以 **junction 指回 baseline worktree 自己的 packages**（5751 條）；第三方（含 `koffi`）junction 到 candidate 的既有安裝（154 條），並以 `createRequire` 核對 `@i-harness/subagent` → baseline 路徑、`koffi` → candidate `.pnpm`。
- 第一次 baseline 全套件因 isolation 腳本漏掉 symlink 形式的第三方依賴（`koffi`）而 **collection 失敗（77/83 檔）**：保留為 setup failure，不當行為 RED。修正 script 後重跑為 `f5-baseline-session-executor-full-v2`。
- 順序：candidate 全套件先跑（10:05–10:09），baseline 後跑（10:11–10:14），同一時段只有一套；每次 before/after maintained product/test manifest 一致（sourceStable=true）。

| 套件 | Test Files | Tests | source manifest |
| --- | --- | --- | --- |
| candidate（fixed） | 22 failed / 64 passed (86) | 67 failed / 377 passed (444) | `85e7cade…`（前後一致） |
| baseline（f362c638） | 21 failed / 62 passed (83) | 66 failed / 371 passed (437) | `c3b217c0…`（前後一致） |

逐測試名稱比較：兩邊失敗集合**只差一項**——

`test/code-mode-children-close-boundary.test.ts > keeps child outputs and stored state through snapshot-before-close at the exact second-turn receipt boundary`

因果證據：同一測試單獨重跑 candidate 3 次 = pass/pass/**fail**（`Session service process cleanup incomplete … Managed facts require reconciliation`），baseline 2 次 = pass/**fail**（同一錯誤）。這是兩邊都存在的 cleanup 時序 flake，不是本輪修正造成。candidate 多出的 3 個測試檔（background／state-negative／reader-capability）全部通過；baseline 沒有這些檔。

### 7.4 其他固定 source 驗證

- 三個 review probes 修正後全部通過（§2）。
- focused packages：subagent（retained-task-body/cold/negative、task-protocol/control、persist、projection、jobs、task-notification）、session-executor（retained-* 全部、retention-grants）、exec 全套、context-output 全套、core-tools 全套，全部 exit 0。
- affected types：subagent／session-executor／exec／context-output／core-tools／core-session／output-retention／desktop-gateway `tsc --noEmit` 全部 exit 0。
- reachability `--gate`：仍是同 6 個交接 WIP 既有的 `unused-export`（core-session 3、output-retention 3），沒有新增豁免、reseed 或假 consumer；gate 仍 fail 並如實記錄。

### 7.5 Copies／打包（只證明 build，不證明 packaged 行為）

| 命令 | 結果 |
| --- | --- |
| `build-gateway.mjs --out .tmp/context-r4a-fix-gateway-20261019-101833` | exit 0，242 packages |
| `build-dist.mjs --out .tmp/context-r4a-fix-cli-20261019-101833` | exit 0，`ih.mjs` 6,746,283 bytes，36 個既有 dynamic .ts import 警告 |
| `verify-dist.mjs --out .tmp/context-r4a-fix-cli-20261019-101833` | **PASS** |

Source→copy：本輪 11 個修改產品檔在 gateway copy 內全部 byte-identical（`.tmp/context-r4a-fix-round1-20261019/source-copy-map.json`）。CLI bundle `ih.mjs` SHA256 `8999fad829cab82967e6705b96795d93a25699de98727ffc62c8ef17aa4a603f`，且含本輪新增的 `ARTIFACT_RECOVERY_REQUIRED` 與 `validTaskResultPublication`。

**未跑** packed Gateway／CLI 的 normal／background／code／child／Stop／cold real-entry 流程；build 成功不等於 packaged 行為已驗證。

## 8. 未完成與限制（不因本輪通過而改變）

- A3 Code Mode emitted output 仍走 legacy optional capture／spill；A4/A5 的 MCP、media、search/export、fresh-host crash cuts 仍未補。
- 沒有 1MiB／100MiB 背景控制；沒有在最終 source 重跑 035/070 的 100MiB、171 的 100-child，也沒有 packaged Gateway／CLI 的 real-entry 流程。
- 本輪環境仍是 Windows／Node 24.15.0；未測試 Linux／WSL。
- S25／CX2 只有結構對照，原拆分仍 27/43。

## 9. 本輪 commit、最終 source 與 evidence

| 項目 | 值 |
| --- | --- |
| 本輪 incremental range | `b0e84da724eb5a55cff253441d10ee800e4ad60a..92eb29de6dbe962815e003accc822327ea82354a`（+ 本文件 commit） |
| F1 | `e84c5c3b fix(subagent): validate task publication in its own domain` |
| F2+F3 | `3fe3f1a7 fix(exec): register every genuine reader and keep unknown settlements retriable` |
| F4 | `92eb29de fix(context): derive durable task reads from the real reader capability` |
| 最終產品 source | 4589 個 apps/packages 檔（排除 node_modules/dist/build/.tmp/scratch），digest `85e7cadeed7ed9aa9ba0a80095543e10ba4f3c293191af2ad143cb21588dda5f` |
| closed evidence | 82 檔（logs／scripts／source-copy-map／build-suffix），digest `f3ed2d69aeddc429eb7b7db3474060383a2ca8433e116a32eb09a3a7dcd67894` |

## 10. 停止點

產品工作停止，等待 Codex 對本輪 incremental range 與 full `91d8fef0..HEAD` 複驗。沒有 merge、tag、release、R4B。
