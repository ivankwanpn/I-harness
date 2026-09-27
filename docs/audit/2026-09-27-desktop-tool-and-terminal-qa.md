# Desktop 工具與終端驗收（2026-09-27）

範圍：`D:\frontend-test` 的 Desktop 分支；真實模型測試只在 `D:\agent-complete\playground`。參考樹 ZCode 與 DSH 只讀。以下把真實模型呼叫、程式測試和未驗證項目分開記錄。

## 真實 DeepSeek Max 工具流程

打包版 Electron 透過已配置的 DeepSeek Anthropic 相容路由執行七組 playground 任務，合計 **34 個 `tool/call`、34 個配對 `tool/result`**。每組有 `turn/end`、輸入框清空；沒有協議 400 或孤立工具結果。

| 會話 | 實際工具 | 觀察 |
| --- | --- | --- |
| `sess-mujwhcnm-fh9khw` | `list_dir`, `read`, `tool_search`×2, `glob`, `grep`, `get_context_remaining`, `todo_write`×2, `memory_list`, `session_search`, `schedule_list`, `list_agents`, `job_list` | 14 次呼叫均配對；待辦有兩筆 durable 更新。`memory_list` 明確回 `memory_disabled`，不是空結果。 |
| `sess-mujwiz8r-ee24e4` | `read_image`, `list_dir` | 讀取 512×512 紅色 PNG，模型續傳並辨識紅色；圖片工具結果在 UI 展開時顯示縮圖和大小，不渲染 base64 文字。 |
| `sess-mujwjkz1-n4qq04` | `list_dir`, `write`, `edit`, `apply_patch`, `read`, `pwsh`, `read` | 唯一測試檔依序變為 `初始測試`、`編輯測試`、`補丁測試`；磁碟重讀確認。PowerShell `Get-Location` 指向 playground。測試檔已清除。 |
| `sess-mujx54zk-cb4mp4` | `read`×2 | 第一筆預期的 `ENOENT` 有 `isError`，第二筆 `sample.txt` 仍成功。新版時間線將前者標為「執行失敗」。 |
| `sess-mujxg92h-mplh6x` | `terminal_list`, `terminal_open`, `terminal_read`, `terminal_close`, `terminal_list` | 裸命令 `pwsh` 開啟成功，讀到 `D:\agent-complete\playground`；關閉後列表為空。 |
| `sess-mujxj417-8yalhp` | `tool_search`, `glob`, `list_dir` | 打包版 `glob` 結果不含 `node_modules`，路徑使用 `/`。 |
| `sess-mujxjzaf-btj2xc` | `bash` | Rtools/MSYS Bash 的 `pwd -W` 回 `D:/agent-complete/playground`、退出碼 0。 |

## 找到並修正的問題

1. `glob` 的 100 筆上限會被 playground 內的 `node_modules` 佔據，Windows 路徑也混用 `\`。`glob` 與 `grep` 現預設排除依賴樹並輸出 `/` 路徑；明確把搜尋根設在該樹內仍可搜尋。審查補測發現 `grep` 最初仍誤排除明確指定的路徑，現已修正。
2. `read_image` 的完整 base64 原本會在工具詳情中序列化成文字。現只在展開時顯示縮圖和精簡 metadata；原始工具結果仍留在 durable 事件中供模型續傳。
3. 工具回傳失敗原本顯示中性的「已收到結果」。時間線現保留 durable `isError` 與獨立的 `resultReceived`，並識別 `{error}`、`{ok:false}` 及非零 shell `exitCode`；即使失敗結果的 output 為 `undefined`，也不再顯示為等待中。
4. Windows `System32\bash.exe` 是 WSL 啟動器，原先會搶在實際可用的 Rtools Bash 前。Bash 偵測現略過 WSL 啟動器並把所選 shell 的完整路徑交給執行服務。
5. Windows ConPTY 在此環境無法以裸命令 `pwsh` 啟動，即使程式在 PATH。Terminal service 現先解析 PATH，`terminal_open`／`process_spawn` 共用這個入口。修正前的真實會話 `sess-mujx5jpx-s65ga6` 先收到 `File not found`；修正後上述終端會話完整通過。

## 內建終端 Shell 設定

ZCode 的 `integratedTerminalShells.ts` 與設定頁採用已發現的 shell 選項；DSH 的 `terminal-controller/src/shells.ts` 由執行環境驗證可執行檔，再保存使用者選擇。I-harness 現在把選擇保存在 Desktop 本機偏好，設定頁從 gateway 讀取可用選項，開新終端時由主程序傳入保存的 ID，再由 gateway 重新解析可執行檔。Renderer 傳入的任意 `command` 不會被執行。

Windows 選項為 Auto、Git Bash、Bash (PATH)、PowerShell 7、Windows PowerShell、CMD（只列出已安裝者）；Git Bash 可由常見安裝路徑或 PATH 中的 `git.exe` 推導。Bash (PATH) 可選 Rtools／MSYS 的原生 Bash，略過 System32 和 WindowsApps 的 WSL 啟動器。Auto 保留本產品既有的 Windows PowerShell 優先順序。Unix 讀取 `SHELL` 作 Auto，並列出 PATH 中的 bash/zsh/sh。選擇只影響**新開的內建終端**；已開終端維持原 shell。Agent 的明確 `bash` 與 `pwsh` 工具語義保持獨立。

Electron 畫面驗收中，選 Git Bash 後，新的 user terminal 使用 `C:\Program Files\Git\bin\bash.exe`；選 Bash (PATH) 後則使用 `C:\rtools44\usr\bin\bash.exe`。兩者在 playground 執行 `pwd` 都指向正確工作區。已關閉測試終端並還原原本的 Auto 偏好。畫面：`D:\frontend-research\desktop-shell-settings-git-bash-2026-09-27.png`、`D:\frontend-research\desktop-shell-settings-bash-2026-09-27.png`。

這輪建立的八個 playground 驗收會話已封存（仍可還原及檢查 durable 記錄），不佔用日常側欄。最終便攜包為 `D:\frontend-test\packages\desktop\release\I-harness-Desktop-0.1.0.zip`，SHA-256 `E4A34CD78EAC197783146393E10829715E48BF9BB4FBB7C3ED499A13EBCA5CB4`。

## 驗證邊界

- 降低 PNPM 工作區並行度後，審查修正後的完整套件測試：70/70 專案、3598 通過、9 跳過、0 失敗。全庫 `pnpm typecheck`、E2E 5 檔 12 項與 reachability gate 通過。日誌在 `D:\frontend-research\desktop-tool-shell-review-*-2026-09-27.log`。
- MCP、LSP、subagent 派生、workflow、schedule 建立／刪除等路徑有各自的本地／E2E 套件測試，這輪沒有對外部服務做實際呼叫。記憶在目前 Desktop 設定中停用；網路工具無此輪可用的 web provider。不能由這些結果推稱所有外部工具服務已完成真實驗收。
- 圖片 byte array 仍在 durable admission 與 promoted user message 出現兩次；十張大圖的長會話記憶與檔案大小尚未量測或優化。
