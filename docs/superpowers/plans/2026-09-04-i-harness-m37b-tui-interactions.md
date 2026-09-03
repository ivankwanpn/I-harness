# M37b 執行計劃 — 全屏交互覆蓋（permission/question + panes + dropdowns + pickers + welcome）

日期：2026-09-04 · spec：`docs/superpowers/specs/2026-09-04-m37b-tui-interactions-design.md` · 取捨：**Inline/minimal → M38**；後端零改動（approval 接線 = 只讀 seam）。

## 分組

- **G1（interaction 覆蓋 + 橋擴展）** `src/views/permission.ts` `question.ts` `cancel-turn.ts` + `src/backend/approval.ts`（BackendClient 擴展：`approvals()/answerApproval()/questions()/answerQuestion()`——embedded 用 `onAssembly` + `registerApprovalAnswerer` + decision queue）+ `test/{permission,approval}.test.ts`。單測：行模板 golden（`1 (●) Always allow: …`）、範圍 ←→ 鍵、freeform RejectOnce 輸入、question `1-9/a-f/z`、決策回寫 stream 順序、cancel-turn 1-4。**新依賴**：`@i-harness/session-persistence` + `-jsonl`（store 列舉——package.json 更新 + lockfile）。
- **G2（panes + dropdowns + pickers + welcome + keymap 全表）** `src/views/{todo-pane,tasks-pane,queue-pane,btw-overlay}.ts` + `src/views/{slash-dropdown,completion-dropdown,history-panel,file-search}.ts` + `src/views/session-picker.ts` `welcome.ts` + `src/app/keys.ts` 補全（modal/dropdown/picker 鍵）+ agent.ts layoutAgent 擴充（面板 row 槽 + overlay 佔位優先序 §2.1）+ `test/{panes,dropdowns,picker,welcome,keys-full}.test.ts`。
- **G4（host + PTY）** host-012/013 + case-012/013（用 M37a harness 基建：byte-budget / wait-screen / marker）——case-012：打字 → Enter 提交 → mock 第二 turn；歷史 Up；Ctrl-C 清草稿；Ctrl-M multiline；Shift-Tab 循環。case-013：scripted approval 請求 → modal 屏幕模板 → `1` 選擇 → 決策回寫斷言（假 backend 的 answer 流）。+ 橋擴展的 surface 導出。
- **G5（docs + 全驗證）** README M37b 行 + CAPABILITIES + spec/plan 標記 + `pnpm typecheck` / `pnpm -r test` / `pnpm e2e`。

## 硬規

- 跨組：只 import contracts.ts / views agent layout 現有導出；文件集互斥；後端包零改動（approval 接線若被阻塞 → 報告，不擅自改後端）。
- Inline/minimal（CSI S/T 前向 / print-once）**不在本輪**——M38（blueprint §4 的 M38 政策輪含 /minimal 切換）。
- approval 決策面：guard-approval 的 Always/Never/Once/Reject 語義照 M37a guardian（approveAll 默認開；TUI 覆蓋顯示時靜默?——**不**：PTY case-013 用關閉 approveAll 的 fake backend 場景）。
- PTY 測試沿用 M37a harness：writes-mode byte-budget + 屏幕 pins + glyph integrity。

## 驗證序列

1. G1∥G2 → 調和 → `pnpm --filter @i-harness/tui test` + typecheck
2. G4 → case-012/013 綠 → apps/tui 手動 smoke
3. G5 → 全量 typecheck/`-r test`/e2e → push → 用戶確認 → FF main
