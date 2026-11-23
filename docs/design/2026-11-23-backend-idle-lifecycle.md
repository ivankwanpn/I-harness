# Desktop 空閒與退出時的程序設計

## 程序邊界

DSH v0.2.3-alpha.2 的 Electron shell 管理一個 Desktop Host 子程序。建立會話時，Host 從 workspace registry 找出專案路徑，顯式傳入 cwd。退出前有專用的查詢，只看執行中的 Agent、工作、以及已載入會話中啟動的提醒。[Host 啟動](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/apps/desktop/src/host-process.ts) · [退出檢查](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/apps/desktop-host/src/quit-inspection.ts) · [會話建立](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/api/session-controller/src/commands.ts)

IH 的 Electron 主程序管理視窗和 Gateway 生命週期。每個 workspace 的 Gateway 啟動時已固定 cwd、會話資料目錄和 writer 鎖，工具、專案權限和執行中的會話也屬於這個工作區。兩個工作區可以有相同的 session ID。這次採用 DSH 的退出查詢方式，並保留 IH 的工作區隔離。若將來合併 Gateway，要先把工作區身分傳到儲存、鎖、檔案權限及取消操作的每個入口，再驗證一個工作區退出或故障時其他工作區能繼續運作。

## 已定位的成本

| 原來的路徑 | 調整 |
| --- | --- |
| 顯示中的側欄每五秒讀清單和歸屬，即使沒有新的會話事件 | 用會話事件更新；切回視窗時核對外部變更 |
| 每個 Gateway 每秒同步三個設定消費端，會反覆讀取同一個設定檔 | 監看設定變更，合併同時到達的事件；監看覆蓋失效或同步失敗時重試 |
| 關窗和回收共用完整會話清單，且兩者的忙碌判定不同 | 新 Gateway 以單次活動查詢核對執行、終端、工作、互動等原始狀態；舊 Gateway 走一致的相容判定 |
| 同一台桌面的其他工作區持續有活動時，閒置 Gateway 的回收結果也會作廢 | 按工作區及程序世代校驗回收結果 |
| 冷會話清單在 Electron 主執行緒重播歷史 | 每個桌面程序按需使用一個共用的唯讀 worker；由主程序確認資料根及管理關閉 |
| 關窗前要等遠端查詢，重複退出可能越過清理 | 視窗先回應關閉操作。重新顯示可撤回舊決定，退出期間共用同一次清理 |

使用者關窗時若仍有工作或無法確認狀態，桌面保留這次關閉意圖。視窗收起期間每三秒再核對一次，各次查詢依序執行。所有 Gateway 確認閒置後才退出。重新開啟視窗會取消待執行的檢查。這涵蓋兩個長會話都已顯示最終回覆、輸入服務仍在完成最後寫入的時段。

## Windows 隔離測量

同一台機器交替啟動基線版 `7679e4b0` 和包含上述改動的候選版，各三次。使用兩個已連線的工作區、一筆 700 回合的會話。等待約 13 秒後，將一份尚未快取的 22.8 MB、1,400 回合測試紀錄放入該工作區，再透過桌面正常入口關窗。由外部 Windows 視窗觀察器記錄視窗消失時間，另外等待 Electron 退出。

| 指標 | 基線 | 候選版 |
| --- | ---: | ---: |
| 視窗消失，中位數（範圍） | 205 ms（202–209） | 20 ms（17–35） |
| 程序退出，中位數（範圍） | 539 ms（520–660） | 333 ms（306–433） |
| 單 Gateway 空閒五秒的設定檔讀取次數，獨立量測 | 20 | 0 |

另一個隔離案例在 Electron 44.11.5 上讀取 22,911,698 bytes 的現行格式 JSONL。直接查詢耗時 667 ms，主執行緒的最長心跳間隔為 91 ms。首次透過 worker 查詢耗時 831 ms，最長間隔為 26 ms；快取查詢耗時 7 ms。worker 的主要收益是主執行緒可繼續處理視窗與 IPC。第一次完整讀取和建立 worker 都有成本。

## 執行環境與剩餘結構成本

開發、CI 與 Windows CLI 安裝器以 Node 24.22.3 為基準。桌面 Gateway 使用 Electron 內建的 Node，更新 Electron 才會改變使用者實際執行的版本。程序量測包含程式和執行環境的整體變更；設定讀取次數及關閉 RPC 可單獨驗證。

多個使用中的工作區仍各自持有一個 Gateway。全域供應商設定另有一個按需啟動的配置 Gateway。後續若要降低常駐記憶體，最小可驗證的候選是縮小全域設定服務的組裝範圍，先量測打開與關閉設定頁時增加的程序、記憶體及啟動時間。
