# m50 修復交接報告（2026-09-02）

> 狀態：m50 分支上 BUG-1 修復已提交；BUG-4 修復**代碼完成、case-018/單元已重校準綠，case-023 待重校準**（接手點）。本檔為下一台機器的接手說明。

## 分支 / 環境

- 分支 **m50**（`git checkout m50`；出自 m49 `c9e408a`）。已推遠端。
- 已推 commit：`235c2c5`（BUG-1 修復 + case-024 cell 斷言）。
- 本機環境：Node 在 `C:\Users\IvanKwan\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.22_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v22.23.2-win-x64`（bash 每次需 `export PATH="<該目錄>:$PATH"`；node 不在默認 PATH）。pnpm 9.15.9 同目錄。
- 若 `apps/tui`/`apps/cli` 的 `node_modules/@i-harness` symlink 缺失（曾發生）：`pnpm install --force` 重建。

## 已完成 ✅

### BUG-1：node:sqlite ExperimentalWarning 洩進 TUI 螢幕（已提交 `235c2c5`）
- 新增 `packages/session-query/src/warning.ts`：**capture-and-redrive** 過濾器（`process.listeners("warning")` 捕獲 → 移除 → 重驅動；只丟棄 sqlite 警告、其餘轉發原 listeners）。
- 作為 **session-query 模塊副作用**安裝（`warning.ts` 底部 + `index.ts`/`file-backed.ts` 首行 `import "./warning.ts"` 先於 `node:sqlite` import——ESM 依賴先求值，保證 filter 先掛）。
- 關鍵經驗：**單加 `process.on("warning")` 無效**（Node bootstrap 默認打印器也是 warning listener，照印）；必須移除原 listeners 自行重驅動。已用真子進程雙向驗證（E1 無泄漏 / E2 對照泄漏）。
- 結果：TUI 12 個 harness case 全綠（原全紅）。
- 順帶修：case-024 `assert-cell-colors` row 12→13（Task 12 加 Dashboard 行後斷言未同步；test drift）。

### BUG-4：`scrollBy`/`pageStep` 用整屏高非 scrollback rect（未提交——本批）
- 修改 `packages/tui/src/app/loop.ts`：
  - 新增 `private scrollViewportHeight()` = `layoutAgent({cols,rows}, this.app, {compact}).scrollback.h`（與 `anchorDisplayLine` 同款）。
  - `scrollBy` 的 `page` 與 `max = total - page + 1` 用之；`pageStep()` = `floor(rectH/2)`。
- **grok-build 對照確認方向**：`D:\grok-build-main\crates\codegen\xai-grok-pager\src\scrollback\state\nav.rs:377` `max_offset = total_height - viewport_height`（viewport=scrollback rect）——IH 同構（+1 差一為既有約定）。
- 重校準（本批）：
  - `case-018.yaml`：wheel-up 期望由舊 max（buffer.height=24 → offset 4→3）改為新 max（rect=13 → follow 15 → 14）；wheel-down 14→15 回 tail。**已綠**。
  - `packages/tui/test/mouse-stream.test.ts`：`one wheel event scrolls ONE line` 期望由寫死 `30-24+1=7` 改為經 `layoutAgent` 實算 rectH；**已綠**。
- 診斷過程已清除（`host-scroll-diag.ts`、driver、`.dbg-scroll.log` 等一次性檔已刪）。

## ⚠️ 接手點 1：`case-023` mouse-matrix 待重校準（唯一紅）

- 現況：`packages/tui/test/harness/case-023.test.ts` **紅**。原因：yaml 的 wheel 段（STEP 2/3 及後續「wheel ×3 more → offset 1」的行 pin 目標）校準自**舊 max = lineCount-24+1**；修復後 max = lineCount-rect+1 = **28-13+1 = 16**。
  - 舊語意（yaml 註釋自述）：`offset 6→4`（clamp 於 24 行 max=5）。
  - 新語意：follow 時 cur=max=16 → 一次 wheel-up → offset 15；×4 次 → offset 12（而非舊 offset 1）。**下游 click/drag/scrollbar 步驟的畫面行全部隨偏移變化**。
- **重校準方法**：host-023 支援 `TUI_DUMP_DIR`（env → 每個 frame 寫 `<dumpDir>/frame-N.txt`）。寫個小 driver（仿已刪的 `c023-recal.mts`，注意 **ESM 不能用 `require()`**——用 `import { readdirSync } from "node:fs"`）：spawn `host-023.ts`（80x24）→ 等 `scene-ready` marker → sleep ~3.5s 等 settle → 發 `\x1b[<64;40;12M`（STEP2 wheel-up）×1 → sleep → 再發 ×3 → dump frames → 依實際行列改寫 yaml 的 wait-screen rows。
- 注意：case-023 的 byte-budget `writes: 36` 若 wheel 幀數不變則不變（wheel 數沒變，只變內容）；先只改 rows。

## 📋 剩餘 bug 清單（m49 報告 [docs/audit/2026-09-02-ih-m49-bug-hunt.md](docs/audit/2026-09-02-ih-m49-bug-hunt.md)）

優先級（按報告 §建議序）：
1. **BUG-2 [HIGH]** Gemini 同名並行工具呼叫折疊——`packages/llm-gemini/src/index.ts:153-181`（`pendingCalls` 按 `name` 去重）。
2. **BUG-3 [HIGH]** `removeProvider` 對 legacy-only `tui.providers` no-op——`packages/provider-runtime/src/index.ts:171-182`（`canonicalLlm` 不含 legacy 行 → :174 早 return）。
3. **BUG-5 [MED-HIGH]** `windowedDiff` 小 append 假巨改——`packages/text-diff/src/index.ts:87-136`（:113 overlap 護欄只在 delta≥window 觸發）。
4. 子代理候選（`[子代理]` 標記、建議先補重現測試）：P1–P4、T1–T2、B1–B6。

## 驗證方法（本機）

```bash
ND="C:/Users/IvanKwan/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.22_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v22.23.2-win-x64"
export PATH="$ND:$PATH"
cd /d/I-harness-main
pnpm --filter @i-harness/tui test          # 除 case-023 外應全綠
pnpm --filter @i-harness/session-query test
pnpm -r typecheck
```

> 全倉 `pnpm -r test` 並行時偶有 PTY/spawn 超時 flake（acp/case-027/sdk-e2e 輪流、單跑全綠）——README「Known infra quirks」同類，非回歸。
