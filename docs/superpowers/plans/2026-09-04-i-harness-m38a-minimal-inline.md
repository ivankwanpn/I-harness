# M38a 執行計劃 — Inline 前向引擎 + minimal 模式

日期：2026-09-04 · spec：`docs/superpowers/specs/2026-09-04-m38-tui-minimal-markdown-design.md`（M38a = §1 M38a 段）· 取捨：M38a/M38b 拆分（用戶）；模式切換 = self-relaunch。

## 分組

- **G1（Inline 引擎）✅*** `packages/tui/src/minimal/inline.ts` + `test/inline.test.ts`——tail-window cell grid + insert_before（CSI S/T + DECSTBM + resize 邊角）。**參考實現**：`D:\opencode-bugfix\grok-build-main\crates\codegen\xai-grok-pager-minimal\src\commit.rs`（讀其 escape 序列**語義**——不抄代碼；金剛：goldens 定義正確性）。單測：k 提交後終端 scrollback 恰含提交塊、region 在底、字節輸出最小（goldens）、grow/shrink resize、寬字符邊角。
- **G2（minimal 視圖 + 切換）✅*** `packages/tui/src/minimal/live-region.ts` `commit.ts` `mode.ts` + `test/minimal-mode.test.ts`——live region 組合（[tail·todos·/btw·status·prompt] 1 行 status + prompt、行數 default 10、info 行）、print-once 提交管道（turn-end/段落閉合 → 提交 + region 重畫）、self-relaunch（`/minimal` `/fullscreen` 命令 → 同會話 re-exec `--mode`）；TuiAppScreen minimal 分支（screen-mode resolve 的 fallback 現在真正生效——M37a/M37b 全屏素材配 minimal 生活）。
- **G3（PTY）✅*** `host-015.ts` + `case-015.yaml` + `case-015.test.ts`——確定性場景：N 提交後斷言（a）xterm scrollback（buffers.scrollback?——virtual.ts 加 scrollback 行取）恰含提交塊；（b）live region 內容對；（c）**writes-budget 恰數**（init+每提交 1 寫+teardown——print-once 的定量證明）；（d）resize 邊角；（e）`/fullscreen` relaunch → 回全屏（host 字串命令？relaunch 測單獨：host-015b 或同一場景末段 spawn 自己帶 --mode fullscreen → 新進程畫面為全屏）。
- **G4（docs + 驗證）✅*** README M38a 行 + CAPABILITIES + spec/plan 標記 + 全量 typecheck/`-r test`/e2e。

## 硬規

- `@i-harness/marked`? 不——本輪無新運行時依賴（Inline/minimal = 純自研）。
- writes-budget 慣例沿用（M37a 方法論）。
- G1/G2 文件集互斥（G1: inline.ts + test；G2: live-region/commit/mode + test + apps/tui --mode 接線）；G2 可讀 G1 契約（`InlineLiveRegion` 接口在 G1，G2 只 import——或 G1 先 commit 再 G2？平行組風險：定義共享小接口檔 `src/minimal/contracts.ts`（我現在寫死））。
- 後端零改動。

## 準則（inline 正確性——G1 遵守）

- 提交即定：已提交文本**永不重繪**；只有 live region 自繪。
- 語意驗證 = PTY goldens + xterm scrollback 斷言（不是理論推演）。


## 執行發現（G3 質量通過——兩個正確性發現）

1. **CSI S 在 xterm.js 6.0 丟行**（`xterm-headless` 實測：`[nS` 把頂行從 buffer 剪掉、baseY 不增長→提交行永遠進不了 native scrollback）——改用 **LF-at-bottom-row**（baseY 增長、滾出行保留）——這正是 grok/ratatui 的 `insert_before_no_scrolling_regions` 路徑（`xai-ratatui-inline/terminal.rs:905-993`；pager-minimal 沒編 scrolling-regions 特性）。
2. **區域零字節 gate**：`loop.frameMinimal` 無 identical 抑制（G3 找到）——inline 引擎加 `lastPaintSig` gate（region 不變 → 0 位元組）；commit 內的 repaint 強制（scroll 移動了 region）。glyph 渲染接縫：`paintRow` 畫 `RegionLine.glyph`（prompt `❯`/tool `◆` 進 minimal 位元組——G2 的 canon 早已含 glyph，之前死內容）。
3. **frame 編號重定**：turn-end 的 region repaint 現在是零位元組（無 marker）——case-015 以 f8（turn-end commit）/ f9（resize repaint）/ f10（again commit 含 region）重新定框；**writes budget = 10**。
