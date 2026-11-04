# 剩餘重設計清單（2026-11-05）

這份文件只列**尚未實作、且需要跨模組設計**的四項。其他審計項目（S-01～S-07、S-09、S-10、NG 系列、A-01～A-12 的大部分、D-01 steps 1–4f、D-05、D-07）已完成並有測試／覆核記錄，見 `2026-11-04-fix-progress-checkpoint.md`。

---

## 1. S-08：fork 的原子發佈

**現狀**：fork 先在 child header 寫 reservation，再分階段 append seed／completion frame；`list()` 已排除 0-byte 半成品（`53ea918e`），但「有 header、尚未完成 seed」的 child 仍會出現在清單。

**已完成**：zero-byte 過濾 + 測試（`list-incomplete`）。

**待做**：
- 方案 A（建議）：fork 先寫入 `<id>.forking`（或 `.pending`）暫存檔，完成 seed＋bootstrap＋initial input 後 `rename` 成 `<id>.jsonl`；`list()` 自然只看得到完成品。
  - 需要 `fork-controller` 的 targetSessionId 與檔名解耦，或 backend 增加「fork 專用的 publication name」。
- 方案 B：在 header 寫入 `bootstrap.completedAt`，完成後才更新 header；`list()` 對有 `semanticSeed` 的檔案讀 header 並過濾。成本是每個 forked session 一次 header 讀取。
- 測試：在 reservation 與 seed frame 之間注入失敗，斷言 `list()` 不含半成品、重開後可 resume 或明確 rejected。

---

## 2. A-12：WSL worker 重用

**現狀**：每個 execution 重新 spawn `wsl.exe + python worker`；distribution 檢查已 per-backend 快取（`de99ee29`）。

**待做**：把 `WorkerClient` 的單一 workload 協議改成可重用：
- worker 端 loop 接受 `prepare → commit → output → settled` 多輪；
- 每個 workload 有獨立 output framing／cancel token；
- idle worker 回收與崩潰偵測；
- 保留 bounded memory 與既有 frame 驗證。

**前置**：需要一份協議版本（v2）與相容性策略；現有單一 workload 路徑保留為 fallback。測試用 fake transport 計數 spawn 次數（連續兩次 prepare 只 spawn 一次）。

---

## 3. D-01 最後一步：移除可變 task document 寫入

**現狀**：job record 雙寫、recovery 優先、document 重建、legacy fallback、owned 唯讀降級、write-behind coalescing、write intents 都已完成；task document 仍是可變寫入來源（strict／owned v3 尤其）。

**待做**：
- 讓 desktop catalog／projectTasks 改讀 job record（或 document 只作 projection，延遲寫入）；
- required settlement／v3 parent 契約改以 child session + job record 為依據；
- 移除 `TaskPersistence` 的 strict 寫入或將其降為 compaction；
- 補 e2e：document 完全缺失時，registry 仍可從 job record + child session 啟動（legacy 已可，owned 需 fallback 或明確 degraded）。

**風險**：v3 parent assertion 與 owned write ownership 是同一組 witness；需要先分離「ownership proof」與「task projection」。

---

## 4. D-12：agent-team 測試 harness 遷移

**現狀**：`ownedTeamFixture` 仍用 legacy coordinator；`acknowledgement-settlement` 等測試在 backend 建立後覆寫 `appendOwnedBatch`／`reconcileOwnedBatch`，composed backend 的 canonical-path guard 會拒絕，造成 timeout。

**已完成**：證明 composed coordinator + action wrapper 本身可正常送出 team message；`composed-team-write` 2/2 固定了邊界。

**待做**：
- backend 增加 pre-bind seam：`wrapOwnedBatch`（已有）＋`wrapOwnedReconcile`（2026-11-05 已補，含 `backend-wrap-hooks` 測試）；
- `ownedTeamFixture` 接受 control hooks，測試改用 hook 記錄 batch／注入 unknown outcome，而不是事後覆寫 backend；
- 逐檔遷移 agent-team 測試；剩餘 `FACT_INVALID_GROUP` 需逐案確認是 fixture 前置狀態還是產品組合問題。
- 先前實驗曾到 20/37；建議以 `acknowledgement-settlement` 為第一個全綠目標。

---

## 建議順序

1. S-08 方案 A（最小、可測試、不影響 write ownership）
2. D-01 最後一步（產品價值最高，但風險也最高）
3. D-12（純測試基礎，可分批）
4. A-12（效能，需要協議版本）
