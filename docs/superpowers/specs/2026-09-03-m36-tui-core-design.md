# M36 — `@i-harness/tui-core` 設計（renderer / input / terminal / screen-mode / theme + PTY harness 首例）

日期：2026-09-03 · branch m36（自 m35 出——研究文檔隨行）· 源：`2026-09-03-tui-grok-blueprint.md` §1–§3 + `2026-09-03-tui-grok-ui-spec.md` §5–§6。

## 0. 目標與紅線

M36 = TUI 的「命運階層」：證明 **零字節 idle** 與 **resize/滾動不變量** 在 TS + Windows 一等終端上可行。紅線（做不到 = 不如做 REPL，藍本 §5）：

1. **零字節 idle**：幀與前一幀相等 → 對終端輸出 **0 字節**（連 synchronized-update 包裹都不發）。
2. **單一 teardown 位元組序**：quit/CTRL-C 第一擊/panic/信號共用一條位元組序列，**永不重發**。
3. **終端恢復合同**：退出後終端在原始模式下無殘留（alt-screen 已離、鼠標/括號粘貼/游標色已復位）。

## 1. 包結構（新包 `packages/tui-core`，運行時 **0 外部依賴**）

```
packages/tui-core/
  src/
    grid/            cell model：Grid 雙緩衝 + 標記 set + diff → dirty runs
    render/          flush：dirty runs → 游標定位 + 樣式 ANSI 序列；DEC 2026 同步包裹（能力門控）
    glyphs/          §6 字形表：fancy + legacy fallback 雙映射（❯ / >、盲文 spinner / |-\、┃ / | …）
    wcwidth/         vendor：終端列寬語義（零庫實現；JS 無內建）
    ansi/            輸出側：樣式（Attr 構造器）+ 解析側：地圖/模式/錯誤容忍
    input/           raw 讀取 + 位元組解析：C0/C1、CSI（方向/Home/End/PgUp/功能鍵）、
                     UTF-8 流式解碼（TextDecoder）、kitty CSI-u 能力探測（DECRPM 27）、
                     bracketed paste（2004）、mouse SGR（1006）、focus（1004）、Ctrl+C=\x03 的原始模式語義
    terminal/        init 序列（alt-screen 1049 + 2004 + 1006/1004 依能力）+ teardown（唯一化、冪等、panic 安全）
    probe/           能力上下文：XTVERSION、DA1→brand（WT/xterm/kitty/wezterm…）、color-level 推斷、
                     kitty 能力、mouse-leak、Zellij/tmux（env + control-mode 查詢）、OSC 11/12 查詢+設定
    screen-mode/     Fullscreen/Inline/Minimal 政策解析（CLI > config > auto）+ 自動啟發
                     （Zellij→Inline、tmux control-mode→Inline、破損→Minimal 降級）
    output/          writer pump：隊列 + coalesce + backpressure（drain 門控——事件循環永不因慢終端阻塞）
    theme/           palettes（groknight/grokday + kind 解析/auto）+ 量化（truecolor/256/16 + ANSI16 釘色
                     + Windows contrast-boost）+ OSC 11/12 探測連結
    signal/          第一擊優雅（teardown 後退出）/第二擊強殺（Windows：SIGBREAK + \x03；POSIX：SIGINT/SIGTERM）
  test/harness/      xterm.js headless（devDep）虛擬屏 + node-pty（devDep，與 packages/terminal 共用）場景執行器：
                     場景 YAML（test/fixtures/scenarios/*.yaml）+ 不變量裁判（屏幕斷言/零字節斷言/滾動斷言）
  package.json       運行時 deps：無。devDeps：vitest、xterm-headless（@xterm/xterm）、node-pty、yaml
```

## 2. 決策表

| # | 決策 | 判定 | 理由 |
|---|---|---|---|
| D1 | renderer = 自研 cell grid + 2-buffer diff | 自研 | 無 TS 現成語義；零字節 idle 唯一可靠路徑；800–1200 LOC |
| D2 | wcwidth | **vendor**（包內 `src/wcwidth/`） | JS 無終端列寬語義；string-width 等引入非零行為方差（表格對齊/繪製字符） |
| D3 | 字面/字形 | 常量化（glyphs.ts），fancy+fallback 雙表 | 1:1 複刻 §6 + legacy ConHost 降級 |
| D4 | 幀寫入策略 | dirty runs（定位+畫）+ DEC 2026 包裹（僅當發了內容且能力開） | 零字節 idle 不需要包裹；快終端少字節 |
| D5 | writer | 單泵合併 + drain 背壓（無 worker 執行緒 v1） | Node 事件循環下屬性#2 的效果由「永不阻塞輸入/事件路徑」達成；慢終端隊列合併；worker 執行緒留 M39 bench 裁決 |
| D6 | input | `process.stdin.setRawMode`（Win/POSIX 同路）+ 自研解析；kitty CSI-u：M36 做能力探測+解碼，鍵位映射 M38 | Windows Terminal 支持 kitty 協議；一階鍵位 legacy 已夠 |
| D7 | 運行時依賴 | **0**（含 vendored wcwidth） | 與質量紅線綁定的最可驗證做法；PTY harness 用 devDeps（xterm.js 虛擬屏——通用公開庫，依賴原則允許；node-pty 既有） |
| D8 | 主題 | M36 內建（groknight/grokday 全表 + 量化 + ANSI16 釘色 + Windows 對比提升 + OSC11/12） | 渲染器第一天就需要顏色模型；按 §5 規格 |
| D9 | 屏幕模式政策 | CLI > config > auto；auto 含 Zellij/tmux 判斷 | 複刻屬性#5 |
| D10 | Inline 功能範圍 | **拆至 M37**（用戶 2026-09-03 取捨） | 前向引擎（CSI S/T/滾動區/resize 邊角）是最大風險塊且其承載者為 minimal 視圖（M37）——隨視圖同輪落地；M36 專注 fullscreen renderer 三紅線 |

## 3. 各模組關鍵不變量

- **grid**：兩緩衝 A/B；每幀 `render(frame) → dirty`；`dirty.empty ⇒ flush 輸出 0 字節`；cell = {char, style, width==2 mark, continuation}；無佈局（文本層在 M37）。
- **render/flush**：dirty runs 按行合併；每 run 發出 CUP/相對移動 + SGR set 最小化 + 文本；整幀包裹 DEC 2026 僅當 run 非空；**unicode 寬度不匹配時後退一列重寫**（width safety）。
- **input**：字節→事件（Key(combo)/Paste/Focus/Mouse）；parser 有界（單筆 100ms 內消化；壞序列不崩——記錄至 debug 日誌並跳過）；kitty 探測寫信 `\x1b[?27u` style（DECRPM 27 查詢）一次。
- **teardown**：單一序列 `\x1b[?1049l` + mouse/paste/focus 復位 + OSC 112 + 光標顯示；**冪等旗標**（任何路徑第二次呼叫＝無操作）；強殺路徑（第二擊）跳過 teardown 直接 `process.exit(130)` 但已安裝的 process 'exit' 鉤子做最後努力。
- **probe**：一次異步收集（每查詢 500ms 超時），結果不可變 `Capabilities` 對象；探測失敗=降級默認（16 色、無 kitty、無 mouse）。
- **theme**：`quantize(cap.colorLevel)`：truecolor 直通 RGB；256 → 最近 216+16;16 → ANSI16 釘色表（hue 系映射 §5）；os 亮暗經 OSC11（失敗 → OS 註冊表/環境）。
- **writer pump**：幀提交排隊；每次 tick 合併後台待寫；`stream.write` drain 掛起時新幀合入（不丟不飆）；idle 空隊列 = 無系統活動 → **可觀測 0 寫入**。

## 4. PTY harness（質量紅線的承載）

```
test/harness/
  runner.ts        node-pty 啟動「宿主 app」（tsx 跑一個寫死的 minimal TUI script）+ xterm headless 附着
  virtual.ts       xterm.js Terminal wrap：screen buffer 導出、零字節計數、resize 改尺寸、輸入注入（write key 序列）
  referee.ts       場景步驟 = 動作/斷言對（YAML）：
                   - screen: render 對照（期望 grid 子集/全等式）
                   - idle:  等待 idle 幀 → 斷言 0 字節
                   - resize: 改尺寸後斷言（行列嵌套不變量、無斷裂字形、光標在界內）
                   - scroll: 斷言 scrollback 上限/滾動不變量（首行/尾行/選區無溢出）
  first-case:      `case-010-render-arrow-idle`（渲染 → 截圖式 grid 斷言 → idle 1s → 0 字節 → resize 10 次不變量 → stop）
```

依賴：`node-pty`（devDep——與 packages/terminal 相同供應商）、`@xterm/xterm`（headless，devDep）、`yaml`（devDep）。測試以 vitest forks pool 運行（沿 M31 教訓）。

## 5. 交付節點（M36 範圍）

1. **T1** grid/wcwidth/glyphs/style + 單測（diff/width/table 對照）
2. **T2** renderer ANSI 輸出 + DEC 2026 + 零字節單測（pump 層次）
3. **T3** input parser（單測矩陣：utf8 多字節/CSI 變體/paste/mouse/kitty 探測）
4. **T4** terminal init/teardown + signal（子進程真終端驗證 teardown 後無殘留——kitty/alt-screen 復位）
5. **T5** probe + theme（量化矩陣：truecolor/256/16/ANSI16）
6. **T6** screen-mode policy（CLI>config>auto；Zellij/tmux 單測為 env 注入）
7. **T7** **PTY harness 首例**（case-010）——**門檻：`pnpm -r test` 含 idle 零字節 + resize/滾動不變量綠**
8. **T8** API surface 凍結（public exports：`createTerminal/attachInput/render/sendFrame/teardown/capabilities/screenMode/palette`）

## 6. 驗收

- `pnpm -r test`（tui-core 新套件全綠；全倉回歸無破壞——新包不觸既有代碼，預期 0 影響）
- `pnpm typecheck` 0 錯誤
- PTY harness：case-010 綠（零字節 idle 的**子進程真終端**證明）
- README/Docs：里程碑表補 M35+M36 行

## 7. 明確非目標（M36）

- 文本佈局/scrollback 引擎/視圖層（M37）；關鍵碼完全對照表（M37 views wheel）
- **Inline `insert_before` 前向引擎 → M37**（與 minimal 視圖同輪；M36 僅 screen-mode 政策解析，auto 啟發的 Inline/ Minimal 選擇結果可先保守回退 Fullscreen）
- fullscreen 之外的所有切換面（/minimal 命令 M38）；markdown/高亮（M38）
- node-pty 不在 tui-core 運行時（M36 只有 harness devDep 用）
- 不觸任何後端包（後端零新面）
