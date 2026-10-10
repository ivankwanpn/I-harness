# WSL2 執行環境

本功能目前位於 `codex/wsl2-sandbox-experiment` 開發分支。它讓 Windows 上的
I-harness 使用指定 WSL2 發行版中的 Linux Bash 執行 Agent 命令，並透過
bubblewrap 套用檔案、網路及程序範圍。

## Desktop 設定

在「設定 → 執行與上下文」選擇 **Windows 執行後端 → WSL2 Linux**，再選擇
已安裝的 WSL2 發行版。使用「診斷 WSL」查看實際環境；WSL1 無法選取。
發行版需要系統 Python3、`/bin/bash` 及 bubblewrap。缺少這些依賴時，診斷會
顯示原因與處理指引。IH 不會自動執行系統套件安裝。

核準政策、沙箱範圍和網頁存取分別設定：

| 控制項 | 行為 |
| --- | --- |
| 唯讀 | Linux 命令可讀取檔案，無法修改專案檔案。 |
| 可寫入工作區 | 只允許修改目前授權的專案根目錄；參考目錄保持唯讀。 |
| 完整存取 | 允許目前 Linux 使用者修改工作區外的檔案；存在唯讀參考鎖時會拒絕執行。 |
| 命令網路存取 | 唯讀與工作區寫入預設關閉，可明確開啟；完整存取允許連線。 |
| 工作區依賴 | 使用 IH 管理的 Linux Node/npm；缺少時可下載固定版本，也可明確修復。 |

新的後端、發行版、依賴與網頁設定由**新組裝的會話**採用。既有會話執行環境
保留捕獲的設定；頁面另列出其實際後端。沙箱與核準政策會在下一次工具呼叫
重新檢查目前權限。

## 網頁存取

| 選項 | 行為 |
| --- | --- |
| 已停用 | 不提供網頁工具。 |
| 快取 | 只讀取 IH 本機已保存的網頁或搜尋結果，未命中時回報原因。 |
| 已索引 | 使用已設定的搜尋提供者；只允許抓取當前執行環境搜尋結果中的網址，轉址也需要在此範圍內。 |
| 即時 | 可直接抓取 HTTP/HTTPS 網頁；搜尋仍需要實際配置的提供者。 |

IH 不提供 OpenAI 維護的搜尋索引。沒有搜尋提供者時，`websearch` 不會出現。
網頁工具的存取模式與 shell 的命令網路權限分開運作。新設定預設為快取；既有
設定檔省略此欄位時保留原有即時抓取行為。

## 工作區依賴

IH 的依賴管理下載固定的官方 Linux Node **22.23.3**，包含 npm **10.9.9**，
並檢查固定 SHA-256、archive 路徑與格式。只提取普通檔案，使用獨立版本目錄
和原子替換；執行期間把所選依賴目錄掛載為唯讀。診斷會檢查現有內容，損壞的
快取需要修復，並顯示具體原因。

系統已有 Node/npm 時可以使用系統工具。停用工作區依賴後，IH 不進行管理式
下載或安裝；可用工具取決於所選發行版。Windows 的 `node.exe`、`npm.cmd`
和專案中的 Windows 原生模組不會轉成 Linux 工具。專案若需要 Linux 原生模組，
應在所選環境安裝相應版本。

## CLI

```powershell
node dist/ih.mjs run "檢查專案並執行測試" `
  --windows-sandbox wsl `
  --wsl-distribution Ubuntu `
  --sandbox workspace-write `
  --wsl-network deny `
  --wsl-workspace-dependencies true
```

CLI 的 run、SDK 與 ACP 都採用保存的設定。run 的明確旗標優先於環境變數與
保存值；旗標不會改寫設定檔。WSL 選項亦可透過 `IH_WINDOWS_SANDBOX`、
`IH_WSL_DISTRIBUTION`、`IH_WSL_NETWORK` 和 `IH_WSL_WORKSPACE_DEPENDENCIES`
提供。Agent 的 Bash、Agent Shell、Code Mode 和子代理使用捕獲的 Linux
執行環境；檔案工具仍使用 Windows 專案路徑。原生 Windows 工具使用其對應後端。

## 支援範圍

- WSL 命令使用 pipe 和完整程序樹生命週期。背景工作與取消可用；WSL PTY
  與保留獨立後代的 transport 尚未提供。
- 每次命令準備與啟動前都會重新檢查寫入根目錄、參考目錄及依賴目錄。外部
  hardlink、重疊根目錄、未支援的掛載配置或權限撤銷會拒絕執行。
- 大型 Windows 磁碟專案的檢查可能較慢。本機 Desktop 專案的 19,270 個項目、
  3,027 個目錄，準備為 23.30 秒，啟動前再次驗證為 22.62 秒。這個結果不代表
  其他磁碟或同時修改中的專案也有相同耗時。

驗證範圍與候選版見 [WSL2 功能驗收紀錄](audit/2026-10-09-wsl2-product-acceptance.md)。
