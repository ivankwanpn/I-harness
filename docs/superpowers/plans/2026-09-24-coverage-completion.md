# M79 — 覆蓋率補齊 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「行為已經正確、但沒有觀察者／沒有牙齒」的指名位置補上：五個可驅動的診斷站點、四個「窗口那半」的 hop、兩個零生產者的 union 成員（**移除**）、telemetry manifest 測試的型別牙齒、reachability 儀器的註解盲點、`CAPABILITIES-DETAIL.md` 的四個過期列數。**不加任何功能。**

**Architecture:** **甲類任務改變行為**（T1 加牙齒、T2 移除成員、T6 剝註解）⇒ 真紅先＋變異。**乙類任務只加觀察者**（T4 五個站點、T5 四個 hop）：生產行為**今天已經正確**（量過的），沒有可紅的實作 ⇒ 它們的「紅」以**拿掉觀察物件**重現——T4 把該站的 `d.<level>(...)` 暫時改走 console、T5 把餵入變數換成兄弟鍵——**具名斷言必須紅**，兩者都記錄。T6 最後做：它會**移動儀器的列集合**（baseline 重新播種），必須在所有其他任務之後。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest · Node ESM 腳本（`scripts/audit/`）

**Spec:** `docs/superpowers/specs/2026-09-24-coverage-completion-design.md`（權威；§1 設計、§2 驗收）

## Global Constraints

- **紅先與變異的紀律**：甲類＝先看到紅再實作；乙類＝先把「觀察物件」拿掉看到紅（見 Architecture）。每一條變異：**做一次、跑具名測試、看到紅**，再用 **Edit 工具**還原並以 `sha256sum` 確認位元組還原（**絕不**用 `git checkout --`）。**變異是預測**：實際用哪一行編輯**由你量測決定並記錄**（本樹的計畫對突變的預測常常錯——錯了就回報，不要換測試）。
- **既有斷言零條被放寬**。被指派的兩個例外：T1（manifest 那一條，closure plan §2.4 明文授權）與 T2（**若** `packages/diagnostics/test/diagnostics.test.ts` 有列舉 union 的斷言，**具名**回報後更新）。其餘任何既有測試紅了 ⇒ **回報**。
- **`docs/` 的例外**：**只有 T3** 可以動 `docs/CAPABILITIES-DETAIL.md`（且只動那四個站點與兩個行號範圍）。`docs/` 其餘（specs／plans／handoff）是控制器的紀錄，**一律不動**；其他任務完全不碰 `docs/`。
- **在 T6 落地之前，不要在 production 檔的註解裡新增任何 export 的名字**（儀器到 T6 之前對註解是盲的：一句註解會讓一列真話消失——這是本單位要修的病，不要在修的過程裡再製造一次）。
- **不新增 export**（`--gate` 不因新 export 加列；T6 的列變化來自儀器本身，走播種）。**不加 attribution trailer**；**不 amend**；blobs 用 LF；檔案用 Write/Edit 工具寫；**不要跑 `pnpm verify:all`**（那是 T7，單獨跑、不與 subagent 並行）。
- 測試檔的 `captureStream()`／`parsed()` 等小工具**逐檔重複是既有樣式**（9 個 `site-diagnostics.test.ts` 都這樣）——照抄，不要抽共用模組。
- **負載 flake**（既有、已量測）：`session-executor/test/shell-promotion.test.ts`、`apps/cli/test/cli.test.ts` 的 headless W10、`apps/cli` 的 M12 retry。紅了先隔離跑、**兩個讀數都記**。

---

### Task 1: telemetry manifest 測試的牙齒

**Files:**
- Modify: `packages/telemetry/test/manifest.test.ts`（`:6-24` 的 `it`）
- 只讀：`packages/telemetry/src/{manifest.ts,types.ts}`

**Interfaces:**
- Consumes: `TELEMETRY_EVENT_TYPES`／`TELEMETRY_MANIFEST`／`TelemetryEventType`（既有）
- Produces: 無（測試內部）

- [ ] **Step 1: 先重現缺陷（今天的樹上，突變不會紅）**

把 `| "provider/m79-probe"` 暫時加進 `packages/telemetry/src/types.ts` 的 `TelemetryEventType` union。跑 `pnpm --filter @i-harness/telemetry typecheck`。**預期：exit 0**（缺陷本體：union 多了成員、manifest 沒多列、**沒有任何東西變紅**）。用 Edit 還原，`sha256sum` 確認。

- [ ] **Step 2: 換上型別斷言（紅先的「紅」＝這條斷言在突變下會紅）**

把 `manifest.test.ts` 那個 `it` 的執行期同義反覆（`codes`／迴圈／`missing`）**換成**：

```ts
type Missing = Exclude<TelemetryEventType, (typeof TELEMETRY_MANIFEST)[number]["code"]>
// If a union member has no manifest row, `Missing` stops being `never`, this
// annotation becomes `false`, and `true` is not assignable to it — a typecheck
// failure at THIS line. (Measured: before M79 nothing failed; the runtime half
// was true by construction.)
const manifestIsExhaustive: Missing extends never ? true : false = true
expect(manifestIsExhaustive).toBe(true)
```

同時改寫 `:9-20` 那段「rewriting this into a type-level assertion is M79's」的註解成**事實**（它現在是型別斷言、以及失敗的形狀）。`it` 的名稱保留（「is exhaustive: every union code has a manifest row」現在在**有牙齒的方向**成真）。

- [ ] **Step 3: 跑，看到綠**

Run: `pnpm --filter @i-harness/telemetry test` 與 `pnpm --filter @i-harness/telemetry typecheck`。**預期：全綠**（`it` 數不變）。

- [ ] **Step 4: 變異證明**

重做 Step 1 的突變 ⇒ `pnpm --filter @i-harness/telemetry typecheck` **必須紅在 `manifestIsExhaustive` 那一行**（若同時別處也紅，**逐條記錄**——那也告訴我們牙齒之外還有誰在守）。Edit 還原、`sha256sum` 相符、typecheck 回綠。

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/test/manifest.test.ts
git commit -m "test(telemetry): the manifest test's missing direction finally has teeth — a union member without a row fails typecheck (M79)"
```

---

### Task 2: union 的兩個零生產者成員——移除，並把 union 釘在實測表面上

**Files:**
- Modify: `packages/diagnostics/src/record.ts`（union ＋ 檔頭 doc comment）
- Modify: `packages/core-session/src/index.ts`（`:145-151` 的內聯複本）
- Create: `packages/diagnostics/test/phase-union.test.ts`（型別級「恰等於」斷言；**若既有測試列舉 union，回報後更新那一條**）

**Interfaces:**
- Consumes: `DiagnosticPhase`／`DiagnosticRecord`（既有）
- Produces: `DiagnosticPhase` **恰等於 8 個成員**（下游不新增依賴；`apps/cli` 的漏斗不變）

- [ ] **Step 1: 先寫斷言（今天紅）**

在 `packages/diagnostics/test/phase-union.test.ts` 加型別級「恰等於這 8 個」的雙向斷言（放在一個 `it(...)` 裡）：

```ts
type MeasuredPhases = "cli" | "config" | "run" | "turn" | "sdk" | "session" | "mount" | "shutdown"
// both directions: a member added on either side is a compile error here.
type NoExtra = Exclude<DiagnosticPhase, MeasuredPhases>
type NoMissing = Exclude<MeasuredPhases, DiagnosticPhase>
const exactA: NoExtra extends never ? true : false = true
const exactB: NoMissing extends never ? true : false = true
expect(exactA && exactB).toBe(true)
```

Run: `pnpm --filter @i-harness/diagnostics typecheck`。**預期：紅在 `exactA`**（今天 `"acp"`／`"telemetry"` 是多的）——這就是紅先。

- [ ] **Step 2: 移除兩個成員與它們的載體**

- `record.ts`：union 刪掉 `| "acp"` 與 `| "telemetry"`；**改寫 `:20-33` 的 doc comment**：把 `sdk` and `acp`／`telemetry (its own sink errors)` 的句子改成事實，並加一段帶日期的說明：*這兩個成員 2026-09-24（M79）移除——實測**零生產者**（ACP host 走 `cli` handle；telemetry 的 sink 錯誤是 W6 的指名 byte-untouched 例外）。要加回來，照本段協定：加成員的提交要說它來自哪條縫。*
- `core-session/src/index.ts` 的內聯複本同步刪兩個字面（`DiagnosticPhase` 的漂移檢查是單向的：**不同步不會紅**——所以這一步靠人，不靠編譯器；完成後把兩份字面**並排抄進報告**證明一致）。

- [ ] **Step 3: 跑，看到綠＋既有套件不紅**

Run: `pnpm --filter @i-harness/diagnostics test`、`pnpm --filter @i-harness/diagnostics typecheck`、`pnpm --filter @i-harness/core-session test`、`pnpm --filter @i-harness/core-session typecheck`。**預期：全綠**（若 diagnostics 有測試列舉 union ⇒ 具名回報後更新；若 `apps/cli` 有東西引用那兩個字面 ⇒ 回報）。

- [ ] **Step 4: 變異證明**

把 `| "acp"` 加回 `record.ts` ⇒ diagnostics 的 typecheck **紅在 `exactA`**。Edit 還原、`sha256sum` 相符。

- [ ] **Step 5: Commit**

```bash
git add packages/diagnostics/src/record.ts packages/diagnostics/test packages/core-session/src/index.ts
git commit -m "refactor(diagnostics,core-session): the two union members with no producer are removed, and the union is pinned to the measured surface (M79)"
```

---

### Task 3: `CAPABILITIES-DETAIL.md` 的 telemetry 列數

**Files:**
- Modify: `docs/CAPABILITIES-DETAIL.md`（**本單位唯一獲准的 doc 檔**；只動 `:22`、`:293`、`:295`、`:674`）

- [ ] **Step 1: 先重現（四個站點的字面）**

```bash
grep -n "19" docs/CAPABILITIES-DETAIL.md | grep -i "telemetry\|manifest\|碼\|行"
```

預期看到四個站點：`:22` 總表列、`:293` 標題（`manifest 19 碼（manifest.ts:16-37）`）、`:295` 句子（`= 19 行`，而句子裡實際列了 20 個名字）、`:674` 驗證清單（`19（telemetry/src/manifest.ts:16-37）`）。同時量母體：

```bash
grep -c '{ code: "' packages/telemetry/src/manifest.ts   # 23
grep -c '^  | "' packages/telemetry/src/types.ts          # 23
```

- [ ] **Step 2: 改**

- `:22` → `| Telemetry 碼 | **23**（manifest） |`
- `:293` → `manifest 23 碼（manifest.ts:16-49）`
- `:295` → 列舉**補上 `provider/usage, provider/truncated, provider/refused`（放在 `provider/error` 之後）**，並把 `（= 19 行` 改成 `（= 23 行`
- `:674` → `9. telemetry manifest 23（telemetry/src/manifest.ts:16-49）`

- [ ] **Step 3: 驗收（機械）**

```bash
grep -n "19\|20" docs/CAPABILITIES-DETAIL.md | grep -i "telemetry\|manifest"   # 零命中
# 列舉的那一行以「內容」定位（不要信行號）：它含 `provider/error, provider/usage`
# 或（修前）`provider/error, token/usage`——先把那行抓出來再數逗號：
grep -n "provider/error," docs/CAPABILITIES-DETAIL.md
grep "provider/error," docs/CAPABILITIES-DETAIL.md | grep -o ',' | wc -l       # 22 ⇒ +1 = 23 個名字
```

- [ ] **Step 4: Commit**

```bash
git add docs/CAPABILITIES-DETAIL.md
git commit -m "docs(capabilities): the telemetry vocabulary count is 23 rows everywhere it is claimed (M79)"
```

---

### Task 4: 五個可驅動的診斷站點——給它們觀察者

**Files:**
- Modify: `packages/plugin-registry/test/site-diagnostics.test.ts`（**追加**一格：commands 站）
- Modify: `packages/hooks/test/site-diagnostics.test.ts`（**追加**一格：trust 站）
- Create: `packages/sdk/test/site-diagnostics.test.ts`（**新檔**，兩格：`:224`、`:230`）
- Create: `packages/core-plugin/test/site-diagnostics.test.ts`（**新檔**，一格：`:458`）

**Interfaces:**
- Consumes: 既有 9 個 `site-diagnostics.test.ts` 的形狀（`captureStream()`／`parsed()`／`installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))`／`expect(warn).not.toHaveBeenCalled()`；**連檔頭與 `afterEach` 一起照抄**）
- Produces: `sdk` 與 `shutdown` 相位的**第一個**斷言（T2 的驗收 3 依賴它）

- [ ] **Step 1: 逐站寫測試（五格）**

引數與斷言的**最少要求**（字面以既有測試為樣）：

| 檔 | 驅動 | 斷言 |
|---|---|---|
| plugin-registry（追加） | 暫存目錄：`good.md` ＋ `mkdirSync(join(dir,"broken.md"))` ⇒ `describeCommands(dir)` | `phase: "mount"`／`level: "warn"`／msg 含 `skipping unreadable command file` 與 `broken.md`；`warn` 未被呼叫 |
| hooks（追加） | 寫一個非 JSON 檔 ⇒ `createHookTrustStore(path)` | `phase: "config"`／`warn`／msg 含 `is not valid JSON`；`warn` 未被呼叫 |
| sdk（新檔） | `initialize` 帶 `"not-an-object"`（第一次 initialize） | `phase: "sdk"`／`warn`／msg 含 `params is not an object`；`warn` 未被呼叫 |
| sdk（新檔） | `initialize` 帶 `{ clientInfo: 42 }` | `phase: "sdk"`／`warn`／msg 含 `clientInfo is not an object`；`warn` 未被呼叫 |
| core-plugin（新檔） | `unmount: () => new Promise(() => {})` ＋ **`vi.useFakeTimers()` ＋ `await vi.advanceTimersByTimeAsync(5_000)`** ⇒ `ctx.unmount(name)` | `phase: "shutdown"`／**`error`**／msg 含 `timed out after 5s`；**`error` 未被呼叫** |

- **core-plugin 的機制**：假計時器**先試**；若量到 race 語意不符（例如 `timedOut` 不為真），退回真時間形狀（照 `plugin.test.ts:250-286`，測試 timeout 設 15 s）。**兩種都可以，實測決定並把機制與牆鐘成本寫進報告。**
- sdk 的 `captureStream`／`parsed`／`makeRequest` 若在 `server.test.ts` 是區域 helper ⇒ 在新檔裡**抄最小的那一份**（樣式如此），不要從 `server.test.ts` 匯出。

- [ ] **Step 2: 跑，逐格紅先**

Run: `pnpm --filter <pkg> test`（四個套件）。每格先跑**拿掉 `installDiagnostics` 的版本**：`lines` 的斷言必須紅（記錄走 console）。**記錄每一格的紅。**

- [ ] **Step 3: 裝上觀察者 ⇒ 綠**

把 install 那行加回 ⇒ 該套件全綠（**既有測試零改動**；sdk／core-plugin 的既有 console 間諜測試在**別的檔案**，不受影響）。

- [ ] **Step 4: 變異證明（逐站）**

把該站的 `d.<level>(...)` 呼叫暫時改走 `console.<level>(...)` ⇒ **該格的 record 斷言紅**（記錄不再產生）；Edit 還原、`sha256sum` 相符。若某站的形狀讓這個突變做不到，改用「拿掉 install 那行」並記錄。

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-registry/test/site-diagnostics.test.ts packages/hooks/test/site-diagnostics.test.ts packages/sdk/test/site-diagnostics.test.ts packages/core-plugin/test/site-diagnostics.test.ts
git commit -m "test(diagnostics): the five drivable sites get their observers — sdk and shutdown for the first time (M79)"
```

---

### Task 5: 四個「窗口那半」的 hop——用誘餌值讓交換可觀察

**Files:**
- Test: `packages/session-executor/test/assembly.test.ts`（**新增三條**；既有測試零改動）
- 只讀（餵入端）：`packages/session-executor/src/assembly.ts:1146`／`:1182`、`packages/agent-team/src/scheduler.ts:221`、`packages/guard-approval/src/guardian/reviewer.ts:178`

**Interfaces:**
- Consumes: `agentCalls`（`assembly.test.ts:31-41` 的 `vi.mock` 記錄的 `createAgent` deps）→ `deps.budget.contextWindow`；既有辨識機制（`:864` 隊友的 systemPrompt、`:1532` reviewer 的 systemPrompt）
- Produces: 四站的觀察者（T5 交付；T4 的相位普查與此無關）

- [ ] **Step 1: 三條測試**

1. **hop 1＋4（繼承臂）**：fixture `contextWindow: 8_000`、`maxOutputTokens: 100_000`、`guardian: {}` ⇒ 斷言**reviewer 子代理**的 `budget.contextWindow === 8_000`（並可加一條 wire 夾取的次要斷言）。
2. **hop 1＋4 的閘（配置臂）**：fixture 帶一個**配置的 guardian 模型**（既有測試的形狀） ⇒ 斷言子代理的 `budget.contextWindow` **不是** session 的 20 萬——**是缺席路徑的實測值**（**先量出那個值再寫斷言**）。**優先新測試**；若非改既有測試不可 ⇒ 停下來回報（NEEDS_CONTEXT）。
3. **hop 2＋3（team 分支）**：fixture `team: {}` ＋ `contextWindow: 8_000`、`maxOutputTokens: 100_000` ⇒ 斷言**隊友**子代理的 `budget.contextWindow === 8_000`。

若 `compact: { contextWindow: 4_000 }` 不擾動 fixture，再加第三個誘餌；做了就記錄。

- [ ] **Step 2: 跑，看到綠（並記錄：它們到場即綠——生產行為今天已經正確）**

Run: `pnpm --filter @i-harness/session-executor test`。

- [ ] **Step 3: 變異證明（逐站，這是本任務的主要證據）**

| 站 | 突變 | 預期 |
|---|---|---|
| `assembly.ts:1146` | `opts.contextWindow` → `opts.maxOutputTokens`（或 `opts.compact?.contextWindow`） | 測試 1 的 `budget.contextWindow` 斷言紅 |
| `reviewer.ts:178` | 拿掉 `deps.model === undefined &&` | 測試 2 紅 |
| `assembly.ts:1182` | `opts.contextWindow` → `opts.maxOutputTokens` | 測試 3 紅 |
| `scheduler.ts:221` | `sub.contextWindow` → `sub.maxOutputTokens` | 測試 3 紅 |

每一條 Edit 還原、`sha256sum` 相符。**若某一條突變殺不死具名斷言 ⇒ 回報它**（那表示誘餌設計在那站失效）。

- [ ] **Step 4: Commit**

```bash
git add packages/session-executor/test/assembly.test.ts
git commit -m "test(session-executor): the four window-half hops get observers, with decoy values a swap moves (M79)"
```

---

### Task 6: reachability 儀器——註解不再是「使用」

**Files:**
- Modify: `scripts/audit/check-reachability.mjs`（`scanUnusedExports` `:410-424`；剝註解的 helper 與 `codeOnly` `:484-513` 同一個狀態機；self-test `:986-994` 反轉＋新增案例；說明 `:961-985` 改寫）
- Modify: `scripts/audit/reachability-baseline.json`（**只用腳本自己的 `--seed-baseline`**，不手改）

**Interfaces:**
- Consumes: 既有 `codeOnly` 的狀態機、`SELF_TEST_CASES`（`:251`）、`--self-test`／`--json`／`--gate`／`--seed-baseline`（先讀腳本的 usage）
- Produces: class 1 的 `used` 判定**剝掉註解**（**字串內容保留**）；一份「新浮出的列」的逐條清單與歸類

- [ ] **Step 1: 先寫 self-test（紅先）**

- **反轉** `:986-994`：改名為「a COMMENT naming a type no longer suppresses the row (M79 fixed the documented false negative)」，`expect` 改成**那一列出現**。
- **新增**：entry 檔的註解**不再**讓列退休。
- **新增（護欄）**：一個名字只出現在 production 的**字串字面**裡 ⇒ **仍然**讓列退休（防過度剝除）。

Run: `node scripts/audit/check-reachability.mjs --self-test`。**預期：兩條新的紅、護欄那條綠**（記錄 `self-test: N/39`）。

- [ ] **Step 2: 修改前先量列集合**

```bash
node scripts/audit/check-reachability.mjs --json > .superpowers/m79-reach-before.json   # or $TMPDIR
```

（記下**列數**——今天應是 **432**——與檔案的 sha256。）

- [ ] **Step 3: 實作**

- 新增一個「**只剝註解、保留字串內容**」的函式，**與 `codeOnly` 共用同一個狀態機**（參數化或共用核心；不要fork出第二套剝法）。它對 regex literal 的限制照 `codeOnly` 既有說明繼承。
- `scanUnusedExports`：`entryText` 變成**先剝註解、再塗白 re-export 語句**；每個 prod 檔的 `f.text` 也換成剝過的版本，**逐檔備忘**（同一檔會被 entry × name 多次提問）。
- 改寫 `:961-985` 的說明與 `:374-379` 裡與「comments included」有關的字句。

- [ ] **Step 4: 跑，看到綠＋量新列**

```bash
node scripts/audit/check-reachability.mjs --self-test     # 39/39
node scripts/audit/check-reachability.mjs --json > .superpowers/m79-reach-after.json
```

**逐條列出**修後才出現的列（用 rowKey 形式比較，不手抄）。每一條歸類：

- **(a) 真的沒人消費** ⇒ 它是**真發現**：用 `--seed-baseline` 重新播種（baseline 的 `count`／`digest` 由腳本更新），**逐條具名**寫進報告。
- **(b) 其實有人消費、只是字比對看不見**（例如只出現在字串）⇒ **不自行播種、回報控制器裁決**（那是儀器的新一類偽陽性）。

**只量不修（寫進報告）**：class 2（`EVENT_LITERAL` 掃 raw `f.text`）與 class 5（`:762` 的 raw read test）是否有同一個「註解當證據」的病；**本任務不改它們的行為**。

- [ ] **Step 5: 變異證明**

把剝註解的呼叫**只**從 `entryText` 那一路拿掉（或把 helper 換回 raw `f.text`）⇒ **反轉的那條 self-test 紅**。Edit 還原、`sha256sum` 相符。

- [ ] **Step 6: 播種後驗閘**

```bash
node scripts/audit/check-reachability.mjs --gate      # PASS（新列已在 baseline）
```

- [ ] **Step 7: Commit**

```bash
git add scripts/audit/check-reachability.mjs scripts/audit/reachability-baseline.json
git commit -m "fix(audit): the reachability instrument stops reading comments as uses, and the rows they hid are named (M79)"
```

---

### Task 7: 收尾（閘門＋報告）

**Files:** 無（只跑閘門與寫報告）

- [ ] **Step 1: `pnpm verify:all`（單獨跑、不與 subagent 並行）**

Expected: 五步全綠（母體 67）。reachability 的讀數是**修後播種**的列數（與 **432** 的差要能逐條對上 Step 4 的清單）。**若 suite 紅在已量測的負載 flake**：隔離跑、**兩個讀數都記**。

- [ ] **Step 2: 報告**（寫給控制器，不進 git）

紅先證據（逐條）、GREEN、**每一條變異與其 sha 驗證**（含實際用的那行編輯）、被改動的既有斷言（預期：T1 一條、T2 若有則具名一條）、**讀數**：三個套件的新 `it` 數、`--self-test` 案例數（36→39）、reachability **修前 432 → 修後 N**（附新列清單與歸類）、core-plugin 那一站的**計時器機制與牆鐘成本**、以及「八個相位成員 → 斷言它的測試檔」表。

---

## 驗收（照 spec §2）

1. 五個站點各有觀察者（T4）。2. 四個 hop 各有觀察者且交換會移動數字（T5）。3. union 恰 8 成員、每人有相位斷言、內聯複本同步（T2＋T4）。4. manifest 突變紅在該行（T1）。5. 儀器 self-test 39/39、新列逐條指名、播種後 `--gate` PASS（T6）。6. doc 無 19／20 的 telemetry 列數（T3）。7. `pnpm verify:all` 五步全綠、算術寫出來。8. 既有斷言零放寬（兩個具名例外除外）、不新增 export。

## 殘餘（本階段**不做**，寫出來不是忘了）

- `subagent/src/tools.ts:829`（`session`，量過驅不動）與 `subagent/src/child.ts:399`（只有 console 間諜）。
- class 2／4／5 的註解危害稽核結果（只量不修）。
- core-session 內聯 union 的**單向**漂移檢查（本階段同步了兩個字面）。
- `docs/` 其餘過期載體（2026-09-11／15 audit 的「20 rows」、2026-09-17 spec、W6 handoff `:167`）。
- 只被字串提到的 export 仍不會有列（剝註解不剝字串的刻意取捨）。
