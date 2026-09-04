# M43 執行計劃 — Rewind UI 複刻

日期：2026-09-05 · spec：`docs/superpowers/specs/2026-09-05-m43-rewind-ui-design.md`。

## 分組

- **G1（view+binder+bridge）✅** rewind.ts 六相位（+planning）+ 字面字串 + rewindKeys（phase-aware y 分派）+ bindRewindOverlay 狀態機（loading→picker→cancel-offer→mode-select→planning→confirm→executing→error）+ loop Esc-Esc 接線 + backend.rewind 橋（M42 service 懶建）+ 標記行 + rewindAnchor()（34/34）。
- **G2（dimFrom + case-020）✅** TuiAppState.dimFrom（anchor 後 blend 0.66）+ present goldens + 真 RewindService 磁盤證明（budget 17；disk == "v1" byte-exact）。
- **G3 補（輪尾保真）✅**：引擎隱藏——appendRewind 過濾 anchorSeq 後塊 + SegmentIndex.resetAll 硬重建 + **共享數組別名 bug 修復**（實為 crash 根因）+ anchorSeq 貫穿（contracts/mapSessionEvent）；case-020 pins 重定（隱藏後標記行在頂）+ referee await-marker timeoutMs。

## 執行發現

1. **引擎隱藏需求**（G2 delta 上報）：僅標記行不隱藏 → 補齊（grok 記憶體截斷等效）——修復過程揭出 **shared-array 別名**（seg.blocks = 引擎數組 → pushBlock 雙重計入 → index 斜移 → countOf undefined crash）。
2. **anchorSeq 語義**：rewind-to-T = 撤 T 後；標記行在上、舊 turn 內容消失（case-020 重定 pin 於頂行）。
3. **await-marker timeoutMs**（referee 擴充）：rewind 級 UI 流長——45s。
