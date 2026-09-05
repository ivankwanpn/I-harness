# M47 執行計劃 — 質量輪 2

日期：2026-09-05 · spec：`docs/superpowers/specs/2026-09-05-m47-quality2-design.md`。

## 分組

- **G1（bench-mouse）✅** 6 條全過（本機數見 README/研究）：hover 10k 掃描 0.17ms、不變幀零字節、click/drag 16ms/100、滾流 113k ev/s 滯後 0、**選區 188 cells = O(viewport) 實證**、timeline 0.96ms；反直覺三發現吸收（grok clamp 洪水打破 pending 上限——grok 自己文檔丟棄、懸停登記視口範圍、rail turnAnchors 每幀×2）。
- **G2（live probe + lineViewer + chip）✅** /doctor **live 重探**（paint-suspend ≤800ms 無鎖死；查詢走 ledger；回覆經 parser onOsc/onDcs + unknown-CSI 路徑；merge 語義「已回答勝、未答保留」）+ openLineViewer → **light line-viewer**（引擎 block walk + unfold + Enter 跳視口）+ chip 單擊修復（chip 區先於 textarea——修複從 chip 行發起的誤拖動選取）。
- **G3（docs + 全量）✅**

## 執行發現

1. **ProbeClient 不可達**（tui-core exports 只露 probeCapabilities；attachInput 硬編碼 parser 無鉤）——live 解碼 = 自家鏡像語法（light-doctor 語法頁）；生產宿主 parser-hook 接線不在本 commit（apps/tui 範圍外——app 側機器+真 parser 測試完備）。
2. **無 block viewer 存在**（「viewer」皆 toast）——line-viewer 以 light panel 落地（最小誠實：標題=塊頭、24 行窗、Enter 跳視口）。
3. minimal-mode print-once 提交在 suspend 時故意不門控（文檔化）。
4. mouse.ts 納入 commit（chip 修復唯一落點）。
