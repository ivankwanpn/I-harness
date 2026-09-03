# M36 執行計劃 — `@i-harness/tui-core`

日期：2026-09-03 · spec：`docs/superpowers/specs/2026-09-03-m36-tui-core-design.md` · 取捨已決：**Inline 拆至 M37**；運行時 0 依賴；PTY harness = devDeps（node-pty / @xterm/xterm / yaml）。

## 總覽

新包 `packages/tui-core`（運行時 0 外部依賴），8 節點 T1–T8。執行模式沿用：worktree 隔離 + 平行分組 + 調和審查 + 全量驗證。

## 分組

- **G1（core）T1 T2 T4a**：`grid/`（cell 模型+雙緩衝 diff）、`wcwidth/`（vendor）、`glyphs/`、`ansi/`（style 構造）、`render/`（flush: dirty runs + DEC 2026 + width-safety）、`output/`（writer pump + drain 背壓 + 零字節合併）、`theme/`（palette + 量化 + ANSI16 釘色 + Windows 對比提升 + OSC11/12 查詢接口）。單測：diff 正確性、字寬表、glyph fallback、flush 字節輸出 goldens、零字節（同幀 → 0 輸出）、量化矩陣。
- **G2（io/terminal）T3 T4b T5 T6**：`input/`（raw 讀取 + 位元組解析器：C0/C1/CSI/UTF-8 流式/括號粘貼/mouse SGR/focus/kitty CSI-u 探測/wait-parse 有界）、`terminal/`（init 序列 + 唯一 teardown 冪等 + panic 安全）、`signal/`（首擊優雅/次擊強殺，Windows BREAK+CTRL-C 語義）、`probe/`（能力上下文：XTVERSION/DA1/color/kitty/mouse-leak/Zellij-tmux/OSC11-12）、`screen-mode/`（CLI>config>auto 政策 + 環境啟發；**無 Inline 引擎——結果保守回退 Fullscreen 或標記 pending-inline**）。單測：解析矩陣注入（utf8/CSI 變體/壞序列容忍）、teardown 位元組序 golden、探測 mock 應答、政策決策表。
- **G3（harness）T7**：`test/harness/`（runner/virtual/referee + case-010 YAML）——依賴 G1+G2 合併。門檻：屏幕 grid 斷言 + idle 1s **0 字節** + resize×10 不變量 + 滾動不變量（子進程真終端）。
- **G4（surface）T8**：public exports 凍結（`createTerminal/attachInput/render/sendFrame/teardown/capabilities/screenMode/palette`）+ README 里程碑表補 M35/M36 行 + spec 狀態標記。

## 節點映射

| T | 內容 | 組 | 門檻 |
|---|---|---|---|
| T1 | grid/wcwidth/glyphs/style | G1 | 單測綠 |
| T2 | renderer flush + DEC 2026 + pump | G1 | 零字節單測 + golden |
| T3 | input parser | G2 | 解析矩陣綠 |
| T4 | terminal init/teardown + signal | G2 | teardown golden + 子進程真終端復位斷言 |
| T5 | probe + theme（量化） | G2 | 能力 mock + 量化矩陣 |
| T6 | screen-mode 政策 | G2 | 決策表 |
| T7 | PTY harness 首例（case-010） | G3 | **idle 零字節 + resize/滾動不變量綠** |
| T8 | API 面 + 文檔 | G4 | exports 凍結 + README |

## 驗證序列

1. G1+G2 並行 → 調和（worktree 合併，衝突：無重叠文件預期 0）→ `pnpm -r test` + `pnpm typecheck`
2. G3 → case-010 綠（`pnpm -r test`、typecheck 0）
3. G4 → docs；最後全量 `pnpm -r test` + `pnpm typecheck` + 既存 e2e 抽樣（新包不觸既有→應零影響）
4. push m36 → 用戶確認 → FF main

## 依賴細節（執行者需知）

- `package.json` 形狀照 `packages/fs-watch`（見其文件）；devDeps：`vitest`、`node-pty`、`@xterm/xterm`、`yaml`；vitest 用 **forks pool**（M31 教訓——防 Windows tinypool flake）。
- tsconfig extends `../../tsconfig.base.json`；include src+test。
- 字面字形：見 `docs/research/2026-09-03-tui-grok-ui-spec.md` §6（glyphs 表 + legacy fallback）；配色：§5（GrokNight 全 RGB + 量化策略）。
- 環境：Windows 11 一等；Node ≥22。
- 完成後於 `docs/superpowers/plans/` 該檔標記各節點 executed。
