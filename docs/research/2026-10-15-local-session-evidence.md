# 2026-10-15：原事故 Session 的本機唯讀核實

使用者確認事故資料位於目前電腦後，於 2026-10-15 香港時間核對原始 Session、Desktop 診斷及獨立用量紀錄。本次沒有執行 live provider 請求、重播會話、修復／升級原檔、啟動已安裝程式，或更改設定與憑證。

## 同一份事故資料

原檔位於 `%APPDATA%/I-harness Desktop/sessions/12b92a07-138c-419e-8b1a-ea5085154565/desktop-draft-9841878024a884b88301cf78ca92f1aa6bfe2ff991a21733ba0ea5d1cb6a6e9b.jsonl`。

- 長度 **5,188,017 bytes**；SHA-256 **`e987274691777110a2546bda6eb8120a181f40687edb82887f1253666aa88870`**，與[原調查](2026-10-14-model-http400-design-audit.md)完全相符。
- 3,283 個非空 JSONL 行：format 1 header 及 3,282 事件。394 個 step/start 與 394 個 step/end、386 個 assistant/message、462 個 tool/call 與 462 個 tool/result。沒有 compaction／rewind 事件。
- 保存的模型選擇為 `deepseek`／`deepseek-flash`、reasoning effort `max`。原檔最後修改時間為 2026-10-14 17:20:45.587 HKT。
- 目前分支的純 `fromJSONL`／`deriveMessages` 能讀取完整 3,282 事件並投影出 918 messages。純匯入只在記憶體轉成 format 2，沒有寫回原檔；匯入前後檔案雜湊相同。沒有舊版未曾保存的 owned budget／recovery checkpoint 可供還原，不能由此宣稱恢復出事故時的實際 request。

## 找回獨立用量紀錄

`%USERPROFILE%/.i-harness/usage-stats/records` 存在。使用目前產品的 `validateUsageRecord` 驗證內容，並核對檔名等於紀錄 ID 的 SHA-256；本輪掃描 3,593 檔，沒有無效或身份不符的檔案。以原 Session ID 精確匹配到 **395 筆：387 completed、8 failed、0 cancelled**。這是請求紀錄數，不應直接等同 Session step 數。

事故前最後一次成功請求 ID 為 `b054fdc4-e7ac-4c40-acab-251713ac02fc`，開始於 **2026-10-14 17:18:05.074 HKT**，歷時 10,082 ms：

|欄位|保存值|
|---|---:|
|inputTokens|162|
|cacheReadTokens|760,448|
|cacheCreationTokens|0|
|inputTokenSemantics|excludes-cache|
|實際總輸入 input + cache read + cache creation|**760,610**|
|outputTokens|587|

這是供應商使用量經既有 adapter 保存的 input semantics，包含 cache read，不能只把 162 視為整份輸入。上述計算與現有 usage-stats 聚合規則一致。

隨後四筆 failed 請求開始於 17:18:15.721、17:18:37.486、17:19:27.917、17:20:39.080 HKT；均沒有保存 token 計數／request metrics。對應 Desktop `session/error` 紀錄仍是 `http_400`／HTTP 400，沒有安全 structured modelFailure、上游拒絕內文或 runtime close facts。

本機診斷檔目前共 1,295 行，其中 803 行精確匹配原 Session。這比舊調查的整檔行數多，不能把整份診斷檔說成與舊副本逐位元相同；四次目標失敗的時間與原調查吻合。

## 可以成立的結論與限制

1. 使用者指的原始 Session 確實位於這部電腦，並且與文件使用的事故 transcript 完全相同；其 JSONL 可完整解析，不能將反覆請求失敗直接描述為檔案損毀。
2. 找回的最後成功請求有 **760,610 input tokens**。這補上原調查尚未取得的實測資料，並確認舊歷史估算器不能代表供應商的實際輸入。原文的 437,837／43.8% 是最終歷史的中性粗估；它與本筆最後成功請求的時間及投影界線不同，不應假裝是同一 payload 的兩個精確讀值。
3. 四次失敗沒有供應商 body，仍無法在 context overflow、輸出／request 限制、訊息／簽章／schema 驗證等原因之間定案。新的用量資料不會補回已遺失的拒絕理由，也不證明某個設定 cap 就是事故 wire 值。
4. 原檔不應直接寫入新版本測試；後續整合回歸使用合成的長歷史、cache 計數及受控供應商錯誤。原 Session 保持原狀。

本輪唯讀分析程式、完整 scalar 結果及實際 exit 收據保存在 ignored `.tmp/long-session-repair/verification/resume-20261015/` 的 `audit-local-session.mjs`、`local-session-audit.json`、`local-session-audit.log`、`local-session-audit.exit`。沒有把原始私人對話納入 Git。
