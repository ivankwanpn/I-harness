# M38b 執行計劃 — 內容輪：markdown checkpoint + 高亮 + 選項頭實值 + --attach 遠程

日期：2026-09-04 · spec：`docs/superpowers/specs/2026-09-04-m38-tui-minimal-markdown-design.md` §1 M38b 段 · 取捨：M38a/b 拆分（用戶）。

## 分組

- **G1（markdown checkpoint + 高亮）✅**** `packages/tui/src/render/markdown.ts` + `packages/tui/src/scrollback/entries.ts`（AssistantBlock 渲染切 markdown 檢查點）+ `folding.ts`（`plainRows`→`markdownRows` 選擇路徑）+ `test/markdown.test.ts`（+ scrollback.test 適配）。**新依賴**：`marked`（通用公開庫）+ `highlight.js`（通用公開庫）——package.json deps + lockfile。
  - checkpoint 狀態機：段落（空行閉合）/列表（結構閉合）/代碼圍欄（```` ``` ```` 閉合）→ 每次閉合刷新該段（尾重渲染——塊尾部增量）; 流中未閉合段 = 進行中行（plain）。
  - 渲染規格（§3.1/§8）：h1-h6 六色（mdHeading 表）、粗/斜/下劃線、` • ` 列表、`│` blockquote、`───` hr、表格 box art（簡化：row+sep 段）、代碼塊 = 圍欄/語言標記 **hidden**（只渲 body on md_code_bg）+ hljs 語言高亮（**極性安全**：ANSI16 映射表照 §5 hue 釘色；未知語言 → plain md_text）；流中代碼塊 = 未閉合 → plain body on md_code_bg + 完成時重渲帶高亮。
  - 迭代性：assistant chunk append → 只重渲該塊（O(block)）。
- **G3（case-016 PTY）✅**** `host-016.ts` + `case-016.yaml|test`——流式 markdown 會話：段落閉合逐段畫出（grid pins 每段）+ 代碼塊閉合後高亮行（顏色字節 pins 或樣式斷言——xterm fg 色檢查）+ **writes-budget 恰數**（每閉合 + 完成重渲的確定次數）。
- **G2（選項頭實值 + --attach 遠程）✅**** `packages/tui/src/backend/remote.ts`（SDK 客戶端 → BackendClient：`@i-harness/sdk` connect over spawned `i-harness sdk` 子進程——wire v0 凍結）+ `src/app/loop.ts`（info line modelLabel/context 實值——`defaultEmbeddedFactory` 的 modelLabel 從 modelBuilder 標籤傳導）+ apps/tui `--attach <sessionId>`（spawn sdk 子進程 → remote backend）+ `test/remote-backend.test.ts`（spawn 真 sdk server 子進程 loop；wire 契約已凍——remote 面只消費）。**注意**：sdk server 走 `apps/cli sdk`——子進程以 tsx 跑了；驗證 spawn 參數從 apps/cli 的 sdk 命令讀。
- **G4（docs + 全驗證）✅**** README M38b 行 + CAPABILITIES + plan 標記 + 全量 verify。

## 硬規

- marked/hljs = 通用公開庫（依賴原則 ✓）；先例：chokidar/@aws-sdk/@agentclientprotocol。
- 現有 scrollback/PTY 測試的回歸敏感性：assistant 純文本行路徑不變（case-011 的 "It says hello." 仍 plain）；僅含 md 語法的段走新路徑。任何 scrollback.test 適配先跑全量看差異。
- 後端零改動（sdk 按 v0 契約消費；attach = apps/tui 接線層）。
- PTY 慣例沿用：byte-budget writes 模式 + pins。

## 驗證序列

1. G1∥G2 → 調和 → 全量 tui test + typecheck
2. G3 → case-016 綠（+ 既有 case-011..015 回歸綠——markdown 路徑不得影響 plain）
3. G4 → 全量 → push → 用戶確認 → FF main


## 執行發現（G3 質量通過）

1. **md_code_bg 在 fullscreen 路徑不繪**（G3 cell-色 probe 抓到：drawScrollback 的 view.text 傳樣式名→styleFor 丟 run.codeBg）——輪尾修復：scrollback run 路徑直接以 codeBg 解析（case-016 補 bg pins `#1c1c1c` + SGR pin 增 bg 段）。
2. **ConPTY 重編碼**：流上以游標相對跳躍（`[3C`）重編碼——byte pins 帶 ConPTY 形（SGR 顏色值不變；counts 慣例不受影響）。
3. **誠實缺口錄案**：--attach cancel 無線面（system note 替代）；replay/list = v0 無 RPC（從 attach 時刻）；contextUsed 需 token-meter（函數體就位）。
