# 2026-10-15：壓縮後工具回合 HTTP400 修復

兩個既有 Desktop 會話在壓縮後的後續模型請求收到 HTTP400。修復來源 `1f2dfa7d9c8f6803560d74fc151e6e90f26c5958`，正式安裝包為 `I-harness-Setup-0.1.13-rc.1-session-fix.exe`。此次已用同一個合成工具回合向使用者設定的官方 DeepSeek Anthropic 端點驗證：初始請求200、已安裝舊 projector 的續接400、修正 projector 的續接200並完成。兩份實際會話也已透過新包內的程式碼唯讀重建，工具／結果相鄰且 thinking／native continuation 隨同一個 assistant response 保留。

## 根因與界線

會話98418780是先前追查的原會話；使用者補充的76e855fc是另一個既有會話。兩者的最近一次 summary 分別隱藏了當前步驟的 step/start（seq3287與2772）。引擎會在步驟開始後執行容量判斷與壓縮，因此這個標記仍屬於後續正在產生的模型回合。

原 projector 把被 summary／reset 隱藏的生命週期標記一併略過，後續 assistant response 因而被拆成：空文字的 assistant(toolCalls)、獨立的 assistant(text/thinking)、tool results。Anthropic serializer 送出 assistant(tool_use) → assistant(text) → user(tool_result)，中間插入的 assistant 訊息打斷了工具與結果的相鄰關係，thinking 也沒有隨工具回合重送。

實際合成控制的400回覆明確指出 tool_use ids 缺少緊接的 tool_result blocks。修正後，同一份合成事件、相同模型／route／4096輸出上限，送出 assistant(thinking+tool_use) → user(tool_result)，回覆200並正常結束。沒有執行任何真實工作區工具。僅三次極短合成模型請求，沒有重送私人對話；credential 僅供已設定端點使用，沒有寫入報告或產物。

本次修復針對目前壓縮後的400。先前原事故四次失敗沒有上游 body，仍不能由本次控制追溯定案那些歷史請求的原因。384000是輸出上限；壓縮後觀察到約13k至18k的輸入估算及約45k至47k bytes的本文，不能僅憑HTTP400把它們歸為輸入超窗。

## 最小修復與驗證

`core-session/src/projection/messages.ts` 在兩個有狀態的 fold 中保留 compaction-shadowed 的 step/start、step/end、step/failed、turn/start，讓保留下來的事件仍按原始步驟分組。模型內容與結果的 shadow 規則保留；resolved-call prepass 不恢復隱藏結果，rewind 仍無條件排除整段被撤回的分支。原始對話不重寫，schema／版本／重試／權限與工具執行政策皆不變。

| 檢查 | 實際結果 |
| --- | --- |
| 新核心回歸 RED／GREEN | 修復前4fail／1pass；修復後5/5pass，涵蓋live／cold、平行結果、失敗回合與rewind。 |
| 真正 Anthropic 協議回歸 | 2/2pass；實際 SSE fold → session → reload → serializer，檢查 thinking／text／tool_use 同回應與立即 tool_result。 |
| core-session 完整測試 | 17 files、135 tests通過。 |
| Anthropic 完整測試 | 8 files、78 tests通過。 |
| compaction 完整測試 | 18 files、144 tests通過。 |
| core-agent 完整測試 | 32 files、306 tests通過。 |
| 四套合計與型別 | 75 files、663 tests通過；四個 package 的 typecheck 均exit0。 |
| Desktop types／production build／新 gateway build | 均exit0，重新交付含修正的 gateway，沒有沿用來源155的舊runtime。 |
| 真實 DeepSeek 合成控制 | 200 → 舊重建400 → 新重建200完成；完全相同的合成工具回合。 |
| 隨包 runtime 重建實際舊會話 | 兩案均通過；本機唯讀，沒有網路或事件重寫。 |
| 真實 packaged executable | 介面、preload／About、內建 gateway RPC、公開close後main-process exit0均通過；使用隔離profile。 |
| 真實 NSIS／PE | 編譯exit0，isolatedTest=false；字串RC1、數字0.1.13.0，SHA與副本均獨立核對。 |

來源及回歸的獨立審查沒有必要修正項目。審查者提出可再直接 shadow step/failed／turn/start 的可選測試，未發現實作錯誤；這次保留現有明確範圍。2206個產品路徑與審查來源逐檔相符，canonical digest `ae579b7152b7cd7598bcc1d754e27a5685ecf9095358df286582e3a8f1090c70`；新gateway的8550檔／332763201bytes亦逐檔核對，修正projector SHA `18b2567c85d2f56d568eaac266dbcd54f2c32bba5cff457251828dc18feb303b`。

## 替代安裝包與使用方式

`I-harness-Setup-0.1.13-rc.1-session-fix.exe`，188417968bytes，SHA-256 `e85a972b5872d89919de74d8a47370a2f849235d478582e3b8c6d25746117c3b`。本機目錄 `packages/desktop/release-rc1-session-fix-20261015` 另有 checksum、正式 installer-build metadata 與 `session-fix-manifest.json`。保留0.1.13-rc.1並使用session-fix後綴，便於辨識本次修正；先前startup-fix只修啟動漏包，沒有此次projector修正。

使用者先正常退出正在工作的I-harness，再執行此包；目前的工作中程序不由本次驗證強制結束。更新後可直接重試原會話，不需要刪除設定、會話或重新送出已完成的工具。對話原始資料保持原樣，正確分組由新版讀取時導出。沒有在使用者的真實安裝目錄執行安裝／移除，因此不宣稱實際升級生命週期或整份私人對話的模型續接已被自動驗證。

先前完整 `pnpm verify:all` 仍為FAILED：7401pass／45skip／4fail，本次沒有重跑或把它改成通過。原生沙箱與既有五秒deadline的限定保留，draft／未合併狀態保留。隔離啟動的錯誤觀測限於CDP連接之後；主程序正常退出不等於獨立列舉所有子程序。

Ruling：在共同projector恢復生命週期分組，讓已壓縮的持久會話能在重新讀取時恢復正確請求，而不重寫使用者事件。代價若判斷錯誤，是隱藏標記可能誤合併或誤抑制可見後綴；故保留rewind全段排除與失敗呼叫判斷，以live／cold／parallel／negative回歸、實際伺服器舊400／新200及隨包原會話重建共同核對。

本機收據位於 `.tmp/model-http400-20261015`：RED／GREEN、各套suite／type logs、`source-review.md`、`live-synthetic-result.json`、`product-freeze.json`、新gateway manifest、production各階段 receipts、實際QA啟動截圖／結果、`packaged-session-replay-result.json`與`session-replay-v2.json`、NSIScompile.log、`final-product-runtime-proof.json`與`final-artifact.json`。`RESUME.md`保留完整回復狀態。初次合成probe的Windows ESM路徑錯誤在網路前失敗；第一次production preflight因ignoredhelper的release label參數而停止；初次會話重建在全部斷言後因收據與結果同名而寫檔失敗。各次helper錯誤修正後使用新標籤，所有原失敗收據保留；只沿用已成功且同來源的build。原coordinator的失敗沒有被改寫為成功，最後資格由實際成功的各階段退出碼逐一核對，沒有產品規則放寬。
