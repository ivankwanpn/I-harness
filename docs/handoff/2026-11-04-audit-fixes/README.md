# Handoff — I-harness 審計修復分支（2026-11-04）

這份文件是為了在另一台電腦接續這次工作而寫。它說明分支內容、如何重建環境、目前驗證狀態，以及還沒完成的部分。

## 1. 分支與位置

- Repo：`https://github.com/ivankwanpn/I-harness.git`
- 分支：`experiment/audit-fixes-v0.1.13`（已推上 GitHub）
- 基底：tag `v0.1.13`（commit `46a6311f`）
- 目前：**34 個 commit**、94 個檔案、+2365/−240
- 檢查：

```powershell
git fetch origin
git switch -c experiment/audit-fixes-v0.1.13 origin/experiment/audit-fixes-v0.1.13
git log --oneline v0.1.13..HEAD
```

## 2. 分支內容（依類別）

| 類別 | 內容 |
|---|---|
| CI／可驗證性 | 新增 Windows GitHub Actions（typecheck、verify:all、boundary gate）；lockfile 正規化讓 `--frozen-lockfile` 可用 |
| 型別 | 修好 4 個套件的 typecheck（含 desktop renderer 的 `ResultPageQuery`/code-output 分支） |
| 安全 | Electron 導航防護；plugin hook `allow` 不再能跳過 host 審批；shell 腳本／任務執行器改判 dangerous；approval policy 改為 scope service（不再依賴競態 slot）；Windows DACL 保護 API key 檔；ACL denial 詞彙單一來源 |
| 資料完整性 | JSONL 中途損壞不再靜默截斷；session header 重寫走 fsync；context-output 發布 fsync；`write` 工具原子寫入且保留 mode；journal rollback 不再補零延伸；settings `unset` 真正刪除；subagent durable snapshot 上限；workflow job store 上限 |
| 協定／行為 | 統一 SSE framer（CRLF／多行 data）；error-body 觀測 abort；沙箱 denial 以 `sandboxDenial` advisory 回報；guard-timeout 真正超時；read_video timeout 立即 settle；capacity retry 加 jitter；credentials 併發寫入；子代理嵌套路徑 |
| UI | 時間軸不再把內部記帳事件渲染成「會話狀態已更新」列（白名單） |
| 診斷 | child birth 失敗訊息帶 BootstrapOutcome kind/reason |

完整清單與理由見同資料夾的 `I-harness-audit-v0.1.13.md`（含「已修／已推翻／未修」狀態表與第 9 節的取捨）。

## 3. 在另一台電腦重建

### 3.1 安裝依賴

```powershell
git clone https://github.com/ivankwanpn/I-harness.git
cd I-harness
git switch experiment/audit-fixes-v0.1.13
pnpm install --frozen-lockfile
```

### 3.2 Electron 二進位（pnpm 不會自動下載）

```powershell
$e = "node_modules\.pnpm\electron@44.4.5\node_modules\electron"
node "$e\install.js"
Test-Path "$e\dist\electron.exe"   # 必須是 True
```

### 3.3 打包需要的原生資產（重要）

`packages/sandbox-windows-acl/native/runtime/` **沒有進 git**，本機也無法從源碼編譯（`native/build-bridge.ps1` 綁定私有 MSVC 路徑與輸出授權）。取得方式：

1. 下載官方 `I-harness-0.1.13.zip`（GitHub release）。
2. 從 `I-harness/resources/app/out/native/runtime/` 取出這 5 個檔案，放到 `packages/sandbox-windows-acl/native/runtime/`：
   `acl-wait-assets.json`、`acl-wait-bridge.c`、`ih-acl-wait-bridge.dll`、`native-wait-protocol.mjs`、`native-wait-worker.mjs`
3. 驗證：

```powershell
node -e "import('./scripts/runtime-acl-wait-assets.mjs').then(m=>{m.verifyAclWaitSourceAssets('D:/path/to/I-harness/packages/sandbox-windows-acl');console.log('verified')})"
```

> 這些是官方 v0.1.13 的 binary，與本分支未修改的 native 源碼雜湊相符（已驗證）。

### 3.4 NSIS（安裝版）

```powershell
winget install --id NSIS.NSIS -e --accept-package-agreements --accept-source-agreements --silent
# makensis 通常在 C:\Program Files (x86)\NSIS\makensis.exe
```

### 3.5 建置

```powershell
$env:IH_NSIS_MAKENSIS = "C:\Program Files (x86)\NSIS\makensis.exe"
pnpm --filter @i-harness/desktop dist        # portable：release/I-harness + I-harness-0.1.13.zip
pnpm --filter @i-harness/desktop installer   # 安裝版：release/I-harness-Setup-0.1.13.exe
```

注意：
- 這個 shell 若設了 `ELECTRON_RUN_AS_NODE=1`，`I-harness.exe --version` 會變成 node；測 GUI 前先 `$env:ELECTRON_RUN_AS_NODE = $null`。
- Windows 上 `I-harness.exe` 被 single-instance 鎖住，第二個啟動會直接退出，這是正常的。
- 建置產物在 `packages/desktop/release/`（已 gitignore）。

## 4. 驗證狀態

- `pnpm -r --no-bail typecheck`：82 套件全綠（最後一次在 `815655c8` 之後跑過）。
- 已通過的針對性測試：`fs` 110/110、`hooks` 36/36（聚焦）、`settings` 230/230、`workflow` 62/62、`core-plugin` 58/58、`media` 15/15、`guard-approval` 103/106（3 個既有失敗）、`guard-timeout` 7/7、`token-meter` 53/53、`exec` service-runner 2/2、`desktop` project 20/20、`subagent` persist 21/21。
- **完整 `pnpm test` 在乾淨環境不可能全綠**：317 個測試依賴外部產生的 evidence fixtures；290 個 fixture 仍用 format 14 之前的 coordinator 建立方式（會得到 `TASK_TRANSITION_UNSUPPORTED`）。這是測試基礎的債，不是本分支造成。

## 5. 未完成／待驗證

1. **spawn_agent child birth 失敗會卡死整個會話** — 已修（待實機驗證）。
   - 現象：`subagent/end` = `Original child birth requires recovery`，之後所有請求 `Managed facts require reconciliation`。
   - 已確認：session journal 完整可載入（322 events, format 14）；卡住的是執行中 gateway 的記憶體 recovery 狀態。
   - 修復：
     - `9bbd898d` recovery 錯誤穿過 cleanup 聚合時保留 `FACT_RECOVERY_REQUIRED`（unit tests + 原本失敗的 claim-failure 案例轉綠）。
     - `cba08449` 新增 `desktop/session/reload` 與「重新載入會話」按鈕：關閉該會話讓下一次請求從 durable journal 重建，不必重啟整個 App（router 11/11）。
     - `601a930f` 只有真正不確定的 `blocked` 才進 recovery；`refused`/`not-issued` 以 `FACT_BIRTH_REFUSED` 正常回報（unit 6/6）。
     - `1ad4051d` birth 失敗現在會把 outcome kind/reason 與 target/parent/task id 寫進 runtime diagnostics。
   - 待做：用新安裝版重測 A5；若再失敗，從 journal 的 `(<kind>: <reason>)` 與 runtime diagnostics 找根因。底層 write error 仍只存在 backend ledger，尚未接到訊息。
2. **UI 時間軸噪音**已修（白名單），需要用新安裝版在真實會話確認位置與數量。
3. 審計未修項目：F8（append O(n²)）、F12（雙寫入協定）、F13（四種磁碟格式）、F16 完整重構、F25（env 過濾）、F40/F41（信任模型 UI）、D2/D4/O 系列。理由見 audit 文件第 9 節。

## 6. 這個資料夾的內容

- `README.md`（本文件）
- `I-harness-audit-v0.1.13.md` — 完整審計與修復狀態
- `IH-test-prompts.md` — 全功能測試提示詞包
- `git-log.txt` — 分支 commit 清單
- （在 `D:\ih-test\ih-handoff-2026-11-04\` 另有一份，含 `ih-diagnostics.json`）

## 7. 接續用提示詞（貼給另一個 Agent）

> 我在接續 I-harness 的審計修復分支 `experiment/audit-fixes-v0.1.13`（基底 tag v0.1.13，已推上 GitHub）。請先讀 `docs/handoff/2026-11-04-audit-fixes/README.md` 與同資料夾的 `I-harness-audit-v0.1.13.md`，再繼續。最優先的是：重現並修好 `spawn_agent` 的 child birth 失敗（錯誤會顯示 `Original child birth requires recovery (<kind>: <reason>)`）— 失敗的 spawn 目前會讓整個會話卡在 `Managed facts require reconciliation`，只能重啟 App。修好後要加回歸測試，並確認 `pnpm -r --no-bail typecheck` 全綠。其餘未修項目見 audit 第 9 節，依穩定性優先逐項處理，不要開新分支。
