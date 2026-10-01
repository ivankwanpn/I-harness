# IH Desktop 子代理獨立介面驗收 — 2026-10-01

## 範圍與交付

在 `D:/frontend-test`、`codex/desktop-workbench` 實作，前一 checkpoint 為 `e70707a0`。依使用者要求，子代理不再加入一般 session 列表，改從父會話頂部「子代理」按鈕及右側專用頁查看。設計同時參考最新 DSH Desktop 與 ZCode；[DSH 實際操作報告](2026-10-01-dsh-desktop-observation.md) 記錄了真實點擊、自測與觀察。

- 名單顯示一般子代理、Team 成員及巢狀歸屬，包含狀態、角色、模型、結果與不可用原因。
- 查看子會話保持父會話身分，提供麵包屑／返回名單和唯讀 Timeline，不掛載普通 Composer 或誤報「尚未選擇模型」。
- 控制由父會話執行，依當下精確 runtime owner 提供續派、訊息、中斷與關閉；Plan Mode 拒絕續派／訊息。
- 保存記錄在重啟後可讀，讀取不建立 Agent、不呼叫模型。冷啟動續派未提供，介面明示其原因。
- 普通列表、dashboard、搜尋與封存列表隱藏 subagent／approval-review；使用者會話及普通 fork 保留。
- 單一損壞子會話顯示不可用，健康兄弟會話仍可讀；不替原始 log 重新編號。

## 實際缺陷修復

### Team 讀取造成子會話序號損壞

使用者的原始 `child-652e1c33-1d80-4c5b-8d5e-64fd1daa6ae7.jsonl` 出現 `event 5 has seq 3`。觀察到活躍 writer 尚在串流時，Team scheduler 的子會話讀取使用 `coordinator.load()`，導致 crash-recovery 提前寫入無序號的 step/turn closers，之後 live writer 又接續原本 seq。

producer 改成唯讀 snapshot；沒有唯讀能力就拒絕，沒有 load fallback。真實 JSONL 回歸覆蓋普通／Team 並行、streaming 中讀取、resident followup、重啟 strict load。原始使用者損壞檔案保留，沒有修改 invariant。Team 生成角色在 mount 中暫時註冊供 resident rebuild 使用，卸載移除其精確定義；不覆蓋既有自訂角色。

### CLI 持久化收尾

TaskRegistry 的 save chain 位於 coordinator queue 上游；原本 close 可能先結束，再由上游提交寫入。新增 task save drain 與 notification drain，assembly disposal 等待 producer，CLI 的最後 coordinator close 在 disposal 後。延遲儲存及通知回歸檢查晚到資料寫入；沒有延長刪除重試來掩蓋問題。

背景命令 promotion 測試改為等待真實 ExecService job 的 completed/exitCode 0，才移除工作資料夾。原本 marker 檔比程序 close 提早，阻塞式 rm 重試無法取代等待程序關閉。

## 驗證紀錄

完整 `pnpm verify:all` 在凍結來源後通過：

| 項目 | 結果 |
| --- | --- |
| Tests | 4,039 通過、10 略過、0 失敗 |
| Project population | 70/70 回報 |
| Typecheck | 通過 |
| E2E | 通過，5 個檔案 |
| Reachability gate | 通過；既有一筆無命中 allowlist warning，未豁免任何新項目 |

完整紀錄：`D:/frontend-research/ih-cli-shutdown-final-verify-2026-10-01.log`。此前失敗的兩項 CLI cleanup 已由 producer／程序收尾修復；完整 CLI 305 通過、1 略過，相關 runtime 331 通過。

獨立 review 與回歸驗證包含 parent lineage、unrelated/fork/reviewer 拒絕、原始 sequence-corrupt bytes 保留、精確 SID/path 權限、Plan Mode、cold read 零模型啟動、晚到 renderer 回傳、重複操作鎖、失敗草稿保留及多資料夾 project scope。renderer 名單與 transcript 回歸使用真實 Timeline 投影；只替代 JSDOM 無法測量的虛擬視窗。

### 真實打包版 Electron 驗收

使用下列實際 EXE、隔離 config/userData 與真實 JSONL 記錄進行操作。providers 為空，沒有付費請求；測試 app 已關閉並清理其臨時目錄。來源在驗收期間保持凍結。

| 項目 | 結果 |
| --- | --- |
| 主會話過濾 | 只有 parent 和普通 fork；一般／Team／nested／reviewer 及 reviewer descendants 未混入 |
| 頂部入口與返回 | 按鈕打開專用 pane；開子代理、返回列表後仍是父會話 SID |
| 保存 transcript | 一般、Team、nested 可讀；nested 麵包屑正確 |
| 冷啟動權限 | 沒有普通 Composer、模型選項、續派／訊息／中斷／關閉按鈕 |
| 損壞隔離 | fixture sequence-corrupt sibling 顯示 unavailable／讀取失敗，健康子代理仍可讀 |
| 原始 bytes | 測試及 app 關閉後不變；SHA256 `c48445c2e8abbad56f610a8fbefbdc3286d0e3177562782e64b2daba225dabe6` |
| 窄視窗 | viewport 882 px、pane 372 px；document/pane 無水平溢出，card 未超出視窗 |
| Renderer | 沒有 pageerror |

QA script/log：`D:/frontend-research/ih-subagent-surface-packaged-qa-2026-10-01.mjs` 與同名 `.log`，exit 0。截圖 `ih-subagent-surface-{catalog,transcript,lineage,corrupt,narrow}-2026-10-01.png` 存於同一目錄。已直接查看列表與窄版截圖。原始使用者 log 的精確損壞樣式另由 gateway JSONL regression 覆蓋；原生 QA 使用隔離 fixture，不改使用者檔案。

## 套件

打包成功，使用新 release 路徑，保留使用者可能正在開啟的先前套件：

- EXE：`D:/frontend-test/packages/desktop/release-subagent-surface-2026-10-01/I-harness Desktop/I-harness Desktop.exe`
- ZIP：`D:/frontend-test/packages/desktop/release-subagent-surface-2026-10-01/I-harness-Desktop-0.1.0.zip`
- SHA256：`8310A5AE95CFE9703014F7AB7B05F6049C4486093BBF5CF830AB2819D836DCE8`
- Build log：`D:/frontend-research/ih-subagent-surface-delivery-build-2026-10-01.log`

## 邊界與後續

- 原有 sequence-corrupt 測試會話未修補；使用者可另行刪除不要的測試記錄。
- Child transcript 顯示最近最多 4,000 筆並提示範圍；完整 durable 記錄保留。
- 冷啟動子代理只能檢視；自動重建與續派尚未交付。
- 其他提供商的真實模型協議验收仍需其設定；目前已知 IH 的兩條 DeepSeek 協議可用。
- 子代理用量／耗時與完整角色建立管理仍在 [介面缺口清單 U08](2026-10-01-desktop-ui-gap-checklist.md)。
- 提醒維持使用者要求的暫緩狀態。
- 使用者表示 IH 沒有 DSH 的 Agent 預設／模式；本輪沒有加入這個功能或頁面。

沒有修改 `D:/I-harness-main`，使用者原有 `packages/desktop/electron.vite.config.ts` 變更保持未納入提交；沒有推送遠端。
