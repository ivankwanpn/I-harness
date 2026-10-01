# IH Desktop 介面缺口清單 — 2026-10-01

## 盤點範圍

依據 `D:/frontend-test` 的實際 renderer、App/Workbench 掛載點、Desktop IPC 與 gateway 路由盤點。參考 DSH、ZCode 及使用者提供的 Codex 介面。這份清單是**程式碼與入口檢查**，不代表逐頁重新完成真實模型驗收。

相關紀錄：[細項能力盤點](2026-09-30-desktop-fine-capabilities.md)、[專案與會話驗收](2026-10-01-desktop-project-navigation-qa.md)、[環境追查與 Todo 介面驗收](2026-10-01-ih-environment-tooling-remediation.md)。使用者另提供 `D:/IHplayground/ENVIRONMENT-TOOLING-REPORT.md`；該報告的測試觀察用來追查缺陷，其中的操作建議不作為變更機器設定的指令。清單主要依 `b34b9655` 的掛載點盤點，本輪新增的 Todo 進度卡已列入完成項。

狀態說明：**缺少**＝尚無相應操作介面；**部分完成**＝有入口但缺部分操作；**入口待改善**＝功能已接通而入口不明顯；**已做**＝來源確認有掛載及後端；**先前延後**＝使用者先前明確要求暫緩。

## 建議先補的日常介面

| 編號 | 状態 | 缺口 / 目前狀況 | 建議補法與後端影響 | 來源 |
| --- | --- | --- | --- | --- |
| U01 | 缺少 | **`@` 上下文選擇器**。目前可從原生選檔加入檔案引用，不能在輸入框搜尋專案檔案、會話並插入引用。 | 參考 ZCode 的上下文選單。檔案搜尋、會話引用格式與可存取範圍也需接通。 | [Composer](../../packages/desktop/src/renderer/session/Composer.tsx:249) |
| U02 | 部分完成 | **新任務輸入介面與既有會話不一致**。無會話時只有文字框、資料夾名稱、開始按鈕；輸入非空文字即建立會話。附件、模型、推理等控制要等會話存在。 | 統一新任務與會話 Composer；先保留草稿，再於送出時建立會話。建立時攜帶模型、附件與設定，需要調整 admission 流程。 | [Workbench](../../packages/desktop/src/renderer/shell/Workbench.tsx:344) |
| U03 | 部分完成 | **核準／沙箱的快速切換**。設定頁有選項，輸入區只有靜態沙箱文字，不能像參考畫面直接切換核準模式。 | 在輸入區加入模式選單與目前有效狀態；沿用已接通的即時設定 API。 | [Workbench 狀態列](../../packages/desktop/src/renderer/shell/Workbench.tsx:354)、[AgentSettings](../../packages/desktop/src/renderer/settings/AgentSettings.tsx) |
| U04 | 部分完成 | **`/` 命令選單**。已有插件命令與 compact，但只處理整個輸入框的 `/` 前綴；缺少完整鍵盤選取與各種內建操作入口。 | 加入上下鍵、Enter/Tab、Esc；整合既有設定／模式操作，保留文字編輯與 IME 行為。 | [SlashCommands](../../packages/desktop/src/renderer/session/SlashCommands.tsx) |
| U05 | 缺少 | **多資料夾檔案樹與編輯器分頁**。目前是變更檔案清單及手動輸入路徑的單一編輯器。 | 專案檔案樹、搜尋、開啟多檔、未儲存狀態、重新載入與檔案操作；新增目錄列舉、路徑身分與編輯狀態契約。 | [ReviewPane](../../packages/desktop/src/renderer/review/ReviewPane.tsx:123) |
| U06 | 部分完成 | **第二個專案資料夾的檔案導航／成果檢查**。Agent 可使用全部根目錄，但手動開檔、工具檔案跳轉及 review 仍依目前所選工作區。 | 檔案身分改成「資料夾 ID + 相對路徑」，review/editor 能切換資料夾。不能只把外部絕對路徑當作本工作區路徑。 | [Workbench](../../packages/desktop/src/renderer/shell/Workbench.tsx:306)、[App](../../packages/desktop/src/renderer/app.tsx:397) |
| U07 | 入口待改善 | **Goal／Plan／團隊／背景工作／代審紀錄** 已有畫面，但藏在「成果檢查 → 工作流程 → 子分頁」。 | 加入側欄或輸入區直達入口、目前狀態及操作提示；主要可重用現有元件/API。 | [Workbench 面板](../../packages/desktop/src/renderer/shell/Workbench.tsx:360)、[WorkflowPane](../../packages/desktop/src/renderer/session/WorkflowPane.tsx:24) |

## 會話、代理與成果管理

| 編號 | 狀態 | 缺口 / 目前狀況 | 建議補法與後端影響 | 來源 |
| --- | --- | --- | --- | --- |
| U08 | 部分完成 | **一般 subagent 的管理介面**。任務投影可看狀態／取消；角色模型設定與 Team 頁存在，但一般子代理沒有完整名單、對話檢視和續派工作介面。 | 分清一般子代理與團隊成員；接入名單、工作輸出、訊息、續派、關閉等可用工具的 Desktop 路由。 | [TaskPane](../../packages/desktop/src/renderer/session/TaskPane.tsx)、[WorkflowTeam](../../packages/desktop/src/renderer/session/WorkflowTeam.tsx) |
| U09 | 部分完成 | **會話搜尋結果的歷史定位**。搜尋命中可開會話，但不會跳到該筆 seq，沒有歷史分頁控制。 | 命中定位、載入該區段、定位標記與下一頁；需配合虛擬 transcript window。 | [SessionSearch](../../packages/desktop/src/renderer/session/SessionSearch.tsx)、[event-window](../../packages/desktop/src/renderer/session/event-window.ts) |
| U10 | 缺少 | **永久刪除、批次管理、移動會話至其他專案**。目前有封存／還原及單筆選單。 | 永久刪除和批次管理需明確資料刪除契約；移動專案需處理固定 project owner、檔案範圍和原有會話儲存位置。 | [SessionActions](../../packages/desktop/src/renderer/shell/SessionActions.tsx)、[session-management](../../packages/desktop-gateway/src/session-management.ts)、[project-scope](../../packages/desktop-gateway/src/project-scope.ts) |
| U11 | 缺少 | **獨立工具／環境診斷頁**。目前工具能力、實際可執行 Shell、Python alias、SDK 缺失主要由 Agent 跑命令才知道。 | 顯示有效工具、延後工具、角色 allowlist、實際執行檔及版本；診斷結果分清未設定、未安裝、不可用與未測。 | [SettingsPane](../../packages/desktop/src/renderer/settings/SettingsPane.tsx)、使用者環境實測報告 |
| U12 | 部分完成 | **Agent PTY／程序管理**。人用終端已有選取、新建、關閉；沒有完整 Agent 程序名單、附接、輸入／signal／resize 的人用介面。 | 統一 owner、活躍／歷史狀態與程序控制 API；需保留沙箱 backend 不足時的拒絕。 | [TerminalPane](../../packages/desktop/src/renderer/terminal/TerminalPane.tsx)、[terminal tools](../../packages/terminal/src/index.ts) |
| U13 | 部分完成 | **背景工作輸出管理**。已有持久化 status、有限輸出和有效權限下的取消，但不是完整 process explorer。 | 補輸出搜尋、複製／匯出、owner／父子歸屬、完整 spill 導航。冷啟動歷史不能假裝仍能控制原程序。 | [WorkflowJobsReviews](../../packages/desktop/src/renderer/session/WorkflowJobsReviews.tsx) |
| U14 | 部分完成 | **Local Git**。已有 diff、stage、unstage、commit；沒有完整分支、stash、衝突處理、worktree 管理頁。 | 先明確需要哪些 Git 工作，再補相應 producer/API/UI。 | [ReviewPane](../../packages/desktop/src/renderer/review/ReviewPane.tsx)、[Git source](../../packages/desktop-gateway/src/review.ts) |
| U15 | 缺少 | **記住核準規則／前綴** 的管理介面。已有危險、逐項、代審、完整存取模式及單次核準。 | 規則列表、新增、撤銷、作用範圍、到期與審核紀錄；需要授權生命週期契約。 | [PendingPanel](../../packages/desktop/src/renderer/interaction/PendingPanel.tsx)、[AgentSettings](../../packages/desktop/src/renderer/settings/AgentSettings.tsx) |

## 資源與設定

| 編號 | 狀態 | 缺口 / 目前狀況 | 建議補法與後端影響 | 來源 |
| --- | --- | --- | --- | --- |
| U16 | 部分完成 | **技能的建立／編輯／獨立安裝管理**。已有搜尋、來源、全文預覽與插入草稿；插件技能可經插件管理，沒有完整人用 skill editor。 | 技能檔案編輯、建立驗證、來源位置、獨立安裝／移除；需處理工作區／插件／全域優先序。 | [ResourceSettings](../../packages/desktop/src/renderer/settings/ResourceSettings.tsx)、[resources](../../packages/desktop-gateway/src/resources.ts) |
| U17 | 部分完成 | **提供商管理與初次啟動設定**。編輯提供商／模型、憑證、模型探索已做，但這些設定依賴已開啟工作區及 gateway。 | 無工作區時也能設定全域提供商；將本機持久化配置和 session gateway 使用區分，避免首次使用只能先開資料夾。 | [SettingsPane models](../../packages/desktop/src/renderer/settings/SettingsPane.tsx:92)、[ProviderDirectory](../../packages/desktop/src/renderer/settings/ProviderDirectory.tsx) |
| U18 | 部分完成 | **附件內容支援和草稿恢復**。一個 plus 入口已做；外部 PDF／Office／壓縮檔不解析，圖片／外部文字未送出草稿不跨重啟。 | 格式解析、檔案大小／截斷提示、持久化草稿與清理策略；是內容與儲存能力缺口。 | [file-attachments](../../packages/desktop/src/main/file-attachments.ts)、[image-drafts](../../packages/desktop/src/renderer/session/image-drafts.ts)、[text drafts](../../packages/desktop/src/renderer/session/text-attachment-drafts.ts) |
| U19 | 缺少 | **自動標題開關與獨立標題模型**。自動標題會執行，目前無人用選項控制。 | 先提供啟用／停用；若需要低價模型，再接獨立模型設定。 | [auto-title](../../packages/desktop-gateway/src/host.ts)、[SettingsPane](../../packages/desktop/src/renderer/settings/SettingsPane.tsx) |
| U20 | 部分完成，P1 | **來源編輯草稿的離開保護**。已有保存衝突檢查，但 editor 草稿存在 React state；關閉成果面板或卸載後沒有持久草稿、保存／捨棄提示。 | 在關閉、換檔、換工作區時保留草稿或顯示保存／捨棄選擇；必須保留既有外部修改／修訂衝突處理。 | [SourceFileEditor](../../packages/desktop/src/renderer/review/SourceFileEditor.tsx)、[Workbench](../../packages/desktop/src/renderer/shell/Workbench.tsx:358) |
| U21 | 部分完成 | **設定分類被隱藏時沒有原因**。需要 workspace／capability 的分類直接從導航隱藏，使用者不知道是未連線、尚未選工作區，還是功能未完成。 | 保留 disabled 分類與前置條件提示；不要將未接通的能力畫成可操作。 | [SettingsPane](../../packages/desktop/src/renderer/settings/SettingsPane.tsx:49) |
| U22 | 部分完成 | **命令與 Hook 編輯**。命令可瀏覽／插入，Hook 可檢查信任／批准／撤銷，沒有完整本機 command／handler authoring UI。 | 命令定義及 handler 編輯／驗證／來源管理；信任授權仍需隨內容變更重新判定。 | [ResourceSettings](../../packages/desktop/src/renderer/settings/ResourceSettings.tsx)、[HookSettings](../../packages/desktop/src/renderer/settings/HookSettings.tsx) |
| U23 | 部分完成 | **記憶筆記編輯與整理**。已有啟用、查看／搜尋、建立、摘要、forget；缺既有筆記的直接編輯／批次整理。自動記憶生成則是後端明確不可用。 | 分別補人用筆記修改 API/UI，以及另行設計自動生成 producer；不能用一個開關宣稱已有自動生成。 | [MemoryPane](../../packages/desktop/src/renderer/memory/MemoryPane.tsx:58)、[memory host](../../packages/desktop-gateway/src/memory-wire.ts) |
| U24 | 缺少 | **通知中心與 About 的版本／診斷資訊**。有原生背景待處理通知，但沒有通知記錄頁；About 主要是產品／授權說明。 | 有需要時增加可回到會話的通知記錄，以及實際版本、診斷／更新狀態。自動更新與公開發行仍屬先前延後範圍。 | [NativeSettings](../../packages/desktop/src/renderer/settings/NativeSettings.tsx:46)、[SettingsPane](../../packages/desktop/src/renderer/settings/SettingsPane.tsx:100) |

> 檔案樹、永久刪除、搜尋定位、核準規則等是目前缺口，沒有自動列為「使用者已延後」。提醒及下列先前延後的項目保留原決定。

## 先前明確延後的介面

- [ ] 提醒／自動化主頁與會話閒置時自動喚醒。現有提醒子面板只在下一 Agent step 處理；使用者已要求先放著。
- [ ] 提供商帳號、OAuth、使用額度／重設時間。
- [ ] 鍵盤快捷鍵設定。
- [ ] 資料／統計頁；包括目前未掛載的匯入、匯出、備份、儲存用量管理，重新啟動這些工作需另行排程。
- [ ] Agent 瀏覽器控制設定及對應工具。人用瀏覽器頁已做。
- [ ] 簽章、公開發行與安裝／更新流程。

## 已具備，後續不能重複列為「沒有做」

- 專案／多資料夾編輯、會話名稱／釘選／未讀／封存／還原／分支。
- 模型與提供商、模型探索、主模型／推理選擇、子代理角色模型及獨立代審模型。
- 即時沙箱／核準模式／自動上下文壓縮設定及後續訊息 queue／steer 設定。
- 思考即時顯示、工具參數／結果展開、圖片預覽、問答／核準卡片。
- Todo 增刪改／狀態及 ZCode 風格的進度卡、輸入佇列取消／恢復、目前執行引導。
- Goal 操作、Plan Mode、Team 名單／任務 CRUD、背景任務歷史、代審紀錄。
- 技能／命令瀏覽、插件市場、MCP 管理、Hooks 信任、手動記憶管理。
- 人用終端、瀏覽器、變更／來源編輯與基本 Local Git。

## 建議實作順序

1. **輸入與導航**：U01–U04、U07、U17。先讓既有能力好找、讓開始新任務的操作完整。
2. **專案成果與草稿保護**：U05–U06、U20，再處理 U09–U10。多資料夾執行能力應有對應的人用導航；草稿離開保護屬優先的資料保留工作。
3. **代理與診斷**：U08、U11–U13，讓子代理、程序與環境可檢查和管理。
4. **擴充操作**：U14–U16、U18–U19、U21–U24。依實際使用選擇，不把所有參考產品功能一次照搬。

本輪交付清單，不自動開工所有介面。工具實測中的程式缺陷另由修正與驗證紀錄追蹤。
