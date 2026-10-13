# IH 0.1.13：研究結論與開發入口

研究開始：2026-10-13；整合檢查：2026-10-14（Asia/Hong_Kong）。基線：v0.1.12，`460a2aee9395dafe196eb31425dcc2c3fcdc259e`。以下研究結論記錄開工前的基線，當時尚未修改產品程式、測試、設定或版本號，也未執行新功能測試、真實模型請求或安裝操作。

開發已從核准計劃 `00824533` 在 `codex/v0.1.13-development` 推進；目前進度與已審查的拆分證據見 [產品追蹤表](../../refactoring/v0.1.13-decomposition-map.md)，原生事件可行性及尚待整合的條件見 [原生技術 gate](../../refactoring/v0.1.13-native-event-gate.md)。本文件的研究結果不代表三項功能已全部完成，0.1.13 尚未發佈。

開發期間針對既有缺口的只讀分析，另記錄於 [完成交付與 scope 清理的補充驗收條件](../../refactoring/v0.1.13-lifecycle-durability-gates.md)。其中包含保存成功後才可領取通知、promotion 的提交邊界，以及子代理與審批代理的資源回收；這些是 E1／E2／I4 的實作要求，並非已通過的新功能測試。

## 使用者已確定的三項目標

1. IH 自身完整的事件驅動：工具／子代理／背景工作完成、主代理喚醒、介面與本地設定／檔案更新。
2. 完善 `AGENTS.md`／`CLAUDE.md` 支援。
3. 拆分全倉庫過大的產品程式為內聚子系統，降低後續AI開發／除錯的上下文負擔；**不拆測試檔、不拆工具腳本**。

Google截圖中的郵件／Webhook是示例，不是需求，沒有列入產品範圍。允許調整IH原結構以修復缺陷，既有reference不是不可超越的架構模板。

## 先讀哪份

| 工作線 | 設計（行為契約、責任、驗收） | 實作計劃（檔案、介面、測試、順序） |
|---|---|---|
| 產品拆分 | [設計](../../superpowers/specs/2026-10-13-v0.1.13-product-decomposition-design.md) | [計劃](../../superpowers/plans/2026-10-13-v0.1.13-product-decomposition.md) |
| 事件驅動 | [設計](../../superpowers/specs/2026-10-13-v0.1.13-event-runtime-design.md) | [計劃](../../superpowers/plans/2026-10-13-v0.1.13-event-runtime.md) |
| 專案指令 | [設計](../../superpowers/specs/2026-10-13-v0.1.13-instruction-context-design.md) | [計劃](../../superpowers/plans/2026-10-13-v0.1.13-instruction-context.md) |

## 主要研究結果

### 事件驅動

core executor與v0.1.12觀察等待已由事件推進。主要缺口是general background work完成後的可靠交付／idle parent wake，以及10個介面／gateway消費面仍依賴8個週期query/scan實作。沒有timer的Git／files/settings畫面也不一定具備完整更新來源，所以不能只用搜尋setInterval作完成證據。

現有child completion路徑有保存與喚醒語意風險：documentwrite可吞錯、drain可重疊、woken不等於已排入或已消費、冷恢復時序需要重現。新方案以工作事實、嚴格flush、固定inputidentity、單一drain、Stopgeneration及恢復投影解決；不加第二個模型lane。

完成事件、UI刷新事件和guard/hook控制流分開；並非每個事件都可以讓模型開始新回合。計時器依用途分類，deadline/backoff/displayclock保留；真正的nativepipe/process-group polling列為獨立技術門檻，不能用rootexit假冒完整清理。

### AGENTS／CLAUDE

IH已能讀兩種檔名，這次是修正完整性而非新增重複loader。重點：明確boundary/globalpolicy、正確UTF-8budget與cache、每child独立context、compaction/rewind與partialclear、typedprovenance、來源表與實際modelrequest一致。

最容易漏的情境是模型直接寫nestedfile、或同一CodeModecell先讀再寫：規則若只在工具內載入，模型還沒有機會理解。計劃加入nativebatchtargetpreflight與可恢復replan；不自動重播原mutation，也不假裝能靜態推斷任意shell程式的全部目標路徑。

### 大型產品檔案

現有**15個產品檔 >=800行**；加上大型函式和高密度元件，共**43個產品候選、32個子系統組**。`assembly.ts`1745行、settings1698行、native runner1246行（含252行內嵌測試）、provider-runtime1173行、service1132行只是其中一部分。

行數只是初篩，重點是責任與所有權。每個候選有原檔→目標目錄→publicfacade→invariants→coveringtests對照。測試與腳本雖曾量測，已明確排除拆分；沒有為減少行數而搬測試／註解或minify。

## 執行順序與相依關係

1. **開工前技術／基線關卡**：核對43候選、公眾API、既有受影響測試；事件E8的native技術fixture先做，不等所有產品都改完才發現平台不可行。這一步是隔離驗證，不改使用者IH。
2. **純結構拆分**：S1–S19建立leaf/domain邊界；S20–S26完成host/service/transport；S27–S32完成Desktop。每列獨立commit/review，測試檔不分拆。
3. **完成事件主鏈**：E1保存與生命週期→E2Stop/恢復/遷移→E3來源owners→E4activeparentwait。UI的E5–E7使用相同owner，不新增副本。
4. **指令主鏈**：I1scope→I2snapshot/watch→I3typedcontext→I4childfactory→I5targetreplan→I6diagnostics。I2依赖workspacewatchcontract，I3擴充拆分後的projection；I4不能自行改父Prompt當替代。
5. **整合**：E8原生替換在技術gate通過後、S14等價抽取之後進行；S33/E9/I7共用wholebranchreview、固定HEADverify:all與打包實測，最後才更新及發佈0.1.13。

可平行的是契約已確定且檔案／stateowner互不重疊的工作。`assembly/service`、`core-session projection`、`settings`和`CodeMode`不能讓幾個agent同時各自改；按dependency順序整合。若先合併多個PR，版本完成仍以三項目標共同驗收為準。

## 已作出的設計選擇（供開工前核對）

| 選擇 | 原因／不這樣做的代價 |
|---|---|
| scoped事件＋sessionlog完成事實，不建globalbroker | 保留IH實際authority/存儲，避免另造不可恢復的statecopy |
| Stop以generation保存；重試交付不重試工具 | 避免完成通知把停止過的工作或副作用再跑一次 |
| 新foregroundchild被steer釋放後移交parentcompletion | 補v0.1.12返回ID後還需主動查結果的缺口；舊task保留原delivery，不追送歷史通知 |
| CodeMode只由最外層交付notice，不吃outputwindow | 避免guest結果被模型通知路徑奪走或重播 |
| AGENTS優先CLAUDE，來源表顯示winner | 保持現有兩檔同層語意；兩檔全部合併會重複或衝突 |
| 指令projectboundary明確，legacyglobals顯式遷移 | 避免ambienthome和磁碟祖先意外進入模型；需要相容性說明 |
| nativewrite遇新規則要求replan | 保證模型先知情再修改；代價是多一個有原因的模型步驟 |
| 不承諾完整ClaudeCode特殊語法或任意shelltarget分析 | 防止把檔名相容冒充整套產品相容；未展開來源要明示 |
| 43候選按子系統拆分，tests/scripts排除 | 符合最新scope，降低上下文負擔而不製造碎片 |
| native事件替換是有實測的gate | 不能為了名稱漂亮而弱化程序樹／pipe／sandbox清理 |

## 原始證據

- [Runtime／完成喚醒](runtime-events.md)：actualowners、保存與恢復風險、sourcefile/line、Codex及OpenCode局部比較。
- [UI／gateway／watcher](surface-events.md)：8週期實作／10消費面、terminalcursor、Gitworktree、reconnect與authority。
- [指令檔](instruction-files.md)：currentloader、child/runtimecontext、native-targetreplan及來源差異。
- [大型檔案](large-files.md)與[產品候選JSON](census.json)：43產品檔、32組、consumers、tests。
- [Timer原始文字掃描](timer-census.txt)：142筆文字命中，含型別／註解／deadline等，**不是142個pollingloop**；分類以兩份事件報告為準。

原始研究中的「proposed」「recommended」「optional」是研究時的候選；有差異時以三份整合spec為準，不能把原始報告的選項當已批准需求。

## 官方來源核對與概念界線

- [Microsoft：Event-driven architecture](https://learn.microsoft.com/en-us/azure/architecture/guide/architecture-styles/event-driven)：事件架構需要設計交付、順序、錯誤和可觀察性；IH選擇有序mediator式completion，不把事件等同任意globalbroadcast。
- [AWS：Transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)：保存狀態與發通知的雙重寫入會造成不一致，consumer要能處理重複。IH計劃使用既有sessionlog及flush，不照搬AWS服務。
- [CloudEvents](https://cloudevents.io/)定義共同事件資料格式，不要求IH使用某種broker；本版不引入其SDK依賴。
- [Codex官方AGENTS說明](https://learn.chatgpt.com/docs/agent-configuration/agents-md)：有global/projectchain、每目錄候選優先順序、大小上限；不能據此推論所有工具都在同一時點載入深層規則。
- [AGENTS.md網站](https://agents.md/)描述nesteddirectoryscope與就近規則。IH會把scope寫成可測資料，而不是只靠文字排列猜測。
- [ClaudeCode官方memory](https://code.claude.com/docs/en/memory)描述不同層級與按需載入，亦有imports等額外語法；IH本版檔名支援不宣稱完整複製這套機制。
- [Node fs.watch caveats](https://nodejs.org/api/fs.html#caveats)說明跨平台／網路檔案系統限制；watch錯誤／rename／reconnect必須可見，不能保證所有OS都不漏通知。

官方頁面查閱於2026-10-13；本機reference是固定checkout，行為不必與最新官方文件完全相同。上述架構是根據IH需求作的設計決策，不是引用聲稱存在唯一「完全事件驅動」範本。

## 文檔自檢與未完成的實作證據

已核對43candidate路徑存在、32子系統映射（補齊MCPsupervisor）、三份plan相依與最新scope；具體existing Vitest路徑可用，新增completion測試明列為待建立。純文檔檢查不等於產品測試通過。

尚需實作階段的RED/GREEN、故障注入、原生平台實測、完整suite、打包後驗證。研究沒有聲稱coldrecovery／compaction等風險已透過新測試重現，也沒有聲稱v0.1.13已具備新功能。
