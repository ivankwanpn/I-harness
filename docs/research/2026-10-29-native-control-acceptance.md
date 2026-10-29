# 原生背景工作取消：整合驗收範圍

本機主線已整合原生背景工作的精確取消接口，產品提交 `cd80a914b33b7032b80ff93fbb9987e62f66c7c9`。這份驗收只涵蓋取消身份、路由與權限邊界，冷讀取、介面、整個 J4 和版本交付仍須後續接合。

註冊工具採 `job_instance_id`／`source_id`，原始服務採 `jobInstanceId`。真正的 `createScopedExec` 保留服務的 checked-kill 能力；明確指定 shell 的取消不會落到同 ID 的子代理或工作流程。取消及其非同步收尾前後都核對原始工作、來源、capture 與權限。沒有 selector 的既有路由保留。缺少 backend 卻攜帶 native selector 會以既定 `unsupported-selector` 拒絕。

最初的 raw-factory WeakSet 會拒絕真正的 scoped wrapper，已在整合前修正。獨立審查也核對最終 guard 的實際位置；最後一項診斷格式差異再經另一位審查者確認關閉。歷史中間提交不單獨代表最終行為。

## 審查與整合

- 受審最終控制來源為 NATIVE `e67850cc..2e8f97a3`，最後診斷修正為 `59abcea1..12a7e38d`。`59abcea1` 的未完成 saved decoder 不屬於此次整合。
- MAIN 依序整合 `85e86a64`、`db823539`、`f81d3ef4`、`d5b29151`、`cd80a914`。七個最終改動的產品／測試檔案與受審來源完全相同，限定 `git diff --exit-code` 與 whitespace 檢查通過。
- 原生服務與真正 scoped 註冊工具控制均有實際工作：錯誤或過期 instance 不會取消新工作，同 ID 子任務保持獨立。權限在等待期間失效時拒絕舊結果。已發出的真正 cancel 無法撤銷；最終回傳仍受檢查。

## 主線驗證

固定產品來源 `cd80a914`，依序執行；每次六個新隔離根目錄、直接既有 Node／Vitest／TypeScript，maxWorkers=2、minWorkers=1、無檔案並行。

| 範圍 | 結果 | 記錄的來源數量 |
|---|---:|---:|
| exec 的原生取消與既有執行控制 | 29 通過 | 34 |
| subagent 的真正 scoped 取消與 native outcomes | 18 通過 | 63 |
| exec 型別檢查 | exit 0 | 30 |
| subagent 型別檢查 | exit 0 | 58 |

四次執行的記錄來源皆在執行前後不變。來源清單是明列套件與額外檔案，不宣稱完整第三方傳遞閉包。初次 subagent 設定誤列不存在的 `packages/exec/src/native.ts`，runner 在啟動測試前拒絕；已修正清單後以新根目錄執行，沒有把設定失敗當作產品測試。

完整收據保留於 `.superpowers/sdd/2026-10-29-native-control-root/`：`root-exec-controls-71f20a9555dd4ce9b4d1e4a87c1c1db8`、`root-scoped-controls-corrected-manifest-8944147224eb48f0a9b9f24b6a239f95`、`root-exec-types-08ebb755f47e4d15bc3ffa280abcfec9`、`root-subagent-types-c21bcf4eb28845fe8d83d28f9e615277`。審查資料在 observation packet 的 `job-output-j4-control-repair-20261029.md`、`job-output-j4-control-rereview-20261029.md`、`job-output-j4-control-p3-review-20261029.md`。

沒有遠端推送、發佈或版本變更；目前仍 0.1.13-rc.1／Session13。
