# context-mode 與 claude-context：研究及 IH 子系統方向

研究日期：2026-10-04，Asia/Hong_Kong。使用者要求研究兩個 MCP，並澄清「以子系統方式做」是指這兩項；目前 Pi 改善仍沿用既有開發方式。本文件交付程式碼研究與獨立子系統方案，兩個 MCP 尚未接入 IH。

兩名研究代理唯讀檢查固定 commit；Root 核對主要結論、版本、授權及 IH 現有能力。沒有安裝套件、執行參考程式、啟動服務或呼叫模型／embedding。以下「已確認」是靜態來源證據，「推論」沒有被實跑重現，「上游報告」不是 IH 實測。

## 核對版本

| 專案 | 核對來源 | 套件版本 |
| --- | --- | --- |
| context-mode | `80d4e823adebbe1e758b558522e3da20312a66cc`，2026-10-04 commit | 1.0.169 |
| claude-context | `6fc318b4e3ce58e2898b00a9c3538ead9e24dee5`，2026-07-14 commit | 0.1.15 |

版本是來源內 metadata，並非宣稱 npm 最新標籤。[context-mode metadata](https://github.com/mksglu/context-mode/blob/80d4e823adebbe1e758b558522e3da20312a66cc/package.json)，[claude-context metadata](https://github.com/zilliztech/claude-context/blob/6fc318b4e3ce58e2898b00a9c3538ead9e24dee5/packages/mcp/package.json)。

## 作用與成本不同

| | context-mode | claude-context |
| --- | --- | --- |
| 主要用途 | 執行／抓取內容後，留在索引端並按需回傳 | 索引程式碼，搜尋與問題相關的片段 |
| 檢索 | SQLite FTS5、BM25／trigram／RRF | Milvus 的 BM25 sparse + dense cosine + RRF |
| 額外模型服務 | 核心文字檢索不依賴 embedding | 現行 MCP 要 embedding，亦要 Milvus |
| 適合 IH 的責任 | 工具結果保留、精確取回、會話回憶、壓縮後恢復 | 專案程式碼索引、版本更新、語意／混合檢索 |

context-mode 的 chunk、FTS、排序及來源替換在其 [store implementation](https://github.com/mksglu/context-mode/blob/80d4e823adebbe1e758b558522e3da20312a66cc/src/store.ts#L959-L1388)。claude-context 的混合檢索可直接核對 [Milvus implementation](https://github.com/zilliztech/claude-context/blob/6fc318b4e3ce58e2898b00a9c3538ead9e24dee5/packages/core/src/vectordb/milvus-vectordb.ts#L476-L697)；其 MCP 初始化選用 Milvus，而 Ollama 只替換 embedding 服務。[MCP initialization](https://github.com/zilliztech/claude-context/blob/6fc318b4e3ce58e2898b00a9c3538ead9e24dee5/packages/mcp/src/index.ts#L55-L73)，[embedding factory](https://github.com/zilliztech/claude-context/blob/6fc318b4e3ce58e2898b00a9c3538ead9e24dee5/packages/mcp/src/embedding.ts)。

## context-mode：值得採用的模式

已確認：大輸出可先索引，回傳匹配片段／引用；搜尋主要給 ranked snippets，未提供公開的 ref+offset 精確讀取工具。宣稱的 aggregate 大小在實作中使用字元計數，並非完整 serialized UTF-8 預算。伺服器亦會在啟動及定時查詢 npm 版本，因此不能宣稱完全沒有網路流量。[Server source](https://github.com/mksglu/context-mode/blob/80d4e823adebbe1e758b558522e3da20312a66cc/src/server.ts#L1879-L2036)。

已確認：它的執行器啟動普通本機子程序，繼承環境及 HOME，並能使用檔案／網路。這不構成 IH 的權限隔離模型；IH 應沿用 QuickJS 與 broker。[Executor](https://github.com/mksglu/context-mode/blob/80d4e823adebbe1e758b558522e3da20312a66cc/src/executor.ts#L282-L329)，[environment](https://github.com/mksglu/context-mode/blob/80d4e823adebbe1e758b558522e3da20312a66cc/src/executor.ts#L674-L707)。

已確認：相同來源標籤會替換舊索引；被拒絕或刪除的檔案可因 refresh 跳過而仍保留可搜內容。IH 的設計因此需要不可變結果 ID、精確來源與目前可見性檢查。[Source replacement](https://github.com/mksglu/context-mode/blob/80d4e823adebbe1e758b558522e3da20312a66cc/src/store.ts#L1032-L1073)，[refresh](https://github.com/mksglu/context-mode/blob/80d4e823adebbe1e758b558522e3da20312a66cc/src/store.ts#L1391-L1458)。

IH 已有 `session_search`／`lineage` 及 FTS5；研究基準 `d0eca79f` 的 `deriveSearchText` 未涵蓋 `code/call`、`code/result`、`code/output`。後續可補進既有投影，不需另造會話資料庫。[IH search](D:/frontend-test/packages/session-query/src/tools.ts)，[IH projection](D:/frontend-test/packages/core-session/src/index.ts)。

上游 benchmark 的整體是約96% **bytes** 減少，98%是部分摘要 workload。腳本用固定 fixture 與手寫程式的 stdout，token 以 bytes÷4 估計；未證明相同任務品質、完整提示成本或 IH 帳單收益。[Benchmark](https://github.com/mksglu/context-mode/blob/80d4e823adebbe1e758b558522e3da20312a66cc/BENCHMARK.md#L8-L75)，[measurement code](https://github.com/mksglu/context-mode/blob/80d4e823adebbe1e758b558522e3da20312a66cc/tests/ecosystem-benchmark.ts#L440-L475)。

授權是 Elastic License 2.0；本方案採獨立實作的模式，不把其整套程式納入依賴。[License](https://github.com/mksglu/context-mode/blob/80d4e823adebbe1e758b558522e3da20312a66cc/LICENSE)。

## claude-context：值得採用的模式

已確認：AST／文字 chunker、背景索引、增量檔案 hash 與 hybrid search 都有實作；AST 失敗會 fallback。現行 exported backend 沒有 SQLite／FAISS／不需 embedding 的詞法模式，雖然 manifest 有 FAISS dependency。[Chunker](https://github.com/zilliztech/claude-context/blob/6fc318b4e3ce58e2898b00a9c3538ead9e24dee5/packages/core/src/splitter/ast-splitter.ts)，[backend exports](https://github.com/zilliztech/claude-context/blob/6fc318b4e3ce58e2898b00a9c3538ead9e24dee5/packages/core/src/vectordb/index.ts)。

已確認：增量同步在 vector replacement 成功前保存新 hash。推論：更新失敗後，下輪可能把檔案視為未變。這不是本輪重現的 runtime 故障；IH 方案要求 staging generation 成功提交後才更新 hash。[Synchronizer](https://github.com/zilliztech/claude-context/blob/6fc318b4e3ce58e2898b00a9c3538ead9e24dee5/packages/core/src/sync/synchronizer.ts#L138-L157)。

已確認：子目錄搜尋會找最近的 indexed parent，並未強制把結果限在該子目錄；增量 traversal 使用 `fs.stat`，會跟隨 link。接入 IH 時，需要用既有 scoped read authority、目前檔案 revision 及實際子目錄範圍重新驗證。[Search scope](https://github.com/zilliztech/claude-context/blob/6fc318b4e3ce58e2898b00a9c3538ead9e24dee5/packages/mcp/src/handlers.ts#L656-L809)，[traversal](https://github.com/zilliztech/claude-context/blob/6fc318b4e3ce58e2898b00a9c3538ead9e24dee5/packages/core/src/sync/synchronizer.ts#L45-L102)。

已確認：遠端 embedding 收到原文，vector store 保存 chunk 文字及路徑 metadata。Embedding 和 index 的資料傳送必須是兩項明確選擇；使用本機 Ollama 不代表遠端 Milvus 也變成本機。[Stored chunks](https://github.com/zilliztech/claude-context/blob/6fc318b4e3ce58e2898b00a9c3538ead9e24dee5/packages/core/src/vectordb/milvus-vectordb.ts#L602-L624)。

上游報告約39.4% agent tokens 減少，使用 MCP 0.1.0、GPT-4o-mini、30個特選 SWE-bench Verified 題目。F1 是修改檔案路徑的重疊，沒有跑驗收測試；embedding／資料庫成本不在這個數字內。[Evaluation](https://github.com/zilliztech/claude-context/blob/6fc318b4e3ce58e2898b00a9c3538ead9e24dee5/evaluation/README.md#L9-L35)，[F1 implementation](https://github.com/zilliztech/claude-context/blob/6fc318b4e3ce58e2898b00a9c3538ead9e24dee5/evaluation/analyze_and_plot_mcp_efficiency.py#L23-L50)。授權是 MIT。[License](https://github.com/zilliztech/claude-context/blob/6fc318b4e3ce58e2898b00a9c3538ead9e24dee5/LICENSE)。

## 獨立子系統交付

- [工具結果與會話回憶子系統方案](D:/frontend-test/docs/superpowers/specs/2026-10-04-context-output-subsystem-proposal.md)：先接既有 output-retention／session-query，再提供精確取回與壓縮恢復引用。
- [程式碼檢索子系統方案](D:/frontend-test/docs/superpowers/specs/2026-10-04-code-retrieval-subsystem-proposal.md)：索引與更新獨立，有明確 owner、generation、revision、成本及取消規則；embedding／Milvus 作可選 adapter。

以上兩份是未實作的提案。Pi 這輪新增的 Code Mode 長文字 spill 與 JSON store 恢復是其現有 runtime 的改善，並不等於已完成這兩個子系統。

## 使用者提供的本機源碼核查

2026-10-04，使用者提供以下兩份源碼。這次補充以本機實際內容為依據；前文的 claude-context 0.1.15 固定 commit 研究保留為先前證據，不當作本機 0.1.11 的版本證明。兩份參考目錄全程唯讀，沒有安裝依賴、執行程式、連接資料庫或呼叫 embedding。

| 參考目錄 | 實際 metadata | 核對檔案 SHA256 |
| --- | --- | --- |
| `D:/agent-complete/claude-context-0.1.11` | root、core、MCP 均為 0.1.11 | root package.json: `E46432CF3C40262687A772B82D18063CA99D7E5D2F676EAD506466AE8BF765D3` |
| `D:/agent-complete/context-mode-1.0.169` | root 為 1.0.169 | root package.json: `F0A96C5AFFD66F5334F2F4CD5A1270E65018A0B83317B4E752CD6F60CDBA8680` |

引擎內容指紋：claude-context `packages/core/src/context.ts` 為 `E183326028E9516E94DB2DEF1D7245DDA1309A81CF50AA3562367B0E1AA0F7C5`；其 `sync/synchronizer.ts` 為 `7788F4B54FBA1D4DE3E185F7D48594CC283DB00AECEA9D67183549F39E21532E`。context-mode `src/store.ts` 為 `D7B06661006E884832E0DCD27720EF2C59A585E301D9C7A38AFC883330781CAD`。版本目錄名稱不等同於 Git commit 身分，以上指紋記錄本次實際閱讀的內容。

### context-mode 1.0.169：本機確認與 IH 設計要求

- 已確認：plain text、JSON 和 Markdown 有各自的分塊流程，FTS5 的文字與 trigram 表在同一交易中更新。相同 label 會刪除前一份來源；IH 的工具結果需要不可變 ID，label 只作顯示 metadata。[分塊與寫入](D:/agent-complete/context-mode-1.0.169/src/store.ts:959)
- 已確認：plain-text 分塊有 UTF-8 byte-aware 處理，但不能由此推論所有 Markdown／JSON chunk 都遵守同一硬上限。搜尋的 aggregate 累加使用 `formatted.length`，查詢標題、分隔符及後續提示不全在同一預算內。`trackResponse` 的 byte 計量是回應統計，不是完整 serialized response 的硬限制。IH 應限制捕獲、單個 chunk、檢索回應三個層次，並把 metadata 算入回應上限。[搜尋預算](D:/agent-complete/context-mode-1.0.169/src/server.ts:2672)、[字元累加](D:/agent-complete/context-mode-1.0.169/src/server.ts:2756)
- 已確認：來源 refresh 對已刪除／deny 的檔案跳過更新並保留 cache；shared store 的無 session attribution 舊資料也可通過 session filter。IH 必須在查詢及取回時檢查目前的來源可見性，為共用資料明確指定 owner。[來源更新](D:/agent-complete/context-mode-1.0.169/src/store.ts:1415)、[session filter](D:/agent-complete/context-mode-1.0.169/src/store.ts:1395)
- 已確認：本機 executor 的環境繼承有 denylist／prefix 過濾，仍使用真實 HOME；前文的「繼承環境」應按此限定理解。捕獲的分塊經過 trim、overlap 或 JSON reserialization，沒有原文 byte offset／durable revision，不能作 byte-exact blob 的替代。[環境處理](D:/agent-complete/context-mode-1.0.169/src/executor.ts:674)、[文字與 JSON 轉換](D:/agent-complete/context-mode-1.0.169/src/store.ts:1654)
- 已確認：live events 的 lookup 有 session 過濾，但空會話可 claim 同專案另一會話的最新未取用 snapshot；snapshot 的 `maxBytes` 參數被明確忽略。IH 恢復必須匹配實際 session／fork lineage，恢復資訊也要有真正的 byte 上限。[恢復 fallback](D:/agent-complete/context-mode-1.0.169/hooks/sessionstart.mjs:269)、[snapshot 預算](D:/agent-complete/context-mode-1.0.169/src/session/snapshot.ts:142)
- 已確認：`ctx_purge` 在把 session scope 交給 `purgeSession` 前，對已開啟的 store 呼叫 `cleanup()`；該方法會關閉並 unlink 整份 DB、WAL 和 SHM。靜態控制流程因此顯示「只清一個會話」可能影響共用 content DB；本輪沒有執行重現。IH 的 close、disable、session clear 和 workspace clear 必須有不同契約，且清理前等待自己的工作排空。[清理入口](D:/agent-complete/context-mode-1.0.169/src/server.ts:4552)、[cleanup 實作](D:/agent-complete/context-mode-1.0.169/src/store.ts:452)
- 已確認：fetch cache key 組合 source 與 URL，但 cache-hit 節省 bytes 仍以 chunk count 估算，token 節省採 bytes÷4。IH 的內容／embedding／query cache 命中、provider prompt cache 命中及 token 計量分開報告。[fetch key](D:/agent-complete/context-mode-1.0.169/src/fetch-cache.ts:13)、[估算](D:/agent-complete/context-mode-1.0.169/src/server.ts:3310)

### claude-context 0.1.11：本機確認與 IH 設計要求

- 已確認：core 會建立 embedding，要求呼叫端提供 vectorDatabase；exported backend 是 Milvus SDK／REST。IH 的本機無 embedding 檢索需要自行提供。[Context 建構](D:/agent-complete/claude-context-0.1.11/packages/core/src/context.ts:114)、[backend exports](D:/agent-complete/claude-context-0.1.11/packages/core/src/vectordb/index.ts:15)
- 已確認：`checkForChanges` 先更新 hash／Merkle snapshot，回到 Context 後才刪除舊 chunks、建立 replacements。推論：後續失敗可能使下次 refresh 認為已處理變更。IH 採 staging generation，成功提交索引後才前移檔案 hash。[snapshot 提交](D:/agent-complete/claude-context-0.1.11/packages/core/src/sync/synchronizer.ts:244)、[索引更新](D:/agent-complete/claude-context-0.1.11/packages/core/src/context.ts:400)
- 已確認：force reindex 可移除 snapshot 的 indexing 狀態；clear 可直接刪除索引，而原背景 promise 的完成路徑仍會寫回 indexed 狀態。已核對的介面沒有 job ID／AbortSignal／cancel 工具串起這些操作。競爭影響是靜態推論，沒有執行重現。IH 的 refresh、rebuild、clear 和 disable 應共用工作區 mutation owner，先取消／等待舊工作，再發布新狀態。[force 路徑](D:/agent-complete/claude-context-0.1.11/packages/mcp/src/handlers.ts:354)、[clear 路徑](D:/agent-complete/claude-context-0.1.11/packages/mcp/src/handlers.ts:857)、[背景完成](D:/agent-complete/claude-context-0.1.11/packages/mcp/src/handlers.ts:548)
- 已確認：AST overlap 把前一塊抽取文字接到當前塊並調整起始行；IH 檢索回傳須分清精確連續原文範圍和拼接展示，不能由拼接文字宣稱一個 exact source range。[overlap](D:/agent-complete/claude-context-0.1.11/packages/core/src/splitter/ast-splitter.ts:239)
- 已確認：修改檔案會重新 embedding 全部新 chunks；dense／hybrid query 都呼叫 embedding，沒有以 chunk 內容 hash 查找可重用 embedding 的實作。IH 可在完整的模型、維度、chunker 與 owner 身分下重用已成功保存的 embedding，並記錄真實呼叫用量。[檔案 embedding](D:/agent-complete/claude-context-0.1.11/packages/core/src/context.ts:874)、[query embedding](D:/agent-complete/claude-context-0.1.11/packages/core/src/context.ts:499)

### 對 IH 整合位置的再確認

`desktop-gateway/host.ts` 已擁有 workspace session query、memory、service 與設定控制器；`session-executor` 是 Agent／Code Mode 的組裝邊界。現有 Code Mode 已保留超過預覽的 emitted text，但 `core-session.deriveSearchText` 尚未納入 Code Mode 事件。新子系統應沿用原有 session log、blob retention、broker 和壓縮流程。[Host 組裝](D:/frontend-test/packages/desktop-gateway/src/host.ts:152)、[Code Mode retention](D:/frontend-test/packages/code-mode/src/runtime.ts:312)、[搜尋投影](D:/frontend-test/packages/core-session/src/index.ts:793)

IH 一般 `read` 工具本來允許外部唯讀存取，不能把「呼叫既有 read」當作索引範圍授權。Index ReadAuthority 要明確綁定已選定來源、session 和 consumer，並整合既有 scoped search／descriptor 機制，在發現檔案與返回片段時分別校驗。[一般 read](D:/frontend-test/packages/fs/src/index.ts:28)、[scoped model search](D:/frontend-test/packages/fs-search/src/model-search.ts:1)

本機核查維持「兩個內建子系統，一個專用設定頁，各自開關」的建議。兩份提案已補充 native host、設定狀態、清理範圍及工作取消要求；仍為設計提案，尚未開始子系統實作。
