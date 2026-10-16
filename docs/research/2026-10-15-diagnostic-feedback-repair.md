# 2026-10-15：上下文資訊被誤顯示為請求失敗

本次先從 GitHub 取得並 fast-forward 到 `720593895adcc9e29f45340ee1ce3938f6c36804`，保留另一台電腦已完成的樣式、候選版、啟動與壓縮後工具分組修復。通知修正提交為 `6fbb14b7ead7c4b8998ca72b29568d2756edb45f`。

## 根因與修復

使用者截圖中的資料是 `kind=context/budget`、`level=info`，且 `recoveryRequired=false`、`fullByProvider=false`。`admission=unavailable` 不是請求失敗的充分證據；例如已接受的回覆會讓上次容量評估等待下一次真正的請求準備。

Native diagnostics 正確將這些資料分類為資訊並保存。問題位於 `RuntimeFeedback.tsx`：除了已辨認的 model lifecycle 等事件，其他診斷都走預設錯誤分支。新增的 `context/budget`、`context/request`、`context/compaction` 因而建立「請求未完成」彈窗，還可能覆蓋真正的 HTTP 錯誤，或在切換會話後顯示幽靈通知。

修正使用明確的通知類別表，在去重與 UI 狀態更新前只接受 model retry/recovered、session cancelled/error、runtime error 和 gateway disconnected。上下文與生命週期資訊保留在 native journal；不變成請求失敗，不影響重試／等待提示或原有錯誤。沒有修改供應商請求、容量數值、壓縮或重試政策。

## 實際驗證

| 檢查 | 結果 |
| --- | --- |
| 真正 native producer → bridge → UI 回歸 | 修正前 6/6 失敗；修正後通過。包括截圖形狀的 post-response budget、physical request、summary success/failure 診斷、HTTP503 保留、背景會話、重試／quiet 及 HTTP401。 |
| 相關 UI、native journal 與 IPC suites | 4 files／66 tests 通過。資訊記錄經 flush 及重新載入仍存在。 |
| Desktop typecheck | exit0。 |
| 獨立來源審查 | Specification PASS／Quality APPROVE，沒有 actionable finding。 |
| Production main 的 shipped-layout import 回歸 | 1/1 通過。 |
| Desktop build、fresh gateway、Portable、NSIS | 每個實際建置程序皆 exit0；各階段命令、時間與退出碼留存。 |
| 產物對應 | 8 個主程序／worker／preload／renderer 檔案與建置相符；8,550 個 gateway 檔案逐檔 SHA 相符；ZIP 內同一組 8 個應用程式檔案再獨立核對。 |
| PE 版本 | FileVersion／ProductVersion 字串為 `0.1.13-rc.1`，數字版本為 `0.1.13.0`。 |

所有資料為合成 fixture，沒有讀取或重送私人會話，沒有呼叫真實模型帳戶，也沒有在使用者現有設定或安裝目錄執行安裝／移除。這次沒有另行啟動真正的 packaged Electron 視窗，shipped-layout import 回歸及檔案核對不被宣稱為完整 installed lifecycle。

## 修復包

檔案位於 `packages/desktop/release-rc1-diagnostics-fix-20261015`，來源同為 `6fbb14b7`，包含最新已同步的 startup／session 修復。

| 檔案 | Bytes | SHA-256 |
| --- | ---: | --- |
| `I-harness-Setup-0.1.13-rc.1-diagnostics-fix.exe` | 188496500 | `39a37a42da75723011e86a0d8ece30feb2fd7db0d6db091e435f4c0fcbed90e8` |
| `I-harness-0.1.13-rc.1-diagnostics-fix.zip` | 286279472 | `1525e40c73156397ed36cbf968dbe4c39ed5c7fba9fb0d6a1714a2ceab3df61f` |

每個檔案附 SHA-256；`diagnostics-fix-manifest.json` 記錄來源、檔案、實際檢查與限制。RC1 保持未公開草稿。之前無後綴的包、startup-fix 和 session-fix 都是較早來源，並不包含本次通知修正。

先前完整 `verify:all` 的 **7,401 pass／45 skip／4 fail** 保留為失敗的歷史資格；兩個 PSEC 問題與兩個既有 deadline 問題沒有被本次局部修復解除，也沒有重跑全套來尋求綠色結果。原先完整事件驅動與剩餘拆分工作沒有在本次恢復。

## 決策與收據

Ruling：以明確事件類別決定通知資格，資訊持久化與即時錯誤展示使用各自的語意。代價是未來新增需要彈窗的類別必須明確加入；避免把新的量測或生命週期事件默認成失敗。

Ruling：保留 RC1 並使用 diagnostics-fix 後綴交付新的草稿產物，保持歷史包與來源可識別。代價是同版本存在不同修復包，因此發佈說明與下載建議必須指向明確後綴；不把本次範圍測試當成整體候選資格。

完整收據在 `.tmp/diagnostic-feedback-20261015`：RED／GREEN／types logs 和退出碼、獨立 review、各建置階段 receipts、artifact-verification、PE／ZIP proof。首個 PowerShell 統整程序在成功 NSIS 編譯後，因缺少 `Get-FileHash` 而失敗；其失敗狀態保留。Node 獨立校驗器的首次相對 import 設定有誤，在校驗前退出；修正後對同一份產物完成 SHA、payload、gateway 與版本校驗。沒有重建已成功的產物，也沒有把兩次 helper 失敗改寫成成功。
