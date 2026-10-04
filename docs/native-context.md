# Context Mode 與 Code Context

這兩項功能是 IH 的內建子系統，在「設定 → 上下文與檢索」各自控制。介面標示設計來源：Context Mode 參考 context-mode；Code Context 參考 claude-context。

本指南對應目前開發分支。GitHub v0.1.0 發行檔尚未包含這兩項功能。

## 選擇設定範圍

選擇「全域預設」可設定後續工作區共用的預設值；選擇「此工作區」可建立覆寫。頁面同時顯示已儲存的設定與目前生效狀態。重設工作區覆寫後，該工作區重新使用全域預設。

兩項功能預設關閉。現有 Code Mode、自動壓縮、核準方式與存取範圍仍有各自的設定。

## Context Mode

啟用後，大型文字結果保存在工作區的 IH 資料目錄。模型接收預覽和不透明引用，可以使用 `context_output_search` 找出相關內容，再以 `context_output_read` 的 byte cursor 分段讀取。`context_output_status` 提供狀態。

Code Mode 在程式內取得的已授權工具值仍供程式處理；完整 emitted text 在有界模型觀察之前保留。引用記錄會跟隨實際會話與可見分叉，壓縮後可以繼續取回尚未過期的內容。

Context Mode 的預覽上限包含直接工具文字回應的引用 metadata。Code Mode 仍使用自己的 `max_output_tokens`／文字觀察限制；新增引用 metadata 另限於 4 KiB，觀察 JSON 的總大小可以高於文字上限。這兩種計量分開，並且不把文字長度視為完整模型請求大小。

| 預設限制 | 值 |
| --- | --- |
| 模型文字預覽 | 16 KiB |
| 單次捕獲文字 | 8 MiB |
| 分段讀取 | 32 KiB |
| 搜尋回應 | 16 KiB，包含 metadata |
| 工作區儲存配額 | 512 MiB |
| 保留期限 | 7 天 |

引用的 `complete` 描述實際捕獲是否完整。上游截斷、配額、過期或清理都可能令完整內容無法取得，狀態會明確呈現。原始操作的失敗、退出碼及取消狀態保留其含義；保存內容不等同於操作成功。

## Code Context

啟用後，可在設定頁建立、更新或重建索引。索引來源是目前工作區，以及你明確加入的唯讀參考來源。建立索引不會在來源目錄寫入衍生資料，也不增加對外部來源的寫入權限。

- **詞彙搜尋**：在本機索引中查找識別字和程式碼文字，無需 embedding 或向量資料庫服務。
- **混合搜尋**：選擇 OpenAI 相容或 Ollama embedding 服務，填入 base URL、模型與可選維度；需要認證時填入既有憑證引用名稱。索引及向量儲存在本機，選取的文字會按配置傳送到 embedding 端點。

端點欄填 base URL，後端加上 `/embeddings` 或 `/api/embed`。憑證引用使用環境變數名稱格式；設定頁不保存金鑰值，也不會自動建立雲端服務。

Agent 可透過 `code_context_search` 檢索片段、`code_context_status` 查詢狀態，以及 `code_context_index` 建立或更新索引。工具沿用 IH 的角色、核準、Plan Mode、取消和 broker 流程。

結果附來源、相對路徑、索引 generation、內容 revision、行號與範圍。程式碼 offset 使用已解碼文字的 UTF-16 位置；輸出引用的 cursor 使用 UTF-8 bytes。返回片段前重新核對目前可見性、忽略規則及檔案版本；失效片段不當作目前檔案提供。

| 預設限制 | 值 |
| --- | --- |
| 檔案數 | 20,000 |
| 單一檔案 | 1 MiB |
| 單次索引輸入 | 128 MiB |
| Chunk 數 | 50,000 |
| 單個 Chunk 文字 | 4 KiB |
| 工作區儲存配額 | 512 MiB |
| 搜尋回應 | 16 KiB，包含 metadata |
| 索引工作期限 | 60 秒 |

更新先建立新內容，成功提交 generation 後才前移已處理的檔案 hash。失敗或取消會保留可用的已提交索引，並提供獨立工作結果。自動更新是另外的選項；啟用時以有界背景檢查更新變更檔案。

## 停用、清理與用量

停用會停止接收新工作、取消並等待該子系統的工作排空，再顯示已停用。資料仍保留。清除輸出資料或索引是獨立操作；來源程式碼不受清理影響。

介面的「已載入統計」描述本次服務已載入的內容；持久資料採按需載入。embedding 請求、embedding 快取重用、提供商回報的輸入 tokens 和未回報用量的請求分開展示，計數範圍為這次服務執行。模型 prompt cache 由模型提供商的快取設定與用量回報控制。

實際效益取決於任務、索引、檢索品質與服務。上游節省比例不是 IH 的帳單或任務品質保證。

## English summary

Context Mode retains long textual results locally, supplies bounded previews, and supports exact UTF-8 reads and lexical retrieval. Code Context supplies local lexical code search or optional configured hybrid retrieval. Both are native IH services, default off, and can use global defaults or workspace overrides.

Outside sources remain read-only. Code snippets carry snapshot revisions and contiguous UTF-16 ranges; each hit is revalidated. Disabling drains owned work and retains data, while clearing is separate. Embedding endpoints receive configured text; vectors stay local. Credentials are stored as references, and measured usage is distinguished from missing reports and cache reuse.
