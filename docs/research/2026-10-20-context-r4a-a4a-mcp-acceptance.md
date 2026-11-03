# R4A A4a MCP 驗收 — 2026-10-20

**本輪 A4a 通過限定範圍驗收。** 完整 MCP 結果、程式讀取值與保存內容保持一致；送進模型的預覽改為有界的文字／媒體／資源描述。Codex root 主導設計與驗收，GPT6.1Sol 實作，另一名 GPT6.1Sol 獨立審查。這不代表整個 A4、R4A 或長會話重構已完成。

## 固定範圍

| 項目 | 記錄 |
| --- | --- |
| 工作目錄／分支 | `D:/I-harness-main`／`codex/v0.1.13-development` |
| BASE | `3ed2d6681decfce4230eca4699890e874da13965` |
| 產品提交 | `01bbd64ea5f3dc579740f26d3bbf44559aa1fcd7`、`fd84e6eaab3357bc79ea1d3b4a73f763661c9466` |
| 交付／審查 HEAD | `e0e6a8d1fd3ea3aeb4eedfa237f6aad7a256cbc3`，最後一筆僅交付文件 |
| 產品／測試範圍 | 12 檔，新增 474 行／刪除 17 行；新產品 presenter 57 行 |
| 版本／Session format／原拆分清單 | `0.1.13-rc.1`／10／27/43，均未改 |
| 獨立審查 | 規格及品質通過；本輪無 Critical、Important 或 Minor finding |

[實作交付](2026-10-20-context-r4a-a4a-mcp-delivery.md)、[核准計劃](../superpowers/plans/2026-10-20-context-r4a-a4a-mcp.md)及[獨立審查全文](context-r4a-a4a-mcp-review-20261020/independent-review.md)分開保存。已接受的 A3 未重做。

## 解決的問題與保留的邊界

- 真正的 MCP registry 路徑原本已保留完整的 normalized `{content, isError?, structuredContent?}`。本輪加入實際路徑驗證，保留明確的 false／null、順序與任意巢狀欄位；沒有把直接 `Tool.execute` 的相容分支誤當成正式路徑。
- 原本有圖片時，預覽會被一行通用句子取代；沒有圖片時，開頭的音訊或其他編碼資料又可能占滿預覽，遮住後面的文字和資源位置。新預覽按原區塊位置描述內容，保留後面的文字／URI，省略編碼二進位資料，並說明未顯示的區塊數。
- 只有真正已派發的 MCP producer 才能在既有私有執行 metadata 記錄展示方式。普通工具不因 payload 看起來像 MCP 就被重新解讀；展示標記不進持久化執行狀態。
- 原值只 lower／freeze 一次，原 store、來源、capture、operation 和程式回傳值不變。保存未知時沿原工作結算；配額失敗不被改成工具執行失敗，也不暗示完整結果已永久保存。
- 描述欄位先限制再組合：文字 2,048、URI／名稱／類型 1,024、預覽 8,192 個跳脫後 bytes；普通最終 envelope 維持 64,000 bytes 上限。完整資料仍供程式及成功保存後的讀取使用。
- 原生圖片驗證、順序、各協議 adapter、現有工具文字加圖片訊息的佈局，以及 Code Mode 預設 4 MiB 傳輸限制均未改。未宣稱原生音訊／資源支援或完整 native block interleave。

MCP-06 另外區分 SDK Server 與 IH 的 normalized contract：SDK Server 不接受 `structuredContent:null`，原失敗已保留；literal JSON-RPC stdio 測試仍經真正的 client transport／normalizer，驗證 IH 的 null 容忍度，沒有放寬產品驗證或宣稱 SDK Server 支援 null。

## 驗證

各範圍互有重疊，不相加為整體測試數或覆蓋率。

| 範圍 | 結果及來源限制 |
| --- | --- |
| core-tools | 137 通過；相關產品／測試來源與最終提交一致 |
| MCP-client | 107 通過；本地 stdio 及真正 registry 路徑，相關來源與最終提交一致 |
| 最終 output-retention | 53 通過；保留既有 spill-GC ENOENT warnings |
| 最終連接 executor 控制 | 16 通過；含 1 MiB structured data 冷讀、完整 bytes／digest、保存／配額、真正 WASM 及原 unknown 恢復 |
| 四個受影響套件型別檢查 | exit 0；之後只有預覽文字及對應斷言修改，沒有 API／型別結構變更 |
| 最終新 Gateway 副本 | build exit 0；22 個相關 copied-library 控制通過；較早副本的 37 個控制保留原時點 |
| 套件圖 | 82/82 可由應用入口到達，零產品依賴循環 |
| reachability gate | exit 1，仍是先前已記錄的 6 個 unused-export；沒有新增豁免、reseed 或假 consumer |

Root 獨立核對：

- 32 個 receipt 的命令、退出碼與來源前後雜湊；沒有交疊執行，穩定性聲明一致。
- 最終 2,603 個來源輸入、846 個產品來源副本、280 條副本內依賴，以及 4 個測試／helper 的 20 個 import 轉換，零不一致或殘留來源 import。
- 184 個封存證據檔及其 inventory／source digest，零不一致。

可攜核對記錄：[執行與來源](context-r4a-a4a-mcp-review-20261020/root-evidence-verification.json)、[副本與依賴](context-r4a-a4a-mcp-review-20261020/root-copy-verification.json)、[證據封存](context-r4a-a4a-mcp-review-20261020/root-seal-verification.json)。完整原始日誌仍在本機 `.tmp/context-r4a-a4a-mcp-20261020-implementation/`，沒有將摘要冒充完整可攜原始證據。

最終 source digest：`8a53b64d1b66dfbb903ad2cd25615141e5e88c88175917f9b443bb615caca419`。Inventory digest：`10dec13468a890acc59e39cc8c6b1dc83402be8b54b39ab942113321c60eda15`。獨立審查檔 SHA-256：`fc2973bed80f422eb215fb613bfea2d7c74e1b21486a3a944a4a828a92dc4825`。

## 尚未完成

剩餘 A4 的讀取／搜尋／匯出／版本／權限工作、A5 生命週期矩陣、A6 最終資格驗證，以及 R4B/C、R5、R6 保持未完成。整體 100 MiB 會話、100 子代理、六條 native route、線上供應商、Gateway IPC、Electron／renderer、packaged CLI 與發佈驗證均未由本輪證明。

副本測試驗證的是實際打包來源庫，不能替代上述應用入口。先前 A3 的相關套件失敗與既有 reachability 問題保持公開，沒有重新標為通過。本輪僅本地提交，未 push、merge、tag 或 release。
