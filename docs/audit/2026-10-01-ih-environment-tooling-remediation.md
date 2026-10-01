# IH 環境實測追查與修正 — 2026-10-01

## 來源與範圍

使用者提供 [IH 實測報告](/D:/IHplayground/ENVIRONMENT-TOOLING-REPORT.md)，受測會話 `sess-muosrt95-z8qzyq`。本輪依其觀察追查 `D:/frontend-test` 的程式碼及這台 Windows 主機；不修改使用者原報告、IH 全域設定或安裝額外開發工具。

報告中的「已通過」、「未測」、「未設定」各自保留，沒有將同族工具測過視為另一支工具也已通過。批次中被取消的工具不列為自身故障。

## 問題與處理

| 報告觀察 | 追查結果 | 本輪處理 |
| --- | --- | --- |
| `bash` 使用 Rtools，npm/npx 的 `env bash` 誤入 WSL，exit 127 | 重現。明確 bash resolver 只選 PATH；子程序 PATH 仍讓 System32 的 WSL launcher 排前。 | Windows 優先偵測 Git Bash，再使用其他原生 Bash，排除 WSL launcher。每次 Bash 執行只在該子程序的 PATH 前置已選定 Bash 目錄；前景、背景、promotion 路徑一致。需要 Rtools 的使用者仍可在 Agent Shell 選 PATH Bash。 |
| `pwsh` 工具跑 5.1，機器實際有 7.6.6 | 重現。WindowsApps `pwsh.exe` 可以啟動，但 Node `existsSync()` 回傳 false；PATH 大小寫與引號也缺乏一致處理。 | 回傳已解析的絕對執行檔；處理 `Path` 大小寫／引號、標準 PS7 安裝路徑，對已知 WindowsApps PowerShell alias 用固定 `--version` 探測。Agent Shell 與人用終端的偵測共用此處理，選取後可重新驗證。 |
| teammate 執行後，最終結果沒到 Lead | 來源缺少完成結果到 Lead inbox/admission 的接線；SessionService 也沒有預設 parentNotify adapter。 | 完成／錯誤結果送入持久化 Lead mailbox；SessionService 預設接到目前 Lead 的 system steer／既有 admitted-input lane。忙碌 Lead 在下一 boundary 可見，閒置 Lead 可處理；穩定 ID 防重複，取消／關閉抑制後續喚醒。保留外部指定 adapter。 |
| 活著、已完成本輪的 teammate 被列為 inactive | scheduler 的 `idle` 狀態未被 roster 的 `waiting` 映射認得。 | roster 接受 `idle`／`waiting`，顯示真實閒置狀態。 |
| `tool_search` 找不到工具 | 現行 assembly 的 `glob`、`grep` 可用名字、一般關鍵字和 exact deferred selector 找到，未重現全部查詢失敗。另發現 `+FILE`／`+LIST_DIR` 這類 must-term 與小寫／拆詞索引不一致。 | 必須詞使用同一 tokenizer 正規化，修正大小寫及複合名稱。沒有加入 wildcard 或改變 direct/deferred 邊界。 |
| 同批一個工具失敗，其他被取消 | 現行、已有測試的 fail-stop batch semantics：未開始的呼叫取消；正在執行者收到可協作取消；已完成效果不回滾。普通工具 body error 允許 Agent 下一步繼續。 | 保留核心批次策略。報告說明取消原因；不將 `job_list`、`memory_note` 的 sibling cancellation 算作該工具獨立故障。 |
| 子代理沒有 `terminal_*` | 內建角色採有限 allowlist，與主會話不同。 | 保留權限邊界。列入 UI 診斷／角色工具可見性的缺口，不自動擴大工具權限。 |
| 子代理背景工作出現在父層 | 同一 assembly 的家庭共享工作 registry 及父層控制行為。 | 保留；UI 工作歸屬／process explorer 仍可改善。 |
| `team_wait_agent` 沒有 active peer 時立即回傳 | 明確定義的 noProgress shortcut。 | 保留。沒有活躍 peer 時的立即回傳不當作 waiter 故障。 |
| memory disabled／沒有 workflows／webSearch false | 分別是持久化設定／沒有註冊標的／工具未啟用。記憶已有人用啟用管理頁。 | 沒有改使用者設定或安裝搜尋服務；提供介面清單與有效工具診斷需求。 |
| Python alias 靜默退出／.NET 只有 runtime | 主機工具鏈狀態，沒有重寫使用者命令的安全通用方法。Python 指令無輸出也可能是合法程式行為。 | 保留環境狀態；Python 可用 `py`，.NET build 需另裝 SDK。未偷偷替換 command 或全域 PATH。 |
| write 不 mkdir、apply_patch 限相對路徑 | 目前兩支工具的明確契約差異。 | 保留並記錄。多 root apply_patch 與完整 rewind／人用檔案導航需要另行設計，不宣稱已驗收所有跨 root 工具。 |

### Search 可重現的用法

現行 assembly 的兩個 deferred 定義是 `glob` 和 `grep`。`glob`、`grep`、`find files`、`search text`、`select:glob,grep` 都能匹配。

`*` 沒有 wildcard 語義。`workflow_run` 已是 direct tool，不需要 deferred discovery；對它使用 `select:` 會報 unknown selector。`totalDeferred` 計算宣告為 deferred 的定義，包含已 promoted 的工具，並非「尚未找到的數量」。

## 驗證界線

- Shell regression 最初確實重現 npm exit 127 與 PowerShell major 5；修正後真實程序得到正常 npm 版本、巢狀本機 Bash及 PowerShell major 7。
- 在不含 Codex bundled PowerShell 的獨立 PATH 中，WindowsApps alias 可被偵測與執行。實際 Agent Shell 設定保存、解析和 validate 路徑也通過。
- Windows ACL backend 下執行該 PowerShell alias：專案內檔案成功寫入，專案外寫入遭拒，未留下外部檔案。證據：`D:/frontend-research/ih-powershell-alias-sandbox-qa-2026-10-01.log`。
- teammate 使用真實 SessionService、coordinator、子代理 scheduler 與 deterministic ModelClient fixture 驗證完成結果；沒有付費提供商呼叫，也不把 fixture 稱為真實 DeepSeek 驗收。
- 本輪沒有重新逐一跑原報告全部工具，原報告列明未測的項目仍是未測。

### Todo 介面實際驗收

使用者提供 ZCode 進度卡截圖後，本輪加入同類型的緊湊 Todo 卡片：完成數／總數、綠色完成勾與刪除線、目前項目、收合／展開、每頁八項及直達原有編輯介面。它只讀同一份 authoritative workState，沒有新的 Todo 儲存。壓縮與重啟保留的既有後端沒有改動。

實際便攜 Electron 驗收通過：2/5 → 開啟編輯並人工新增 → 2/6 → 全部完成 6/6；收合／展開、CAS 接線、窄視窗沒有水平溢出或遮住 Composer。本輪 UI 驗收沒有提供商憑證，**付費提供商呼叫 0 次**。腳本／log：`D:/frontend-research/ih-todo-progress-packaged-qa-2026-10-01.{mjs,log}`。三張實際截圖：`ih-todo-progress-wide-2026-10-01.png`、`ih-todo-progress-narrow-2026-10-01.png`、`ih-todo-progress-completed-2026-10-01.png`，皆在該 research 目錄。

驗收抓到 Todo 卡片與 Timeline 使用相同 React key，更新後會重複卡片。已以重複 snapshot 更新的 regression 重現並改為獨立 key。另修正 native helper 的 external TypeScript 匯入：採用可隨 Electron main 打包的相對來源入口，不修改使用者的 Electron 設定。

第一輪完整 gate 有一個原有 project/resident native integration 測試超過 5 秒，只有 65/70 專案回報，不能當作完整成功。獨立重跑該檔案通過；停止與大型完成結果修正後的下一輪通過 4,010 項。最後 frozen-source gate 通過 **4,011 項、10 略過、0 失敗，70/70 專案回報**；型別檢查、五個 E2E 檔案、可達性 gate 全部通過。Log：`D:/frontend-research/ih-environment-todo-frozen-verify-2026-10-01.log`。

獨立覆核確認先前發現的冷恢復、過長完成結果、停止／flush／重啟、system input provenance 問題均已修正；另重跑 21 項相關測試通過。Shell／gateway 原生測試分別 63／10 項通過；Todo／Workbench 已有與新增受影響測試共 37 項通過。

尚未定位的一次額外觀察：早期 UI 驗收腳本在建立會話後立刻重新命名，JSONL header replacement 遇到 Windows `EPERM`。後續 Todo 專項驗收未再做重新命名，原先的會話管理驗收記錄仍保留。這次沒有聲稱該瞬時檔案替換錯誤已被修正；若真實使用重現，應另查 Windows 檔案持有者與 persistence 替換策略。

## 交付包

建置 log：`D:/frontend-research/ih-environment-todo-delivery-build-2026-10-01.log`。

- 執行檔：`D:/frontend-test/packages/desktop/release-environment-todo-2026-10-01/I-harness Desktop/I-harness Desktop.exe`
- ZIP：`D:/frontend-test/packages/desktop/release-environment-todo-2026-10-01/I-harness-Desktop-0.1.0.zip`

ZIP SHA-256：`9D7EBA2CEE9CCEF2613FE8B5A9CD2C850B325DCF8AA9FADA38E22D8BD55F2644`。最終重新打包後再次執行 Todo UI 驗收通過。提醒未開工，未推送遠端，未修改 `D:/I-harness-main`；使用者原有的 `packages/desktop/electron.vite.config.ts` 修改保留並排除於提交。

## 介面工作清單

[24 項 Desktop 介面缺口清單](2026-10-01-desktop-ui-gap-checklist.md) 已完成，標出目前實際入口、後端需求及先前延後項目。本輪只新增使用者指定的 ZCode 風格 Todo 進度卡，不自動實作整張清單。

提醒仍按使用者指示先放著。舊 Anthropic 測試紀錄遷移、帳號 OAuth／usage、快捷鍵／資料統計、Agent 瀏覽器控制及公開發行等先前範圍決定保留。
