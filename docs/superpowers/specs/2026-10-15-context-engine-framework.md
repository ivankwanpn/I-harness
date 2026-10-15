# ContextEngine 完整開發框架補充

2026-10-15 使用者補充：接受必要開發複雜度，優先正確性、規律及完整設計；本次重構與原拆分重合的責任應合併交付。此文件是[主設計](2026-10-15-context-engine-redesign.md)的規範補充。仍是設計階段，不把提案或目錄地圖當作已實作。

## 1. 決策原則

不以工期、修改檔數或少寫抽象作為省略可靠性機制的理由。複雜度要落在明確資料型別、狀態機、狹窄port、版本化儲存與驗證矩陣裡。保留必要能力，移除重複owner和無界重試；每個非採納的參考機制需說明語義／相容性理由。

上一份設計已吸收五個來源的主要優點，但來源比較不等於執行規格齊備。本補充固定以下ownership、retry、summary與delivery契約；每階段開始前再以具體型別／fixture／舊路徑退出條件完成執行計畫。

## 2. 採納追蹤：優點→IH落點→必須守住的條件

| 參考優點 | IH責任落點 | 不變條件 | 驗收ID／階段 |
| --- | --- | --- | --- |
| Codex的rollout與ContextManager分離、完整replacement checkpoint | core-session projector／snapshot；ContextEngine commit port | 同一checkpoint＋accepted suffix的live/cold結果一致，archive不直接變成prompt | **F01 checkpoint-resume**，R1/R3/R6 |
| Codex live-clone truncation；OpenCode完整structured output＋preview | result ingress、output-retention、context-output | outcome與完整結果保存，preview/page總量受限；發布durable ref前先確認儲存 | **F02 retained-results**，R4 |
| DSH replacement surface與有序block／原生sidecar | semantic exchange、adapter replay | keep/drop/reorder同步作用於內容及sidecar；原生狀態不越過ownership | **F03 ordered-replay**，R1/R2 |
| DSH縮減進度；ZCode microcompact→summary | ContextEngine reduction／assessor；summary port | changed、hard-fit、target-ready分開，縮減後使用同一request重測 | **F04 reduction-progress**，R3 |
| ZCode prospective history＋usage anchor | snapshot、token-meter、adapter.prepare | 新human/steer/child input、最新system/schema/media/route option都納入；anchor按語義prefix判定 | **F05 prospective-budget**，R2 |
| PI branch/checkpoint/tail與context edits | projector／legacy importer／snapshot | 已失敗片段不進prompt；近期tail保留型別；rewind不回復已丟棄的原生權威 | **F06 branch-projection**，R1/R2 |
| PI原生簽名；DSH共用內容＋protocol escape hatch | llm-seam能力契約、各adapter | 共用內容不抹除native state；opaque-only不相容時blocked | **F07 protocol-compatibility**，R2/R3/R4 |
| OpenCode V2 context epoch、durable admission先於wake | session-executor／subagent delivery | durable result與context promotion分開；重送wake不造成重複claim；Stop/rewind有處置 | **F08 delivery-epoch**，R4/R5 |
| OpenCode logical call與physical attempt；DSH/ZCode有類型重試 | execution attempt ledger、recovery、transport | 一個總額覆蓋主／摘要／恢復與下層retry，已派工具不重跑 | **F09 attempt-ledger**，R3/R5 |
| 五者archive與有效window分離，及其未解決的計量缺口 | BudgetPolicy、adapters、共享UI DTO | tokens／bytes／usage／cache／billing明確區分；UI不prepare/auth/send | **F10 measurement-domains**，R0/R2/R5/R6 |

採納的具體來源位於[研究附件](../../research/context-redesign-2026-10-15/README.md)。不照搬的項目包括：Codex私有遠端能力當通用API、15MiB metadata軟預算當通用硬limit、fail-open的壓縮／spill、未計入新input的提前計量、文字化typed tail、無條件413=token overflow。這些排除是為了語義正確，不是節省實作。

## 3. 依賴方向與唯一owner

以下箭頭表示「左邊可以依賴右邊」，contract-only引入明列為type-only：

```text
core-session                     -> 基礎資料／事件工具；不依賴執行／provider／UI
token-meter                      -> core-session 的資料契約
llm-seam                         -> core-session + token-meter 的契約／primitives
llm-* adapters                   -> llm-seam + token-meter
context-engine                   -> core-session + token-meter + llm-seam contracts
compaction summary implementation-> context-engine/contracts (type-only) + llm-seam
core-agent                       -> context-engine + tools/執行抽象
session-executor composition     -> core-agent + compaction + provider binding + persistence
subagent/team                    -> executor提供的窄介面＋自身任務owner
SDK/gateway/Desktop              -> 已發布DTO與application service；不參與容量決策
```

`context-engine`不反向import `core-agent`／`session-executor`／`subagent`／Desktop，不import具體`llm-*`或`compaction`實作。由composition root注入summary、preparation、artifact與checkpoint ports。`compaction`移除自己的production admission owner後可留相容facade，不能一面由engine呼叫、一面反過來構造另一個engine。

| 權威狀態／副作用 | 唯一owner | ContextEngine可以做／不能做 |
| --- | --- | --- |
| 原始事件、seq、branch、exchange identity | core-session資料及persistence coordinator | 讀取／提出manifest；不另造raw log |
| Session lease、generation、lifecycle、durable publication | session-executor＋persistence writer | 經fenced port提交；不直接開JSONL、管lock或重試storage |
| 可重建active snapshot／reduction candidate | ContextEngine | 持有derived cache與transaction state；非第二份durable真相 |
| provider client、auth、endpoint/account identity | provider-runtime／credentials | 只接resolved identity與adapter port，不讀token或刷新帳戶 |
| protocol encoding、原生回放檢查、physical transport | 各llm adapter／transport | 要求prepare／validate／send；不拼各家JSON或重試socket |
| model action/physical attempt allowance與接受狀態 | executor-owned attempt ledger | 申請有限額attempt／提出recovery；不自建獨立retry budget |
| tool dispatch與實際outcome | core-agent/tool executor | 消費committed facts，不能執行或重播工具 |
| artifact儲存、ACL、retention/GC | output-retention／對應store owner | 解析ref或要求retention；不實作GC或繞過scope |
| task settlement、outbox/inbox、claim/wake | subagent/team＋executor delivery | 把已接納fact加入snapshot；不成為child scheduler |
| 觀測及UI | SDK/gateway/renderer | 只讀scalar DTO，不觸發模型工作 |

Standalone公開API若使用in-memory實作，必須明示不具跨程序恢復保證；shipping CLI/Desktop/main/child必須由assembly注入durable owner，不能靜默降級。

## 4. ContextEngine內部目錄與port邊界

```text
context-engine/src/
  index.ts                         公開factory與type exports
  contracts/{snapshot,policy,ports,decisions}.ts
  snapshot/{build,protected,revision,compatibility}.ts
  admission/{assess,pressure,certification}.ts
  reduction/{plan,preview,tail,progress}.ts
  transaction/{capture,run,validate,publish}.ts
  recovery/{classify,plan,progress}.ts
  observation/{view,diagnostic-facts}.ts
```

這是責任邊界，不要求每個檔案預先創空殼。只建立有實際使用者的模組；相近純邏輯可合併，但不能把整個runtime移成一個巨型`run.ts`。

窄port的必要契約：

- **PreparedRequestPort**：輸入snapshot revision、binding identity、request purpose與generation policy；輸出immutable prepared handle、semantic/wire identities、measurement與validation facts。副作用free的prepare與有attempt許可的physical send分開。
- **SummaryPort**：輸入固定source groups＋coverage manifest、current summary、摘要限制和共享attempt lease；輸出complete/blocked及source coverage。不能改session、發布checkpoint、派工具或自己重新觸發compaction。
- **CheckpointPublicationPort**：輸入expected branch/owner generation/source revision、candidate manifest及accepted suffix接合規則；輸出committed receipt、stale或commit-unknown。writer負責compare-and-append/flush；uncertain時先按transaction ID查詢durable結果，不盲目再append。
- **ArtifactPort**：輸入owner/scope/ref/revision和明確讀取預算；輸出bounded page或retention狀態。路徑本身不授權，不因存在ref就全量讀回prompt。
- **AttemptLeasePort**：每次physical model/count request先取得有限額reservation，送出前再次檢查fence；settlement只更新同一attempt，不因換HTTP/WS或wrapper重置次數。
- **ContextObservationPort**：讀immutable scalar view，不帶provider實作或callback，不能產生prepare/auth/count/model call。

每個port在執行計畫要固定input/output union、error codes、同步/async邊界與owner；禁止以`any`或整個Assembly/SessionService當作port參數。

## 5. 共享attempt ledger與串流接受邊界

一個logical action對應一次主模型response step及其admission／summary／recovery，具有穩定actionId，不是整個長session。上一step接受並完成必要結果提交後，正常工具續接才產生新的logical step；retry不能靠新建actionId重置額度。每個main、summary、changed-input recovery、SDK retry或WS→HTTP fallback的實際模型請求有不同attemptId和cause/parent。生成請求共享有限的action allowance與deadline；保留現有summary最多8次的子上限，子上限不能增加總額。Provider count屬非生成准入工作，使用明確獨立且有界的count allowance並記錄；不能隱藏在UI讀取或生成retry裡。

下層SDK內建retry必須停用或接同一ledger；transient等待／backoff不刷新總額；恢復是新attempt、同logical step，不重新claim輸入或派工具。跨重啟遇到已reserved但是否送達未知的attempt採保守耗用，不能當作免費新額度。這是控制請求次數，不假裝等於供應商計費成功次數。

串流資料先作observation；只有合法完成／明確接受的response exchange可進有效context。Tool dispatch必須在response接受、call identity與授權持久確認後進行；本次不引入邊串流邊投機執行工具。已dispatch後失聯，結果是settled或unknown，不能用模型retry重播effect。部分文字可以在UI顯示但失敗後不得作已接受答案偷偷回放。

F09必須涵蓋：first delta前、文字後、tool call完整但未dispatch、dispatch後、result flush後、response commit後的失敗；每個位置都測同一attempt ledger、可恢復狀態與零重複effect。

## 6. Summary source超限不得遞迴壓縮自己

共用assessor不等於遞迴共用整個orchestrator。Request purpose區分main／summary／count／recovery；summary admission需要reduce時，只能在既有transaction內做有限source分段／分層summary／已授權artifact預覽，或回blocked。

每個piece有source group IDs、covered/omitted ranges與低權限derived provenance；不可把未概括區段當作已概括。所有piece／merge使用同一attempt與deadline上限，不能每層重置8次，也不能取得自己的session lease或發布中間summary為正式checkpoint。最後一次候選仍經目標主模型完整prepare與准入。

F04涵蓋超大summary source、單一不可分割group、schema／system已佔滿、summary-of-summary、上限耗盡及中途Stop，保證有限終止、保留原snapshot與可取的失敗原因。

## 7. Child result與branch／epoch處置

結果持久保存和加入目前上下文是兩件事。Task保存spawning branch、delegation identity與result revision；parent rewind或context epoch變更後，結果仍可查，但promotion要有明確處置：promote、defer、already-claimed、incompatible。不能因重建context再claim，也不能將舊分支結果當新分支授權。

沿用主設計的logical admission key；另記目標context epoch與disposition，不以改key方式讓同一結果偷偷變成新交付。重新授權／重新交付是可追蹤的明確操作。Wake只是提示，可以重送，觸發時重新檢查owner fence、Stop與epoch。尚未消費但已接納的結果必須被snapshot後綴保留或有明確deferred狀態。

F08涵蓋rewind在settlement／admission／claim前後、crash在durability／wake之間、summary期間多child完成和重複wake。預期durable result不遺失，不越權注入，不雙claim、不重跑工具。

## 8. 與舊拆分任務合併

規範映射：[拆分重合地圖](../../refactoring/2026-10-15-context-decomposition-overlap.md)。本次建議整組完成S20/S21/S22/S23/S25/S28共9個pending原檔，部分重合S24/S27/S29/S30/S31不冒算整組完成，S26/S32保持獨立。新增CX1 JSONL backend與CX2 task registry另計；已完成拆分的骨架只做必要變更及回歸，不重算完成數。

一般產品檔150–400行、函式通常<=120行、facade150–250行為review目標；大型／高密度候選有具體責任分解或具名例外。新ContextEngine同樣受管，不豁免。每個責任列唯一owner、窄介面、import方向與退出的舊路徑；跨子系統只用public entry，禁止全locals袋與utils堆積。

## 9. 完整開發節奏與放行條件

1. **契約先行**：每個R單元先具體化types、state transitions、authority／failure、compatibility matrix、S/CX映射及獨立fixture oracle，審查後才實作。不能以「框架已畫圖」取代介面定義。
2. **結構與行為分開追蹤**：在同一交付單元內先做可驗證的責任抽取，另commit新行為；不可等價的替換明示差異。所有權／次序／既有測試基線保留。
3. **測試對錯誤有判斷力**：RED/GREEN針對實際不變量；多協議golden request、crash-cut／race、生成序列的property/state-machine測試與counterexample保留。不能用同一個estimator生成expected再自證。
4. **每單元雙驗收**：功能正確性＋結構維護性；fresh GPT6.1Sol審查，單一product writer避免共享owner並行改寫。每個實作任務有可獨立拒絕的交付物，不為省review把所有核心一口氣重寫。
5. **舊路徑必須退出**：新owner啟用時刪掉原production決策或只留無狀態facade；不得長期雙寫、兩套retry計數／budget互相兜底。
6. **整合後驗證**：各R單元、consumer gates、原S門檻、全範圍typecheck/reachability、固定HEAD整體測試與實際packaged runtime。真實provider小控制須在相應授權與非私密fixture下進行，不能以離線假模型聲稱線上已驗證。
7. **發布以證據為準**：舊FAILED仍列出，沒有相應成功證據不能宣稱release ready；設計、程式已完成、測試已通過、已打包／已發布分別報告。

不為設計完整度承諾零bug；以可重現、可審查、可故障注入、可恢復的機制降低回歸。尚未固定的policy數字在對應R0/R2 fixture與model route限制核對後才定值，不能臨場憑感覺散落在多個模組。
