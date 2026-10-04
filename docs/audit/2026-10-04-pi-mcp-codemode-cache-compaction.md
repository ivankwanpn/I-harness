# Pi 1.0.2：MCP、Code Mode、快取與壓縮研究

本輪依使用者指定，唯讀研究 `D:/agent-complete/pi-1.0.2`，並對照 IH 現行副本 `D:/frontend-test`。Pi 的 MCP、Code Mode、coding-agent 套件均為1.0.2；monorepo 根套件另為0.0.3。研究由子代理完成，Root 已讀研究記錄並直接核對 changelog、cache warmer、摘要請求與 IH 動態工具描述。沒有修改參考專案、安裝依賴、啟動 Pi、呼叫模型或執行 benchmark。這份文件是研究結論，以下 IH 借鑑尚未實作。

## 先釐清「省了約40%」的範圍

Pi 1.0.0 的 [CHANGELOG](D:/agent-complete/pi-1.0.2/packages/coding-agent/CHANGELOG.md:82) 寫：預設工具及 Code Mode 都啟用時，GPT-5.6 的請求提示約從5300降至3300 tokens。具體改動是縮短 helpers/models 說明、避免 direct 工具完整宣告在 Code Mode 中重複、縮短 MCP server 提示。

這是 Pi 自己前後版本的提示精簡例子。有限本地搜尋沒有找到樣本數、tokenizer、原始 payload、資料集或實跑 benchmark 結果，不能把它解讀為傳統 MCP 與 Code Mode 全任務 A/B，也不能當成 IH 可保證的節省比例。

四種機制要分開量測：

| 機制 | 直接作用 |
| --- | --- |
| 宣告精簡／延遲發現 | 減少每次送入模型的工具 schema 與說明 |
| 腳本內過濾／聚合 | 減少模型收到的工具結果內容 |
| Prompt cache | 重用相同前綴的計算與計費；cache-read tokens 仍佔上下文 |
| Compaction | 用摘要與保留區間改變模型可見歷史；摘要另有模型成本與資訊損失風險 |

## 1. MCP 與工具發現

Pi 的 MCP client 仍使用標準 initialize、tools/list、tools/call；Code Mode 不改 MCP wire protocol。CLI 預設 MCP exposure 是 `codemode`／deferred：完整 schema 不在初始模型工具列，也不 inline 到 Code Mode 描述，但脚本能呼叫。`hidden` 工具則不給腳本呼叫。

- 腳本用 BM25 `searchTools()`（預設8項）、`describeTool()`、`describeNamespace()` 查所需工具；這條路不把全部 schema promote 成模型 direct tools。
- 模型層的 `tool_search` 才將選中的宣告加入下一個 request，並記錄 transcript。
- Code Mode 的 on 模式避免重複 direct 工具宣告；only 模式才隱藏 direct 列並在 Code Mode 描述它們。
- Inline budget 預設3000 estimated tokens，以字元÷4估計；不涵蓋全部前言及共用型別成本，因此不是精確 tokenizer 上限。
- MCP server 目錄另有界：每個簡述最多250字元，system section 最多4096字元。

重要細節：CLI 的 `ALL_TOOLS.description` 實際包含完整 TypeScript sample。這些資料起初位於 sandbox，但印出全部 `ALL_TOOLS` 或全部搜尋結果仍會把大量 schema 送回模型。

來源：[exposure](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/extensions/mcp/tools.ts:41)、[去重](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/extensions/codemode/tool.ts:329)、[helper 注入](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/extensions/codemode/execute.ts:345)、[promotion](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/extensions/tool-search/tool.ts:197)。

## 2. 腳本與結果如何減少模型上下文

每次 execution 使用 fresh worker與獨立 QuickJS/WASM，globals不跨執行；compiled WASM 的記憶體快取是另一件事。腳本透過工具能力呼叫外部操作，沒有任意 Node/fetch/filesystem import。

完整 nested tool result 留在 host／VM，模型收到的是 text、console、image、頂層 return及失敗資訊。腳本可以 filter/map/reduce或聚合多個工具結果，只印需要的欄位。MCP 會把完整 CallToolResult 作為 structuredContent 給腳本，去除 top-level `_meta`；`isError:true`仍 resolve，腳本必須檢查。

CLI 的 nested call 經共用 executeTool/runToolCall pipeline，包含 input validation、permission/result hooks、parentToolCallId。Stop會 interrupt/terminate worker、abort pending calls，MCP發 cancellation notification；遠端已發生副作用不會因此回滾。

結果限制仍需分層理解：sandbox emitted outputs 有16Mi字元及100000 items上限，頂層 return未走同一計數；CLI文字再用預設10000 estimated tokens首尾預覽，完整文字寫temp。完整MCP傳輸、JSON serialization及host記憶體成本仍存在。跨執行 store是有界JSON資料，成功才保存；CLI將其記入session branch，支援resume/fork。Temp路徑則没有同等耐久引用保證。

来源：[full MCP result](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/extensions/mcp/tools.ts:213)、[共用 pipeline](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/core/agent-session.ts:699)、[輸出截斷](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/extensions/codemode/execute.ts:272)、[branch store](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/extensions/codemode/execute.ts:219)、[worker stop](D:/agent-complete/pi-1.0.2/packages/codemode/src/runtime/host.ts:242)。

## 3. 快取命中

Pi 將 system/tool 變更記為追加的 transcript patch，Code Mode 描述保持穩定。能支援中途system/tool changes的provider可保留較早前綴；不支援的route會collapse成目前leading system，仍可能失去cache。

Anthropic使用cache_control標記；Responses可使用session affinity/cache key，實際字段與TTL依provider compatibility決定。模型usage的cacheRead/cacheWrite、MCP工具目錄記憶體cache和compiled WASM cache應分開報告。

Footer命中率為`cacheRead/(input+cacheRead+cacheWrite)`。Cache waste是對前後prompt和讀取量的估計，不是server回報的miss原因；compaction/branch summary後會reset baseline。已有SDK cache probe可以記錄usage及latency，但本地未附實跑結果，不能据此宣稱命中率提高。

Pi另有 **cache warmer**：到宣告TTL約90%時，重送上一份context，`maxTokens:1`、`maxRetries:0`。它以預估續作機率與模型價格計算收益，預期節省至少$0.05才發送；idle機率0.15只有自家觀測註解，未附樣本。這是真正額外的模型請求，usage單獨記為cache_warm，不能算作免費節省。

來源：[transcript compatibility](D:/agent-complete/pi-1.0.2/packages/ai/src/utils/transcript.ts:104)、[cache統計](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/core/cache-stats.ts:56)、[warmer請求](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/core/cache-warmer.ts:330)、[收益模型](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/core/cache-warmer.ts:378)、[SDK probe](D:/agent-complete/pi-1.0.2/packages/coding-agent/test/sdk-codex-cache-probe-tool-loop.ts:67)。

## 4. 壓縮

預設超過`contextWindow−16384`觸發，原文保留最近約20000 tokens；保留邊界不拆tool call/result。估計优先使用最後有效provider usage，加後續文字估計；context edit/compaction後舊usage失效。

摘要另發模型請求，帶前次summary、累積檔案操作，工具結果每條只取前2000字元。摘要請求明確cacheRetention:none，避免一次性摘要寫cache；截斷的length摘要拒絕提交。成功保存summary、firstKeptEntryId、usage與完整system/tool checkpoint，原始日志不刪除，恢復時按active branch重建。

壓縮改變歷史前綴，下一輪cache與舊usage不能直接沿用。保留原始日志不等於模型自動拿回被摘要丟掉的內容，2000字元裁切也可能漏資訊。這些是實作取捨，尚無本地資料集結果證明任務保真度或成本收益。

來源：[估計/觸發](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/core/compaction/compaction.ts:196)、[usage失效](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/core/compaction/compaction.ts:226)、[no-cache摘要](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/core/compaction/compaction.ts:619)、[checkpoint](D:/agent-complete/pi-1.0.2/packages/coding-agent/src/core/session-manager.ts:1260)。

## 適合 IH 的下一步（未實作）

1. **穩定、精簡 Code Mode 描述。** Mixed mode避免重複direct schema；deferred工具按需描述；將live cell IDs移出會反覆變化的工具說明。[IH catalog](D:/frontend-test/packages/code-mode/src/catalog.ts:28)、[live IDs](D:/frontend-test/packages/code-mode/src/register.ts:76)。
2. **加入有界腳本 search/describe。** 搜目前授權snapshot，選少數工具才拿完整宣告；沿用IH現有broker、角色、核准及Stop。保留IH policy refusal終止cell的語義，Pi可catch的一般permission block不直接替換它。
3. **分開量測schema、結果、cache與摘要用量。** 記錄固定workload、實際payload、usage、重複次數與latency；marker/affinity依route能力加入。Warmer需要單獨計算新增用量。
4. **校準壓縮估計。** 引入有效usage加trailing estimate及projection revision失效規則；保留IH已有original-message prefix summarizer與prune，量測它們對cache的影響。[IH summarizer](D:/frontend-test/packages/compaction/src/index.ts:207)。
5. **補有界的耐久狀態／完整結果引用。** Resume保留游標與IDs，長輸出接既有retention服務；不要把worker continuation持久化，也不擴大grep預設32KiB上限。

IH已經有Code Mode、deferred discovery、broker、fresh WASM worker、transfer/output caps、角色核准及Stop。可借鑑的是描述、發現、計量與恢復細節；本研究没有實測IH可獲得固定百分比收益。

詳細私人研究底稿：[findings.md](D:/frontend-test/.superpowers/sdd/2026-10-04-pi-research/findings.md)。
