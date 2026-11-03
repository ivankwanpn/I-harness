# R4A A3 — Code Mode emitted output delivery (2026-10-19)

狀態：**UNACCEPTED，等待 Codex 驗收。** 本批只完成 R4A A3（Code Mode emitted output 的完整保存與有界 model/archive 輸出）及其必要接線。R4A 其餘 A1/A2 矩陣、A4–A6、R4B/C、R5、R6 仍未完成；沒有 merge／tag／release。

## 1. 起點、結束與範圍

| 項目 | 值 |
| --- | --- |
| 分支 | `codex/v0.1.13-development` |
| 起點 HEAD | `4730ca83f5f3e97a1ab5a4bf8d8d2b5131987456` |
| 本批產品 commit | `954f6c878426a6b55fb65899b31c11f023f60d4e` |
| 本批產品 diff | `4730ca83..954f6c87`（14 改檔＋2 新檔，+392／−278；docs commit 隨後） |
| full R4A BASE | `91d8fef04253272a437c68f5f2f84a657fa53d3b` |
| 產品版本 | `0.1.13-rc.1`（未改） |
| 原拆分計數 | 27/43（未改） |
| 本批 evidence | `.tmp/context-r4a-a3-20261019/`（新的 logs／scripts；舊 evidence 未覆寫） |

## 2. 實際入口與責任對照（先畫再改）

| 階段 | 實際 owner／入口 | 本批處理 |
| --- | --- | --- |
| guest 發出 text/image/audio | `packages/code-mode/src/worker.mjs`（WASM guest，JSON 邊界） | 不變；worker 已在 host 之前丟棄的內容仍為 source-limited |
| host 接納 item | `packages/code-mode/src/runtime/output.ts` `output()`（ITEM_CAP／maxResultBytes barrier） | 不變；只有 accepted item 進入後續 |
| F1 原始 item 事實 | `register.ts` `onEvent` → `facts.required({type:'code/output'})` | **不變**；每個 accepted item 一次，是原始捕獲與 receipt |
| 有界 model/archive 表示 | `runtime/output.ts` `project()` → `CodeModeRuntimeOptions.retainText` | 改為回傳 `CodeModeTextRetentionResult`（`ResultEnvelope`／明確 unavailable／recovery-required） |
| 完整結果保存 | **新** `session-executor/src/lifecycle/code-text-retention.ts`（`createCodeTextRetention`） | 用既有 `createResultCapture`＋`ContextOutputService.beginResult/confirmResultOwner` 寫入 `json-utf8-v1` artifact；scope 綁原 cell／session／source |
| 模型／歷史 DTO | `packages/code-mode/src/types.ts` `CodeModeTextRetention` | 新增 `envelope`／`unavailable`；移除 `path`／`contextRef` |
| 正式結果 fact | `register.ts` `observationOutput` → code_exec/code_wait tool result → 既有 tool-result finalization | 不變；bounded observation 內含 managed ref，tool/result F1 fact 即 ref 事實 |
| 讀取 | 既有 `context_output_read`／`ContextOutputService.readResult` | 不新增 reader；以 managed ref 分頁讀回（cold digest 控制） |
| 事件投影／search | `core-session` `code/output` projection、`desktop-gateway/src/execution.ts`、renderer project | **不改**：per-item `code/output` 仍是原始事實；本批沒有改事件契約（見 §5） |

## 3. 已移除／保留 legacy／尚未切換

**已移除（新 shipping 路徑）**

- `session-executor/src/context-output.ts` 的 `createNativeCodeTextRetention`：legacy `service.capture`＋`context/result-ref`＋actor/parent grant 分支。
- `runtime/output.ts` 的 `createUnifiedSpillStore()` fallback：沒有 durable owner 時不再寫未追蹤 temp file，也不再內嵌巨大文字。
- `CodeModeRuntimeOptions.spillStore`、`CodeModeMountOptions.spillStore`、assembly 的 `codeSpillStore`，以及 `captureReference` 接線。

**保留 legacy（有明確理由）**

- `installNativeContextOutput` 仍以 `legacyToolCapture:false` 掛載：其 tool-output capture cascade 原本就停用，目前只提供 inherited-session 的 legacy ref grant 與 recovery 文字；A4 會處理剩餘 consumer。
- `packages/session-executor/src/lifecycle/reference-retention.ts` 仍服務上述 legacy mount。
- `outputSpill` 選項仍在 assembly type 上，但本批後已無 shipping consumer；其 guard retirement 屬 A4/A6，未在本批刪除。

**尚未切換（明列）**

- `code/output` 事件與其 search／gateway／renderer 投影（本批刻意不改；見 §5）。
- `code/output` 的 managed artifact search 索引：managed artifact 不進 legacy ContextOutput search，A4 範圍。
- 跨 session 讀取 child 的 code artifact：只依本次 session 的 pin；parent／cross-owner read 屬 A4。
- packaged Gateway／CLI real-entry 的 code output 流程未跑（A6）。

## 4. 契約與資料版本

- `CodeModeTextRetention` 現在是 `{stored, envelope?, unavailable?, cellId, sessionId?, admittedBytes, omittedBytes, complete, truncated}`；`envelope` 只在真 artifact 時出現，`preview` 固定為空（模型視窗已是 observation 自己的 bounded `text`，不重複巨大內容）。
- `unavailable` 明確區分 `no-owner`／`quota`／`encoding`／`storage-refused`／`unsupported-owner`／`capture-canceled`／`storage-unknown`；沒有退回 spill 或 inline giant text。
- artifact codec 沿用 `json-utf8-v1`（quotes／backslash／NUL／emoji／unpaired surrogate 由 JSON 編碼保留原值），沒有新增 codec。
- **session format 不變（10）**、沒有新事件類型、沒有資料遷移；舊 `context/result-ref`／legacy `context_output_read({refId})` 仍可按原資料讀取。
- `ResultEnvelope.execution` 由 cell status 決定（completed→succeeded、failed→failed、terminated→canceled、running→unknown），`dispatch:'not-dispatched'`（本結果不是工具 dispatch）。

## 5. 為什麼不改 `code/output` 事件

`code/output` 是 guest accepted item 的**原始捕獲**：每個 item 一次、帶完整 content、已在 F1 required settlement 中。A3 新增的是「joined emitted text 的 model/archive 完整保存」，其 ref 事實放在同一次 code_exec/code_wait 的正式 tool/result（bounded observation 內的 envelope）。如果再改 `code/output` 為 envelope，會同時失去原始 item 事實並造成第二份 ref 權威；因此本批維持原契約並以測試證明「原始 item 一次＋tool/result ref 一次」。

## 6. 新反例與修正前／修正後

A3 是 cutover，不是既有 bug 修補；本批沒有把「新測試在舊 source 上失敗」當成 RED（舊 source 沒有新 port，會是 import/collection failure，不是有效行為 RED）。修正前後的行為對照如下：

| 行為 | 修正前（HEAD 4730ca83） | 修正後 |
| --- | --- | --- |
| 大量 emitted text 保存 | `service.capture` legacy optional capture → `context/result-ref`＋spill 路徑 | 同一 artifact owner 的 `json-utf8-v1` managed artifact；observation 帶 immutable envelope |
| 無 durable owner | fallback `createUnifiedSpillStore()` 寫 temp file | `stored:false, unavailable:'no-owner'`，不寫檔、不內嵌 |
| 已知 quota／encoding／storage-refused | legacy capture 行為 | 明確 `unavailable` reason，guest outcome 不變 |
| 保存 finish 回執 unknown | 依 legacy capture retry | 同一原 capture 可再 settle（只快取 known terminal），`recovery-required` 不變成成功 |
| model/archive 大小 | `textRetention` 帶 path/full join 資訊 | bounded envelope（`preview:''`）＋bounded observation text；JSON 總量 ≤ 64,000 bytes 控制 |
| 正式 ref 事實 | `context/result-ref` legacy event | 已提交的 code_exec/code_wait tool/result fact |

新增／遷移的實際控制：

- **新檔** `packages/session-executor/test/retained-code-output.test.ts`（真實 registerCodeMode＋managed document＋F1＋真 ContextOutput service）：
  - 3 個 accepted item（text／image／text）順序保留；每 item 一次 `code/output`；無 `context/result-ref`；model output ≤64,000 bytes；
  - quotes／backslash／NUL／emoji／unpaired surrogate 經 artifact 冷讀 JSON.parse 後 byte-for-byte 等於獨立 literal fixture；`contentDigest`／`encodedBytes` 對得上；
  - unknown `finish` 之後以同一原 operation 第二次 settle 成功，guest invoke 0 次（純 text cell），finish 2 次；
  - child document 的 artifact 只給 child 讀，parent 讀取被拒且 parent 無任何事件。
- 遷移 `packages/code-mode/test/text-retention.test.ts`（7 個控制）：改以 host `retainText` 假 owner 驗證 steering 順序、每 window 獨立、source-limited、failure diagnostic、dispose drain、late output、無 owner 明確 unavailable；移除 file spill 斷言（理由：spill 已退出 shipping；檔案的完整保存改由 host artifact 控制驗證）。
- 遷移 `session-executor` 的 `native-context-output`（emitted text 改 managed envelope＋cold read／Stop → capture-canceled）、`managed-context-output`（single capture／artifact ownership／Stop 後仍可讀）、`retention-grants`（quota 拒絕與 F1 unknown）、`code-mode`（assembly artifact cold digest）、`native-context-lifecycle`（兩個 managed ref 跨五種 framing／compaction／restart 的實際讀取）。

## 7. 實際測試與型別（source 測試；packaged 行為分開）

全部 receipt 在 `.tmp/context-r4a-a3-20261019/logs/`，每個記錄 argv、cwd、Node、起訖、exit、完整 stdout/stderr、before/after maintained product/test manifest。

| receipt | 範圍 | 結果 |
| --- | --- | --- |
| `a3-final-code-mode-suite` | `packages/code-mode` 全部（9 檔／93 tests） | 1 failed（**既有** `bounds retained completed cells`；在 HEAD 單獨執行同樣失敗） |
| `a3-final-executor-batch` | retained-code-output、native-context-output、managed-context-output、retention-grants、code-mode、nested-broker-retention、native-context-lifecycle、search-code-mode（8 檔／38 tests） | 5 failed：`native-context-output` shell capture 1（**既有**）＋`search-code-mode` 4（**既有**）；其餘 33 passed，含全部本批新／遷移控制 |
| `a3-subagent-code-mode` | subagent code-mode／retained-task／tools（81 tests） | 78 passed；3 failed 為**既有**（已在 HEAD 重現：tools.test.ts 三項 status 斷言） |
| `a3-final-types-executor` | session-executor `tsc --noEmit` | exit 0 |
| `a3-final-reachability` | `check-reachability.mjs --gate` | exit 1：仍是交接 WIP 既有 **6** 個 unused-export，沒有新增豁免／reseed／假 consumer |

另逐一通過（exit 0）：code-mode、session-executor、context-output、output-retention、core-session、subagent、exec、core-tools、desktop-gateway 的 `tsc --noEmit`。

**未跑／未宣稱**：packaged Gateway／CLI 的 code output real-entry 流程、managed artifact search、renderer build；本批沒有新增 1MiB／100MiB code 輸出控制（新控制是 ~60KB 文字＋PNG，未把它稱為大輸出資格）。

## 8. 失敗與既有問題（原樣保留）

- `code-mode/test/runtime.test.ts > bounds retained completed cells…`：在 HEAD 單獨重跑即失敗（`Active cell limit exceeded`，時序競態），本批未修、未改其斷言。
- `session-executor/test/native-context-output.ts > captures full real shell stdout…`：HEAD 已存在的 shell capture 形狀失敗，A3 未觸及。
- `session-executor/test/search-code-mode.ts` 4 項：HEAD 已存在的 legacy search/stop 失敗。
- `subagent/test/tools.test.ts` 3 項：HEAD 重現（狀態時序），與 A3 無關。
- 先前 `code-mode-children-close-boundary` 的 cleanup flake 仍偶發；本批最終 receipt 未出現。

## 9. 未完成（不因本批而改變）

- R4A A4：MCP `structuredContent`／`isError`、media、search/export、跨 owner catalog 授權、managed artifact search、剩餘 consumer 切換。
- R4A A5／A6：fresh-host crash cuts、literal9/8→10 最終 source 重跑、100MiB／100-child、packaged real-entry。
- R4B/R4C、R5、R6 未開始。

## 10. 程序與收尾

- 所有測試依序執行、測試期間沒有修改產品；每個 receipt 的 before/after source manifest 相同（`96e8c01e…`／最終 commit 後同內容）。
- 沒有背景 job 殘留；沒有 push、merge、tag、release；版本與拆分計數不變。
- 舊 evidence（`.tmp/context-r4a-fix-round1-20261019/` 等）未被覆寫。

## 11. 封存摘要

| 項目 | 值 |
| --- | --- |
| 最終產品 source | 4594 個 apps/packages 檔（排除 node_modules/dist/build/.tmp），digest `96e8c01e129fd827d559629d34914e9cdbad38659e79e5a6e0623e9acda5adf2` |
| closed evidence | 31 檔（logs receipts＋runner／close scripts），digest `3ec8a55c1ce6fdbfe51328af357d5771cab64c03821273c3d065982680348edc` |
| 產品 commit | `954f6c878426a6b55fb65899b31c11f023f60d4e`；本文件 commit 緊接其後，最終 HEAD 以回報訊息為準 |
