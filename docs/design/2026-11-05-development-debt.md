# 開發債務清冊與 burn-down（2026-11-05）
   **round 145 已遷移** 3 個測試檔（`admitted-context`、`cancel-stop`、`result-page-cli`）→
   **round 161**：`result-page`、`session-context` 亦遷移 → **9 failed / 110 passed（119）**。
round 162：`packages/sdk/vitest.config.ts`（30s）→ cancel-stop 的 5 個 timeout 露出真因
  round 163 查證：`cancel-stop.test.ts` 的兩個 hook（append/reconcile）是**在** `service.submit(...)`
  **round 164 已實作**：`cancel-stop` 5 個 hook 遷到 seam ＋ armed 旗標 → **4/5 通過**；
  剩「an independent actual fork finishes while the original cancel Stop remains held」
  （`Original Stop boundary pending`，該案自身的 4s 邊界）。
  **之後**才安裝的，正是 round 135 的 `armed` 情境。遷移步驟：把 `entered/release/unknown/allow/key/
  reconciles/closeKeys/receipts` 宣告提前到 `createJsonlBackend` 之前、加 `armed=false`、
  wrapper 內 `if(!armed) return append(...)`、`service.submit` 之後 `armed=true`。
  **`PROCESS_READ_UNAVAILABLE`**（建構後 patch backend，需 seam 遷移）。
   **11 → 10 failed / 109 passed（119）**；剩 1 筆 `TASK_TRANSITION_UNSUPPORTED` 不是建構子路徑。

這份文件處理的是**開發債務**，不是產品功能：讓「回歸」重新有意義，然後清掉
被產品 hardening 甩在後面的測試與 API。

> **狀態快照（round 54）**：typecheck 82/82、boundaries 147/147、reachability PASS（0 NEW）
> 三個 gate 已綠。待辦 1（P0 + P1 #3/#4）、待辦 2（移除 `createJsonlSessionCoordinator`）、
> 待辦 3（A 類 11/11 遷移）已完成。`session-persistence-jsonl` 全套 106 failed / 751 passed
> （26 紅檔）。第 5 項量測：`session-executor` owned-* 19/19、`token-meter` 53/53、
> `llm-seam` 188/188 綠。剩下的紅分兩類：(a) cleanup-debt 群（`closeOne` 的殘留 attempt
> entry，根因已定位）；(b) 各 bootstrap／predecessor 語義紅（逐條列在第 4 項）。
> 下一個具體動作見文末「交接：round 32」與其後的 round 41–52 記錄。
> **round 157 更新**：48 個套件已量測（instructions、schedule、runtime-context、guard-retry、
> guard-repeat-tool、session-query、compaction、workspace 由紅轉全綠）。剩餘紅：code-mode 83、
> core-agent 33（多為 seam 遷移類）、sdk 10、provider 2、exec 1、acp 1、llm-openai 1、
> core-session 1（效能）、sandbox-windows-acl 2（native）。

## 為什麼先做這個

`verify:all` 的 full job 從未真正 green：v0.1.13 的 gate 只有 typecheck 與
package boundaries，測試 suite 累積了數百個紅測試。當紅測試成為常態，
「這次改動有沒有弄壞東西」就無法回答——本輪 audit 的多次實驗失敗，有一半是
分不清 pre-existing failure 與新 regression。

本輪的原則：

1. 先讓**根因**變成可測（環境、建構子、fixture），不是逐測試硬改。
2. 產品的 fail-closed 契約**不為了測試放寬**；測試要遷移到產品的正式入口。
3. 每個根因都要留下可重跑的驗證指令與預期數字。

---

## 已償還（本輪）

### 1. 套件邊界 gate（紅 → 綠）

`packages/desktop-gateway/src/host.ts` 直接 import
`../../session-executor/src/child-shell.ts`，是 baseline 之外的新違規。
修法：`session-executor` 公開發佈 `mountChildShellTools`（只發佈實際被引用的符號，
避免新增 unused-export），gateway 從套件入口匯入。
`node scripts/audit/check-package-boundaries.mjs --gate` 回到 147 baseline。

### 2. 測試環境自足

先前 `pnpm test` / `node scripts/verify-all.mjs` 直接跑會因為
`IH_*_EVIDENCE_ROOT`、`IH_CONFIG_DIR` 未設而大量崩潰（`Received undefined`）。

- 新增 `scripts/test-env.mjs`：為每個「目錄型」evidence 變數建立**每次執行隔離**
  的暫存目錄（明確給值時不覆蓋）；刻意**不**預設 `IH_BASELINE_RECEIPTS`、
  `IH_CODE_CLOSE_EVIDENCE` 等 opt-in 證據檔。
- root `test` / `test:default` 與 `scripts/verify-all.mjs` 都改走這個 wrapper。

### 3. composed 協調器的測試入口

新增 subpath export
`@i-harness/session-persistence-jsonl/internal/transition`，讓測試/組裝碼不必再
`import '../src/backend-factory.ts'`。目錄內的 `src/` 相對匯入是既有的 147 筆
基線債務，新程式碼不再增加。

### 4. 測試 fixture 的過期假設（4 類）

| 檔案 | 根因 | 修法 |
|---|---|---|
| `task-transition-physical14` (39 tests) | "future task document" 用 `formatVersion: 3`，但 v3 已是支援格式（`captureTaskV3Document`） | future = 4；39/39 |
| `document-observed-read` (6) | S-05 之後 legacy `getDocument` 不再把 IO 錯誤當「沒有文件」 | 斷言兩層都傳播 EACCES/EIO；6/6 |
| `selected-fact-journal` (16) | cleanup 失敗被 managed-documents 包成 aggregate，頂層訊息改變 | 斷言錯誤鏈包含原始 debt；16/16 |
| `task-document-cleanup` (10) | document-only 建構子在 format 14 不能 `create` | 改用 transition 建構子；10/10 |

歷史格式 fixture 也不能再用 `backend.create(format<14)`（產品正確拒絕 downgrade）：

- 新增 `test/helpers/predecessor.ts` 的 `createPredecessorSession`
  （先以 current format 建立、只改 header 的 `formatVersion`）。
- 4 個檔案（history / history-fault / prior-write / upgrade-retry）轉綠；
  upgrade-retry 的「post-effect rename 後讀到什麼版本」斷言改為
  `CURRENT_FORMAT_VERSION`（原本寫死 13 是 format 13 時代的語意）。

### 5. 逾時設定

`session-persistence-jsonl` 的測試會做真實 fsync/journal/lock 工作，原本的
5s 預設逾時會把慢磁碟誤判為失敗（`cold-selected-capability` 42 個「timeout」
其實每個只要 3–8 秒）。新增 `vitest.config.ts` 把 test/hook timeout 設為 30s：
同一批測試（cold-selected-capability + cold-f0-acquisition）由 42 failed 變成
**1 failed / 52 passed / 1 skipped**；剩下的是「closes the exact document
attached during an ordinary opening flight: cleanup-debt」，待查。

### 6. D-12 遷移：不是「改 import」而是逐案重寫

`session-persistence-jsonl` 30 個引用 legacy `createSessionCoordinator` 的檔案，
實測只有 **6 個**能只改 import（45 tests）：

- `meta`、`delivery-journal`、`generation-reservations`、`process-read-owner`、
  `canonical-task-exclusion`、`canonical-connected-exclusion`。

其餘三類根因（20 檔已還原，等待對應工程）：

1. **建構後 monkeypatch backend**（最多）：`appendOwnedBatch` / `repair` /
   `upgradeSessionFormat` 等在 coordinator 建立後被替換 → canonical-path guard
   判 `PROCESS_READ_UNAVAILABLE`。這是產品的 fail-closed 設計。正確遷移是用
   **pre-bind seam**（`wrapOwnedBatch` / `wrapOwnedReconcile`，已存在）重寫每個
   檔案的 fault injection。
2. **predecessor / task-less 會話**：composed 會把 13 升到 14、或對沒有 task
   document 的 legacy session 回 `TASK_TRANSITION_RECOVERY_REQUIRED`。需決定
   語義（升級是否正確），再改測試。
3. **專用建構子缺 transition storage**：見下面產品 bug #2。

`session-persistence` 套件（41 檔使用 legacy 建構子）：**15 檔 / 46 tests 遷移**
（es-platform-events、fact-capacity、fork、input-persistence、m4-crash-acceptance、
model-retry-event、native-witness-format5、retained-execution-observation、
rewind-event、run-end-event、sandbox-mode-event、selected-source-forwarder、
semantic-fork-baseline、step-failed-event、todo-persistence；含 `kill-mid-tool.mts`
子程序），**18 檔還原**，套件 typecheck 乾淨。還原原因與 jsonl 相同（建構後 patch
backend、in-memory fake backend「Original JSONL backend required」、legacy-only 斷言），
另新增兩個產品發現（見下 #7/#8）與一個 hang（#9）。

---

**量測（本輪結束時）**：`session-persistence-jsonl` 全套由
**379 failed / 477 passed（53 個紅檔）** 降到
**295 failed / 561 passed（38 個紅檔，共 98 檔）**。剩餘紅檔分成：

- 建構後 monkeypatch 型（12 檔）：`bootstrap-physical`、`bootstrap-capture-physical`、
  `cleanup-diagnostic`、`coalesced-recovery`、`context-format`、`context-reduction`、
  `current-context-predecessors`、`recoverable-source-hold`、`retained-format-ownership`、
  `selected-results-denials`、`required-source-ports`、`delete-owned`。
- predecessor / 升級語義（5 檔）：`child-bootstrap-predecessor`、
  `child-bootstrap-stage`、`format8/13/11-predecessor`、`semantic-codec2-predecessor`。
- 專用建構子缺 transition（3 檔）：`process-read-composition`、`task-d-repair-header-path`、
  `task-document-write-repair`。
- bootstrap header/close debt 語義（9 檔）：`task-transition-bootstrap-retry/revoke/
  stage-debt/stage-swap`、`task-transition-capture-close-race`、`task-transition-direct-lease`、
  `task-transition-header-debt`、`task-transition-managed-header-confirm/retry`、
  `task-transition-stage-revision`。
- fixture 需要真 birth（2 檔）：`semantic-publication`、`task-document-composition`。
- 其他（3 檔）：`archive-stream`（hang，legacy 也紅）、`managed-native-replay`（deep-JSON
  P0）、`cold-selected-capability`（1 個 cleanup-debt 案例）、`replacement-journal`
  （seedLength 語義）。

---

## 償還：round 6（待辦第 1 項，2026-11-05）

### P0：deep-JSON 冷載入的 e2e 回歸

`managed-native-replay.test.ts` 改走 composed 測試入口後拆成兩個案例：

| 案例 | 深度 | 期望 |
|---|---|---|
| signed/numeric/source-order 保留 | 12 | `prepare().validation.native === 'preserved'`；冷讀後 `tool/call` 的 args 鍵序仍是 `['2','10','z','a','deep','text','$ref']` |
| 過深會話冷開啟 | 6000 | 拒絕：`message === 'TASK_TRANSITION_FAILED'`、`code === 'SESSION_EVENTS_TOO_DEEP'`、`cause.code` 同名、`cause.cause` 是 `RangeError` |

寫入側（agent → managed document → durable journal）在 6000 層仍然成功，只有冷開啟拒絕——
這是 mitigation（`9c4e1bf2` + `e78fe6ca`）的 e2e 證據，`managed-native-replay.test.ts:41`
的重現點結案。保留案例刻意用 12 層：clone 溢出的門檻是 stack 相依，不能當穩定數字。

### P1 #4：create 驗證 lineage 完整性

- `core-session` 新增 `validateLineageHeader`：有 `parentSession` 就必須有合法的
  `seedLength`（安全整數 ≥ 0）。`mutations.create` 的 composed/legacy 兩條分支都在
  寫入前驗證，不再產生「create 成功、append 才 `PROCESS_READ_UNAVAILABLE`」的 artifact。
- 回歸：`delete-owned.test.ts`「refuses a child lineage header without its seed length
  at create」。修前 `create` resolve `{id:'child'}`（測試紅），修後以
  `Invalid parent session lineage: a seed length is required` 拒絕，store 不留檔案。
- 與 `process-read-composition.test.ts:82`（lineage-only 讀取：`seedLength` 缺省視為 0）
  的衝突已記錄：該檔整檔紅（P1 #2），遷移時要把「手寫 lineage-only artifact 的讀取容忍」
  與「create 拒絕」分開寫，不能再用 `create` 造 lineage-only fixture。

### P1 #3：刪除不再被已接受的寫入卡死

- 根因：`lifecycle.deleteOwnedSession` 先 `closeAdmission`（`deleted` 標記）再 flush
  write-behind；composed 的 flush 走 `transitionWrite` → `transitionLoad` →
  `assertWritable`，直接拋 `Session is deleting or deleted`。
- 實測另一條路不可行：只讓 `assertWritable` 在 drain 期間放行、仍走 transition 車道，
  會在 `beginTaskTransition` 得到 `Session binding observation conflict`
  （刪除自己的 observation admission 內不能再開 task transition）。
- 修法：`mutations.ts` 的 write-behind 寫入器在 `deleted.has(id)`（只有 deletion 會設）
  時改走 direct append——與 legacy write-behind 相同形狀，且不必新增 lifecycle 依賴。
- 回歸：`delete-owned.test.ts`「drains accepted writes…」修前在 `deleteOwnedSession`
  拋 `Session is deleting or deleted`，修後刪除成功且事後 `enqueue` 仍被 fence。
- 取捨：drain 的 direct append 不經過 task transition；若 drain 之後刪除才失敗（例如
  backend IO），磁碟上會多一批「已接受但未 transition」的事件，下次開啟是
  `TASK_TRANSITION_RECOVERY_REQUIRED`（fail-closed、可 recovery），而不是靜默丟棄
  已接受的寫入。tombstone 仍在 drain 之後才寫，成功路徑沒有中間可見狀態。

### 同批 fixture 現代化（`delete-owned.test.ts`）

- 建構子改走 `test/helpers/composed.ts`。
- `restarted.create` 的 tombstone 斷言改看 `code: SESSION_DELETED`（D-12 #7 的 wrapper
  只保留 code；message 仍是泛用的 `TASK_TRANSITION_FAILED`）。
- symlink 案例的訊息改 `symlink|non-reparse`（Windows junction 走
  `Artifact ancestor is not an original non-reparse directory`）。
- 「read-only backend 不發佈 destructive capability」改用**從未有**該能力的 fake
  backend：JSONL backend 的 identity guard 會拒絕建構後改屬性，那不是這條契約。

**量測（round 6 結束時）**：`session-persistence-jsonl` 全套
**286 failed / 572 passed / 17 skipped（36 個紅檔，共 98 檔）**
（round 5 結束：295 failed / 561 passed / 38 紅檔）。紅檔集合 = round 5 的 38 檔減去
`delete-owned` 與 `managed-native-replay`，沒有新增紅檔。

**其他 gate（round 6）**：三個受影響套件 `typecheck` exit 0；boundaries 147/147；
reachability 仍是 71 NEW（沒有新增 row）。

---

## 償還：round 7（待辦第 2 項，2026-11-05）

依 round 6 的決策移除 `createJsonlSessionCoordinator`（`session-persistence-jsonl/src/index.ts`
不再 export，`backend-factory.ts` 刪除實作）。14 個測試檔全部遷移：

| 套件 | 檔案 | 前 → 後 |
|---|---|---|
| jsonl | `process-read-composition` | 0/12 → 12/12 |
| jsonl | `task-transition-managed-header-retry` | 0/1 → 1/1 |
| jsonl | `canonical-connected-exclusion` | process-only 變體隨建構子消失，13/13 |
| jsonl | `task-d-repair-selected-capability` | generic 改用 core 建構子，3/3 |
| jsonl | `archive-stream` | composed 建構子改用 transition；42 中仍 1 個既有 hang |
| jsonl | `bootstrap-stage-debt`／`-stage-swap`／`-managed-header-confirm`／`-stage-revision` | setup 改 transition 建構子；紅因轉為 bootstrap 語義（見下） |
| desktop-gateway | `host-publication` | 0/21 → 21/21（同檔 legacy 建構子一併換掉） |
| desktop-gateway | `process-query` | 2/2 |
| desktop-gateway | `process-native-bridge` | 0/1 → 1/1 |
| session-executor | `process-result-integration` | 0/1 → 1/1 |
| subagent | `task-owned-load` | generic 變體改用 core 建構子；該檔 22/37 仍是 5s timeout（套件缺 vitest.config，見下） |

### `process-read-composition` 一併解掉 round 6 的 lineage 衝突

- malformed seed boundary（-1／0.5／'1'／null）：**cold process setup 與 managed recovery
  都拒絕**——format 14 的 recovery 是 task transition，malformed seed 是
  `Invalid task history scope`（包在 `TASK_TRANSITION_FAILED` 內）。
- well-formed inherited boundary（1）：cold setup 拒絕、managed recovery 成功。
- lineage-only（缺 `seedLength`）：create 拒絕；**手寫** artifact 仍可走 cold process lane
  （視為 0），managed recovery 拒絕（strict history reader）。

### round 7 的新發現（未修，歸第 4 項）

- `bootstrap-stage-debt`：setup 走 transition 建構子後 task document 已存在，舊斷言
  「blocked resume 後 doc 不存在」失效；應改成「blocked resume 不改寫 doc」。
- `bootstrap-stage-swap`／`stage-revision`：faulted resume 後重試成功，但
  `coordinator.close()` 拋 `Coordinator cleanup is unresolved`——retained cleanup debt
  沒被 close 收斂。
- `managed-header-confirm`：setup 已完成的 bootstrap 讓 cold open 的 header sync 不再
  落在 `doc:task-target` lease 內（`protectedAtSync === false`）。
- subagent 套件沒有 `vitest.config.ts`（5s 預設）：`task-owned-load` 單檔在空載下仍有
  22/37 個「Test timed out in 5000ms」，實際每個測試要 2.5–4.6s。**不要直接複製 jsonl 的
  30s**：本輪試過同一個 config，該檔 15 分鐘沒有任何輸出（5s 版 151 秒跑完），已還原；
  timeout 與可能的同步 hot loop 要單獨查（第 5 項量測 subagent 時處理）。

### 第 3 項（A 類）開工：5 檔完成

每檔都用 `createJsonlBackend` 的 pre-bind seam（`wrapOwnedBatch`／`wrapOwnedReconcile`）
取代建構後的 `backend.appendOwnedBatch = ...`，並改走 composed 測試 helper：

| 檔案 | 前 → 後 | 用的 seam |
|---|---|---|
| `cleanup-diagnostic` | 0/4 → 4/4 | `wrapOwnedBatch` |
| `required-source-ports` | 0/2 → 2/2 | `wrapOwnedBatch` |
| `recoverable-source-hold` | 0/2 → 2/2 | `wrapOwnedBatch` |
| `coalesced-recovery` | 0/4 → 4/4 | `wrapOwnedBatch` + `wrapOwnedReconcile` |
| `selected-results-denials` | 5/9 → 9/9 | `wrapOwnedBatch` |
| `context-format` | 1/10 → 10/10 | 新增通用 `wrap` seam（見下） |
| `context-reduction` | 0/20 → 20/20 | `wrap` + 可變 `AppendHook`（fixture 在建構前安裝） |
| `retained-format-ownership` | 0/30 → 30/30 | `wrap` 計數器（取代七個 `vi.spyOn`） |
| `bootstrap-physical` | 0/58 → 46/58 | `wrap` + append／confirm frame hooks（剩 12 個語義紅，見下） |
| `current-context-predecessors` | 3/12 → 3/12（遷移完成） | `wrap` upgrade policy（剩下 9 個 predecessor-resume 語義紅，見下） |
| `bootstrap-capture-physical` | 11/61 → 57/61 | `wrap` 通用捕獲方法 hook map（剩 4 個語義紅，見下） |

`context-format` 需要換掉三種「建構後改 backend 方法」的注入，既有的兩個 seam 不夠，
所以 `createJsonlBackend` 多了第三個 pre-bind seam：

- `wrap?: (backend) => void`：在 canonical-path guard 快照 **所有** own descriptor 之前
  執行一次。測試可以替換任何方法（repair／replaceEvents／upgradeSessionFormat／append），
  也可以刪掉能力來模擬「本來就沒有」的 backend。這比照 `wrapOwnedBatch` 的既有限制：
  建構後再改就是 `PROCESS_READ_UNAVAILABLE`。
- 檔內兩個 legacy 期待在 format 14 已不成立，改寫成 composed 契約：
  1. 過深／legacy 升級能力：composed lane 自己 stage header 升級，**不查**
     `backend.upgradeSessionFormat`；改成斷言「沒有該方法也能升到可寫格式」。
  2. 升級被拒後重試：unknown durable write 會 poison process-read latch，重試被
     `PROCESS_READ_UNAVAILABLE` 拒絕、關閉時回報 retained batch debt；改成斷言
     fail-closed 形狀（不再假設同一個 coordinator 內可重試）。
- 順帶修掉 P2 #5：`updateMeta` 的 downgrade 檢查移到 transition 之前，訊息回到
  「cannot downgrade session format」，不再被包成泛用 `TASK_TRANSITION_FAILED`。

11 檔全部遷移完成：8 檔全綠，3 檔只剩語義紅
（`bootstrap-physical` 46/58、`current-context-predecessors` 3/12、
`bootstrap-capture-physical` 56/61）。

`bootstrap-capture-physical` 的 4 個語義紅（歸第 4 項；P18 已修）：

- P09/P10 rename-after promotion：期待 `ready`，實際 `refused`。
- P10 cold full promoted ready stage：期待 `already-ready`，實際 `blocked`
  （metadata 編輯後冷 resume 被拒；要確認 metadata 是否應屬 birth manifest）。
- P14 claim release failure／consumed native claim release：release 次數 2（期望 1；
  composed lane 在捕獲失敗時已嘗試釋放一次，close 再重試）。
- P18 原本期待「root directory open = 0」，但 composed lane 的 fs-lock artifact guard
  會讀一次 root（Windows reparse 檢查）；改成只斷言「沒有可寫的 directory handle」後轉綠。

`bootstrap-physical` 遷移後仍有 12 個語義紅（歸第 4 項），共同形狀是「transition 車道
的 outcome 與 legacy 期待不同」：

- seed-issue 守衛、source-change、frame reconcile、header fsync 等案例期待 `ready`，
  實際是 `blocked`（bootstrap 在 transition 內多了一次一致性檢查）。
- 一個案例期待 `not-issued`，實際 `blocked`（metadata-only nonempty target）。
- 兩個案例期待 `FACT_RECOVERY_REQUIRED` 或直接拋錯，實際是
  `SessionBindingObservationError`／`PROCESS_READ_UNAVAILABLE`。
- `keeps the original manifest ready …` 與 `review F1 …` 期待 `already-ready`，
  實際 `blocked`。

`current-context-predecessors` 遷移後仍有 9 個 predecessor-resume 語義紅（歸第 4 項）：

- ready／direct-upgrade／birth-conflict 模式期待 `already-ready`，實際 `blocked`。
- header-only 期待 `ready`，實際 `not-issued`。
- stage-only 期待 header 升到 CURRENT，實際停在 11（resume 只沿用 predecessor stage 的
  header，沒有走 composed 的升級）。
- partial-header 以 `Coordinator cleanup is unresolved` 收場。
- upgrade-response-lost／upgrade-target-revoked 期待 `blocked`，實際 `already-ready`
  （predecessor 階段已在舊 build 完成，current resume 直接視為已就緒）。

**量測（round 10 結束，空載重跑）**：`session-persistence-jsonl` 全套
**106 failed / 751 passed / 17 skipped（26 個紅檔，共 98 檔）**
（round 34 空載重跑；P18 修正後 +1，與 round 10 的 107/750 對帳一致）。

- round 8/9 結束時是 152 failed / 705 passed（26 紅檔）。
- round 10 的 `bootstrap-capture-physical` 遷移：-45 failed、+45 passed（56/61），
  紅檔不變（檔案仍紅，剩 5 個捕獲語義）。

- round 7 結束時是 228 failed / 629 passed（27 紅檔）。
- round 8 的兩個 A 類遷移：`retained-format-ownership` -30、
  `bootstrap-physical` -46（46 個轉綠、12 個語義紅留下）；紅檔 27 → 26
  （`retained-format-ownership` 轉綠，bootstrap 兩檔仍紅）。
- round 9 的 `current-context-predecessors` 遷移不改數字（9 個語義紅仍在，
  見第 4 項）。

- 第 2 項（建構子移除）後是 273 failed / 584 passed（34 紅檔）：差異恰好是
  `process-read-composition`（-12 failed、+12 passed）、
  `task-transition-managed-header-retry`（-1、+1），加上
  `canonical-connected-exclusion` 少一個 process-only 變體（總數 875 → 874）。
- 第 3 項的 7 檔再降 45 個紅測試（4／2／2／4／4／9／20），紅檔 34 → 27。
- round 6 結束時是 286 failed / 572 passed（36 紅檔）。

**其他 gate（round 7）**：全庫 `pnpm -r --no-bail typecheck` 82 packages 全綠；
boundaries 147/147；reachability 432 rows、70 NEW（round 6 是 71，移除的 export row
已消失）、104 baseline rows 消失。

**round 13 的 gate 進度**：`session-persistence` 移除 5 個沒有 import 端點的 type
re-export（`ResolvedBootstrapBirth`、`ForkHandoffMode`、`ChildInitialCommitment`、
`ChildExecutionIntent`、`ChildLineage`）→ reachability **427 rows、65 NEW**
（-5），套件 typecheck 乾淨。同輪再移除 `BootstrapInitial`、`BootstrapLineage`、
`BootstrapTarget`、`ChildBootstrapRequestIntent` → **423 rows、61 NEW**。
再一輪移除 `core-session` 的 5 個 type re-export（`CurrentContextComponent`、
`SelectedResultsPreparationSemantic`、`LegacyReadVisibility`、`LegacyVisibleRef`、
`DeliveryActionOrigin`）→ **418 rows、56 NEW**（累計 -14）。再一輪移除 `exec` 的
`ExecFrameQuery`、`ExecOutputFramePage`、`ExecRawSummary` → **415 rows、53 NEW**（累計 -17）。
再一輪移除 `core-agent` 的 6 個 type re-export（`ManagedAgentDeps`、`ManagedGenerationFactory`、
`ManagedAcknowledgedFact`、`ManagedRequestContext`、`ManagedSessionExecutor`、
`ManagedSessionExecutorDeps`）→ **409 rows、47 NEW**（累計 -23）。再一輪移除 `settings` 的
`SettingsRevisionGuard`、`SettingsWatchOptions`、`SettingsWatchState`、
`InstructionMigrationMeta` → **405 rows、43 NEW**（累計 -27）。再一輪清三個套件共 11 個
type re-export：`session-executor`（`PendingRewindIntent`、`RewindIntentV1`）、
`subagent`（`DocumentIntentStore`、`DocumentWriteIntentV1`、`JobLoadResult`、
`JobRecordStore`、`PendingDocumentWrite`、`isParentNotificationStopped`）、
`core-tools`（`ApprovalPolicyService`、`NativePlanValidationError`、`NativeTarget`）
→ **394 rows、32 NEW**（累計 -38）。再一輪移除 4 個 type re-export
（`session-persistence` 的 `ForkHandoff`、`ChildCaller`；`instructions` 的
`InstructionPendingLease`；`llm-seam` 的 `SseFrame`）→ **390 rows、28 NEW**（累計 -42）。
接下來改走「公開契約 → allowlist 註明理由」：把 `llm-seam#withPreparedRequests`
（README 列為 public API seam，但目前 adapter 直接 import wrapper 模組）加進
`reachability-allowlist.json`（dated 2026-11-05、附 reason/source）→ **27 NEW**。
接著修 gate 本身的盲點：`session/queued` 的 producer 存在（`session-executor/src/service.ts`
的 `telemetry.emit({ type: 'session/queued' })`），但 gate 的 producer 掃描只認雙引號字面量，
單引號一律漏報。把 `EVENT_LITERAL` 與 `isProducerLine` 改成引號無關 → 該筆 false positive
消失，**26 NEW / 389 rows**（其他既有 producerless 判定不受影響）。再移除
`workflow#WorkflowLoopFailure` 與 `session-executor#ManagedRuntimeLifecycle` 兩個
multi-line export list 內的 type 條目 → **24 NEW / 387 rows**。接著把 5 個有公開簽名／
文件依據的契約加 allowlist（`exec#JobOutputObservation`、`exec#NativeJobKillSelector`、
`core-tools#ToolPrepareIdentity`、`runtime-context#PreparedRuntimeContextReader`、
`token-meter#CHARS_PER_TOKEN`，皆附 dated reason/source）→ **19 NEW**（無 inert 警告）。
再處理第一個「測試專用」項：`settings#SettingsWatchError` 讓 `watch-lease.test.ts`
改從內建模組 import type，入口不再 export → **18 NEW / 386 rows**（測試 14/14 綠）。再移除 `core-session`
的 `validateRuntimeContextRecord`（只在定義模組內使用）→ **17 NEW / 385 rows**。
再移除 `workflow#reserveWorkflowIn`（測試本來就從 `src/runner.ts` 直接 import）
→ **16 NEW / 384 rows**（runner-lifecycle 13/13 綠）。再把 `settings#previewLegacyInstructionImport`
的唯一測試 consumer 改成從 `src/storage/instruction-migration.ts` import，入口不 export
→ **15 NEW / 383 rows**（instructions 44/44 綠）。再移除 `session-persistence` 入口的
`validateChildCaptureStage`（測試本來就從 `coordinator/bootstrap-route.ts` 直接 import）
→ **14 NEW / 382 rows**。再移除 session-executor 的 ManagedRuntimePublication（測試以 import('../src/service.ts') 取得）→ **13 NEW / 381 rows**。把 core-session 兩個 wildcard 來源的 4 筆加 allowlist（CodeOutputRecord、SubagentDeliverySourceEvent、validCodeOutputMember、validDeliveryKey，皆附 dated reason/source）→ **9 NEW**。剩下的 NEW rows 多數是 type-only／內部候選，需逐個確認
是否為公開契約再加 allowlist 或移除。

---

## 發現的產品 bug（本輪新增，依嚴重度）

1. **P0：deep-JSON 冷載入會 `RangeError` 崩潰**
   `session-persistence/src/coordinator/load.ts:90` 用
   `JSON.parse(JSON.stringify(proof.initial.events))` 做 deep clone；
   6000 層的 tool-call args 會 stack overflow（`JSON.parse`、
   `structuredClone` 都會），被包成 `TASK_TRANSITION_FAILED`。
   重現：`packages/session-persistence-jsonl/test/managed-native-replay.test.ts:41`
   （目前被還原；把 import 改回 composed helper 即可重現）。
   建議：在讀取/複製路徑做**迭代式深度檢查**，超過上限回明確
   `SESSION_EVENTS_TOO_DEEP`；或在 tool args admission 就限制深度。
   **已緩解（`9c4e1bf2`）**：cold-load 的 JSON round-trip 現在捕捉 `RangeError`，
   回 `code: SESSION_EVENTS_TOO_DEEP`（cause 保留 RangeError），且
   transition wrapper 會保留該 code。probe（6000 層）：
   `CODE SESSION_EVENTS_TOO_DEEP | CAUSE RangeError`。
   **round 6 已補**：磁碟上深層 args 會話的 e2e 冷開啟回歸
   （`managed-native-replay.test.ts`；6000 層 → `code: SESSION_EVENTS_TOO_DEEP`，
   cause 鏈到 `RangeError`）。**仍欠**：admission 端的深度上限決策（目前語義是
   「寫得進去、冷讀拒絕」）。

2. **P1：`createJsonlSessionCoordinator` 在 format 14 無法建立/開啟會話**
   `backend-factory.ts:42-49` 組裝時沒有 `transitionStorage`，任何
   `create`/`openManagedDocument` 都 `TASK_TRANSITION_UNSUPPORTED`。
   目前沒有 production caller，但它是公開 export，且有 15+ 測試檔使用
   （desktop-gateway、session-executor、subagent、jsonl）。
   建議：讓它要求 `TaskTransitionConfiguration` 參數，或直接移除 export
   （私有套件，無外部使用者）。
   **已修（round 7）**：export 與實作移除，14 個測試檔改走 composed 建構子；
   reachability 的 export row 也跟著消失。詳見上方量測。

3. **P1：`deleteOwnedSession` 先標記刪除、再 drain 已接受的寫入**
   `delete-owned.test.ts:40`：`Session is deleting or deleted`
   （`mutations.ts:53` → `load.ts:51` → `mutations.ts:68`）。刪除順序需與
   accepted-write drain 對齊。
   **已修（round 6）**：`deleted` 狀態的 write-behind 改走 direct append（transition
   車道在刪除 admission 內是 `Session binding observation conflict`），回歸見上方
   量測章節。

4. **P1：`create` 接受 `parentSession` 但沒有 `seedLength`，append 才拒絕**
   `delete-owned.test.ts:12-14`：`create({origin:'subagent',parentSession})`
   成功，`append` 卻 `PROCESS_READ_UNAVAILABLE`（`process-read.ts:237`）。
   應在 create 就驗證 lineage 完整性。
   **已修（round 6）**：`validateLineageHeader` 在 create 入口拒絕不完整 lineage，
   回歸與待解衝突（`process-read-composition`）見上方量測章節。

5. **P2：`updateMeta` 把 downgrade/format 錯誤包成 `TASK_TRANSITION_FAILED`**
   `context-format.test.ts:39` 期待 `/downgrade|format/`，原因藏在 `.cause`。
   對 user-facing diagnostics 是退步。
   **已修（round 7）**：downgrade 檢查移到 transition 之前，訊息恢復原樣；回歸在
   `context-format` 的 cold v1 案例。

6. **P2：fork `seedLength` 語義改變**
   composed fork 的 header `seedLength` 是 4（compiled seed records），
   legacy 是 10（raw prefix）；訊息內容相同。需確認是否有下游依賴舊值
   （`replacement-journal.test.ts:40`）。

7. **P1：composed 路徑把 typed error 全部包成 `TASK_TRANSITION_FAILED`**
   `task-document-transition.ts:234` 把所有失敗包成
   `new Error('TASK_TRANSITION_FAILED', { cause })`。format-15 標頭、unknown
   event type、non-positional seq 都只剩泛用外層錯誤；呼叫端用
   `instanceof SessionFormatUnsupportedError` 會失效（conversation-format ×2、
   repair ×1、passive-code-store-bootstrap ×1）。
   **已修（`e78fe6ca`）**：wrapper 保留原始 `code`，format 拒絕得到穩定的
   `SESSION_FORMAT_UNSUPPORTED`；probe（format-15 header → composed
   `openManagedDocument`）得到 `CODE SESSION_FORMAT_UNSUPPORTED`、
   `CAUSE SessionFormatUnsupportedError`。後續：把上述 4 個測試改為檢查
   `code`（而不是字串）即可一併轉綠，但那些檔案同時有 monkeypatch 問題，
   留在第 4 批一起處理。

8. **P1：每次 append 都會修補 open tail**
   `append(turn/start)` 後 `append(step/start)` 會在中間寫入合成的 `turn/end`；
   下一次 append 再補 `step/end`。被拒絕的 append 也可能留下 durable repair
   batch；且「acceptance 晚於既有 batch」會被 `append conflicts with durable
   prefix` 拒絕（conversation-format test 1）。需確認 transition load 的
   repair 邊界（`load.ts:64-79`、`task-document-transition.ts:215`）。

9. **P1：`process-read-pending-retry` 測試會無限 hang**
   `vitest run test/process-read-pending-retry.test.ts` 240s 無輸出、vitest 5s
   timeout 也不觸發，必須殺 process——疑似 reconcile 路徑的同步 hot loop。

---


## 其他 gate 的債務

### `check-reachability --gate`（**round 27 已轉綠：PASS**）

經 17 輪比對：可移除的 export 逐批拆掉（~50 筆），真正的公開契約則加
`reachability-allowlist.json` 並附 `dated`、reason、source。現在
`node scripts/audit/check-reachability.mjs --gate` 輸出 `gate PASS -- no new rows`（exit 0）；
baseline 仍為 456 rows，目前 381 rows、無 inert 警告。以下為當時的紅清單（歷史）。

- 435 rows（baseline 456，103 筆已消失是進度），但 **71 筆是 baseline 之後新增**：
  多數是 `unused-export`（`core-agent` 6、`core-session` 10、`core-tools` 8、
  `exec` 7、`sdk` 2、`session-executor` 5…），另有 1 筆
  `producerless-event session/queued`（telemetry manifest 宣告但沒有 producer）。
- 2 筆 allowlist 條目已經沒有對應 row（`output-retention#gcSpillStore`、
  `sdk#SdkRunError`）——**已刪除**（`reachability-allowlist.json` 38 筆，
  gate 不再報 inert）。
- 處理原則：能移除的 export 直接移除（型別 export 不影響 runtime）；確實是公開
  契約的就加回 allowlist 並註明理由；`session/queued` 要補 producer 或刪
  manifest 條目。**不要**直接 `--write-baseline` 把 72 筆吞掉。

## 待辦順序（下一輪起）

1. ~~修 P0（deep-JSON）與 P1 #3/#4，各補一個回歸測試。~~ → round 6 完成（見上）。
2. ~~決定 #2 的 API 去留（移除或補參數），同步清掉 15+ 測試的建構子。~~
   → round 7 完成（移除 export，14 檔遷移，見上）。
3. A 類測試（建構後 monkeypatch）逐檔改用 pre-bind seam；每檔一次 PR/commit，
   並用本文件的 `test-env` 指令驗證。
   **round 10：11/11 檔遷移完成**，8 檔全綠；`bootstrap-physical` 46/58、
   `bootstrap-capture-physical` 57/61、`current-context-predecessors` 3/12 的剩餘紅
   都是語義（歸第 4 項，共 25 個已列形的案例）。
4. B 類 predecessor 語義決策：若 composed 升級 13→14 是正確行為，更新
   `child-bootstrap-predecessor`、`semantic-codec2-predecessor` 的位元組斷言；
   若否，回頭修產品。
   **round 12 進度：`session-executor` 第一批（owned-* 17 檔）**。Windows 上該套件
   `vitest.config.ts` 關閉 fileParallelism，單檔要 30–140 秒，17 檔約 25 分鐘；
   已完成 8 檔全綠：`owned-service-shell`(15)、`owned-workflow-service`(7)、
   `owned-metadata-runtime`(18)、`owned-service-title`(7)、`owned-code-nested-shell`(2)、
   `owned-plugin-catalog`(6)、`owned-task-service`(2)、`owned-code-service`(2，單跑 29.6s)。
   量測中發現 **單檔就吃 30–140 秒**，批次跑到第 8 檔後被本輪中止（不是 hang；
   `owned-code-service` 單跑可完成）。**round 31 完成剩餘的 11 檔：11/11 檔、21/21 tests 全綠**（batch2，字串列表下列為當時的清單）。
早先已完成 8 檔；合計 owned-* 子集 **19 檔全綠**。

剩下的清單為（`owned-approval-causal`、`owned-code-mount`、
   `owned-code-nested-workflow`、`owned-code-stop-retry`、`owned-metadata-fold`、
   `owned-plugin-causal`、`owned-prefilesystem`、`owned-rewind`、`owned-service-title-debt`
   等）下一輪分組跑。套件實際有 223 個 `*.test.ts`（不是 99），全套要用多輪或分組跑。
round 28/29 量了兩個小套件：

- `token-meter`：**8 檔 / 53 tests 全綠**（2.4s）。
- `sdk`：**6 檔紅 / 13 檔綠（19 檔），11 failed / 108 passed（119 tests）**——已列為第 5 項待修清單的第一筆（含 `cancel-stop` 的 5 個 Stop receipt 案例、CLI 端到端 2 筆、cold native frames 2 筆等）。
- `instructions`：**1 檔紅 / 12 檔綠（13 檔），1 failed / 140 passed（141 tests）**。
- `runtime-context`：**1 檔紅 / 3 檔綠（4 檔），1 failed / 21 passed（22 tests）**。
  紅點名稱已補記：`instructions` = **「actual W1 128-key aggregate capacity bounds a new
  port without cancelling an accepted producer」→ Test timed out in 5000ms**（時間類；
  round 65 已加 `packages/instructions/vitest.config.ts`（30s），**13/13 檔、141/141 全綠**）；round 67 再量兩個套件：`preset` **2 檔 / 9 tests 全綠**、`provider-runtime`
  **7 檔 / 93 tests 全綠**。
round 70：`session-query` **4 檔紅 / 3 檔綠（7 檔），25 failed / 59 passed（84）**；
  `hooks` **19 檔全綠，167 passed / 1 skipped（168）**。
round 74：`core-plugin` **6 檔 / 58 tests 全綠**、`memory` **3 檔 / 4 tests 全綠**。
round 77：`todo` **1 檔 / 14 tests 全綠**、`text-diff` **1 檔 / 16 tests 全綠**。
round 89：`skills` **8 檔 / 61 tests 全綠**、`telemetry` **4 檔 / 19 tests 全綠**。
round 90：`settings` **18 檔 / 230 tests 全綠**、`plugin-registry` **12 檔 / 244 tests 全綠**。
round 91：`usage-stats` **10 檔 / 88 tests 全綠**、`mcp-client` **17 檔 / 109 tests 全綠**。
round 92：`terminal` **8 檔全綠，57 passed / 2 skipped**（第一次跑有 1 個 flaky 紅，重跑全綠）；
round 93：`fs` **15 檔 / 113 tests 全綠**、`shell` **11 檔 / 93 tests 全綠**。
round 119：`fs-search` **5 檔 / 51 tests 全綠**、`fs-watch` **5 檔 / 69 tests 全綠**。
round 120：`image-validation` **1 檔 / 19 tests 全綠**、`attachment` **2 檔 / 12 tests 全綠**。
round 147：`plan-mode` **1 檔 / 5 tests 全綠**、`interaction` **5 檔 / 29 tests 全綠**。
round 148：`goal` **1 檔 / 16 tests 全綠**、`diagnostics` **4 檔 / 49 tests 全綠**。
round 149：`workspace` **6 failed → 2/2 檔、24/24 tests 全綠**（legacy 建構子 → composed +
round 150：`sandbox-policy` **3 檔 / 67 tests 全綠**、`tool-search` **2 檔 / 19 tests 全綠**。
round 151：`sandbox-local` **4 檔綠 / 2 檔 skipped，22 passed / 6 skipped**；`fs-lock`
round 152：`credentials` **2 檔 / 23 passed + 1 skipped**、`harness-home` **1 檔 / 5 tests 全綠**。
round 154：`output-retention` **5 檔 / 45 tests 全綠**；`sandbox-windows-acl` **1 檔紅 / 39 檔綠 /
round 159：`sandbox` **9 檔 / 142 tests 全綠**、`sandbox-wsl` **8 檔綠 / 4 檔 skipped（63 passed / 20 skipped）**。
round 155：`soft-sequence-settlement` 的 3 紅 unmask 後真因是 **`PROCESS_READ_UNAVAILABLE`**
  （建構後 patch backend），與 code-mode／guard-repeat-tool 同一類；單獨跑時無
  `TASK_TRANSITION_FAILED`（全跑才出現，屬順序敏感）。→ core-agent 的 cleanup 群多數可望以
  same seam 遷移解決。
  5 skipped（45 檔），2 failed / 380 passed**——兩個紅都是「native initialization failed with
  retained cleanup debt」（koffi native 初始化，疑與本機環境有關）。
  **3 檔綠 / 1 檔 skipped，109 passed / 6 skipped**。
  lock）；`workspace-runtime` **3 檔 / 23 tests 全綠**。
round 125：`guard-timeout` **1 檔 / 7 tests 全綠**；`guard-retry` **1 檔紅 / 9 passed（10）**——紅點
  **round 126 已修**：`guard-retry` 在 `sleep(backoff)` **之後**沒有再檢查 caller signal，
round 127：`guard-approval` **11 檔 / 107 tests 全綠**；`guard-repeat-tool` **1 檔紅 / 8 passed（9）**
  **round 128 已修**：把 `entered`／`release` 提到建構前，掛鉤改走 `wrapOwnedBatch` 並用 composed
  建構子 → `guard-repeat-tool` **2/2 檔、9/9 tests 全綠**。
  ——紅點「awaits the actual owned repeat-feedback receipt for the exact observed session」原為
  `TASK_TRANSITION_UNSUPPORTED`（legacy 建構子），遷到 composed 後變成
  `PROCESS_READ_UNAVAILABLE`（建構後 patch backend），即與 `code-mode` 同一類、需同一個掛鉤決策。
  所以 backoff 期間 abort 仍會再派發；補上 `if (upstream?.aborted) break` 後 **10/10 全綠**。
  「does not re-dispatch after the caller signal aborts」→ `expected 2 to be 1`（abort 後仍再派發）。
round 94：`jobs` **1 檔 / 5 tests 全綠**、`workflow` **6 檔 / 66 tests 全綠**。
round 95：`lsp` **6 檔 / 94 tests 全綠**、`media` **3 檔 / 15 tests 全綠**。
round 96：`acp` **1 檔紅 / 16 passed（17）**（CLI stdio NDJSON：`Cannot read properties of undefined
round 101：`core-agent` 原 **13 檔紅 / 44 failed（79 檔 / 649 tests）**，10 個測試檔仍是 legacy
  round 143：加 `packages/core-agent/vitest.config.ts`（30s）→ **10 檔紅 / 35 → 9 檔紅 /
  round 144 抽樣：`soft-sequence-settlement` 首紅是 **`TASK_TRANSITION_FAILED`**（需讀 wrapper 的
  `cause`），其餘三紅是 cleanup 遮罩；`held-policy-receipt` 1 紅同屬 cleanup 群。
  紅檔清單（9 檔）：`held-policy-receipt`、`compaction-binding`、`soft-sequence-settlement`、
  `overflow`、`retained-boundaries`、`current-context-loopback`、`instruction-request-context`、
  `unstarted-call-settlement`、`retained-batch-continuation`。
  33 failed（649）**；剩餘分類：22× `Coordinator cleanup is unresolved`（多為遮罩，需 unmask）、
  6× `expected undefined to be defined`、1× `SYS-PROMPT`、1× `main authority`、1× length、以及少量 timeout。
round 115：`code-retrieval` **4 檔 / 54 tests 全綠**；`code-mode` **10 檔紅 / 18 檔綠
  **round 117 已遷移**：8 個 code-mode 測試檔改用 composed 建構子 → **9 檔紅 / 19 檔綠，
round 133：`compaction` 已由 3 紅轉 **33/33 檔、247/247 tests 全綠**——`managed-facts` 與
  `summary-observation` 的 `appendOwnedBatch`／`reconcileOwnedBatch` 掛鉤搬到 `wrapOwnedBatch`／
  `wrapOwnedReconcile`（計數器先宣告），並把 `finally` 的 close 改為只附加錯誤 → 真紅現形、逐一修正。
  **round 121 遷移配方**（給下一輪照做）：測試目前是 `backend.appendOwnedBatch = async (...args)=>…`
  **round 122 首例完成**：`broker.test.ts` 的 `appendOwnedBatch` 掛鉤搬進 `wrapOwnedBatch` →
  **round 134**：`managed-store-stop.test.ts` 同法遷移（計數器先宣告）→ **2/2 全綠**。
round 138 全套重跑：`code-mode` **7 檔紅 / 21 檔綠（28 檔），83 failed / 282 passed（365）**
  round 139：`store.test.ts` 單紅是「a failed completion flush overrides a persisted store
round 141：`session-query` 4 個測試檔遷到 composed 建構子 → **25 → 20 failed / 64 passed
  **round 142 收尾**：剩下的 `TASK_TRANSITION_UNSUPPORTED` 其實來自
  `task-document-transition.ts:95`（lock 未啟用）——補上 `{ lock: { enabled: true } }`；
  子會話建立需 `seedLength`（lineage validator）；current append 測試的格式改期待 14。
  → `session-query` **7/7 檔、84/84 tests 全綠**（由 25 failed）。
  （84）**、4 紅檔不變；剩餘 20 筆仍報 `TASK_TRANSITION_UNSUPPORTED`，來源不是測試檔的建構子
  （src 無 `createSessionCoordinator`），需追 session-query 工具內部開啟 session 的路徑。
  candidate and completed marker」→ `Managed facts require reconciliation`；該測試用非 durable
  `createSession()`（不是 jsonl backend），屬語義/生命週期問題，需與 cleanup-debt 一起判讀。
  （由 9 檔紅 / 86 failed 改善）。紅檔：`retention-callback-latches` 41、`cell-output-owner-lifetime` 27、
  `surface-publication` 5、`instruction-start-recovery` 4、`output-owner-boundaries` 3、`register` 2、`store` 1。
  **round 135 重要教訓**：`register.test.ts` 的 hook 若在建構時就生效，會攔到 `create`／
  **round 136**：加 `armed` 旗標（open 後才生效）仍 5s timeout → 不是 hook 攔到 open，而是
  `register` 這兩個案例的 settle 時序本身需要更長／或 hook 與 settle 互動有問題；此檔暫緩，
  先做 `surface-publication`／`output-source-recovery` 這類較單純的檔案。
  `openManagedDocument` 期間的 append/reconcile（測試原本是 open 之後才掛），導致 `mount.ready()`
  永遠等不到（30s timeout）。遷移時必須加 `armed` 旗標：open 完成後才 `armed = true`，hook 內
  `armed && …` 才生效。已還原該實驗（未提交）。
  **round 123 卡點**：`cell-output-owner-fixture.ts` 的後續掛鉤（line 115–134）依賴執行期狀態
  （`batch`／`receipt`／`target` 由測試參數決定），無法直接搬進建構選項；同類測試還有
  `instruction-start-recovery`、`output-source-recovery`。這批需要「建構後的合法掛鉤 API」
  （例如 `backend.hookOwnedBatch(fn)` 重新 bind guard）或把 fixture 改成在建構前先確定 hook 的
  形式——屬設計決策，不是機械遷移。`broker.test.ts` 之所以能遷是因為它的 hook 是靜態的。
  **11/11 全綠**（原本 `PROCESS_READ_UNAVAILABLE`）。其餘檔案照同一模式處理。
  與 `backend.reconcileOwnedBatch = …` 的建構後賦值。改法是：把包裹邏輯改寫成
  `createJsonlBackend(root, { wrapOwnedBatch: append => async (...args) => { …原邏輯，用 append 當原方法… },
  wrapOwnedReconcile: reconcile => async (...args) => { … } })`；需要跨測試共享的計數器/旗標先
  在檔案頂層宣告（`let`），wrapper 內用閉包讀寫。涉及檔案：`broker`、`cell-output-owner-fixture`、
  `instruction-start-recovery`、`managed-store-stop`、`output-owner-boundaries`、`output-source-recovery`、
  `register`、`surface-publication` 等。
  86 failed / 279 passed（365）**，`TASK_TRANSITION_UNSUPPORTED` 絕跡；剩 **83×
  `PROCESS_READ_UNAVAILABLE`**（建構後 patch backend，需 pre-bind seam）、1× FACT_RECOVERY 期待不符、
  1× reconciliation、1× timeout。
  （28 檔），94 failed / 271 passed（365）**——失敗原因分三類：**71× `PROCESS_READ_UNAVAILABLE`**
  （建構後 patch backend，需改用 pre-bind seam）、**22× `TASK_TRANSITION_UNSUPPORTED`**（legacy
  建構子）、1× `Managed facts require reconciliation`。前兩類都是本 session 已建立遷移模式的機械問題。
  建構子（全部 `TASK_TRANSITION_UNSUPPORTED`）；遷到 composed 建構子後降為 **10 檔紅 / 35 failed**，
  `TASK_TRANSITION_UNSUPPORTED` 絕跡。剩餘紅：3 個 `Coordinator cleanup is unresolved`（同一
  cleanup-debt）、1 個 `TASK_TRANSITION_FAILED`、若干行為斷言（`main authority`、`SYS-PROMPT`）。
  **round 97 排除**：在 `startInner` 的 flight 上「barrier.headerCommitted 為真時清
  **round 98 實測欄位**（`closeOne`，`bootstrap-stage-swap`）：
  **round 99 排除**：在 `startInner` 的 flight 上「outcome 為 ready／already-ready 就清
  **round 102**：`trackBootstrap`（bootstrap.ts:128–148）只負責 process latch 的 witness，
  **round 103**：`withBootstrapResume`（binding-observation.ts:293–299）只是 capture＋
  **round 104 執行期追蹤**：stage-swap 測試中 `adopt` 與 remap 都有跑，且都是
  **round 105 決定性證據**：`documents` 只有一個 key `target`；close 時該 entry 是
  **round 106 決定性證據**：在 `startInner` 的 `documents.set`（line 605）與 flight finally 的
  **round 107**：`documents.delete` 共 7 處——bootstrap.ts:608（已驗證未觸發）、:681（capture
  **round 108 修正解讀**：兩個 `NEW_ENTRY` 很可能分別是「第一個 coordinator 的 bootstrap」與
  **round 109 關鍵翻轉**：在 `start`（bootstrap.ts:572）與 factory 的 `resumeSemanticTarget`
  **round 110 定論**：把第二次 `resumeSemanticTarget` 包 try/catch 後**沒有** `RESUME2_ERR`——
  **round 111 揭曉真正失敗**：把兩檔的 `finally` close 改成 `.catch(console.error)` 後，真正的
  **round 113 已修測試衛生**：兩檔的 `finally` 改為「先捕捉 body 錯誤、close 只在沒有其他
  **round 114**：`child-bootstrap-physical` 也套用同樣的 finally 衛生改動，真實失敗現形為
  `expected ['ready','already-ready'] to include 'refused'`——即冷 resume 在某個 barrier cut
  之後回 `refused`（測試期待 ready/already-ready）。這是真正的語義問題，不是 cleanup 假象。
  失敗時才蓋上」，現在回報的是真實斷言（`task-target.doc.jsonl` 非 ENOENT）；
  `child-bootstrap-physical` 的 `finally{await cold.close()}` 同類問題待套用。
  斷言錯誤現形——`promise resolved "Buffer[123,34,102,111,114,…]" instead of rejecting`，
  即測試 line 35 的 `await expect(readFile('task-target.doc.jsonl')).rejects.toMatchObject({code:'ENOENT'})`
  **失敗**：blocked resume 之後 `task-target.doc.jsonl` **被建立**了（內容以 `{"for…` 開頭）。
  這才是 bootstrap 群紅的真正原因（cleanup-debt 只是 close 的二次現象）。下一步：確認 transition
  lane 在 blocked resume 時建立 task document 是否為預期行為；若是，更新測試期待（允許該檔存在
  並斷言內容）；若不是，修 lane 的 eager 建立。實驗已還原。
  即它沒有拋錯。配合 round 109 的 log（該次呼叫沒有 START_OUT），最可能是 `expect(...).toBe
  ('already-ready')` 的斷言失敗（實際回 `refused` 或 `blocked`），而 JS 的 `finally` 中
  `await coordinator.close()` 拋錯**覆蓋**了原本的斷言錯誤。所以 bootstrap 群 3 檔的
  `Coordinator cleanup is unresolved` 是**遮罩後的假象**；真正要看的是「stage 被替換/還原後
  第二次 resume 為何不是 already-ready」。下一步：把三檔測試的 `finally` 改成先記錄原錯誤
  再 close（或 close 用 catch 收集），以顯示真正的斷言差異。
  各加 outcome log 後，測試只印出 `START_OUT ready`（第一個 coordinator 的 bootstrap）、
  `START_OUT blocked`（第二個 coordinator 的第一次 resume）與一次 `FACTORY_OUT blocked`——
  **第二次 resume 既沒有 START_OUT 也沒有 FACTORY_OUT/ERR**，即它根本沒走到 factory 的
  `trackBootstrap`（很可能在 `captureSelfConflict`／guard capture 同步拋出）。因此測試看到的
  `Coordinator cleanup is unresolved` **是 finally 的 close 蓋住了真正錯誤**；cleanup-debt 可能
  只是次要現象。下一步：在 `resumeSemanticTarget` 入口用 try/catch 印出同步例外。
  「第二個 coordinator 的第一次 resume」；第二次 resume（line 37）**沒有**再建 entry（所以只有
  兩筆 log），而是直接回 `already-ready`——但該 entry 仍停在 `phase:'header'`、`ready:false`。
  即「already-ready 沒走 adopt」的謎團仍在；下一步應在 `startInner` 的所有 return 點印
  outcome 與 entry 狀態（確認是否有一條回 already-ready 但沒走 adopt 的分支，例如
  `entry.bootstrap` 已存在時走 `startInner:595` 那條）。
  finally，需 `!b.issued`）、:877、:908（selected/capture）、managed-documents.ts:66、:98、:255
  （open 失敗處理）。下一步在 :66、:255、:681、:877、:908 各插一行 log（帶 stack）即可定位；
  其中 :255 的 `open` rejection 路徑最可疑（若第一次 resume 的 open 以 rejection 結束，entry
  會被直接刪除，而 `blocked` outcome 仍可能被回傳）。
  `delete` 各加 log，stage-swap 測試印出**兩次 `NEW_ENTRY target`**（都來自 `startInner`），
  而**沒有**任何 `DEL_ENTRY`——即第二次 resume 時 `documents` 是空的，第一次 blocked resume
  的 entry 被「別的路徑」移除了（不是 startInner 的 flight finally）。下一步：在所有
  `documents.delete(` 呼叫點加 log（含 `closeOne` line 98、`revoke` 相關），找出移除者。
  `{ready:false, doc:false, issued:true, phase:'header'}`——正是**第一次 blocked resume** 留下的
  那個 entry，而不是 adopt 成功的那個物件。即第二次 resume 的 adopt 作用在另一個物件上，
  `documents` 後來又被換回／重建了。下一步：在 `documents.set`／`delete` 加 log，找出
  adopt 之後誰重建了 'target' entry。
  `{doc:true,current:true,ready:true,headerUnknown:false}`——即 target 的 bootstrap entry 是
  健康的。但 close 的 AggregateError 仍來自 `closeOne` line 96（headerUnknown 守衛），表示
  **失敗的是另一個 entry（不同 id，很可能是 task document entry，測試裡 `task-target.doc.jsonl`
  的 ENOENT 斷言正指向它）**。下一步：在 closeOne 印出 `id` 與 `documents` 全部 keys。實驗已還原。
  `bootstrapMutation(run)` 的薄包裝，不合成 outcome；所以 `already-ready` 仍應出自
  `start`→`adopt`。與 `document:false` 的矛盾未解，下一步只能做執行期追蹤：在
  bootstrap.ts:350（adopt 的 already-ready）與 :561（remap）各印一行（entry 是否有 document、
  是否為 `documents.get(id)`），跑 `task-transition-bootstrap-stage-swap` 一次即可定位。
  不碰 entry 的 `headerUnknown`；`attach`（managed-documents.ts:37）對已有 document 的 entry
  直接回傳，不會換 entry；而 `adopt`（唯一會產生帶 document 的 `already-ready` 的地方）
  必會 `attach`，所以 round 98 印到的 `document:false` 與「第二次 resume 回 already-ready」矛盾。
  結論：那個 `already-ready` 很可能來自 observations 層（`withBootstrapResume`）合成的結果，
  而非 `managed.resumeSemanticTarget`；下一輪要查該 wrapper。
  `headerUnknown`」仍三檔全紅 → 表示第二次 resume 的 `already-ready` 沒有經過該 flight（或
  close 時 `documents` 裡的 entry 不是 flight 的 `owned`）。下一步必須在 close 時印出
  `documents` 的所有 key 與 `owned` 的參照比較，確認是否有第二個 entry 存在。
  `{headerUnknown:true, document:false, headerCommitted:false, revoked:true, issued:true, phase:'header', current:true}`
  （`revoked` 是 closeOne 自己在 line 90 revoke 的結果；`ready` 未定義）。也就是說：第一個
  `resumeSemanticTarget` 回 `blocked` 後 entry 停在 `phase:'header'`、header issued 未 commit；
  第二個呼叫回 `already-ready` 卻**沒有**把這個 entry 的 `headerUnknown` 清掉（adopt 的 line 349
  只作用在它自己的 entry 上）。下一步：找 `resumeSemanticTarget` 回 `already-ready` 的實作，
  確保它對 `documents` 裡的那個 entry 標記 header 已確認。
  `headerUnknown`」→ 三檔仍 `Coordinator cleanup is unresolved`，表示這些 entry 的
  `headerCommitted` 是 false（或 close 走的是另一條路徑）。累計已排除：放寬守衛、只對 current
  entry 拋、document 路徑 fallback、ready 判斷、blocked 返回清旗標；下一輪需在 `closeOne` 直接
  印出 `entry` 的 `ready／headerUnknown／document／bootstrap.taskBarrier.headerCommitted／revoked`
  五個欄位才能定位。
  (reading 'stopReason')`，疑與建置/環境有關）；`compaction` 原 **4 紅全是 `TASK_TRANSITION_UNSUPPORTED`**
  （legacy 建構子），遷到 composed 建構子後降為 **3 紅，且全變成 `Coordinator cleanup is
  unresolved`**——即與 bootstrap 群同一個 cleanup-debt（`headerUnknown` 殘留 entry）。
  `web` **2 檔 / 16 tests 全綠**。
round 78：`schedule` **2 檔紅 / 4 檔綠（6 檔），3 failed / 97 passed（100）**；`rewind`
  **7 檔 / 72 tests 全綠**。`schedule` 三紅同源：live fold 失敗保留語義（預期 `uncertain`
  或 `undefined`，實際是 `TypeError: Original fold callback failed`）。round 79 定位：
  `core-session/src/managed/restored-view.ts:95` 的 `synchronous()` 會刻意把 fold callback 的
  例外包成 `TypeError('Original fold callback failed',{cause})` 並保留 `foldFailure`（fail-closed
  設計）；`schedule/test/fold-bridge.test.ts:78` 卻直接 `toThrow('uncertain')`（期待未包裝的
  原始錯誤）。另兩個測試期待 `undefined` 但收到包裝後的 TypeError。這是測試期待與產品設計
  不一致，需決定：改成斷言 `cause.message === 'uncertain'`，或產品在 `install` 首次失敗時
  原樣拋出。**round 80 已修**：斷言改為 `TypeError('Original fold callback failed')` 且
  `cause` 分別是 `'uncertain'`／`undefined`（產品 fail-closed 設計不變）→ **`schedule`
  6/6 檔、100/100 tests 全綠**。
round 75：`core-tools` **24 檔 / 187 tests 全綠**；`exec` **1 檔紅 / 28 檔綠（29 檔），
  1 failed / 366 passed（367）**——紅點「recovers the same real1MiB background artifact after
  losing its original finish receipt」→ `unknown job: bash-1`。
  測試位置：`packages/exec/test/retention-store-recovery.test.ts:12`，用真實 1 MiB 輸出＋
  `createContextOutputService` 的 retention store 重建流程；錯誤表示重建後 job registry 找不到
  原本的 job（`bash-1`）。下一輪：查 retention store 復原後 job 索引的寫入/讀取順序。
round 68：`provider` **2 檔紅 / 8 檔綠（10 檔），4 failed / 172 passed（176）**；
  `core-session` **1 檔紅 / 86 檔綠（87 檔），1 failed / 932 passed（933）**。
  紅點名稱：`core-session` =「durable exchange acceptance > indexes a large prefix once
  and visits only each proposed suffix」→ `expected +0 to be 20000`；`provider` =
  「preserves invalid raw input -1／1.5 without declaring accounting」（多了一個欄位）、
  「does not add a marker to signed or redacted assistant thinking」與「explicit off removes
  supported Responses content breakpoints while preserving tool data」（皆 `expected undefined
  **round 84 修一半**：兩個 invalid raw input 紅的根因是 `measurementValidity:'invalid'`——
  只有 llm-openai 會標，其餘三個 provider 沒標。已把同樣規則（`typeof === 'number'` 且非
  safe-integer 或 <0）加到 llm-anthropic／llm-gemini／llm-openai-compatible，並把 `provider`
  測試改為斷言 `{ inputTokens: count, measurementValidity: 'invalid' }`（仍不宣告 accounting
  semantics）→ `provider` 由 4 紅降為 **2 紅**（剩兩個 marker 紅）；三套 llm 測試與 llm-openai
  基線一致（1 個既有 M72 紅，與本次無關）。
  round 71 診斷：`visits` 只在 `entries()` yield 時遞增，而目前實作不再透過 `entries`（所以 0）。
  改測 `Symbol.iterator`＋`entries` 後得到 **60000**（3×20000）——表示 index 建構時對前綴做了
  **round 85**：兩個 marker 紅都失敗在 `capture()` 的 `expect(body).toBeDefined()`——
  請求根本沒發出去（stub 沒收到 fetch），不是 marker 內容不對。下一步要查 client 在
  signed/redacted thinking＋toolCalls 或 explicit-off breakpoints 這兩種輸入下是否提早結束
  （例如驗證/錯誤事件在 fetch 之前），再決定修產品或修測試的輸入。
  3 次走訪，或 hooks 被呼叫多次；需先確認實作是否真的退化（效能契約）再決定修產品或重寫 probe。
  **round 87 排除**：即使補一個前置 user turn，`anthropic-messages` 仍不發 fetch（body 仍
  undefined）→ 不是「訊息序列缺 user」的問題；需在 `buildModelClient` 的 stream 進入點直接觀察
  是否產生 error event（測試的 `for await` 會吞掉事件，不拋錯）。實驗已還原。
  兩次實驗均已還原。round 72 追加：`conversation/validation.ts` 只有一處
  `for (const event of events)`（line 431）；3 次走訪的其他來源很可能在 `createHistoryIndex`
  （core-session 內另一個模組），下輪沿該呼叫鏈數走訪次數即可。**round 73 定論**：只掛
  `Symbol.iterator`（不掛 entries）仍得到 **60000 = 3 次完整走訪**；而 `validation.ts` 只有
  一處 `for (const event of events)`（line 431）→ 同一段建構路徑被呼叫了 3 次。這是真實的
  「一次建構要走訪前綴三次」效能問題（測試契約正確），修法需重構 `conversationIndex` 的
  建構流程；已還原探針，未改產品。
  to be defined`）。
- `runtime-context` = **「original-only management settles actual
  absent without getter/action/retain or publication replay」→ resolved undefined instead
  of rejecting**（語義類）。round 66 定位：`test/original-disposition.test.ts:52` 的
  `it.each(['committed','absent','install'])`，只有 `absent` 這輪失敗，失敗點是 line 57 的
  `await expect(f.rc.settleOriginals()).rejects.toThrow()`——`absent`  disposition 在
  `allow()` 之前 `settleOriginals()` 直接 resolve。下一步：確認 absent 的 settle 是否應在
  `allow()` 前拒絕（與 committed/install 對齊），或測試期待需調整。**round 81 分析**：
  fixture 的 absent 路徑讓 `appendOwnedBatch` 只回 `{kind:'unknown'}`（不寫入）、`reconcile`
  在 `allow()` 前也回 `unknown`；`settleOriginals()` 的 `reconcileRecords` 只把 absent/not-issued
  放進 refused 而不拋，所以 absent 這輪 resolve 是**產品既有語義**（committed/install 才會因
  `unknown` 拋）。測試卻對三個 disposition 一律要求 reject；修正需把 absent 那輪改成
  `resolves` 並重新推導 counts（`finishes` 會變 1），屬測試期待調整，需一併改 line 56–60 的計數。
  **round 82 實測**：只把 line 57 的 absent 改成 `resolves` 後，失敗移到 line 59——
  absent 是 terminal（無 pending write），`next()` 後的下一次 render 也直接 resolve，而測試
  期待它拒絕到 `allow()`。結論：absent 需要**獨立的測試**（斷言 terminal 語義與對應 counts），
  不能和 committed/install 共用同一個流程；已還原實驗。
  **round 83 已修**：把 `it.each` 拆成 `['committed','install']`，並新增「an absent original
  settles as a terminal disposition and does not fence later renders」測試（斷言 settle 兩次都
  resolves、`issues` 由 1 → 2、後續 render 不再被 fence）→ **`runtime-context` 4/4 檔、
  22/22 tests 全綠**。
- `llm-seam`：**22 檔 / 188 tests，1 紅**（21 檔綠）。唯一紅是 `terminal-ownership-contract.test.ts`：它期待 private SDK ownership bridge 的 production importer 只有 `['.', './internal/bedrock-terminal']`，實際收到 4 個（已有額外檔案 import）。這是未量測套件既有紅，列入第 5 項待修。
  round 30 修正：它比的是 `package.json` 的 exports 清單，而該清單後來多了
  `./internal/passive-observation` 與 `./internal/stream-lifetime` 兩個已審查的內部 bridge；
  把期望值更新為四個 subpath（`importers` 仍只允許 Bedrock terminal）後
  **llm-seam 22/22 檔、188/188 tests 全綠**。
5. 量測 `session-executor`（223 檔）、`desktop-gateway`（61 檔）、`subagent`、
   `agent-team` 的 red 清單，補進本文件。
6. 全部轉綠後，才把 `verify:all` 的 full job 當成 gate；在那之前 CI 的必過項目
   仍是 typecheck + boundaries。

## 驗證指令

```powershell
# 全庫型別 gate
pnpm -r --no-bail typecheck
# 邊界 gate（147 baseline）
node scripts/audit/check-package-boundaries.mjs --gate
# 自帶隔離環境的套件測試
node scripts/test-env.mjs pnpm --filter @i-harness/session-persistence-jsonl test
node scripts/test-env.mjs pnpm --filter @i-harness/session-persistence test
# round 6 的回歸點（P0 deep-JSON、P1 #3/#4）
node scripts/test-env.mjs pnpm --filter @i-harness/session-persistence-jsonl exec vitest run test/managed-native-replay.test.ts test/delete-owned.test.ts
```

## 交接：2026-11-05 round 32

**已綠的 gate（可當 CI 必過項）**：
- `pnpm -r --no-bail typecheck`：**82 packages 全綠**（round 39 空載重跑）。
- `node scripts/audit/check-package-boundaries.mjs --gate`：147/147 PASS。
- `node scripts/audit/check-reachability.mjs --gate`：**PASS（0 NEW，381 rows，無 inert）**，
  由 round 6 的 70 NEW 經 17 批移除（~50 筆 export）與 dated allowlist 收斂。

**測試債務現況**：
- `session-persistence-jsonl` 全套 **106 failed / 751 passed / 17 skipped / 26 紅檔**
  （round 34 空載重跑；98 檔）。
- 三個 A 類檔的語義紅共 25 筆：`bootstrap-physical` 12、`bootstrap-capture-physical` 4、
  `current-context-predecessors` 9（逐條形狀見上文第 4 項）。
- 其餘 jsonl 紅檔：`task-transition-*` header/close 群、`semantic-publication` 24、
  predecessor 群（format8/11/13、codec2、child-bootstrap）、`archive-stream` 1 個 hang。

**第 5 項量測進度**：`session-executor` owned-* 19/19 檔全綠（30–140s/檔，Windows
關閉 fileParallelism）；`token-meter` 53/53、`llm-seam` 188/188 綠。未量：
`session-executor` 其餘分組（private-*/task-*/result-* 等，共 223 檔）、
`desktop-gateway`（61 檔）、`subagent`、`agent-team`。

**下一輪建議順序**：第 4 項語義紅（先 `bootstrap-capture` P09/P10 與 P14 release 計數，
再 `bootstrap-physical` outcome 差異），然後分組量測其餘套件，最後把 `verify:all`
full job 當 gate。

**已定位、尚未實作的具體修法**（round 37 查證）：

- `child-bootstrap-physical.test.ts` 的子程序 template（約 line 49–54）在
  `createJsonlBackend` 之後才 patch `bootstrapRoutes.reserveCapture`／`prepareBootstrapHeader`／
  `appendOwnedBatch`／`confirmBootstrapFrames`，所以子程序一啟動 bootstrap 就被
  canonical-path guard 判 `PROCESS_READ_UNAVAILABLE`。修法：把四個 patch 搬進
  `createJsonlBackend(root,{ wrap })` 的 pre-bind seam，並把 `p.createSessionCoordinator`
  改成 `composeJsonlTaskTransitionCoordinator(backend,{lock},
  taskDocumentStorageContract)`（即 `bootstrap-capture` P06 的成功模式）。
  **round 40 已實作**：child script 改成 `createJsonlBackend(root,{wrap})` + composed 建構子，
  `PROCESS_READ_UNAVAILABLE` 消失、測試主體（barrier／cold restart／receipt／bytes）全部通過；
  剩下唯一紅是 `finally { await cold.close() }` 拋 `Coordinator cleanup is unresolved`——新的
  cleanup-debt 語義（與 `bootstrap-stage-swap`／`stage-revision` 同一類），列入第 4 項。
  （round 41–43 定位：`Coordinator cleanup is unresolved` 來自 `coordinator-factory` 的
  `closeWithRetained`，其 rejection 鏈是 `Managed documents require recovery before close`
  → `Managed facts require reconciliation`（`managed-documents.ts:259` 的 AggregateError
  包住 `closeOne` 的失敗）。round 44 再收窄：該訊息是 `FactRecoveryRequiredError`
  （`FACT_RECOVERY_REQUIRED`），由 `core-session/src/managed/nondurable.ts:41` 的
  `assertNewWork` 在 `recoveryState.sticky || recoveryHolds.size` 時拋出——即冷 resume 後
  仍有 sticky recovery 或未釋放的 recovery hold。**round 46 修正線索**：durable managed
  document 走的是 `session-persistence/src/coordinator/bootstrap.ts`；`FactRecoveryRequiredError`
  的 throw 點是 `bootstrap.ts:359`（`assertCurrent`：`documents.get(id)!==entry || entry.revoked`）
  與 `:825`（`captureClosed || owned.revoked || documents.get(id)!==owned`）。即 close 期間某個
  bootstrap entry 的識別已失效（revoked／被 resume 換掉）。**round 47 再收窄**：最可能的
  throw 是 `resumeCachedReady` 內的 `assertCurrent`（`bootstrap.ts:359`），由已排入 flight
  的延續在 entry 被 revoke 後執行；`managed.closeOne` 會 await `entry.flight`，因此把該
  rejection 併進 close 的 AggregateError。下一步：在 `closeOne` revoke 前先 join flight，
  或讓 revoked entry 的延續走 `refused` 而非 throw（需確認 fail-closed 語義）。
  **round 48 關鍵發現**：`managed-documents.ts:closeOne` 有兩條路徑——
  `if(entry.document){await entry.document.close();return}`（line 85）直接關文件，
  而 `revokeManagedEntry(entry); await entry.flight?.catch(...)` 的 revoke/join 只在**沒有**
  document 的 entry（line 90）才做。冷 resume 後 entry 已有 document，所以走 line 85，
  文件內部的 currentness 斷言在文件關閉時仍以舊 entry 為準 → `FactRecoveryRequiredError`。
  下一輪候選修法：在 line 85 之前也先 `revokeManagedEntry(entry)` 並 join flight（或让
  document.close 對已 revoke 的 entry 容忍），再跑三檔驗證。
  **round 50 實測**：在 line 85 包一層「遇 `FactRecoveryRequiredError` 才 revoke+join 並重試」
  的 fallback，三檔仍全部 `Coordinator cleanup is unresolved` → 表示 rejection 不是裸的
  `FactRecoveryRequiredError`（可能是 AggregateError／另一層包裝），或失敗點不在 closeOne 的
  document 路徑。已還原該實驗；下一輪應先在 `managed.close()` 印出實際 rejection 的建構子
  名稱與 stack，再決定修法。
  **round 51 取得真實 stack**：throw 點是 `managed-documents.ts:96` 的
  `if(entry.headerUnknown) throw new FactRecoveryRequiredError()`（closeOne 的無 document
  分支）。即冷 resume 後該 entry 的 `headerUnknown` 仍為 true；`bootstrap.ts` 只有 line 349、
  514 兩處會清除它，冷 resume 走的另一條分支沒清。下一輪：找出冷 resume 後 header 已
  confirmed 的分支，補上 `entry.headerUnknown=false`。
  **round 52 實測**：把守衛改成 `if(entry.headerUnknown && !entry.ready)` 後三檔仍全部
  `Coordinator cleanup is unresolved` → 該 entry 的 `ready` 是 **false**（不是「已 ready 但
  flag 沒清」）。所以失敗的 entry 是一個「header 未確認、也還沒 ready」的殘留 attempt entry；
  需要的是在冷 resume 成功時**清掉這個殘留 entry**（或清它的 flag），而不是放寬守衛。已還原實驗。
  **round 55 再排除**：改成 `if(entry.headerUnknown && documents.get(id)===entry)`（只對
  current entry 拋）仍然三檔全紅 → 失敗的 entry **就是** `documents` 裡的 current entry，
  且 `ready=false`、`headerUnknown=true`。即冷 resume 的成功結果並沒有回寫到這個 entry。
  需要的是在 `resume` 成功時把「已確認 header」回寫到 current entry（或把該 entry 標 ready），
  不是 close 端的守衛問題。已還原實驗。
  **round 57–58 再收窄**：`adopt()` 其實會在成功時設 `entry.ready=true; entry.headerUnknown=false`
  （`bootstrap.ts:349`），所以失敗的 current entry 走的是**另一條**（例如 `blocked`）路徑：
  header 已 issued（`activeIssue` 設 `headerUnknown=true`）但最後回 `blocked`，flag 沒被清。
  下一輪：在 `run()` 回傳 `blocked` 前，若 durable state 已證明 header committed（或由後續
  成功 resume 證明），清掉 `entry.headerUnknown`；否則保留 fail-closed。
- 其餘 in-process 的 legacy 建構子已清完；`child-bootstrap-predecessor` 的紅在 generated
  `.mjs` predecessor runtime（format11-clean 腳本 line 18），屬 predecessor 語義。

## 交接：2026-11-05 round 7（歷史）

待辦第 1、2 項完成，第 3 項（A 類）11／11 檔全部遷移（8 檔全綠；三個 bootstrap／
predecessor 檔只剩語義紅，歸第 4 項）。`createJsonlBackend` 另有通用 `wrap` seam、
P2 #5 的 downgrade 修正。**第 5 項量測已起跑過 `session-executor`（99 檔，尚未完成，
下一輪重跑並記錄）；`desktop-gateway`（61 檔）、`subagent`、`agent-team` 仍未量測。**
下一輪優先：第 4 項的 `bootstrap-capture-physical` 4 紅（P09/P10 promotion、P14 release
計數）與 `bootstrap-physical` 的 12 個 outcome 差異。

## 交接：2026-11-05 round 5（歷史）

本 session 的上下文已用盡，停止在乾淨的 345541fe（工作樹 clean）。本輪只做狀態驗證：
全庫 typecheck 在 round 2 為 82 packages exit 0；reachability allowlist 已清到 38 筆、
不再有 inert 警告。**下一輪請開新工作階段**，從上面的「待辦順序」第 1 項（P0 端到端
回歸測試）開始；每次修完一項就更新本文件並 push。
