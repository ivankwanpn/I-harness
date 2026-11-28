# IH v0.1.18 分區程式碼審查清單

受查版本為 `codex/desktop-v0.1.18` 上的 `c6e4fe18`。下列是這個版本仍能重現的問題。優先級依使用者影響排列。P1 會執行錯誤的工作、使用錯誤的工作目錄，或讓已有資料無法操作。P2 會造成可觀察的延遲、資源滯留或功能失準。P3 的觸發範圍或影響較小。

共確認 **13 項**，其中 P1 有 4 項、P2 有 6 項、P3 有 3 項。三個子代理各自負責進程及工作區、會話及儲存、桌面前端；主審查再核對協議、上下文和工具，並將相同根因合併。

## 後續修復與驗收

原始清單保留了 `c6e4fe18` 的重現條件。後續至 `167b891f` 的修復涵蓋全部 13 項，以下是採用相同入口及資料條件的驗收結果。

| 原項目 | 變更與驗收 |
|---|---|
| 1、5 · 工作區生命週期 | 工作區失效會作廢尚未執行的重連，重連前再讀目前目錄。A 已取得即時結果後，無人等待的磁碟預讀可以結束，B 的清單和退出可繼續。共用讀者仍能讀完。已取得儲存租約的實際讀取仍會安全釋放租約，底層檔案系統卡住時，這部分仍可能影響退出。[重連測試](../../packages/desktop/test/sdk-runtime.test.ts) · [掃描、取消與租約測試](../../packages/desktop/test/session-catalog.test.ts) |
| 2、3、13 · 持久化輸入與 SDK | 重送 A 的舊收據只會檢查 A。SDK 和 Desktop 共用冷佇列觀測，SDK 可依原輸入 ID 取消，第二次重開仍維持取消。在 JSONL 和 commit-log 都驗證了已完成、已取消、仍待處理三種重試及新輸入的先後順序。兩種後端都將「會話不存在」映射為 `-32602`。[公開收據與佇列測試](../../packages/desktop-gateway/test/cold-queue-receipts.test.ts) |
| 4 · 舊會話歷史 | 從真實 SDK 頁面復原舊事件的顯示位置。格式 2 的兩筆訊息均可見，新舊混合會話經重疊分頁及重連後各顯示一次。即時通知維持本來的身分。[歷史合併測試](../../packages/desktop/test/event-window.test.ts) |
| 6、7 · 思考串流與原始記錄面板 | 同一思考區塊更新時只改該列正文，缺口、順序變更、正式記錄到達時才重新投影。原始訊息每頁最多 100 個事件，可翻到較早、較新或最新頁。以 20,000 個事件測試，面板由一次建立 16,000 列降至 80 列，80 次思考更新只建立一次完整時間線。[投影測試](../../packages/desktop/test/live-reasoning-projection.test.ts) · [面板測試](../../packages/desktop/test/context-session-records.test.tsx) |
| 8 · commit-log 翻頁 | 初讀驗證整份日誌，後續在同一版本的已索引範圍內只讀頁面及其依賴的原始 bytes。索引有大小上限，可移至其他範圍。在 20,004 筆會話上連讀 10 頁，包含一次遠距跳頁，完整讀檔由 10 次降為 2 次，其餘 8 次各讀 28–147 bytes。若檔案系統無法可靠識別版本，會回到完整讀取。建立或重建索引仍需完整驗證，並須在檔案身分或內容改變後重新檢查。[版本替換、並行追加、圖片與翻頁測試](../../packages/session-persistence/test/commit-history-pages.test.ts) |
| 9 · 壓縮保留成本 | 各協議在準備原始請求時記錄實際重播的推理成本及所屬助手訊息。壓縮直接使用這些數據。測試中短段落佔 6 token，受保護的後一段佔 8,196 token，兩者分開歸屬。換協議、覆寫輸入或缺少可靠來源時維持保守的估算。[五種協議的歸屬測試](../../packages/provider/test/replay-unit-ownership.test.ts) · [實際壓縮選取](../../packages/compaction/test/route-tail.test.ts) |
| 10 · HTTP 串流 | 四個 HTTP 轉接器共用終止幀的釋放流程。Chat 與 Gemini 同一幀包含用量與錯誤時，呼叫端停在 `usage`，伺服器仍能觀察到連線已關閉；繼續讀取時仍會收到原錯誤。[真實本機 HTTP 測試](../../packages/provider/test/stream-disconnect.test.ts) |
| 11、12 · 工具與 Code Mode | 讀檔參數只改鍵順序時仍算同一個呼叫，舊與受管執行路徑使用同一項判斷。實際執行 5 次，模型在第 3、5 次後收到提醒。Code Mode 依 UTF-8 碼點截取：`x🙂abcdef` 在 4-byte 上限產生 `x`，正確報告省略 10 bytes。[受管工具測試](../../packages/session-executor/test/managed-runtime.test.ts) · [Code Mode 測試](../../packages/code-mode/test/runtime.test.ts) |

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

## 多專案 Windows 使用流程複核

以 `61b57fc1` 的 Windows 便攜版為基準，在隔離設定檔註冊 4 個專案與 12 份會話，分別跑空歷史、合成長歷史和之前透過本機模型與工具實際產生的歷史。最後一組含兩份約 6 MB、各 874 回合的日誌。空與滿兩種測試使用相同的桌面及 Gateway 入口。供應商是本機 HTTP 服務，測試不讀取個人對話或使用模型額度。

| 問題或觀察 | 複核結果與處理 |
|---|---|
| 關窗時若要儲存新的視窗尺寸，主程序會等磁碟操作完成才隱藏視窗 | 在原封裝主程序的設定檔改名操作注入 200 ms 等待，舊版約 215 ms 才隱藏。現在先在視窗仍可讀時擷取尺寸，背景依序原子寫入。設定變更只在寫入成功後確認，明確退出時等最後一次寫入完成。另一筆寫入失敗不會阻止以後儲存。[視窗與寫入](../../packages/desktop/src/main/native-window.ts) · [關窗時暫停磁碟的回歸](../../packages/desktop/test/native-preference-close.test.ts) |
| 收合側欄或將視窗收到系統匣時仍會讀取專案列表 | 24 個專案、2,880 筆會話歸屬資料的案例，收合啟動由 24 次導覽查詢降為 0。隱藏期間同一工作區連續變更並重連，讀取由 1 次降為 0；重新顯示時只更新該工作區一次。舊回覆晚到不會把已移走的會話放回舊專案。[工作台回歸](../../packages/desktop/test/idle-project-sidebar.test.tsx) |
| JSONL 每查一份會話標頭，都要求讀取 64 KiB | 標頭改由 1 KiB 開始，視長度逐步擴大到原上限。單一 12 會話工作區的暖列表及導覽合計由 2,359,296 降為 36,864 bytes；未連線的預覽由 1,572,864 降為 24,576 bytes。超長標頭、短讀與跨區塊 UTF-8 仍受驗證。[標頭測試](../../packages/session-persistence-jsonl/test/header-limit-read.test.ts) |
| 可選 commit-log 為列表反覆重開相同日誌 | 用同一次已驗證的列舉取得顯示標頭與摘要。重複列表由 5,923,518 降為 1,974,506 bytes；已連線導覽由 6,026,838 降為 4,052,332 bytes。後者保留獨立的專案歸屬與可見性檢查，同大小替換、損毀及等待寫入時版本改變都另有驗收。[完整性與並行測試](../../packages/desktop-gateway/test/session-catalog-integrity.test.ts) |

參考項目中，OpenCode Desktop 會在關窗時擷取位置並於視窗關閉後處理持久化；DSH 的 JSONL 列表則分開管理檔頭與完整會話。IH 的桌面還需要保留有活動工作的隱藏視窗，commit-log 也需要驗證當前日誌及歸屬，因此各自保留原有的關閉和一致性條件。

**閒置與送出應分開判讀。** 在上述實際長歷史基線，Windows 前景程式依正式設定連續閒置約 246 秒，未送出模型請求。每 50 ms 量測一次，共 4,921 次，最長間隔約 66 ms。約 241 秒時第一次採樣到工作區 Gateway 已退出，正常關窗至退出為 255 ms，已追蹤的子程序均已結束。這個隔離環境沒有重現持續閒置時的卡頓。首次打開長會話內容約 1.44–1.53 秒，送出到本機供應商收到請求約 2.30–3.66 秒；首段文字抵達至畫面顯示約 24–26 ms。兩次樣本只用來區分等待發生在哪一段。

**仍待改善的是長歷史送出前的等待。** 在隔離 Gateway 上，約 6 MB 的首次恢復包含七次完整性複驗，該次合計約 205 ms，分布在不同持有權與狀態邊界。另一個實驗嘗試將已驗證索引暫留給緊接著的請求，七組配對的完整流程中位數由 3,123 降到 2,883 ms，但其中兩組慢了 156 和 642 ms，單純瀏覽額外保留約 4.17 MiB 記憶體最長 2.5 秒。最終版保留原有驗證與保留期限，未採用這項實驗。
