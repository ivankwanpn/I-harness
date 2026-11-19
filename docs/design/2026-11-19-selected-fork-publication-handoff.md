# 修復 commit-log selected fork 的發布與封存

請在 `D:\codex-ih-development` 接手兩個已重現的 P1，完成程式修復與固定回歸。分支為 `codex/runtime-stability-redesign`，交接基準為 `3bc7f42067ddb4025ec5662b1484e24277cbc94b`。先核對分支、HEAD 與工作目錄，沿用後續已有的變更。

## 已重現的問題

1. **資源保留失敗，待發布目標仍可透過封存頁公開。** 真實 Gateway 中，grant 失敗後目標仍為 `forkPublication: 'pending'`，一般列表暫時隱藏。呼叫 `desktop/session/archived` 能看到目標，透過正常還原入口即可讓目標回到 `session/list`，持久化狀態仍為 pending。原因是這些入口只依 `archived` 處理，尚未納入 fork 的發布狀態。
2. **新版重試會解除前一版已完成 fork 的使用者封存。** 用 `aed8af6c` 的原始 controller 建立並完成 fork，封存目標並關閉 host，再以新版開啟並重送同一操作。結果回傳 `adopted`，但 archived 由 true 改為 false，目標重新出現在一般列表。前一版正常完成的目標沒有 `forkPublication`，新版將缺少欄位當成需要發布。

兩個案例都以受控模型、真正 Gateway RPC 和實際 commit-log 儲存重現。16 項既有迴歸通過，新補測兩項失敗。測試程式與前一版 controller 的原始碼，已保存至下列目錄。前版 controller 的 Git blob 為 `209f5bc683eaf2acfcf0ad689b526ffbc4a526f1`。

`C:\Users\IvanKwan\AppData\Local\Temp\ih-codex-review-20261119-fork-archive`

- [覆核收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-codex-review-20261119-fork-archive/receipt.json)
- [待發布目標還原的實測日誌](C:/Users/IvanKwan/AppData/Local/Temp/ih-codex-review-20261119-fork-archive/review.log:813)
- [前版資料重試的實測日誌](C:/Users/IvanKwan/AppData/Local/Temp/ih-codex-review-20261119-fork-archive/review.log:898)

## 實作範圍與契約

- **待發布狀態從出生開始生效。** 保留現在同一次持久化寫入建立 birth 與 pending 狀態的做法。讓 `forkPublication: 'pending'` 成為正常會話入口的可見性判定之一，即使資料已出現 `archived: false` 也要拒絕當成一般會話使用。重用共用的會話可見性與管理判定，核對一般列表、封存列表、還原、開啟／續作及相鄰搜尋或讀取入口。內部原始 fork 恢復、診斷及清理仍需能定位目標。
- **發布由原始操作完成。** 完整核對目標 birth 身分、操作及請求摘要，資源保留與必要 Task／project 文件完成後才發布。將身分和 pending 狀態的確認放進實際寫入所用的同一個受控操作，處理同一操作的並行重試。已發布的目標取回原結果；重播過程保持使用者隨後的 archive／restore 決定。若目標身分不符，保持其 metadata 及資源保留資料原樣。
- **兼容上一版已持久化的記錄。** 用實際舊資料查證原有 outcome、舊 `published` marker 與目標 metadata 的語意。對已有完成／發布證據的舊目標，保持 `archived`。舊 `published: false` 存在跨寫入中斷的歧義，依確實存在的持久化證據決定能否恢復。證據不足時，保留封存並回傳符合契約的結果。請記錄各種舊資料如何處理。
- **維持現有恢復能力。** 保留 grant 失敗後使用同一操作續補、目標衝突時零 grant、資源保留成功後的精確 receipt、已發布操作重跑的冪等性，以及 JSONL 暖／冷續作與已掛載後的重播。沿用既有協調器、持久化資料與正常入口，依根因調整生命週期。

建議從以下位置追查。這些是起點，請核對它們的呼叫者及儲存契約。

- [selected-fork.ts 的發布及重試](D:/codex-ih-development/packages/desktop-gateway/src/selected-fork.ts:117)
- [會話可見性](D:/codex-ih-development/packages/desktop-gateway/src/session-visibility.ts:12)
- [封存列表及管理](D:/codex-ih-development/packages/desktop-gateway/src/session-management.ts:149)
- [commit-log 的 birth 及原始身分比對](D:/codex-ih-development/packages/session-persistence/src/commit/coordinator.ts:456)

## 驗收測試

1. 將上述兩個已重現案例納入固定回歸。第一案透過 Gateway 的真實列表及還原入口斷言待發布會話不可用、磁碟資料維持 pending，之後同一原 fork 操作可正常完成。第二案由真實前版 controller 產生舊資料，由新版冷啟動重播，確認封存、原本的持久化身分及適用的 receipt 契約。
2. 對 publication 寫入失敗、發布已提交但回覆或 outcome 保存失敗，以及使用者隨後封存的情形，核對冷重試與並行重試。至少覆蓋原生或既有測試 seam 可穩定控制的故障點，保留實際命中次數與原始狀態，證明只有合法的 pending 操作可以發布。
3. 完整執行修改涉及的測試檔案與 package 型別檢查。按本機既有方式依序執行大型工作，可先用下列定向命令。新測試使用原有 helper、受控模型或 loopback。不需使用真實 DeepSeek 額度。

```powershell
Set-Location -LiteralPath 'D:\codex-ih-development'
node scripts/test-env.mjs pnpm --filter '@i-harness/desktop-gateway' test test/selected-fork-seed.test.ts test/host-commit-log-selected-recovery.test.ts test/host-jsonl-fork-continue.test.ts test/session-management.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter '@i-harness/desktop-gateway' typecheck
pnpm --filter '@i-harness/session-persistence' typecheck
node scripts/audit/check-package-boundaries.mjs --gate
git diff --check
```

## 交付

直接完成修復與驗證，回報兩個重現如何由失敗轉為通過、舊資料的處理契約、固定版本、實際測試數字及證據路徑。沿用既有交接的 Git 身分規則，提交及推送使用已登入的 `ivankwanpn <213307026+ivankwanpn@users.noreply.github.com>`，核對遠端 SHA 與 CI。

本輪先完成這兩個發布與封存問題。issue 125 的整體驗收仍包括 typed SDK V2、公開 C67 流程及固定版本完整驗證。最近完整全綠證據對應 `52cf62ff`。Push CI 的完整 `verify:all` 為略過，Windows 完整 job 的 180 分鐘限制已有取消實測。定向驗收收斂後，再依整體範圍核對完整驗證。
