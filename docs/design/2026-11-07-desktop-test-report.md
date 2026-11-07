# IH Desktop 實測報告（2026-11-07）

環境：`D:\ih0113rc2test_env`（portable app、獨立 userdata／config、Windows x64）
建置：0.1.13-rc2 → rc13（未合併測試分支；rc13 為目前最新交付）
測試方式：CDP 驅動 `window.ihDesktop.request`、repo 單元／整合測試、實際會話。

## 一、已修復問題（含 commit）

### 啟動與輸入
1. 首個 prompt 偶發 `model_error`：turn 準備期間的暫時性會話讀取失敗導致 recovery 重載／drain（`FACT_PRECONDITION_STALE`）。修正：IPC 對 allowlisted 讀取方法做短暫重試（12×150ms），寫入不重試。
2. 首個 write 誤報 `INSTRUCTIONS_REPLAN_REQUIRED / unseen-rules`：preflight 重新取 snapshot 比對 evidence。
3. legacy fork 子會話無法續傳（bootstrap document 未關閉）：ready observation 後關閉 managed document。
4. forked child 刪除失敗（selection 混入 document key）：拆分 `ids` 與 `sessions`。
5. 大型 workspace 啟動指令失敗（`FS_WATCH_GAP`）：chokidar `ignoreInitial:true`。
6. 受限沙箱 shell 在 read-only／workspace-write 直接 crash（`napi_get_last_error_info`）：`koffi.view` 在打包 Electron 下失效，改 Electron 分支逐次 decode。

### 上下文與壓縮
7. 壓縮錯誤被誤標為 `capacity-unavailable`：replacement 驗證錯誤改映射到正確 blockedReason。
8. rewind 後壓縮被 `ambiguousTurn` 擋住：`rewind/point` 重置 open-turn tracker；delivery 追蹤僅限 active generation 且排除 tool。
9. unpriced replay（signature/opaque）導致 soft reduction 被擋：capacity unknown 時以完整 heuristic prefix 對 threshold 保底觸發（managed／legacy 兩路徑）。
10. partial reduction 永遠不發布：replacement 讓 candidate `fixedInput:true`，`reductionProgress` 拒絕；自帶 rewrites 時允許 after fixedInput，實測 33,240→14,014 tokens 成功發布。
11. 自動壓縮在 unpriced 會話完全不啟動：兩個 auto gate 都要求 pressure known；補 heuristic fallback。
12. CJK token 高估：非 ASCII 原按 UTF-8 byte 計價（中文 3 tokens/字），改為 CJK 每字 1 token；實測 ratio 1.8x→1.29x。
13. `context/usage` 缺 cache 數字：新增 `cacheReadTokens`／`cacheCreationTokens`。
14. signature 讓容量計算失效：簽章原走 `opaque()` → estimate unknown → compatibility；改 bytes/2 直接計價（保留 signature-token-cost，不再不可定價）。實機 budget 變 `estimated/known`。

## 二、驗證結果

| 套件 | 結果 |
|---|---|
| token-meter | 55/55 |
| context-engine | 98/98（＋prepared-assessment 18/18） |
| core-agent | 649/649（全量） |
| core-session（replacement／usage／attribution） | 50/50 |
| fs-watch | 70/70 |
| desktop-gateway（host 專項） | 4/4 |

實機驗證：
- 一般對話＋bash 工具、排程 45s 觸發、手動壓縮（committed／ready）、自動壓縮、prune 大工具輸出、rewind 後續傳；
- CJK 長對話（window 24k）6 回合 0 失敗、1 次 replacement，heuristic 18,027→14,851；
- Code Context：索引 91 files／250 chunks，`code_context_search` 命中正確；
- Context Mode：>60KB 輸出存成 managed artifact（ref 可讀、可分頁）；status/search 限 legacy；
- Memory：note 寫入＋跨會話 `memory_search/list/read` 回憶；
- Hooks：信任綁定（app exe＋絕對 script）、approve 後 `prompt/submit` 觸發；
- Skills：`skill_get` 載入並依指示回覆；
- MCP：stdio 與 streamable-http 皆可掛載／列出／呼叫；壞 server 不影響會話；
- 子代理：`spawn_agent` → completed、finalText、artifact result 可讀。

## 三、已知限制（未修）

1. **Context Mode status/search 只涵蓋 legacy store**：managed artifacts 可按 ref 讀取，但不列入 results 計數／搜尋；`clear` 只清 legacy（實測 managed-v1 仍有 182 個 artifact）。
2. **MCP live 變更**：會話進行中 enable／修改 MCP，會擋 submit 到 handshake 結束（~60s pending）；失敗會讓該會話 selection 進入 recovery（需重啟）。兩次小修（放寬 failed、defer refresh）都被既有設計／測試擋下；正解是版本化 background refresh。
3. **Code Context hybrid** 未測（環境無 Ollama／embedding server），僅 lexical。
4. **heuristic 仍約 1.29x** provider 上報值（保守），未做 provider 校準收斂。
5. 小體驗：`subagents/result` 與 Context Mode read 的 `maxBytes` 下限 1024、錯誤訊息未說明。

## 四、交付建置（未簽署、不合併）

| 版本 | Setup SHA256 | Zip SHA256 |
|---|---|---|
| rc13 | `54761a2124ad583deda427bb8a1c184739f24581d3f1b77bb73bcebbe07b3971` | `16bbec42900c4797b090130c732876f271c0b9517138cf10907b33899f22fbef` |
| rc12 | `4a8ed27f7123a1b55c82f7ee95244ddffa5e6c9ba3eb939cf4ecc105f3539013` | `a7a2676fbd7ad1a2353508257e90e6bc16bd40efc4c808c89a152920eeb59552` |
| rc11 | `d51cd632485fcae1527500ef411a990ef39960d04d4d99e4de53db291e7dd686` | `595e6a77ca0a07388ea9d38b21d969bdeb7fff00ccec483a12de49366d4cebca` |

## 五、目前測試環境狀態

- app：rc13；window 1,000,000；
- Context Mode／Code Context：ON；
- Memory：停用；Hooks：已 revoke／刪除；MCP：清單為空；
- 測試殘留：`workspace/demo/codecorpus`（91 個 .ts，Code Context 測試用）。

## 六、建議下一步

1. MCP 版本化 background selection（舊 witness 保留到新 mount 就緒）；
2. Context Mode 將 managed artifacts 納入 status/search（或 UI 改文案）；
3. provider 校準把 1.29x 收斂；
4. 完成後做一次 rc14 回歸與交付。
