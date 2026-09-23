# M77 — 拒絕要有通道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 今天模型拒絕與成功無法分辨：五家轉接器把 `content_filter`／`SAFETY`／`RECITATION`／`refusal`／`guardrail_intervened` 一律變成裸 `end` ⇒ `core-agent` 把空的 assistant 訊息寫進日誌、turn 正常結束、CLI 靜默、exit 0。本階段給它一條通道：seam 的 `end` 加一個**語意**位元 `refused?: true`（與 `truncated` 對稱），五家在**自己的** wire 上認字面，三個消費者與 `truncated` 逐點對稱；anthropic 的 `model_context_window_exceeded` 走**既有**的 `CONTEXT_WINDOW_EXCEEDED` 錯誤碼。

**Architecture:** 複製 `truncated` 的形狀（5 生產者 → 1 位元 → 3 讀者 → 1 耐久欄位 → 1 telemetry → CLI stderr），**不新增聯集成員**（`core-agent` 的 defaultless `switch` 會靜默丟掉它；重試包會**轉發但不判斷**它——`createRetryingClient` 的尾端 `yield ev` 是 catch-all），**不把 wire 詞彙帶進 seam**（M72 Ⅱ 的約束）。**引 `llm-seam` 用符號名不用行號**（那個檔案的行號在本階段兩次位移）。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-24-refusal-channel-design.md`（權威；§1 設計、§2 驗收）

## Global Constraints

- **紅先測試 ＋ 變異證明**：每一條修法都要先看到紅；實作後**把修法拿掉一次**、確認**具名的那條**測試變紅、再用 Edit 工具還原（**絕不**用 `git checkout --`），並以 `sha256sum` 確認位元組還原。
  - **突變是預測**：哪一行字面編輯能達到那個效果，**由你量測決定並記錄**——M72–M76 裡計畫的字面預測錯了十幾次，M75 有五個**字面值本身**是任何實作都過不了的。找不到能讓它紅的突變 ⇒ **那是發現，回報它**。
- **既有測試預期只改一條，而且要具名**：`packages/llm-openai/test/openai.test.ts:489-497` 的 `expect(events.at(-1)).toEqual({ type: "end" })` **刻意斷言的就是這次要改的契約**（拒絕＝空成功）⇒ 改成 `{ type: "end", refused: true }`，並在該處註解說明它為何改。**其他任何既有斷言都不得改**（四家「其他原因是乾淨結束」的斷言仍然為真，因為 `STOP`／`end_turn`／`stop` 不寫 `refused`）。若有其他紅，**回報它**。
- **缺席即缺席**：`refused` 只在該字面出現時被寫，**永遠不寫 `false`**；沒有拒絕時既有行為**逐位元組不變**。
- **不新增 export**（收尾閘門會看）。
- **提交訊息不加任何 attribution trailer**；**不 amend**；blobs LF；檔案用 Write/Edit 工具寫。
- **每個任務只跑自己套件的測試與 typecheck**；`pnpm verify:all` **整支分支只跑一次**（收尾任務）。
- **不要動 `docs/`**（紀錄由控制器寫）。

---

### Task 1: seam 的位元與 mock（`@i-harness/llm-seam`）

**Files:**
- Modify: `packages/llm-seam/src/index.ts`（`LLMStreamEvent` 的 `end` 成員）
- Modify: `packages/llm-mock/src/index.ts`（欄位；`MockStep` 與其 yield）
- Test: 這兩個套件既有的測試檔（`packages/llm-seam/test/`、`packages/llm-mock/test/` 裡對應的檔）

**Interfaces:**
- Produces: `{ type: "end"; truncated?: true; refused?: true }`——欄位是**可選的語意位元**，與 `truncated` 並列；`MockStep` 多一個對應欄位讓測試釘得住。

- [ ] **Step 1: 寫紅測試**

在 `llm-mock` 的測試裡：一個帶 `refused` 的 step ⇒ 事件流的最後一個是 `{ type: "end", refused: true }`；一個**不帶**的 step ⇒ `{ type: "end" }`（`not.toHaveProperty("refused")`，與既有 `truncated` 對照的形狀相同——**找該檔既有的 `truncated` 對照抄它的形狀**）。

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/llm-mock test`
Expected: 紅在型別／欄位不存在（量出來是哪一個，並記錄）。

- [ ] **Step 3: 實作**

`llm-seam`：`end` 成員加 `refused?: true`。**寫清楚它是語意的、不是 wire 詞彙**（五家的字面留在五家，M72 Ⅱ 的約束），並寫**為什麼不是新聯集成員**（兩個 defaultless 的消費者：`core-agent` 的 `switch`、重試包的 `if/else if`）。`llm-mock`：`MockStep` 加欄位並在 yield `end` 時帶上（**缺席即缺席**）。

- [ ] **Step 4: 跑它，看到綠**

Run: 兩個套件的 test ＋ typecheck。兩個套件的既有案例全綠（`truncated` 的斷言是範本，不得改）。

- [ ] **Step 5: 變異證明**

拿掉 mock 的 yield 欄位 ⇒ 新測試紅。記錄實際編輯與 `sha256sum`。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-seam/src/index.ts packages/llm-mock/src/index.ts packages/llm-seam/test packages/llm-mock/test
git commit -m "feat(llm-seam): a refusal gets a semantic bit on `end`, beside `truncated` (M77)"
```

---

### Task 2: 五家的生產者（**同一形狀的批次，一次派工**）

**Files:**（每個檔案都是「認自己的字面 ⇒ 設位元」）
- Modify: `packages/llm-openai/src/index.ts`
- Modify: `packages/llm-openai-compatible/src/index.ts`
- Modify: `packages/llm-gemini/src/index.ts`
- Modify: `packages/llm-anthropic/src/index.ts`
- Modify: `packages/llm-bedrock/src/index.ts`
- Test: 五個套件各自的測試檔

**Interfaces:**
- Consumes: Task 1 的 `refused?: true`
- Produces: 五家各自認得自己的拒絕字面 ⇒ `end` 帶 `refused === true`；**anthropic 的 `model_context_window_exceeded` ⇒ 帶 `CONTEXT_WINDOW_EXCEEDED` 碼的 `error` 事件**（不是 `refused`）

| 檔案 | 認的字面（**先量再寫，別照抄計畫**） |
|---|---|
| `llm-openai` | `response.incomplete` 且 `incomplete_details.reason === "content_filter"` |
| `llm-openai-compatible` | `finish_reason === "content_filter"` |
| `llm-gemini` | `finishReason` 為 `"SAFETY"`／`"RECITATION"`，**以及** `promptFeedback.blockReason` 存在（被擋在輸入側時 `candidates` 可能整個缺席——今天連 `candidates?.[0]` 都讀不到） |
| `llm-anthropic` | `stop_reason === "refusal"` ⇒ `refused`；`stop_reason === "model_context_window_exceeded"` ⇒ **error 事件** |
| `llm-bedrock` | `messageStop.stopReason === "guardrail_intervened"` |

- [ ] **Step 1: 寫紅測試（每家兩條：拒絕、與既有對照仍綠）**

每家用**該家既有的 fixture 形狀**造一個拒絕 case，斷言 `end` 帶 `refused === true`。**既有對照不動**（那四家「`STOP`／`end_turn`／`stop` 是乾淨結束」的斷言就是對照，它們必須繼續綠——若它們紅了，說明你把 `refused` 寫進了一般路徑，**那是發現**）。

**`content_filter` 的既有斷言要改**（本階段唯一被改的既有斷言）：`packages/llm-openai/test/openai.test.ts:489-497` 的 `toEqual({ type: "end" })` ⇒ `{ type: "end", refused: true }`，並在該處註解寫明**為什麼它改**（它刻意斷言的正是本階段要改的契約）。**先量它在改之前是紅的**（fixture 不變、斷言改成新形狀 ⇒ 紅）。

- [ ] **Step 2: 跑它，看到紅**

Run: 五個套件各自的 test。Expected: 每個新 case 紅在「`refused` 不在事件上」。

- [ ] **Step 3: 實作**

每家照它**現有**的 `truncated` 變數模式（宣告 → 在認出字面處設 → 在 yield `end` 時帶上）。**`refused` 與 `truncated` 各自獨立**（不假設互斥）。anthropic 的那一臂**不設 `refused`**：它發一個 **`error` 事件**，其 `error.code === "CONTEXT_WINDOW_EXCEEDED"`（用 `retryErrorCode()` 讀的那個欄位；**不新增第二套詞彙**）。

- [ ] **Step 4: 跑它，看到綠**

Run: 五個套件的 test ＋ typecheck。**既有斷言只有那一條被改。**

- [ ] **Step 5: 變異證明（三條）**

(a) 拿掉 openai 的 `content_filter` 分支 ⇒ 它那條紅；(b) 拿掉 gemini 的 `promptFeedback` 分支 ⇒ `candidates` 缺席的那條紅；(c) 把 anthropic 的 context 臂改成設 `refused`（而不是 error）⇒ 它那條紅。記錄實際編輯與 `sha256sum`。

- [ ] **Step 6: Commit**

```bash
git add packages/llm-openai packages/llm-openai-compatible packages/llm-gemini packages/llm-anthropic packages/llm-bedrock
git commit -m "feat(providers): five wires recognise their own refusal literal, and anthropic's context cap takes the existing error code (M77)"
```

---

### Task 3: 消費者與 schema（**同一形狀的批次**）

**Files:**
- Modify: `packages/core-agent/src/index.ts`（`refusedThisStep` ＋ telemetry ＋ 耐久的 `step/end`）
- Modify: `packages/core-session/src/index.ts:25`（`step/end` 的欄位）
- Modify: `packages/telemetry/src/types.ts:23`（事件型別聯集）＋ `packages/telemetry/src/manifest.ts:36`（對應列）
- Modify: `apps/cli/src/run.ts`（讀 `step/end.refused` ⇒ stderr `[refused]` ＋ `result.refused`）
- Modify: `packages/compaction/src/summarizer.ts:272`、`packages/session-title/src/index.ts:84`（訊息只在**看到拒絕**時改準）
- Test: 各自的測試檔

**Interfaces:**
- Consumes: Task 1 的欄位、Task 2 的生產者
- Produces: 三個消費者與 `truncated` 逐點對稱的行為

- [ ] **Step 1: 寫紅測試**

用**既有的 `truncated` 測試當範本**逐點照抄形狀：`packages/core-agent/test/agent.test.ts:515-534`（telemetry 一則 ＋ 耐久欄位）與 `:536-551`（乾淨時兩者都不出現）；`apps/cli/test/metrics-summary.test.ts:116-129`（stderr ＋ `result`）與 `:141-188`（端到端）；`packages/telemetry/test/manifest.test.ts` 的一致性斷言會替你檢查 manifest（**跑它就會紅**，若你改了型別卻沒加 manifest 列——那正是它的用途）。

- [ ] **Step 2: 跑它，看到紅**

Run: 相關套件各自的 test。

- [ ] **Step 3: 實作**

`core-agent`：`refusedThisStep`（與 `truncatedThisStep` 同形狀）→ `provider/refused` telemetry → 寫進 `step/end`。**空 assistant 訊息仍然照寫**（否則日誌上「模型沒說話」與「被擋」仍然不可分——語意在欄位上，不在文字上），並在該處註解說明這個選擇。CLI：與 `[truncated]` 逐點對稱。兩個內部訊息：只在看到 `refused` 時改準（**沒有 `refused` 時逐位元組不變**）。

- [ ] **Step 4: 跑它，看到綠**

Run: 上述每個套件的 test ＋ typecheck。

- [ ] **Step 5: 變異證明（兩條）**

(a) 拿掉 `core-agent` 的 telemetry 發射 ⇒ 它那條紅；(b) 拿掉 CLI 的 stderr 行 ⇒ 它那條紅。記錄實際編輯與 `sha256sum`。

- [ ] **Step 6: Commit**

```bash
git add packages/core-agent packages/core-session/src/index.ts packages/telemetry apps/cli/src/run.ts packages/compaction/src/summarizer.ts packages/session-title
git commit -m "feat(core-agent,cli): a refusal is visible in the log, the telemetry and the terminal instead of an empty turn (M77)"
```

---

### Task 4: 收尾（閘門＋報告）

- [ ] **Step 1: `pnpm verify:all`**

Expected: 五步全綠（母體 67）。**`--gate` 不得新增 row**（**不新增 export**；若新的 telemetry 型別產生了一列，**回報而不要加 allowlist**）。
- **若 suite 紅在已量測的負載 flake**（`apps/cli` 的 M12 retry、`session-executor` 的 `shell-promotion W10`、`apps/cli` 的 headless W10）：隔離跑、**兩個讀數都記**。**跑閘門時不要同時跑 subagent。**

- [ ] **Step 2: 報告**（寫給控制器，不進 git）

每個任務各自的：紅先證據、GREEN、**每一條變異證明與其 sha 驗證**（含你實際用的那一行編輯）、被改動的既有斷言（**預期恰好一條，具名**）、以及**你量到的字面**（五家各自的 wire 字面，以及它們與計畫表格的差異——**差異是發現，不是錯誤**）。

---

## 驗收（照 spec §2）

1. 五家的拒絕字面各自被認出 ⇒ `refused === true`——Task 2。
2. `content_filter` 的既有斷言被改且具名——Task 2 Step 1。
3. gemini 的 `promptFeedback.blockReason`（`candidates` 缺席）也被認出——Task 2。
4. anthropic 的 context 超限 ⇒ 帶 `CONTEXT_WINDOW_EXCEEDED` 碼的 error 事件，且 `retryErrorCode()` 讀得出來——Task 2。
5. `core-agent`：telemetry ＋ 耐久欄位 ＋ 乾淨時都不出現——Task 3。
6. CLI：`[refused]` ＋ `result.refused`，乾淨時都沒有——Task 3。
7. **缺席即缺席**：四家「其他原因是乾淨結束」的既有斷言全綠——Task 2 Step 4。
8. `pnpm verify:all` 五步全綠、`--gate` 無新增 row——Task 4。

## 殘餘（本階段**不做**，寫出來不是忘了）

- **`EMPTY_RESPONSE` 沒有生產者**（`llm-seam:47`、`:93`）。
- **拒絕之後的行為是產品決定**（重試／換模型／回報使用者）。
- **`model_context_window_exceeded` 只到「出現」**：預算階梯沒有消費它。
- **不分辨拒絕的種類**（seam 只有一個位元；要分辨得再分一層語意類別，不是搬 wire 字面）。
- **沒有真 provider 的請求被跑過**（fixture 是 wire 文件形狀）。
