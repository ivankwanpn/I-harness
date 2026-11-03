# R4A owned Session version 驗收 — 2026-10-20

**接受本輪會話格式資格驗證。** 獨立 GPT6.1Sol 的完整範圍 spec／quality review 通過，沒有 actionable finding；root 閱讀完整審查並獨立核對來源與證據。這輪修改13個測試檔，沒有修改產品程式，沒有宣稱修復了新的產品缺陷。

| 固定點 | 值 |
| --- | --- |
| BASE | `538cdb9297bbf6c4f757dfd69d3a48239032e4b8` |
| 測試 commit | `cdb55a4ba4aa704956ab1a0296c1bbdb71b1e2c3` |
| 交付／驗收範圍 HEAD | `1755ee0745de134fc7bd60ba1dc2e3b3dd92170b` |
| 版本／原拆分 | 產品0.1.13-rc.1、Session10、27/43，均不變 |

[交付報告](2026-10-20-context-r4a-owned-version-delivery.md)、[獨立審查](context-r4a-owned-version-review-20261020/review.md)、[root 來源核對](context-r4a-owned-version-review-20261020/root-verification.json)保存各自責任及限制。

## 已驗證

真正 JSONL backend／coordinator 的 owned 路徑可以把 literal8／9 升為10，只更新 header，保持原 body、journal 及未知 metadata；追加一筆 managed metadata 後完整關閉，再由全新的 backend／coordinator 從磁碟重開。原未決 generation reservation、歷史 unknown result 和結果參照保持原樣，不補造執行結果、child authority marker 或供應商請求。

普通工具、nested code、emitted code、子代理完成及背景工作 retained result 五個位置，各有有效的 current10 對照。它們經實際追加／關閉／重開後保留完整事件。把同一有效檔案**只改 header 為8、9或11**後，原驗證器會在任何修復／升級／追加之前拒絕；原始 bytes 不變，原 mutation ports 的 delegating spies 為零。這是拒絕不相容資料的控制，不代表歷史 writer 曾產生該種錯配檔案。

舊測試中「current9／future10」及同一 owner 的 mock-current fixtures 依 VERSION-01 修正。Literal6／7／8／9、future99、generation total-cap9、callback 順序／receiver、Windows lease 和原安全斷言都保留。未用假 upgrade capability 或增加 timeout 隱藏問題。

## 最終驗證

| 範圍 | 結果 |
| --- | --- |
| session-persistence-jsonl 全套 | 146 tests／15 files 通過 |
| session-persistence 全套 | 153 tests／26 files 通過，無 unhandled error |
| 兩個受影響套件型別 | exit0 |
| 實際 Gateway package copy build | exit0，242 shipped packages |
| 複製後 public backend／coordinator 路徑 | 24 tests 通過 |

Root 獨立重算本輪 manifest 中2,616個來源檔、33個 receipt 的來源穩定性、最終八個資格 gate 的循序／exit0、172個封存證據檔、78個 mapped packages／1,141個來源一致副本、322條實際副本內依賴，以及2個 fixture／3個 AST 確認的 import 字面轉換，零不一致。生成的 WSL manifest 另以原 generator schema 及 worker bytes 驗證，沒有冒稱 source-identical file。

Source digest：`c66dc6831267156a2f9dda9974f4d35e0bc1622b5491ca532443aeb4b62dcc43`。Evidence inventory SHA256：`0a7b12170e33de215395210e19b67a67d15175b6a95a4701b2cd1bb23aa9717b`。原完整證據在 `.tmp/context-r4a-owned-version-20261020-implementation/`。

初次 root-filter 誤掃歷史 `.tmp`、12／13兩次執行短暫重疊、fixture 型別／錯誤類型假設、generated manifest mapping 及 config path 等失敗均保留並排除資格宣稱。最終受影響套件已在固定來源、正確 package root 下循序重跑通過。舊斷言失敗屬測試契約落後；新的通過控制屬既有產品行為資格，沒有製造產品 RED／GREEN 敘事。

## 範圍

接受 offline library／backend／coordinator 與該 isolated copy 的格式行為，不等於 native producer、live provider、installed profile、Gateway IPC、installer、100MiB fan-in 或整個 R4A 的完成。原六項 reachability 未在此 tests-only 單元重新宣稱通過。

Root 接續原生工具 outcome 與明確 artifact 分頁讀取，然後完成剩餘 A5/A6、R4B/C/R5/R6。完整事件驅動、指令檔及無關拆分沒有被默默恢復；沒有 push、merge、tag 或 release。
