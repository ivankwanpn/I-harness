# M40 執行計劃 — 缺口收割輪

日期：2026-09-04 · spec：`docs/superpowers/specs/2026-09-04-m40-gaps-design.md` · 取捨：#5→M41a、rewind→後續核心輪。

## 分組

- **G1（後端接線六件）✅** A1 todo_write 掛載 / A2 apps-cli pluginRegistry+jobKillBridge / A6 settings/changed emitter（+休眠偵測分支修復）/ A7 guardian breaker 全判定 / B8 read_image 工具 / B8b 文檔訂正。
- **G2（TUI 五項）✅** A3 toast 渲染（case-012 預算 13→14）/ A4 context 真值（token-meter + activeTokens + total=contextWindow）/ C11 滾動（**「1106」=轉錄錯誤**——誠實落地 1015 urxvt + 1016=1006 同構註記 + wheel 事件此前被丟棄 → 路由修復 + scrollBy follow-aware 真 bug 修復；case-018 預算 8）/ C12 mermaid Unicode art（flowchart 子集 + fallback box + 閉合 fencing 掛鉤）/ C13 plan-review 適配（plan→approve/comment/quit 動作條；case-019 預算 9）。
- **G3（docs + 全驗證）✅** README/B60 行 + 全量。

## 執行發現

1. **A6 死分支（真 bug）**：store 級偵測把 reload 後的 `this.current` 與自身比較——永遠不觸發；修復=重載前快照 `before`。
2. **C11 規格轉錄誤**：無 mouse 1106；落地 1015（urxvt 分隔）+ 1016=1006 註記；並修復「wheel 事件被丟棄」+「scrollBy 從尾一牙直接跳頂」兩真 bug。
3. **case-012 預算 13→14**（toast 桌面落地——「Press again to quit」卡現在可見）。
4. G1 編譯註記：A2 v0 觀察限制（無全局 MCP 集合時 plugin MCP 評價 failed——接縫注記）。
