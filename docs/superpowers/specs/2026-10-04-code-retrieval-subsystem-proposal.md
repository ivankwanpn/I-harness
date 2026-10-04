# IH 程式碼檢索子系統提案

狀態：2026-10-04 研究提案，尚未實作。來源證據見 [研究報告](../../audit/2026-10-04-context-mode-and-claude-context-research.md)。這份方案回應使用者對 claude-context 的子系統要求。

## 目的與預設

在大量程式碼中找到相關檔案、符號與邏輯片段，保留 grep／glob 的精確查找。子系統預設 off；啟用時先可選本機 lexical backend，hybrid 另選 embedding 及 index adapters。這個無 embedding 的本機 backend 是 IH 提案，並非 claude-context 已有功能。

## 契約

| 元件 | 介面 | 責任 |
| --- | --- | --- |
| IndexService | `startIndex`, `refresh`, `search`, `status`, `cancel`, `clear`, `dispose` | 工作區 owner、job identity、進度及取消；不接任意未授權路徑 |
| ReadAuthority | host-supplied admitted scope + `sessionId/callId/AbortSignal` | Candidate discovery、bounded snapshots、目前 read policy 與結果 revalidation |
| Chunker | admitted immutable snapshot → chunks | 相對 path、exact range、revision、parser version；不直接讀磁碟或呼叫 provider |
| IndexStore | `begin`, `write`, `commit`, `rollback`, `query`, `delete` | Staging/committed generations、quota、舊 generation 保留、可恢復 metadata |
| EmbeddingAdapter | `embedBatch`, `embedQuery` | 可選 provider/model/dimension/endpoint/credential-ref；獨立 signal 與 bytes/token/cost budget |
| RetrievalResult | snippets + refs + provenance | Workspace/root、generation、revision、freshness、mode、rank、partial reasons、limits/stats |

組裝器掛載一般 deferred index/search/status 工具。Code Mode 透過既有 broker 呼叫，沒有第二條權限路徑。搜尋本身是 read-only；建索引／清索引修改的是內部儲存，並須有正確的 concurrency metadata。

## 一致性與目前權限

索引 key 包含 workspace/worktree 身份、canonical root、policy/ignore/extension fingerprint、chunker/schema version，及可選 embedding provider/model/dimension。檔案 revision 包含未提交內容，Git commit 不能取代內容 hash。

更新先發現變更，再 stage replacements，成功保存並發布 generation 後才推進 file hashes。失敗檔案可重試，舊 committed generation 保持可讀。Initial index、incremental refresh、force rebuild 和 clear 共用 mutation owner／fenced lease。Watcher 只是 enqueue；有界 reconciliation 修復漏掉的事件。

搜尋必須強制 requested subdirectory scope。讀出片段前，用目前 consumer authority 重新驗證 path/descriptor 及 revision；不一致就明確回報 stale 或抑制該 hit。已撤銷的 scope 不能因 shared index 放行。外部参考只給 read authority，不增加 source write root。

## 儲存、網路與生命週期

Host 提供專屬 storage root，不能採用上游全域 `.context` 作無區隔的身份。遠端 embedding 與遠端 index 儲存是不同的資料傳送設定；不得推斷既有 LLM credentials 或自動建立雲服務。

Mount 只建立已啟用的 backend。Cancel/clear/unmount 等 jobs、watchers、timers 和 clients 排空，再關閉 store／釋放 lease。重啟只恢復 committed generations，in-flight jobs 記為 interrupted。設定 bound bytes、files、chunks、queue、read budget、deadline、generation retention 和 disk quota；相同限額涵蓋 metadata 與 tool result serialization。

## 建議順序與驗收

1. 明確 scope／snapshot／revision 契約及本機 lexical index。
2. Transactional generation、增量更新、取消／刪除、restart recovery。
3. 可選 versioned AST chunker；錯誤與 fallback 明確。
4. 只有量測證明召回收益時，才加入明確配置的 embedding／Milvus adapter。
5. 固定 repo revisions 比較 grep/glob、lexical、hybrid：file/symbol recall、任務通過率、agent/embedding tokens、冷索引時間、warm query latency、memory/disk、stale hit 和拒絕率。

必要案例：插入／commit 失敗後重試、clear 與 refresh 競爭、改 ignore/policy、刪除／重新命名 worktree、link/junction、huge files、parser error、低輸出預算、取消與 provider 排空。39.4%上游 agent-token 研究不能替代這些 IH 驗收結果。
