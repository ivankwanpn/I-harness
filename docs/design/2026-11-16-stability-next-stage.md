# IH 下一階段修復決策

本文件由使用者於 2026-11-16 要求 Codex 審查接手成果後制定。請按以下順序繼續實作，沿用既有交接文件中的測試品質、Git 身分、證據保存及資源清理要求。

第一輪 selected-results 測試已重寫。下一輪從本文件的 P0 開始。

## 一、已核對的起點

- 工作目錄為 `D:\codex-ih-development`，參考目錄為唯讀的 `D:\ih-reference-project`。
- 分支為 `codex/runtime-stability-redesign`。
- 審查起點為 `2e0500ddb6689253d29c89bb687cd2868a9c27a9`，建立本文件前工作目錄乾淨。
- 最新完整測試記錄對應 `cf92d076`。原始日誌確認 82／82 packages、16,220 passed、215 failed、104 skipped，整體 verify:all exit 1。
- 該輪全庫型別、127 項 E2E、reachability、boundaries 及 compiled Gateway／Windows ACL 通過。
- `cf92d076` 之後另有 observed-settings 與 chat-stream-terminal-error 的測試修改，當前 HEAD 的最新完整測試總數仍待重跑。
- 最新 HEAD 的 CI run `43731288240` 已確認 success，actor 與 triggering actor 均為 `ivankwanpn`。
- 本次審查包含原始碼、差異、原始日誌、清單及 CI 核對。新增 production 風險尚待實際故障重現。

## 二、P0-A，補齊可核對的失敗清單

原始日誌回報 215 項失敗，但以下 JSON 的 94 列加總只有 184 項，差 31 項。

`C:\Users\IvanKwan\AppData\Local\Temp\ih-test-rewrite-handoff\verify-final2-file-failures.json`

目前清單與報告的 package 差額如下。

| Package | 日誌／報告總數 | 現有 JSON 加總 | 差額 |
| --- | ---: | ---: | ---: |
| apps/cli | 4 | 3 | 1 |
| context-output | 19 | 18 | 1 |
| desktop-gateway | 82 | 69 | 13 |
| guard-approval | 2 | 1 | 1 |
| session-executor | 101 | 87 | 14 |
| desktop | 1 | 0 | 1 |

先從既有原始日誌修正清單產生方式，檢查漏掉的檔案格式、整檔失敗、hook failure、重複輸出及統計口徑。每項需能追到實際檔案、案例或 suite-level failure 與原始日誌位置。保留原清單供比較。

同步核對 104 項 skipped 的逐項原因，以及相較舊基線 86 項的差異。原始 predecessor fixtures 曾需明確配置，將資料缺失、平台限制、環境權限及測試條件各自記錄。

驗收時清單加總需與原始 runner 結果對應。若 runner 的 suite／hook 計數口徑不同，列出可重算的對照。這一步使用現有日誌即可完成。

## 三、P0-B，審查新 target pins 修復的失敗與重試契約

優先審查 `7a15e67b` 的 production 變更，以及第一輪三個 selected-results 測試。

```text
packages/desktop-gateway/src/selected-fork.ts
packages/desktop-gateway/src/result-reader.ts
packages/desktop-gateway/test/host-commit-log-selected-fork.test.ts
packages/desktop-gateway/test/host-commit-log-selected-read.test.ts
packages/desktop-gateway/test/selected-fork-seed.test.ts
```

目前程式先建立 child，再分批 grant managed refs。每次 execute 都重新捕獲 source，grant 每批最多 100 refs。新測試已覆蓋真實內容、來源 archive／clear 及 target 冷讀取，還需要補驗原始操作的恢復語意。

按問題規模建立以下控制。

1. child 已建立後 grant 失敗，從正常 list／open／prompt 入口觀察 target，核對 READY 契約與持久化狀態。
2. 多批 grants 中途失敗，保留已完成部分及同一原始操作的恢復責任，重試後核對完整 membership 與效果次數。
3. grant 完成但 RPC ACK 遺失，使用完全相同 operation、target、requestDigest 重試，核對相同 seed、receipt 與選取結果。
4. begin 後 source 新增回合、結果或 metadata，再重試原 operation，核對首次捕獲結果的穩定性。
5. 已完成操作在 host 重啟與 source archive／clear 後重試。未完成操作亦測試可恢復與缺少依賴兩種結果，保留原始操作身分及明確 blocked／unknown 狀態。
6. 核對 source signal、host close、project binding 改變及 revoke 在 grant 前後的行為，包含清理失敗的原始責任。
7. 核對完整 ref、revision、digest 與 selected projection。現有 grant 只接收 ID，需確認其查找與不可變資料契約足以維持精確選取。
8. 有 managed rows 而缺少 retention port 時，核對 controller 的可用性與結果契約。
9. 有限 `selection.atSeq` 的案例需排除邊界之後的結果。目前 `captureSelectedResultsSeed` 建立 context 時使用固定 completed selection，先重現請求選取範圍是否被正確傳遞。

保留第一輪已修好的真實內容正向案例。優先重用現有 transfer、capture、receipt 與 owner 機制，讓正常入口及恢復流程共同成立。

`result-reader.ts` 的 ancestor fallback 仍存在。驗證目標本身的保留權限、來源清除後可讀性、完整 ref 匹配及歷史資料相容性，再依證據調整。

## 四、P1，修復掛起、持久化恢復及 Task 正常入口

依影響先處理以下群組。

### 掛起與未完成工作

優先處理 execution-fs-ack、resident-instruction-activation、fork-handoff。每項先用真實 constructor 與正常入口證明等待的位置，記錄持有的 action、publication、native handle、pending operation 及 cleanup 責任。

案例逾時只能先證明期限內未完成。根因分類需有等待關係或原生故障證據，並驗證測試結束後原工作已收尾。

### 持久化與工作接續

優先核對 managed-runtime-context、title-action、delivery-active-wait、delivery-lifecycle、service-instruction-close。

對照目前對 unknown publication、finished action、post-turn callback、通知保存及 cold reader 的既有契約，修復恢復順序與生命週期根因。錯誤碼變化需要從原始失敗一路追到公開結果。

### Task 與 child fixture

project-context、event-driven-steering、native-context-child、retained-*、owned-* 等案例，先核對 prepared Task caller、真實 coordinator、generation、child identity 及模型／工具建構是否完整。

IH 先前已有真實 DeepSeek Flash 父子 Task 與 native C67 成功記錄。`Original prepared task caller unavailable` 或 agentTable 為空，需要從當前正常入口追查，才可判定缺少產品能力或 fixture 已失效。

沿用確實存在的 factory／constructor seam，對每個共用根因建立一個有效正向案例及相應負向控制，再擴展到同類測試。

## 五、P2，按專用公開 route 完成 issue 125

上一輪報告提出 JSONL child-birth adapter。現有程式已具備專用公開 selected-results route，本輪整合以這條路徑為起點。

已核對的現有介面如下。

```text
packages/session-persistence/src/coordinator/selected-results-route.ts
  protocol = public-results-v1

packages/desktop-gateway/src/context-runtime.ts
  createSelectedSourceHolder(operation)

holder.captureFirst()
holder.publishWarm()

packages/session-persistence/src/selected-source-owner.ts
  inspectColdSelectedTarget(...)
  beginColdSelectedFinalization(...)

packages/desktop-gateway/test/helpers/native-consumer-fixture.ts
  forkSelected(...)
  restoreSelected(...)
```

private Task child birth 與 public selected fork 各有原始 request、route 與 admission 契約。公開整合需沿用已存在的 public route、原始 holder、V2 DTO、選取範圍與 cold qualification。

實作前閱讀現有 SDK server／client 與 Gateway controller，確認公開請求、同 operation 重試、取消、關閉及錯誤回覆的正常路徑。能共用的資料驗證與生命週期沿用既有實作。

經真正 Gateway／SDK 入口驗證以下完整流程。

```text
child 產生結果
→ compaction
→ reset
→ cold resume
→ selected-results V2 fork
→ 精確內容讀取與搜尋
→ source clear／retire
→ target cold qualification
→ 再次精確讀取
```

保留普通工具及 Code Mode 的既有正向要求，補上不確定 ACK、相同 operation 冷重試、部分失敗與正常關閉。commit-log 與 JSONL 的公開語意及既有 V1 相容性一併回歸。

## 六、P3，驗證負載敏感案例與剩餘完整回歸

單獨通過的案例先記為負載敏感或原因未定。兩次不同 HEAD 的結果差異需要核對來源差異、執行環境及待完成工作，才可判斷回歸或偶發性。

針對 selected-native-source、usage-protocol-aux-host、interaction-resume、current-unfinished-catalog、retention-grants 等，使用相同固定來源比較單 worker 與既有兩 worker 執行，保存全部失敗與清理結果。

效能群組包含 legacy-funding-batch、legacy-fork-scale、legacy-fork-performance 與 10,001 observations。分別量測 fixture 成本、實際原生工作、反覆驗證及逾時收尾，再作最小修復。

逐批完成後重跑相關完整檔案與 package。根因收斂後，在固定 HEAD 與 source／test 雜湊下執行一次完整 verify:all，所有 82 個 package 均須有明確結果。保持單一大型測試／型別編譯工作，排除 dev 啟動的重疊負載。

## 七、執行與交付要求

- 主責實作者繼續處理上述工作，Codex 保留有限額度作關鍵設計及證據審查。
- 使用原交接中的 environment wrapper、正常入口、原生故障注入及 Git 身分核對方式。
- 每批交付原始失敗、修復、反向控制、完整檔案結果、型別結果、source 版本與證據位置。
- Production bug、fixture 問題及環境條件分別寫明根因，保留所有尚未確認事項。
- 同步更新現有報告及 checkpoint 的版本、完整基線、完成項目與下一步。active 下的舊 109 commits、舊基線及 editsStarted=false 等欄位需要按實際狀態整理。
- 本次新增決策文件及審查註記可與下一批適當提交。沿用 `ivankwanpn <213307026+ivankwanpn@users.noreply.github.com>`，推送後核對實際 SHA 與 CI 範圍。
- 額度與時間優先用於實作、定向驗證及明確根因。對話回報摘要，完整資料寫入原有證據目錄。

下一次提交報告先交付 P0-A 的完整對帳，以及 P0-B 實際重現與修復結果，再依序繼續 P1 至 P3。
