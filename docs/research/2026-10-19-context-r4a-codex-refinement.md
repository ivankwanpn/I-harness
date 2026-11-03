# R4A：外部 fix1 複驗與 Codex 直接修整

**結論：本輪限定範圍的修正已接受；整個 R4A 仍未完成，未達合併／發佈條件。**

使用者將分工調整為「DeepSeek 做初步，Codex 驗收以後自己調整」。Codex 在外部 writer 停止後直接修正產品；原 GPT6.1Sol reviewer 做獨立唯讀複審，沒有新增實作代理或並行產品 writer。舊指示中 Codex 只能寫計劃／交回外部修正的限制已被此次授權取代。

## 範圍與結果

| 項目 | 固定點 |
| --- | --- |
| 分支 | `codex/v0.1.13-development` |
| 整個 R4A 原始 BASE | `91d8fef04253272a437c68f5f2f84a657fa53d3b` |
| 外部 fix1 交付／本輪起點 | `e8b2781f607c63421b4089a66ea230aa9799ff21` |
| Codex 產品提交 | `97ff39e8bb95766276884bf5dfc4177a6f722476`、`3ba0d782fea3eb3389790e16f47f1f9b9cab0208` |
| 本輪產品／測試差異 | 9 檔，+306／−52；其中產品 5 檔、測試 4 檔 |
| 版本／原拆分進度 | Desktop `0.1.13-rc.1`；27/43，均未變更 |
| 獨立複審 | 限定範圍 specification PASS、quality PASS，沒有新增 actionable finding |
| 本輪交付狀態 | 本地提交；沒有 push、merge、tag、release，沒有開始 R4B |

原 fix1 的 task roundtrip、background catalog、unknown settlement 三組反例已通過；reader capability 修正也有實際無 service／可讀取能力控制。它們關閉先前已指出的缺陷，不代表所有不同 owner 的 catalog 授權情況都已完成。外部 fix1 與本輪的接續關係可查[外部交付](2026-10-19-context-r4a-fix-round1-delivery.md)及[獨立複審全文](context-r4a-codex-refinement-20261019/independent-review.md)。

## Codex 發現並修正的問題

1. **背景自動完成／關閉錯用當前觀察者。** 原流程會在 startup 工具已經 finalize 後，再向它登記原程序的 dependency。現在自動完成和 dispose 使用原 capture 的被動保存；只有真正的前景／查詢操作才登記自己的觀察依賴。實際 assembly 測試以 EOF 放行檔控制時序，驗證 startup 已結束後不再被修改，後續 `job_output` 仍取得結果 catalog。
2. **前景 observer rejection 變成未處理例外。** 現在 public exec 回傳前會接住並等待 observation，透過獨立 `retentionFailure` 表示結果保存／觀察未完成；原 stdout、stderr、exitCode、timedOut 和 native exception 保持原意。觀察者失敗不能將已保存的背景結果降級成未知。
3. **未知結果必須保留原 capture。** 前景與背景都留在原 registry 管理的 pending 集合內，close 在仍未知時明確失敗，之後從同一 handle 恢復；不重開程序、不重做 capture、不增加輪詢。舊 adapter 沒有新的 optional `settle` 時，使用既有原 frame capture 的 settle，不以 observe 代替。
4. **補上結果包裝後的私有 reader 身分。** 增加 `retentionFailure` 需要新結果物件，首次實作因此遺失私有 WeakMap 中的 reader。Codex 新增反例確認失敗後，在 `3ba0d782` 將原可信 reader 綁到觀察結果；沒有從 ref／path 形狀推導權限。修正前後證據均保留。

`packages/exec/src/jobs/retention.ts` 是 67 行責任葉檔，原 job registry／capture 仍負責執行與保存狀態。原 `records.ts` 淨減 23 行。這符合避免新增大檔案的方向，但未將原拆分清單任何一項提前標為完整完成。

## 實際驗證與來源限制

所有 root suite 依序執行；測試期間不修改產品。下列數字有重疊，不能相加成獨立總覆蓋率。

| 證據 | 結果與範圍 |
| --- | --- |
| `exec-after-reader-fix` | 最終產品內容 20 檔、257 tests passed；source digest 前後一致 |
| `types-after-reader-fix` | 最終內容的 session-executor `tsc --noEmit` 通過 |
| `all-review-probes` | 原三組反例及新兩個邊界共 5 檔、6 tests passed；在 reader-only 最後修正之前，保留該時點範圍 |
| `executor-retained-controls` | 12 檔、30 tests passed；同樣在 reader-only 修正之前，未冒充最終內容重跑 |
| exec／Gateway typechecks | 本輪較早內容通過；最後 reader 差異另由最終 executor types、exec controls 驗證 |
| `copied-library-controls` | 新 Gateway copy 內實際產品模組，3 檔、9 tests passed；包含前景／背景恢復和真實磁碟保存 |
| Gateway／CLI build | 最終產品內容建立全新輸出，兩者 exit 0；CLI `verify-dist` PASS，含隔離設定的 SDK initialize smoke |
| source/copy | 842 個產品來源檔與新 Gateway copy bytes 相同；280 個內部依賴解析到該 copy；3 個測試僅由 AST 改寫 14 個產品 import，產品副本未修改 |
| reachability gate | exit 1；仍是交接 WIP 既有 6 個 unused-export，沒有新增豁免、假 consumer 或 reseed；不能寫成全綠 |

最終 exec receipt 的 Git HEAD 仍是 `97ff39e8`，因 reader 修正當時尚未 commit；其 manifest 實際包含後來提交為 `3ba0d782` 的內容。獨立 reviewer 比對本輪全部 9 個產品／測試檔，9/9 相同；root 收束時再核對全部 2,576 個記錄來源，一致。因此驗證依據是記錄的實際 bytes，而非單靠 HEAD 字串。

真實磁碟測試經受控 transport 提供 **1 MiB stdout 加 6 bytes stderr**，由真正 ContextOutput store 寫入。第一次 finish 已提交但回執被測試 wrapper 丟失；後續透過同一 operation／scope／sink 取回原 immutable ref。斷言要求 launch 1 次、open 1 次、finish 2 次，恢復時沒有新增 write；另用新 service 冷讀實際 encoded bytes，驗證 digest、stdout 長度／digest 和 stderr marker。這是 **實際 store＋受控 transport**，不宣稱真 OS 程序輸出 1 MiB 或完整 session 冷恢復。真 OS 程序的少量 binary／Unicode 控制另有獨立測試。

早期 `refine-*` RED receipts 只記當時 tracked source，前景新測試仍未追蹤。原測試後續原樣保存，其 SHA256 為 `7e75b3c31d275bc44f4cac7fd6576ac8fb2fc51f82bae0acb60dd2b22b608ad6`；不能回頭聲稱早期 manifest 已包含它。後續 runner 明確涵蓋 maintained tracked＋untracked source。中間舊 recovery 測試因仍預期「被動完成會呼叫 observer」而失敗，保留該失敗，改以真正分離後的 storage／observer 語意作 oracle；reader 遺失的 RED 也完整保留。

## 外部證據複核與封存

Codex 在改產品前已核對外部 fix1：82 個封存檔、19 份 receipts、4,589 個 final manifest rows，以及 11 個 copy 對照／CLI hash；這 11 個 copy 含 2 個未改檔，實際產品差異是 9 檔。baseline `f362c638` 使用獨立 worktree，2,399 個 maintained bytes 和 5,751 個 workspace links 經核對。candidate／baseline full suite 依序在不同 cwd 執行；原先同 checkout 重疊約 64.9 秒的「65 vs67 無回歸」比較仍是作廢的歷史證據。

修正後 full-suite candidate 67 failed／377 passed、baseline 66 failed／371 passed；失敗名單只多一項 second-turn close-boundary，外部亦記錄兩邊的間歇性 cleanup failure。這些不代表本輪全套通過，也不以 baseline 發生過就推論新修正不會改變其發生頻率；該問題仍留待後續處理。本輪沒有重跑整個 session-executor 或 monorepo。

本輪 evidence：`.tmp/context-r4a-codex-refinement-20261019/`。22 份 receipts 的 raw stdout／stderr hash、before／after source、controls 均核對；最終維護來源、產品副本與 copied fixtures 再核對，0 mismatches。封存 123 個檔案，摘要已保存於 [verification-summary.json](context-r4a-codex-refinement-20261019/verification-summary.json)。舊 receipts、probes、reports 保持不變。

- Final maintained-source digest：`767b27b6756106fc2d8b3dfdef339c5c6521d7ea9547ac5ceaa7394481e1d291`。
- Evidence inventory digest：`baa37c8447d421d8d4cae6f480801334ee3c7e8358d5c4d2578878fe47f2dedf`。
- 新 CLI `ih.mjs`：6,748,442 bytes；SHA256 `495fdd9823c3ba0231c6535d883cbad66c5a7d7aafd56dbd94e0f63f4a2f4391`。
- 新 Gateway：`.tmp/context-r4a-codex-gateway-20261019-a/`；新 CLI：`.tmp/context-r4a-codex-cli-20261019-a/`。

## 尚未完成

- **R4A A3**：Code Mode emitted output 切換到新的完整保存／有界輸出路徑，移除舊 spill fallback，補 surrogate／NUL 等控制。
- **R4A A4／A5 及剩餘 A1／A2 矩陣**：MCP `structuredContent`／`isError`、媒體、search／export、跨 owner catalog 授權與撤銷、crash／Stop／未知 F1／刪除並行等責任；literal9/8→10、最終 source 的 100 MiB／100-child fan-in 資格亦未完成。
- **R4A A6**：完整 packaged Gateway／CLI 的 normal／background／code／child／Stop／legacy／cold 真正入口流程。這輪 copied-library9tests 和 CLI smoke 沒有替代這個關卡；renderer 既有失敗也未在本輪解決。
- **R4B／R4C、R5、R6**：語意分支／可靠交付、觀測與 UI、串流歷史與冷恢復等後續階段仍待完成。既有來源時點的 100 MiB 結果測試不等於 100 MiB session 驗收。
- **其他原任務**：完整事件驅動、指令檔支援與不相關拆分未因這輪調整恢復或提前完成；原拆分計數保持 27/43。

後續沿[進度總表](../refactoring/context-engine-progress.md)與[外部實作框架](../superpowers/plans/2026-10-19-context-engine-external-execution.md)接續剩餘 R4A。此文件接受的是明列的缺陷修正；不將尚未完成的整個長會話重構標為完成或可發佈。
