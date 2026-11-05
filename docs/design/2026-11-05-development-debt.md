# 開發債務清冊與 burn-down（2026-11-05）

這份文件處理的是**開發債務**，不是產品功能：讓「回歸」重新有意義，然後清掉
被產品 hardening 甩在後面的測試與 API。

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

2. **P1：`createJsonlSessionCoordinator` 在 format 14 無法建立/開啟會話**
   `backend-factory.ts:42-49` 組裝時沒有 `transitionStorage`，任何
   `create`/`openManagedDocument` 都 `TASK_TRANSITION_UNSUPPORTED`。
   目前沒有 production caller，但它是公開 export，且有 15+ 測試檔使用
   （desktop-gateway、session-executor、subagent、jsonl）。
   建議：讓它要求 `TaskTransitionConfiguration` 參數，或直接移除 export
   （私有套件，無外部使用者）。

3. **P1：`deleteOwnedSession` 先標記刪除、再 drain 已接受的寫入**
   `delete-owned.test.ts:40`：`Session is deleting or deleted`
   （`mutations.ts:53` → `load.ts:51` → `mutations.ts:68`）。刪除順序需與
   accepted-write drain 對齊。

4. **P1：`create` 接受 `parentSession` 但沒有 `seedLength`，append 才拒絕**
   `delete-owned.test.ts:12-14`：`create({origin:'subagent',parentSession})`
   成功，`append` 卻 `PROCESS_READ_UNAVAILABLE`（`process-read.ts:237`）。
   應在 create 就驗證 lineage 完整性。

5. **P2：`updateMeta` 把 downgrade/format 錯誤包成 `TASK_TRANSITION_FAILED`**
   `context-format.test.ts:39` 期待 `/downgrade|format/`，原因藏在 `.cause`。
   對 user-facing diagnostics 是退步。

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

### `check-reachability --gate`（目前紅）

- 435 rows（baseline 456，103 筆已消失是進度），但 **71 筆是 baseline 之後新增**：
  多數是 `unused-export`（`core-agent` 6、`core-session` 10、`core-tools` 8、
  `exec` 7、`sdk` 2、`session-executor` 5…），另有 1 筆
  `producerless-event session/queued`（telemetry manifest 宣告但沒有 producer）。
- 2 筆 allowlist 條目已經沒有對應 row（`output-retention#gcSpillStore`、
  `sdk#SdkRunError`），應刪除。
- 處理原則：能移除的 export 直接移除（型別 export 不影響 runtime）；確實是公開
  契約的就加回 allowlist 並註明理由；`session/queued` 要補 producer 或刪
  manifest 條目。**不要**直接 `--write-baseline` 把 72 筆吞掉。

## 待辦順序（下一輪起）

1. 修 P0（deep-JSON）與 P1 #3/#4，各補一個回歸測試。
2. 決定 #2 的 API 去留（移除或補參數），同步清掉 15+ 測試的建構子。
3. A 類測試（建構後 monkeypatch）逐檔改用 pre-bind seam；每檔一次 PR/commit，
   並用本文件的 `test-env` 指令驗證。
4. B 類 predecessor 語義決策：若 composed 升級 13→14 是正確行為，更新
   `child-bootstrap-predecessor`、`semantic-codec2-predecessor` 的位元組斷言；
   若否，回頭修產品。
5. 量測 `session-executor`（99 檔）、`desktop-gateway`（61 檔）、`subagent`、
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
```
