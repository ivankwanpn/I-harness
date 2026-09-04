# M39 執行計劃 — 質量輪

日期：2026-09-04 · spec：`docs/superpowers/specs/2026-09-04-m39-quality-design.md`。

## 分組

- **G1（case-017 交互矩陣）** `packages/tui/test/harness/host-017.ts` + `case-017.yaml` + `case-017.test.ts`（referee/runner/virtual 按需小擴充）。5 步：permission freeform（type → reject+feedback）、question（1-9a-f + z freeform + footer）、/btw 面板（steer → answering → done 轉換）、session picker（Ctrl-S → 列舉 → j/k → Enter）、history（Up → 命中 highl 行）。斷言：決策 json / 面板內容 pins / 選擇後閉合。writes-budget 適用（確定性場景）。
- **G2（HUD + memory + bench）** `packages/tui/src/app/hud.ts`（FPS 採樣 p50/p95 + 32 列面板渲染——`TUI_HUD=1` 或 `/debug fps` 觸發；默認零開銷）、`src/scrollback/engine.ts` `retain()`（LRU/顯示層 trim + `… earlier (N lines)` sticky 標記 vs 新事件仍收）、App 長會話自動觸發、`test/{hud,retain,bench}.test.ts`（bench：5000 段佈局時延表 + 閾值斷言）。
- **G3（docs + 核對）** 12 屬性核對表 → CAPABILITIES + README M39 行 + bench 結果記錄；全量 typecheck/`-r test`/e2e。

## 硬規

- HUD 默認關（零開銷——屬性#10 精神）；retain 不得丟事件語義（顯示層 trim only，新 append 不影響；回放 seq 游標不變）。
- 後端零改動；PTY 慣例（byte-budget/pins）；無新運行時依賴。
- bench 閾值取寬（CI 波動容忍），輸出文件記錄為報告。

## 驗證序列

1. G1∥G2 → 調和 → 全量 tui test + typecheck
2. G3 → 全量 → push → 用戶確認 → FF main
