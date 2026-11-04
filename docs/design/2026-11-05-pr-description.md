# PR: audit fixes for I-harness v0.1.13

## 目的

把 `docs/handoff/2026-11-04-audit-fixes/`、`2026-11-04-design-deviation-audit.md`、`2026-11-04-audit-session-persistence.md`、`2026-11-04-audit-agent-context.md`、`2026-11-04-audit-tools-sandbox.md` 的審計發現修到可交付狀態，並以 Codex／opencode／dsh 的設計作為重設計參考。

## 影響範圍

- session-persistence／core-session：journal、document 寫入、recovery、fork、rewind。
- subagent／agent-team：task projection、job record、team lifecycle、completion delivery。
- session-executor／sdk／desktop-gateway／desktop：admission、notification、approval、診斷顯示。
- exec／sandbox：assurance、MCP 關閉、WSL 檢查。

## 主要變更（依類型）

### 資料一致性／恢復

- D-01 durable job record：append-only、雙寫、terminal 優先、document 重建、legacy fallback、owned 唯讀降級、desktop 降級列。
- D-07 durable write intent：未結算寫入有 durable 證據並出現在 reload 診斷。
- D-08：task-document 寫入失敗只影響該 job，不再封鎖 spawn／無關任務。
- S-07：rewind 先寫 intent、再還原檔案；pending rewind 進 reload 診斷。
- team completion 喚醒修正（`submit` 對 admitted input 延後 settleFinishedActions）。
- team teardown：registry retire 時 cleanup 降級。

### 效能／資源

- S-06 step 2：append warm cache 只驗新增事件。
- S-06 document：preimage／candidate 改 64 KiB 串流 SHA-256，峰值記憶體與文件大小無關；confirmation 與 partial-temp 續寫也改串流（不再整份讀回記憶體），大小上限統一為 `TASK_DOCUMENT_MAX_BYTES`。
- A-12：WSL distribution 檢查每 backend 一次。

### 可見性／生命週期

- S-08：fork 以 durable publication marker 延後可見性——child header 出現後、bootstrap birth 完成前不會出現在 `list()`；completion frame commit 時（或任何 completed-birth 讀取）清除 marker。

### 協議／UX

- NG-08 session/status 詞彙統一；NG-11 hook ask 進 approval seam；NG-12 核准規則自動重讀；D-05 approval identity 不再雜湊工具表面。
- A-10 shell 截斷標記；A-11 `AGENT_ABORTED` 與 MCP tree kill；S-10 header 明確錯誤。

## 測試

```powershell
pnpm -r --no-bail typecheck
$env:IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT="$env:TEMP\ih-evidence"
pnpm --filter @i-harness/agent-team exec vitest run test/acknowledgement-settlement.test.ts test/completion-delivery.test.ts test/transact.test.ts test/managed-transact.test.ts test/lifecycle.test.ts test/initial-input-proof.test.ts test/composed-fixture-hooks.test.ts --testTimeout=30000
pnpm --filter @i-harness/subagent exec vitest run test/job-record.test.ts test/job-record-dual-write.test.ts test/job-record-recovery.test.ts test/write-behind.test.ts test/document-intent.test.ts test/persist.test.ts
```

- 全庫 typecheck：82 packages 全綠。
- agent-team composed：118/120（另 2 個 5 秒 `waitFor` timeout 在 pre-change baseline 同樣失敗，屬環境 flake）。
- subagent D-01／D-07：含新增的「document store 全失敗仍可 admission／重建」e2e。
- session-persistence：`fork-publication` 2/2、`document-write-errors` 2/2。
- session-persistence-jsonl：`list-incomplete` 2/2、`task-document-write` 8/8、`task-document-observation` 25/25、`document-write-preimage` 2/2。
- 封裝後 gateway CLI 冒煙測試通過（`--help`、空 stdin exit 0、`initialize`＋`session/list` E2E）。

> 註：`session-persistence-jsonl` 全套在本環境為 379 failed／477 passed，**與本分支改動無關**（baseline 378 failed，逐檔失敗集合相同）。根因是 legacy `createSessionCoordinator` 在 format 14 被 `TASK_TRANSITION_UNSUPPORTED` 停用，屬 D-12 測試遷移債務；詳見 `2026-11-05-final-decisions.md` §0。

## 風險／回滾

- 大部分改動在既有 API 內，無資料格式升級；document 寫入仍保留原格式與上限。
- S-08 只新增 `<id>.jsonl.publishing` 旁檔（完成即刪）；舊版會忽略它。
- 安裝檔：`I-harness-Setup-0.1.13.exe`（SHA-256 `94cd1fcc…`，189,643,574 bytes）。
- 回滾：revert 此分支即可；job record／write intent 是**另外的附加檔案**，不影響舊版讀取（舊版會忽略 `jobs/`）。

## 未完成（follow-up，非本 PR 目標）

- A-12 WSL worker 重用（協議 v2）：設計決策為**不做**（單 workload trust boundary），見 `2026-11-05-final-decisions.md` §4。
- D-01 移除可變 task document 寫入：決策為**保留 projection 寫入**，以 job record + child session 為權威來源並以測試鎖定，見 §3。
- D-12：legacy coordinator 測試遷移（379 個紅測試的根因）。

詳見 `docs/design/2026-11-05-final-decisions.md`。
