# IH 會話格式與多協議相容性

## 哪些資料可以跨協議

IH 的 `LLMMessage` 記錄使用者與助手正文、工具名稱、呼叫 ID、參數、結果及失敗狀態。每次送出前，由目標協議的轉接器將這些資料轉成它接受的格式。有記錄公開區塊順序時，正文要留在對應工具呼叫的前面或後面。歷史只留下整段文字時，保留原文和工具配對，採用目標協議可表達的順序。[訊息型別](../../packages/core-session/src/projection/types.ts) · [共用呈現邏輯](../../packages/llm-seam/src/index.ts)

簽章、加密推理及供應商專用欄位帶有來源限制。將已知的公開區塊排回原位時，只取當前正文和工具資料。DeepSeek 是本次驗證的特例：同一個官方端點、模型及具名設定由 Responses 切回 Chat，若正文和工具仍與原紀錄一致，IH 能送回原始的 `reasoning_text`。舊紀錄缺少這項來源證據時沿用原協議的讀法。[DeepSeek 轉換測試](../../packages/provider/test/deepseek-protocol-switch.test.ts)

另外向官方 DeepSeek Flash 送出兩筆請求。第一筆 Responses 回傳工具呼叫，原生推理項目同時含有可見的 `reasoning_text` 與 `encrypted_content`。實際讀取隔離檔案後，將對話寫入 JSONL 並從磁碟重開。第二筆 Chat 使用原工具 ID 和結果，僅傳送逐字相同的 `reasoning_text`，取得 HTTP 200 並答出檔案中的隨機標記。兩筆請求的輸入／輸出分別為 326／66 與 417／13 token。相容回歸包括只有密文、混有摘要、改動工具參數及來源不符等情況。[官方 Responses 格式](https://api-docs.deepseek.com/guides/responses_api/) · [官方思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)

## 用同一段歷史重播

測試讓 Responses、Chat Completions、Anthropic Messages、Gemini 和 Bedrock 各產生一輪包含正文與工具呼叫的回覆，寫入 IH 的 JSONL，再從磁碟重開。每份歷史分別轉送給五種協議。每組各跑一次成功和失敗的工具結果，刻意讓結果正文相同。HTTP 回應與 AWS 事件由本機測試服務或 SDK fixture 提供。

| 檢查 | 舊版 `fd460273` | 修正後 |
| --- | --- | --- |
| 工具名稱、ID、含中文參數和結果配對 | 25/25 | 25/25 |
| 目標模型能區分同文的成功與失敗 | 15/25。兩種 OpenAI 相容目標把兩者送成相同內容 | 25/25。缺少原生錯誤欄位的格式只在失敗結果前加上明確狀態，儲存原文可繼續使用 |
| 能逐塊表達的「正文 → 工具 → 後續正文」 | 4/16。四個目標只在讀回各自原格式時保持順序 | 16/16。從現存順序資料核對正文和全部工具後，依目標格式重建公開區塊 |

Chat Completions 的助手訊息以 `content` 和 `tool_calls` 兩個欄位呈現。涉及 Chat 的組合檢查完整正文及工具配對，區塊交錯測試只計入另外四種可直接表達該順序的協議。來源紀錄在五次轉送前後逐項核對，外部模型也未收到其他協議的私有推理標記。[錯誤狀態回歸](../../packages/provider/test/tool-result-status.test.ts)

另一組測試從真正的 Responses 串流取得沒有推理或 `phase` 的交錯區塊，逐一檢查同一會話及重讀 JSONL 後四種目標的請求。修改助手正文後，只送出新的文字及參數。[區塊順序回歸](../../packages/provider/test/interleaved-replay.test.ts)

### 多個工具與圖片

同一回覆可能先列出讀檔 A、B，卻依 B、A 完成。執行器仍按實際完成順序取得呼叫。記錄提供者的區塊位置時，IH 同時保存已確認的呼叫 ID。重播時用 ID 和位置比對現有工具，才可重建與完成順序不同的排列。舊紀錄只有位置且無法確認身分時，跨協議回放沿用可確認的工具順序。[反序完成與簽章回歸](../../packages/provider/test/reversed-tool-completion.test.ts)

工具回傳的圖片屬於該筆工具結果。舊分支如果另外儲存了圖片所在訊息與區塊的位置，讀取時依這些位置還原。一般使用者圖片始終保有自己的訊息身分。測試使用同一份存檔，依序發出兩個同名呼叫，反序回傳各自的圖片及成功／失敗狀態，最後再附一張獨立的使用者圖片。

| 目標 | 如何保留圖與結果的關係 |
| --- | --- |
| Responses、Anthropic Messages | 圖片直接隨對應呼叫的工具結果送出。 |
| Chat Completions | 先送完整批工具文字結果，再將各呼叫的圖片與其 ID 排在一起。真正的下一則使用者訊息另外傳送。 |
| Gemini | 支援多模態函式結果的官方 Gemini 3 及後續模型使用 `functionResponse.parts`。舊模型及未確認的相容端點使用附有呼叫 ID 的圖片訊息。Gemini 2.x 的結果依該請求實際送出的呼叫位置排列。 |
| Bedrock | 已核實的官方 Claude 或 Nova 視覺模型使用 `toolResult` 內的圖片與錯誤狀態。相容端點依實際 SDK 路由選擇替代表示，各圖片組標上原呼叫 ID。 |

同份 JSONL 在上述五種協議、11 條路徑都通過檢查。各路徑的三張工具圖片與一張使用者圖片都只傳一次。這些 HTTP 測試用本機服務接收；AWS 案例使用真正的 SDK 簽署和序列化流程。[Google 函式結果多媒體規格](https://ai.google.dev/gemini-api/docs/function-calling#multimodal) · [AWS 工具結果格式](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolResultContentBlock.html) · [AWS 端點選擇](https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html)

## 在已開啟的會話切換協議

公開 Gateway 測試保留一個會話 ID，透過 `session/model/set` 把 Responses 換成 Chat，之後重開再繼續。舊版在設定回報成功後遇到 `Managed facts require reconciliation`，第三筆模型請求無法送出。當時寫回相同的模型選擇，也會使執行中的 JSONL 寫入者失效。

協議覆寫屬於目前會話的執行設定。若持久化選擇相同，只更新當前綁定。真正變更持久化模型時，在會話閒置且舊寫入者安全釋放後，才寫入新選擇並啟用新綁定。同設定及跨設定各完成三輪、五筆模型請求與兩次本機讀檔；冷啟按保存的供應商及模型恢復。[Gateway 切換實作](../../packages/desktop-gateway/src/model-switch.ts)

## SDK 與儲存邊界

- **同一會話的並行輸入。** 支援 `prompt-input-receipt` 的 IH 服務透過收據傳回實際分配的 `inputId`，SDK 用它選取該次 `run()` 的事件和最終回答。兩個請求的文字和 `clientToken` 即使相同也能分辨。會話通知訂閱仍能觀察整個會話。舊服務缺少可配對的收據時，SDK 會指出無法歸屬的並行呼叫。[請求歸屬回歸](../../packages/sdk/test/prompt-attribution.test.ts)
- **JSON-RPC 封包。** 回覆須沿用呼叫的 ID 型別和值。成功與失敗各自有獨立的封包形狀；有結果又有錯誤的行會被略過。沒有對應請求的解析錯誤只影響該行。IH 明確的過載通知仍會結束連線上的待辦請求。[SDK 協議實作](../../packages/sdk/src/protocol.ts) · [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
- **顯示歷史與原始日誌。** 翻頁游標 `nextSeq` 可以直接作為下一頁的 `afterSeq`。獨立讀一頁也能顯示已送出的圖片。要用完整顯示歷史重建含圖片的對話，先收齊頁面，再透過 `restorePromotedHistoryImages` 還原已升格的輸入。尚未送出的圖片仍屬原始來源。即時圖片讀取按已提交的序號查找，後續事件不會改變其對應關係。[SDK 歷史轉換](../../packages/sdk/src/history-events.ts)
- **舊 JSONL。** 舊會話的分支來源與父會話欄位在匯出時保留。早期缺少明示序號的記錄留在原始歷史前綴，後來新增的事件才寫進新的提交框架。重開後同時驗證對話、來源及格式邊界。[JSONL 實作](../../packages/core-session/src/serialization/jsonl.ts)
