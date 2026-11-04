# IH 會話持久化／恢復子系統審計（2026-11-04）

**範圍**：`packages/core-session`、`packages/session-persistence`、`packages/session-persistence-jsonl`、`packages/session-executor`。重點在 managed execution、fact journal、write-behind、document 寫入、recovery／debt，以及 fork／rewind 與持久化的互動。

**方法**：只讀產品程式碼（未修改任何產品檔案），對照參考專案的持久化與並行模型，只列設計偏離、不合理設計與潛在 bug；純風格問題不列。

**對照來源**：

- Codex `D:\ih_reference_project\codex-rust-v0.166.0\codex-rs`：`rollout/src/recorder.rs`（單一背景 writer、bounded channel、失敗保留未寫前綴並在下次 barrier 重試、保持開啟的檔案 handle 逐筆 append）、`thread-store`、`core/src/session`、`core/src/agent`。
- opencode `D:\ih_reference_project\opencode-2.1.4\packages\core`：`session/store.ts`（SQLite／Drizzle；`time_suspended` 執行 claim＝durable write-ahead intent、`resume_attempts`、`listSuspended`）、`job.ts`（durable job record ＋ `recovery` 描述）、`session/execution.ts`、`session/subagent-completion.ts`、`database`。
- 同源 `D:\ih_reference_project\deepseek-harness-dsh-v0.2.2-alpha.2\packages`：`session/session-persistence-jsonl`（不可變 generation 發佈、`flushAll` 耐久屏障）。

**嚴重度**：**C** = 功能不可用或資料錯亂；**H** = 常見情境下不穩定／不可恢復；**M** = 可維護性、可診斷性或可擴展性；**L** = 體驗或一致性。

**與前一份審計的關係**：`docs/design/2026-11-04-design-deviation-audit.md` 的 D-02／D-07／D-08 描述的是同一組症狀（task document debt 卡死、fail-closed 狀態不持久、單一文件失敗封鎖整個 session）。本報告補上**機制層的證據**：S-01／S-02／S-03 就是那三個症狀的實際成因。

---

## 摘要

| # | 嚴重度 | 一句話 | 主要證據 |
|---|---|---|---|
| S-01 | **C** | 一次 `unknown`／`conflict` 事實寫入就把整個 managed document 永久隔離，決定性的 conflict 沒有程式內出口 | `managed-document.ts:220-230,280-284,617-653` |
| S-02 | **C** | process latch 的 poison 集合只增不減：任何一次 append 例外就永久封鎖該 session 的 task document 與 cold read | `process-read-latches.ts:10-39`、`mutations.ts:154-167` |
| S-03 | **H** | 崩潰留下的 torn tail 讓普通 append 拋無 `code` 的錯，而截斷修復只掛在 load 路徑 | `backend-factory.ts:256-261`、`fact-journal.ts:128-145` |
| S-04 | **H** | document 寫入有兩套耐久性，且對外路徑（`putDocument`）完全沒有 fsync | `document-write.ts:8-12,85`、`backend-factory.ts:430-442` |
| S-05 | **H** | document 讀寫失敗被偽裝成「成功」與「不存在」 | `documents.ts:195`、`backend-factory.ts:443-447` |
| S-06 | **H** | 每次 append 都是 O(檔案大小)：全量讀檔＋逐 frame 重新編碼雜湊 | `backend-factory.ts:252-266`、`fact-journal.ts:56-106` |
| S-07 | **H** | rewind 跨兩個耐久性域：檔案先還原、marker 後寫，中間 crash 沒有補償記錄 | `rewind-facts.ts:19-27`、`projection/rewind.ts:53-57` |
| S-08 | **H** | fork 的耐久單位不是 child 的歷史，而是 header 裡的 bootstrap reservation | `fork-controller.ts:40,188-220`、`fact-journal.ts:13-50` |
| S-09 | **M** | write-behind 是沒有生產者的死路徑，但仍參與 close／delete 的耐久屏障 | `mutations.ts:26-79,168-197`、`run.ts:359-378` |
| S-10 | **M** | header 讀寫上限不對稱：寫得進去、之後讀不出來 | `backend-factory.ts:418,423-426,567-581` |
| S-11 | **M** | rewind 投影混用 seq 與陣列索引，在修補過或 seq 有 gap 的日誌上錯算受影響範圍 | `projection/rewind.ts:14-33`、`result-resources.ts:39` |
| S-12 | **M** | `atSeq` 超出日誌範圍時，fork 靜默改用最後一個完成的 turn | `fork.ts:84-91` |

---

## S-01 一次 `unknown`／`conflict` 事實寫入就把整個 managed document 永久隔離（C）

**問題一句話**：`finish()` 把「這一幀未知」升級成「整個文件不可用」——設 `quarantined`、`capacity.stop()`、丟掉佇列，但不清 `pending`；而清除路徑要求同一 batch key 的 reconcile 回 `committed`／`absent`，所以一次決定性的 conflict（檔案狀態不變，每次 reconcile 都再失敗）在行程內等於沒有出口。

**證據**：

- `packages/session-persistence/src/coordinator/managed-document.ts:220-230`：`failQueued()` 設 `quarantined = true`、`capacity.stop('FACT_RECOVERY_REQUIRED')`、把 queue 全部以 `not-issued` 結束，**沒有**碰 `pending`。
- 同檔 `:280-281`：`outcome.kind === 'unknown' || 'conflict'` → `failQueued()`；`:284`：只有 `absent`／`not-issued` 分支才 `pending = undefined`。
- 同檔 `:408-425`：`quarantined` 連 `authorization.required === true` 的 admission 都拒絕，所以連 tool settlement 也寫不進去。
- 同檔 `:617-653`：`quarantine` 只在 `reconcile(key)` 中 `pending` 被清掉後才復位；`:629-630` key 不符時直接回 `FACT_RECOVERY_REQUIRED`。
- `packages/session-persistence-jsonl/src/backend/fact-journal.ts:159`：append 要求 `stat().size === position`，任何長度不符都是 `conflict`；`:209`：reconcile 長度不符也是 `conflict`。

**參考做法**：Codex 的 I/O 失敗只丟棄 writer handle、把未寫前綴留在 `pending_items`，下一次 persist／flush 重開檔案重試兩次（`rollout/src/recorder.rs:1826-1831`、`1875-1900`、`1906-1919`）。opencode 每個 mutation 是 SQLite 單一陳述式交易，失敗即回滾，session 狀態一致、可繼續（`session/store.ts` 全篇；`session/store.ts:208-227` 的 claim／release 也是單一 update）。

**建議方向**：

1. 把「這一幀未知」與「整個文件不可用」分開：`unknown` 只鎖該 batch key；`required` 事實可在 reconcile 後繼續。
2. `conflict` 要能自癒：在 owner 之下重讀檔案前綴、重算 prefix、丟棄本地佇列，而不是 `capacity.stop()`。
3. `capacity.stop()` 不該用於可恢復狀態（它會拒絕所有排隊中的 required 事實）。

**可否本地單檔測試**：可。用自訂 backend 讓第一次 `appendOwnedBatch` 回 `{ kind: 'conflict' }`，之後再 admission 並 `reconcile` 同一 key；現況會永遠 `FACT_RECOVERY_REQUIRED`，修好後應能恢復。

---

## S-02 process latch 的 poison 集合只增不減（C）

**問題一句話**：`beginMutation` token 以 `'unknown'` 結束時會把 session／document key 寫進 `poisoned` 集合，全檔沒有任何刪除；而 task document transition 的每個 guard 都查它——於是任何一次 `append` 例外（事件形狀驗證失敗、ownership／lease 衝突、torn journal）都讓該 session 之後所有 spawn／settlement／cold read 得到 `PROCESS_READ_UNAVAILABLE`，直到重啟。

**證據**：

- `packages/session-persistence/src/coordinator/process-read-latches.ts:10-11`（三個 Set）、`:34-39`（`outcome === 'unknown'` 時加入 poison）、`:20-21`（`assertUnpoisoned`）、`:47-49`（reader capture 也查）——全檔無 `delete`。
- `packages/session-persistence/src/coordinator/mutations.ts:154-167`：`append` 的 token 在 `finally` 以 `outcome` 結束，`outcome` 預設 `'unknown'`，只有成功才 `'settled'`。任何 `withSessionOperation`／`ensureOwnership`／`backend.append` 的例外都會 poison。
- `packages/session-persistence/src/coordinator/documents.ts:104-128`：`putDocumentStrict` 同型（而且一次寫入建了兩個 token）。
- `packages/session-persistence/src/coordinator/managed-document.ts:440-455`：fact admission 同型。
- 使用端：`packages/session-persistence/src/coordinator/task-document-transition.ts:110,112,251,268`。
- 生產環境一定啟用：`packages/session-persistence-jsonl/src/backend-factory.ts:42,51,59` 以 `assembleSessionCoordinatorWithProcessStorage` 建 coordinator，`processLatches` 非 undefined。

**參考做法**：opencode 的失敗是 per-statement／per-job，`time_suspended` claim 與 `resume_attempts` 是 durable 且有明確 release（`session/store.ts:208-254`）；沒有跨子系統的記憶體毒化。Codex 的失敗只保留未寫前綴。兩者都不會讓「一次驗證錯誤」變成「整個 session 的子代理功能永久關閉」。

**建議方向**：poison 綁定「該次嘗試／該 frame」，成功 reconcile 或重新讀到一致前綴後清除；至少提供可恢復路徑與具名診斷（目前只有一個通用 `PROCESS_READ_UNAVAILABLE`，無法從錯誤訊息知道是哪一次寫入中毒）。

**可否本地單檔測試**：可。建 coordinator → 送一個會驗證失敗的批次 → 之後對同一 session 開 task document，斷言現況拋 `PROCESS_READ_UNAVAILABLE`。

---

## S-03 torn tail 讓普通 append 拋無 `code` 的錯，修復只掛在 load 路徑（H）

**問題一句話**：`backend.append` 每次用 `readFile` 重讀整份 journal，遇到 `journal.torn` 就 `throw new Error('Journal recovery required')`（沒有 `code`）；截斷修復只存在於 `readJournalPrefix()`（managed 開檔路徑）與 `repair()`（load 路徑）。若 crash 後第一次寫入發生在尚未 load 的路徑（child、CLI、同行程其他 writer），會拿到不可分類的錯誤，並依 S-02 毒化 latch。

**證據**：

- `packages/session-persistence-jsonl/src/backend-factory.ts:256-261`：`readFile(path)` → `readFactJournal` → `if (journal.torn) throw new Error('Journal recovery required')`。
- 同檔 `:311-352`：`repair()` 才會截斷／重寫，而 `repair()` 只由 `load`／`loadOwned`／`transitionLoad` 呼叫（`packages/session-persistence/src/coordinator/load.ts:52,114,180`）。
- `packages/session-persistence-jsonl/src/backend/fact-journal.ts:128-145`：`readJournalPrefix()` 在持有 owner 時 truncate torn 結尾並 fsync——這是唯一「寫入前先修」的路徑。
- `packages/session-persistence/src/coordinator/load.ts:114`：`repaired = await backend.repair(sessionId)` 是讀路徑的一部分。

**參考做法**：Codex 的 writer 自己處理壞尾：失敗就 `enter_recovery_mode()` 丟棄 handle、重開、重試兩次（`recorder.rs:1875-1919`），錯誤型別是 `io::Error`；壞尾的處理在 writer 內，不是另一個階段。

**建議方向**：把 torn-tail 截斷納入 append 前置（在持有 owner 時），回傳具名診斷（例如 `JOURNAL_TAIL_TRUNCATED`）；永遠不要用「無 `code` 的 Error」表示「尚未發出寫入」——那是 `not-issued`，不該 poison latch。

**可否本地單檔測試**：可。手動寫半個 frame 後呼叫 `coordinator.append`，斷言錯誤 `code` 與後續可寫性。

---

## S-04 document 寫入有兩套耐久性，且對外路徑完全沒有 fsync（H）

**問題一句話**：`coordinator.putDocument` 走 `writeLegacyDocument`＝`writeFile` ＋ `rename`，沒有 `fsync`、失敗也不清 temp；只有 owned 的 `createOwnedDocumentWrite` 會 fsync 檔案，而且回執明白寫著 `durability: 'file-synced-process-restart-v1'`（不含目錄 fsync，只保證 process restart）。task registry、session title、project binding、approval history、input receipts 全都走前者。

**證據**：

- `packages/session-persistence-jsonl/src/backend/document-write.ts:8-12`：`writeLegacyDocument` = `writeFile(tmp)` → `rename`，無 `sync()`、無失敗 `unlink()`（對照 `session-io.ts:26-30` 有）。
- `packages/session-persistence-jsonl/src/backend-factory.ts:430-442`：`putDocument` → `writeLegacyDocument`。
- `packages/session-persistence-jsonl/src/backend/document-write.ts:85`：owned 路徑的回執 `durability: 'file-synced-process-restart-v1'`。
- `packages/session-persistence-jsonl/src/backend/session-io.ts:20-45`：journal 重寫有 `handle.sync()` ＋ best-effort 目錄 fsync，可見同一行程內三種耐久等級並存。
- 使用端：`packages/subagent/src/task/persistence.ts:70`、`packages/desktop-gateway/src/project-scope.ts:179`、`packages/desktop-gateway/src/approval-history.ts:49`、`packages/workspace/src/index.ts:250-320`。

**參考做法**：opencode 的 session／message／job 全在 SQLite（Drizzle）單一交易內，WAL 提供一致耐久性；Codex 的 rollout 逐筆 flush，metadata 走 state DB。兩者都沒有「同一件事有三種耐久等級」。

**建議方向**：文件寫入收斂成一條路徑（fsync 檔案 ＋ fsync 目錄 ＋ 失敗清理），或明確把 document 降級為「可重建 projection」，不要當 recovery 依據；`putDocument` 與 owned path 的耐久語義必須一致。

**可否本地單檔測試**：可。以計數 fs mock 斷言 `putDocument` 在 rename 前呼叫過 `sync`（現況沒有）。

---

## S-05 document 讀寫失敗被偽裝成「成功」與「不存在」（H）

**問題一句話**：`putDocument` 把任何錯誤 `report(error)` 後正常 resolve，呼叫者無法知道文件沒寫進去；`getDocument` 把任何讀取錯誤（權限、I/O）catch 成 `undefined` 當成不存在。於是 task registry 的「存檔成功」與「文件消失」都不會被發現，後續寫入以錯誤的 preimage 為基礎。

**證據**：

- `packages/session-persistence/src/coordinator/documents.ts:195`：`async putDocument(...) { try { await putDocumentStrict(...) } catch (error) { report(error) } }`。
- `packages/session-persistence-jsonl/src/backend-factory.ts:443-447`：`getDocument` 對 `readFile` 的任何失敗回 `undefined`。
- 同檔 `:448-462`：`readDocumentObserved` 才區分 `{kind:'absent'}`／`{kind:'present'}`——能力存在，但主要讀取路徑沒用。
- `packages/subagent/src/task/persistence.ts:63-70`：strict 與非 strict 兩條路徑並存，非 strict 就是靜默版本。

**參考做法**：opencode 的讀寫錯誤是 Effect 錯誤，不存在「靜默 absent」；Codex 的 rollout 讀取錯誤往上拋。參考 `session/store.ts:96-99` 的 `get` 只把「查無資料」當 undefined。

**建議方向**：`putDocument`／`getDocument` 回傳 typed outcome；「不存在」只能是 `ENOENT`。把 report-only 版本標成 deprecated 或移除，讓編譯器找出所有需要處理失敗的呼叫端。

**可否本地單檔測試**：可。backend 對 put 丟錯、對 get 丟 `EACCES`，斷言現況 resolve／`undefined`。

---

## S-06 每次 append 都是 O(檔案大小)（H）

**問題一句話**：`backend.append` 先 `stat` 取 size，再 `readFile` 整檔、`readFactJournal` 解全部 frame（每個 frame 在 `decodeFactBatch` 裡重新 `encodeFactBatch` 做 SHA-256 並逐 byte 比對），然後才寫入一個新 batch；`repair()` 更把整檔當 UTF-8 字串讀入再 split／join。session 越長，每個事件批次的延遲與記憶體越線性成長，而一次 `loadOwned` 要做三次全讀＋一次 repair 全讀。

**證據**：

- `packages/session-persistence-jsonl/src/backend-factory.ts:252-266`：append 內 `readFile(path)` ＋ `readFactJournal(bytes...)`。
- `packages/core-session/src/serialization/fact-journal.ts:56-65`：`decodeFactBatch` 重新 `encodeFactBatch` 並 `buffer.equals(...)`；`:81-106`：`decodeJournal` 對整份歷史逐 frame 驗證 digest 鏈。
- `packages/session-persistence-jsonl/src/backend-factory.ts:315`：`repair()` 的 `readFile(path, "utf-8")`。
- `packages/session-persistence/src/coordinator/load.ts:101,107,114`：`loadOwned` 三次 `read` ＋ `repair`。
- document 端同樣全量：`packages/session-persistence-jsonl/src/backend/document-write.ts:21-23,57-70`（preimage 全文複製、`Buffer.alloc(limit + 1)`、預設上限 64 MiB）。

**參考做法**：Codex 保持開啟中的 `JsonlWriter`，逐筆 append，從不重讀檔案（`recorder.rs:1921-1932`、`1961-1990`）；opencode 用 SQLite B-tree，寫入與查詢都是 O(log n)。

**建議方向**：append 只驗尾端（managed 路徑已在記憶體持有 prefix，可延伸）；開檔時線性驗一次並快取結果；document 改成 digest 比較＋串流，降低 64 MiB 上限。

**可否本地單檔測試**：可。以計數 fs 斷言每次 append 的讀取位元組數；現況等於檔案大小，應降為常數。

---

## S-07 rewind 跨兩個耐久性域，marker 在檔案還原之後才寫（H）

**問題一句話**：`withRewindFacts`／`withManagedRewindFacts` 先跑 `restore()`（還原 workspace 檔案），只有在 callback 裡才 append `rewind/point` 並等它 settle；若在兩者之間 crash，檔案已還原但日誌沒有 marker，重載後看到的是「未 rewind 的對話」配上「已還原的檔案」，而且沒有 intent 記錄可供偵測。

**證據**：

- `packages/session-executor/src/lifecycle/rewind-facts.ts:19-27`：`source` 註冊後才進 `restore(async event => { fact = source.rewind.capture(event); await settle() })`——restore 先、marker 後。
- 同檔 `:47-59`：managed 版同構。
- `packages/core-session/src/projection/rewind.ts:53-57`：cut window 完全由 `rewind/point` 推導；沒有 marker 就沒有 cut。
- `packages/desktop-gateway/src/rewind.ts:30-33`：入口只先 flush，再開 document。

**參考做法**：沒有任何參考實作把「檔案還原」與「日誌」綁在一起：opencode 的 revert 只是 DB 一列（單一交易生效範圍），Codex 沒有檔案還原式 rewind。這正是 IH 自創跨域操作缺少 WAL 的地方——應該借用 opencode 的 durable claim 思路（`session/store.ts:62-85`）。

**建議方向**：先寫 intent（或 marker 本身），再還原檔案，最後寫 completion；recovery 看到 intent 就能重放或標記未完成。這也讓「已 rewind 但未完成」變成可查詢狀態。

**可否本地單檔測試**：可。fake fs 在 restore 與 append 之間注入失敗，斷言重載後可偵測未完成 rewind。

---

## S-08 fork 的耐久單位不是 child 的歷史，而是 header 裡的 bootstrap reservation（H）

**問題一句話**：fork 以「先寫 reservation（`operationId`／`requestDigest`／`seedLength`／`manifestDigest`）到 child header，再分階段寫 seed／completion frame」完成，正確性依賴 in-memory `Holder`、`operations`／`targets` Map 與 `prepare → begin → retry` 三階段協議；crash 後要靠 `inspectBootstrapCapture` 判 `absent`／`reserved`／`materialized`，任何分歧（`source-changed`、`manifest-invalid`、birth frame 不符）都是終局拒絕，而 `list()` 只看檔名，半成品 child 會出現在會話清單裡。

**證據**：

- `packages/session-persistence/src/fork-controller.ts:40`：`Holder`（`attempted`／`enteredB2`／`lastOutcome`／`cleanupHandles`）全在記憶體；`:188-220`：`execute()` 依 inspection 結果選 passive／warm／first 三條路徑；`:243-257`：`operations`／`targets` Map 與 flight 去重。
- `packages/session-persistence/src/fork-contract.ts:40-54`：`prepared`／`operation`／`blocked` token 協議（含 `BootstrapResumeToken`）。
- `packages/session-persistence-jsonl/src/backend/fact-journal.ts:13-50`：`preserveBootstrapBirth` 要求 birth frames 與 manifest 完全相符，否則 `Bootstrap birth ... changed`／`immutable`；`:73-81`：舊格式只允許精確的 seed／completion 形狀。
- `packages/session-persistence-jsonl/src/backend-factory.ts:302-308`：`list()` 只依檔名，不看 reservation 是否完成。

**參考做法**：Codex 的 fork 是為新 thread 建一份自包含 rollout（單一 writer，沒有跨 session 2PC，也不需要 resume token）；opencode 的 child 就是一般 session row（`parent_id`）＋ durable job record（`job.ts:12-33`、`443-450`），恢復語義與一般工作相同。

**建議方向**：讓「複製前綴」成為一次原子發佈（單檔建立即完成），reservation 只當冪等鍵、不當回復狀態機；半成品 child 不應被 `list()` 看見（例如完成前用不同後綴）。

**可否本地單檔測試**：可。在 reservation 與 seed frame 之間注入 crash，觀察 `list()` 與重開結果。

---

## S-09 write-behind 是沒有生產者的死路徑，但仍參與 close／delete 的耐久屏障（M）

**問題一句話**：`SessionWriteBehind` ＋ `enqueue` ＋ `flushWriteBehinds`／`cancelAutomaticWaits` 這條路徑在產品程式碼裡沒有任何呼叫端（只有測試），所有真實事件都走同步 `append`；但 `close()`／`deleteOwnedSession()` 仍以它為 flush 屏障，CLI 文件也還寫著「write-behind 以 200 ms 批次、turn/end 才 flush」——文件描述的耐久模型與實作不同。

**證據**：

- `packages/session-persistence/src/coordinator/mutations.ts:26`（`writeBehinds` Map）、`:56-79`（只有 `enqueue` 會建）、`:168-178`（`enqueue` 唯一入口）、`:193-197`（`flush` 沒實例就 no-op）。
- `packages/session-persistence/src/write-behind.ts:44-55`（`enqueue` 無回傳值）、`:124-149`（失敗只 `reportBackgroundFailure`，witness 保留到成功）。
- `packages/session-persistence/src/coordinator-factory.ts:159-163`：`enqueue` 是唯一對外出口。
- 產品程式碼無呼叫端：僅 `apps/cli/test/input-tiers.test.ts:41` 與 persistence 測試。
- 文件落差：`apps/cli/src/run.ts:359-378`。

**參考做法**：Codex 只有一條 writer 路徑（bounded channel ＋ 未寫前綴重試，`recorder.rs:1029-1044`）；dsh 每個 session 一個 handle，`flushAll` 是唯一屏障（`session/session-persistence-jsonl/src/storage.ts:503-522`）。

**建議方向**：刪掉或真正接上（例如讓高頻 chunk 類事件走它）；保留單一耐久契約，避免「一個會 retry、一個不會」的兩套語義並存。

**可否本地單檔測試**：可。跑一次完整回合後斷言 `pendingWriteBehind(id)` 恆為 `undefined`。

---

## S-10 header 讀寫上限不對稱（M）

**問題一句話**：讀 header 一律只讀 64 KiB，超過就以各自的訊息失敗；但 `updateMeta` 只檢查「舊 header」長度，`snapshotMetadataUpdate` 產生的新 header 沒有上限檢查。fork 允許 32 KiB 的 title，把 header 推到接近上限後再加一個 patch 就可能跨線，之後該 session 不可讀、不可 append，錯誤訊息還是誤導性的 `empty session file`。

**證據**：

- `packages/session-persistence-jsonl/src/backend-factory.ts:418`：檢查的是 `raw`（舊檔）的 `end + 1 > 65536`；`:423-426`：新 header 由 `snapshotMetadataUpdate` 產生，直接寫入，無長度檢查。
- 同檔 `:567-581`：`readHeader` 固定 `HEADER_READ_MAX_BYTES = 64 * 1024`，註解假設「ids ~40 chars，titles capped at 200」——是假設，不是不變量。
- `packages/session-persistence-jsonl/src/backend/fact-journal.ts:58-62`：append 路徑的 `header()` 同樣 64 KiB，超過就 `Invalid managed header`。
- `packages/session-persistence-jsonl/src/backend/format-upgrade.ts:42-45`：同上。
- `packages/session-persistence/src/fork-contract.ts:30`：`title` 上限 32768 bytes。

**參考做法**：Codex 的 rollout 首行由 serde 串流讀，沒有固定上限；opencode 是 schema 欄位（`SessionTable.title`）。

**建議方向**：寫入前檢查新 header 長度並以具名代碼拒絕；或把 header 讀取改成「讀到第一個 LF」不限長（成本只需一次小 read loop）。

**可否本地單檔測試**：可。造一個 > 64 KiB 的 patch，斷言寫入被拒；現況會成功寫入，下一次讀／append 失敗。

---

## S-11 rewind 投影混用 seq 與陣列索引（M）

**問題一句話**：`originalPoints` 把 `cutFrom` 記為 `anchorSeq`（seq 空間）、`markerIndex` 記為陣列索引；消費端 `inheritedCutGuard` 卻在同一個比較式混用兩者。`load()` 明確會產生非位置化的 seq，任何 repair／drop 之後 `index !== seq`，這個過濾就會把被 rewind 的 result 當成可見、或把仍可見的藏起來。

**證據**：

- `packages/core-session/src/projection/rewind.ts:14-19`：`markerIndex` 是 `entries()` 的索引，`cutFrom`／`markerSeq` 是 seq；`:23-33`：另外提供了 value-space 的 `startRank`／`endRank`，但此處沒用。
- `packages/core-session/src/conversation/history/result-resources.ts:37-45`（第 39 行）：`fact.index < window.cutFrom || fact.index >= window.markerIndex`。
- `packages/session-persistence/src/coordinator/load.ts:137-156`：非位置化 seq 的明確來源（`max(index, maxDefinedSeq + 1 + k)`），而且註解自己說「consumers must not assume seq === index」。

**參考做法**：Codex 的 rollout item 只有位置順序、不混用座標；opencode 用單一 row seq 座標（`session/store.ts:143-181` 的 cursor 也只有 `seq`）。

**建議方向**：此處改用 `startRank`／`endRank`（已是 value-space rank），或把 `markerIndex` 換成 `markerSeq`；長線是讓 `load()` 與 `loadOwned()` 產出同一個座標系（見 S-03 註解）。

**可否本地單檔測試**：可。造一個 `seq !== index` 的 view（例如插入一個 repair 產生的 synthetic closer），斷言 inherited result 的可見性。

---

## S-12 `atSeq` 超出日誌範圍時 fork 靜默改用最後一個完成的 turn（M）

**問題一句話**：`completedTurnPrefix` 在找不到 `seq >= atSeq` 的 `turn/end`、但 `atSeq > events.length - 1` 時，會回退到「最後一個 `turn/end`」，也就是把整段歷史都 fork 出去，而不是回報越界；`requestDigest` 只涵蓋請求（`sourceSessionId`／`selection`／`metadata`），不涵蓋實際解析出的邊界，呼叫端無從得知拿到的是不同的前綴。

**證據**：

- `packages/session-persistence/src/fork.ts:84-91`：`if (boundaryIndex === -1 && atSeq > events.length - 1) { ...last turn/end... }`；`:94-100` 只在完全找不到 `turn/end` 時才丟錯。
- `packages/session-persistence/src/fork-contract.ts:36`：`requestDigest` 的輸入是 request core；`:123-125`：receipt 只有 `seedLength`，沒有 resolved boundary。

**參考做法**：Codex 的 fork 以明確 item／turn 邊界為輸入；opencode 沒有 fork，child 由 job／spawn 產生，不存在「靜默改成別的邊界」。

**建議方向**：越界就拒絕（`atSeq out of range`），或回傳解析後的 boundary 並納入 receipt，讓呼叫端能驗證自己拿到什麼。

**可否本地單檔測試**：可。以 `atSeq = events.length + 100` 呼叫 `completedTurnPrefix`，斷言現況回整段而非報錯。

---

## 我實際讀過的關鍵檔案

產品程式碼（只讀）：

- `packages/core-session/src/serialization/fact-journal.ts`
- `packages/core-session/src/projection/rewind.ts`、`packages/core-session/src/conversation/history/result-resources.ts`
- `packages/core-session/src/events/types.ts`（header 欄位）
- `packages/session-persistence/src/write-behind.ts`
- `packages/session-persistence/src/repair.ts`
- `packages/session-persistence/src/fork.ts`、`fork-contract.ts`、`fork-controller.ts`
- `packages/session-persistence/src/coordinator-factory.ts`
- `packages/session-persistence/src/coordinator/{mutations,load,lifecycle,documents,process-read-latches,fact-capacity,managed-document,managed-documents,managed-execution-source,process-read-assembly}.ts`
- `packages/session-persistence-jsonl/src/backend-factory.ts`、`backend/{fact-journal,document-write,session-io,format-upgrade}.ts`
- `packages/session-executor/src/{durable-session.ts,durable-session 週邊}`、`lifecycle/{fork-handoff,rewind-facts,managed-native-recovery}.ts`
- `packages/subagent/src/task/persistence.ts`（document 呼叫端）
- `apps/cli/src/run.ts`（耐久模型文件）

參考專案：

- Codex `rollout/src/recorder.rs`（writer 狀態機、flush／persist／shutdown、channel、pending_items、error 處理）
- opencode `session/store.ts`（SQLite、claim／release、resume_attempts）、`job.ts`（durable job ＋ recovery）

## 未涵蓋與限制

- 未執行任何測試；本輪僅以程式碼閱讀與行號證據推論。所有「可否單檔測試」欄位是可驗證性判斷，不是已驗證結果。
- `packages/session-persistence/src/coordinator/task-document-transition.ts`（48 KB）與 `task-document-operation.ts`（35 KB）只讀了守衛與 poison 使用點，未逐條審查其狀態機。
- `packages/core-session/src/managed/execution-state.ts`（96 KB）與 `restored-view.ts`（44 KB）只讀了對外 API 與 currentness guard 的形狀，未逐條追蹤 fold／restore 流程。
- SQLite backend 不存在（`PersistenceBackend` 只有 JSONL 實作），因此「coordinator 抽象是否適合 SQLite」未評估。

**S-07 部分完成（2026-11-05）**：非 managed 的 rewind 現在會在**還原檔案之前**寫入 durable intent（`rewind-intents/<sessionId>.jsonl` 的 `begin`），還原與 marker settle 後寫 `complete`；crash 留在 `begin` 即為「檔案可能已還原但沒有 marker」的證據，`readPendingRewindIntents` 可查詢。managed 路徑（`managed.execute`）尚未接上 intent；desktop／SDK 的 rewind 入口已把 intent 傳入 `withRewindFacts`。

**S-07 managed 路徑（2026-11-05）**：`withManagedRewindFacts` 與 `OriginalManagedRewind.execute` 已接受同一組 intent hooks，desktop 的 managed rewind 也會在還原前寫 `begin`、完成後寫 `complete`；ordering 由共用的 `runRewindRestoration` 固定（begin → restore → complete，restore 失敗不寫 complete）。尚未做：pending rewind intent 的 UI／reload 診斷。

**S-07 診斷（2026-11-05）**：desktop reload 會讀取 pending rewind intents，並以 `rewind-intent-pending` 併入 `desktop/tasks/projection` 通知；desktop 的 runtime diagnostics 已接受新增的 job-record／document-write／rewind 類 issue（先前只允許兩個舊 kind，會把新問題丟掉）。
