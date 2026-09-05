# M46b — 鼠標全 parity：執行記錄（G1 8fd0a0c + G2 2a8de9b + G3）

日期：2026-09-05 · branch m46b（自 main 出）· 源：docs/superpowers/specs/2026-09-05-m46b-mouse-design.md（新版 delta Area 1）。

## 執行

- **G1（8fd0a0c）**：捕獲五模（tui-core terminal init/teardown）+ 解析器 Moved/釋放位解碼 + `hover.ts` HitArea 引擎（dirty-only）+ 視圖懸停視覺（scrollback bg blend / md 邊框 / ts swap / chips / dropdowns / permission / question / slash）+ `scroll-stream.ts`（grok 引擎移植：80ms gap、16ms cadence、每品牌 ept、accel、taper、carry、per-flush cap）+ knobs（settings Mouse 7 行 + `mouse_reporting_toggle` 門控 + scrollback Ctrl+R 綁定）+ 單測（hover/mouse-stream/scroll-stream/settings-mouse/present-hover）。
- **G2（2a8de9b）**：`mouse.ts` 路由器——scrollback 單/雙/三擊 + word_select 1/2/3、拖拽（≥1 cell、邊緣 band 1/2/3/5 行/tick、鬆手自動複製、失 Up 恢復、flash/hold 模式）、scrollbar 鎖存+fraction、prompt 點擊/雙擊（file-ref/paste chip）/拖選、permission 雙擊即發、question/cancel-turn、status chips、面板（tasks/queue/todo）、dropdowns、Ctrl+點鏈接 — 全部經注入剪貼板層（唯一複製路徑）+ `mouse-consts.ts` 時序常量（唯 300ms/copy debounce 500/context 300/flash 150）+ overlay-seam rowYs/setCursor/multi 縫 + 單測 mouse-click.test（679 行）。
- **G3（本提交）**：case-023 PTY 鼠標矩陣（wheel/hover+ts swap/click/double-fold+drag-autocopy/scrollbar/permission-double + minimal no-capture）+ docs（README 行 + CAPABILITIES 鼠標節 + UI 規格 §4 鼠標標註 superseded 延展 + 本文）。

## 驗證

- `pnpm --filter @i-harness/tui test`：**49 文件 462 測試全綠**（既有 460 + case-023×2），2× runs 穩定。
- `pnpm --filter @i-harness/tui-core test`：全綠（解析器 Moved/釋放位用例在內）。
- typecheck 0。
- case-023 pins：writes=34（init 1 + 11 event frames + 3 hover + 4 wheel + 1 click-down + 2 fold + 1 expand + 6 drag + 2 scrollbar + 2 permission + teardown 1）；裁剪板 `clipboard.json` = `data-1\ndata-2\n …\ndata-4\ndata-5`（拖拽 4 行顯示行）；`selection.json` 終態 {5,9}；decision.json `{surfaceId:"p1", verdict:"always", approved:true, index:0}`；hover bg `#2c2c2c`（bgHover）；ts swap `18:46:35 | Sep 05`（本地構造 epoch——任何時區同牆鐘）。

## 已承認偏離（LOUD）

1. **滾動流式：`push()` 即時 flush（偏差於 grok 的 16ms scroll clock）**——既定設計 §4 已聲明（凍結/固定測試時鐘下確定性滾動；drain 路徑保留 cadence）。實際驗證：單一 wheel 事件 = 1 offset 行（case-018 數學保持）。
2. **自動滾動邊緣 band = 3 行（而非設計 §3 的 2 行）**——`updateAutoscroll` 以距離 0..3 為帶；行/帶距表 [5,3,2,1]。測試拖拽因此選中間帶（距帶極 ≥4），避免凍結下 pump-tick 捲動（編排選擇，非語義改變）。
3. **case-023 場景細節與任務措辭的小偏差**：(a) 拖拽 motion SGR 用 `<32;x;yM`（b+32 拖動位——`<0;x;yM` 會解析成再次按下，非拖動）；(b) 拖拽起止放中間安全帶（序上「wheel→hover→click→fold→drag→scrollbar」按任務次序，折疊後總行數 16——scrollbar 比例跳用下方 max=4：frac 5/12 → offset 2）；(c) 擴展雙擊用**異格同行**（33,14 vs 30,14）——多擊計數按格鍵，凍結時鐘 0 gap 使同格第二對變「三擊」；(d) scrollbar 列=app x=77（1-based 78）——事實佈局（內框 w=76），非 79；(e) 折疊目標=**Edit 塊**（展開態→`❙ 頭 (+6/-6)` 單行）；「Run read data.txt」維持自動 collapsed 顯示（execute excerpt）。
4. **滑動後視圖跳幅**：loop 的 `scrollBy` 用 **24 行窗**clamp（max = lineCount - rows + 1）而呈像用 13 行 scrollback 窗——輪一檔後顯示頂跳至新 offset（case-018 早已如此；其「1 行」指 offset 檔位）。案例 pin 以實測為準。
5. **hover 目標**：懸停 bg-blend pin 用 Edit 塊的 **diff 正文行**（非工具頭——3 輪後那行帶 ts 詳情+頭在一行內也未離視窗；一致於「有工具塊的行」）。
6. **permission 雙擊畫面**：第一對 down1 的 setCursor(0) 無視覺變化 → 無額外 frame（寫數 pin 已含）。

## 事實

- 捕獲五模確認：`MOUSE_ENABLE_SEQ`（1000h/1002h/1003h/1015h/1006h crossterm 順序）於 terminal.init 若 `cap.mouse`；teardown 五模 `l`。
- 每事件 = 1 frame（queueMicrotask 合流）；凍結時鐘下 anim pump 重繪零字節；toast/flash 永不失效（凍結）——確定性來源。
- selection 至今僅狀態契約（框/flash 繪製=調和事項）——case-023 經主機 watcher 斷言引擎 set（selection.json）。
- minimal 場景：**無 tui-core terminal 建構**（無 init/teardown 位元組）——byte 流斷言 `?1000h` 缺席 + region 「minimal line」正控（writes=6）。
