# M41b 執行計劃 — Wire v1.1 附錄

日期：2026-09-05 · spec：`docs/superpowers/specs/2026-09-05-m41b-wire-v1-1-design.md`。

## 分組

- **G1（sdk 四方法 + 行豐富）✅** session/cancel（每-session AbortController 槽）+ rewind 三方法（rewindFactory → 真 RewindService）+ capabilities 兩行（protocolVersion 維持 2）+ CLI list 行豐富（updatedAt=touch mtime/createdAt fallback、turnCount=coordinator.load）+ 36/36 + cli 88。
- **G2（tui remote + DA1）✅** 能力 gating（hasCapability；cancel 真 wire / rewind 有條件）+ eager initialize + DA1 查詢（WT_SESSION 壓過 DA1 提示）+ 20/20 + probe 12/12 + tui 300。
- **G3 補（輪尾真缺口）✅**：**in-flight cancel 達引擎**——lane 每-submit signal 轉發（turnSignals Map + service 直通）；原 G1 測試假設「cancel 只停隊列」被新語義推翻 → 更新為真實引擎中止斷言；core-agent +58。

## 執行發現

1. **真 in-flight abort**（G1 誠實上報：「service.submit 的 signal 只護隊列」）→ 輪尾修：executor 每-input signal Map + pump 轉發 agent.run；service.lane.submit 直通——**embedded 與 remote 的 cancel 都升級**。
2. **cancel 語義變更**：running turn 現在真被中止（submit 以失敗+abort 收場）——G1 舊測試「turn completes afterwards」改寫（服務端 queued-gate 語義單測仍在）。
3. DA1：WT_SESSION 環境壓過 DA1 提示（誤判防護）；DA1 永不提早結束（kitty/wezterm 同答 1;2）。
4. list 行：updatedAt = 工件 mtime（meta.createdAt fallback）；無 count() 匯出——coordinator.load 為唯讀路徑。
