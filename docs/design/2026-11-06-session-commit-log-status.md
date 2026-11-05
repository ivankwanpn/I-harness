# Session Commit Log — 現況報告（2026-11-06）

本文件彙整 SCL（Session Commit Log，`session.v15.jsonl`）在 `experiment/audit-fixes-v0.1.13` 上的實作、
驗證證據與剩餘缺口，供後續決策與交接使用。設計背景見 `2026-11-05-session-commit-log-redesign.md`，
逐輪紀錄見 `2026-11-05-development-debt.md`，實作計畫見 `docs/superpowers/plans/2026-11-05-session-commit-log-format.md`。

## 1. 已實作並驗證的產品面

| 面 | 證據 |
|---|---|
| store（append-only commit log、prefix 鏈、flock writer lease、sidecar、GC、deletion commit point） | `session-commit-log` 9 檔 / 38 tests（format、scanner、fold、store、crash、scan-cache、benchmark、multiprocess-lock、fold-property） |
| facade／coordinator（create、load、list、profile、snapshot、append、documents、delete、fork、birth、intent、ownership、retained references） | `session-persistence` commit 系列 10 檔 / 38 tests |
| desktop host（create、prompt turn、model switch、tool call、artifact retention、result page 讀取與分頁、execution/tasks/processes 讀取、task reconcile、schedule CRUD、surface subscribe/snapshot/changed、management rename/archive/restore/reload/navigation/batch delete/batch move、project bind、auto title、compaction E2E、cold control 錯誤） | `desktop-gateway` host SCL 13 檔 / 14 tests |
| fork（普通 fork、nested、project 繼承、retry） | `host-commit-log-fork.test.ts` |
| rewind（points/plan/execute） | `host-commit-log-rewind.test.ts` |
| CLI（`sessions list/show/--json/--last`、headless `run`） | `apps/cli/test/sessions-commit-log.test.ts`、`run-commit-log.test.ts` |
| 整備 gateway（slash command turn + clean close） | `owned-gateway-commit-log.test.ts` |
| 雙跑 corpus（8 個 legacy session 對照 legacy coordinator） | `commit-dual-run-corpus.test.ts` |

## 2. 效能

- journal prefix 改為增量累加（每次 commit 不再重新序列化整段歷史）；
- read 開啟加入 parsed-record 快取（40×30 corpus：17ms → 7ms；5,000 事件 session 連續 10 次讀取 7ms）；
- `IH_COMMIT_SCAN_CACHE=0` 可關閉快取（除錯用）。

## 3. 生命週期與錯誤語義

- 刪除以 `rename` 為 commit point；receipt 先持久化；manifest 文件以 `doc-clear` 清除；
- 刪除會 `markDeleted`，retained reference 立即失效；coordinator close 會 retire 全部 references；
- legacy 讀取／列舉失敗原樣拋出（只有 ENOENT 是 not-found）；不捏造 legacy metadata；
- 背景失敗（enqueue、deletion listener）走 `reportBackgroundFailure`。

## 4. 剩餘缺口

| 缺口 | 範圍 | 影響 |
|---|---|---|
| selected-results 繼承（`results:"selected-results-v1"` 的 fork／child 捕獲） | 需 `selectedSourceFor` ＋ `createSelectedRuntimeCapture`（legacy `createDocuments` 的 selected 路徑），或自建 `HeldInheritedResultMetadata`／`HeldResultPages` 等價物 | SCL 模式下此種捕獲不可用（`SELECTED_RESULTS_UNSUPPORTED`／`Selected source unavailable`）；一般 fork、無 selected 的 task child、頁面讀取不受影響 |
| legacy 刪除 | 需 selected-results 缺口關閉或接受降級 | 尚未刪除任何 legacy 程式碼 |
| 舊格式 corpus（6–12） | 需帶有效 `journal` metadata 的錄製樣本 | dual-run corpus 維持 13/14 |
| legacy `session-persistence` 基線 | 280 個既有失敗（transition gate／artifact latch／win32 lock） | 與 SCL 無關，未修復 |

## 5. 需要的決策

1. **selected results**：維持 legacy-only（現況）、接受 SCL 降級並切換預設、或投入移植（§8.2 的 B2）；
2. **legacy 刪除**：只有 (1) 決定後才有意義；
3. **SCL 預設化**：目前為 opt-in（`IH_SESSION_STORE=commit-log` 或 host 的 `sessionStore`）。

## 6. 如何重跑驗證

```powershell
node scripts/test-env.mjs pnpm --filter @i-harness/desktop-gateway exec vitest run test/host-commit-log.test.ts test/host-commit-log-fork.test.ts test/host-commit-log-rewind.test.ts test/host-commit-log-turn.test.ts test/host-commit-log-schedule.test.ts test/host-commit-log-surface.test.ts test/host-commit-log-surface-changed.test.ts test/host-commit-log-management.test.ts test/host-commit-log-project.test.ts test/host-commit-log-title.test.ts test/host-commit-log-compact.test.ts test/host-commit-log-compact-long.test.ts test/owned-gateway-commit-log.test.ts
pnpm --filter @i-harness/session-commit-log exec vitest run
pnpm --filter @i-harness/session-persistence exec vitest run test/commit-coordinator.test.ts test/commit-execution.test.ts test/commit-fork.test.ts test/commit-ordering.test.ts test/commit-retained.test.ts test/commit-task-document.test.ts test/commit-process-read.test.ts test/commit-observations.test.ts test/commit-prefix.test.ts
node scripts/test-env.mjs pnpm --filter @i-harness/cli exec vitest run test/sessions-commit-log.test.ts test/run-commit-log.test.ts
```
