# IH v0.1.18 分區程式碼審查清單

受查版本為 `codex/desktop-v0.1.18` 上的 `c6e4fe18`。下列是這個版本仍能重現的問題。優先級依使用者影響排列。P1 會執行錯誤的工作、使用錯誤的工作目錄，或讓已有資料無法操作。P2 會造成可觀察的延遲、資源滯留或功能失準。P3 的觸發範圍或影響較小。

共確認 **13 項**，其中 P1 有 4 項、P2 有 6 項、P3 有 3 項。三個子代理各自負責進程及工作區、會話及儲存、桌面前端；主審查再核對協議、上下文和工具，並將相同根因合併。

## 優先處理

| 編號 | 問題與觸發方式 | 實際影響與證據 | 建議修正與驗收 |
|---|---|---|---|
| 1 · P1 | **搬移工作區恰好遇上 Gateway 重連，會沿用舊目錄。** 子進程退出，500 ms 的重試計時器捕獲舊工作區物件。在重試前搬移工作區，若沒有執行中或啟動中的子進程，舊計時器會繼續。 | 用實際 runtime manager 和可記錄工作目錄的測試啟動器重現。搬移前後兩次啟動都是舊路徑，向 manager 查詢新工作目錄仍拿到舊連線。兩個目錄都存在時，後續操作有用錯專案的風險。[重連](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop/src/main/sdk-runtime.ts#L285) · [搬移](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop/src/main/worktrees.ts#L168) | 讓工作區失效操作一併作廢尚未執行的重試，啟動前讀回目前工作目錄。驗收要覆蓋舊目錄仍存在與已移走兩種情況，確認下一次實際啟動及取得的連線都使用新目錄。 |
| 2 · P1 | **重送已完成的輸入 A，會順帶執行尚待恢復的 B。** 在 B 是重開後唯一待處理輸入時，帶相同 `clientToken` 和內容重送 A。 | A 的原收據正確返回，但請求數從 2 變成 3，第三筆送往模型的文字是 B。未呼叫恢復。預設 JSONL 和可選 commit-log 都重現。[整批排程](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop-gateway/src/input.ts#L86) · [重用收據](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop-gateway/src/input.ts#L147) | 重送時以收據對應的輸入 ID 判斷是否仍需啟動。測試要同時證明 A 已完成時 B 保持等待，以及 A 本身仍排隊時可正確續行一次。 |
| 3 · P1 | **重開後，SDK 查不到、也無法取消已保存的排隊輸入。** 一輪執行中排入 B，關閉並重開，再透過桌面和 SDK 查詢同一會話。 | 桌面顯示 B 可恢復，SDK 的 `session/queue` 回空陣列、`session/status` 的排隊數為 0。用原 ID 呼叫 SDK 取消回傳 `false`，桌面卻可以取消。兩種儲存後端都重現。[SDK 查詢](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/sdk/src/server.ts#L662) · [SDK 取消](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/sdk/src/server.ts#L674) · [桌面讀取](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop-gateway/src/input.ts#L183) | SDK 與桌面共用持久化佇列的讀取和取消入口。查詢不能啟動模型，取消後再重開，B 應持續消失。可與第 2 項共用同一組冷啟動案例。 |
| 4 · P1 | **舊對話已從磁碟讀回，畫面卻沒有歷史訊息。** 早期 JSONL 中的事件以位置排序，未必逐筆帶有 `seq`。 | 在含 2 筆舊事件的格式 2 會話上，真正的 SDK 歷史頁回傳 2 筆，游標由 0 到 2；前端合併時只保留帶 `seq` 的事件，時間線為 0 筆。向前翻頁也有相同篩選。資料仍在磁碟。[頁面合併](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop/src/renderer/session/event-window.ts#L87) · [舊頁篩選](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop/src/renderer/session/use-history-scroll.ts#L76) | 在歷史頁邊界依頁面位置產生顯示用序號，保留持久化事件與暫時通知的區別。驗收舊格式、混合新舊事件、重疊分頁與重新連線。 |

## 效率、穩定性與資料正確性

| 編號 | 問題 | 實測範圍與影響 | 建議修正與驗收 |
|---|---|---|---|
| 5 · P2 | **已經顯示即時 Gateway 結果後，備用的磁碟掃描仍可拖住另一工作區及退出。** [桌面同時啟動讀取](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop/src/main/ipc.ts#L556) · [共用掃描佇列](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop/src/main/session-catalog-worker.ts#L25) · [退出等待](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop/src/main/session-catalog.ts#L38) | 用發行包的真實 worker 暫停 A 的一次檔案讀取。A 已顯示即時結果，B 的輕量導覽成功，但 B 的冷清單和退出均等到 A 被放行。400 ms 是刻意注入的等待，證明阻塞關係；一般電腦的關閉延遲仍待量測。 | 保留昂貴掃描的並行上限，合併相同工作區的要求，讓已無消費端的掃描可在安全邊界停止。驗收 A 的過時讀取不能擋住 B 和關閉流程，仍有人等待的掃描能完成。 |
| 6 · P2 | **長對話每次思考更新都重新投影整段已載入的歷史。** [投影入口](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop/src/renderer/app.tsx#L859) · [時間線分組](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop/src/renderer/session/Timeline.tsx#L138) | 用實際前端投影、排序和分組函式，暖機後量 70 次。502 筆事件的每次更新中位數為 0.31 ms，5,002 筆為 2.39 ms，20,002 筆為 10.28 ms，P95 為 13.67 ms。尚未包括 React 或瀏覽器排版。適用於正在串流思考的長對話。 | 已完成回合保留投影結果，活動中的推理只更新所屬回合。測試須保持最終事件取代預覽，並比較 500 和 20,000 筆歷史的每次更新成本。 |
| 7 · P2 | **開啟上下文原始記錄時，一次建立所有符合條件的列。** [篩選](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop/src/renderer/session/ContextSessionRecords.tsx#L26) · [整批建立列](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/desktop/src/renderer/session/ContextSessionRecords.tsx#L50) | 在 React 元件的伺服器端渲染量測中，500 個事件建立 400 列，約 27 ms；20,000 個事件建立 16,000 個 `details`、產生約 1.37 MB HTML，約 390 ms。這是開啟該頁時的成本，未量實際 Electron 排版。 | 對原始記錄使用分頁或虛擬清單。驗收同時檢查畫面掛載列數受限，且向前、向後與即時更新均可到達所有記錄。 |
| 8 · P2 | **commit-log 的冷會話每翻一頁都完整讀取當前日誌。** [快照入口](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/session-persistence/src/commit/coordinator.ts#L248) · [日誌讀取](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/session-commit-log/src/store.ts#L260) | 在未變更的 1,024 筆事件會話上，連續 6 次 `session/history`、每次 `limit: 1`，每次讀 2,418,570 bytes，合計 14,511,420 bytes。最小回覆 89 bytes。這次每頁耗時 11–66 ms。只在可選 commit-log 測出。 | 讓後端提供範圍讀取；以已驗證的日誌版本重用索引。驗收未變更頁面的實讀 bytes，以及並行追加、替換和刪除後的頁面正確性。 |
| 9 · P2 | **上下文壓縮保留尾段時，沒有計入下一筆請求確實會重播的原生推理文字。** [群組估算](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/context-engine/src/reduction/selection.ts#L29) · [請求估算](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/llm-openai/src/context.ts#L48) | 六個已完成交換，`retainTokens=50`。12,000 字元放在最新助手正文時，最新群組估 3,004 token，較早 5 組可選。等量文字放在該路由合法的 `reasoning_text` 時，已準備的請求對該元件估 4,022 token，但尾段只算 5，較早可選組變為 0。數字是 IH 對同一份資料的兩種估算。硬上限超出另有回退；主要影響提早壓縮與保留哪些回合。 | 使用此次目標路由可重播的元件來估算各群組，並重用該次請求的估算。測試同協議、換協議及未綁定的原生資料，不把目的地會捨棄的內容也算進去。 |
| 10 · P2 | **Chat 和 Gemini 已收到含用量的終止錯誤，但連線可能一直等呼叫端再讀一次。** [Chat 錯誤事件](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/llm-openai-compatible/src/stream/fold.ts#L36) · [Gemini 錯誤事件](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/llm-gemini/src/stream/fold.ts#L130) | 讓本機 HTTP 端送出同一幀的用量與錯誤，並保持連線開啟。兩種轉接器都在交付 `usage` 後保持連線，再取 `error` 才關閉。同一測法下，這次修好的 Responses 在交付 `usage` 時連線已關閉。主要影響暫停讀取的消費端。 | 一旦辨認終止幀，先釋放其 HTTP 回應，再按原順序交付用量和錯誤。用保持開啟的真實 socket 驗收，另驗正常流仍能收齊尾端用量。 |

## 較小但可獨立修復

| 編號 | 問題與證據 | 修正方向與驗收 |
|---|---|---|
| 11 · P3 | **相同工具參數只改 JSON 鍵順序，重複呼叫提醒便失效。** 使用實際掛載的 guard 連續傳 5 次相同讀檔參數。鍵順序固定時第 3、5 次共提醒 2 次，兩種鍵順序交替時提醒 0 次。[重複判定](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/guard-repeat-tool/src/index.ts#L60) · [掛載位置](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/session-executor/src/assembly.ts#L938) | 以物件鍵順序無關的表示比較合法 JSON，保留陣列順序。測試巢狀物件與真正不同的參數，不增加每次工具呼叫的大型序列化成本。 |
| 12 · P3 | **Code Mode 的截短預覽可能製造原文沒有的字元，並低估省略的 bytes。** 讓真實 worker 執行 `text("x🙂abcdef")`，設定 `max_output_tokens: 1`。原文 11 bytes，預覽回傳 `x�`，並回報省略 7 bytes。4-byte 上限內的有效原文前綴只有 `x`，實際省略 10 bytes。[文字截取](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/code-mode/src/runtime/limits.ts#L35) · [省略量](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/code-mode/src/runtime/output.ts#L253) | 在 UTF-8 碼點邊界截取，依實際保留的原文 bytes 計算。驗收中文、emoji、剛好切在邊界與零預算。 |
| 13 · P3 | **找不到會話時，兩種後端回傳不同的 SDK 錯誤。** 同一個不存在的會話，JSONL 的 `session/history` 回傳 `-32602`，commit-log 回傳 `-32603`。後者會使客戶端誤判為內部故障。[錯誤映射](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/sdk/src/server.ts#L412) · [儲存層錯誤](https://github.com/ivankwanpn/I-harness/blob/c6e4fe183da680012d6caa3d4c9c60d802e450cd/packages/session-commit-log/src/store.ts#L19) | 將兩種「不存在」映射到同一個公開結果，另保留損壞與權限錯誤的判別。 |

## 修復順序與範圍

1. 先處理工作區目錄及輸入恢復的身分歸屬（第 1–3 項），避免在錯誤目錄繼續工作、意外執行待恢復輸入，或讓使用者無法取消排隊工作。接著修復舊歷史的顯示位置（第 4 項）。
2. 先處理多餘掃描對其他工作區及關閉流程的影響（第 5 項），再分別量測前端投影、原始記錄面板與儲存層讀取（第 6–8 項）。DSH 的 `use-turn-data.ts` 按回合訂閱，OpenCode 的 `message-timeline.tsx` 依訊息及部件身分取資料，適合借用到第 6 項。第 8 項需要另外驗證日誌版本，單純改 UI 無法降低該項 I/O。
3. 第 9、10 項分別修共享估算及串流資源釋放。第 11–13 項可以獨立驗收。

本次涵蓋工作區重連、兩種會話後端、SDK 收據及佇列、歷史分頁、桌面時間線與上下文記錄、Responses／Chat／Gemini 串流、壓縮尾段選擇、Code Mode 文字輸出與重複工具提醒。重現使用隔離資料、本機供應商及編譯成品；前端效能項目明列量測到哪一層。先前回報的「完全閒置時或按關閉便卡頓」仍需在桌面進程採樣以確認根因。這份清單沒有把串流中的前端耗時當成閒置卡頓的證據。

同一批開發已交付 Responses 正文與原生續接修復。用實際 Windows 便攜包走公開 Gateway，四種回覆形式都經過讀檔、關閉、重開及下一輪請求驗證，共 40/40 項檢查通過。五種協議之間的 25 組重播亦通過。這些已修項目不計入上方待辦。[程式修正](https://github.com/ivankwanpn/I-harness/commit/c6e4fe183da680012d6caa3d4c9c60d802e450cd) · [該提交的 CI](https://github.com/ivankwanpn/I-harness/actions/runs/46131503059)
