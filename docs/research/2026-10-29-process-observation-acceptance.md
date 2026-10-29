# 原始會話觀察與結果讀取：主線整合驗收

本機主線 `cd2d52c414069c94ab398cc21dbc755fe294b077` 已整合受審 CURRENT 範圍至 `2e5a2cbe`。這一範圍提供真正的 JSONL／managed 會話觀察、原操作變更追蹤、可見結果索引，以及一般 SessionService 和桌面 native injected service 的原始讀取接合。**生產 host 建構入口、背景輸出選取／介面，以及完整 J4 和版本驗證仍未完成。**

## 已接合的行為

真正 JSONL 工廠持有 backend 的原始關聯；新的 composed coordinator 建構入口使用原本的 coordinator、文件與 managed owners。一般自訂或複製的 backend 不會因為聲稱相同 ID 就取得最佳化能力。冷觀察保留原始檔案、每條父目錄及選定文件的見證，最後只進行一次驗證與資源關閉。Windows 原生身份使用精確 BigInt 資料，拒絕被替換的父目錄、檔案、namespace 或 tombstone。

排入佇列與實際寫入的追蹤在非同步等待前開始，保留於原始工作、pending frame 與原始恢復流程。重試不會為同一筆未完成工作無界累積額外追蹤。managed 観察可消費真正已安裝的增量；work 最後等待期間追加的內容由唯一的 finish 交付，沒有提前要求增量已耗盡。發布階段可以作最後的可見性與 currentness 檢查，但不能再開始 artifact page IO；即使呼叫者捕捉拒絕，也不能發布舊的快取候選。

可見結果索引保留既有七欄完整引用比較、重複出現次數，以及原始非單調 rewind 的實際合併語意。它不取代 source、profile、project、pin 或 catalog 的原始檢查。兩條真實服務路徑都使用原工廠建立的受檢服務與頁面 lease；活躍觀察中不會退回逐頁歷史掃描，也不會從其他共享註冊取得讀取身份。

## 主線固定來源驗證

Root 在合併後依序執行四組測試與各自型別檢查，每次使用六個新的隔離根目錄、既有直接 Node／Vitest／TypeScript、maxWorkers=2/minWorkers=1/無檔案並行。

| 範圍 | 主線結果 |
|---|---:|
| JSONL cold／managed composed、原始檔案與父目錄 | 36 通過 |
| persistence 原操作、重試、managed 後綴與生命週期 | 22 通過 |
| executor 真正 standalone 結果服務與 reader 生命周期 | 27 通過 |
| gateway 真正 native injected 服務與結果頁 | 30 通過 |
| 上述四套型別檢查 | 全部 exit 0 |

合計 **115 項測試通過，無跳過**。八次執行的前後來源雜湊不變，與合併後實際工作檔案相同；48 個根目錄互不相同。四個套件的最終內容與受審 `2e5a2cbe` 完全相同。這是明列來源／測試的檢查範圍，不宣稱完整第三方傳遞閉包。

收據及精確命令在 `.superpowers/sdd/2026-10-29-process-source-root/evidence/`；`qualification.json` 記錄八次結果、來源數量、零當前雜湊差異及根目錄唯一性。原始審查／修復證據在 `2026-10-27-execution-surface-observation` packet，最後一份範圍複核為 `process-read-publication-phase-review-20261029.md`。

## 成本與支援範圍

兩條真實服務的受控正例各讀三頁 catalog member：觀察見證初始／最終各一次、一次 journal decode、一次 visibility index，沒有額外 snapshot；native 的 `visibleRefsFor` 為零。這不表示整條路徑只有兩次實體讀取：1318-byte fixture 的 standalone profile 讀取為18次／23724bytes，native為24次／31632bytes；catalog、pin、membership、namespace 的實際 IO 另存，尚未完整計數。managed setup 另有有界 raw-header domain read。大型會話與實際 inspector 的成本仍須後續驗證。

目前最佳化域限定為目前格式、無 semantic bootstrap 或非空繼承 seed 的普通會話；一般 lineage-only 的無 seed／零 seed 子會話可用。這沒有擴大舊格式轉換或繼承來源的權限。仍保留已在修正前基線重現的 structural-fork `firstSeq` 預期0／實際2失敗，未降低斷言或以其他測試通過代替修正。

主線未切換生產 host constructor，沒有以內部 API 驗收宣稱介面或整個版本完成。版本仍0.1.13-rc.1／Session13；沒有發佈或推送。
