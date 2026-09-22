# M70 — dispatch 邊界必須在工具本體之前耐久（Q8 的落地）：**完成**

**Written:** 2026-09-22，SDD 執行 session，分支 `m70`（自 `origin/main` ＝ `b48c2896` 開，快進到 `docs/decisions-2026-09-22` ＝ `5407aa94` 之上，也就是四題產品答案那一筆之後）。
**Audience:** 日後要查這件事究竟證明了什麼的人；最近的讀者是隨後進來的 scoped 複審與 owner 的合併決定。
**State measured at:** `6841d207`（本單元的最後一個提交）。**行號會腐，引用前先重量**（本 repo 既有紀律）。自重：

```bash
git log --oneline -8 m70 && git status -sb
```

---

## 0. 先看五件事

| Fact | Value |
|---|---|
| 分支 | `m70`，六個提交完成、任務複審與 scoped 複審都已跑；**未 push**（controller 推）、**未合併 `main`**（owner 決定） |
| 計畫 | **沒有計畫文件** —— 有界改動，設計在對話中核准（`brief.md` 在 ledger 目錄） |
| 設計的家 | `docs/superpowers/specs/2026-09-18-durable-turn-state-machine-design.md`（Q8 的所在；2026-09-22 的落地註在其 §3.4／§5／§7） |
| ledger | `.superpowers/sdd/2026-09-22-m70-dispatch-boundary/`（**gitignored**；本檔自足，不依賴它。`progress.md` 的 R15–R17、`report.md` 的實作與修正輪報告、`probe-output.txt`、`verify-all-fix1.txt`、`sha-implemented.txt` 是它的證據 artifact） |
| 複審 | 任務複審 **0 Critical／1 Important**（＋5 Minor／3 ⚠️）—— 那條 Important 是**本單元自己的缺陷類**：值測式漏掉「沒有 reason 的拒絕」，turn 會對著已證實寫不進去的 store 續跑。修正輪後 scoped 複審：**全部處理完，無新 Critical／Important**（新增一條 Minor，見 §5） |

## 1. 完成了什麼（每個提交證明了什麼）

| Commit | 證明了什麼 |
|---|---|
| `5259ce3d` feat(agent) | `execute-tool-calls.ts` 的 checkpoint：`tool/dispatch` append 之後、`tools.dispatch` 之前，**await 宿主排空**（`execute-tool-calls.ts:249-305`）；**fail-closed** —— 排空失敗 ⇒ 本體不跑、該呼叫的裁決是既有的 `TOOL_ABORTED_BEFORE_DISPATCH`、store 錯誤往外丟 ⇒ turn 失敗（`hasFlushError`／`firstFlushError`：:152、:296-299、:618）。縫是**選配**的（缺席＝pre-M70 位元）。**紅先**（3 條新案例）：`expected [ 'body' ] to deeply equal [ 'flush', 'body' ]`／`promise resolved "undefined" instead of rejecting` |
| `4029b015` feat(executor) | 縫在組裝點接上（`packages/session-executor/src/assembly.ts:1263-1265`：`(coordinator, sessionId)` 這一對，就是收到標記的那個 write-behind）⇒ **CLI 主線真的過 checkpoint**。突變 D（拆掉縫）⇒ CLI 的 `session_search` 測試紅 |
| `1c1a17e1` feat(subagent) | **兩個**子代理站點接同一條縫（`child.ts:313-314` 新子代理；`tools.ts:661-663` resume 的子代理），且**先量後接**。新案例的觀察點是**本體跑之前已被排空的那一批**（不是「有沒有 flush」——那會因為 `turn/end` 也 flush 而假綠）；突變 C ⇒ 紅 |
| `b641b732` test(cli) | **一個既有測試改強**：`apps/cli/test/cli.test.ts` 的 `session_search` 原本 `hits.length === 1` —— 那是在**斷言 200 ms 損失窗**（搜尋是耐久讀者，而這次 run 自己的 `tool/call` 還沒落盤）。改成精確集合（`main:tool/call` ＋ `main:user/message`），嚴格強於計數；因果兩向量測（DIAG：`tool/call` seq 6；拆縫 ⇒ 退回 1 筆） |
| `728fe4a5` fix(agent) | **修正輪的本體**：`firstFlushError ??=` ＋ `!== undefined` 的值測式，對「拒絕**而沒有 reason**」的 flush 讀成「沒有失敗」⇒ turn 續跑。改成旗標對（`hasFlushError`）＋一條新案例（`throw undefined`；斷言用 `.then(…, …)`，因為 `rejects.toThrow()` 需要 reason） |
| `6841d207` docs | 兩個 comment 改準（行為零改變）：assembly 的縫在呼叫者自帶 `opts.session` 時可能是**對空佇列 resolve** 的語意；`child.test.ts` 的 fake 記的是**被 enqueue**、不是被排空 |

**讀數（各自在自己的提交上量）**：`core-agent` focused 36/36（套件 96 passed）· `subagent` 158 · `session-executor` 136 · CLI **291 passed｜1 skipped** · typecheck exit 0（所有觸到的套件）。
**分支 tip 的最終閘門（`6841d207`）**：`pnpm verify:all` → **`VERIFY:ALL PASSED`** —— suite exit 0 · **2904 passed｜9 skipped｜0 failed** · 母體 **67／67** · typecheck exit 0 · e2e exit 0／5 檔 · gate exit 0 · **434 列**（`PASS -- no new rows`）。
（在修正輪之前、四個提交的樹上是 **2903**，差的 1 正是新案例。）**注意**：**頭三個提交**時閘門**第一次跑是紅的（1 條）**，而那**不是**負載 flake —— 隔離重現，因果探針證明是 M70 的前綴排空，由第四個提交 `b641b732` 修掉；第二次完整跑才是上面那個讀數。

## 2. 量到的代價（**不是預測**）

探針對**真的** `createSessionCoordinator`（真的 jsonl 後端）跑一批 **10 個並行**呼叫：

| 組態 | 後端寫入 | 事件 | 牆鐘 |
|---|---|---|---|
| **有 checkpoint（本單元）** | **10** | 17 | **62 ms** |
| 無（pre-M70） | 批次中 **0**；顯式 flush 後 1 | 23 | 16 ms |

**⇒ 成本＝每個起跑的呼叫一筆耐久寫入。** 而 controller 在核准時給 owner 的預測（「一批 10 個並行呼叫只付一次排空，因為 `flush()` 是 in-flight barrier」）**在這個路徑上量到為假**：`runGroup` 對每個 `startCall` 是**循序 await** 的，前一個 flush 解析後才發下一個，**沒有可合流的 barrier**。barrier 本身是真的 —— 對照組 **5 個事件 ＋ 5 個並行 flush ＝ 1 筆寫入**（一次帶走全部 5 個）—— **它只是從這條呼叫路徑碰不到**。**沒有發明去重或佇列**（brief 明文禁止）；出貨的成本就是那些以前被 hold 在 200 ms 窗裡、等截止才落盤的寫入 —— 同一個探針也顯示 pre-M70 批次在**本體跑完時一筆都還沒寫**。

**使用者可見的附帶後果**：checkpoint 排空的是**前綴**，不只標記 ⇒ 一個耐久讀者（另一個行程的 `session_search`、`--resume`、rewind）會在本體**還在跑**的時候就看到這個 turn 的 `tool/call`。方向是本單元要的（CLI 那個測試的改動就是它的證據），但它比「標記」本身寬。

## 3. 我做的裁定（逐條附「若錯的代價」）

| # | 裁定 | 若錯的代價 |
|---|---|---|
| R15 | **Q8 的意圖以「讓標記不可遺失」實作，不以「重讀缺席」實作。** owner 答「保守」（舊日誌不得讀成 benign）；量測顯示缺席之所以有歧義，是因為**標記會丟**（200 ms 窗、無 flush），所以把標記做成不可遺失（checkpoint、fail-closed）。**字面的「全 log 無標記 ⇒ unknown」park 成觸發項** —— 理由是**新的**日誌可以合法地整份沒有標記（一個 session 的唯一呼叫在 `prepare` 就被拒，例如被拒的批准），今天讀成 `not-dispatched` **是對的**，全 log 規則會把它標成錯的；**我們讀過的**參考實作沒有一個把缺席讀成 unknown（耐久檢查點的做法本身取自 dsh 的 `session-checkpoint-policy`，見 `packages/core-agent/src/execute-tool-calls.ts:255`；opencode-fork 的 kernel 見 design spec §6）。 | 觸發項生效前，若真的復原到一份 pre-M4 日誌，它 pending 的呼叫仍讀成 benign；觸發項就是**接住它的東西**，而 checkpoint 把等價的洞對**有縫的宿主**此後寫下的日誌關掉 |
| R16 | **controller 的合流預測被實作方的量測推翻，照實記錄、不掩蓋**（見 §2）。 | 核准是照「一批一次排空」的概念給的，實際是**每呼叫一次**；絕對值小（整批 62 ms），但 owner 若要重讀那個核准，重讀的是這個數字。替代設計（批次層 checkpoint：先 append 全部標記再一次排空）是設計變更，刻意出界 |
| R17 | **被拒的 checkpoint 讓 turn 失敗**（呼叫的裁決照樣寫下、store 錯誤再往外丟）—— 這是本檔自己的規則（M5 T4 R5：「失去的耐久寫入不得變成靜默續行的 turn」），而 `run.ts` 的失敗站點本來就列了「a durable flush that rejected」（`apps/cli/src/run.ts:835`）。 | 一次「以前會繼續、現在會失敗」的 run；失敗是響的，且落在既有的 exit-1 耐久路徑上 |

## 4. 紅先與突變（每一條都先改壞、跑、再還原，sha 驗證）

- **紅先**（實作前）：新 describe 3 條 —— 順序／fail-closed 兩條由紅到綠；第三條（無縫等價）的「位元相同」那一半**按構造**本來就是綠的（它把 pre-M70 行為釘成字面），只有「這條縫真的被用到」那一行是紅的 —— **照實記，不裝成三條全紅**。
- **突變**：A（`await opts.flush()` → `Promise.resolve()`）· B（`.catch(() => {})` 吞掉）· C（subagent 的縫移除）· D（assembly 的縫移除），各自指名的案例轉紅、還原後 sha 相符。修正輪把 **A／B 在出貨版重跑**，並用**E ＝ 把修正前的值測式整段放回**證明複審的宣稱到端：批次**解析**（`expected 'resolved' to be 'rejected'`）—— 也就是「turn 真的續跑」；原本三條案例對它全盲，因為它們的拒絕值是 `Error` 物件。
- 證據 artifact（ledger 內）：`probe-output.txt`（真實後端；寫入次數跨次穩定，事件總數會因 commit lane 交錯而動幾個單位）· `verify-all-fix1.txt` · `sha-implemented.txt`（**blob** 修訂標籤；舊的 `4dec5765…` 是把 CRLF 工作區當 blob 的誤標）· `red-focused.txt`。

## 5. 殘餘、觸發項與 parked

1. **已命名的殘餘（量到）**：復原後**載入失敗**的子代理 entry 留著 `createSessionFromEmpty()` 的替身（`packages/subagent/src/persist.ts:124`），而鏡像只在 `childSessions` 存在且載入成功時才換上去 —— 該替身**沒有 append 鉤子**，所以 append 一個 `tool/dispatch` 到不了任何 write-behind，`flush(entry.sessionId)` 造成 **0** 筆後端寫入（探針 C）。接縫在該處是 no-op；**誠實**（M70 前後都沒有東西鏡像那些 append），且那個 entry 已以 `error` 現形。**不修** —— 那是 resume 路徑的耐久修復，不是本單元。
2. **觸發項（parked，不是丟掉）**：Q8 的字面重讀（全 log 無標記 ⇒ `outcome-unknown`）—— **第一次真的復原到 pre-M4 日誌時做**。母體**已封閉**（不可能再產生新的 pre-boundary 日誌）、**這台機器上是空的**（2026-09-22 實測：`~/.i-harness/sessions` 不存在；`~/.i-harness` 下 0 個 `.jsonl`）。
3. **parked 的 Minor（明說，不動）**：abort／refusal 的支配巧合會蓋掉 store 錯誤的**訊息**（turn 兩種都失敗，沒有靜默續行）；沒有「批次中途 flush 被拒 ＋ 兄弟取消」的案例；複審新增的一條 —— 先到先贏現在也套在**值**上，所以一個沒有 reason 的拒絕會遮住後到的 `Error` 訊息（turn 仍失敗；`run.ts` 以 `instanceof Error` 防守）。
4. **有量到、但沒有套件測試釘住**：`tools.ts` 的 resume 子代理站點（`tools.ts:661-663`）—— 探針 C 量過，但**沒有 package 測試釘它**；指名以免被當成覆蓋。順帶：62 條 `spill GC failed: ENOENT` 的收尾警告**在改動前後同數**，不是本單元的。

## 6. 已知的閘門陷阱（別踩）

- **`pnpm verify:all` 才是閘門**；`pnpm -r --no-bail test` 單獨跑不算（母體先數）。
- 本 suite 有**已量測的負載 flake**（W6 的記錄）。可疑失敗**先隔離跑該套件**，兩個讀數都記；本單元那條紅**不是** flake（隔離重現 ＋ 因果探針）。
- `.superpowers/` 是 gitignored 的 scratch：**ledger、brief、報告、review 包都不在 git 裡**；換機要手動複製整個 `2026-09-22-m70-dispatch-boundary/`。
- **沒有 push、沒有合併** —— push 由 controller 做，合併時機由 owner 決定。

---

**這份記錄的性質**：本單元是 M4「只差 Q8」的收尾，而它把 Q8 落地成**「讓標記不可遺失」而不是「重讀缺席」**（§3 R15）—— 因此它的判準要連著 `docs/superpowers/specs/2026-09-18-durable-turn-state-machine-design.md` 的 2026-09-22 註一起讀，那份文件才是 Q8 的家。
