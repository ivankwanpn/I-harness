# M46b — 鼠標全 parity（新版真源）

日期：2026-09-05 · branch m46b（自 main 出）· 源：新版 delta Area 1（鼠標——5 模式/點擊語義/時序/滾動流式/旋鈕，全部 file:line）+ 黑盒登錄屏實證（OSC52 等）。**新版為真源**（規格 §4 鼠標行標註 superseded——「滾輪 3 行」流式化後遠不止）。

## 0. 目標

修補我們鼠標的最大差距：**懸停 + 點擊 + 拖拽 + 滾動流式 + 配置旋鈕**——grok 級互動。紅線：minimal 模式捕獲關；teardown 五模全復位；case-023 鼠標矩陣 PTY。

## 1. 捕獲/解析（G1）

- **init 五模**：`?1000h ?1002h ?1003h ?1015h? ?1006h`（crossterm 同款；1015 無害——我們解析 1015 已有）；**1003 = all-motion（懸停必需）**。
- **解析器**：1006 已有；加 **Moved（無按鈕移動）**解碼（SGR `<b;x;yM` 且 b==3（無按鈕）→ {type:"mouse", motion:true}）；drag = b&32 的既有處理（code>=32 為拖動——核對現解析）；滾輪 64/65 已有。
- **teardown**：擴全序 `?1000l ?1002l ?1003l ?1015l ?1006l`（現有 1006l+1002l 补齐）+ mouse-leak 警告（conhost 原始 ANSI 清殘——視需要）。
- **minimal**：捕獲完全關（現 M38a 本就不捕獲——維持+註記）。

## 2. 懸停機制（G1）

- **HitArea**（grok 真源）：`{ rect, hovered }` + `update(col,row) → changed`；present 時每個視圖**登記** rect+語義（views 在繪製時回報）；hover 只在 updated-changed 時重繪（**dirty**——不裝 30fps 懸停泵）。
- 懸停視覺：scrollback 行 bg blend+inset（markdown 除外——邊框代替）；時間戳懸停擴展 `%H:%M:%S | %b %d`；context chip 懸停八分塊條（min 6 列）；dropdown 行懸停；permission/question 項懸停；tasks `[✗]/[↗]` 懸停；狀態 chip 懸停（cwd 複製提示等）。
- 非矩形：hovered_entry（可選塊）、hovered_link、timeline_hover(+popup 簡版)、follow-up chips。

## 3. 點擊語義（G2）

- **scrollback**：單擊=選中+聚焦；雙擊（≤300ms，**唯一定時常量 300**）=折疊（組頭=整組；BgTask=viewer；subagent=全屏；prompt=內聯編輯（gated——fallback 折疊+置頂））；三擊=折疊+置頂；word_select 模式（`keep_text_selection=word_select`）：1=選項 2=詞/URL **立即複製** 3=單元格/段落（box-grid 表格檢測——簡化：段落）。
- **拖拽**：閾值 **≥1 cell**；文本拖=wrap 感知選區（+表格拖簡單）；塊拖=per-block;文本自動滾動（**2-row 邊緣、1/2/3/5 每 tick**、tick-driven、重繪後頭重貼）;**鬆手自動複製** + "Copied!" toast + 150ms flash（`DEFAULT_SELECTION_HIGHLIGHT_DURATION_MS=150`；flash/hold/word_select 三模式）；失 Up(Left) 恢復路徑仍交付複製。
- **scrollbar**：Down=鎖存+跳至球拍（thumb 同算式 Top/Bottom/Offset）；Drag 連續；Up 結束。
- **prompt**：點擊定位光標；雙擊 file-ref→line viewer / 粘貼 chip `[Pasted: N lines]` 展開；拖=textarea 選區；follow-up chip 單擊=SubmitFollowUp。
- **permission**：單擊=活動行；**雙擊（≤300 同 idx）即發**；懸停動行。
- **question**：單擊 toggle；雙擊=選+下一題（末題提交)。
- **cancel-turn**：點擊即發。
- **狀態欄/chips**：cwd 點擊複製路徑；tasks chip 面板切換；context chip → 信息（300ms debounce）；goal chip → 詳情 overlay（M46a 已建）。
- **面板**：tasks 行按鈕；組頭點擊切組；queue `[cancel]/[Send now]/[edit]`；todo 行選；dropdown 行點擊選+接受 + 右 2 列 scrollbar 列比例跳；timeline chevron 跳 turn。
- **鏈接**：Ctrl+點（macOS Cmd——我們 Windows 為主）armed→同單元格 Up 開鏈接。
- 以上按控件全部接入現有視圖（views 新增 `handleMouse(ev, ctx)` 鉤子；loop 鼠標路由：先 HitArea/控件 → 後默認）。

## 4. 滾動流式（G1——`src/app/scroll-stream.ts` 移植）

- 80ms gap / 16ms cadence（`GROK_SCROLL_CADENCE_MS`）/ 每品牌 ept / 加速 2.5× + taper + per-flush cap `max(viewport/2, 6)` + wheel-promote（首批 ≤12ms 觸發）/ 觸控板辨識（均值 <30ms）。
- **旋鈕**（settings `tui.prefs.mouse` + settings modal **Mouse 類**現在真——取代 m46a 佔位）：`scroll_speed`(1-100→0.1-6×) `scroll_mode`(auto|wheel|trackpad) `scroll_lines`(1-10,def 3;品牌默認值表——iTerm2/Wez 滾輪 1、VS 嵌入軌道板 15、其餘 3; ept 表) `invert_scroll` `keep_text_selection`(flash|hold|word_select) `word_separators` + `mouse_reporting_toggle`(opt-in 默認關;註冊 Ctrl+R scrollback 綁定 + `/toggle-mouse-reporting`（隱藏+惰性——m46a 已佔槽）+ env `GROK_MOUSE_REPORTING_TOGGLE`)。

## 5. case-023（鼠標矩陣 PTY）

SGR 序列喂入 + 斷言：滾輪滾動（scroll 偏移變化）；懸停高亮（cellColor/inset 前後差）；單擊選中（selection 框）；雙擊 300ms 折疊（塊 collapse）；拖拽+auto-copy（選區 cells + "Copied!" toast pins）；scrollbar 拖（跳轉）；permission 雙擊即發（decision json）；Ctrl+點鏈接（若場景有鏈接——加一個）；minimal 模式無捕獲（捕獲序列 idles——byte ledger 觀察 0 mouse bytes 無效——直接斷言 minimal init 不含 mice 序列）；budget + pins + exit 0。**Host 捕獲記錄 byte stream 帶 SGR 解碼斷言**。

## 6. 分組

- **G1**：捕獲五模+解析 Moved+teardown + HitArea/dirty + 懸停視覺接入（scrollback/ts/chips/dropdowns/permission）+ 滾動流式 + 旋鈕（settings modal Mouse 真）+ CTRL+R 門控 + 單測（解析/懸停 dirty/流式/旋鈕）。
- **G2**：點擊語義全控件（scrollback/drag+autoscroll+autocopy+flash modes/scrollbar/prompt/permission/question/cancel/chips/panes/dropdowns/timeline/link）+ 單測（每個語義——dry-run 級：虛擬 buffer 斷言;複製=clipboard 注入層）。
- **G3**：case-023 + docs（規格 §4 鼠標真源註記 + README/CAPABILITIES）+ 全量。

## 7. 硬規

- preset 服務的渲染路徑低侵入（視圖回報 HitArea——不重繪像素隨意）；懸停僅 dirty 重繪（性能紅線——不裝 30fps 懸停泵）。
- 複製經注入層（測試斷言 selected-copied 內容；系統剪貼板只在真實運行）。
- 既有 case 010-022 全綠；PTY 慣例。
