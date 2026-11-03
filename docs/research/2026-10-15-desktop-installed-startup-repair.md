# 2026-10-15：已安裝 Desktop 無法啟動的修復

**後續會話修復：最新的 `session-fix` 安裝包包含本報告的啟動修復，並處理兩個舊會話在壓縮後因工具／結果分組錯誤而出現的 HTTP400。** 見[壓縮後工具回合修復與驗證](2026-10-15-compacted-tool-http400-repair.md)。本報告保留來源fd4d及原startup-fix產物的歷史紀錄。

使用者安裝上一份 RC1 後，主程序拋出 `ERR_MODULE_NOT_FOUND`，找不到 `@i-harness/usage-stats`。修復來源為 `fd4d9b5f47f028e2fa7c9799250a30d396239b6d`；新的打包程式已實際顯示介面、啟動內建 gateway，並正常退出。新的安裝器已完成實際 NSIS 編譯與獨立 PE／SHA-256 檢查。這些結果只涵蓋本次啟動修復；[先前完整候選驗證](2026-10-15-candidate-qualification.md)的四項失敗保留，沒有把整體資格改為通過。

## 原因與修復範圍

唯讀核對顯示，使用者已安裝主程序與原交付 payload 的主程序相同：299,332 bytes，SHA-256 `739117d3740bf8ab048b7b23b2e78e8f9ea0c79a9d7211909b3beb8863d31b7f`。原主程序還會直接匯入 `@i-harness/desktop-gateway/src/context-diagnostics.ts`；兩者均沒有放在應用程式的 node_modules 下。

`electron.vite.config.ts` 原本只將 SDK 與 fs-search 的 workspace 原始碼納入 bundle。修復沿用相同邊界，增加 usage-stats 與 desktop-gateway 兩個既有 owner。Electron、Node builtins 及 Koffi 的既有外部載入方式保留。沒有改版本、依賴版本、原生政策或使用者已安裝檔案。

新增的回歸從真正的 production electron-vite 設定建置主程序，將產物與實際 Koffi 放入 OS-temp 的獨立 shipped layout，再核對全部 emitted chunks 的 static／literal dynamic imports。它清除 NODE_PATH／NODE_OPTIONS，沒有 workspace links；Electron 作為內建模組處理，其餘檔案必須在 shipped layout 中解析。修復前 RED 同時呈現兩個缺少的 owner，修復後 GREEN 通過。獨立來源審查為 spec PASS／quality PASS，沒有待修正項目。

## 實際驗證

| 檢查 | 本次結果 |
| --- | --- |
| 真實 bundle 回歸 | 修復前 exit1；修復後 exit0。 |
| 聚焦 Desktop 回歸 | 5 files、72 tests 通過。 |
| 完整 Desktop 測試 | exit0；185 files 通過／1 skipped；1,408 tests 通過／3 skipped。 |
| Desktop types／production build | 兩者 exit0。 |
| 實際 portable 打包 | exit0；新 payload 與 build 的 main／attachment worker／preload 雜湊逐一相符。 |
| 實際 packaged executable 啟動 | 2026-10-15T07:26:41.258Z–2026-10-15T07:26:48.957Z；正常退出0。 |
| 真實介面及 bridge | 從新 payload 的 file URL 載入繁體中文介面；about 回傳 RC1、packaged=true、Electron44.4.5、Node24.21.0；renderer 無 Node require／process，bridge 為 frozen。 |
| 內建 gateway | 公開 bridge 的 provider-directory RPC 成功；空白隔離設定回傳0個 provider，gateway session 位於指定 QA profile。 |
| 關閉及錯誤 | 透過公開視窗 close RPC 正常退出0、偏好設定寫入隔離 profile；CDP 連接後收集的 page／console／request errors 均為空，沒有強制清除測試程序。 |
| 實際 NSIS | v3.11，編譯 exit0；正式 payload，isolatedTest=false；獨立 PE 數字版本0.1.13.0，File／Product 字串版本0.1.13-rc.1。 |

啟動測試直接執行新 payload 的 I-harness.exe。沒有注入 Electron loader、CJS bootstrap 或 Node inspector；僅連到本次程序的 Chromium renderer CDP。使用全新 IH_CONFIG_DIR、user-data-dir、HOME／USERPROFILE 和空白配置，移除憑證環境變數。啟動截圖已目視檢查。使用者已安裝程式、真實設定、會話及原有崩潰程序均未修改。

早期啟動探測沒有成功，相關失敗收據保留。其原因是測試用 USERPROFILE 缺少 Windows 的 AppData/Roaming 與 AppData/Local known-folder 目錄；精簡 CJS 診斷入口捕捉到同一份 shipped main 在讀取 appData 時失敗。只建立這些隔離目錄後，同一份 main 匯入和正常打包啟動均通過。這是驗證環境修正，沒有追加產品修補，也沒有把較早失敗改寫為成功。

gateway 沿用來源15563d70的已受控 smoke 驗證 runtime；本次封裝的全部8,550檔、332,762,658 bytes，與原 runtime／handoff 逐檔相同，最終產物檢查再次核對所有檔案。Desktop 的2204個產品路徑與來源fd4d逐檔相同，scopeVersion2 canonical manifest 為 `ec2550b213941ffd68bceb1ed767512273cf08684c69e57924ab150445db7776`。本次 shipped main 為303,167 bytes，SHA-256 `00e42970383cb98bbaf8185b06dfd095ac8beb053d19261455fb03b11a901200`。

## 替代安裝包

| 檔案 | Bytes | SHA-256 |
| --- | ---: | --- |
| `I-harness-Setup-0.1.13-rc.1-startup-fix.exe` | 188524669 | `5e238a10f912c3ae7e58b34c4a5a93d3926b6c4377befa90d743d07645b6e0e1` |

本機位置：`packages/desktop/release-rc1-startup-fix-20261015/I-harness-Setup-0.1.13-rc.1-startup-fix.exe`。同目錄保留 `startup-fix-manifest.json`、installer-build metadata 及 checksum。此檔是新編譯成功的正式安裝器副本，副本與 compiler metadata 的 bytes／SHA 相同。原先188,427,746-byte、SHA `3ca3b9ca3fe27437c0b0f54fd462904c8d1e0299de94a5be29461444c1852e18` 的安裝包已知無法啟動，只保留為歷史證據。

未在使用者的實際安裝目錄執行安裝或移除，故沒有宣稱完整安裝／升級生命週期已通過。沒有使用真實模型帳戶。先前來源15563d70完整 `pnpm verify:all` 仍為exit1、7,401 pass／45 skipped／4 failed；本次沒有重跑整體門檻，也沒有放寬兩項 PSEC 錯誤及兩項既有五秒 deadline。此修復不改變未公開 draft／未合併狀態。

## 本次決策與證據

Ruling：透過既有 bundling 邊界修復兩個已證實遺漏的 workspace owner，維持 RC1 並使用有明確 startup-fix 後綴的新檔名，重用逐檔相同的 gateway。依據是兩個 import 均未交付、現有 SDK/fs-search 已採此做法、installer 允許相同版本修復；代價是使用者仍須分辨同版本的新舊包，且實際安裝生命週期沒有被本次隔離啟動取代。故交付前要求真正 packaged executable 啟動、gateway、正常關閉及實際 NSIS 編譯，而非只憑 build 成功。

本機完整證據位於 `.tmp/desktop-startup-fix-20261015`：`brief.md`、`installed-red-evidence.json`、RED/GREEN 與 Desktop suite/types/build logs、`review.md`、`product-freeze.json`、`final-product-proof.json`、`gateway-copy.json`、`packaged-main-assets.json`、全部早期啟動失敗與 controls、`packaged-startup-homedirs.json`、不可變的 QA startup-result／截圖、`installer.json`、實際 compiler compile.log、`final-artifact.json`。回復入口是同目錄 `RESUME.md`。私人原始 Session 不在本次證據或產物中。
