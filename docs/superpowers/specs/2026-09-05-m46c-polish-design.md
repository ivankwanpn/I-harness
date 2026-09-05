# M46c — 鼠標收尾 + 選區可視 + 時間線軌 + 粘貼源 + workflow 面

日期：2026-09-05 · branch m46c（自 main 出）· 源：m46b 執行發現（selection 邊框 state-only、paste 源未保留）+ UI 規格 §2（時間線軌——跳過至今的面）+ /workflow 深化（後端包已有）。

## 範圍（四件）

1. **選區邊框可視**（m46b #6 缺口）：present 渲染引擎 selection —— `┌┐└┘│` 框（被剪裁 = 虛線 `┆` 側）、右上 `[✗]` 關閉、拖拽中的磁帶（selection_bar `▏`）、自動複製後 flash 150ms（已有 state——接渲染）；`keep_text_selection` 三模式下的選區持久（hold 直到 Esc/點擊/滾動——渲染+清除協同）。**渲染紅線**：selection 行的內容不重排（僅框層疊加——O(選區邊界) 繪製）。
2. **時間線軌**（規格 §2：scrollbar 槽被 timeline 替代——`show_timeline && !subagent && width>=60 && turns>=2`）：tick `━━/──/ ─`（激活/懸停/idle）、`▴▾` chevron（懸停 text_primary）、點擊跳 turn（m46b 語義續用——chevron hit + jump）、懸停 popup 簡版（turn 預覽 1 行）、`L/H` 鍵 ↔ 軌互動；與 scrollbar 的選擇關係（同一右列互斥）；路徑 = engine turn anchors（M46a /jump 已有）。
3. **粘貼源保留**（m46b #5 誠實缺口）：`[Pasted: N lines]` chip 的源文本存進 prompt state（paste 對象保留原始字符串）→ 雙擊展開真的還原原文（不再 toast）；關閉/提交後釋放。
4. **/workflow 面深化**：面板加 **run（參數輸入線——文本行）+ status 刷新**（@i-harness/workflow 的 workflow_run/list——讀其導出）；運行中行帶 `[stop]`（jobs 面? workflow run 的取消若無 → 誠實 (M46d)）。

## 分組

- **G1**：selection 渲染（框中線/虛線/✗/磁帶×三模式）+ case-023 增補斷言（border cells 現在可視——upgrade 其 watcher-only 斷言為真渲染斷言）+ 時間線軌（engine turn anchor 面 + 右列互斥 + chevron 點擊/懸停 popup 簡版）+ 測試（渲染 golden 每模式；軌 tick 狀態/點擊跳轉）。
- **G2**：paste 源保留（編輯狀態對象）+ workflow 面板 run/status + tests（paste expand 還原、workflow run 假後端）。
- **G3**：docs + 全量驗證 + 推送。

## 硬規

- 選區渲染不重排（疊加層）；時間線軌與 scrollbar 互斥規則照規格；PTY 慣例；既有 case 023-… 全綠（023 斷言升級後仍綠 = 渲染真準）。
- 後端零改動（workflow 只讀導出）。
