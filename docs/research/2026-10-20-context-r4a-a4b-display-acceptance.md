# R4A A4b Task2 顯示及冷讀驗收 — 2026-10-20

**接受本輪 CLI／Desktop 結果顯示，以及對應 history/export、搜尋 producer 與瀏覽器相依邊界修正。** 獨立 GPT6.1Sol reviewer 的 spec／quality 審查通過，沒有 actionable Critical、Important 或 Minor。Root 已閱讀完整審查、核對證據與實際預覽。這是單元驗收，不代表整個 R4A 或發佈資格完成。

| 固定點 | 值 |
| --- | --- |
| 工作目錄／分支 | `D:/I-harness-main`／`codex/v0.1.13-development` |
| BASE | `43e829a4d08ba54f2264bece3b827bf28be44ed6` |
| 最終產品 HEAD | `368d18faca15d16204d1d063d7e704fe3ae75a1e` |
| 交付／計劃裁定 HEAD | `a14d95d0f75d8425e796fdd402818db43823652d`／`46ba1a4907910f11eb922851105ac3a69b404022` |
| 版本／拆分 | 產品0.1.13-rc.1、Session10、原拆分27/43，均不變 |

實作與審查分由 GPT6.1Sol 承擔，root 負責設計裁定、來源核對與視覺驗收。[交付報告](2026-10-20-context-r4a-a4b-display-delivery.md)、[獨立審查](context-r4a-a4b-display-review-20261020/review.md)、[root 核對](context-r4a-a4b-display-review-20261020/root-verification.json)分別保留，審查沒有冒稱重新執行測試。

## 已接受行為

CLI 原有精簡會話列表現在能顯示新結果的 inline value 或保存預覽，並保留原200字元上限。Desktop 的普通工具、nested Code Mode 工具，以及已分組／未分組兩條真實元件路徑，現在都保留 typed envelope。正式介面中的改動位於原有結果卡片；受控預覽頁只是開發驗證入口。

執行結果、是否已派發及保存狀態分開顯示。任意輸出資料中的 `error`、`status`、`exitCode` 不會冒充新結果的執行狀態；unknown 明確標示。保存失敗不會把成功執行改成失敗；部分來源不會標為完整保存。原始 inline 資料仍可展開查看，獨立 typed 圖片依原順序顯示一次。歷史 raw 分支維持原行為。

原搜尋取消測試揭露真正 fs-search producer 沒有宣告取消結果。READ-09 在原 factory 依其封閉 `SearchResult.status` 宣告 succeeded／failed／canceled，維持原資料、搜尋限制及演算法。原240 matches、262144限制、10個被選取參照、完整 retained value、取消後 drain 與零後續效果均保留驗證。

實際 renderer 建置亦揭露 SDK/context 經 core-session 引入 Node runtime。READ-10 把原純量型別與驗證函式移到同一份瀏覽器安全 leaf，提供真正公開 `core-session/context` 入口給 SDK/context 使用。原 root exports 和 v1/v2 解碼行為保留，沒有 Node shim、別名繞過或複製驗證邏輯。

## 驗證與限制

| 範圍 | 最終結果 |
| --- | --- |
| Desktop 相依顯示與回歸 | 143 tests／12 files 通過；封存 HEAD 的專項11 tests 通過 |
| CLI 實際 sessions command | 17 tests 通過 |
| 原搜尋完整結果／Stop 控制 | 4 tests 通過 |
| fs-search 全套 | 51 tests／5 files 通過 |
| Core context／SDK context、history、browser | 33 tests／4 files；8 tests／3 files 通過 |
| 七個受影響套件型別 | 全部 exit0 |
| 實際 Electron 建置 | main442／preload2／renderer2047 modules，exit0 |
| 最終 copied／bundled 消費者 | 30 tests／5 files 通過 |

範圍有重疊，不加總成總覆蓋率。CLI copied gate 是 consumer bundle，未冒稱完整 CLI executable 驗證。Electron build 未包含安裝程式或已安裝應用的 IPC 資格。

Root 獨立核對57個循序且來源穩定 receipts、2,671個來源輸入、1,003個來源／manifest 副本、280條內部依賴、6個 fixture／36個字面 import 轉換、352個證據檔、137個 CLI inputs、22個 preview inputs、7個 Electron 輸出，以及15個搬移前後相同的純量定義，零不一致。

Source manifest SHA256：`bf31c5358225fabb9a4a94096a91f4bb91b921bf6a92b028c5be193da07c0156`。Inventory digest：`a9c42e5a49046e5c3119dbdcc1b1539fdcaf95b0d971da2f7ef78a7406b88abc`。完整 raw 證據保留在 `.tmp/context-r4a-a4b-display-20261020-implementation/`；本檔旁另保存可攜的 review、root 核對與視覺證據。

Root 操作實際元件／IH CSS 的受控瀏覽器預覽，確認深色中英文、原始資料展開、部分保存／quota／unknown 標示及圖片順序；在1265×712觀察範圍內沒有重疊或頁寬溢出。[視覺記錄](context-r4a-a4b-display-review-20261020/visual-review.md)及[修正後 manifest](context-r4a-a4b-display-review-20261020/visual-manifest-v2.json)保留限制。截圖實際為 JPEG，原先副檔名／PNG 位移讀尺寸的錯誤已明確更正，沒有把錯誤 metadata 當作證據。不是已安裝 IH、明亮主題或全響應式矩陣驗證。

原失敗、fixture/setup 錯誤和舊 raw-output 斷言均有獨立處置，未刪除或重新標成成功。Root 的 [reachability gate](context-r4a-a4b-display-review-20261020/reachability-receipt.json)仍 exit1：原有六個 unused exports，沒有新項目，也沒有加豁免或 reseed。沒有以單元驗收宣告全工作區通過。

## 接續

連續推進 owned Session8/9→10 升級／追加／重開資格、其餘原生執行 outcome、明確 artifact 分頁 reader，以及 A5/A6、R4B/C/R5/R6。觀察到背景工作失敗的 query 不因此改成執行失敗。原完整事件驅動／指令檔及無關拆分仍暫停；沒有 push、merge、tag 或 release。
