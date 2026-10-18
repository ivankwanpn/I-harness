# ContextEngine R4A external implementation delivery — 2026-10-19

狀態：**UNACCEPTED。R4A 第一批由外部實作者（deepseek-flash-1017）部分完成，等待 Codex 功能＋結構驗收。** 本文件不含接受、合併、標籤或發佈聲明；產品工作已停在本次 checkpoint。

## 1. 固定起點與交接核對

| 項目 | 值 |
| --- | --- |
| Workspace | `D:/I-harness-main` |
| Branch | `codex/v0.1.13-development` |
| 交接 HEAD | `f362c6387a40fbb8d4a0e60184c3040e9f01d5fb` |
| 產品 WIP commit | `81917360215c17ca00e5a9df4c312bd8f9056f3e`（ancestor of HEAD） |
| 完整 R4A 比較 BASE | `91d8fef04253272a437c68f5f2f84a657fa53d3b` |
| 產品版本 | `0.1.13-rc.1`（未改版） |
| 接手時 dirty files | 無（`git status --short` 空） |
| Node | v24.15.0（`C:/Program Files/nodejs/node.exe`） |
| 本批新 evidence | `.tmp/context-r4a-external-20261019/`（`logs/`、`scripts/`、source manifests） |

既有證據原樣保留、未被覆寫：

- `.tmp/context-r4a-evidence-20261018-a/`：847 個檔案，receipts 001–227 完整可讀。
- `.superpowers/sdd/2026-10-18-context-engine-r4a-retained-results/`：29 個檔案（handoff、product paths inventory、root 核對報告）。
- 未重做 R0–R3；未從 BASE 重寫；未 reset／clean／clone 覆蓋。

接手當下先跑交接文件列的 focused 範圍（無產品修改），全部 pass：

| 檔案 | 結果 |
| --- | --- |
| `session-executor/test/retained-state-cold`、`retained-child-flow`、`retained-child-scope` | 6 passed |
| `subagent/test/retained-task-body`、`retained-task-cold` | 5 passed |
| `desktop-gateway/test/session-subagents`、`retained-catalog-io`、`retained-result-publication-proof`、`subagent-protocol-header` | 31 passed |

## 2. 本批實際完成

### A0 — 接手與安全檢查點（完成）

- 核對 branch／HEAD／dirty／WIP ancestry／BASE，均與交接檔一致；沒有其他使用者的修改需要並列。
- 建立新的 evidence 目錄與可重現 runner：每個 receipt 記錄 label、repoRoot、cwd、完整 argv、Node/platform、start/end、duration、exit code、完整 stdout/stderr、stdout/stderr SHA256，以及產品 source before/after manifest（4596 個 apps/packages 檔案，逐一 path/bytes/SHA256 + 聚合 digest）。
- 逐項對照原 R4A A1–A10 與 ruling（見 §4），把「已有 source-scoped 證據／本批待做／最後 source 待重驗」分開；不把 171 等舊 source 控制直接勾成最終 pass。

### A1 — current／cold 讀取與完整責任收束（完成本批範圍）

RED → GREEN 修正（都在原 owner 內，不另造 completion 權威）：

1. `packages/subagent/src/task/validation.ts`：task 文件只驗 result，未驗 publication／savedObservation，與 state mirror 的 closed descriptor 不一致。現在 v1 帶任何 result／publication／savedObservation 一律拒絕，v2 每列都走同一 `validResultPublication`，偽造 `future-confirmation`、缺 savedObservation 的 `unqualified`、非法 status／execution 都在真正 restore 入口被拒。
2. `packages/subagent/src/task/registry.ts`：冷讀取曾在**沒有 result owner** 的組合下把 artifact-backed 列標成 `durable`（readResult 實際不可用）。現在只有本次組合真的有 reader 才標 durable；否則 `failed` + `RetentionError`，且 re-save 保留原 `formatVersion: 2`、原 result revision/ref，不降版、不丟 descriptor。

新增反例控制（沿用真實 coordinator／restore／tool 入口，不建 stub projector）：

- `packages/subagent/test/retained-task-negative.test.ts`
  - 偽造 task publication／savedObservation → 於 restore 入口 throw（原本 GREEN 前為 RED）。
  - 無 result owner 冷讀取的 re-save：v2 與原 descriptor 保留、retention 誠實標示（原本誤標 durable 為 RED）。
- `packages/session-executor/test/retained-state-negative.test.ts`
  - 已提交的 original parent fact → `completed`（control）。
  - **rewind**：committed `subagent/end` 落在 rewind cut 內 → job/table 一律 `recovery-required`、`publication: unqualified`、execution `{unknown,unknown}`，savedObservation 原樣保留，不新增 job/status 或 subagent/end fact。
  - **current followup**：較新的 `job/status` running（不同 revision）→ 同一個 old revision 不得當成功。
  - state 文件 literal1／current2／future3、legacy 帶 result descriptor、偽造 publication／savedObservation 的實際 restore fence。

read 契約反例（既有 fixture 已覆蓋，本批复查）：wrong `revision`／`refRevision`／`refId` 拒絕、非 advancing page、UTF-8 邊界、child preview ≤ 2048 serialized bytes、report ≤ 16384。

真實 consumer 對照：model（`get_task_output` + `full_result` page）、Desktop UI（`RetainedChildBody` 逐頁 encoded JSON，`desktop/test/subagent-pane.test.tsx`）、Gateway catalog/history（`session-subagents` 系列）、SDK/read API（`readResult`）。三者都只吃 bounded page／preview，不自行解析完整 body。

### A2 — 背景 exec 與完整依賴生命週期（完成本批核心）

問題：背景 job 的 frame capture 只在有人呼叫 `get_task_output`／`listJobs` 時才被 observe；且 `observe` 依賴當下的 tool producer AsyncLocalStorage，背景完成時已不在原 tool 呼叫內，因此真實 shipping 路徑不會自動保存，也拿不到同一個 ref。

修正：

- `packages/exec/src/capture/frames.ts`：`ExecResultRetention.observe` 改為回傳 `Promise<ExecFrameObservation>`（`ready` 帶該 source 的 `ResultDependency`，或 `recovery-required`）。
- `packages/session-executor/src/lifecycle/exec-result-retention.ts`：在 `begin()` 綁定原始 producer/binding，`observe()` 用該原始身份（而非稍後的 ALS 狀態）註冊與結算；同一 capture 只有一個 dependency handle、settle 由 capture 自身 coalesce，不會二次提交。
- `packages/exec/src/jobs/{contracts,records,views}.ts`、`packages/exec/src/index.ts`：背景 job 在 `capture.complete` 後**先自動 settle** 再一次發布 terminal view；`BackgroundJobView` 增加 `retained`（同一 source/ref/revision）與 `retentionFailure`（明確拒絶，不假裝有 ref）。`dispose()` 在關閉 host 前 join 所有已開始的 capture 與其 settlement。

新控制 `packages/session-executor/test/retained-background-exec.test.ts`（真實 assembly＋真實 pwsh tool＋真實 process）：

- startup gate：tool receipt 已回傳 `job_id`、process 尚未 EOF 時 job 仍 `running`、`retained` 尚不存在。
- 只靠 `subscribeJob`，**全程未先查詢 output**，terminal view 就自帶已提交 artifact dependency（證明不是 lazy query 才保存）。
- 獨立 expected bytes：stdout `A\0😀`、stderr `ff 00 7f`，逐筆比對 channel/frame/offset/end，raw bytes 與 digest 與獨立 oracle 相同；cold page 讀回 digest 等於 ref.contentDigest。
- 之後任何 `getOutput` 回傳同一個 ref（JSON 完全相同）。

RED 證據：把 6 個 A2 產品檔暫時還原到 HEAD 後重跑同一測試 → `Expected automatic artifact settlement: {}`（terminal view 完全沒有 retained）。patch 還原後 GREEN。

### A3 — Code Mode emitted output（**未完成，維持原狀**）

`packages/code-mode/src/runtime/output.ts` 與 `session-executor/src/context-output.ts: createNativeCodeTextRetention` 仍走舊 optional capture／`context/result-ref`／`createUnifiedSpillStore` fallback。本批沒有改動此路徑，原因與具體缺口見 §5。既有失敗 receipt 原樣保留。

### A4／A5 — 部分（見 §5、§6）

- Session format 10／literal 9、8 讀取／owned upgrade／future 11 拒絕已在 source（含 journal predecessor 分支），本批未改動；auxiliary TaskProtocolDocument／SubagentStateSnapshot v1/v2/future3 由 A1 補齊 closed validation。
- MCP bridge、compaction retained-context、media/native wrapper 的完整 producer→reader 對照、fresh-host crash cuts 沒有在本批新增控制；列為未完成。

## 3. 實際測試與 typecheck（本批）

所有 receipt 在 `.tmp/context-r4a-external-20261019/logs/`，格式見 runner；下列為 label → exit／範圍。

| label | scope | 結果 |
| --- | --- | --- |
| `a1-session-executor-baseline` | 交接 focused（修改前） | exit 0，6 passed |
| `a1-subagent-retained-and-protocol` | retained-task-{body,cold,negative} + task-protocol/task-control/persist/projection/model-display | exit 0 |
| `a1-gateway-retained-suite` | session-subagents、retained-catalog-io、retained-result-publication-proof、subagent-protocol-header、subagent-host、subagent-settings | exit 0 |
| `a2-exec-suite` | `packages/exec` 全部 test | exit 0 |
| `a2-output-retention-suite` | `packages/output-retention` 全部 test | exit 0 |
| `a6-context-output-suite` | `packages/context-output` 全部 test | exit 0 |
| `a6-core-tools-suite` | `packages/core-tools` 全部 test | exit 0 |
| `a2-executor-retained-and-code` | retained-* 全部、native/managed context output、service-output-spill、retention-grants、search-code-mode | **exit 1：8 failed / 45 passed**（與 HEAD 基線相同，見 §5） |
| `a6-session-executor-full` | `packages/session-executor` 全部 test | 見 §3.1 |
| `final-a1-subagent` | commit 後重跑 retained-task-{body,cold,negative} + task-protocol | exit 0（source digest stable） |
| `final-a1a2-executor` | commit 後重跑 retained-state-{cold,negative}、child-flow/scope/pins、exec-flow、background-exec、result-flow、hook-{recovery,stop} | exit 0 |
| `final-types` | commit 後 `session-executor` `tsc --noEmit` | exit 0 |

Typecheck（`tsc --noEmit`，各 package cwd）：subagent、session-executor、exec、context-output、core-tools、core-session、output-retention、desktop-gateway 全部 **exit 0**。

### 3.1 完整 session-executor 套件（含 HEAD 基線比較）

| 來源 | Test Files | Tests |
| --- | --- | --- |
| 本批 source（`a6-session-executor-full`） | 22 failed / 63 passed (85) | **65 failed / 377 passed (442)** |
| 未修改 HEAD 基線（`a6-session-executor-full-head-baseline`，排除本批 2 個新測試檔） | 22 failed / 61 passed (83) | **67 failed / 370 passed (437)** |

兩邊失敗檔案集合相同（22 檔）；逐檔比較只有兩個差異，且都是既有 flaky 清理邊界：

- `test/code-mode-children-close-boundary.test.ts`：本批 source 在滿載全套件中失敗一次；單獨重跑 3 次為 1 failed / 2 passed，錯誤是 `Session service process cleanup incomplete … Managed facts require reconciliation`。
- `test/code-mode-children.test.ts`：基線全套件失敗，本批 source 全套件通過。

結論：**本批沒有可歸因的新失敗**；滿載下的 child close/cleanup 邊界本身不穩定，屬既有問題。其餘 65 個失敗集中在 sandbox／terminal／shell／rendering-free 環境依賴與 A3／A4 的舊 context-output 路徑（見 §5.1）。

## 4. A1–A10 對照

| ID | 本批狀態 | 證據／缺口 |
| --- | --- | --- |
| A1 full-result scope | 既有 source 控制（035 1MiB／070 100MiB）為歷史 source，本批未重跑；背景 exec 新增 1MiB 級 frame 控制 | `.tmp/context-r4a-external-20261019/logs/a2-*`；舊 035/070 仍只代表當時 source |
| A2 truthful no-fit | 既有 quota／refusal 控制保留；本批新增背景 `retentionFailure` 不假裝 ref | `a2-executor-retained-and-code`、`a2-exec-suite` |
| A3 once-only recovery | 本批未新增 cut；既有 197–210 保留 | 未補 |
| A4 program/media | 既有 172/178/182/188/189 保留；本批未新增 | 未補 |
| A5 durable pins | 既有 120–132 保留；本批未新增 | 未補 |
| A6 bounded integrity | 既有 managed-artifacts/exec-frame-pages 保留；100MiB page-I/O 未在最終 source 重跑 | 未補 |
| A7 fan-in | 171 為舊 source；最終 source 未重跑 100-child | 未補 |
| A8 compatibility | session format 10／9／8／11 已在 source；auxiliary v1/v2/future3 由本批補齊並加反例 | `a1-*` receipts |
| A9 actual consumers | model／Gateway／Desktop UI／read API 對照完成；MCP、search/export、compaction 未全數複查 | 部分 |
| A10 structure/evidence | 新 evidence／runner／source manifest 完整；S25／CX2 對照見 §6；gateway/CLI build 與 verify-dist pass、source→copy byte-identical；reachability gate 仍有 6 個交接 WIP 既有的 unused-export（§7） | 部分 |

## 5. 已知失敗與未完成（原樣保留）

### 5.1 既有 RED（本批未修，與 HEAD 基線相同）

`packages/session-executor` 中以下 8 個測試在**未修改的 HEAD** 也一樣失敗（本批用同一命令在 revert 後重跑確認；不是本批 regression）：

| 測試檔 | 失敗數 | 內容 |
| --- | --- | --- |
| `test/native-context-output.test.ts` | 1 | shell 完整 stdout/stderr capture 仍期待舊 `contextRef` envelope 形狀 |
| `test/search-code-mode.test.ts` | 4 | mounted search／stop 仍期待舊 text retention 描述子 |
| `test/service-output-spill.test.ts` | 3 | 仍斷言舊 spill guard 的 `output.spill/outputPaths` 形狀 |

處置：**未修**。這是 A3（Code Mode emitted output 退出舊 optional capture／spill）與 A4（剩餘 consumer 切換）的具體缺口；不得把它們重標成 pass，也不能靠改斷言遷就舊行為。

### 5.2 A3 具體未完成項

1. `runtime/output.ts`：`retainText` 缺失時仍 fallback 到 `createUnifiedSpillStore()` 寫檔（fail-open、無 owner、無 quota）。
2. `createNativeCodeTextRetention`：仍用 `service.capture(...text...)` 的 legacy optional capture＋`context/result-ref`，非新的 `ResultEnvelope`／`beginResult` artifact；同一份完整文字因此有第二份保存。
3. 未有 `code/output`／`code/result` 的新 envelope contract 與 projection 切換，也沒有 normal/restricted child mount 的雙覆蓋控制。
4. 必要反例（引號／反斜線／NUL／emoji／unpaired surrogate、UTF-16 pair 截斷邊界、unknown receipt 重試）未新增。

### 5.3 A4／A5 未完成項

- MCP `structuredContent`／`isError`／ordered text+media／resource／普通同名字段的實際 producer fixture 未新增。
- search／export／history 的「只讀、不建 child／assembly、不 auth/prepare/wake」跨 scope 反例未新增。
- fresh coordinator／host 的 artifact-committed-fact-unissued、partial/unknown fact issue、fact-committed-receipt-lost、local install failure 四種 cut 未新增。
- literal9/8→10 的 owned upgrade／append／reopen 在最終 source 未重跑（source 已有實作與既有測試）。
- 100MiB page-I/O、100-child fan-in、1MiB／100MiB 普通與 exec 都沒有在**最終 source** 重跑。

## 6. S25／CX2 責任對照

| 原檔 | BASE 行數 | 現況 | 本批判定 |
| --- | --- | --- | --- |
| `desktop-gateway/src/session-subagents.ts`（S25） | 314 | 19 行 facade + `src/subagents/{catalog,changes,control,read,result-proof,scope,types}.ts`（416 行，7 檔） | 結構完成；live/durable identity、context read、lineage、結果與父子可見性仍走同一 owner。本批未改此目錄，只跑其控制 |
| `subagent/src/task-protocol.ts`（CX2） | 438 | 5 行 re-export + `src/task/{types,registry,result,publication,validation,settlement,notifications,persistence,recovery}.ts`（677 行，9 檔） | 結構完成；唯一 records/outbox/save-chain owner 保留。本批只在 `validation.ts` 補 closed publication validation、在 `registry.ts` 收斂 restored retention |

原 27/43 進度、9 個重合原檔與 renderer 拆分都**沒有**因本批改動而重新計分；上述兩項只記錄實際 owner 與本批增量。

## 7. Copies／打包（A6 部分）

在最終產品 source 上，用全新 out 目錄：

| 命令 | 結果 |
| --- | --- |
| `node packages/desktop/scripts/build-gateway.mjs --out .tmp/context-r4a-gateway-20261019-075731` | **exit 0**，242 packages shipped |
| `node scripts/build-dist.mjs --out .tmp/context-r4a-cli-20261019-075731` | **exit 0**，`ih.mjs` 6,743,847 bytes，36 個 dynamic .ts import 警告（既有） |
| `node scripts/verify-dist.mjs --out .tmp/context-r4a-cli-20261019-075731` | **PASS**（含 `--version`、bare launch、help、`__dist-selfcheck`、acl runner、sdk NDJSON initialize） |
| `node scripts/audit/check-reachability.mjs --gate` | **exit 1**：6 個 NEW `unused-export` row（見下） |

Source→copy 對照：8 個本批修改產品檔在 gateway copy 內 byte-identical（`.tmp/context-r4a-external-20261019/source-copy-map.json`）：

```text
packages/exec/src/capture/frames.ts                               match=True
packages/exec/src/index.ts                                        match=True
packages/exec/src/jobs/contracts.ts                               match=True
packages/exec/src/jobs/views.ts                                   match=True
packages/exec/src/jobs/records.ts                                 match=True
packages/session-executor/src/lifecycle/exec-result-retention.ts  match=True
packages/subagent/src/task/registry.ts                            match=True
packages/subagent/src/task/validation.ts                          match=True
```

CLI bundle `ih.mjs` SHA256 `42e891038aa008c45ca7c4db955b86ed49013744c869d10fb1d7ab290d179429`，且 bundle 內含本批新增的 `retentionFailure` 欄位（line 58226），證明不是用舊 source 打包。

Reachability gate 的 6 個 NEW row 全部是交接 WIP 既有的公開 export，本批沒有新增或刪除這些 export：

```text
new unused-export @i-harness/core-session#ExecFrameRecord
new unused-export @i-harness/core-session#JsonStreamOptions
new unused-export @i-harness/core-session#validResultEnvelope
new unused-export @i-harness/output-retention#ExecFrameCaptureOptions
new unused-export @i-harness/output-retention#ResultCaptureOptions
new unused-export @i-harness/output-retention#createOutputSpillGuard
```

未做（明列限制）：沒有在 packaged Gateway／CLI 上跑 normal result／background／Code output／child result／Stop／legacy upgrade／cold read 的完整 real-entry 流程；只做了 build、verify-dist 與 bundle 內容核對。這屬 A6 尚未完成的 packaged qualification。

## 8. 未測限制

- 本批所有測試都在 Windows／Node 24.15.0、以 repo 內已安裝的 vitest／tsc 執行；未做 Linux／WSL qualification。
- 未讀取真實憑證、未連線任何 provider、未操作使用者正在跑的會話或程序；renderer 的 Node/browser 依賴失敗仍屬 R5。
- 100MiB／100-child／整會話 cold memory 等只在舊 source 有證據，不能推論到最終 source。
- 背景 exec 新控制只覆蓋單一 1MiB 級 frame 流與正常完成；cancel／abandoned／consumer cap／Stop／quota／concurrency 的矩陣尚未在本批補。

## 9. 本批 commit 與最終 source

| 項目 | 值 |
| --- | --- |
| 完整審查範圍 | `91d8fef04253272a437c68f5f2f84a657fa53d3b..b53938bef6be24c130cf66212a672d144ffaf65a`（含交接 WIP `8191736` 與本批 2 個產品 commit）；本文件所在的 docs commit 緊接其後，最終 HEAD 以回報訊息為準 |
| 本批 commit 1 | `e0a9e841 fix(context): fence retained task publication and truthful cold retention` |
| 本批 commit 2 | `b53938be feat(executor): settle background native results on the original source` |
| 最終產品 source | 4587 個 apps/packages 檔（排除 node_modules/dist/build/.tmp），digest `75db9402d627f4df20f22354b1a2f1325c5d591e52dcd11d72ae0bbe0f6ddfd0` |
| closed evidence | 53 個檔（13 個 receipt 的 txt/json/source-before/source-after + patch + manifests），digest `dd0daea1c064e68debce93baeed2aae759546f1ebe1fa4659bbb6df6f9acfe07` |

Receipt 的 before/after manifest 取自 runner 的產品樹 walk；早期 receipt 的 digest 曾包含 `packages/session-executor/.tmp/` 下由 sandbox 測試留下的暫存目錄（該目錄自 2026-10-08 起就有大量歷史 debris，`git check-ignore` 顯示為 ignored）。最終 `final-product-source-manifest.json` 明確排除 `.tmp`，digest 以上表為準。其中 `a6-session-executor-full` 的 before/after 由 4600 增至 4604，正是該次全套件新建的 8 個 scratch 檔（4 個 `.json`/4 個其他），不是產品 source 變更；其餘 receipt 的 before/after digest 相同。

## 10. 停止點

- 產品工作停止；沒有 R4B、merge、tag、release、branch、worktree、依賴安裝或子代理。
- 本批提交只包含 A1／A2 的產品修正與其控制；未接受的 A3–A5 缺口照原樣保留在報告中，不以新命名或改斷言掩蓋。
- 等待 Codex 對 full `91d8fef0..HEAD`（含交接 WIP 與本批新 commit）做功能＋結構＋證據審查。
