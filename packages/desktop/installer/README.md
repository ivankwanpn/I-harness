# Windows Desktop 安裝版

安裝版將完整的 I-harness Desktop、Electron runtime 和 gateway 打包成單一 Setup EXE。使用者毋須另裝 Node.js，也毋須系統管理員權限。

預設安裝位置為 `%LOCALAPPDATA%\Programs\I-harness Desktop`。安裝後會建立目前使用者的桌面捷徑、開始功能表捷徑，以及 Windows「已安裝的應用程式」移除項目。介面包含英文和繁體中文。

## 建置

先產生可攜版，再使用 [NSIS 3 的官方工具](https://nsis.sourceforge.io/Download) 編譯。`--nsis` 接受解壓縮後的 `makensis.exe` 完整路徑，亦可透過 `IH_NSIS_MAKENSIS` 或 PATH 指定。工具會讀取編譯器版本，並將編譯器和輸出 EXE 的 SHA-256 寫入建置紀錄。

```powershell
pnpm --filter @i-harness/desktop dist
pnpm --filter @i-harness/desktop installer -- --nsis 'C:\tools\nsis\makensis.exe'
```

預設輸入為 `packages/desktop/release/I-harness Desktop`，預設輸出位於 `packages/desktop/release/`：

- `I-harness-Desktop-Setup-0.1.0.exe`
- `I-harness-Desktop-Setup-0.1.0.exe.sha256`
- `I-harness-Desktop-Setup-0.1.0.installer-build.json`

也可以明確指定既有 payload 和輸出目錄，兩者都必須是完整路徑：

```powershell
pnpm --filter @i-harness/desktop installer -- `
  --app-dir 'D:\artifacts\I-harness Desktop' `
  --out-dir 'D:\artifacts' `
  --nsis 'C:\tools\nsis\makensis.exe'
```

`--validate-only` 會檢查版本、Windows EXE、Electron runtime、renderer/preload、附件 worker、gateway entry point 和必要依賴，然後輸出摘要。payload 內的連結、junction、缺少的必要檔案及版本不符都會使建置失敗。

建置暫存檔和 NSIS compile log 存放於忽略追蹤的 `build/desktop-installer/<build-id>/`。建置不會刪除或移動輸入的可攜版。

## 更新及移除

下載新版 Setup 並在關閉 Desktop 後執行，會更新同一個安裝目錄。安裝程式會驗證既有安裝的 ownership marker，執行上一版的移除程式，按上一版實際安裝的檔案清單移除舊 payload，再複製新版。這會清理新版已不使用的 gateway 和 resource 檔案。

執行中的 Desktop 或 gateway 會阻止更新及移除；使用者需先自行關閉程式。安裝程式不會終止使用中的程式。自訂安裝目錄的最後一層必須命名為 `I-harness Desktop`；drive root、帶有 junction 的路徑，以及沒有對應 ownership marker 的非空目錄會被拒絕。

移除程式只刪除該安裝版列出的檔案及其捷徑，資料夾只在空白時移除。AppData 內的設定、工作區、對話資料和 credentials 會保留；安裝目錄內其他檔案也會保留。

更新的 payload 複製程序沒有自動 rollback。若磁碟或權限問題導致複製中斷，可先執行該目錄內的 `Uninstall.exe`，然後重新安裝。此版本的 Setup 和 Desktop EXE 沒有 code signing，亦沒有自動更新服務。

## 隔離的安裝測試

以下測試會在 repository 的 `.tmp/desktop-installer-smoke-<id>/` 建立帶有唯一 ownership token 的測試環境，並編譯名稱帶 `-test` 的 installer。測試版本只在該環境內寫入 payload 和捷徑，沒有 Windows uninstall registry 操作。

```powershell
pnpm --filter @i-harness/desktop test -- test/installer-builder.test.ts
pnpm --filter @i-harness/desktop installer:test -- `
  --app-dir 'D:\artifacts\I-harness Desktop' `
  --nsis 'C:\tools\nsis\makensis.exe'
```

測試會實際執行新安裝、更新、使用已安裝 Electron 載入 shipped backend、執行中程式的更新及移除拒絕，以及正常移除。它亦檢查過期的 resource 檔案被清理、其他檔案與資料仍然存在，以及所有測試啟動的 Desktop process 已停止。

測試紀錄保存在 `.superpowers/sdd/2026-10-04-desktop-installer/`。測試 installer 不應當作正式發行檔；正式 asset 使用沒有 `-test` 後綴的 Setup EXE。

NSIS 的[命令列文件](https://nsis.sourceforge.io/Docs/Chapter3.html)要求 `/D=` 必須放在最後且不加引號，即使目錄包含空格；自動化測試會依照這個格式傳送完整路徑。
