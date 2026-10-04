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
