# IH 測試品質修復與重寫任務

你現在接手 I-harness 的測試品質修復工作。請直接檢查程式、修改測試、執行驗證，持續完成具體修復。

使用者已授權檢查與修復設計問題、bug、測試及必要的相關實作，也允許有根據的重新設計。你的主要工作是讓測試真實反映產品契約，找出錯誤測試、假陽性、假陰性、失效 fixture、錯誤故障注入、資源洩漏及不可靠的驗收方式。

測試揭露真正 production bug 時，請保留正確的驗收要求，追查根因並完成必要修復。重大產品實作變更應有清楚的證據、影響範圍及獨立提交。

使用繁體中文報告進度。優先做實際修改與驗證，控制對話輸出長度，把完整日誌保存到檔案。

## 一、工作環境與交接版本

工作目錄

`D:\codex-ih-development`

參考項目目錄

`D:\ih-reference-project`

參考目錄維持唯讀，用來理解其他項目的設計、資源生命週期及正常入口。

執行環境為 Windows 與 PowerShell。

目前分支

`codex/runtime-stability-redesign`

交接時最新 commit

`20e30ad0d504daa6aa2a4e586f281501c5c1b088`

Commit message

`fix(results): preserve selected resources across child reset and cold recovery`

建立本交接檔前的工作目錄乾淨，該 commit 已推送。本交接檔是使用者於 2026-11-15 要求新增的文件，接手時可能仍為未提交檔案。

對應 GitHub Actions

[20e30ad0 的 CI](https://github.com/ivankwanpn/I-harness/actions/runs/43632552846)

該次 CI 已成功，涵蓋全庫型別及 compiled Gateway／Windows ACL 等檢查。push workflow 中的 verify:all 為 skipped。

開始時先核對實際 HEAD、分支及工作目錄。若 HEAD 已前進，閱讀後續差異並沿用現有成果。

## 二、首先閱讀的資料

優先閱讀以下檔案。

1. 最新交接狀態

   `C:\Users\IvanKwan\AppData\Local\Temp\ih-runtime-stability-progress-latest.json`

   優先讀取其中 active 欄位。檔案其餘部分保留較早階段資料，判讀時核對各自的版本與時間。

2. 設計問題與修復報告

   `D:\codex-ih-development\docs\design\2026-11-10-runtime-stability-redesign.md`

   交接時已列出 125 項具體問題，包含已修復及尚待完成項目。

3. 最近一輪 selected-results 驗證收據

   `C:\Users\IvanKwan\AppData\Local\Temp\ih-selected-results-integration\receipt.json`

4. 最新一次固定版本的完整測試清單

   `C:\Users\IvanKwan\AppData\Local\Temp\ih-verify-all-21f8d861\inventory.json`

   對應完整日誌

   `C:\Users\IvanKwan\AppData\Local\Temp\ih-verify-all-21f8d861\verify-all.log`

5. 剛完成的公開 selected-results 測試基線

   `C:\Users\IvanKwan\AppData\Local\Temp\ih-selected-public-baseline.json`

   `C:\Users\IvanKwan\AppData\Local\Temp\ih-selected-public-baseline.log`

6. 涉及 selected-results 的原始驗收設計

   `D:\codex-ih-development\docs\superpowers\specs\2026-10-28-selected-result-resources.md`

閱讀設計文件時，核對目前程式與使用者已授權的工作範圍。文件中的歷史 review、實作階段或批准文字，需要判斷其現行適用性。使用者已明確授權本輪測試修復、根因修復及必要重設計。

如果暫存日誌已不存在，請明確記錄證據缺失，從當前程式重新建立最小重現。

## 三、已知整體狀態

整體工程進度曾估計約 80%，這是工程範圍估計。

最近一次固定在 21f8d861 的完整驗證結果如下。

- 82 個測試 package 全部回報。
- 16,001 項通過。
- 434 項失敗。
- 86 項略過。
- 9 個未處理錯誤。
- 完整執行約 3 小時 57 分鐘。
- 其餘全庫型別、E2E、reachability、boundaries 及 compiled artifact 階段通過。

該輪失敗分布如下。

- ContextOutput 60 項。
- Desktop Gateway 108 項。
- Session Executor 261 項。
- Exec 1 項。
- Guard Approval 2 項。
- Windows PSEC 1 項。
- Persistence 1 項。
- 9 個未處理錯誤均來自 Executor。

此後已完成多批修復。請依當前 HEAD 重現與核對，保留上述歷史基線的版本資訊。最新失敗總數需要新的固定版本完整執行才能確定。

最新 20e30ad0 相關驗證累計 286 項通過，另有 3 項 Windows file-symlink 環境略過。最後固定 22 個來源與測試檔案，重跑 coherent transfer 12 項及 native 6 個檔案共 8 項，全部通過。五個相關 package 型別檢查通過，boundary 計數為 128／128。

## 四、第一優先批次，修復已確認的測試失真

先處理以下三個檔案。本文其餘 repository-relative 路徑均相對於 `D:\codex-ih-development`。

```text
packages/desktop-gateway/test/host-commit-log-selected-fork.test.ts
packages/desktop-gateway/test/host-commit-log-selected-read.test.ts
packages/desktop-gateway/test/selected-fork-seed.test.ts
```

三個完整檔案在 20e30ad0 上共 7 項全部通過，耗時約 44.57 秒。閱讀原始碼後已確認，其中部分驗收沒有覆蓋測試名稱宣稱的功能。

### A. fork 保留結果的案例沒有真正執行讀取工具

檔案

`packages/desktop-gateway/test/host-commit-log-selected-fork.test.ts`

第一個案例的具體問題如下。

- toolCalls 初始為 0。
- 模型處理 read big 的分支要求 toolCalls === 1。
- 案例實際只提交 read big。
- 因此讀取工具沒有執行。
- 最後還斷言 selected result pages 為零。
- 測試名稱卻宣稱驗證帶有 selected results 的 fork。

請重寫成真實、可觀察的正向流程。

- 使用真正 Desktop Host 與實際 RPC 入口。
- 模型回覆可以受控。
- 工具需經正常 registry、prepare、dispatch 路徑執行。
- 核對實際工具呼叫與成功結果。
- 從真正保存的事件或結果取得 ref。
- fork 後核對確切被選取的結果。
- 核對完整內容或完整分頁重組後的 bytes 與 digest。
- 核對效果次數及正常清理完成。
- 對缺少工具執行、缺少結果或內容不符的情況，測試應明確失敗。

同檔第二個案例使用 codec fixture 與手工宣告資料。請核對其測試層級與名稱，明確驗證它實際覆蓋的內容。資源可讀性與轉移能力需要實際 artifact、owner 及儲存證據。

### B. 冷讀取案例補入了虛構 legacy reference

檔案

`packages/desktop-gateway/test/host-commit-log-selected-read.test.ts`

現有流程先產生真正 managed artifact，之後又手工 append 一筆 context/result-ref。

該筆資料使用手工填寫的 workspaceId、bytes、originalBytes 等欄位，把 managed artifact 身分放進 legacy 宣告。

請改用產品正常產生的 metadata、事件與 ref，驗證完整流程。

- 正常工具產生結果。
- 原始 host 正常關閉。
- 新 host 冷開啟。
- 經公開入口建立 selected-results fork。
- child 能讀取正確結果。
- source 清除或退休後，target 依其保留契約仍可讀取。
- target 再次冷開啟後仍可讀取。
- nested fork 使用正常入口與實際繼承資料。
- 未選取、被 rewind 隱藏、fork 後才產生及無權限的結果均受到正確限制。
- 核對完整 ref、revision、內容與 digest。
- 核對原始資源確實清理。

分批建立這些控制，避免第一步就製造過大的混合案例。

### C. selected-fork-seed 的測試層級需要核對

檔案

`packages/desktop-gateway/test/selected-fork-seed.test.ts`

其中使用 synthetic codecRef 與手工事件。

純編碼、解碼、projection 或 metadata 單元測試可以使用這類資料。驗證資源轉移、授權、實際內容與冷恢復時，應建立真正底層資源並走正常入口。

請核對每個案例宣稱的能力、實際執行路徑及斷言之間是否一致，補齊缺少的控制。

## 五、相鄰 production 路徑的待驗證問題

### A. 公開結果讀取會沿 ancestor chain 回退

檔案

`packages/desktop-gateway/src/result-reader.ts`

目前觀察到的程式行為如下。

- child 的直接讀取 unavailable 後，取得 seed result pages 中的 ref IDs。
- 以 ref ID 判斷是否繼承。
- 沿 parentSession 最多向上尋找 16 層。
- 使用祖先 session 嘗試讀取原查詢。

需要建立真正控制來回答以下問題。

- selected target 是否確實持有自己的資源保留與讀取資格。
- 完整 ref 與 revision 是否精確匹配。
- source 清除、退休或失去權限後的行為。
- ancestor 已 archived 或不可見時的行為。
- nested fork 的實際來源及授權邊界。
- 跨 await 的 visibility／currentness 變化。
- 正常歷史資料的相容性。

這項目前已有原始碼觀察，完整原生負向控制尚待建立。請先重現，再依證據修復。

### B. 公開 JSONL selected-results 入口尚未接通

檔案

```text
packages/desktop-gateway/src/host.ts
packages/desktop-gateway/src/selected-fork.ts
packages/desktop-gateway/src/context-runtime.ts
```

Host 目前只為 commit-log 安裝 V2 selected fork controller。

JSONL 的 original capture、publish、cold finalization kernel 已有原生整合案例，但公開 Gateway／SDK 流程仍待整合。這是問題報告中的第 125 項。

驗證公開功能時，請從真正公開入口執行。內部 kernel 的成功可作為其自身範圍的證據。

## 六、保留最近已修好的正向驗收

20e30ad0 已修復以下問題。

- 零繼承歷史的真正 Task child 可以讀取與搜尋自己的 legacy 結果。
- selected preparation facts 完成驗證及深度凍結後可重用，live owner 與 currentness 仍逐次核對。
- selected projection 中的 managed roots 納入 V2 原始請求、binding 與 dependency closure。
- 冷恢復組合真正的 project、managed 與 legacy qualifiers。
- metadata-only qualification 在對應功能狀態下可正常執行。

相關測試如下。

```text
packages/desktop-gateway/test/native-context-child-recovery.test.ts
packages/desktop-gateway/test/selected-results-eligibility.test.ts
packages/desktop-gateway/test/selected-inspection-cost.test.ts
packages/desktop-gateway/test/subagent-protocol-header.test.ts
packages/context-output/test/coherent-transfer-contract.test.ts
```

原始 C67 正向驗收的主要順序如下。

```text
真正 child 產生結果
→ compaction
→ reset
→ cold resume
→ selected-results V2 fork
→ 精確內容讀取與搜尋
→ source clear／retire
→ target cold qualification
→ 再次讀取精確內容
```

普通工具模式及 Code Mode 都需要成立。

前一輪曾因 V1 selector 回報 legacy-anchor-unsupported，把 fork 暫時移到 reset 之前。核對原始驗收後已恢復上述順序。

請維持這項正向要求，並把 V1 格式限制及 V2 正向能力分別驗證。

不可變 facts 的回歸測試已做反向驗證。移除重用後，重複確認使派生次數由 28 增至 94，測試會失敗。候選版本驗證重複確認不增加完整派生次數，真正 source 變更仍會被拒絕。

## 七、逐批整理其它失敗測試

完成第一批後，依 inventory 與當前重現結果整理其餘失敗。

優先判斷以下情況。

- fixture 使用已失效的 API 或事件格式。
- backend 建構後才替換受到原始身分保護的方法。
- 缺少真正 Task transition coordinator。
- child header 缺少 seedLength 或其他必要出生資料。
- 只建立 header，卻宣告已有繼承歷史。
- 測試直接呼叫 tool.execute，跳過正常工具準備與 dispatch。
- spy 攔截不到實際呼叫位置。
- 故障注入尚未到達預期 I/O，案例已先在 admission 失敗。
- 模型條件分支沒有觸發預期工具。
- 尚未取得 committed ACK，就宣稱已保存。
- crash fixture 在真正 marker 寫入前退出。
- 斷言硬編碼舊格式版本或舊 artifact 數量。
- cleanup 將原始錯誤吞掉，掩蓋 resource debt。
- 測試逾時後，舊工作繼續執行並污染下一個案例。
- Windows file-symlink 權限問題與真正產品失敗混在一起。
- 只檢查欄位存在，缺少確切內容與行為驗證。
- 只有成功案例，缺少足以抓住該次缺陷的負向控制。

可參考已重寫的測試。

```text
packages/session-executor/test/partial-retry-recovery.test.ts
packages/session-executor/test/instruction-isolated-finalization.test.ts
packages/session-executor/test/delivery-cold.test.ts
packages/session-executor/test/helpers/delivery-crash.mts
packages/desktop-gateway/test/helpers/native-consumer-fixture.ts
```

參考時仍需核對目前的正常入口與契約。

## 八、測試重寫原則

### 正常入口與真正效果

每項測試先說清楚使用者可觀察的正確行為，以及應驗證的契約。

純資料邏輯可以使用精簡 fixture。生命週期、權限、持久化、恢復與 native I/O 的整合測試，使用原始 constructor、真正 owner、實際儲存及正常呼叫入口。

驗證工具執行時，涵蓋準備、授權、dispatch、結果保存與 terminal 狀態。

### 故障注入

沿用現有 constructor 提供的 wrapOwnedBatch、wrapOwnedReconcile 或相關原始 I/O 注入入口，具體參數以當前程式為準。

每個故障案例核對注入實際到達的次數與位置。

區分以下狀態。

- 寫入前拒絕。
- 真正零位元組寫入。
- 已寫入但 ACK 遺失。
- reconcile 仍為 unknown。
- 已取得 committed 或 absent 的原生結果。
- cleanup 尚有原始責任待重試。

### 斷言

對應缺陷選擇足夠精確的斷言。

- 原始內容與完整 ref。
- revision、digest、encoded bytes。
- 實際執行次數與副作用次數。
- 未授權操作的零效果。
- 預期的 durable state 與 terminal event。
- 保護欄位修改拒絕後，原始檔案 bytes 相同。
- 子程序 exit、listener 關閉及 pending operations 歸零。
- 原始 owner 的 cleanup ACK 與重試責任。

錯誤碼或 typed result 有穩定契約時優先核對它們。一般錯誤訊息文字應以真正需要維持的契約為範圍。

### 測試對缺陷的敏感度

對新修復或可疑假陽性，建立至少一個具體反向控制。

例如暫時移除修復、阻止預期工具執行、替換原生身分，或令結果內容不符，確認測試會失敗。

採取與問題規模相稱的方式，完整恢復診斷改動並核對差異。

### 清理

失敗、取消、逾時與 setup 中途失敗，都需要處理已建立的原始資源。

已完成的 sibling cleanup 應保持冪等。原始 cleanup 失敗時保留具體責任及可重試狀態。

曾有一個測試過度要求所有 close 都成功。真正契約是政策失效後首次 close 回報 CONTEXT_INPUT_STALE，後續 close 完成清理。請依實際契約驗證診斷與釋放結果。

## 九、期限、效能與執行隔離

本機採用單一測試／型別編譯工作擁有者，按批次依序執行。

測試使用至多兩個 Vitest workers。診斷共享狀態、native contention 或時間敏感問題時使用一個 worker。

全庫型別編譯、大型測試與 IH dev 啟動會影響原生案例耗時，量測時分開執行。

前一輪有一份早期診斷曾短暫與型別檢查重疊，正式數字已改採獨立重跑。

期限調整需要記錄原值、實際時序、工作量與新值。先判斷逾時發生於 setup、原生操作、模型 fixture、等待 ACK 或 cleanup。

已知的個別期限如下。

- 完整 native child cases 由 15 秒調為 180 秒，曾量得普通模式約 85.383 秒、Code Mode 約 142.697 秒。
- metadata cases 由 15 秒調為 120 秒，曾量得約 29.222 及 43.226 秒。
- header case 由 5 秒調為 15 秒，曾量得約 5.295 秒。
- Gateway usage 測試內層 prompt 由 5 秒調為 20 秒，外層原 30 秒案例期限保留，實測 prompt 約 5.866 至 14.152 秒。
- 10,001 observations 案例仍使用原 300 秒期限，目前存在逾時。
- funding d31 在原 120 秒期限獨立執行曾以 113.890 秒通過，d1 約 12.568 秒。批次中 d31 逾時後殘留工作曾污染 d1。

大型案例位置如下。

```text
packages/context-output/test/legacy-fork-observation-scale.test.ts
packages/context-output/test/legacy-funding-batch.test.ts
```

效能測試需保留原本衡量的工作量與語意。重複資料派生、重複原生核對及 fixture 自身放大成本，都應以量測辨認。

## 十、環境略過的處理

Windows 部分 file-symlink 案例在真正建立 link 時回報 EPERM，已有環境條件略過。

請分別記錄以下數字。

- Passed。
- Failed。
- 環境條件 skipped。
- 命令篩選造成的未執行案例。
- Unhandled errors。
- Cleanup failures。
- Timeout 後仍在執行的工作。

Hardlink、junction、身分替換與正常路徑等可執行控制，保留其實際驗證。

歷史 predecessor 測試曾使用 IH_TASK_D_PREDECESSOR_FIXTURES 與真正 format 13 producer。需要這些案例時，查閱報告及原有 manifest，確認 producer、輸出與版本，沿用真實歷史資料。

## 十一、執行命令

先切換工作目錄並核對狀態。

```powershell
Set-Location -LiteralPath 'D:\codex-ih-development'
git status --short
git branch --show-current
git log -1 --format="%H%n%s"
```

專案使用 pnpm，測試經由既有 environment wrapper 執行。

第一批完整檔案的命令如下。

```powershell
node scripts/test-env.mjs pnpm --filter '@i-harness/desktop-gateway' test test/host-commit-log-selected-fork.test.ts test/host-commit-log-selected-read.test.ts test/selected-fork-seed.test.ts --maxWorkers=1 --minWorkers=1
```

保存 JSON 與完整文字日誌時，可採用以下形式，為每輪使用新的證據檔名。

```powershell
$testEvidenceRoot = Join-Path $env:TEMP 'ih-test-rewrite-handoff'
New-Item -ItemType Directory -Path $testEvidenceRoot -Force | Out-Null

node scripts/test-env.mjs pnpm --filter '@i-harness/desktop-gateway' test test/host-commit-log-selected-fork.test.ts test/host-commit-log-selected-read.test.ts test/selected-fork-seed.test.ts --maxWorkers=1 --minWorkers=1 --reporter=default --reporter=json "--outputFile.json=$testEvidenceRoot/selected-public.json" *> "$testEvidenceRoot/selected-public.log"

$testExitCode = $LASTEXITCODE
$testExitCode
```

按修改範圍執行相關 package 型別檢查，與測試分開執行。

```powershell
pnpm --filter '@i-harness/desktop-gateway' typecheck
pnpm --filter '@i-harness/session-executor' typecheck
pnpm --filter '@i-harness/context-output' typecheck
pnpm --filter '@i-harness/session-persistence' typecheck
pnpm --filter '@i-harness/core-session' typecheck
```

邊界與差異檢查如下。

```powershell
node scripts/audit/check-package-boundaries.mjs --gate
git diff --check
```

整體修復收斂後，在固定來源版本執行。

```powershell
pnpm verify:all
```

先閱讀 scripts/verify-all.mjs，理解完整 package population、七個驗證階段及準備工作。全庫驗證預留數小時，持續監看至 terminal 結果，保存完整日誌。

搜尋程式優先使用 rg 或 rg --files。Windows 上以目錄搭配 -g 搜尋，避免把未展開的 wildcard path 當成實際檔名。

## 十二、Git 身分與提交

使用者明確要求使用其已登入的 GitHub 帳號。

帳號

`ivankwanpn`

作者與提交者

`ivankwanpn <213307026+ivankwanpn@users.noreply.github.com>`

交接時，本輪 109 筆提交已逐筆核對，本機 author／committer、GitHub attribution、有效 Git credential 帳號及 push actor 均符合。

提交前核對以下項目。

- gh api user 的登入帳號。
- 當前分支與待提交檔案。
- git var GIT_AUTHOR_IDENT。
- git var GIT_COMMITTER_IDENT。
- 暫存區的精確修改範圍。

可在本次 PowerShell 程序設定明確身分。

```powershell
$env:GIT_AUTHOR_NAME = 'ivankwanpn'
$env:GIT_AUTHOR_EMAIL = '213307026+ivankwanpn@users.noreply.github.com'
$env:GIT_COMMITTER_NAME = 'ivankwanpn'
$env:GIT_COMMITTER_EMAIL = '213307026+ivankwanpn@users.noreply.github.com'
```

現有實際憑證稽核工具如下。

`C:\Users\IvanKwan\AppData\Local\Temp\ih-audit-github-identity.mjs`

使用前先閱讀它。該工具在記憶體內核對 Git 實際憑證帳號，輸出應維持不含 token。

每一批採取範圍清楚的小提交，測試品質修正與 production 根因修正可分開記錄。保留既有成果，使用正常非強制推送，核對實際 commit SHA 對應的 CI 結果。

若另有開發者同時工作，先確認檔案與執行資源的分工，避免共同修改同一檔案或重疊執行大型 native 測試。

## 十三、模型、dev 與成本

使用者已授權隔離 IH dev 沿用現有供應商，並指定 DeepSeek Flash 做實機測試。

既有 dev launcher

`scripts/dev-desktop.ps1`

既有隔離 profile

`C:\Users\IvanKwan\AppData\Local\I-harness-dev\stability`

交接時 dev 已關閉。

先前已使用真實 DeepSeek Flash 驗證 Code 執行、同 cell 背景等待、正常父子 Task、關閉及冷重啟。證據對應較早 commit，閱讀時保留版本資訊。

日常測試修復優先使用本機 controlled model 或 loopback HTTP fixture。需要實機確認時使用既有隔離 dev、deepseek-flash 與最小任務，保護現有設定與憑證。

使用者轉交此工作是為了節省原開發助手額度。完整日誌寫入檔案，對話只回報有意義的進度、失敗根因及驗證摘要。

## 十四、產品方向

Team 執行功能已依使用者要求移除。歷史 Team 資料保留必要唯讀相容處理。

Code Mode 保留為獨立 package，目前使用 QuickJS／WASM 與 Node Worker。使用者允許參考 DSH、OpenCode 等項目調整設計。

涉及這些測試時，按目前已接受的產品方向修復。架構調整應直接解決已重現問題，重用現有機制，控制新增抽象與狀態。

## 十五、工作節奏與交付

請按以下順序執行。

1. 核對 HEAD、工作目錄、交接狀態與報告。
2. 閱讀第一批三個測試及其 production 呼叫路徑。
3. 重現已知假陽性，建立真正輸出與持久化證據。
4. 修正或重寫測試。
5. 對新暴露的產品缺陷建立最小重現，修復明確根因。
6. 完整執行修改過的測試檔案。
7. 執行相關回歸、型別及 boundary 檢查。
8. 核對來源版本與差異，完成小批提交。
9. 依 inventory 繼續處理同類 fixture 與測試缺陷。
10. 在來源固定後完成較大範圍及全庫驗證。
11. 更新既有問題報告及交接 active 狀態。

每一批回報以下內容。

- 原測試實際漏掉或誤判的行為。
- 正確驗收契約的依據。
- fixture、harness、測試與 production 各自改了什麼。
- 故障注入是否真正到達預期位置。
- 舊版本／反向控制如何失敗。
- 修正後完整檔案的結果。
- 通過、失敗、環境略過、未執行及 unhandled 數字。
- 任何期限調整及其量測。
- 日誌與收據位置。
- 尚未完成或尚未確認的項目。
- 提交 SHA、Git 身分及 CI 範圍。

首次進度回報以第一批三個測試的實際分析與修復結果為主。完成後繼續下一批已確認問題。

最終完成情況應能回答以下問題。

- 高優先級測試是否真正在驗證其宣稱的能力。
- 已修復缺陷是否有會抓住回歸的控制。
- 正向驗收是否完整保留。
- 失敗與取消後的原始資源是否完成清理。
- 正常產品入口是否能執行預期功能。
- 最新固定版本的完整測試範圍與結果是否清楚。
- 所有尚待處理事項是否有可接續的證據與位置。

現在直接從核對工作目錄，以及第一批三個 selected-results 測試開始。
