# Session Commit Log — 現況報告（2026-11-06）

本文件彙整 SCL（Session Commit Log，`session.v15.jsonl`）在 `experiment/audit-fixes-v0.1.13` 上的實作、
驗證證據與剩餘缺口，供後續決策與交接使用。設計背景見 `2026-11-05-session-commit-log-redesign.md`，
逐輪紀錄見 `2026-11-05-development-debt.md`，實作計畫見 `docs/superpowers/plans/2026-11-05-session-commit-log-format.md`。

## 1. 已實作並驗證的產品面

| 面 | 證據 |
|---|---|
| store（append-only commit log、prefix 鏈、flock writer lease、sidecar、GC、deletion commit point） | `session-commit-log` 9 檔 / 38 tests（format、scanner、fold、store、crash、scan-cache、benchmark、multiprocess-lock、fold-property） |
| facade／coordinator（create、load、list、profile、snapshot、append、documents、delete、fork、birth、intent、ownership、retained references） | `session-persistence` commit 系列 10 檔 / 38 tests |
| desktop host（create、prompt turn、model switch、tool call、artifact retention、result page 讀取／分頁／邊界／unavailable、execution/tasks/processes 讀取與冷視圖形狀、task reconcile、todo 冷／live 寫入、schedule CRUD、surface、management rename/archive/restore/reload/navigation、batch delete/move/edges、archive 與 delete 於有歷史的 session、project bind、auto title、compaction E2E、cold control 與 owner-scoped 錯誤、session search、context picker、diagnostics） | `desktop-gateway` host SCL 32 檔 / 37 tests（另 lineage／subtree／search tool 單元 3 檔） |
| fork（普通 fork、nested、project 繼承、retry、turn 之後、rewind 之後、重啟契約、child task document） | `host-commit-log-fork*.test.ts`、`host-fork-restart.test.ts` |
| rewind（points/plan/execute、files 模式、fingerprint 失效、跨 host 執行、turn 之後、fork 之後） | `host-commit-log-rewind*.test.ts`（6 檔） |
| 重啟耐久（session 續用、metadata、schedule、batch move、prepared fork 契約） | `host-commit-log-restart*.test.ts`、`host-commit-log-schedule.test.ts`、`host-commit-log-batch-move.test.ts`、`host-fork-restart.test.ts` |
| 搜尋（SCL fallback、limit、tool 內容、混合 store、subtree、lineage） | `host-commit-log-search*.test.ts`、`host-commit-log-mixed-search.test.ts`、`session-search-tool.test.ts`、`session-query-subtree.test.ts`、`session-lineage.test.ts` |
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
- 背景失敗（enqueue、deletion listener）走 `reportBackgroundFailure`；
- fence 的 `exclusive` 只對自己的 async context 授予 admission（archive／delete 於跑過 turn 的 session 也能完成，內部 cold-rewind
  recovery 不再被自己的 fence 擋下）；
- fork／rewind 對「跑過 turn」或「rewind 過」的 session 皆可運作，prepared fork 仍不可跨 host 續用（與 legacy 一致的契約）；
- `settleCapture` 對已被 rewind 釋放的 capture 視為 settled，host 關閉不再因 `Original capture obligation released` 失敗；
- 有 fork 子會話的 parent 不可刪除（先刪 child 再刪 parent）。

## 4. 剩餘缺口

| 缺口 | 範圍 | 影響 |
|---|---|---|
| selected-results 繼承（`results:"selected-results-v1"` 的 fork／child 捕獲） | **commit-log 已接線**：SDK v2 seam → gateway controller → v3 seed → `createChildSession`，host 測試通過（`host-commit-log-selected-fork`） | legacy 仍走 `createSelectedRuntimeCapture`；兩個 store 各自支援，行為尚未完全對齊（child 的 result page 讀取待驗） |`）；一般 fork、無 selected 的 task child、頁面讀取不受影響 |
| legacy 刪除 | 需 selected-results 缺口關閉或接受降級 | 尚未刪除任何 legacy 程式碼 |
| 舊格式 corpus（6–12） | 需帶有效 `journal` metadata 的錄製樣本 | dual-run corpus 維持 13/14 |
| legacy `session-persistence` 基線 | 280 個既有失敗（transition gate／artifact latch／win32 lock） | 與 SCL 無關，未修復 |
| ~~fork child 續用~~ | ~~code-mode 的 delegated owner 檢查~~ | **已修（2026-11-06）**：`origin:"fork"` 放行，child 可跑 turn、rewind、管 schedule |
| ~~fork 後刪除 parent~~ | ~~task operation 持有已關閉的 parent document~~ | **已修（2026-11-06）**：fork witness 改用 detached read-only document |

## 5. 需要的決策

1. **selected results**：維持 legacy-only（現況）、接受 SCL 降級並切換預設、或投入移植（§8.2 的 B2）；這是**唯一**仍阻擋預設切換的功能；
2. **legacy 刪除**：只有 (1) 決定後才有意義；
3. **SCL 預設化**：目前為 opt-in（`IH_SESSION_STORE=commit-log` 或 host 的 `sessionStore`）。

## 5.1 最新回歸（2026-11-06）

一次跑完 SCL 全部表面：**host 37 檔 / 42 tests**、`session-commit-log` 9 檔 / 38 tests、commit 系列 43 tests，共 123 tests
全綠、無 flake。涵蓋 fork／rewind 在 turn、rewind 之後的序列、**fork child 續用與 nested fork**、fork child 的 schedule、
archive／delete 於有歷史的 session、todo 跨 rewind／compaction、search／context picker，以及 fence 的 exclusive 授權。

## 6. 如何重跑驗證

```powershell
node scripts/test-env.mjs pnpm --filter @i-harness/desktop-gateway exec vitest run test/host-commit-log.test.ts test/host-fork-restart.test.ts test/host-commit-log-restart.test.ts test/host-commit-log-restart-meta.test.ts test/host-commit-log-search.test.ts test/host-commit-log-search-limit.test.ts test/host-commit-log-mixed-search.test.ts test/host-commit-log-fork.test.ts test/host-commit-log-rewind.test.ts test/host-commit-log-turn.test.ts test/host-commit-log-schedule.test.ts test/host-commit-log-surface.test.ts test/host-commit-log-surface-changed.test.ts test/host-commit-log-management.test.ts test/host-commit-log-project.test.ts test/host-commit-log-title.test.ts test/host-commit-log-compact.test.ts test/host-commit-log-compact-long.test.ts test/owned-gateway-commit-log.test.ts
pnpm --filter @i-harness/session-commit-log exec vitest run
pnpm --filter @i-harness/session-persistence exec vitest run test/commit-coordinator.test.ts test/commit-execution.test.ts test/commit-fork.test.ts test/commit-ordering.test.ts test/commit-retained.test.ts test/commit-task-document.test.ts test/commit-process-read.test.ts test/commit-observations.test.ts test/commit-prefix.test.ts
node scripts/test-env.mjs pnpm --filter @i-harness/cli exec vitest run test/sessions-commit-log.test.ts test/run-commit-log.test.ts
```