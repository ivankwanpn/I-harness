# M45 — 打包/分發：build-dist（esbuild 捆包）+ NSIS 自包含安裝器（M44 全局命令的成品化）

日期：2026-09-05 · branch m45（自 main（含 m44）出）· 取捨（用戶）：**自包含**——安裝器帶 Node 官方 zip 運行時。

## 0. 目標

產出一個可安裝的 Windows 產物：`I-harness-Setup-<ver>.exe`（NSIS）——裝到 `Program Files\I-harness`，PATH 寫入，`i-harness`/`ih` 任意 cmd 可用，含卸載器。**無捆包的前置補齊**：一條 build-dist 管線。

## 1. M45a — build-dist（`scripts/build-dist.mjs`）

- 新 devDependency：`esbuild`（通用公開庫——構建工具；依賴原則允許，不進運行時）。
- 捆包：`apps/cli/src/index.ts` 入口 → `dist/ih.mjs`（format esm、platform node、target node22、bundle:true、define process.env.I_HARNESS_DIST=1）。
- **路徑適應**：捆內 `new URL(..., import.meta.url)` 的項目根解析失效——`apps/cli` + `apps/tui` 的根解析改為 `process.env.I_HARNESS_HOME ?? fileURLToPath(...)`（增量改動，源碼直跑路徑不變）。
- **native 外部化**：`external: ["node-pty","koffi","@vscode/ripgrep"]` + `dist/node_modules` 用 **pnpm deploy --prod** 產出（`build/dist-project/package.json` 宣告這三項在內的最小集合——原生二進製隨包走，win32-x64 預編譯）。
- 佈局：`dist/{ih.mjs, node_modules/, launcher.cmd?}`；入口 guard 的 CLI `bin` 內容。
- **smoke**：`node dist/ih.mjs --version` + `node dist/ih.mjs tui --help`（無 tty OK）+ `node dist/ih.mjs help`。
- CI 式驗證自動化為 `scripts/verify-dist.mjs`（上述三斷言）。

## 2. M45b — NSIS 安裝器（`installer/ih.nsi` + `scripts/build-installer.mjs`）

- `installer/ih.nsi`（NSIS 3.x 腳本）：
  - 安裝到 `$PROGRAMFILES64\I-harness`；File（dist/** + node/**）
  - **Node 運行時**：構建時下載 `node-v22.x-win-x64.zip`（官網）→ 解出 `node/node.exe`（+附帶 DLL 文件）；腳本拷 `node/**`
  - PATH：`AppendPath`（讀 `HKLM` PATH → 追加 `I-harness` → 回寫）；卸載器 `RemoveFromPath` + 註冊表清掃 + 卸載器自刪
  - 開始選單快捷方式（`I-harness.cmd`、`ih.cmd`、README）
  - `.cmd` = `"%~dp0node\node.exe" "%~dp0dist\ih.mjs" %*`（兩個命令名）
  - 卸載器：`WriteUninstaller`；版本頁/許可文本（MIT）
- `scripts/build-installer.mjs`：下載 makensis（便攜 zip——構建期工具；或檢測 PATH 存在）→ 調 `makensis /DVER=0.1.0 installer\ih.nsi` → `I-harness-Setup-0.1.0.exe`。
- **實測（本機）**：生成 exe → 靜默安裝到臨時目錄（`/S /D=<tmp>\I-harness`）→ 跑 `<tmp>\I-harness\ih.cmd --version` 與 `tui --help` → `/S` 卸載（自刪/註冊表預期行為）——**驗證腳本 `scripts/verify-installer.mjs`**。PATH 修改在測試模式跳過（`/D` + 腳本開關 `IH_NSIS_TEST=1` 不寫 PATH）。

## 3. 分組

- **G1（build-dist + 路徑適應 + smoke）**：source 微改（I_HARNESS_HOME）、scripts/build-dist.mjs、dist-project/pkg.json、verify-dist.mjs、esbuild devDep + 文檔。
- **G2（NSIS + 構建 + 實測）**：ih.nsi、build-installer.mjs、verify-installer.mjs、makensis/node zip 下載——依賴 G1 的 dist（次序：G1 後動）——實際跑出 Setup exe + 裝/卸 smock。
- **G3（docs）**：README「Distribution」節 + scripts/ 說明 + 產物路徑。

## 4. 硬規

- 源碼直跑路徑零破壞（I_HARNESS_HOME 缺省回退等價）；不合併已有依賴原則（esbuild 只進 devDeps；makensis/node zip = 構建期外部下載工具）。
- dist 為 gitignored 產物（產物不入庫；腳本/構建入庫）。
- verify 斷言全綠後才允許「產品化」聲明——**不用 mock 替換斷言**。
