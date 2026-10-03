# IH Desktop 前端打磨與操作介面驗收 — 2026-10-03

## 範圍與驗收狀態

工作位於 `D:/frontend-test`、分支 `codex/desktop-workbench`，起點 `293077e0`。使用者批准前端進度報告第二、三節並要求平行分派；介面沿用 DSH、ZCode 及使用者提供的 Codex 參考。這次涵蓋八組實作及其真實後端操作，不包含提醒與自動喚醒。

**交付狀態：八組功能、最後的核準選單介面、打包原生驗收及完整 gate 均已完成。** 最後獨立 `pnpm verify:all` 為 exit 0：**4322 passed、10 skipped、0 failed，71／71 專案全部回報**。最後使用者指定的介面為 `+` 旁顯示目前生效模式的盾牌按鈕與向上浮動選單；沙箱只在設定頁管理，主畫面沒有沙箱下拉選單或底部沙箱欄。所有測試／原生 owner 已停止，來源保存為本機提交 `e669335bb4db44b9809b272f8b8bdcd2f0411d8a`。

設計與計畫：[設計](../superpowers/specs/2026-10-03-desktop-front-polish-design.md)、[實作計畫](../superpowers/plans/2026-10-03-desktop-front-polish.md)。舊盤點：[2026-10-01 介面缺口](2026-10-01-desktop-ui-gap-checklist.md)。

## 已接通的八組功能

| 組別 | 使用者可操作的介面 | 後端與資料行為 |
| --- | --- | --- |
| A：輸入與導航 | 新任務與既有會話共用完整 Composer；單一新增附件入口；模型／推理預選；檔案與會話 `@` 上下文；`/` 鍵盤選取；`+` 旁核準模式盾牌／浮動選單；Goal／Plan／Team／工作／代審直達入口。 | 明確送出才建立會話。穩定建立及輸入識別值避免重試重複送入；確認持久化後才清理草稿。檔案／會話引用須通過目前專案與會話歸屬檢查。核準標籤／勾選使用 effective，請求只傳 approvalMode；沙箱由設定頁及既有後端政策管理。 |
| B：專案檔案與編輯 | 多資料夾檔案樹及搜尋、含資料夾身分的編輯分頁、第二根目錄工具跳轉、未儲存草稿、保存／保留／捨棄／取消、外部修改比較。 | 檔案身分是 `{workspaceId,path}`。保存檢查完整內容修訂，保留 CRLF／BOM；面板卸載及重啟保留未儲存草稿。來源／Git 操作仍使用其實際根目錄。 |
| C：會話歷史與管理 | 搜尋命中定位及歷史分頁、返回最新內容、批次封存／還原／移動、確認後永久刪除、逐項失敗回報與清理重試。 | 歷史瀏覽不改動即時 replay cursor。移動保存專案歸屬；保留原始儲存位置、預設執行資料夾及 rewind 根目錄，介面披露原執行資料夾。刪除只處理已知所屬紀錄／文件／未送出會話草稿；拒絕忙碌、待處理輸入／互動、子代理及活躍資源。 |
| D：全域設定與原生資訊 | 尚未開啟資料夾也可設定提供商／模型／憑證及探索模型；自動標題開關；通知記錄、已讀、返回會話與確認清空；About 版本／診斷複製。 | 與實際 gateway 共用持久化設定；全域配置不建立聊天。自動標題開關於下一次標題工作讀取。通知導覽重新確認目標有效且不是內部代理記錄；失效通知可保留查看。 |
| E：資源與記憶編輯 | 建立／編輯／匯入技能、編輯命令、來源及遮蔽狀態、複製插件內容至本機、確認移除、本機 Hook 設定及腳本編輯、筆記修訂及批次整理。 | 真實有效 registry 接收變更；插件來源唯讀。同名優先順序維持工作區、插件、全域。Hook 信任綁定設定與腳本完整內容；修改後需重新明確授權。筆記修改以 SQLite 交易更新內容及 FTS，修訂衝突保留草稿。 |
| F：附件與輸入草稿 | 統一選檔／貼上圖片；PDF、DOCX、XLSX、PPTX、ZIP 文字摘要、格式／大小／截斷提示；重啟恢復提示、圖片、文字及引用草稿。 | 解析器獨立打包、有限讀取，不執行內容、不解壓至專案。草稿儲存有配額、期限及 CAS；晚到的清理不能刪除新草稿。永久刪除使用可信退役標記，清理失敗回報並可重試。 |
| G：執行、環境與程序 | Code Mode 設定與生效狀態；程式／輸出／巢狀呼叫分頁及停止；工具／角色／執行檔診斷；Agent PTY／背景工作名單、輸出及有效 owner 的操作；歷史終端檢視。 | 模式變更供新建立的實際 mount 使用，既有 cell 保持其原模式。停止指定 cell 可以在模型等待觀察時完成。保存紀錄與已保存終端輸出唯讀；歷史 ID 不取得活躍程序權限，也不重放工作。 |
| H：記住核準規則 | 核準卡明確勾選記住、作用範圍／到期、規則列表／新增／撤銷、完整參數及不支援原因。 | 只接受可信人用回覆；冷恢復卡或子代理不能產生人用授權。匹配完整參數、實際工具／可執行檔身分及政策；準備與真正執行前重查撤銷／期限／綁定／guard。不透明 Shell 保持單次核準。 |

## 原盤點項目更新

以下為本次來源及入口狀態；完整驗證與原生驗收結果另列於後文。沒有把未列入設計的延伸功能標為完成。

| 原編號 | 本次狀態 | 對應操作及仍有的界限 |
| --- | --- | --- |
| U01–U04、U07 | 已接通 | `@`、草稿先行新任務、目前有效核準模式／浮動選單、鍵盤 `/`、工作流程直達入口；最新使用者決定把沙箱控制集中在設定頁。 |
| U05–U06、U20 | 已接通 | 多資料夾樹／搜尋／分頁、正確根目錄跳轉、未儲存草稿保護及修訂衝突。 |
| U08 | 既有獨立介面保留 | 子代理不混入普通會話；有效 live owner 可操作。冷啟動紀錄唯讀，尚無冷啟動重建續派。 |
| U09–U10 | 已接通 | 歷史命中定位／分頁、批次管理／移動／永久刪除。跨儲存草稿清理與重啟後精確重試已通過回歸及獨立覆核。 |
| U11–U12 | 已接通 | 工具／角色／執行檔診斷、實際 Agent PTY 控制、保存終端輸出檢視。歷史狀態不提供 live 控制。 |
| U13 | 輸出與程序操作已接通 | 提供可用的保存／live 輸出及有效 owner 的取消。完整 spill 搜尋／匯出與通用 process explorer 未列入本次設計。 |
| U14 | 既有基本 Git 保留 | diff、stage、unstage、commit；完整分支、stash、衝突及 worktree 管理仍未做。 |
| U15 | 已接通 | 記住核準卡、規則管理、作用範圍／到期／撤銷及真正執行前重查。 |
| U16、U22 | 已接通 | 技能／命令／Hook 本機編輯、SKILL.md 匯入、來源及插件複製、內容變更後重新信任。 |
| U17–U18 | 已接通 | 無資料夾提供商配置、五類附件讀取、持久未送出草稿。格式支援及配額界限明示。 |
| U19 | 開關已接通 | 下一次標題工作讀取啟用／停用；尚未提供獨立標題模型設定。 |
| U21、U24 | 已接通 | 不可用設定分類有原因；通知記錄／導覽／已讀／確認清空；真實 About 版本與診斷。 |
| U23 | 人用筆記編輯已接通 | 修訂檢查修改、FTS 交易及批次 forget；自動記憶生成仍未做。 |
| 新增 Code Mode 介面 | 已接通 | off／mixed／only 設定、有效狀態、程式／輸出／巢狀呼叫及指定 cell 停止。 |

## 最後覆核與修正

首輪完整覆核提出三個 P2，均已修正並通過最後聚焦覆核，沒有未處理的 P0／P1／P2：

1. **非同步專案歸屬更新迴圈**：歸屬載入依會話／工作區及重試識別更新，真實 deferred IPC 回覆只讀取一次並收斂至可送出狀態。
2. **永久刪除未清理未送出草稿**：可信 native 成功後退役精確草稿範圍；移除 prompt／context／metadata／圖片／文字／引用，拒絕晚到寫入；清理失敗明確顯示並提供精確重試。第二輪補上 gateway 刪除成功但 native 退役憑證尚未保存的中斷窗口。版本 2 JSONL 刪除憑證在 artifact 移除前保存最小 ID／origin／parent 及精確 manifest，不保留被刪除內容；fresh gateway＋store 可重試完成清理，且仍重查忙碌／有效 owner／子代理／子孫／write lease。
3. **歷史 PTY 沒有顯示保存紀錄**：從真正保存的 tool／code 事件組成有界紀錄及已捕獲輸出，經唯讀 snapshot 讀取，沒有重播、模型呼叫或 live 控制。

第二輪實際 native 整合 8 項、JSONL 刪除 6 項及聚焦會話管理 5 項通過；包含真正檔案系統造成的 native 憑證保存失敗與 crash-equivalent 窗口，重新啟動兩個 owner 後精確重試、晚到保存拒絕、兄弟／新任務草稿與來源檔案保留。完整整體結果另列於下節。

打包原生驗收揭露並修正：32px workflow header 裸文字重疊、本機有效命令漏出 `/` 清單、Windows cooked 人用 Enter LF／CR、冷背景工作漏讀真正 `{text,status}` DTO，以及 246,032,896-byte Electron 被 128 MiB 核準指紋上限拒絕。正確候選包已實際重查 icon／四個 handler、canonical command body、只靠人用介面的 cooked 行輸出、歷史完整 job snapshot，以及完整 H 勾選／真正讀取／重用／重啟／期限／撤銷／政策／綁定拒絕。Scope 覆核均 CLEAN。

窄畫面的 maximize／close 另被不縮小的操作列推出裁切區；縮小／捲動次級操作列後，真正 viewport、裁切祖先、hit test 及 minimize／maximize／restore／close 通過。外層沒有 horizontal overflow 不能代替這個檢查。

CPU 修正改用可用的目前 worker thread CPU，固定可信初始化獨立於 guest quota，guest evaluation／promise／timer／result callback 持續計量；完成前最後時計驗證失敗不能發布成功或 store writes。真正 CPU30 pause／初始化／時計錯誤與最後 read6 的 red→green 證據、同一 native runtime 的 sentinel／巢狀 FS → 無限 CPU 失敗 → 精確 `7` 恢復 → observer-safe stop → cold 零 replay／控制／byte mutation 已通過。使用者批准的 100 ms 是一個可靠性 fixture；正式預設仍為 1000 ms，專門反證仍為 30 ms。

最後核準選單在最初讀取未完成時，trigger Tab 曾讓晚到回覆搶回焦點。真正元件 red 重現後，trigger Tab 只關閉選單且保留原生 Tab；最後 37 項 UI 與獨立 10 項選單／picker 檢查通過，包含舊工作區回覆拒絕、busy／error、effective 對 saved 與焦點。原生候選包另核實實際模式、approvalMode-only DTO、full-access 的既有沙箱 coercion、Escape／outside／keyboard、主按鈕與設定頁沙箱。

先前 producer 覆核的執行 Hook 等待後權限重查，以及冷啟動檢視誤用可變 loader 問題，已通過具體回歸與聚焦覆核。草稿首次送出、持久化確認及較新模型選擇的覆核問題也已修正。

## 完整驗證

所有來源凍結、原生／fixture owner IDLE、root 看過最後實際畫面後，獨立執行 `pnpm verify:all`，**exit 0**。最後原始日誌：[完整 gate](D:/frontend-research/ih-desktop-front-polish-approval-menu-final-verify-2026-10-03.log)。

| 檢查 | 最終實際結果 |
| --- | --- |
| 全套測試 | **4322 passed、10 skipped、0 failed** |
| 專案母體 | 71／71 有 test script 的專案全部回報，包含 Desktop |
| 全套型別 | exit 0 |
| E2E | 5 檔、12 項通過、exit 0 |
| Reachability | 421 列、無新增未接通列、gate PASS；兩個既有 inert allowlist 警告不豁免任何活躍列 |
| Desktop | 592 項通過；Gateway 246 項通過，兩者均在完整母體內 |
| 覆核 | 最終各 producer／round 1–10、打包指紋、CPU／Composer 與核準選單範圍無未處理 P0／P1／P2 |

早期失敗與中止日誌保留以交代修正原因，不作為最終驗收。具體 Code Mode 設計錯誤及三份 Desktop 舊 fixture 修正另見 [設計分析](2026-10-03-desktop-design-analysis.md)。工具執行／Hook／冷查詢／持久化／異步歸屬都有具體行為回歸，測試總數本身不保證所有產品情境都已覆蓋。

較早 4298 全綠只是最後 native 修正之前的紀錄。後續 CPU plain error 的 61／71、子代理 fixture 的 70／71，以及其他 failed／中止紀錄全部保留，均不作為最後母體結果。子代理 fixture 補上真正共享 registry 的 owner wait、精確 final1–4／job completed 及 flush 屏障，保留原 15 秒 case 與 1 秒語義觀察；原完整 timeout 的確切 stalled stage 未捕獲，不宣稱修復 production 子代理缺陷。提交前僅移除新 trusted-human test 的一行空白 EOF；沒有改變測試／產品行為或打包 bytes，沒有為此重跑廣泛測試。

## 打包後原生操作

最後 `pnpm --filter @i-harness/desktop dist` **exit 0**；附件 worker、PDF.js CMaps／字型／WASM／canvas、201 個 gateway 套件與新 CPU helper 一併打包。最後包位於 `D:/frontend-test/packages/desktop/release-front-polish-approval-ux-2026-10-03`，實際外部複製執行位於 owned `app-approval`。測試採專用設定／userData／資料夾／假憑證及 loopback 傳輸，原始使用者應用、會話、憑證與剪貼簿保留。

| 產物 | 大小／SHA256 |
| --- | --- |
| [I-harness Desktop.exe](<D:/frontend-test/packages/desktop/release-front-polish-approval-ux-2026-10-03/I-harness Desktop/I-harness Desktop.exe>) | 246032896 bytes；`BD14928E0728366FD3F41499CB398FF3F4304DAB259A3E605077899A6F8C748E` |
| [完整 portable ZIP](D:/frontend-test/packages/desktop/release-front-polish-approval-ux-2026-10-03/I-harness-Desktop-0.1.0.zip) | 211634801 bytes；`811DF19BACA92528DCA47D5D1A61C7034AD09BF8B5D7812F3119473769E119E2` |

Build 日誌：[最後 build](D:/frontend-research/ih-desktop-front-polish-approval-ux-build-2026-10-03.log)。EXE 是 Electron 宿主，需保留相鄰 resources；EXE hash 單獨不能代表全部 app／gateway。新 helper／worker 位於 `resources/gateway/node_modules/@i-harness/code-mode/src`，SHA256 為 `A7D876FC24D9D70016F60E69CCE4D453F9AE976AE45A7DB904B4A6C644194254`／`B07EFCF24423F9552ECFD7FBC375786043D2087C1A210D1E6DFC70445862A8CF`，實際 native Worker 已從該路徑載入。

原生結果由保存的原始矩陣與有完整 payload 對比的修正範圍組成；沒有把多次操作稱作同一包的一次 A–H 測試：

| 原生範圍 | 真正重查 | Loopback |
| --- | --- | --- |
| 原始副本 | A/B/C/F、D、E/G 未改 producer；保存缺陷證據 | 47 |
| 修正 producer 候選 | header／canonical slash／cooked Enter／cold job／完整 H | 25 |
| 視窗控制 CSS 候選 | 寬／窄／restore 3 control bounds、hit test、實際 window actions／toolbar | 0 |
| CPU 與先前 Composer 候選 | 同一 runtime CPU／sentinel／nested FS／恢復／停止／cold；含保留的 5-request fixture attempt | 15 |
| 最後核準選單 | popup／模式／actual DTO／設定／keyboard／newdraft／Send-Stop／toolbar；成功 1、保留 failed fixture 2 | 3 |

合計 **90 loopback，0 remote、0 blocked remote attempts、0 renderer／console／provider errors**；這是分段紀錄的總數。最終 narrow **682×982**、wide **1502×982** 是實際 DOM viewport，圖片顯示縮放尺寸不作 native 尺寸。最後 UI 比較涵蓋 7762 union paths、7755 unchanged、7 renderer entries；所有 CPU／指紋／agent-settings／main/preload／reader／WASM bytes 相同。初始-read/trigger-Tab及 saved/effective 不同步以真正元件測試覆蓋；未捏造 native 延遲或不一致回覆。原生確實驗證 ordinary keyboard／focus、實際當前狀態與 actor 回覆。

機器證據：[A–H 組合紀錄](D:/frontend-research/ih-front-polish-native-qa-2026-10-03-final-aggregate.json)、[CPU 重查](D:/frontend-research/ih-delivery-cpu-native-qa-2026-10-03-accepted-report.json)、[最後 UI aggregate](D:/frontend-research/ih-approval-menu-native-qa-2026-10-03-aggregate.json)、[最後 payload 對比](D:/frontend-research/ih-approval-menu-native-qa-2026-10-03-payload-comparison.json)、[實際 configure DTO](D:/frontend-research/ih-approval-menu-native-qa-2026-10-03-actual-configure-dtos.json)、[最後 owner inventory](D:/frontend-research/ih-approval-menu-native-qa-2026-10-03-idle-inventory.json)。

最後畫面：[窄畫面浮動選單](D:/frontend-research/ih-approval-menu-native-qa-2026-10-03-ui-evidence-open-narrow.png)、[寬畫面浮動選單](D:/frontend-research/ih-approval-menu-native-qa-2026-10-03-ui-evidence-open-wide.png)、[完整存取權標籤](D:/frontend-research/ih-approval-menu-native-qa-2026-10-03-full-access-orange.png)、[設定頁沙箱](D:/frontend-research/ih-approval-menu-native-qa-2026-10-03-ui-evidence-settings-sandbox.png)。

## 行為限制與剩餘範圍

- 本次遠端協議驗收沒有擴展至其他提供商；先前使用者確認可用的 DeepSeek 兩條協議結果保留，不能用本機 fixture 宣稱新遠端服務通過。
- 多資料夾存取依目前專案歸屬及原有工具政策。移動會話變更分組與可寫範圍，預設 cwd 與舊 rewind 根目錄仍為原始資料夾。
- 已交付 JSONL 持久化後端支持會話管理及唯讀歷史；自訂後端缺少必要 snapshot／delete 能力時會明確拒絕。冷啟動 cell／PTY／子代理紀錄不還原 OS 句柄或自動續派。
- 舊版本 1 刪除 tombstone 缺少原始可見性證據，僅已有可信 native 退役憑證時可重試其草稿清理；不依「會話不存在」推測新權限。新版本 2 刪除憑證支持本次驗證的跨 owner 重啟恢復。
- 附件讀取有界；掃描 PDF 不提供 OCR。舊二進位 Office、巨量／加密／不合法／含巢狀危險項目的壓縮檔依格式回報不支援或拒絕，不能把檔案選入視為解析成功。
- 記住核準僅對有完整可驗證身分的工具生效。Shell 可重用證據保守；一般 PowerShell／CMD／複合命令沒有任意前綴授權。
- 目前核準選單的 full-access 依既有後端一併設定 danger-full-access 沙箱；其餘沙箱調整在設定頁。dangerous 模式有誠實的當前標籤，沒有映射成 ask-all。
- Code Mode 缺少 threadCpuUsage 的 Node 22.18／初次不支援環境，採保守本地 wall fallback，仍可能把 OS 暫停算入限額。正式 default1000／range10–10000／parent CPU+250 與初始化30秒不變；特殊 fixture100 及 dedicated30 不代表產品預設變更。
- 提醒、自動喚醒、DSH Agent 預設、OAuth／帳號額度、快捷鍵／統計、完整 Git 分支／stash／worktree、自動記憶生成、簽章／公開發行與自動更新未在本次交付。
- 自動核准審查拒絕移除兩個舊的自測暫存資料夾 `C:/Users/inkik/AppData/Local/Temp/ih-pty-launch-yETTtR`、`C:/Users/inkik/AppData/Local/Temp/ih-pty-launch-nqWViN`，所述原因為「blocked by policy」。它們保持原狀，未重試或改用其他方式刪除。這是測試殘留，並非使用者會話刪除的驗收資料。

主要有界契約如下；這些數值是已交付實作的限制，並非效能保證：

| 功能 | 實際界限 |
| --- | --- |
| 專案檔案搜尋 | 每頁 100 項、最多掃描 3000 項、目錄深度 32；截斷明示。 |
| 文件／壓縮附件 | 輸入 16 MiB、ZIP 256 項、單項展開 8 MiB、總展開 32 MiB、比例 1000、文字 32 KiB、PDF 100 頁、worker 15 秒；不執行或落地解壓。 |
| 未送出附件草稿 | 主程序儲存配額 128 MiB、每筆 29 MiB、64 筆、7 天；提示 32 KiB，圖片最多 10 張／單張 10 MiB／合計 20 MiB，文字附件上下文 64 KiB，文字／檔案／上下文引用合計最多 8 項。 |
| 保存背景工作輸出 | 最後一次成功讀取的完整 snapshot，最多 131072 字元；省略內容明示截斷，不能推測已丟失的輸出或還原活躍程序。 |
| 執行檔核準身分 | 可執行檔最多 512 MiB，以重用的 1 MiB buffer 計算兩次完整 SHA256，要求一致並檢查檔案、handle、路徑及祖先身分；最大讀取約 1 GiB／次，仍有同步 I/O 延遲，沒有快取、OS 寫入鎖或原子檔案租約保證。 |

真正 246,032,896-byte Electron 的完整 SHA256 與獨立 stream／`Get-FileHash` 一致。單次 fingerprint 實測約 409.94 ms；觀察到的 external memory 增量約 1 MiB 是前後採樣差，不能解讀成整個 app 的速度或 peak memory 保證。

## 提交與保護的本機設定

來源／測試／package 本機提交：`e669335bb4db44b9809b272f8b8bdcd2f0411d8a`，184 檔；這四份文件由分支上的後續文件提交保存。最後 HEAD 與工作樹狀態另見[交付紀錄](D:/frontend-test/.superpowers/sdd/2026-10-03-desktop-front-polish/delivery-final-report.md)。沒有推送／PR／merge 或修改保護的主／參考 checkout。

打包使用本工作樹原有的本機 Electron 配置；原有 `packages/desktop/electron.vite.config.ts` 修改保留且未 staged／提交，SHA256 確認維持 `EDE81F84EE9571D43587EFEEC4970F5FB2F54C54E2B2E9EE7FCA7B029C6D8085`。交付 source 與原生 artifact 的 provenance 以本紀錄為準。
