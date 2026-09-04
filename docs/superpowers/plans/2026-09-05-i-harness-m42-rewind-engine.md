# M42 執行計劃 — Rewind 引擎

日期：2026-09-05 · spec：`docs/superpowers/specs/2026-09-05-m42-rewind-engine-design.md`。

## 分組

- **G1（引擎核心）✅** packages/rewind（store/recorder/service 32 測試）+ fs 寫管道 pre-image 報告（write/edit/apply_patch 精確鉤點；無 rewind 時位元組相同）+ assembly 掛鉤（subscribe: user/message→begin、turn/end→finalize+point；dispose 退訂）；session-executor 20/20、fs 54/54。
- **G2（投影）✅** core-session：`rewind/point` 事件 + deriveMessages cut 投影（重疊 meld、單調跳過、防禦；compaction 零改動）；84/84。
- **G3（docs + 全驗證）✅**

## 執行發現

1. **語義鎖定**：rewind-to-turn-T = 恢復至 T-1 終尾（撤 T 之後）——與 G2 cut 窗口（自 T 的 anchorSeq 起隱藏）一致。
2. **unTracked 定義**：target 後已記錄 turn 的路徑（不在 target 集）→ 列出不恢復；shell 單獨變更完全不可見（honest 註記）。
3. **截斷語義**：exclusive（T 撤銷）；mode files 永不截斷；had_errors 全保留。
4. `take` 同步 + 工具結果帶 preImageRef/isNewFile（blob 在 finalize 持久化——turn 內存集）。
