# 上下文重構與既有拆分任務的合併地圖

2026-10-15，核對 HEAD `1b605d0e7e7f88cdc4de5a5ae3c6103eea61f590`。使用者要求：開發複雜度可以接受，必須有規律與完整設計框架；上下文重構遇到原拆分範圍時合併交付，避免重新產生大檔。測試檔、工具腳本、第三方與產生碼仍不拆。

本文件是範圍／驗收整合，沒有將規劃標成完成。設計依據：[ContextEngine](../superpowers/specs/2026-10-15-context-engine-redesign.md)；架構約束：[完整框架補充](../superpowers/specs/2026-10-15-context-engine-framework.md)。舊台帳：[43 檔追蹤](v0.1.13-decomposition-map.md)。

## 1. 精確進度與本次量測

- 原清單 **43 檔／32 組**；S1–S19 的 **27 檔／19 組**有既有拆分與獨立審查紀錄。
- 尚未完成 **16 檔／13 組（S20–S32）**，不是「還有 16 個子系統」。
- 本次重測 891 個 tracked maintained product source；沿用 >=800 實體行、JS/TS 函式 >=250 行、或 <250 行但 >=18,000 字元的候選條件，共 **18 個目前候選路徑**：16 個原 pending＋2 個原清單外的路徑。
- 這些門檻是找風險的工具，不是完成標準。小於 800 行仍可能有巨大 closure；已 review 的舊拆分遇到新行為仍需重新驗證，但不能重複計入完成數。

機器資料：[census.json](context-overlap-2026-10-15/census.json)；可重跑腳本：[census.mjs](context-overlap-2026-10-15/census.mjs)。Physical lines 含註解／空白；AST 函式可巢狀重疊。原生內嵌測試仍須人工區分，不因掃描而取得拆測試的授權。

## 2. 建議整組收編：6 組、9 個原檔

以下各組會被本次主資料路徑直接改動，建議把其完整結構拆分併為該階段的交付條件，不另排一次重複搬動。公共入口保留薄 facade；每個原檔的其餘責任也必須有明確歸屬，才能結案。

| 原任務 | 現在尺寸：檔案／最大函式 | 本次重合責任 | 目標模組與交付點 |
| --- | --- | --- | --- |
| **S20** | `session-executor/assembly.ts` **1,785／1,287**；`service.ts` **1,153／896** | 組裝 ContextEngine、model binding、durable owner／lease、輸入 admission、背景結果與 close | `assembly/{types,models,context-engine,tools,plugins,subagents,cleanup}.ts`、`service/{types,assembly-cache,input-admission,turn-queue,session-controls,shutdown}.ts`、`lifecycle/{ownership,publication,retirement}.ts`；R1→R5 分階段接入，同一 state owner 不複製 Maps |
| **S21** | `sdk/server.ts` **1,018／693** | context DTO、prompt／steer、cancel／rewind、通知與 request correlation | `server/{state,initialize,session-reads,session-controls,prompt,models,shutdown}.ts`；R5，保持 capability、錯誤碼、bounded writer與inflight owner |
| **S22** | `cli/run.ts` **1,033／681**；`index.ts` **995／439** | 主與摘要請求的組裝、CLI 恢復／壓縮／錯誤呈現與清理 | `headless/{assembly,execution,events,errors,cleanup}.ts`、`commands/`＋原 executable facade；R2/R3/R5，stdout/stderr、exit code及無互動生命週期不漂移 |
| **S23** | `desktop-gateway/router.ts` **716／615**；`host.ts` **556／431** | 手動壓縮、model switch／rewind、prompt busy gate、controller組裝、job取消／drain | `router/{state,capabilities,session-input,session-controls,context,dispatch,shutdown}.ts`、`host/{composition,controllers,observation,lifecycle}.ts`；R3/R5，既有 domain controller 仍是唯一執行者 |
| **S25** | `desktop-gateway/session-subagents.ts` **316／257** | live/durable child identity、context read、lineage、結果與父子可見性 | `session-subagents/{projection,visibility,bindings,controls,observation}.ts`；R4/R5，不為 UI read 建新的 child／assembly，也不繞過 lineage authority |
| **S28** | `desktop/main/runtime-diagnostics.ts` **375／333** | admission／summary／attempt 的安全診斷，info／failure分類、scope與訂閱 | `runtime-diagnostics/{classification,redaction,buffer,projection,subscriptions}.ts`；R5，bounded log、安全 scalar 與原始錯誤不外洩 |

這 **9 檔實際驗收後**，原台帳可由 **27/43 → 36/43**。現在仍是 **27/43**；新增設計／目錄或只將新功能寫進別檔，均不構成原大檔完成。

## 3. 部分責任重合：5 組、5 個原檔

| 原任務 | 現在尺寸：檔案／最大函式 | 這次需要處理 | 原任務仍有的責任 |
| --- | --- | --- | --- |
| **S24 project-scope.ts** | **397／368** | context／artifact 的 workspace scope、rebind／revocation fence | 完整 project membership、lease／retirement broker；只接 port 不等於整個 broker 已拆 |
| **S27 ipc.ts** | **800／626** | context／diagnostic/session 請求接線與 sender validation | native、workspace、project、resource等dispatch責任；不能只移走context分支便結案 |
| **S29 app.tsx** | **809／758** | context revision／session event DTO接線、active epoch、pending input | runtime connection、session selection、project navigation與App layout |
| **S30 Workbench.tsx** | **547／410** | context reader、模型切換後revision、相關pane呈現 | 全部pane host、review/workflow view、hidden form和navigation所有權 |
| **S31 Composer.tsx** | **604／345** | 上下文讀數、send／steer admission、attachment ref接線 | durable drafts、attachments lifecycle、toolbar、NewTask／SessionComposer及focus |

處理規則：優先在已存在的 leaf／新狹窄模組改功能，原入口只接線。若必須大改上述原 closure，就把該組提升為本次整組拆分，先更新本表與具體 before→after manifest，再做結構／功能分開的提交。不可一邊新增大型 closure 邏輯、一邊以「只是部分重合」規避拆分。

只有完整責任遷移與全部原 gate 通過，原任務才從 pending 改為 reviewed；否則記錄已移出的具體責任與剩餘責任。這五組目前不計入上面的預計 36/43。

## 4. 保持獨立：2 組、2 個原檔

- **S26 `coding-plans/codex-management.ts`：476／349 行。** ContextEngine 只消費已解析的 route／account compatibility identity；token/login/redemption/account-lock仍屬 credentials owner，不因上下文工程全面重構登入管理。
- **S32 `renderer/session/SessionManager.tsx`：210／185 行、最大函式20,560字元。** 清單／批次管理、選取與確認流程不是本次主鏈路。高密度候選仍留在舊台帳，不因行數少而刪除。

跨來源的 account、workspace identity 必須在 R2/R4 驗收；「沒有拆 S26」不代表省掉相容性檢查。

## 5. 已完成拆分、這次繼續使用的結構

| 原任務 | 原檔數 | 本次會碰的既有模組 | 計數規則 |
| --- | ---: | --- | --- |
| S2 | 1 | core-session events／projection／serialization | 保留已完成狀態；新exchange／checkpoint責任不得重新塞回index |
| S3 | 2 | provider catalog/context、runtime selection/binding | limits／route身份仍分清owner；不合併catalog與runtime |
| S4 | 5 | 五種adapter的request／stream／client | 在各adapter新增validator/measurement小模組；Codex subscription仍為Responses內不同route能力 |
| S6 | 1 | core-tools registry／prepare／dispatch／finalize | result envelope不侵入approval owner；不重算拆分完成數 |
| S9 | 1 | persistence coordinator／format／write-behind | checkpoint CAS、flush與lease保持單一owner |
| S11 | 1 | compaction engine／projection及summary helper | 改成單一ContextEngine的reduction/summary實作者，移除重複決策；原已拆index保持薄入口 |
| S15 | 1 | code-mode runtime／output | 大結果與worker事件邊界；不把Code Mode重新寫成獨立context engine |
| S17 | 2 | core-agent agent／tool-batch | request admission／accepted exchange／effect ledger；不集中到turn.ts |
| S18 | 2 | subagent child／tools／followup | snapshot seed與result delivery；已拆部分重新做變更回歸 |
| S19 | 1 | team scheduler admission／completion／recovery | 完成通知共用契約，既有taskboard/mailbox仍是權威 |

這是 **17 個已完成原檔／10 組**與本次核心直接重合的已拆骨架；其他已完成組可作consumer gate，但沒有因為同一package被測試就算作本次重構範圍。沒有把「改功能」再次計成「多拆了17檔」。

## 6. 新增兩個候選：另立台帳，不改原43分母

| 新標識 | 現在檔案／最大函式 | 為何重合 | 目標 |
| --- | --- | --- | --- |
| **CX1** | `session-persistence-jsonl/src/index.ts` **337／256**（createJsonlBackend） | 大歷史cold load、checkpoint恢復、append/repair/format upgrade都經backend factory | `backend/{types,session-io,documents,format-upgrade,deletion,profile}.ts`；優先重用既有format/helper，file-system寫入owner唯一，R1/R3/R6 |
| **CX2** | `subagent/src/task-protocol.ts` **457／278**（createTaskRegistry） | durable result、notification queue、settlement、claim及branch/epoch disposition | `task/{types,registry,settlement,retention,notifications,persistence}.ts`；唯一records/outbox/save-chain owner，R4 |

CX1／CX2不是原S9／S18已完成原檔的重複數字；它們是當前新量測達門檻的其他路徑。`summarizer.ts` 等未達舊候選門檻的本次變動檔仍須遵守新的維護性 gate，不能只檢查這18個名稱。

## 7. 一次開發、兩條驗收

每個單元同時對應一個 R階段、一個 S/CX拆分任務。實作紀錄包含：原責任→新module→public interface→唯一state owner→被替換的舊production path→語義驗收fixture。

1. 先建立受影響套件的基線和必要characterization；保持測試檔結構。
2. 純搬移可等價的部分先做結構提交，保留已知bug現狀作對照；新行為的修正／替換在另一個明確提交。若演算法替換不可純搬移，記錄新舊契約及故意改變的結果，不偽稱AST等價。
3. 功能gate驗證正確性；結構gate驗證責任分離、public exports、依賴方向、state owner、尺寸與可讀性。兩者缺一不可。
4. 既有原task suite／consumer gate仍是下限，另外跑新context fixtures；不因測試「太複雜」削弱權限、timing、assertion或reachability規則。
5. fresh GPT6.1Sol審查通過後，才在舊43檔台帳標reviewed；CX各自計數。完整candidate gate仍獨立，不能用局部pass覆蓋原FAILED。

## 8. 維護性 gate

- **一個子系統一個目錄，一個公開入口；每個狀態一個owner。** ContextEngine單一決策者不代表單一實作檔，也不能吸收storage、credentials、tool execution或child scheduler。
- 沿用工作目標：一般產品檔約150–400行、function/component通常不超過120行、組裝facade約150–250行。超過目標需要審查說明；>=800檔、>=250函式或>=18,000字元密集函式必須處理或給具體cohesive例外。
- 不按行號切檔、不把巨大closure搬成另一個檔、不靠壓縮成超長行過關；每個helper只接所需資料／操作，禁止把全部私有locals包成巨大`deps`穿透。
- 不新增循環import、跨子系統私有路徑import、重複Map／writer／retry counter；state生命週期和release順序列在README。
- 同步追蹤新增／改動產品檔，不讓本次的新engine、summary runner、validator、legacy importer成為下一輪大檔。
- tests／tool scripts維持排除；補有判斷力的驗收測試與必要路徑適配可做，不能為減行數重構測試。

## 9. 當前狀態

本輪完成範圍映射與設計框架，產品拆分完成數仍為27/43。規劃收編9個pending原檔＋2個新候選，5個partial依實際觸及責任記錄，2個原任務保持獨立。原完整事件驅動與AGENTS／CLAUDE計畫仍暫停；這次收編的是context必要的拆分，不宣稱那些功能已完成。
