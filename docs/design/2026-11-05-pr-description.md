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
- S-06 document：preimage／candidate 改 64 KiB 串流 SHA-256，峰值記憶體與文件大小無關。
- A-12：WSL distribution 檢查每 backend 一次。

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
- agent-team composed：120/120。
- subagent D-01／D-07：39/39。
- 封裝後 gateway CLI 冒煙測試通過（`node --import tsx cli/src/cli.ts --help`）。

## 風險／回滾

- 大部分改動在既有 API 內，無資料格式升級；document 寫入仍保留原格式與上限。
- 安裝檔：`I-harness-Setup-0.1.13.exe`（SHA-256 `1bd51031…`）。
- 回滾：revert 此分支即可；job record／write intent 是**另外的附加檔案**，不影響舊版讀取（舊版會忽略 `jobs/`）。

## 未完成（follow-up，非本 PR 目標）

- S-08 fork 原子發佈
- A-12 WSL worker 重用（協議 v2）
- D-01 移除可變 task document 寫入
- S-06 document 大小上限／格式決策

詳見 `docs/design/2026-11-05-remaining-redesigns.md`。
