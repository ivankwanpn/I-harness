# M37a 執行計劃 — `@i-harness/tui`（全屏主幹）

日期：2026-09-03 · spec：`docs/superpowers/specs/2026-09-03-m37-tui-app-design.md`（M37a 範圍 = §1 減 M37b 項）· 取捨：M37 拆 a/b（用戶）。

## 分組（骨架已立：packages/tui package.json/tsconfig/vitest + src/contracts.ts = 跨組契約）

- **G1（scrollback 引擎）** `src/scrollback/*` + `test/scrollback.test.ts`——純內存、無終端。Contract：`ScrollbackEngine`（contracts.ts）。模組：entries（TuiEvent → block 模型，折疊分組 per §3.1，動詞組 folding）、layout（wrap 行段 + virtual_y 前綴和）、folding（折疊/展開/…N more/動詞組）、selection（行/詞/單元三擊+拖拽）、search（regex 反相/n/N）。單測：1000 段增量只重排 dirty；offset 導航 O(log n)；折疊分組；中英混排 wrap 段；resize setWidth 段數穩定。
- **G2（視圖 + app loop/發送/鍵表）** `src/views/*（agent/status/turn-status/prompt/shortcuts）` + `src/app/*（loop/present/keys）` + `test/present.test.ts`——用 tui-core `createRenderer` + contracts；測試用 stub engine。Presenter：app state → cell buffer（唯一繪圖點；spinner 有需才裝 tick）；AgentView 佈局 = 規格 §2.1 精簡版（status 行→turn 行→scrollback Min(5)→prompt 區→shortcuts 行；vpad/hpad 默認）；keymap 主組（§4：scrollback 瀏覽 j/k/L/H/g/G/PgUp/E/y；prompt Enter/Ctrl-C 雙階段/Shift-Tab 循環；全局 Ctrl-T/B/S/Q/Ctrl-P/+/）。單測：present 輸出（stub state → 斷言 cell buffer 文本/樣式 map）；idle 幀 0 字節；keymap 表（jq events → handler）。
- **G3（backend 橋）** `src/backend/client.ts + embedded.ts` + `test/backend.test.ts`——embedded = `createSessionService`（session-executor）+ core-session `subscribe()` 映射（TuiEvent map 表照 contracts：user/message→user、assistant/chunk→assistant、reasoning→thinking、tool/call+result→tool（toolKindOf）、turn/start|end、compaction/*、todo/write、goal/change、session/title、plan/mode、command/run|done→system）；**16ms batch 合併**；seq 游標 = session-log seq（subscribe 提供）；replay(afterSeq) 走 deriveMessages/events 線。測試：llm-mock scripted turn → 斷言事件序 + batch 合併 + seq 連續 + submit/cancel 生效。
- **G4（host + PTY）** `apps/tui/src/index.ts`（tui app：embedded service + mock 默認 / --resume / --model / --yes）＋ `packages/tui/test/harness/`（host-011/014 + case-011/014 yaml+ts——用 @xterm/headless + node-pty，延用 tui-core harness 經驗：marker 文件 + chcp 65001 + 零字節窗口）。G1–G3 合併後執行。
- **G5（docs + 全驗證）** README M37a 行 + spec/plan 標記 + `pnpm typecheck` / `pnpm -r test` / `pnpm e2e`。

## 依賴與硬規

- `packages/tui` deps 已列：tui-core / session-executor / core-session / llm-mock（workspace:*）；devDeps xterm-headless/node-pty/yaml。運行時依賴**允許**工作區包（本層是 app 層——後端包都被依賴；非「0 外部」規則，那是 tui-core 的紅線）。
- vitest forks pool 已配。
- 跨組規則：**只 import contracts.ts**；不動其他組文件；不動 src/index.ts（除 G4/G5 的 surface 在輪尾）。
- M37a 後端**零改動**（只讀既有 API；若發現真正阻礙 → 報告不擅自改後端）。

## 驗證序列

1. G1∥G2∥G3 → 調和（同 worktree；文件集互斥）→ `pnpm --filter @i-harness/tui test` + typecheck
2. G4 → PTY case-011/014 綠（真終端、零字節、resize 不變量）+ apps/tui 手動 smoke
3. G5 → 全量 `pnpm -r test` + typecheck + e2e 11/11 → push m37a → 用戶確認 → FF main
