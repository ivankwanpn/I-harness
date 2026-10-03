# IH 設計問題分析 — 2026-10-03

## 結論與檢查範圍

使用者要求檢查這輪問題是否來自原本不合理的設計。以下依這輪已重現的 host、registry、原生 IPC、JSONL 和真正執行工具案例分析，包含修正後的行為檢查。這是有證據的局部設計分析，尚未宣稱全專案所有設計都已審核。

**有幾個原設計邊界需要調整。** 問題集中在：展示資料與權限資料共享可變來源、同一事實的兩份 owner 投影沒有同步契約、跨儲存操作缺少耐久恢復憑證、讀取接口含修改副作用，非同步等待後沒有在真正執行處重查權限，以及把 wall time 和可信初始化算作 guest CPU。實際打包宿主的執行檔大小、Windows 終端 Enter 和工具保存 DTO 也揭露了只在合成測試成立的假設。另有前端依賴設定錯誤與過時測試 fixture，需要分別修正。

建議保留目前 Runtime、gateway 與 native IPC 分層，明確收緊以下契約。這些修正已有直接 producer／consumer 回歸，不需要先替換整個工作台。

本輪最後來源已保存為本機提交 `e669335bb4db44b9809b272f8b8bdcd2f0411d8a`；最後完整 gate 為 **4322 passed／10 skipped／0 failed，71／71，型別／E2E／reachability 全部 exit0**。原生紀錄由完整 payload 對比支撐的分段驗收組成，90 loopback／0 remote，最後核準選單及沙箱只留設定頁的使用者要求也已完成。[最後完整驗收與可執行產物](2026-10-03-desktop-front-polish-acceptance.md)

## 已重現的問題與設計處置

| 問題 | 已觀察的證據 | 原設計／實作原因 | 修正後契約 |
| --- | --- | --- | --- |
| **展示讀取改變權限識別** | 真正 Desktop host 的 mixed／only Code Mode 皆回傳 `prepared approval authority or policy changed before dispatch`；`list_dir` 已進入巢狀 dispatch 卻被拒絕。持有執行 Hook 時，僅啟動 cell 並讀取 executionState 就改變識別值。 | `registerCodeMode.schemas()` 把 active cell IDs 寫入實際登錄的工具 description；權限識別同時讀 catalog 與模型投影，讀取順序亦會混合舊／新資料。動態顯示資料被納入可變權限來源。 | 模型 schema 返回展示副本，保留動態工具說明及 active IDs；實際工具登錄保持穩定。權限仍綁定真實政策、工具綁定、完整參數及當前 guards。 |
| **跨兩個儲存 owner 的刪除無法冷啟動恢復** | gateway 已永久刪除會話，native 退役憑證尚未保存便失敗；fresh gateway＋draft store 重試時保留 `orphan payload` 且回報已刪除。 | gateway／JSONL 與 native 草稿不是同一個交易；原流程只在第一個 owner 成功後建立第二個 owner 的恢復憑證。部分成功與中斷沒有持久、可驗證的後續權限。 | JSONL 在 artifact 移除前保存最小結構刪除憑證及精確 manifest。原 confirmed delete 可根據此 owner 證據重查可見性／忙碌／資源／子孫及 write lease，再完成精確清理；未知 ID 或單純 absence 不構成權限。 |
| **歷史檢視缺少真正唯讀入口** | 不完整 JSONL 在冷 execution／process 讀取的 loader fallback 中被修復；保存的 PTY 存在而重新啟動後畫面只列 liveResources，沒有歷史列。 | 執行用的 loader 與歷史用的 snapshot 契約混用；程序 UI 把 live owner 集合當成全部保存紀錄。 | 冷查詢必須使用 readonly snapshot；不支援的 backend 明確拒絕。保存事件投影歷史 metadata／已捕獲輸出，標記未確認狀態，提供零 replay／零 assembly 建立的唯讀畫面。 |
| **等待 Hook 後權限檢查過早** | 七個 held-hook 案例中，操作準備後撤銷／換綁定／新 guard／政策改變，原 cascade fallback 仍執行；真正檔案寫入及 PTY send 也重現。 | prepare 與 dispatch 入口檢查後，execution Hook 可以 await；真正工具 body 與最後一次檢查之間留下可變權限窗口。 | 真正 cascade fallback 在 body 前同步檢查工具世代／當前 policy authority／guard／記住的證據；檢查與呼叫 body 間沒有 await。Hook、工具 body、finalize 與結果各執行一次。 |
| **前端狀態更新依賴自己的輸出** | 真正 App 的非同步歸屬回覆引發 9 次讀取且 `projectReady=false`；即時 resolved Promise fixture 會掩蓋問題。 | effect 依賴由 projectBinding 產生的 activeProjectId，同時清空並更新 projectBinding；屬狀態依賴設定錯誤。 | 讀取依會話／工作區／能力／明確重試識別；讀取結果為權威歸屬，顯示衍生值不反向觸發同一個讀取循環。 |
| **命令介面與引擎讀取不同清單** | 打包後原生介面已建立 workspace 命令，引擎及資源頁讀到它，但 `/` 清單回傳「沒有符合的已啟用命令」。 | engine／resources 使用 effective local inputs，舊 `desktop/plugins/commands` 僅從 managed plugin descriptors 建立清單。新功能接到一個 producer，consumer 仍使用另一個 owner。 | host 的唯讀命令清單直接投影共享 `resources.effectiveInputs()`，僅返回 name／description／argumentHints；維持工作區、啟用插件、全域優先序與停用篩選。真正建立／修改／移除／切換來源回歸已通過；最終 native 候選包實際鍵盤選取、插入與模型收到的有效 body 亦通過。 |
| **人用終端行提交假定 LF 可以代替 Enter** | 同一個 Windows cooked Node PTY，UI 的 LF 只產生 OS echo，沒有程式完整行輸出；相同 owner 的 CR 經真正單次核准後產生 `QA_COOKED_LINE:COOKED_INPUT`。 | 原始工具資料傳送與人用行編輯混用；介面在原始資料後固定附加 LF，沒有採終端 Enter 的 CR。 | 人用行編輯將貼上行分隔轉成 CR，並送出最後 Enter；原始工具仍完全由呼叫者決定 bytes，沒有新增權限或隱藏核准。最終 native 候選包的相同 cooked 場景已以人用介面單獨提交並產生完整行輸出，沒有額外 owner CR 補送。 |
| **保存輸出投影使用了錯的 producer 格式** | 真正 pwsh 背景工作及 `job_output` 保存 `{text,status}` 含 `QA_JOB_OUTPUT`，重新啟動的 job-output 檢視卻回報不可用。 | fold 以合成的 stdout／stderr 假設取代實際註冊工具 DTO；工具與 Code Mode 保存包裝也沒有共同真實輸出回歸。 | 讀取真正完整 text snapshot，後續 snapshot 替換舊值，保留舊 stream 格式相容與 131072 字元／截斷；匹配 launch／call／name／owner 並維持冷唯讀。真實註冊工具及自動 Code Mode 保存紀錄的重啟回歸已通過。 |
| **執行檔指紋邊界只涵蓋 Node 測試環境** | 真正打包 Electron 執行檔為 246,032,896 bytes，核準卡回報超過 128 MiB 限制而沒有記住選項。 | 指紋先以小執行檔上限拒絕，再一次 readFileSync 分配整個檔案；實際出貨宿主與測試 Node 大小不同。 | 使用固定 1 MiB buffer、兩次完整 SHA256 一致性及檔案／handle／路徑／祖先檢查，最大 512 MiB；實際完整 digest 與獨立 streamed digest／Get-FileHash 相同，Windows 持有另一 reader 的變更案例仍拒絕。同步最後驗證、完整權限及 binding／expiry 檢查保留；最終 native 候選包 H 已通過可見勾選、真正讀取、重用、重啟、參數／政策／綁定變更、期限及撤銷檢查。 |

原生候選包的窄畫面另外揭露一個真實 CSS 佈局問題：682px viewport 中標題列在 672.8px 裁切，最大化按鈕位於 672.8–714.8px，關閉按鈕位於 716.8–758.8px，兩者實際不可見。外層 document 的 scrollWidth／clientWidth 相等，不能證明被內層裁切的控制可操作。原因是次級操作列 `flex-shrink: 0`，而父標題列 `overflow: hidden`。最小修正讓次級操作列可以縮小與捲動，保留個別按鈕寬度及固定視窗控制；真正按鈕矩形、裁切祖先、hit test、原生 minimize／maximize／restore／close 與 toolbar 皆已通過重查，最後 UI 包沒有重新引入裁切。

最新使用者介面決定為 `+` 旁的盾牌按鈕顯示當前 **effective** 核準模式，向上 body portal 提供要求核准／代我核准／完整存取權；當 dangerous 生效時標為「高風險時核准」，沒有假冒 ask-all。沙箱下拉與底部欄從主介面移除，設定頁保留完整沙箱／四種核準設定。選單只送 approvalMode，但 full-access 依原後端一併設 danger-full-access，描述沒有宣稱保留原沙箱。原生實際 DTO、當前勾選、橘色 label、viewport／height／keyboard 與設定 callback 全部驗證。[實際原生 configure DTO](D:/frontend-research/ih-approval-menu-native-qa-2026-10-03-actual-configure-dtos.json)

新選單覆核找到 loading／focus P2：初始 state 還沒回覆時選項全 disabled，ArrowDown 開啟後焦點留在 trigger；trigger Tab 未關閉選單，晚到回覆便搶回已移到 Send 的焦點。真正元件 red 重現後，最小 trigger Tab 分支關閉選單並保留原生 Tab，late reply 不再搶焦點。舊工作區配置回覆也按 epoch 拒絕更新新 workspace 的 label／callback；晚到 save 不會在 outside dismiss 後搶回 editor focus。最終獨立 10 項 menu／picker 與原生 ordinary keyboard／focus 通過；沒有捏造原生延遲回覆來宣稱 native timing race 已重現。

## 驗證設計修正沒有放寬真實權限

Code Mode 新的真正 host 回歸涵蓋：

- 相同權限下，持有 Hook、啟動／停止真實 cell、讀取執行狀態，已準備的 `list_dir` 成功。
- 真正修改沙箱、核準模式或專案根目錄後，待執行操作仍拒絕。
- 模型仍接收動態 schema 說明；實際 registry description 不因 consumer 讀取而改寫。
- mixed／only 正確傳遞保存模式及輸出截斷；原本完成／`long`／truncated 的成功斷言維持。

本輪最後的聚焦結果為 host 9、registration 4、dispatch authority 8、launch guards 6、policy fingerprint 1 通過，兩個覆蓋套件型別及 reachability 通過。全量與打包後操作的最終結果記於 [前端驗收報告](2026-10-03-desktop-front-polish-acceptance.md)。

刪除恢復以真正檔案系統故障阻擋 native 退役目錄保存，及 crash-equivalent 的 gateway 成功／native 未退役窗口測試；兩個 owner 重新啟動後精確重試完成。兄弟／新任務草稿及來源檔案保留；missing、busy、hidden、其他工作區 ID 仍拒絕，沒有新草稿退役權限。版本 1 舊 tombstone 缺少結構可見性證據時維持保守拒絕。

## 不應把所有紅色測試都歸為設計錯誤

Desktop 全套另外有四個失敗，已確認是三份舊 fixture 的契約與生命週期沒有更新：

1. 原生問答 fixture 仍 mock 舊 untrusted reply；目前人用 IPC 正確轉送 trusted-human route，保留精確決策及無效輸入拒絕。
2. `/` 選單 fixture 查詢 `button`，目前鍵盤選單正確提供 `listbox`／`option` 語意。選取與動態停用斷言保留。
3. Composer fixture 重用同一會話 ID，只清除 localStorage；目前輸入另有跨 remount 的記憶草稿。單獨 Stop 案例通過，整個檔案則讀到上一案例的 `new task`。fixture 以既有 `clearDraft` 清理自己實際擁有的兩個 scope，並完成 React 非同步清理；沒有修改產品 Stop 行為。

修正後五個覆蓋測試檔 33 項通過，包括單按鈕狀態、IME、佇列／引導、鍵盤 picker 及可信人用核準真正進入受 guard 的檔案工具。

原生驗收的兩個中途失敗也經實際資料確認為 fixture 錯誤：輸入尚未可見便計數得到 0，保存紀錄後確認只有一個 admission／promotion／turn；另一案例恢復時重產測試 marker，卻以新 marker 比較舊 Alpha 檔案。實際 Alpha 原始 58 bytes 及雜湊沒有變，Beta workspace ID／保存路徑正確。驗收改用耐久輸入識別、完成屏障及操作前後的精確檔案內容。

檔案搜尋全套另出現 30 秒 scan fixture timeout 與 1 秒 UI 觀察失敗。完全未修改的兩個測試檔獨立執行通過，scan 1.293 秒；fixture 曾一次排入 3001 個檔案寫入，timeout 後仍有異步目錄工作，teardown 引發二次 EBUSY。修正僅限制 fixture 同時寫入 16 個、完整 drain owner，並在真正 native response 與 React 更新後保留原 1 秒 UI 觀察。仍建立同樣 3001 個檔案，scan 3000 上限／截斷與 30 秒 test timeout 不變；production directory pins、掃描與權限檢查沒有修改。

W10 Shell 400 ms 截止的全套測試曾卡至 30 秒；未修改的獨立案例通過。真實診斷量到 Git Bash exit 542 ms、所有繼承 pipe close 694 ms，原生 PowerShell exit／close 同在 507 ms。原全套卡住的確切階段沒有 trace，不能據此宣稱已重現或修復 production kill bug。Windows 的單一截止／promotion 關係反證改用真正註冊的原生 pwsh builtin hold；保留 400／30000／test timeout、超時品牌、無 job 與未完成工作斷言，其餘案例與非 Windows shell 選擇維持。僅在觀察之後釋放、drain 自有失敗工作，避免 teardown 擱置。

最後子代理 fixture 在 default 1 秒內反覆做完整 catalog filesystem projection，等待非同步 teammate 完成；完整 gate 只捕獲其 timeout，原始 case 獨立 190／192 ms 通過，沒有證明 production 子代理失敗。fixture 改用真正共享 registry 的 wait_agent 依精確 root／lead path 等待，驗證 waiting、沒有 error、final1–4、自己的 job completed，再 flush child／parent 後檢查 catalog／歷史。原有 followup、turn、無 child-main assembly、1 秒觀察及 15 秒 case 斷言保留；10 項完整檔案／型別／reachability 通過並經 root fidelity review。原完整 stalled stage 仍未證實，最終完整 71-project gate 已通過。

Goal fixture 的初始讀取和 Create and Start 本來有非同步回覆，卻在 React 尚未安裝回覆時開始下一步。補上實際回覆的 `act` 屏障後，原本廣泛的文字查詢同時找到目標段落和輸入框；現在檢查實際 `.workflow-objective` 段落。精確 `goal/create` DTO、trimmed objective、`start: true`、首次只讀一次及沒有隱含建立等斷言保留，未加長觀察期限或修改產品。

Code Mode CPU containment 的早期全套案例只捕獲恢復空字串，沒有保存 status／error；案例 522 ms 和預設觀察預算 1000 ms 也不足以證明它只是 running。未修改的獨立案例通過，實際診斷顯示初始 cell 因 CPU 限制失敗、恢復 cell 完成並輸出 `7`。當時 fixture 補上自己的 failed／closed 事件、現有 `cancel()` 的 worker／producer 停止屏障，再於同一 runtime 以同一 CPU 30 ms 限制建立新 cell；等待該 cell 的 completed／closed 事件並檢查沒有 error、精確輸出 `7`。該輪沒有替換 runtime、清空 store、重置配置、sleep、重試迴圈或提高資源限制。原空輸出失敗的確切原因維持未證實。

## CPU 計量與完成邊界的後續證據

後續真正獨立的完整 gate（`ih-desktop-front-polish-final-release-verify-2026-10-03.log`）提供了新的具體證據：相同 runtime 的 `text(7)` 恢復 cell 回報 `CPU work limit exceeded`，案例 396 ms，並在檢查它自己的 closed error 時失敗。原 worker 把 `performance.now()` 的 slice 經過時間累積為 CPU，同一 slice 又包含固定 bootstrap 與 guest module evaluation。父程序另有 `cpuTimeMs + 250` 的 hard watchdog，其錯誤帶有 `worker hard stop`，與這次捕獲的 plain worker error 不同。該 gate 只有 61／71 專案回報，2474 passed／9 skipped／1 failed，不能採用為交付結果。

修正採用目前 worker 的 `process.threadCpuUsage()` user／system 微秒計量，於 v23.9.0／v22.19.0 加入；本機 Node v24.15.0 已確認可用。新的私有 `cpu-budget.mjs` 在執行前選定計量來源：缺少 API 或初次不支援時保留本地 slice wall time 的保守路徑；這個路徑仍可能把 OS 暫停算入限額，不能宣稱有精確 CPU 計量。開始執行後的時計失敗會令 cell 失敗，不能改用其他時計或重置累積值。固定可信 helper／bootstrap／reserve 建構獨立於 guest quota；guest source evaluation、promise pumping、結果 decode／settle、timer／yield callback 仍計量，父程序初始化 30 秒及 hard watchdog 維持。[Node 官方 API 文件](https://nodejs.org/api/process.html#processthreadcpuusagepreviousvalue)、[實際計量 helper](D:/frontend-test/packages/code-mode/src/cpu-budget.mjs:1)、[真正 worker](D:/frontend-test/packages/code-mode/src/worker.mjs:1)

真正 worker 的專門 CPU30 反證在 clock read 注入有界 100 ms 暫停：實際 wall 至少 90 ms，而該執行緒 CPU 少於 30 ms；原版本失敗，新版本完成精確 `7`。另一 probe 在固定初始化消耗至少 45 ms 執行緒 CPU，仍允許 guest CPU30 完成 `7`。API 缺少時的 fallback、無限 promise containment 和時計失敗均另有實際 worker 驗證。這些是捕獲的閾值及 red→green 行為，沒有補造未記錄的浮點採樣值。[真正 worker probes](D:/frontend-test/packages/code-mode/test/cpu-budget.test.ts:1)

獨立覆核另重現一個完成邊界 P2：clock read 6 失敗前，原流程已發布 completed 和 `[[k,7]]`，可能讓 parent 接受尚未驗證的 store commit。現在先完成該 slice 計量和 budget 檢查，再發布成功／writes；相同故障得到 failed、clock error、空 writes、read 6 及自然 exit 0。guest 捕獲 `exit()` 後的迴圈也由 closed interrupt 終止，保留 exit 前寫入，沒有以 parent kill 假裝成功。最終聚焦 runtime／budget 35、register／human-stop 5、real host 9 及型別／reachability 通過；完整交付結果另見[驗收報告](2026-10-03-desktop-front-polish-acceptance.md)。

使用者後續明確批准上述 containment／同一 runtime 恢復 fixture 使用 100 ms。正式產品預設仍為 1000 ms，配置界限 10–10000 ms，父程序 hard watchdog 公式 `cpuTimeMs + 250` 維持；專門 CPU／初始化反證仍使用 30 ms。先前真實 30 ms 失敗及相關日誌保留，最終結果須以這次批准後的凍結來源完整 gate 為準。

## 搜尋設計的後續建議

這是使用者另行要求的唯讀 grep／ripgrep 研究，以下搜尋契約建議尚未實作。IH 的模型 `grep` 已透過 `@vscode/ripgrep` 啟動打包的 rg；優先改善的是搜尋契約。[實際引擎解析](D:/frontend-test/packages/fs-search/src/index.ts:22)、[grep 註冊與 schema](D:/frontend-test/packages/fs-search/src/index.ts:115)、[實際 argv](D:/frontend-test/packages/fs-search/src/index.ts:135)

來源顯示 glob 的 100 項及 grep 的 250 項上限在完整進程結果返回後才裁切，不能據此宣稱掃描、原始 stdout 或時間已受限。搜尋走 `spawn`，沒有 `execFile maxBuffer`；一般掛載未啟用可選 spill collector，其 tail 門檻也不是搜尋進程 hard cap。搜尋 body 沒有把既有 ToolExec abortSignal 或 deadline 傳入 exec，結果也缺少 truncated／partial／byte metadata。這些是 source 證據；本次沒有實際 Stop／CLI 故障 fixture 或效能基準，不能宣稱觀察到某個殘留程序或速度倍率。[返回上限](D:/frontend-test/packages/fs-search/src/index.ts:101)、[搜尋執行與結果解析](D:/frontend-test/packages/fs-search/src/index.ts:146)、[spawn／可選 collector](D:/frontend-test/packages/exec/src/index.ts:170)、[一般 shell 掛載](D:/frontend-test/packages/shell/src/index.ts:707)

後續可先接上 owner 取消與全局結果／byte／時間限制，回報有限、取消、逾時、無命中與部分錯誤，再補 literal、大小寫、context 和明確 hidden／ignore 選項。現有 glob 開啟 `--hidden --no-ignore`，grep 採 rg 預設且沒有 `--no-config`；需要明示並驗證這些 policy，而非把無命中當作已搜尋全部檔案。多根內容搜尋可沿用 `{workspaceId,relativePath}` 與目前專案歸屬；它與本次已交付的有界「檔名搜尋」是兩個不同入口。完整來源與官方文件比較保存在[獨立研究報告](D:/frontend-test/.superpowers/sdd/2026-10-03-desktop-front-polish/grep-ripgrep-research.md)。這些建議尚未實作或原生驗收。

## 後續實作採用的檢查原則

- 讀取／診斷／展示接口保持無副作用；真的需要變更 registry 時使用明確的 owner mutation。
- 對同一事實指定一個權威 owner。UI 顯示和模型 presentation 從權威資料投影，不成為新的授權依據。
- 跨 owner 的破壞性操作先持久化可驗證的恢復證據；成功回覆須說明已完成的階段，重試具有精確 ID 與冪等語意。
- 每次非同步邊界之後，在不可逆 body 前重查當前權限；保存資料或過去核準不能替代現在的 owner。
- 測試使用真正延期回覆、重新啟動的新 owner、具體 side effect 及精確失敗原因，並同步維護 consumer 的契約。
