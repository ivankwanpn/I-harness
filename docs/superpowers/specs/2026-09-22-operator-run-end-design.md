# `operator/run-end` —— 常駐的那一半（durable run 紀錄）Design

**一句話**：一次執行結束時，把它的**身分與結局**寫進 session 的 durable log，讓它在 stderr 消失之後，還回答「哪一次、怎麼死的、花了多久」。

**來源**：M3 spec §3.4（`docs/superpowers/specs/2026-09-17-m3-measurement-foundation-design.md:197-213`）＋ 孤兒列 C1（`docs/handoff/2026-09-20-queued-work.md:950`）。**分級 S**（一個事件＋一個漏斗＋兩個表面；動引擎型別一格）。**取樣／自創**：**自創**（M3 spec §4 的來源表 `:271`；2026-09-22 的先例掃描亦證實：**沒有**參照工具有 run-end 紀錄——durable 的是 trace，不是結局）。

---

## 0. 它讓什麼變得不一樣

今天，一次失敗的執行**只在失敗的當下**存在：`failureReport` 印在 stderr（該函式的註解自稱 **LOSS CONTRACT**，`apps/cli/src/run.ts:256`），要事後看就得**事先**開 `I_HARNESS_LOG`。而那條被兩份文件照抄的完成定義——「**一次失敗的執行不需要人手讀 JSONL 就能定位**」——今天在任何模式下都取不到。

量測（2026-09-22，全部在 `m68`）：

| 事實 | 讀數 |
|---|---|
| `turn/end` 的形狀 | `{ type: "turn/end"; seq?: number }`（`packages/core-session/src/index.ts:26`）——**無 error、無 exitCode、無時長** |
| `sessions list` | `ID · TITLE · TURNS · UPDATED`——**無狀態欄**（`apps/cli/src/sessions.ts:113`） |
| `sessions show --last N` | 只渲染 5 種事件，`default: return undefined`（`apps/cli/src/sessions.ts:143-157`） |
| CLI 失敗路徑 | 只發即時診斷：`runD.error(failureReport(...))`（`apps/cli/src/index.ts:488`） |
| M4 補的是 | `tool/dispatch`（派送邊界）——**不是** run 級結局 |

⇒ M3 spec 許諾的「`sessions show --last 5` ← **失敗那一行**：runId、phase、exit code、時長」（`:211`），**那一行從未被寫下**。

## 1. 設計

### 1.1 事件形狀（照 spec §3.4 `:201`）

```ts
// packages/core-session/src/index.ts 的 SessionEvent union（現起於 :5，末員在 :139 附近）
| { type: "operator/run-end"; version: 1; runId: string; exitCode: number
    durationMs: number
    // the phase vocabulary is @i-harness/diagnostics' DiagnosticPhase — INLINED
    // because core-session must stay dependency-free (job/status precedent, :81-83);
    // the producer (the CLI run path) owns the event.
    phase: "cli" | "config" | "run" | "turn" | "sdk" | "acp" | "session" | "mount" | "telemetry" | "shutdown"
    error?: string; seq?: number }
```

- **`phase` 內聯，不 import**：`core-session` 今天**零 import、零 dependencies**（`package.json` 沒有 dependencies 區塊；原始檔只 re-export 自家的 `./inbox.ts`），而 `job/status` 對 `@i-harness/subagent` 的 `JobStatus` 就是這樣處理的。**漂移由生產者把關**：CLI 的漏斗簽名收 `DiagnosticPhase`（從 diagnostics 套件 import），賦值進這個欄位——**diagnostics 若新增成員而這裡沒跟上，CLI 當場編譯失敗**。
- **`runId` ＝ W6 bootstrap 已 mint 的那一個**（見 1.3）。
- **`error` 是已 redact 的一行**（`fromError(err, redactor).message` 的產物），**不是裸 `Error`**——沿用 W6 §3.5 強制力第 2 層：衍生的才可以進記錄。
- `version: 1` 沿用 `rewind/point` 的先例（additive union 成員帶 version）。

### 1.2 生產者＝**三個 append 站點，各自緊鄰既有的排空**（**寫計畫時量測後更正**）

原稿寫「既有的 `emitSessionEnd` 漏斗即生產者」。**`run.ts` 的順序量測推翻了它**：漏斗是 **telemetry 專用**的，而成功路徑的 `coordinator.close()` 在 `:748`、`emitSessionEnd(0)` 在 `:778`——**append 若放進漏斗，成功那一筆會被已關閉的 coordinator 吃掉**。更正後：**漏斗一字不動**（telemetry 契約不變），append 獨立成三站。

| 出口 | append 站點 | 緊鄰的**既有**排空 | phase |
|---|---|---|---|
| 組裝／掛載前失敗 | `run.ts:652` 的 catch 內 | `:654` `await coordinator.close()` | `mount` |
| 成功 | **`:740-741` 的 `flush` 之前** | `:741` `flush` → `:748` `close()` | `run` |
| run 期間失敗 | `:782` 的 catch 內 | `:784` `await coordinator.close()` | `run` |
| resume 載入失敗 | **不寫**（見下） | —（`:343-345` 既不關 coordinator 也沒有 flush 可借） | — |

- **為什麼 resume 失敗不寫**：`loadOwned` 失敗 ⇒ **那個 id 在 store 裡沒有 session 文件**，這一筆沒有可落地的家——§4.1 的原則本來就涵蓋它。**因此不需要任何新的排空機制**：三個站點的既有 `flush`／`close` 就是排空。
- append 走 **`append(session, ev)`**（`packages/core-session/src/index.ts:323`），由既有的鏡射回呼進 coordinator（`run.ts:319-323`）⇒ **不需要新的寫入 API**。
- `durationMs` 的起點：在 `run.ts:308-312` 的 `session/start` 發射**旁邊、且無條件**記一個 `const runStartedAt = Date.now()`——那一塊包在 `if (telemetry)` 裡，**telemetry 關掉時它不執行**，所以時間戳必須在它之外（否則關掉 telemetry 的執行就沒有時長）。

### 1.3 `runId` 的接合（本單元最大的附加價值）

W6 的 bootstrap 每次宿主入口 mint 一個 `runId`，**診斷 JSONL 的每一筆都帶它**。讓 durable 記錄帶**同一個** id ⇒ 事後拿那一行就能回 JSONL 撈整個 run 的敘事（phase 時間軸）。代價：兩處 additive——`createCliDiagnostics` 的回傳多帶 `runId` 與 `redactor`（`apps/cli/src/diagnostics-bootstrap.ts:162` 現回 `{ diagnostics, uninstall }`），`runHeadless` 的 opts 多收它們（`apps/cli/src/index.ts:477` 的 boot 傳入）。

### 1.4 表面

- **`sessions list`**：列尾加 `LAST RUN`（`ok 1.2s`／`failed exit 1`／`—`）。實作上不是新的一次讀：`turnCount` 已經在做**全 log 讀取**（`apps/cli/src/sessions.ts:87`），同一次掃描裡取**最後一個** `operator/run-end`。舊 session 沒有這個事件 ⇒ **照 `StoredSessionRow` 的既有慣例「無法證明就缺席」**（`:29`）。
- **`sessions show`**：`transcriptLine` 加一個 case（`:143`），渲染成與其他行同風格的一行，內容＝exit code、時長、以及（有失敗時）已 redact 的 error。

### 1.5 載入閘門（本樹的**已知缺陷類**）

新事件型別**必須** `registerEventType("operator/run-end")`，放在既有的註冊旁（`packages/session-persistence/src/index.ts:247` 是最後一條）。**絕不 `ignorable`**——`load()` 會**丟掉** ignorable 事件（`:421-425`），等於把紀錄 erase。這個缺陷類在本樹**出貨過兩次**（`rewind/point`、`sandbox/mode`），所以測試形狀是**載入往返**（append → 存 → `load` → 事件還在），**不是 append 斷言**。

## 2. 驗收

1. **載入往返**：`operator/run-end` 過了存／載之後仍在（`session-persistence`）。
2. **三個生產出口各一例**：drive 真實的 `main(["…","run",…])`，斷言 `exitCode`／`phase` 對上（`mount`／`run`／`run`；成功與失敗各一）**且那一筆真的落地**（用 fresh coordinator 對同一個 store 讀回）。**突變：拿掉成功路徑的 append ⇒ 成功那一次沒有紀錄（紅）**。**另加一例**：`--resume <不存在>` ⇒ exit 1 且**沒有** `operator/run-end`（沒有 session 文件可寫——釘住 §1.2 的那條規則）。
3. **表面**：`sessions list` 有 `LAST RUN` 欄且舊 session 顯示 `—`；`sessions show` 把那行放進 transcript。
4. **redaction 接得上**：一則含已註冊秘密的錯誤 ⇒ 記錄的 `error` 已遮蔽（把 W6 的 redactor 與 durable 線釘在一起）。
5. **runId 可接合**：同一跑之中，`I_HARNESS_LOG=stderr` 的 JSONL `run` 欄位**等於** durable 記錄的 `runId`。
6. **`pnpm verify:all`** 五步全綠（母體 67；`--gate` 不得新增 row——新 export 要有真消費者，否則逐列 allowlist 附 `reason`＋`dated`）。

## 3. 刻意不做（YAGNI）

- **`sdk`／`acp` 的 run-end**：它們是**常駐宿主**（一個行程服務多個 session），「run end」語意不同——**具名 residual**，留給 operator 面的單元。
- **新 CLI 指令**：`sessions list`／`show` 就夠。
- **wire 變更**：`SessionEvent` 是引擎型別、**不是已發布的 wire**（spec `:297`；wire 是 `packages/sdk/src/protocol.ts`）。
- **OTLP**：M3 §5 Q5 已裁定延後。

## 4. 它不保證什麼（明說）

1. **在 session 存在之前就死的 run 沒有紀錄**——`activeId === undefined` 時沒有可落地的家（那正是 `failureReport` 說「no session — this happened before one existed」的那些）。
2. **SIGKILL／崩潰不產生它**——行程已死；那是 spec §3.6（崩潰紀錄與下次開啟時回報）的另一半，不在本單元。
3. **只涵蓋 CLI 的 `run`**（見 §3）。
4. **成功與失敗都寫**（`exitCode` 0 也寫）——那讓這一欄同時是**時長遙測**；成本是每次執行多一筆事件，這是有意的。

## 5. 殘餘（寫出來，不是藏起來）

- `sdk`／`acp` 的結局仍無處可查（§3）。
- 崩潰路徑仍只靠 stderr 與 §3.6 的未來工作（§4.2）。
- `error` 是**一行**、已 redact 的訊息——stack 不在其中（需要 stack 的人今天要開 `I_HARNESS_LOG`）。

## 6. 取樣與自創

| 部分 | 來源 |
|---|---|
| 事件本身（run 級、durable、帶 exit code／時長） | **自創**（M3 spec §4 `:271`；2026-09-22 的先例掃描：無參照工具為之） |
| 「損失契約」的寫法（明寫崩潰最多掉什麼） | 取樣（grok），**本樹已採用**——`failureReport` 的 `durable:` 區塊（`apps/cli/src/run.ts:256-267`，`ede0850`） |
| 載入閘門的紀律（註冊、不 ignorable、載入往返測試） | **自創**——由本樹自己的兩次出貨缺陷歸納出來 |
