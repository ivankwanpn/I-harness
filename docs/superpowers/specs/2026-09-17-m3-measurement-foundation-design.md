# I-harness 量測底座設計（M3）

**日期：** 2026-09-17 · **分支：** `m65`（自 `m64` `4ac8105` 分出）· **分級：L**
**輸入：** 路線圖 `docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md` §3.M3
**方法：** 本文件的所有引用都對 `4ac8105` **重新量測**過（路線圖 §1.1）。量測的原始記錄在
`.superpowers/sdd/m3/`（gitignored）；三份研究報告由唯讀代理產出。

---

## 0. 這份文件要解決什麼

路線圖給 M3 的一句話是：**「一個改動是好是壞可以量，不必靠人重讀程式碼。」**

今天不是這樣。本文件第 2 節量出五個結構缺口，而其中一個比路線圖描述的更糟：**一次死在工具呼叫中途的崩潰，會被寫成一句它無法確立的斷言**（第 2.4 節）。

**分級由 M 改為 L，這是本文件的第一個決定。** 路線圖 §1.4 的準則是：

| 級 | 適用 |
|---|---|
| **M** | 新增接縫或改變契約 |
| **L** | 改變別人依賴的介面、**或崩潰語意** |

在 `run` 路徑上安裝行程級的致命網（`uncaughtException` / `unhandledRejection`）＋ SIGINT/SIGTERM 處理，**改變的是行程怎麼死、以及呼叫者看到什麼 exit code**（1 / 130 / 143），並且新增一個別人會依賴的 durable 記錄。**那就是崩潰語意。** 所以路線圖對 M3 的立論（「additive、不動引擎」）對它一半的範圍不成立。

**為什麼不「保留 M 然後寫個理由」：** 寫一個超出準則的理由，正是這份路線圖存在的目的要移除的缺陷類別 —— 一個不從證據推導出來的聲明。L 多出來的那道程序（**互不重疊 scope 的最終審查**，沙箱那次的做法）與這個改動的失敗模式相稱：**一個 exit 0 的 handler 會把崩潰變成無聲的成功。**

---

## 1. 動工前的重量：四條已發布的宣稱被推翻

路線圖 §1.1 要求「任何引用自稽核文件的東西，進 spec 前必須對現行 HEAD 重量」。本節是那次重量的結果。**四條都是已發布的、被下游當成事實的宣稱。**

### 1.1 `§3.M3:136`「IH 無崩潰處理」——**兩個方向都錯**

實測：**三條出貨路徑上都有** signal 處理 —— `apps/cli/src/index.ts:600-601`（`sdk`）與 `:674-675`（`acp`），兩者都在生產路徑上，帶著 memoized 的 teardown；`apps/cli/src/web.ts:595-596`（凍結，僅引用）。

而真正缺的那件事**比「沒有處理」更糟** —— 見 2.4。

### 1.2 `§3.M3:144` 的指紋證據——**反了**（本文件作者親自重量）

原文說：*「`bash` 解析到 Git Bash 而非 WSL，因此該文件記載的兩個 `session-executor` 紅燈**在這裡不紅**」*，並以此作為「基線必須連同機器指紋一起記錄」的**理由**。

實測：

```
bash            → C:\Users\IvanKwan\AppData\Local\Microsoft\WindowsApps\bash.exe
bash --version  → GNU bash 5.2.21(1)-release (x86_64-pc-linux-gnu)
uname -s        → Linux                      ← WSL，不是 Git Bash
bash -c "node --version"  → /bin/bash: line 1: node: command not found   (exit 127)
```

而 `packages/session-executor/test/workspace-cwd.test.ts` → **2 failed | 4 passed**。

**所以那兩個紅燈在這裡是紅的。** 指紋要求的**結論**（記錄指紋）存活；它的**證據**是反的 —— 而一個由假觀察支撐的要求，沒有人能重新推導出它。

### 1.3 沙箱 spec `§7:296` 的 slice 成本歸因——**一個「更正」把原本正確的答案改成了錯的**

spec 與 `what-the-design-does-not-answer.md:19` 都說那個 `slice` 被量到約 `0.0013 ms`
（「複製 2 萬個指標……可忽略」），並據此結論掃描才是唯一真實成本。實測：

| 量測 | 結果 |
|---|---|
| `events.slice(0)`，20 000 事件 | **0.067–0.104 ms/call** |
| `slice(N-100)` | **0.0012 ms** ← 與 spec 的 0.0013 幾乎相同 |
| 生產形狀 `resolve({events: slice(0)})` | **0.1788 ms/call** vs 測試守衛量到的 **0.0487** |

`session.events` 是普通 `Array`，等價的普通物件對照組量到一樣的值，所以這不是 wrapper 假象；而且成本對迭代次數是平的（1→2000 次：0.093→0.104 ms），所以它是真實的複製成本。

**淨效果：對一個成長中的新 session（`policyFloor = 0`），slice 比掃描**更大**（約 0.072 vs 0.049）—— 那個守衛量的是便宜的一半，把生產成本低估約 2.5 倍。** 對 `--resume`（floor 在歷史末端）「可忽略」成立。**§7 把一個取決於情境的結果講成了普遍結論。**

而 `what-the-design-does-not-answer.md:19` 自己記錄著：作者**原本的 slice 歸因才是對的**，那是他們的「第二個錯誤」。**更正本身才是錯誤。**

### 1.4 `what-the-design-does-not-answer.md:21`「rests on one-off measurement rather than on a CI assertion」——**假的**

`packages/tui/test/bench.test.ts` 與 `bench-mouse.test.ts` **跑在預設測試套件裡**（`packages/tui/vitest.config.ts` 只隔離 `test/harness/case-027.test.ts`，bench 沒有被排除）。它們確實是「一次量測」，但**不是**「沒有 CI 斷言」。

### 1.5 附帶：`docs/CAPABILITIES-DETAIL.md:289` 說 manifest 有 19 碼——**是 20**

同一份文件的 `:473` 與 `:701` 說 `settings/changed` 沒有生產者 —— 那在 `settings/src/index.ts:1291` 落地後就不再成立。

---

## 2. 五個結構缺口（全部實測）

### 2.1 一次失敗的執行，只從一個沒有結構的地方可診斷

實跑 `run "hello" --session-dir DIR --telemetry`（無模型）：

```
stdout : {"type":"session/start","data":{"task":"hello","sessionId":"sess-…"}}
         {"type":"session/end","data":{"sessionId":"sess-…","exitCode":1}}
stderr : No model configured
store  : sess-….jsonl  (94 bytes) ← 全部內容只有 header 一行
sessions show <id>     ← 空
```

| 表面 | 帶著什麼 | 缺什麼 |
|---|---|---|
| stderr | 裸的 `error.message` | 時間戳、level、run id、session id、phase、時長、cause chain、stack |
| session JSONL | 只有 header | 關於失敗的一切 |
| stdout telemetry | run 開始／結束、exit code | 完全沒有那個錯誤 |
| exit code | `1` | 是大約 14 條 exit-1 路徑中的哪一條 |

結構原因：**`SessionEvent` 沒有任何通用的 error 成員** —— 提到 error 的四個（`team/member`、`job/status`、`subagent/end`、`command/done`）都各自綁在別的關注點上。`SessionMeta` 沒有 exit code、結束時間、或失敗欄位。

而 `telemetry` **不是**診斷日誌：它自己的檔頭就寫著 *「host 事件流（與 session log 分離；agent 不可見）」*，20 個碼裡沒有任何一個能帶 stack、cause、時長或 severity。它的 `error` 與 `warn` **零生產者**；`session/error` 只由 HTTP `SessionService` 產生，而 **headless CLI 從不建構它** —— 所以**一次失敗的 `i-harness run` 永遠不可能發出 `session/error`。**

### 2.2 harness 是天花板，不是偵測器

`packages/tui/test/bench.test.ts`（`3045013`，2026-09-04）與 `bench-mouse.test.ts`（`2416d74`）存在，而且**早於**說「IH 沒有 benchmarking harness」的那次稽核。它們是寫在 vitest 裡的計時斷言，自己的檔頭就承認是「GENEROUS thresholds (CI noise tolerant)」。

實測餘裕：append-5k **11.1 ms 對 2000 ms 的上限（180×）**；viewport-50 2.9/150；**fold-100 29.6/100（3.4× —— 唯一一個 10 倍會觸發的）**；search 31.9/250；retain 1.5/500。

**精確的講法是：IH 有 bench 形狀的計時斷言，但沒有會記錄基線並與之比較的 harness。** 兩個檔案都在凍結的 `packages/tui` 裡 —— 引用，不要蓋在上面。

### 2.3 全樹唯一的 payload redactor 住在凍結的套件裡

`redactToolPayload`（`packages/tui/src/tool-presentation/redact.ts`）是**唯一**的 payload redactor：`packages/tui/src` 底下 7 個檔案 ＋ 1 個測試，**凍結 TUI 之外零呼叫者**，掛在**渲染**邊界而非寫入邊界，鍵集是 5 個固定的不分大小寫名稱（`apiKey, api_key, token, authorization, password`），**沒有值形狀規則、沒有 PEM、沒有 hex/HMAC、沒有 URL userinfo**。

**明講：現有的 redactor 不能重用。** 它在一個預定汰換的套件裡，而且它只認鍵名的策略本來就蓋不住下面的洩漏路徑。這就是發現，不是障礙。

**已驗證的洩漏路徑：** LLM adapter 把 `await response.text()` 插進錯誤訊息（`llm-openai-compatible:128`、`llm-openai:141`、`llm-anthropic:141`、`llm-gemini:163`），所以一個回顯請求的閘道會把 `Authorization` / `x-api-key` 的值直接送進操作者的失敗文字；`run.ts:149` 把**整個 task prompt** 放上 stdout；`apps/cli/src/index.ts:571` 印出帶 launch token 的登入 URL；而 session log **逐字**儲存使用者訊息與工具結果（`core-session/src/index.ts:315-337`），所以 `read .env` 的內容原封不動進 store。

### 2.4 ⚠️ 崩潰會產生錯誤答案 —— **今天已經是真的**

`repairTurnTail`（`packages/session-persistence/src/repair.ts:113-124`）會給最後一輪裡每個沒有配對的 `tool/call` 蓋上：

```
{ error: "tool call aborted before dispatch", code: TOOL_ABORTED_BEFORE_DISPATCH }
```

—— **「派送前就中止」**的措辭 —— 然後 `loadOwned`（`session-persistence/src/index.ts:537-544`）把它**寫成磁碟上的正史**。

活著的 abort 路徑有資格這樣說，因為它追蹤一個真實的「從未開始」邊界（`core-agent/src/execute-tool-calls.ts:103-115,211-219`）。**崩潰修復層把同樣的話套在它原則上不可能知道有沒有派送過的呼叫上。**

**所以路線圖 §3.M4 的前提 ——「崩潰會產生錯誤答案」—— 不是未來的顧慮，而是今天的事實，就在修復層裡。** 一個 durable 記錄在斷言它無法確立的事。這是本專案一路在移除的同一種缺陷，只是這次斷言它的文件是 **session log 本身**。

**這是 M3 必須排在 M4 之前最強的理由。** 修法需要新的 event 詞彙，屬 M4 的範圍，不是 M3 的 —— 但它必須進 M4 的 spec，且不能被遺忘。

**另外，一次 SIGINT 打在 turn 中間會損失什麼（實測）：** 5 個事件入列 → jsonl **只有 1 行（header）、0 個事件**；明示 `flush()` 後是 6 行。曝險視窗是 write-behind 的 200 ms。而且**沒有任何 durable 痕跡顯示這次執行死過** —— 崩潰的 jsonl 與從未開始過的長得一模一樣。

### 2.5 全樹最好的崩潰處理是凍結層裡的死碼，而閘門看不見它

`packages/tui-core/src/signal/index.ts` —— SignalGate（第一次優雅、第二次強制，1000 ms 視窗；SIGINT/SIGTERM/SIGBREAK ＋ `exit` hook；可注入的 emitter）—— **零生產呼叫者，而且沒有從 `packages/tui-core/src/index.ts` export 出去。**

**兩個 M1/M2 漏掉的附帶發現：**
- **M2 的閘門對它結構上盲目。** `check-reachability.mjs` 對它**不報任何 finding** —— class 1 只走 package entry 的 export，所以一個沒有被 export、零呼叫者的模組在它的視野外。**entry-only 盲點，在野外又遇到一次。**
- **`apps/cli/bin/i-harness.js:28` 抹掉 signal exit code** —— `process.exit(code ?? (signal != null ? 1 : 0))` 把被信號殺掉的子行程映射成 **1**，130/143 消失。而 shim 沒裝 handler，所以打給 shim pid 的信號殺掉 shim、把真正的 CLI 子行程變成孤兒。
- `packages/fs-watch` **零生產消費者**，閘門也沒報。

### 2.6 metrics registry 比路線圖暗示的小得多

以「exit report ＋ benchmark harness」為唯一讀者，它是一個**固定鍵的計數袋**：沒有 labels、沒有 buckets、沒有 histograms、沒有 timers、沒有 exporter —— **約 60 行**。它的大小由 exit report 的行數決定。

---

## 3. 設計

### 3.1 benchmark harness（`scripts/bench/`）

**形狀：** 獨立的 node scripts，沿用 M2 閘門已證明的形式（`scripts/audit/check-reachability.mjs` 的 `--json` / `--self-test` / `--seed-baseline` / `--gate`，基線 JSON 帶 `seededAt` ＋ `reason` ＋ `digest` ＋ `count` ＋ `rows`）。

- **不要加根層 `vitest.config.ts`** —— `e2e/vitest.config.ts` 的檔頭記錄了實測教訓：根設定會被每個套件的 `vitest run` 撿到，弄壞 `pnpm -r test`。
- `scripts/*.mjs` **不在任何 tsconfig 裡**，所以 M2 的先例買到的是慣例，不是型別檢查。
- **從根目錄不能用裸的 `@i-harness/*` import** —— `node_modules/@i-harness` 不存在。`npx tsx` 可用**相對路徑**載入 workspace TS（已驗證）。
- **迴圈：** 跨案例交錯回合（熱漂移平均打在每個案例上）、每案例取中位數、印 min/med/max、計時前先跑一次暖機。
- **原型在一個真實的 10 倍變異上測到比值 10.1×**（0.0487 → 0.4928 ms/call），而現行 2 ms 的天花板**不會觸發**。完成定義因此是可示範的。

**第一個真實案例必須走公開入口。** 沙箱解析器的 `policyFloor` 是**引擎私有**的（`assembly.ts:337` 的區域變數、`:355` 的閉包），沒有公開 API 能組合「floor ＋ resolve」。三個選項全都要付代價：工具呼叫邊界（一輪要幾十 ms，**看不到 0.05 ms 解析器的 10 倍變化**）、從公開 API 重建（正是 `benchmarks/AGENTS.md:14` 禁止的「複製產品演算法」）、加介面（**已被否決兩次**，`assembly.ts:253-268` 記錄了同一道接縫曾被拒絕）。

**所以沙箱解析器那條明確延後並記下理由。M3 的完成定義不可以被一個「不可能偵測 10 倍」的案例滿足。**

### 3.2 機器指紋

每個基線旁邊記一個 `fingerprint` 物件，**跨指紋不符時拒絕比較**（警告 ＋ 要求明示 `--accept-fingerprint-drift`），永不靜默比較。欄位全部可用 Node 零依賴取得：node 版本、`process.platform`/`arch`、`os.cpus().length`、`cpus()[0].model`/speed、`os.totalmem()`，以及**這個 repo 已經搞錯過的那兩個** —— `bash` 的解析結果、以及 bash→node 橋接是否可用。

### 3.3 結構化診斷日誌（新套件 `@i-harness/diagnostics`）

```ts
export interface DiagnosticRecord {
  ts: number; level: "debug"|"info"|"warn"|"error"; run: string
  phase: DiagnosticPhase; msg: string
  data?: Record<string, unknown>; err?: RedactedError; durMs?: number
}
export function createDiagnostics(opts: {
  stream?: NodeJS.WritableStream; level?: Level; runId: string
  redactor: Redactor            // 必填，沒有預設值
}): Diagnostics                 // {debug,info,warn,error,child(phase),close}
```

`child(phase)` 綁定 phase，呼叫端不必手寫。

**stderr 診斷必須預設關閉 —— 這不是禮貌，是被測試逼的。** `apps/cli/test/bin.test.ts:36,62,69,74,82-83` 斷言 stderr 的**內容與不存在**，`cli.test.ts:168` 斷言 `result.error`。`I_HARNESS_LOG` 未設 → 今天的行為**逐位元組不變**；`=stderr` → stderr 上的 JSONL；`=<path>` → 追加 JSONL。既有的白話訊息保留 —— 人不應該為了知道「沒設模型」而去解析 JSON。

> **行號重測（2026-09-22，W6 的 T7，於 `f307cdb`）：** 上面那串引註裡 **`:69` 已漂成一行 timeout** —— 逐字是 `}, 60_000)`，不是斷言；`:36`／`:62`／`:82` 今天是**測試的宣告行**、真正的 `stderr` 斷言在其後幾行；`:74` 逐字不變。該檔今天的 `stderr` **斷言**全集 ＝ **`:39`、`:46-50`、`:67-68`、`:74`、`:79`、`:87-88`**（**無截斷**；**量法是 `grep -n "expect(r\.stderr)" apps/cli/test/bin.test.ts` ⇒ 12 條**。⚠ 較寬的 `grep -n "stderr"` 會多回傳 `:17`／`:21`／`:23`／`:25` 那四行**管線** —— `runNode` 的簽名、`let stderr = ""`、`child.stderr.on(…)`、`resolve({ … stderr })` —— 那四行不是斷言，不要用那一條當量法。該檔 91 行。）**原句的論點不變** —— 這些斷言確實同時釘著 stderr 的內容與不存在。同句的 `cli.test.ts:168` 重測**仍然正確**（逐字 `expect(result.error).toContain("No model configured")`）。

### 3.4 常駐的那一半：一個 durable 的 `operator/run-end`

**只放在 stderr 的紀錄，正好在需要它的時候消失**（headless 的常態）。所以必須有一筆預設就落地的紀錄：

- `packages/core-session/src/index.ts` 新增成員：`{ type: "operator/run-end"; version: 1; runId; exitCode; durationMs; phase; error?; seq? }`
- **`registerEventType("operator/run-end")`，放在 `session-persistence/src/index.ts:236` 旁邊。**

**這是已知的陷阱，不是細節：** 載入閘門會拒絕未註冊的型別（`:406-417`，`SessionFormatUnsupportedError`），而標成 `ignorable: true` 會讓 `load()` **丟棄**它（`:410-412`），等於把紀錄 erase 掉。先例與理由在 `:216-236`（`rewind/point`）與 `:223-236`（M1 的 `sandbox/mode`）—— **兩個都曾經以「每個 session 都無法載入」的潛伏缺陷出貨過。** 所以測試必須是**載入往返**，不是 append 斷言。

**人實際跑的：**

```
i-harness run "…"                       # exit 1；stderr 白話訊息（+ 開啟時的 JSONL）
i-harness sessions list                 # 哪一次、多久以前
i-harness sessions show <id> --last 5   # ← 失敗那一行：runId、phase、exit code、時長
I_HARNESS_LOG=stderr i-harness run "…"  # 敘事：phase 時間軸 ＋ cause chain
```

第 3 步今天是空的，第 4 步不存在。

> **落地註記（2026-09-22，`m69`，於 `c2824ab`）：** §3.4 已實作收線（`operator/run-end`；T1–T3 ＝ `db996b3`／`fb0349f`／`c2824ab`）。**三處執行期的量測事實，逐條記下它與原稿的關係：**
> 1. **生產者是三個 append 站點，不是一個漏斗。** 實作計畫的原稿寫「既有的 `emitSessionEnd` 漏斗即生產者」，被 `run.ts` 的順序推翻：成功路徑在 `emitSessionEnd(0)` **之前**就 `coordinator.close()`，append 若進漏斗會被已關閉的 coordinator 吃掉。三站各自緊鄰既有的排空 —— `apps/cli/src/run.ts:699`（組裝／掛載前失敗，phase `mount`）、`:788`（成功，`run`；在 `:792` 的 `flush` 之前）、`:838`（run 期間失敗，`run`）。**（2026-09-22 修復 wave 重量：`runId` 的單次 mint 讓這三站各 +5；上面是重量值，原值 `694`／`783`／`833`。）**
> 2. **「失敗那一行」取在 `sessions show`。** 上面 `:211` 許諾的那一行由 `apps/cli/src/sessions.ts:184` 渲染（`sessions list` 另有 `LAST RUN` 欄，`:96` 掃最後一筆）——**但那一行只帶 exit code、時長與（失敗時的）已 redact error**：`:211` 逐字列出的 **`runId` 與 `phase` 不在那一行上**（本單元設計 spec §1.4 的刻意範圍），它們在 durable 紀錄裡、並已可從出貨表面取回 —— `sessions show <id> --json` 把 `session.events` 原樣 dump（`apps/cli/src/sessions.ts:227-230`）⇒ **「第 3 步今天是空的」已不再成立**。原稿沒有預見的是**兩筆紀錄**：durable 寫入失敗時，成功站點（flush 前）與失敗 catch 各寫一筆，讀取端的契約是**最後一筆為準** —— 見本單元設計 spec（`docs/superpowers/specs/2026-09-22-operator-run-end-design.md`）§4 第 5 條。
> 3. **紀錄只存在於 store-backed 的執行。** 協調器只在 `--session-dir` 下接線（`apps/cli/src/index.ts:345-376`），所以**沒有 store 的 `i-harness run` 一律不留紀錄**（成功的執行也一樣）—— 這比本單元設計 spec §4 第 1 條原稿的「在 session 存在之前就死」**更寬**。

### 3.5 redactor

放在 `@i-harness/diagnostics`，**只透過一個閉包住秘密集合的工廠曝露**：

```ts
export function createRedactor(opts?: { extraRules?: readonly Rule[] }): {
  redact: (value: unknown, key?: string) => unknown
  registerSecret(value: string): void
  size(): { rules: number; secrets: number }
}
```

**強制力，由強到弱：**（1）`createDiagnostics({redactor})` **沒有預設值、沒有 `undefined` 重載** —— 一個不 redact 的診斷實例**在 API 上不可建構**，而且沒有 `raw()` 逃生口；（2）`err` 是**衍生**的，不能塞任意 `Error`；（3）洩漏回歸測試是最後一道。

**覆蓋率 —— 三趟獨立掃描**（鍵與值都掃）：鍵名（不分大小寫與分隔符）、憑證**形狀**（`sk-…`、`Bearer \S+`、PEM block、URL userinfo、只在看起來像秘密的鍵下的長 base64）、**已註冊的值**（精確子字串，≥8 字元）。

**已註冊的值從哪來（誠實的部分）：** 形狀規則抓不到自訂閘道的 token（`Bearer corp-abc123`），所以 CLI 必須餵真實的值 —— 一次 **env 掃描**（`/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i` 且值 ≥8 字元；這是有依據的，因為憑證的讀取優先序是 env > file），加上對 settings 已指名的每個 `apiKeyEnv` 呼叫 `store.resolve(ref)`。

**實測到的障礙：** CLI 沒有曝露那個 store（`provider-runtime.ts:24-26` 在內部建構它，非 web 的呼叫者只解構 `runtime`）。修在 `apps/cli`，**永遠不要修在 `credentials`**。

> **行號重測（2026-09-22，W6 的 T7，於 `f307cdb`）：** 引註指的是 `apps/cli/src/provider-runtime.ts`（不是 `packages/provider-runtime`），而 **`:24-26` 今天是「一個空行 ＋ `roleModelOptionsFor` 說明註解的開頭」**（`:24` 是空行，註解從 **`:25`** 起），不是 store 的建構。**原句的前提也不再成立：** 該檔（70 行）**一直**把 store 回傳出去 —— 回傳型別在 **`:50`**（`credentials: CredentialStore`）、回傳的物件在 **`:63`**（`credentials,`）、**建構**在 `:58`（`createCredentialStore`）—— 而 W6 動的是**保留那個 handle 的呼叫端**：`apps/cli/src/index.ts:577`／`:833`、`apps/cli/src/run.ts:408`。**量法：** `git log --oneline ec18c9d0^..HEAD -- apps/cli/src/provider-runtime.ts` **為空**（W6 一個字沒動它；`:50` 在 W6 的起點 `e78bad3` 逐字相同），所以這裡是**引註漂移**而不是本單元造成的改變。`packages/credentials` 與 `packages/provider-runtime` 零改動，如原句所要求。

**殘餘，說出來而不是藏起來：** v1 **不能**承諾「沒有秘密離開行程」。它承諾「沒有被**名稱比對到、形狀比對到、或註冊過**的秘密離開」。`size()` 與覆蓋率測試讓已註冊集合**可稽核**，而不是被斷言。

### 3.6 崩潰處理與優雅關閉

**fail-loud 長什麼樣：** stderr 上一塊有標籤的區塊（`[i-harness] FATAL <kind>`、session id、phase、未 flush 的數量、被吞掉的數量、shutdown 是優雅還是強制、紀錄路徑、**stack**）；一個**同步寫入**的崩潰紀錄（`openSync`/`writeSync`/`closeSync`，先例 `output-retention/src/index.ts:181`），**下一次開啟該 session 的執行會回報它找到的紀錄** —— 這是唯一也能在 SIGKILL 之後存活的痕跡；exit code：崩潰 **1**、SIGINT **130**、SIGTERM **143**（凍結 TUI 已在用的碼）。用 `process.exitCode` ＋ 排空迴圈，**永不裸呼 `process.exit()`**。

**吞掉仍然允許；說不出自己吞了幾個不行。** 50 個 `.catch(() => {})` ＋ 2 個裸 `catch {}` 在非凍結原始碼裡 —— 計數器掛在 `reportBackgroundFailure` 的 **sink** 上，不是靠列舉呼叫點（列舉出來的數字會說謊）。

**優雅關閉必須排空什麼。** *已經排空的（不要重做）：* mcp/lsp/team mounts、skills+workflow、terminal PTY、win32 ACL、rewind 的 turn/end 鏈、**所有 session write-behind**（`coordinator.close()`）、`docChain`、ownership lease。*今天沒有任何東西排空的：*

1. **per-session write-behind 批次**（200 ms 視窗）—— **實測 5 入列 / 0 落地**。頭號項目。
2. **exec 背景工作**（`bash-N` 子行程）—— `ExecService` **完全沒有 dispose/kill-all**。
3. **進行中的 subagent 工作** —— `registerSubagent` 回傳的**沒有 `unmount`**。
4. **`RewindRecorder` 的 take()-time 佇列** —— 死在 turn 中間會損失復原設計所假設的 pre-image blob。
5. **stdout/stderr 的寫入** —— 沒有東西等 drain。
6. **telemetry 沒有東西可 flush。** `close()` 是字面上的 no-op。**一個「flush telemetry」的關機設計，是在 flush 一個 no-op —— 要說出來，不要照做。**

**安裝範圍：不要在全域裝。** 裸啟動的預設**就是**凍結的 TUI（它自己裝 handler），`web` 也是凍結的（`web.ts:595`）—— 第二個 handler 會把 web 乾淨的 `resolve()` 變成競態。**只裝在 `run` 路徑與 `runSdkCommand`/`runAcpCommand` 裡。** 也不要為了它的 `SignalEmitter` 去 import `@i-harness/tui-core`（凍結、預定刪除；那個模式重寫一遍約 20 行）。

### 3.7 metrics registry

`packages/telemetry/src/metrics.ts`，零依賴。**規則：每一個鍵在 M3 裡都必須同時有生產者與讀者，否則不進去**（鏡射 manifest 自己的「never a code without a producer」）。讀者是唯一一個 `formatExitReport()`，在優雅路徑與崩潰路徑各呼叫一次。沒有任何東西輪詢它。

**它不可以聲稱能回答「結束時還有幾個背景 shell 工作活著」** —— `ExecService` 在 assembly 裡、沒有曝露。回報 **unknown**，不要編造一個 0。

---

## 4. 取樣與自創

| 部分 | 來源 |
|---|---|
| benchmark harness | **自創** —— 七源只有 dsh 有 harness，且形式不同；IH 的形狀沿用自家 M2 閘門 |
| 結構化診斷日誌 | **取樣**（dsh 的 telemetry 分層）＋ 自創（`operator/run-end` 的 durable 記錄） |
| metrics registry | **自創**，且刻意比路線圖暗示的小 |
| 崩潰處理 | **取樣**（`tui-core/src/signal/index.ts` 的 SignalGate 設計 —— 但那是我方凍結層的死碼，不是外部源） |
| redaction | **取樣**（形狀規則的通用做法）＋ **自創**（三趟掃描 ＋ 註冊值 ＋ 覆蓋率證明） |

---

## 5. 刻意**不**做

- **OTLP 匯出** —— §5 Q5：先本地，等有 collector 再說。
- **不取消進行中的工作。** exit report 要**具名**列出還在跑的 subagent 任務與背景工作（用既有的唯讀 `assembly.tasks()`），但**不取消**它們：`SessionAssembly` 被凍結的 `packages/tui` 依賴，而取消是 M4 的（它擁有 lease/generation）。**做在這裡會動到分級。**
- **不修 `exitCode: -1` 的八種意義** —— allowlist 已經把它標價為 M。
- **不修 `repairTurnTail` 的誤記**（2.4）—— 需要新的 event 詞彙，是 M4 的。**但它必須進 M4 的 spec。**
- **任何 OTLP 形狀的結構。**
- **redaction 不放在 session `append` 前面** —— 那會破壞 append-only 的審計紀錄（`core-session/src/index.ts:315-337`，且被 `tui/test/harness/host-026.ts:18` 刻意證明）。**redaction 只屬於診斷路徑。**

---

## 6. 介面影響

**全部 internal-only**，前提是 3.6 的第 2–4 項是**被回報**而不是被取消：

| 部分 | 影響 |
|---|---|
| `@i-harness/diagnostics`（新） | internal-only（`private: true`，零依賴） |
| `apps/cli` 的 diagnostics 接線、`I_HARNESS_LOG` | internal-only |
| `operator/run-end` 成員 | 加法式；**不是**已發布的 wire（那是 `sdk/src/protocol.ts`，`PROTOCOL_VERSION = 2`），但它是別的套件會 import 的引擎型別 |
| `registerEventType(...)` | internal-only，一行，以載入往返測試 |
| `packages/telemetry/src/metrics.ts`（新） | internal-only |
| redactor | internal-only |
| `telemetry` / `tui` / `tui-core` / `web` / `web-host` / `apps/cli/src/web.ts` | **零改動** |

**引擎只碰兩行。**

---

## 7. 完成定義與如何證明

路線圖的兩條，加上本文件因 L 分級而加的一條：

1. **harness 能偵測一個 10 倍退化。** *不是斷言，是示範：*（a）`--self-test` 裡一個刻意慢 10 倍的合成案例必須回報 FAIL；（b）在真實案例上做那個已知良好的 10 倍變異，harness 必須報出來。原型已在（a）上達到比值 10.1×。
2. **一次失敗的執行不需要人手讀 JSONL 就能定位。** *紅色先：* 今天 `sessions show <id>` 在失敗的執行之後是空的；實作後它必須印出失敗行。
3. **（L 分級新增）崩潰不會變成無聲的成功。** *最高價值的變異測試：* **把致命 exit 從 1 翻成 0，必須讓測試變紅。** 一個 exit 0 的 handler 會把崩潰轉成靜默的成功。

**每個部分都必須能被變異紅回去。** 研究中已經點出會「在缺陷下仍然通過」的形狀，並且**原型在探測時撞到它兩次：一個什麼都沒讀的偵測器會真空地通過。** 所以：

- 指紋比對 → 要變異**基線**的指紋，不是當下的（單邊比對會免費通過）；
- `--gate` → 要變異**量到的值** 10 倍，不是門檻；
- 案例註冊表 → 刪掉一個案例並斷言執行**回報了數量**（一個跑零個案例的 harness 是綠的）；
- seeding → 斷言基線**自己的** digest 被檢查，否則手改的基線會通過；
- redaction 覆蓋率 → 把 N 個已知明文餵進 ~10 KB 對抗性 payload（**用 `notes`、`payload`、`args` 這種看不出是秘密的鍵名**），然後在**輸出裡搜** —— 三趟各一個變異。**它不斷言「有呼叫 redact」**，那種斷言在 no-op 下也會過。

**這幾件事測不了，說出來而不是提議一個測試形狀的安慰：**（a）**真實送達的 SIGINT** —— 探針在這台主機上無法送出一個可捕捉的信號（`child.kill("SIGINT")` 殺掉了子行程但沒走它的優雅路徑）。決策邏輯用注入的 emitter 覆蓋，真實信號那條腿記為**POSIX 上手動驗證過、Windows 上未驗證**。（b）**SIGKILL 中途 flush** —— 結構上不可能；唯一可斷言的是**下一次**執行的回報。（c）**孤兒背景子行程** —— 探針被環境污染（這台主機會殺掉整個子孫樹），所以一個斷言「工作隨 harness 而死」的測試**會因為錯的理由通過**，那正是本專案在移除的類別。

**一條來自本 repo 自己教訓的紀律**（`FINAL-REPORT.md` §6：門檻是天花板，不是偵測器 —— 一個 10 倍退化通過了 2 ms 的上限）：**不要**把關機期限斷言成 `elapsed < N`；斷言**可觀測的**（紀錄寫了、store 持久了、exit code 對了），讓期限只是報告裡的一個值。

---

## 8. 這份設計沒有回答的問題

- **真實 SIGINT 的執行期行為** —— 這台主機上送不出可捕捉的信號，所以現有 sdk/acp handler 的實際行為未驗證。
- **背景 `bash-N` 子行程是否在崩潰後存活** —— 從程式碼看，repo 裡沒有任何東西殺它們，所以在任何不殺子孫樹的主機上它們會變成孤兒；但探針被環境污染，**未證實**。
- **每筆紀錄的開銷** —— 未量測，而且必須由 M3 自己的 harness 量（這正是 M3 是一個里程碑的原因）。
- **`operator/run-end` 該是 run 級還是 turn 級** —— 提案是 run 級（完成定義講的是「一次執行」），未定。
- **`packages/fs-watch` 是否刻意為死碼**，以及**閘門為何不報它** —— 這是一個 M2 覆蓋率問題，不是 M3 的。
- **`repairTurnTail` 的誤記要怎麼修**（2.4）—— 它需要新的 event 詞彙與 M4 的裁決語意；本文件只負責把它記下來，並且**不讓它被遺忘**。
