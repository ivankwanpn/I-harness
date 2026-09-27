# 圖片 admission 單份保存驗收（2026-09-28）

## 變更

新 Desktop／SDK 圖片提示先把完整 `ImageInput[]` 寫入 `agent/input/admitted`，升格的 `user/message` 只保存 `imageInputId` 和不含 base64 的 `imageSummaries`。模型投影依前序 admission 還原圖片；舊式直接 `Agent.run(..., images)` 和既有內嵌圖片日誌保持可讀。

SDK 的 `session/history` 和即時 `session/event` 對外顯示已還原的使用者圖片，並略去 admission 的圖片位元組。Desktop 事件窗口對舊 gateway 的 admission 圖片也會移除副本。只複製最近回合的子代理分支若切掉 admission，會在子會話的使用者訊息內嵌圖片；一般分支保留 admission 與引用。圖片檔名仍可經會話搜尋索引命中。

## 證據

- 結構與冷讀測試：新的 JSONL 只含每張圖片一次 base64；讀回後模型投影仍有圖片。SDK 分頁即使從 admission 後開始，也還原使用者訊息的圖片。十張圖片的 SDK 提交測試通過；第十一張的既有拒絕測試仍通過。
- 子代理最近回合分支、一般會話分支與 rewind 後分支測試保留正確的圖片內容；遺失 admission 的冷壞日誌明確報錯，不會冒充文字提示成功。
- 唯讀程式碼審查後修正了兩個邊界：SDK 對同一長會話的每頁圖片歷史不再重掃整個前綴（10,000 事件的重複讀取由約 10,002 次索引存取降到少於 50 次）；子代理把缺少 admission 的圖片內嵌到分支時，搜尋索引優先使用不含 base64 的圖片摘要。修正後全套單專案並行測試：70/70 專案、3611 通過、9 跳過、0 失敗；全庫 `pnpm typecheck`、E2E 5 檔 12 項、reachability gate 均通過。日誌：`D:\frontend-research\desktop-image-reference-review-*-2026-09-28.log`。
- 打包版 Electron 使用已配置的 DeepSeek 圖片模型，在 `D:\agent-complete\playground` 提交既有 512×512 紅色 PNG，回覆「主要顏色是紅色」。會話 `sess-muk0p3zr-lrpzha` 的原始 JSONL 為 6,598 bytes，2,672 字元的圖片 base64 只出現一次。SDK 歷史的 admission 無 `images`，使用者訊息有圖片；重啟程式後縮圖仍解碼為 512×512。測試會話已封存。畫面：`D:\frontend-research\desktop-image-reference-reopened-2026-09-28.png`。
- 隔離 Electron profile 的十張圖片壓力測試使用十張可解碼的 512×512 PNG（隨機 ancillary 內容，合計 21,360,320 字元 base64）；原始 JSONL 為 21,362,198 bytes，畫面十張縮圖全部解碼。一次量測中 renderer 工作集從 73,900 KB 升至載入後 265,036 KB、強制 GC 後 208,340 KB；CDP `Runtime.getHeapUsage.usedSize` 從 1,347,164 bytes 升至 GC 後 68,867,484 bytes。不同試跑的載入後工作集約 265–316 MB，不能把它當穩態保證。量測 JSON：`D:\frontend-research\desktop-image-heap-ten-2026-09-28.json`；截圖：`D:\frontend-research\desktop-image-heap-ten-2026-09-28.png`。隔離 profile 已清除。
- 最終打包版再次冷讀已封存的真實圖片會話：原始 base64 次數仍為 1，SDK 使用者訊息有圖片、admission 不傳位元組，重啟後縮圖 512×512 且原答覆仍為「紅色」。驗收後重新封存。畫面：`D:\frontend-research\desktop-image-reference-final-package-2026-09-28.png`。便攜 ZIP：`D:\frontend-test\packages\desktop\release\I-harness-Desktop-0.1.0.zip`，SHA-256 `472B213D457E29983A3D6D588BAC489C2E54409975484C49E9FD020CC1ADB90A`。

## 邊界

這輪證明了新提示在持久化與 Desktop 事件窗口不再保留兩份 base64；原始圖片仍須在模型請求與可見縮圖中使用。十張大圖片的 renderer 記憶體已有一次隔離量測，但沒有可比較的舊版本基準，也沒有定義產品的記憶體門檻。外部供應商的圖片接受能力仍按各模型的 `inputModalities` 設定；真實端點只驗證了此環境已配置的 DeepSeek 路由。
