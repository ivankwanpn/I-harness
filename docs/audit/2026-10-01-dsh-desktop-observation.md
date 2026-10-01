# DSH Desktop 實際操作與 IH 設計依據 — 2026-10-01

## 實測環境

參考目錄為 `D:/agent-complete/deepseek-harness-dsh-v0.2.0-rc.2`。已從該目錄建置並使用官方 `start:desktop` 啟動 Electron Desktop；原生視窗顯示 `DSH 本地构建`、版本 `0.2.0-rc.2-6145fd6`。原始碼封存沒有 Git metadata，建置用的 metadata 存在外部暫存位置，沒有在參考目錄新增 `.git` 或修改參考原始碼。

使用者在 Desktop 中自行加入 API Key。測試工作區為 `D:/IHplayground`。操作透過 Electron renderer CDP 與 Computer Use 的原生視窗觀察，沒有讀取 API Key。Desktop 曾並排顯示，之後由使用者放大；整個自測與操作均在可見視窗中執行。原生畫面為深色；Playwright 的 renderer 截圖呈現淺色，因此截圖顏色不作為使用者主題設定的證據。

## 實際點擊紀錄與設計結論

| 操作 | 畫面觀測 | IH 應採用的方式 |
| --- | --- | --- |
| 點頂部「3 個子智能體」 | 下拉列出三個代理，包含名稱、任務摘要、執行／完成狀態、用量與耗時。主會話側欄仍只有父會話。 | 子代理依附父會話，提供固定入口與狀態清單；不加入普通會話導航。 |
| 點 PROBE-A 的「在側邊欄打開」 | 父會話繼續可見，側邊會話顯示初次任務、結果、續派訊息與第二次結果。 | 先在父會話的獨立子代理面板中檢視，保持父會話身分與輸入草稿。 |
| 點清單中的 PROBE-A 主列 | 子會話變成主內容，頂部為「父會話 / 子代理」，可點父會話返回。 | 子代理詳情提供清楚的歸屬、麵包屑及返回清單。 |
| 点父會話名稱返回 | 返回父會話；背景自測未被中斷。 | 檢視切換不能重建 Agent 或更換父會話執行身分。 |
| 點「4 個後台任務」 | 已結束工作仍保留。綠色完成與橙色被終止分開，列出命令、退出原因與耗時。 | 持久化歷史與活躍程序控制分開；完成工作仍可查。 |
| 點「軌跡」及紅色 `CODE_RUN_FAILED` | 時間線分出模型、工具、子工具和上下文，詳情有概述／程式碼／結果／Schema／計時。 | 普通對話保留簡潔摘要；技術錯誤、參數與輸出可展開查閱。 |
| 回到對話，觀察 Todo 收尾 | 任務清單從完成／進行／待處理混合狀態变成「11 已完成」。可收合，放在輸入框上方。 | Todo 讀取同一份持久化權威清單；IH 進度卡仍採使用者指定的 ZCode 右上方外觀。 |
| 觀察輸入主按鈕 | 執行時為停止方塊，結束後同一位置恢復送出箭頭；空輸入時禁用。 | 單一位置傳達目前動作，不另放常駐的小方形按鈕。 |
| 回答自測問答卡 | 問題在輸入區上方，側欄顯示待回答；已代使用者提交其明確選擇「保留權限修復與備份」。 | 待處理狀態與輸入區問答卡要一致，答覆後恢復任務。 |
| 點「＋ → 計畫」、送出 `/plan` 補測 | 菜單先插入命令；送出後進入 Plan Mode。`exit_plan_mode` 產生「計畫待審」卡，具有查看全文、要求修改、同意執行。 | 入口、計畫全文與審核操作需要接通；不能只有 mode 標記。 |
| 點「查看全文」、同意已確認的唯讀計畫 | 計畫在側邊開啟，審核完成後 `exit_plan_mode` 成功返回，模式退出；沒有新增檔案或代理。 | 核准結果要有回傳與狀態更新；保留唯讀計畫預覽。 |
| 點報告檔名 | Markdown 在右侧檔案分頁預覽，父會話可見。 | 交付檔案提供預覽入口，與對話中的結果相連。 |
| 點「更多 → 設定 → 通用設定」 | 一般設定具有工作步驟詳情、忙碌時送出行為與 Ctrl/Cmd+Enter 反向操作說明。只讀取，未改設定。 | IH 已有後續訊息預設設定；可借鑑把輸入行為與顯示偏好放在一起。 |
| 點設定的「Agent 預設」 | 標準、PTC、極簡、創造模式以卡片顯示說明、內建／預設標記及使用方式。未切換模式。 | 使用者明確表示 IH 沒有此 Agent 模式，不採用這個功能或頁面。 |

窄視窗的側邊子會話操作曾產生「主會話 / 開始頁 / 子會話」三欄，子會話內容被擠窄。IH 這輪使用單一右側面板，避免額外插入空白開始頁。放大後 DSH 的軌跡與詳情可同時查看；窄版仍須依實際可用寬度處理。

DSH 本次可繼續的子代理顯示 `Custom` 權限與輸入框。IH 這輪採子會話唯讀 transcript，加上父會話授權的訊息／續派／中斷／關閉操作；冷啟動記錄只可讀，未提供冷啟動續派。這是目前 IH 執行權限的實際邊界。

## 工具自測結果與判讀

DSH 親自產生的報告：`D:/IHplayground/DSH-ENVIRONMENT-TOOLING-REPORT-2026-10-01.md`，實際存在，19,714 bytes，284 內容行（含尾端空行的分割計數為 285）。首輪報告記錄 26 支載入工具全部已呼叫，95 筆探測記錄：70 通過、10 預期失敗、3 非預期成功、12 候選工具未載入。

必須保留以下驗收邊界：

- 首輪 `exit_plan_mode` 只有非 Plan Mode 拒絕；後續透過 Desktop 的實際模式入口與審核卡補測成功。原報告未追加此結果，本文件記錄補測證據。
- Team／任務板、排程／cron、workflow、專用終端／上下文管理工具在該會話未載入，沒有宣稱已完成這些工具的成功驗收。pwsh 背景工作也不等同專用 PTY 工具。
- 3 個子代理的最後狀態是 `inactive`，並且仍出現在清單、仍有可繼續記錄。這證明當下未執行，不證明永久關閉或刪除。
- 第一回合內建立的 fork 回報沒有已完成回合可繼承。這個案例沒有驗證對已完成父回合的 fork；不能据此判定所有 fork 都會遺失上下文。
- 自測報告自稱 Web GUI，是從 `DSH_WEB_URL` 推得的描述。實際受控目標是 `dsh-app://app/` 的 Electron Desktop renderer，原生視窗亦已觀察。
- 報告中關於輸出截斷、未知代理中斷仍回 accepted、Windows Python alias 與沙箱狀態的發現，保留為 DSH 該環境的結果，不套用成 IH 的結論。

首輪自測曾自行透過 DSH 診斷技能修復 `D:/IHplayground` 的 ACL。已告知使用者；使用者明確選擇保留修復及 `D:/dsh-acl-recovery-20261001` 的還原備份。沒有再修改機器設定。自測探測目錄已不存在，四個背景工作皆 settled，原有 IH 報告保留。DSH Desktop 留在前景供使用者查看。

## 操作截圖

截圖存於 `D:/frontend-research`，來源為實際 Electron renderer：

- `dsh-desktop-subagents-menu-2026-10-01.png`
- `dsh-desktop-subagent-sidepane-2026-10-01.png`
- `dsh-desktop-subagent-main-2026-10-01.png`
- `dsh-desktop-background-jobs-2026-10-01.png`
- `dsh-desktop-execution-trace-2026-10-01.png`
- `dsh-desktop-tool-error-detail-2026-10-01.png`
- `dsh-desktop-composer-plus-menu-2026-10-01.png`
- `dsh-desktop-plan-review-2026-10-01.png`
- `dsh-desktop-plan-completed-2026-10-01.png`
- `dsh-desktop-subagents-after-interrupt-2026-10-01.png`
- `dsh-desktop-report-preview-2026-10-01.png`
- `dsh-desktop-settings-general-2026-10-01.png`
- `dsh-desktop-agent-presets-2026-10-01.png`

Computer Use 另外直接顯示原生深色視窗。參考 DSH 的互動安排及 ZCode 的 Todo 外觀，不修改參考程式碼。
