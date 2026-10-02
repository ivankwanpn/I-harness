# IH Code Mode 後端驗收 — 2026-10-03

## 範圍

使用者於 2026-10-02 確認新增 Code Mode，並要求依據 Codex 的做法在 IH 重新設計。參考為 `D:/agent-complete/codex-rust-v0.160.0`；工作位於 `D:/frontend-test` 的 `codex/desktop-workbench`。設計採用 Codex 的隔離 cell、exec/wait、工具代理、輸出選擇與生命週期，整合 IH 既有工具與會話，不新增 DSH Agent 預設 UI。

設計／計畫：[設計](../superpowers/specs/2026-10-02-code-mode-design.md)、[實作計畫](../superpowers/plans/2026-10-02-code-mode.md)。

## 已交付

| 能力 | 實際行為 |
| --- | --- |
| `code_exec` | 執行 JavaScript ES module，支援 top-level await；每個 cell 為新的 QuickJS/WASM context 和 Node worker |
| `code_wait` | 依 cell ID 讀取新輸出、接續等待或終止；自然完成與終止競態、單一 observer 有回歸 |
| `tools`／`ALL_TOOLS` | 當前會話／角色的 direct 和 deferred 工具；不提供 hidden 或遞迴的 exec/wait；名稱別名碰撞拒絕 |
| 輸出 helpers | text、image、audio、notify、yield_control、exit；圖片沿用既有 images 投影，不重複塞入 base64 文字。音訊記錄為內容，但現有 text/image adapters 不提供音訊推論 |
| store/load | 成功完成的 cell 可提交有界 JSON store；同執行環境跨 cell 保留，globals 每個 cell 重新建立，重啟不恢復 store |
| 既有權限 | 巢狀呼叫經 prepare/dispatch/finalize、hooks、guardian／核准、沙箱、Plan Mode、角色 allowlist、timeout／spill |
| 並行 | 安全工具本體可以並行；exclusive 工具形成 barrier。prepare 按順序，finalize/hooks 在完成順序中串行 |
| 記錄 | code/cell、call、dispatch、result、output 保存於既有 session；dispatch 在本體執行前 flush，模型只收到 outer observation 和明確輸出 |
| 壓縮 | 活躍 cell 與 store 屬於執行 owner；壓縮不清掉。wait 的有界說明列出目前活躍 ID，壓縮後仍可找到 |
| 生命周期 | cancel/dispose 取消 worker、排隊呼叫及在途操作，等待 producer drain；interrupt 仍可續派，close 阻止排隊工作再啟動 |
| 主機 | CLI、SDK／ACP、Desktop Gateway、一般／Team／resident 子代理；子代理重新掛載自己的工具範圍，不繼承父 wrapper |
| token 計算 | inference schemas、輸出 cap 與 compaction 使用同一個即時 system/tool overhead，目錄改變不重建 compactor |

隔離引擎為 `quickjs-emscripten 0.32.0`，參考其[官方專案文件](https://github.com/justjake/quickjs-emscripten)。它取代了直接引入 Codex Rust/V8 host 的部署依賴。沒有使用 Node `vm` 作為安全邊界。CPU、heap、source、IPC、store、output 與 pending/active 數量限制有實際 WASM 回歸；CPU計算排除 idle tool/timer 等待。沒有固定 Goal 回合／步數上限。

## 如何開啟

既有設定預設 `off`，保留原有直接工具面。`mixed` 同時提供直接工具及 Code Mode；`only` 的模型工具面為 `code_exec`／`code_wait`，實際 registry 保留供巢狀使用。

將以下欄位合併到既有 settings.json；不覆蓋其他提供商或使用者設定：

```json
{
  "codeMode": { "mode": "mixed" }
}
```

只用 Code Mode 時改成 `"only"`。CLI 的 `--code-mode off|mixed|only` 可覆寫本次主機設定；不合法值會拒絕。程式化主機使用 AssemblyOptions.codeMode。設定在建立 assembly/runtime 時採用，不更換已執行中的 cell。

模型呼叫介面：

```js
code_exec({
  code: 'const rows = await Promise.all([tools.read({path:"README.md"}), tools.read({path:"package.json"})]); text(rows);',
  yield_time_ms: 1000,
  max_output_tokens: 1000
})
```

若回傳 running，使用 `code_wait({cell_id: "回傳的 ID", yield_time_ms: 1000})`，直到 terminal。觀察期限不是完成保證；worker 冷啟動亦可先 yield。

## 審查修復與驗證依據

實際 red→green 修復包括：guest／host 超長錯誤在 IPC 前有界、JSON helper intrinsic 捕獲、origin admission snapshot、checkpoint 後再次驗證撤銷的 binding、串行 post hooks、避免同一次呼叫寫入兩個結果、finalize／post-hook 拒絕不能被 guest catch 轉為成功、子代理 interrupt 後可再次續派，以及即時目錄的輸出／壓縮價格。

Code Mode 套件有 40 項測試（29 runtime、7 broker、4 mount）；核心 worker 測試為實際 WASM，沒有替換 interpreter。主機、子代理、CLI、Gateway 使用實際 registry／fixture ModelClient 或受限本機 HTTP provider。最後獨立審查的已確認問題均完成 scoped re-review。

最初完整驗證發現兩個測試假設：從 observation deadline 推定模組已完成／工具已 admission。改為等待實際 closure 與 invoke barrier，沒有提高 runtime 限制或加入 sleep。另移除未被外部使用的 public type export。後續完整驗證發現既有側欄初次 mount 的 passive effect 清掉首次選單；可確定性重現，改成 layout phase 清理 scope，20 項選單／側欄測試通過。

## 實際便攜版驗收

完整凍結驗證：**4,109 通過、10 略過、0 失敗，71/71 專案**。所有型別檢查、5 個 E2E 檔案及 reachability 通過。Log：`D:/frontend-research/ih-code-mode-delivery-verify-2026-10-03.log`。

最終 `release-code-mode-final-2026-10-03` 的 Electron 便攜版複製到原始碼目錄外，使用隔離 workspace/config/userData 和 dummy credential；只連到本機 SSE fixture。2026-10-03 01:11（香港時間）完成最後一次驗收，15/15 項通過，14 個 loopback requests、0 remote provider calls：

- packaged executable/resources，以及 bundled worker 和 4 個 WASM payload 的存在／實際載入。
- 模型只看到 exec/wait；實際 list_dir/read 取得測試資料夾內容。
- 9 個 ambient API 不存在，node:fs dynamic import 拒絕。
- globals 每個 cell 全新；store/load 在成功完成後跨 cell 保留。
- 兩組巢狀 call/dispatch/result 有序保存，模型 history 不含額外巢狀 tool-use。
- incremental yield/wait、terminate。
- graceful restart 後保存 history 相同、store 清空、沒有自動 inference／nested replay，舊 cell wait 拒絕。

證據：`D:/frontend-research/ih-code-mode-packaged-qa-2026-10-03.mjs`、同名 `.log`、`-report.json`、`-captured-requests.json`、`-history-before-restart.json`、`-history-final.json` 和 `-session.png`。測試副本及狀態已按已驗證路徑清理。初次 QA 的 Windows NODE_OPTIONS 路徑及 runtime-context prompt 選取問題只修正測試腳本。

## 最終交付包

- [Desktop 執行檔](<D:/frontend-test/packages/desktop/release-code-mode-final-2026-10-03/I-harness Desktop/I-harness Desktop.exe>)
- [便攜版 ZIP](D:/frontend-test/packages/desktop/release-code-mode-final-2026-10-03/I-harness-Desktop-0.1.0.zip)
- 建置 log：`D:/frontend-research/ih-code-mode-final-build-2026-10-03.log`；gateway 隨包配送 201 個 runtime packages。
- 最終驗收的 `sourceApp` 指向上述 release 目錄，實際 worker SHA256 為 `f79735246375f740b100785b71b53a0214fbc1e883170bd0d5f272aee4aa8bfd`。
- ZIP SHA256：`998D49502DD80E89513072BB51FC35842C727E92D4AC9D5012511A141EB18634`。

## 實際限制

- 這輪未用付費提供商完成新的真實模型驗收；既有 adapters 透過 function schemas 接通，本機 provider 驗收不等於所有遠端服務已驗收。
- 重啟保留 log/config，不保留 live JS、promise、store 或 worker；不自動重跑已產生副作用的程式。Native smoke 為 graceful restart，open-cell crash／對抗資源情境由 source tests 覆蓋。
- 既有無持久化／無 child session ID 的 followup wakeup 限制未重新設計；session-backed ordinary／Team／resident 回歸已通過。
- 音訊 helper 可記錄，不新增模型音訊能力、語音或 UI。
- 既有工具本體和 output-spill 的限制仍有效，不能把已截斷的工具結果宣稱為完整資料。
- 未提供專用 Code Mode UI，設定由後端配置／CLI 控制。提醒及先前明確延後的工作未重啟。

使用者原有 `packages/desktop/electron.vite.config.ts` 修改保持未納入提交；沒有推送遠端或修改 main/reference。
