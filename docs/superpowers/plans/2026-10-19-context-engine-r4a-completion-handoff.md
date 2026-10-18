# R4A Retained Results Completion Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for this batch. The user selected **deepseek-flash-1017** as the separate implementation agent and **Codex** as reviewer. Use one product writer, no recursive delegation. Follow checkbox steps; the explicit workflow applies if the skill is unavailable.

**Goal:** 在現有未驗收R4A程式上完成所有真實producer／reader／恢復／生命週期接線，提供一個可由Codex完整驗收的交付包。

**Architecture:** 完整結果由現有workspace ContextOutput artifact owner保存；model/archive用有界ResultEnvelope；工具執行結果、保存結果與交付狀態分開。F1仍是唯一正式事實權威，原source持有捕獲、pending operation和receipt，恢復不重播原工作。

**Tech Stack:** Node24.15.0、TypeScript、Vitest、現有JSONL／QuickJS／MCP／exec／SDK／Gateway；不加套件。

**Spec:** [總入口](2026-10-19-context-engine-external-execution.md)、[交接檢查點](../../research/2026-10-19-context-engine-handoff-checkpoint.md)、[完整R4A契約](2026-10-18-context-engine-r4a-retained-results.md)。本文件安排未完工作，沒有取代原契約的codec／proof／owner細節。

## Global Constraints

- 原R4A比較BASE為`91d8fef04253272a437c68f5f2f84a657fa53d3b`；從交接checkpoint接續，不從BASE重做。
- 產品版本維持`0.1.13-rc.1`；此批完成後停下交付Codex，不自行開始R4B、merge、tag、release。
- 預設disk quota **512MiB**，沿同一workspace store與實際設定。無媒體普通model/result envelope **64000 serialized UTF-8 bytes**；child preview **2048 serialized bytes aggregate**；report **16384 final JSON bytes**；預設artifact page **32KiB**；integrity chunk **65536 bytes**。媒體遵守原typed媒體限制。
- Session format **10**，literal9/8相容與實際owned upgrade，future11拒絕。TaskProtocolDocument／SubagentStateSnapshot新版本 **2**，literal1保留，future3拒絕。
- 原始result、getter/toJSON、hook、exec launch、guest、child不重播。保留既有guest transfer **4MiB**限制與原生JSON.parse數字語義。
- 原ENC/WRITE/DEP/PROGRAM/HOST/PAGE/COLD/VIS/PIN/FAN/SER/RAW/HOOK rulings全部有效；先查原計劃的同名條目，不能用新增例外解測試。
- 產品檔按責任拆分；一般150–400行／函式通常≤120行，超出需具體責任理由。S25/CX2必須做完整責任對照；不擴展不相關拆分。
- 實際source/copy/fixture前後雜湊及失敗紀錄不可覆寫。不要降低既有180s fan-in控制上限來掩蓋效能問題，也不要提高它以換取pass。

## 當前結構與介面

下列是交接時實際存在的責任，不另造同名owner。新增葉檔可以細分責任，但維持public entry與依賴方向。

| Owner／文件 | 消費／產出 | 本批責任 |
| --- | --- | --- |
| `packages/core-session/src/results/`、`serialization/json-{data,stream}.ts` | `ResultEnvelope`、`ManagedArtifactRef`、`RetainedResultRevision`；一次owned lowering／stream | 保持closed DTO、JSON語義及版本讀取；不把store依賴放進core |
| `packages/context-output/src/artifact/`、`workspace.ts` | `ResultArtifactScope`、`ResultArtifactSink`、`ManagedArtifactPage` | 唯一store／quota／pin／grant／integrity／原operation恢復 |
| `packages/output-retention/src/result/{capture,exec-frames,preview,media}.ts` | `createResultCapture`、`createExecFrameCapture` | 同一codec／有界preview／一次capture；完整資料不可因preview丟失 |
| `packages/core-tools/src/registry/{result-finalization,result-dependencies,finalize}.ts` | `ResultFinalization`、`ToolResultRetention`、genuine handle registry | 正常／合成／MCP與真正dependency registration，原handle恢復 |
| `packages/core-agent/src/tool-batch/`、`packages/code-mode/src/broker/` | 原dispatch與result source／once-only observer | source hold、F1 result、guest失敗與required passive settlement |
| `packages/exec/src/capture/`、`jobs/` | `ExecFrameCapture`／`ExecResultRetention` | native capture在舊collector丟棄前保留frames；背景完成與close join |
| `packages/code-mode/src/runtime/output.ts`、`types.ts` | `CodeModeRuntimeEvent`、`CodeModeObservation` | emitted output的完整保存與有界model/archive；退出舊spill fallback |
| `packages/session-executor/src/lifecycle/*result*.ts`、`reference-retention.ts` | 真正host scope、task/native/code ports | composition接同一service；不能從payload、header字串或工廠parent猜authority |
| `packages/subagent/src/task/`、`persist.ts`、`jobs.ts`、`agent-table.ts` | TaskRegistry／v2 result revision與publication proof | 唯一registry/save owner；current/resident/cold讀取一致 |
| `packages/desktop-gateway/src/subagents/`、`session-subagents.ts` | lineage-qualified projection／context/history | 唯讀catalog不建child；explicit history仍經原owned observation fence |
| `packages/desktop/src/renderer/session/RetainedChildBody.tsx`、`SubagentPane.tsx` | 有codec的結果頁／legacy頁 | 真正分頁、revision cursor、完整欄位語義 |

核心介面以實際public exports為準，以下是接手時已存在的形狀：

```ts
// @i-harness/core-tools
interface ResultFinalization {
  settle(): Promise<
    | { kind: 'ready'; envelope: ResultEnvelope; program: ResultProgram }
    | { kind: 'recovery-required' }
  >;
}
type ResultProgram = { kind: 'value'; value: unknown }
  | { kind: 'unavailable'; reason: 'encoding' };

// @i-harness/exec
interface ExecFrameCapture {
  readonly sourceId: string;
  write(part: { channel: 'stdout' | 'stderr'; frame: number;
    offset: number; end: boolean; bytes: Uint8Array }): Promise<void>;
  complete(completeness: ResultCompleteness): void;
  settle(): Promise<{ kind: 'ready'; dependency: ResultDependency }
    | { kind: 'recovery-required' }>;
}
```

`ResultEnvelope`與artifact codec的完整discriminated union只維護在原owner。上述片段是讀取指南，不能複製成第二份產品型別。

## Task A0：接手與確認安全檢查點

**Files:** 交接檢查點、當前branch／worktree；本機`implementer-state.md`及`task-1-report.md`只作證據索引。產出新的`docs/research/context-r4a-external-delivery.md`及獨立evidence目錄。

**Interfaces:** 消費現有checkpoint，不改產品API；產出此實作者的精確BASE／起始HEAD／dirty檔清單與後續測試紀錄。

- [ ] 核對交接文件與HEAD；如另有使用者修改，保留並列明，不能reset／clean／覆蓋。
- [ ] 讀原R4A A1–A10及所有ruling，逐條標「已有source-scoped證據／本批待做／最後source待重驗」。不要把已跑過但source不同的171 fan-in直接勾成最終pass。
- [ ] 建立新的evidence目錄並選當前任務的聚焦基準；不先跑整個monorepo，也不改斷言湊綠。

```powershell
Set-Location 'D:/I-harness-main'
$r4aNode = 'C:/Program Files/nodejs/node.exe'
$r4aEvidence = '.tmp/context-r4a-external-20261019'
if (Test-Path -LiteralPath $r4aEvidence) { throw 'Choose a fresh evidence directory; preserve existing receipts.' }
New-Item -ItemType Directory -Path $r4aEvidence | Out-Null
git rev-parse HEAD
git status --short
```

- [ ] 最後focused checkpoint的原commands在交接文件中。只在相關source確實改變／證據缺失時重跑；不把舊測試失敗重標成已修。

**完成條件：**可以指出當前產品起點、原始比較BASE、當前已知失敗與每一項未完責任；沒有新產品行為。

## Task A1：確認current／cold結果讀取與完整責任收束

**Modify:** `packages/subagent/src/{persist,jobs,agent-table,report-policy}.ts`、`task/{registry,result,publication,validation}.ts`、`packages/desktop-gateway/src/subagents/`及`session-subagents.ts`。只修這些實際入口尚存的缺口。

**Test:** 現有`packages/session-executor/test/retained-state-cold.test.ts`、`retained-child-flow.test.ts`、`retained-child-scope.test.ts`；`packages/subagent/test/retained-task-{body,cold}.test.ts`；`packages/desktop-gateway/test/{session-subagents,retained-result-publication-proof,retained-catalog-io,subagent-protocol-header}.test.ts`。

**Interfaces:** 消費原TaskRecord taskId、`RetainedResultRevision`與真正owned parent F1 proof。產出有明確representation／publication的同一current projection；不能另造completion權威。

- [ ] 讀最後checkpoint的state/list/task與history-fence修正；保持原始225等失敗證據。先用現有actual service／coordinator fixture補缺漏的v1/v2/no-port/future3、current resident新revision、rewind-cut與不同owner情況。
- [ ] 對新缺口先保留實際RED：unproven必須recovery-required；已提交的相同taskId/revision/ref不能false-unknown；舊initial TaskRecord不可覆蓋較新resident結果。no-port observer不能將v2降回v1。
- [ ] 在同一private proof／projection owner修正；savedObservation及artifact bytes保留，derived restore不新增job/status，不讀payload猜taskId，不因history query建立assembly。
- [ ] 聚焦執行上述受影響tests／types；對照完整S25與CX2原責任，列出仍屬R4C的delivery語義，不提前報整組reviewed。

實際counter oracle（加到現有真實fixture，不用假的projector取代service）：

```ts
// Extend the existing retained-state-cold.test.ts fixture after its real
// coordinator close/reopen. These are that fixture's actual owners/variables.
const before = reopened.view.events.length;
restoreState(restored, await coordinator.getDocument('parent') as SubagentStateSnapshot, {
  coordinator, stateId: 'parent', parentSessionId: 'parent',
  parentSession: reopened.view, factOwner: reopened,
});
const job = restored.jobs.read('subagent-1');
expect(job.status).toBe(committed ? 'completed' : 'recovery-required');
expect(snapshotState(restored).formatVersion).toBe(2);
expect(reopened.view.events.length).toBe(before);
expect(getters).toBe(1);
```

這是既有實際fixture的斷言片段；新negative cases沿用同一真實coordinator／restore入口，不建立只回expected的stub。model／wake讀取副作用另沿Gateway的實際reader fixtures計數。提交只包含本任務的完整修正／tests。

## Task A2：背景exec與完整依賴生命週期

**Modify:** `packages/exec/src/capture/{output,retention,frames,completion}.ts`、`jobs/{records,observation}.ts`、`retained-output.ts`；`packages/session-executor/src/lifecycle/{exec-result-retention,result-dependencies,result-sources}.ts`；`packages/core-tools/src/registry/result-dependencies.ts`。

**Test:** 擴充`packages/session-executor/test/retained-exec-flow.test.ts`、`packages/exec/test/managed-frames.test.ts`、`packages/context-output/test/{managed-ownership,exec-frame-pages}.test.ts`；需要獨立檔時新增`packages/session-executor/test/retained-background-exec.test.ts`。

**Interfaces:** 消費`ExecResultRetention.begin/observe`與`ExecFrameCapture.write/complete/settle`。產出startup不等EOF、原native lifetime持有且完成後可讀的frame dependency；仍由同一artifact/pin/grant owner確認。

- [ ] 用真實controlled execution transport建立background startup gate；hold EOF，確認startup result已回傳而`complete()`尚未發生。release後確認原process與capture一次完成，後續job query取得同一ref/revision。
- [ ] 以固定alternating stdout/stderr frames建立獨立expected raw hash與順序。分別注入cancel、abandoned、consumer cap、known quota、unknown artifact commit、host close；每種結果都須保留真實execution outcome與正確completeness。
- [ ] 接通原background owner的自動settle與close join；不能依靠日後剛好有人get_task_output才保存，也不能將startup source已關閉當成刪除完整結果的理由。
- [ ] primary ExecResult JSON、frames、dependency catalog及所有pin／grant一起驗證。ref-shaped JSON不授權；foreign-owner read做零body I/O；已確認刪除不復活pin，unknown先reconcile原operation。
- [ ] 執行實際native、capture與store scopes，提交單一完整背景生命週期修改。

獨立預期資料可直接在fixture生成：

```ts
import { createHash } from 'node:crypto';
const frames = [
  { channel: 'stdout', bytes: Buffer.from('A\u0000😀') },
  { channel: 'stderr', bytes: Buffer.from([0xff, 0x00, 0x7f]) },
] as const;
const expectedRawDigest = createHash('sha256');
for (const frame of frames) expectedRawDigest.update(frame.bytes);
const expectedDigest = expectedRawDigest.digest('hex');
// Compare the independently decoded cold frame pages to expectedDigest and
// the literal channel/frame/offset order; a preview is not this oracle.
```

不得把兩個channel合併文字後的hash當成frame order／binary fidelity證明。

## Task A3：Code Mode emitted output退出舊spill路徑

**Modify:** `packages/code-mode/src/runtime/{output,cell-state}.ts`、`types.ts`、`broker/{records,types}.ts`；`packages/session-executor/src/lifecycle/reference-retention.ts`、相關result port及`assembly.ts`的薄接線；`packages/core-session/src/events/`實際code/output contract與projection。

**Test:** 先讀`packages/session-executor/test/native-context-output.test.ts`、`service-output-spill.test.ts`與`packages/code-mode/test/managed-store-stop.test.ts`；新增`packages/session-executor/test/retained-code-output.test.ts`連接實際WASM guest／onEvent／F1。

**Interfaces:** 消費既有`CodeModeRuntimeEvent`的output/committed/retainOutcome barrier與original cell/source，結果沿同一`ResultFinalization`／artifact contract。新的host只讀DTO如需版本變更，producer、codec、projection、consumer同批切換；不得保留新ref與舊完整raw text雙寫。

- [ ] 先重現現有`runtime/output.ts`的`retainText`／`createUnifiedSpillStore` fallback及完整文字join路徑。fixture實際emit多段文字、交錯image、yield與Stop；expected以原admitted item順序生成。
- [ ] 在原cell的output admission／required settlement內捕獲一次完整accepted item；保存確認後才發布相應ref事實。保留原onEvent barrier與callback順序。使用現有source／fact owner，不創假tool call來取得synthetic權限。
- [ ] 移除新shipping路徑的無界spill fallback及重複原文保存。原hard admission／guest transfer限制保持；超出來源上限的輸出必須標source-limited／producer-incomplete，不能聲稱未收到的內容也完整保存。
- [ ] model/archive取有界envelope；guest／實際program value按原語義和限制取得完整已接受值，不能用preview冒充。media次序不因文字artifact分開而漂移。
- [ ] hold storage/F1、failed observer、Stop、guest已退場、再次observe均驗證原cell/capture/receipt與一次執行；未知時用原hold，不能觸發第二次guest或new input。
- [ ] 實際normal mount與restricted child mount都覆蓋，相關types／tests通過後提交。

必要反例：文字含`"`、`\\`、NUL、emoji、unpaired surrogate；截斷邊界靠近UTF-16 pair；unknown receipt後重試storage。不可使用生產serializer生成expected後再用同一serializer自證。

## Task A4：剩餘producer／reader與版本完整切換

**Modify:** `packages/mcp-client/src/bridge.ts`、`packages/core-tools/src/registry/`；`packages/core-session/src/conversation/`、`packages/session-query/src/file-backed/`；SDK／Gateway／Desktop的實際結果reader。需要改UI時沿現有IH風格，不新增獨立設計系統。

**Test:** `packages/mcp-client/test/bridge.test.ts`、`packages/core-tools/test/{result-finalization,inherited-result-retention}.test.ts`、`packages/compaction/test/retained-result-context.test.ts`、`packages/desktop/test/subagent-pane.test.tsx`、實際public format／owned append tests。

**Interfaces:** 消費`ResultFactPayload` closed union及managed頁的codec/encoded offsets；輸出有界可觀測結果。codecs／結果是否complete由原owner決定，UI不自行推斷。

- [ ] 建立真實producer→finalizer→F1→model/archive→query/UI/SDK對照表，找出仍直接使用`.output`、raw resultText、未受限stringify或原spill的shipping入口。以實際呼叫驗證，不只grep字串。
- [ ] MCP fixture包含`structuredContent`、`isError`、ordered text/media、resource及普通同名字段；執行failed與保存failed獨立。任意payload字段不能改變trusted outcome或授權。
- [ ] 新body頁明示`codec`、encoded-byte offset／next／eof與原revision；resultText與error兩欄都保留。legacy欄位頁維持其既有語義；新ref收到legacy selector時明確返回不支援與正確讀法。
- [ ] 用literal9/8→10真實owned upgrade/append/reopen、future11拒絕，以及task/state literal1、2、future3／malformed實際readers驗證；不要全面把fixture的9改10，previous-version控制必須保留。
- [ ] actual search/export/history只讀，不建立child/assembly、不auth/prepare/send/wake；跨scope/ref偽造零body I/O。所有route透過實際adapter準備受控request，保留各自native／media語義。
- [ ] 分consumer提交可獨立理解的完整變更；更新對照表，沒有尚在shipping的衝突路徑才結束。

有界結果oracle使用最終JSON bytes：

```ts
const ordinaryBytes = Buffer.byteLength(JSON.stringify(actualOrdinaryEnvelope), 'utf8');
expect(ordinaryBytes).toBeLessThanOrEqual(64_000);
expect(Buffer.byteLength(JSON.stringify(actualReport), 'utf8')).toBeLessThanOrEqual(16_384);
expect(Buffer.byteLength(JSON.stringify({ resultText, error }), 'utf8')).toBeLessThanOrEqual(2_048);
```

上述值取自actual consumer輸出，不拿preview字元數代替。media有獨立typed限制，不把圖片bytes任意切成64k來通過普通文字控制。

## Task A5：剩餘crash／ownership／retention矩陣

**Modify:** 僅當反例需要時修改`context-output/src/artifact/`、原`session-persistence` source／receipt及對應host接線；不要另建recovery journal。

**Test:** 現有`managed-artifacts.test.ts`、`managed-ownership.test.ts`、`original-owner-pin.test.ts`、`retained-hook-{recovery,stop}.test.ts`、`retained-child-pins.test.ts`；擴充真正fresh coordinator／host冷啟動cut controls。

**Interfaces:** 原write cursor／reconcileWrite、原artifact commitment、原F1 receipt／source hold。恢復不得產生新captured body或execution permission。

- [ ] 列出尚未覆蓋的切點：write短寫／unknown、body/index sync、manifest、第一/第二document pin、catalog dependency、F1 issued/receipt lost/install、host restart。
- [ ] 每個cut先用受控fault跑RED；檢查同operation/key、callbacks一次、bounded queue及zero new transport。成功修復用同一oracle重跑，不用增加timeout或刪掉intermediate assertions。
- [ ] 實際混合legacy/managed quota、saved quota降低、generic clear/TTL、archive/rewind/current ACL revoke、confirmed deletion、多document pins與store close。未知保護不刪，known precommit delete不復活；execution outcome不被retention refusal改寫。
- [ ] nativeRaw lexeme／boxed JSON／無效編碼、UTF-8頁cursor、index/root/leaf/header corruption等沿既有完整matrix補缺漏；page只驗證實際觸及的chunks與proof，不宣稱未讀全檔的全檔integrity。
- [ ] 不可證明原F1 completion的cold狀態保留bytes／savedObservation但標unknown／recovery-required；不要掃artifact metadata後重建成功event。

**完成條件：**原A1–A10各有真實控制；每個未執行分支明列，不以helper測試取代producer／host路徑。

## Task A6：最終source驗證、copies與交付

**Files:** 新delivery報告、source manifests、artifact/copy/import mappings、原始logs；必要的結構責任對照。不得覆寫原171等舊證據。

- [ ] 完成產品修改後固定source，不邊跑長控制邊改產品。逐一跑受影響owner/consumer tests與types，`maxWorkers=2,minWorkers=1`；CLI序列化單worker。保持expected injected diagnostic可辨識，記錄unexpected stderr。
- [ ] 根據最後source delta重跑必要的1MiB/100MiB普通與exec、page-I/O、100-child fan-in。本機原控制均位於`.tmp/context-r4a-evidence-20261018-a/`：`normal-100mib.mjs`、`exec-100mib.mjs`、`child-fan-in-100-v2c.mjs`。接手另一台電腦時先用`rg --files`確認；若原腳本不存在，重新建立等價獨立fixture並明記來源差異，不能假裝執行舊檔。
- [ ] fan-in保留180000ms capture bound，分別記child／parent requests與真實default notification/wake。等合法delivery quiescent後再設read baseline，cold讀取的增量模型呼叫為0；原heavy-parent失敗留R6，不用這個較小parent控制宣稱全部壓測已過。
- [ ] 執行normal reachability／dependency檢查，再用全新out目錄build Gateway及CLI。實際copied imports、source→copy map、fixture transformation、原始命令與bytes hash都記錄；不能把source測試冒充dist驗證。
- [ ] Gateway／CLI／SDK真實入口至少覆蓋normal result、background、Code output、child result、Stop/recovery、legacy upgrade、cold read零執行，以及後續明確input仍可用。
- [ ] 完成S25／CX2完整責任表與新產品檔尺寸檢查；不把仍在R5的assembly/service/host完整拆分算完成。
- [ ] 提交coherent commits，報告full BASE..HEAD（包含交接WIP，不只最後一個commit）。保存closed evidence manifest＋SHA256，停止產品實作，交由Codex審查A1–A10；不要自行把R4A標accepted。

工具命令模板，`Set-Location`必須是對應package；shell為PowerShell，shell測試需Git Bash時使用`C:/Program Files/Git/bin/bash.exe`，不要誤用WSL bash：

```powershell
$r4aNode = 'C:/Program Files/nodejs/node.exe'
Set-Location 'D:/I-harness-main/packages/session-executor'
& $r4aNode '../../node_modules/vitest/vitest.mjs' run test/retained-exec-flow.test.ts test/retained-state-cold.test.ts --maxWorkers=2 --minWorkers=1
& $r4aNode '../../node_modules/typescript/bin/tsc' --noEmit
Set-Location 'D:/I-harness-main'
& $r4aNode 'scripts/audit/check-reachability.mjs' --gate
$r4aBuildSuffix = Get-Date -Format 'yyyyMMdd-HHmmss'
& $r4aNode 'packages/desktop/scripts/build-gateway.mjs' --out ".tmp/context-r4a-gateway-$r4aBuildSuffix"
& $r4aNode 'scripts/build-dist.mjs' --out ".tmp/context-r4a-cli-$r4aBuildSuffix"
& $r4aNode 'scripts/verify-dist.mjs' --out ".tmp/context-r4a-cli-$r4aBuildSuffix"
```

這是實際命令模板，不是完整test檔清單；交付須逐項列實際跑過的範圍。原renderer Node/browser import失敗仍屬R5，不因Gateway/CLI成功而改寫成renderer pass。原整體FAILED仍待R6完整qualification。

## Codex驗收輸入與停止點

交回 [總入口的交付格式](2026-10-19-context-engine-external-execution.md#9-證據與交付標準)，並附以下表格的每一列：

| ID | 交付必須說明 |
| --- | --- |
| A1/A2 | 完整資料與有界輸出、known no-fit、原outcome不混淆 |
| A3 | 原capture/source/receipt、body/getter/hooks/guest不重播、hold恢復 |
| A4 | 真實guest值與MCP/media/structuredContent順序 |
| A5/A6 | pins／ACL／deletion／quota；bounded page integrity及corruption |
| A7 |100個distinct revision、bounded reports、cold讀取零新work |
| A8/A9 | 新舊future版本及每個實際consumer、未保存資料不稱完整 |
| A10 | 完整責任拆分、actual graph/copies/source hashes、保留失敗證據 |

全部列出不等於全部通過；Codex對full range驗收後才能進入B。若實作者被迫提前停下，提交精確checkpoint、未完成清單與process狀態即可，不得將部分交付改稱整批完成。
