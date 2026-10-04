# IH 工具結果與會話回憶子系統提案

狀態：2026-10-04 研究提案，尚未實作。來源證據與比較見 [研究報告](../../audit/2026-10-04-context-mode-and-claude-context-research.md)。這份方案回應使用者對 context-mode 的子系統要求。

## 目的與邊界

大結果留在有界儲存端，模型使用少量片段與精確引用。保留既有 Code Mode、shell、fs、MCP executor 與 broker；本子系統不新增任意程式執行器。會話回憶擴充既有 session-query，不新增平行的會話真實來源。

## 契約

| 元件 | 介面與資料 | 責任 |
| --- | --- | --- |
| ResultCapture | finalized text + trusted workspace/session/call/event identity → `{refId,revision,capturedBytes,complete,preview,expiresAt}` | 只保留已經走過權限與結果 finalization 的資料；不把二進位媒體塞進文字索引 |
| ResultStore | `put`, `read(refId,offset,maxBytes,revision)`, `deleteOwned`, `dispose` | 不可變 byte-exact blob；引用 ID 不接受任意路徑；labels 只是 metadata |
| ResultSearch | `search({refIds?,queries,limit,maxBytes},authority,signal)` | 衍生 FTS chunks；每片附原文 offset／revision／coverage；索引可重建 |
| SessionRecall | 現有 `session_search` + 有界 event read | 補 Code Mode search-text 投影；返回精確 seq、來源及狀態 |
| RecoveryRefs | 現有 summary + latest trusted request/state + surviving refs | 小型 deterministic 引用區塊；不替換原始 session log，不創造角色或授權 |

Serialized UTF-8 預算必須包含 headings、metadata 與 cursor。`complete` 只代表實際捕獲的上游內容完整；截斷前已遺失的 bytes 不能宣稱已保存。讀取返回 exact contiguous window、next cursor、EOF、revision；搜尋返回 ranked excerpt，不能把少量命中視為全語料已檢查。

## 整合與權限

- Capture 接 core-tools finalization／output-retention。Blob root 與 GC 由 host 擁有；模型無法指定任意輸出位置。
- Search/read 註冊為一般工具，direct 與 Code Mode 共用 prepare、approval、dispatch、abort 和 audit。
- Host 提供目前 session/workspace 可見性；模型的 scope 字串不擴大權限。外部参考可以唯讀納入，不增添 source write root。
- 歷史 result refs 的可見性與即時檔案 read scope 分別校驗；重新讀取來源要新權限。取消原有可見性後，不可藉 cached snippets 繞過。
- 檢索不重跑原 shell/API 操作。Retrieved text 保持 source material，不能 promote 成使用者／系統指令。

## 持久化與生命週期

Durable session event 與 immutable blob 是真實來源；FTS 是可重建索引。捕獲／索引寫入有單一序列 owner，失敗會回傳明確狀態。Cancel/unmount 必須等讀取、寫入及索引工作排空。Fork／session deletion 有明確 copied ownership 或 visibility 規則，不能挑「最近的另一個 session」恢復。

用量上限包含 producer capture、queued work、讀取 bytes、query 數、chunk 數、deadline 與 disk quota。GC 只處理本子系統擁有的資料，並記錄過期；不存在的引用返回 expired/unavailable。現有 temp spill 本身沒有永久有效保證，接 durable refs 前必須訂出 retention 契約。

## 建議順序與驗收

1. Code Mode 事件進既有 session-search；重啟／壓縮後可找回已知 nested result。
2. Immutable result ref + exact bounded read；第二份同標籤結果不覆蓋第一份，中段錯誤可取回。
3. Derived output index；測量召回率後才加入 trigram／RRF 等排序改善。
4. Compact recovery refs；最新使用者修正及權限範圍仍直接可見。
5. 相同任務比較 full request tokens、結果 bytes、檢索正確性、延遲和 disk usage。

必要案例：CJK／emoji／長行、media 排除、已刪除 blob、索引失敗／重建、撤銷可見性、跨 session 拒絕、外部唯讀來源、symlink／descriptor 邊界、cancel 排空、fork、quota／expiry。不繼承上游的固定98%節省宣稱。
