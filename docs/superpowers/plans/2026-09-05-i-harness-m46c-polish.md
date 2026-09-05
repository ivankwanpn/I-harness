# M46c 執行計劃 — 選區渲染 + 時間線軌 + 粘貼源 + workflow 面

日期：2026-09-05 · spec：`docs/superpowers/specs/2026-09-05-m46c-polish-design.md`。

## 分組

- **G1（選區渲染 + 時間線軌）✅**：`drawSelectionOverlay` 最終軌（┌┐└┘/✗/┆/▏磁帶/flash+hold+word_select——零重排證明：覆蓋只寫空白列）+ timeline 軌（三態 tick/chevron/popup/跳轉——`turnAnchors()` O(turns)；`L/H` 從 M38 死鍵復活為真導航）+ /timeline + case-023 升級（真渲染斷言 + ✗ 點擊清除——budget 34→36）+ 新場景 023t（rail 細胞/懸停/popup/chevron 跳——budget 39）——506/506 綠 ×3。
- **G2（paste 源 + workflow 面）✅**：pasteStash（雙擊還原 byte-exact、提交釋放、小粘貼免chip）+ /workflow run|status|list（真執行器——child_process shim 零新依賴 + `[r]` 刷新 + 無取消縫誠實 (M46d)）。

## 執行發現

1. **timeline 默認 OFF**（誠實偏差）：grok 默認 ON，但既有 11 個 PTY 場景釘 80 列全行——ON 逼全改；OFF 保 462 測試原位。**開關邏輯與規格全同**（gate/tick/popup/chevron/jump）——宿主 `TuiAppOptions.showTimeline` 或 `/timeline` 開啟。
2. **折疊清選區**：double/triple 折疊使 span 行無效——折疊即清（改語義必要 + 場景行精確）。
3. **彈窗 card 扁平化**（cell grid 無圓角——誠實簡化）；單詞選取引擎截斷 ≤40 vs 繪製 20 列（規格視覺保 20）。
4. 同文件雙組編輯（loop/contracts/registry）已並存驗證——G3 全量後推送。
