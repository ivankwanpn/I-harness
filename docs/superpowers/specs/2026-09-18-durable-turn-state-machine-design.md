# M4 耐久 turn 狀態機設計 — 2026-09-18

> **基準**：`m65` @ `24d6051`。**路線圖**：`docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md` §3.M4。
> **量測來源**：本 session 對 `core-agent`、`session-persistence` 的實讀，全部標明行號。
> **範圍**：讓「行程在工具呼叫中途被殺」這件事，從**推論**變成**記錄**。
> **不是**：opencode-fork 那個 kernel 的移植（§6）。

---

## 0. 這份文件是什麼、不是什麼

**是**一份 **L 級**改動的 spec。它動到 `core-agent`、`core-session`、`session-persistence`、
`session-persistence-jsonl`、`session-executor` —— 都是別人依賴的介面。

**不是**「加一個事件」這麼小。**先把不變式與「它不保證什麼」寫清楚，再談實作** —— 這是路線圖
§1.3 對每個里程碑的要求，而 M4 是全份路線圖裡唯一一個**「崩潰會產生錯誤答案」**的主題。

---

## 1. 量測：今天有兩個裁決，兩個都是**推論**

### 1.1 日誌記錄了「要求」，沒有記錄「派送」

```ts
// packages/core-agent/src/index.ts:261 — 模型發出呼叫的當下
append(deps.session, { type: "tool/call", callId, name: ev.call.name, args: ev.call.args })
// M13: collect the call; execution happens AFTER the stream ends so the step's
// tool calls can run concurrently (bounded pool).
batch.push({ callId, name: ev.call.name, args: ev.call.args, eventSeq })
```

**`tool/call` 寫在模型發出的那一刻，工具本體在串流結束後才跑。** 而 `tool/result` 寫在完成時。

**所以一個沒有 `tool/result` 的 `tool/call`，意思是「模型要求了，而我們不知道本體跑過沒有」。**
四種實情**全部**符合，而日誌**分不出來**：

| 實情 | 日誌能分辨 |
|---|---|
| 從未被派送 | ❌ |
| **派送了、完成了**（結果只是還沒寫進去 —— write-behind 有 200ms 的窗） | ❌ |
| 派送了、失敗了 | ❌ |
| **派送了、還在跑**（有副作用的那種：`rm`、`git push`） | ❌ |

### 1.2 而 `repair.ts` **選了其中一個來斷言**

```
// packages/session-persistence/src/repair.ts:52-54
// - Every `tool/call` in the LAST turn without a matching `tool/result`
//   receives a synthetic aborted result (M10a TOOL_ABORTED_BEFORE_DISPATCH
//   vocabulary), in call order.
```

**`TOOL_ABORTED_BEFORE_DISPATCH` 是一個不可能被知道的答案，被寫成了事實。**

**後果是具體的**：模型讀到「派送前就中止了」，**可能重跑它**。如果它其實跑過，
副作用**翻倍** —— 一次 `git push`、一次 `rm`、一次對外 API 的 POST。

**這不是「少一個功能」，這是崩潰產生錯誤答案。**

### 1.3 另一個裁決也是推論

```ts
// packages/subagent/src/persist.ts:107-115
// Agent table: restore entries; running → error (process gone after resume, ...)
const wasRunning = entry.status === "running"
const status: ChildStatus = wasRunning ? "error" : entry.status
... error: wasRunning ? "interrupted by resume" : entry.error
```

**「行程沒了，所以它一定是被打斷」** —— 這是推論。它可能**已經完成**，回報只是沒寫進去。

### 1.4 沒有任何耐久裁決

grep 過 `packages/session-persistence/src` 與 `packages/core-session/src`：**沒有 per-turn 或
per-tool 的 attempt record**（出現的 "attempt" 全是在講鎖的重試）。

---

## 2. 不變式

> **I1 — 派送邊界是耐久的。** 工具本體開始執行**之前**，那個事實必須已經在日誌裡。
> 復原**讀**它，不**猜**它。

> **I2 — 裁決會被寫回去。** 復原做出的判斷**本身**是一個事件。第二次復原**讀到它**，
> 而不是重新推導一次 —— 所以兩次復原不可能給出不同的答案。
>
> **【量測後更正：這一條在 2026-09-18 之前就已經成立了。】**
> `loadOwned` 已經有 `needsRewrite` ＋ `backend.replaceEvents`：它把修好的 tail **耐久寫回**，
> 而既有的測試（`loadOwned durably canonicalizes crash recovery before continuation`）
> 已經用「換一個 coordinator 再載」證明了它。
>
> **所以 M4 對 I2 的義務不是「建寫回」，是「證明新的判決也被寫回」。**
> `491dd10` 之後補了那條測試（`...canonicalizes an OUTCOME-UNKNOWN verdict too`），
> 而它**第一次就綠** —— 那不是「測試沒用」，是**這一條本來就成立**。
> 它的牙齒由突變證明：拿掉 `replaceEvents` → `expected '…' to contain 'TOOL_OUTCOME_UNKNOWN'`。
>
> **寫在這裡，因為一份把「既有能力」記成「待辦」的 spec，會讓下一個人去建一個已經存在的東西。**

> **I3 — 不確定就是「不確定」。** 一個派人了的工具如果沒有結果，它的裁決是
> **`outcome-unknown`**，不是任何一種「它沒跑」。**永不自動重跑。**

**I3 是這一節的重點。** 今天的三種「我不知道」被壓成兩種確定的答案（「派送前中止」、
「被 resume 打斷」），而**兩個答案都指向 benign 的方向** —— 也就是錯得最危險的方向。

---

## 3. 設計

### 3.1 一個事件，不是一個新儲存

派送邊界寫進**既有的 session 事件流**，不是新增一個並行的儲存 —— 理由是這個 repo 已經
在 `session-persistence` 裡有 write-behind 與其損失契約，**第二個真相來源正是 §5 反覆拒絕的東西**。

```
turn/start
  tool/call        { callId, name, args }          ← 模型要求（既有）
  tool/dispatch    { callId, eventSeq }            ← 新增：本體即將執行（I1）
  tool/result      { callId, name, output }        ← 完成（既有）
```

`eventSeq` 已經在 `index.ts:260` 被捕捉（M26 R-D1），所以指回那一次呼叫是免費的。

### 3.2 復原讀它，然後**寫回裁決**

```
一個 tool/call
  ├─ 有 tool/result        → 已完成（既有行為）
  ├─ 有 tool/dispatch      → 【outcome-unknown】(I3) —— 永不重跑，升級為 needs-recovery
  └─ 兩者皆無              → 【not-dispatched】—— 唯一可以安全重跑的種類
```

**而這個裁決本身寫成一個事件**（I2），所以第二次復原**讀**它。

### 3.3 `repair.ts` 的 `TOOL_ABORTED_BEFORE_DISPATCH` 要跟著改

現有的合成 payload 在新詞彙下是**錯的兩次**：名字宣稱了一件事，而它的觸發條件（無 result）
**同時涵蓋「派送了、下落不明」**。

**處置**：合成的結果改成兩個詞彙之一，取決於**有沒有 `tool/dispatch`** —— 也就是
**同一個判準，只是現在它是被記錄的**。

### 3.4 既有 log 的相容性

一份**沒有** `tool/dispatch` 的舊日誌（今天寫的每一份）在復原時會全部落進 `not-dispatched`。
**那正是今天的行為**，所以是相容的 —— 但它**是一個選擇，不是一個遺漏**：舊日誌沒有記錄派送，
所以「不知道」是它唯一誠實的讀數。**要不要對舊日誌保守（一律 `outcome-unknown`）是一個產品決定**（§5 Q8）。

---

## 4. Red-first 測試

| 測試 | 先紅於 |
|---|---|
| 一個有 `tool/dispatch` 沒有 `tool/result` 的 tail → 裁決是 **`outcome-unknown`**，且**不重跑** | 今天會說 `TOOL_ABORTED_BEFORE_DISPATCH` |
| 一個沒有 `tool/dispatch` 的 `tool/call` → 裁決是 **`not-dispatched`** | `tool/dispatch` 不存在 |
| 復原寫回裁決事件；**第二次**復原讀它而不是重新推導 | 沒有裁決事件 |
| 兩次復原對同一份日誌給出**相同**裁決（冪等） | 同上 |

**驗收就是路線圖的完成定義**：**在工具呼叫中途殺掉行程**，斷言續行的 session 到達一個
**已記錄且正確**的裁決。**那個測試要 spawn 一個真的行程並在派送與結果之間殺掉它** ——
不是單元測試，是路線圖明文要求的形狀（「不是靠讀程式碼」）。

**Mutation proof**：讓復原把「有 dispatch 無 result」判成 `not-dispatched` → 第一條必須轉紅。

---

## 5. 它不保證什麼（路線圖原文＋我加的）

- **不保證續行 turn 的內容是對的** —— 只保證裁決是「記錄下來的」而不是「推論出來的」。（路線圖原文）
- **不保證 `outcome-unknown` 的工具可以被自動解決。** 它會被升級成一個**人**要處理的狀態，
  而那個狀態在今天的介面上**沒有地方顯示** —— 那是前端的事，不是 M4 的。
- **不保證 `tool/dispatch` 一定寫得進去。** 它走同一個 write-behind，所以在它自己的 200ms 窗裡
  被殺，就等於它沒被寫。**這是損失契約的必然結果**，不是缺陷：日誌只保證它寫下的事。
- **不動 opencode-fork 那個 kernel 的任何結構**（§6）。

---

## 6. 為什麼不是移植 opencode-fork 的 kernel

本 session 讀過它（`D:\agent-complete\opencode-fork-private-999.0.15`，14 檔 / 4,612 行）。
它的核心是 **lease + generation + 跨行程擁有權**，解的是**多行程 / 崩潰一致性**。

**我們是單行程。** 引進 lease 只會多出一整套狀態機去守一個我們沒有的問題。

**要拿的只有它的一個想法**：**裁決必須從耐久證據讀出來，而不是從「行程還在不在」推出來。**
那就是 §3.2，而它用既有的事件流就做到了。

---

## 7. 這份設計沒有解決的

- **§5 Q8**（舊日誌要不要保守）—— 產品決定。
- **`outcome-unknown` 的使用者介面** —— 前端。
- **跨行程的擁有權** —— 見 §6，我們沒有那個問題。
- **`subagent/src/persist.ts` 的 `running → error`**（§1.3）**是否同一批改**。它是同一個形狀，
  但它是**子代理**的狀態，不是 turn 的。**這一節先不動它，並記錄它在這裡**，因為
  「同一個形狀、不同一批」正是這個 repo 把債留成孤兒的方式。
