# 排程的投遞 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一個到期的排程，在**有 turn 在跑的時候**變成一筆 durable 的輸入，最後成為使用者與模型都看得到的訊息 —— 引擎（deliver 接縫、in-flight 守衛、批次）、三個工具、與 assembly 的掛載，全部照已核准的 spec。

**Architecture:** **引擎不寫日誌。** `deliver` 把 dispatch 事件、framed 文字、inputId 交給宿主；宿主用 canonical `append()` ＋ `inbox.admit()` ＋ `await coordinator.flush()` 讓 `[dispatch, admitted]` 落在**同一個 durable batch**（spec §3.4 的更正讀法，見 §0.1）。tick 掛在 `agent/pre-step` —— **沒有 timer**，閒置就沒有 step、沒有 step 就沒有 tick（I5 結構性成立，不是行為約定）。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-20-schedule-design.md`（629 行，owner 2026-09-20 核准；**2026-09-21 行號重測完成** —— 4 處漂移已就地更正，`d330dc91`）。前置：`docs/handoff/2026-09-20-queued-work.md` §9.2 A1（重測已完成，只差計畫）。

---

## 0. 接手前該知道的四件事

### 0.1 §3.4 的更正讀法（開工前量的；Task 1 會把它寫回 spec）

**spec §3.4 指名的 primitive 是 `coordinator.append(sessionId, [dispatchEvent, admittedEvent])`。量到的：那條路只寫磁碟。**

| 量到的事實 | 出處（2026-09-21，`d330dc91`） |
|---|---|
| `coordinator.append` 只做 `withSessionOperation → ensureOwnership → backend.append` —— **不碰記憶體、不通知訂閱者** | `packages/session-persistence/src/index.ts:470-475` |
| `append(session, ev)` 才是 canonical 路徑：`seq = events.length`、跑 append hook（write-behind 鏡像的來源）、通知 session 訂閱者（SDK 的 `session/event` 串流靠它） | `packages/core-session/src/index.ts:323-343` |
| `flush()` 是 quiescence barrier：**resolves only after backend durability**；一個 batch 一次 `backend.append`（jsonl：一個 `write` ＋ 一個 `sync`，失敗回退到 `committedBytes`） | `packages/session-persistence/src/write-behind.ts:55-64,104-119`；`packages/session-persistence-jsonl/src/index.ts:73-90` |

**⇒ 實作（Task 1）：`append(session, dispatch)` → `inbox.admit(…)`（同一條 `append()` 路徑）→ `await coordinator.flush(sessionId)`。** 這給出 spec §3.4 要求的三個性質：①兩筆在**同一個** backend append 裡（失敗 ⇒ 兩筆都不在）；②acceptance 在 `deliver` 回傳前已 durable；③記憶體、鏡像、訂閱者三者一致（照 spec 字面上的 `coordinator.append` 實作會**三者全斷**：fold 看不到 dispatch ⇒ 下一 tick 重複投遞；`pending()` 看不到 admission ⇒ 提醒永遠不升格；SDK 串流看不到兩筆）。

**殘餘視窗（一併記錄，不是這一塊修得掉的）**：例外失敗路徑是 both-or-neither（回退）；**torn write**（機器斷電級的寫入撕裂）下，repair 截到最後一條**完整行** —— 理論上可以留下 dispatch 而丟掉 admitted。那是 jsonl 模型裡**每一組相鄰事件對**共有的曝光（例：`promote` ＋ 它的 `user/message` 今天就有），不是排程特有；Task 6 **量它並把量到的結果**寫進同一則更正。

### 0.2 接縫的形狀是**計畫**決定的（spec §7.3 明說留給計畫）

```
deliver(delivery: ScheduleDelivery) → void | Promise<void>   // REQUIRED
ScheduleDelivery = { sessionId, dispatchEvents: SessionEvent[], text, inputId, due: ScheduleDue[] }
```

- **引擎擁有**：dispatch 事件的形狀、framed 文字（注入防護在引擎）、`inputId`（per-occurrence；批次用 `schedule-batch@<acceptedAt>`）、occurrence 算術。
- **宿主擁有**：admitted 事件的構造（用它自己的 `Inbox`，折疊契約只有一份）＋ 一次 atomic durable 寫入 ＋ 「送不送」（`deliver` 拋出 = 不接受）。
- `append` 與 `onDue` **退場**：舊的「引擎自己 append 再通知」是這次要消滅的形狀（§3.4）。

### 0.3 `ctx.on` 的 handler **必須回 `undefined`**（量到的 emit 語意）

`emit()` 對每個 plain listener：`const resolved = isPromiseLike(res) ? await res : res`，而**若同一事件有 waterfall handler 且 `resolved !== undefined`，它會覆蓋 waterfall 的 chain payload**（`packages/core-plugin/src/index.ts` 的 `emitFn`）。`hooks` 在 `agent/pre-step` 上**有** waterfall handler（`hooks/src/index.ts:411`）。所以掛載寫成：

```ts
ctx.on("agent/pre-step", async () => { await driver.tick() })   // block body ⇒ Promise<undefined> ✓
```

**不可以**寫成 `ctx.on("agent/pre-step", () => driver.tick())` —— 它回傳 `TickResult`（非 undefined）⇒ 汙染 hooks 的 chain。

### 0.4 本計畫對 spec §10 的一處順序更動（有理由的）

spec §10 的 ①a（守衛）在 ①b（接縫）之前。**量到的事實讓它反過來**：舊形狀是 `append` 在 `onDue` **之前**（`driver.ts:99-100`），所以「兩個 tick 同時看到 overdue」的窗口在舊形狀下幾乎是關的 —— **守衛的紅測試在舊形狀下不紅（空洞）**。守衛的窗口在**宿主擁有 append**（= 接縫落地）之後才打開。⇒ **先接縫（Task 1）、再守衛（Task 2）**，守衛的測試才有指名的紅線。

---

## Global Constraints

- **`renderReminderFraming` 逐字不動**（spec §3.3）；`packages/schedule/test/schedule.test.ts:134` 的轉義測試一字不改。
- **提醒的 `user/message` 不得帶 `internal`**（spec §3.2.1 的阻斷性檢查）—— Task 5 有指名的斷言。
- **一次投遞 ≤ 1 則訊息**（批次界）；**不加**數量上限、**不加**視野上限、**不加**開關預設值（spec §6.3.4：有依據的寫出來，沒有依據的留空 —— **誰在空格上填一個看起來合理的數字，就是把它反過來做**）。
- **schema 方言只有 10 個關鍵字**（`additionalProperties / description / enum / items / maximum / maxItems / minimum / properties / required / type` —— `packages/core-tools/src/json-schema.ts` 的 `SUPPORTED_KEYWORDS`，assert 在 `register` 跑）。**沒有 `oneOf`** ⇒ `schedule_create` 的三選一在 **handler** 驗。
- **`packages/schedule/src/index.ts` 保持純函式、零 I/O**；新增的 `tools.ts` 是這個套件第一次拿 `@i-harness/core-tools` 依賴（新 dep，走 subpath export `./tools`，照 `./driver` 的體例）。
- **新 export 要有生產消費者**（reachability gate）。**中途 gate 會出現 `N NEW rows` 是預期的**（Task 4 的 tools 消費者在 Task 5；block ①／② 的先例）；**最終 `pnpm verify:all` 必須零紅、`--gate` 必須 PASS**。
- **改任何檔案之前先 `grep -n`**（行號會腐）；不要 amend；提交訊息**不加任何 attribution trailer**。
- **不靜默**：引擎與宿主的每一個失敗路徑進 `deliveryErrors` 或拋出，不吞。

---

## File Structure

| 檔案 | 角色 | 任務 |
|---|---|---|
| `packages/schedule/src/driver.ts` | deliver 接縫（T1）；in-flight 守衛（T2）；批次整合（T3） | T1–T3 |
| `packages/schedule/src/index.ts` | `scheduleOccurrenceInputId`（T1）· `decideDue` ＋ `scheduleBatchInputId` ＋ `renderEveryReminderBatchFraming`（T3） | T1, T3 |
| `packages/schedule/src/tools.ts` | **新檔**：`createScheduleTools`（三個工具） | T4 |
| `packages/schedule/package.json` | `./tools` export ＋ `@i-harness/core-tools` dep | T4 |
| `packages/schedule/test/driver.test.ts` | 新形狀（T1）＋ 守衛（T2）＋ 批次（T3） | T1–T3 |
| `packages/schedule/test/tools.test.ts` | **新檔** | T4 |
| `packages/session-executor/src/assembly.ts` | 掛載：工具註冊 ＋ driver ＋ `ctx.on("agent/pre-step")` | T5 |
| `packages/session-executor/package.json` | `@i-harness/schedule` dep | T5 |
| `packages/session-executor/test/schedule-delivery.test.ts` | **新檔**：端到端（閒置／turn／fork／批次／耐久） | T5, T6 |
| `packages/subagent/src/projection.ts` | 註解修準（第 15-17 行的句子在新世界裡不再為真） | T5 |
| `packages/session-persistence-jsonl/test/jsonl.test.ts` | 兩事件批次的 torn-tail —— **量測並釘住量到的** | T6 |
| `apps/cli/test/sessions.test.ts` | `renderTranscript` 的提醒案例（使用者面） | T6 |
| `docs/superpowers/specs/2026-09-20-schedule-design.md` | §3.4 更正（T1）· §1 引用更新（T5）· 檔頭狀態（T6） | T1, T5, T6 |
| `docs/handoff/2026-09-20-queued-work.md` | §9.2 A1 → ✅（T6） | T6 |

---

### Task 1: 引擎 — `deliver` 接縫（`append`/`onDue` 退場）＋ inputId ＋ spec §3.4 更正

**Files:**
- Modify: `packages/schedule/src/driver.ts`
- Modify: `packages/schedule/src/index.ts`（`scheduleOccurrenceInputId`）
- Modify: `packages/schedule/test/driver.test.ts`（五條既有測試換形狀）
- Modify: `docs/superpowers/specs/2026-09-20-schedule-design.md`（§3.4 加更正註記）

**Interfaces:**
- Produces（Task 5 的宿主照這個實作）：
  - `ScheduleDelivery { sessionId: string; dispatchEvents: SessionEvent[]; text: string; inputId: string; due: ScheduleDue[] }`
  - `ScheduleDriverOptions.deliver: (delivery: ScheduleDelivery) => void | Promise<void>`（**required**；`append` 與 `onDue` 刪除）
  - `scheduleOccurrenceInputId(record: ScheduleRecord, occurrenceAt: string): string` —— `` `${record.id}@${occurrenceAt}` ``（per-**occurrence**，見 §3.5；per-record 的 id 會被 `Inbox.pending()` 當成永遠 consumed）
- Consumes: 既有 `foldScheduleEvents` / `resolveEveryOccurrence` / `scheduleView` / `renderReminderFraming`（全在 `./index.ts`）

- [ ] **Step 1: 改測試到新形狀（先紅）**

`packages/schedule/test/driver.test.ts` 的 fixture 換成：

```ts
function driverOver(
  sessions: Record<string, FixtureSession>,
  deliveries: ScheduleDelivery[],
  now = NOW,
): ReturnType<typeof createScheduleDriver> {
  return createScheduleDriver({
    sessions: () => Object.keys(sessions),
    events: (id) => sessions[id]?.events,
    deliver: async (delivery) => {
      deliveries.push(delivery)
      // The HOST's side of the contract: dispatch + admitted in ONE durable batch. This fixture
      // stands in with a synchronous append of the dispatch events — the real atomicity is the
      // host's own test (packages/session-executor/test/schedule-delivery.test.ts).
      for (const ev of delivery.dispatchEvents) sessions[delivery.sessionId]!.events.push(ev)
    },
    now: () => now,
    pollMs: 60_000,
  })
}
```

五條既有測試逐條改：
1. **one-shot exactly once** —— `deliveries.length === 1`；`deliveries[0].inputId === "schedule-1@2026-08-31T10:00:01.000Z"`；`deliveries[0].text` 含 `[SCHEDULE REMINDER]`；`deliveries[0].dispatchEvents[0]` 是 `operation: "dispatch"`；re-tick ⇒ `deliveries.length` 仍 1。
2. **restart re-drive** —— 形狀不變（fixture 換掉即可）。
3. **every occurrence-aligned** —— `deliveries[0].due[0].occurrenceAt === "2026-08-31T10:20:00.000Z"`；dispatch 事件的 `acceptedAt === "2026-08-31T10:25:00.000Z"`；`inputId === "schedule-1@2026-08-31T10:20:00.000Z"`。
4. **deliver failure suppresses the delivery** —— `deliver: async () => { throw new Error("disk full") }` ⇒ `delivered === 0`、`deliveryErrors === ["sess-1: disk full"]`、`deliveries` 空（舊的 `append: throw` 案例整條搬過來）。
5. **unknown session skipped** —— `deliver` 傳一個「絕不可被呼叫」的 spy。

**加一條新的（§3.5 的指名紅線）**：

```ts
  it("a second occurrence of the same every record delivers again — the inputId is per OCCURRENCE, not per record", async () => {
    const deliveries: ScheduleDelivery[] = []
    const sessions = { "sess-e": everySession("sess-e", 600) }
    const driver = driverOver(sessions, deliveries, NOW + 25 * 60_000)
    await driver.tick()
    await driverOver(sessions, deliveries, NOW + 35 * 60_000).tick()
    expect(deliveries).toHaveLength(2)
    expect(deliveries[0]!.inputId).not.toBe(deliveries[1]!.inputId)   // record-keyed ⇒ 兩者相同 ⇒ 紅
    expect(deliveries.map((d) => d.due[0]!.occurrenceAt)).toEqual([
      "2026-08-31T10:20:00.000Z",
      "2026-08-31T10:30:00.000Z",
    ])
  })
```

- [ ] **Step 2: 跑，確認紅**

```bash
pnpm --filter @i-harness/schedule test
```
Expected: 全紅（`deliver` 不存在、`append`/`onDue` 參數型別不符）。

- [ ] **Step 3: 實作**

`packages/schedule/src/index.ts` 加（放在 `scheduleView` 之後）：

```ts
/**
 * Durable idempotency key for ONE accepted occurrence (spec §3.5): the record id plus the accepted
 * occurrence instant. Per-OCCURRENCE, never per record — `Inbox.pending()` treats any promoted or
 * cancelled id as consumed forever (core-session/src/inbox.ts), so a record-keyed id would eat the
 * record's own second occurrence, silently.
 */
export function scheduleOccurrenceInputId(record: ScheduleRecord, occurrenceAt: string): string {
  return `${record.id}@${occurrenceAt}`
}
```

`packages/schedule/src/driver.ts` 改：
- 檔頭註解改準（引擎不再 append；durable accept 的責任在宿主，見 §3.4 的更正）。
- `ScheduleDriverOptions`：**刪 `append`、改 `onDue` 為 `deliver`（required）**，型別照 **Interfaces** 段。
- tick 的內圈：先算 occurrence，再組 `ScheduleDelivery`，再 `await opts.deliver(delivery)`；成功把 `delivery.due` 推進 `result.due`、`result.delivered += delivery.due.length`；拋出 ⇒ `deliveryErrors.push(`${sessionId}: ${reason}`)` + `logWarn`（沿用既有文案形狀）。
- **every 的單筆文字要說實話**：`renderReminderFraming` 的 `occurrence_at` 讀的是 `record.scheduledAt`（落後的 target），所以對 every 傳 `{ ...record, scheduledAt: occurrenceAt }`（Task 3 會把 every 整條改走批次 framing，這裡是接縫先落地的單筆形狀）。

`docs/superpowers/specs/2026-09-20-schedule-design.md` §3.4 的決定段後面加：

```
> **⚠ 更正（2026-09-21，實作前量到的）：** 本節指名的 `coordinator.append(sessionId, [...])` 只寫磁碟
> （`session-persistence/src/index.ts:470-475`）—— 它不更新 `session.events`、不通知訂閱者。照字面實作會
> 讓 fold 看不到 dispatch（重複投遞）、`pending()` 看不到 admission（永不升格）、SDK 串流看不到兩筆。
> **實作改為**：`append(session, dispatch)` ＋ `inbox.admit(...)`（canonical `append()`，
> `core-session/src/index.ts:323-343`）**＋ `await coordinator.flush(sessionId)`**（quiescence barrier，
> resolves only after backend durability，`session-persistence/src/write-behind.ts:55-64`）—— 兩筆仍落在
> **同一個 backend append**（失敗 ⇒ 兩筆都不在），而記憶體／鏡像／訂閱者三者一致。
> **殘餘視窗**：例外路徑 both-or-neither；torn write 由 repair 截到最後一條完整行，理論上可留下 dispatch
> 而丟掉 admitted —— 那是 jsonl 中每一組相鄰事件對共有的曝光（promote ＋ user/message 同型），不是排程特有。
```

- [ ] **Step 4: 跑，確認綠**

```bash
pnpm --filter @i-harness/schedule test && pnpm --filter @i-harness/schedule typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/schedule/src/driver.ts packages/schedule/src/index.ts packages/schedule/test/driver.test.ts docs/superpowers/specs/2026-09-20-schedule-design.md
git commit -m "feat(schedule): the deliver seam — the engine hands the host [dispatch, text, inputId], the host owns the atomic write"
```

---

### Task 2: 引擎 — tick 的 in-flight 守衛

**Files:**
- Modify: `packages/schedule/src/driver.ts`
- Test: `packages/schedule/test/driver.test.ts`

**Interfaces:**
- Produces: 同一條 `tick()` 契約 + 「重疊的 tick 回空結果（skipped, not queued）」；`start()` 的第一次 tick 走同一條守衛。
- Consumes: Task 1 的 `deliver`。

- [ ] **Step 1: 寫紅測試**

```ts
  it("one tick in flight: a tick arriving while the host's delivery is still resolving is SKIPPED (one delivery, not two)", async () => {
    const deliveries: ScheduleDelivery[] = []
    const sessions = { "sess-e": everySession("sess-e", 600) }
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const driver = createScheduleDriver({
      sessions: () => Object.keys(sessions),
      events: (id) => sessions[id]?.events,
      deliver: async (delivery) => {
        deliveries.push(delivery)
        await held
        for (const ev of delivery.dispatchEvents) sessions["sess-e"]!.events.push(ev)
      },
      now: () => NOW + 25 * 60_000,
      pollMs: 60_000,
    })
    const first = driver.tick()
    await new Promise((resolve) => setTimeout(resolve, 0)) // the first tick reached deliver
    const second = await driver.tick()                     // overlaps: it would re-fold the UN-advanced record
    expect(second.delivered).toBe(0)
    expect(second.due).toEqual([])
    release()
    const finished = await first
    expect(finished.delivered).toBe(1)
    expect(deliveries).toHaveLength(1)
  })
```

**為什麼這是紅線**：宿主擁有 append ⇒ 第一個 tick 的 dispatch 在 `deliver` 裡面才落地；沒有守衛時，第二個 tick 重新 fold（記錄還沒被推進）⇒ 第二次投遞。**突變**：拿掉守衛 ⇒ `deliveries` 長度 2 ⇒ 紅。（舊形狀下這條不紅 —— 那就是 §0.4 換順序的理由。）

- [ ] **Step 2: 跑，確認紅**

```bash
pnpm --filter @i-harness/schedule test
```

- [ ] **Step 3: 實作**

```ts
  let ticking = false  // one tick in flight (W1's shape, settings/src/index.ts:1437): a tick that
                       // arrives while one is running is SKIPPED, not queued — the next tick re-reads
                       // the fold, and a skipped tick can never miss a state that has settled. Without
                       // this guard two overlapping ticks can both fold BEFORE either host delivery
                       // lands, and each would deliver the same occurrence.
  async function tick(): Promise<ScheduleTickResult> {
    if (ticking) return { delivered: 0, due: [], deliveryErrors: [] }
    ticking = true
    try {
      // …既有 tick 主體…
    } finally {
      ticking = false
    }
  }
```

- [ ] **Step 4: 跑，確認綠**

```bash
pnpm --filter @i-harness/schedule test
```

- [ ] **Step 5: Commit**

```bash
git add packages/schedule/src/driver.ts packages/schedule/test/driver.test.ts
git commit -m "feat(schedule): one tick in flight — a skipped tick re-reads, and two overlapping ticks can no longer double-deliver"
```

---

### Task 3: 引擎 — 批次（`decideDue` ＋ 批次 framing）

**Files:**
- Modify: `packages/schedule/src/index.ts`（`decideDue`、`scheduleBatchInputId`、`renderEveryReminderBatchFraming`）
- Modify: `packages/schedule/src/driver.ts`（內圈換成一個決定 → 一次投遞）
- Modify: `packages/schedule/test/driver.test.ts`；Test: `packages/schedule/test/schedule.test.ts`（`decideDue` 的單元測試）

**Interfaces:**
- Produces:
  - `ScheduleDecision = { kind: "none" } | { kind: "one-shot"; record: AfterScheduleRecord | AtScheduleRecord; occurrenceAt: string } | { kind: "every"; acceptedAt: string; reminders: readonly { record: EveryScheduleRecord; occurrenceAt: string }[] } | { kind: "wait"; target?: string }`
  - `decideDue(active: readonly ScheduleRecord[], now: number): ScheduleDecision` —— dsh `dueDecision` 的移植：**恰好一個決定**；一次性優先（同 target 以 create 序決勝）；否則一批**所有** overdue 的 every；否則 `wait`（`target` ＝ 最早的未來 `scheduledAt`）。
  - `scheduleBatchInputId(acceptedAt: string): string` —— `` `schedule-batch@${acceptedAt}` ``
  - `renderEveryReminderBatchFraming(reminders): string` —— **dsh 逐字移植**（`[SCHEDULE REMINDER BATCH]` ＋ 一句 untrusted 指示 ＋ `reminders_json: JSON.stringify([{schedule_id, occurrence_at, reminder_prompt}])`）；JSON.stringify 就是轉義層。
- Consumes: `resolveEveryOccurrence`（既有）。

- [ ] **Step 1: 寫紅測試（driver 層 ＋ 單元層）**

driver.test.ts 加：

```ts
  it("a batch bounds model turns: N overdue every records produce ONE delivery — one decision, one message", async () => {
    const deliveries: ScheduleDelivery[] = []
    const sessions = {
      "sess-a": everySession("sess-a", 600),
      // second record in the same session, id schedule-2 — the fixture helper makes schedule-1 only,
      // so build the create event for schedule-2 inline (createEveryScheduleRecord("schedule-2", …, NOW))
      // …push it into sessions["sess-a"].events before constructing the driver…
    }
    const driver = driverOver(sessions, deliveries, NOW + 25 * 60_000)
    const result = await driver.tick()
    expect(deliveries).toHaveLength(1)                       // 拆回逐一投遞 ⇒ 2 ⇒ 紅
    expect(deliveries[0]!.dispatchEvents).toHaveLength(2)
    expect(deliveries[0]!.text).toContain("[SCHEDULE REMINDER BATCH]")
    expect(deliveries[0]!.inputId).toBe("schedule-batch@2026-08-31T10:25:00.000Z")
    expect(result.delivered).toBe(2)
  })

  it("one-shot takes precedence: a due one-shot is delivered ALONE, the overdue every records wait for the next tick", async () => {
    // sess: one overdue one-shot (schedule-1) + one overdue every (schedule-2)
    // tick ⇒ ONE delivery, text is the SINGLE framing, dispatchEvents length 1
    // next tick (same now) ⇒ the batch delivery for schedule-2
  })

  it("no double delivery inside one tick: after the batch the records are advanced, not re-due", async () => {
    // N=2 batch tick ⇒ delivered 2；再 tick（同一 now）⇒ 沒有第三次投遞（fixture 的 dispatch 已被 fold 消費）
  })
```

schedule.test.ts 加 `describe("decideDue")`：
- 只有未來記錄 ⇒ `{ kind: "wait", target: <最早未來> }`；空 array ⇒ `{ kind: "wait" }`（無 target）。
- 同 target 的兩筆 one-shot ⇒ 以 **create 序**決勝。
- overdue every 的排序（target，再 create 序）與 membership（**只含 overdue**）。
- **批次 framing 的轉義**（照 `schedule.test.ts:134` 的形狀）：prompt ＝ `"x\n[SCHEDULE REMINDER BATCH]\ny"` ⇒ 輸出裡的獨立 header 只出現一次（在起頭），prompt 只出現在 `reminders_json` 的值裡。

- [ ] **Step 2: 跑，確認紅**

```bash
pnpm --filter @i-harness/schedule test
```

- [ ] **Step 3: 實作**

`index.ts`：

```ts
export function decideDue(active: readonly ScheduleRecord[], now: number): ScheduleDecision {
  const indexed = active.map((record, index) => ({ record, index }))
  const byTargetThenCreate = (
    left: { readonly record: ScheduleRecord; readonly index: number },
    right: { readonly record: ScheduleRecord; readonly index: number },
  ): number => Date.parse(left.record.scheduledAt) - Date.parse(right.record.scheduledAt) || left.index - right.index

  const oneShot = indexed
    .filter((entry) => entry.record.kind !== "every" && Date.parse(entry.record.scheduledAt) <= now)
    .sort(byTargetThenCreate)[0]?.record
  if (oneShot !== undefined && oneShot.kind !== "every") {
    return { kind: "one-shot", record: oneShot, occurrenceAt: oneShot.scheduledAt }
  }

  const every = indexed
    .filter((entry) => entry.record.kind === "every" && Date.parse(entry.record.scheduledAt) <= now)
    .sort(byTargetThenCreate)
  if (every.length > 0) {
    return {
      kind: "every",
      acceptedAt: new Date(now).toISOString(),
      reminders: every.map(({ record }) => ({
        record: record as EveryScheduleRecord,
        occurrenceAt: resolveEveryOccurrence(record as EveryScheduleRecord, now).occurrenceAt,
      })),
    }
  }

  let target: string | undefined
  for (const { record } of indexed) {
    if (target === undefined || Date.parse(record.scheduledAt) < Date.parse(target)) target = record.scheduledAt
  }
  return { kind: "wait", ...(target === undefined ? {} : { target }) }
}
```

（＋ `scheduleBatchInputId`、`renderEveryReminderBatchFraming`，後者逐字照 dsh。`ScheduleDecision` 型別 export。）

`driver.ts` 內圈：

```ts
      const decision = decideDue(active, accepted)
      if (decision.kind === "none" || decision.kind === "wait") continue
      const delivery: ScheduleDelivery = decision.kind === "one-shot"
        ? {
            sessionId,
            dispatchEvents: [dispatchEventFor(decision.record, accepted)],
            text: renderReminderFraming(decision.record),
            inputId: scheduleOccurrenceInputId(decision.record, decision.occurrenceAt),
            due: [{ sessionId, record: decision.record, occurrenceAt: decision.occurrenceAt }],
          }
        : {
            sessionId,
            dispatchEvents: decision.reminders.map(({ record }) => dispatchEventFor(record, accepted)),
            text: renderEveryReminderBatchFraming(decision.reminders),
            inputId: scheduleBatchInputId(decision.acceptedAt),
            due: decision.reminders.map(({ record, occurrenceAt }) => ({ sessionId, record, occurrenceAt })),
          }
      try {
        await opts.deliver(delivery)
      } catch (err) { /* deliveryErrors + logWarn，照 Task 1 的形狀 */ continue }
      result.due.push(...delivery.due)
      result.delivered += delivery.due.length
```

（`scheduleOccurrenceInputId` 對 every 不再有生產者 ⇒ **它的 every 分支沒了**：簽名保持 `record: ScheduleRecord` 但只剩 one-shot 呼叫；若 TS 允許就收窄成 `AfterScheduleRecord | AtScheduleRecord`。）

- [ ] **Step 4: 跑，確認綠**

```bash
pnpm --filter @i-harness/schedule test && pnpm --filter @i-harness/schedule typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/schedule/src/index.ts packages/schedule/src/driver.ts packages/schedule/test/driver.test.ts packages/schedule/test/schedule.test.ts
git commit -m "feat(schedule): batching — one decision, one delivery, and the model-turn bound is derived, not chosen"
```

---

### Task 4: 建立面 — 三個工具

**Files:**
- Create: `packages/schedule/src/tools.ts`
- Modify: `packages/schedule/package.json`（`"./tools"` export ＋ `@i-harness/core-tools` dep）
- Test: `packages/schedule/test/tools.test.ts`（新檔）

**Interfaces:**
- Produces:
  - `createScheduleTools(deps: { session: Session }): Tool[]` —— 回 `[create, list, delete]`
  - 工具名（dsh parity）：`schedule_create` `{ prompt, after_seconds? | at? | every_seconds? }`（**handler 驗恰好一個 selector** —— schema 沒有 `oneOf`）；`schedule_list` `{}` → `{ schedules: ScheduleView[] }`；`schedule_delete` `{ id }` → `{ deleted: string }`
  - 讀寫**只碰自己的後綴**：`session.events.slice(session.header?.seedLength ?? 0)`（§5；`task-protocol.ts:355` 的同一切法）
- Consumes: `foldScheduleEvents` / `allocateScheduleId` / `create*ScheduleRecord` / `scheduleView` / `ScheduleInputError`；`append`（core-session）；`Tool`（core-tools）。

- [ ] **Step 1: 寫紅測試**

`packages/schedule/test/tools.test.ts`（fixture：`createSession()` ＋ 直接呼叫 `tool.execute(args, {})`）：

```ts
const deps = { session: createSession() }
const [create, list, deleteT] = createScheduleTools(deps)

it("create after: allocates schedule-1 then schedule-2 (ids never reuse)", …)
it("create trims the prompt; empty ⇒ ScheduleInputError invalid_prompt", …)      // 斷言 err.code
it("create at: past instant ⇒ ScheduleInputError not_future", …)
it("create every: < 300 ⇒ ScheduleInputError frequency_too_high", …)
it("zero selectors ⇒ ScheduleInputError invalid_rule", …)                          // 訊息點名 exactly one
it("two selectors ⇒ ScheduleInputError invalid_rule", …)
it("list: reports state scheduled vs overdue, and only THIS session's own suffix", …)
   // 子 session 形狀：events[0] = 父的 create（hand-built, past scheduledAt）＋ header { seedLength: 1 } ⇒ 清單為空
it("delete: removes an active record; an unknown id throws and appends NOTHING", …)
it("flags: create/delete are NOT concurrency-safe (fold-read-then-append); list is read-only", …)
```

- [ ] **Step 2: 跑，確認紅**

```bash
pnpm --filter @i-harness/schedule test
```

- [ ] **Step 3: 實作**

```ts
// packages/schedule/src/tools.ts
// The creation surface (spec §6.2): three session-scoped tools. The MODEL supplies a rule; the
// engine allocates the id (allocateScheduleId — never reuses), so `schedule_delete` only ever
// speaks `schedule-<n>`. create/delete are deliberately NOT concurrency-safe: both fold-then-append,
// and two parallel creates would allocate the SAME id against the same fold — the scheduler
// serializes non-safe tools for exactly this shape (todo_write can be safe because it REPLACES).
import { append, type Session, type SessionEvent } from "@i-harness/core-session"
import type { Tool } from "@i-harness/core-tools"
import {
  ScheduleInputError, allocateScheduleId, createAfterScheduleRecord, createAtScheduleRecord,
  createEveryScheduleRecord, foldScheduleEvents, scheduleView, type ScheduleView,
} from "./index.ts"

export interface ScheduleToolDeps { session: Session }

function ownEvents(session: Session): readonly SessionEvent[] {
  return session.events.slice(session.header?.seedLength ?? 0)
}

export interface ScheduleCreateArgs { prompt: string; after_seconds?: number; at?: string; every_seconds?: number }
export interface ScheduleCreateOutput { id: string; kind: "after" | "at" | "every"; scheduledAt: string }

function createScheduleCreateTool(deps: ScheduleToolDeps): Tool<ScheduleCreateArgs, ScheduleCreateOutput> {
  return {
    name: "schedule_create",
    description: "create a session-local reminder; exactly ONE of after_seconds (delay), at (RFC 3339 with an explicit Z or numeric offset), every_seconds (fixed rate, minimum 300) must be provided; the reminder fires while this session is live",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        after_seconds: { type: "number", minimum: 1 },
        at: { type: "string" },
        every_seconds: { type: "number", minimum: 1 },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    execute: async (args) => {
      const selectors = [args.after_seconds !== undefined, args.at !== undefined, args.every_seconds !== undefined]
        .filter((present) => present).length
      if (selectors !== 1) {
        throw new ScheduleInputError("invalid_rule", "exactly one of after_seconds, at, every_seconds must be provided.")
      }
      const folded = foldScheduleEvents(ownEvents(deps.session))
      const id = allocateScheduleId(folded)
      const now = Date.now()
      const record = args.after_seconds !== undefined
        ? createAfterScheduleRecord(id, args.prompt, args.after_seconds, now)
        : args.at !== undefined
          ? createAtScheduleRecord(id, args.prompt, args.at, now)
          : createEveryScheduleRecord(id, args.prompt, args.every_seconds!, now)
      append(deps.session, { type: "schedule/change", version: 1, operation: "create", schedule: record })
      return { id: record.id, kind: record.kind, scheduledAt: record.scheduledAt }
    },
  }
}

function createScheduleListTool(deps: ScheduleToolDeps): Tool<Record<string, never>, { schedules: ScheduleView[] }> { … fold → active → scheduleView(record, Date.now()) … }

function createScheduleDeleteTool(deps: ScheduleToolDeps): Tool<{ id: string }, { deleted: string }> {
  return {
    name: "schedule_delete",
    description: "delete one schedule by id (schedule-<n>) from THIS session",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    isReadOnly: false,
    isConcurrencySafe: false,
    execute: async ({ id }) => {
      const folded = foldScheduleEvents(ownEvents(deps.session))
      if (!folded.active.some((record) => record.id === id)) {
        throw new Error(`schedule_delete: no active schedule with id ${JSON.stringify(id)}`)  // soft body failure (tool pipeline block ①); NOT a durable write
      }
      append(deps.session, { type: "schedule/change", version: 1, operation: "delete", id })
      return { deleted: id }
    },
  }
}

export function createScheduleTools(deps: ScheduleToolDeps): Tool[] {
  return [createScheduleCreateTool(deps), createScheduleListTool(deps), createScheduleDeleteTool(deps)]
}
```

`package.json`：`"exports"` 加 `"./tools": "./src/tools.ts"`；`"dependencies"` 加 `"@i-harness/core-tools": "workspace:*"`。跑 `pnpm install` 讓 lock 跟上。

- [ ] **Step 4: 跑，確認綠**

```bash
pnpm install && pnpm --filter @i-harness/schedule test && pnpm --filter @i-harness/schedule typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/schedule/src/tools.ts packages/schedule/test/tools.test.ts packages/schedule/package.json pnpm-lock.yaml
git commit -m "feat(schedule): the creation surface — three tools, engine-allocated ids, and the exactly-one selector checked where the schema dialect cannot"
```

---

### Task 5: 宿主 — assembly 掛載（工具 ＋ driver ＋ `agent/pre-step`）

**Files:**
- Modify: `packages/session-executor/src/assembly.ts`
- Modify: `packages/session-executor/package.json`（`@i-harness/schedule` dep）
- Modify: `packages/subagent/src/projection.ts`（第 15-17 行的句子修準）
- Create: `packages/session-executor/test/schedule-delivery.test.ts`
- Modify: `docs/superpowers/specs/2026-09-20-schedule-design.md`（§1 修正 2 的引用隨 projection 註解更新）

**Interfaces:**
- Consumes: Task 1–3 的 `createScheduleDriver` / `ScheduleDelivery`；Task 4 的 `createScheduleTools`；既有 `inbox`（`assembly.ts:769`）、`append`、`opts.coordinator` / `opts.sessionId`。
- Produces: 掛載只在 `opts.coordinator !== undefined && opts.sessionId !== undefined` 時發生（與 session 鏡像同一條件）；**沒有 coordinator 就沒有 durable batch，就沒有掛載**（SDK／ACP 今天不建 assembly，§4.6）。

- [ ] **Step 1: 寫紅測試（`packages/session-executor/test/schedule-delivery.test.ts`，新檔）**

fixture（照 `assembly.test.ts` 的 coordinator double 體例擴充成會記 batch 的版本）：

```ts
function batchCoordinator(): SessionCoordinator & { batches: SessionEvent[][]; written: SessionEvent[] } {
  const written: SessionEvent[] = []
  const batches: SessionEvent[][] = []
  let pending: SessionEvent[] = []
  return {
    batches, written,
    create: async (meta?: { sessionId?: string }) => ({ id: meta?.sessionId ?? "mem-0" }),
    append: async (_id: string, evs: SessionEvent[]) => { written.push(...evs); batches.push([...evs]) },
    enqueue: (_id: string, evs: SessionEvent[]) => { pending.push(...evs) },
    flush: async () => { if (pending.length > 0) { written.push(...pending); batches.push(pending); pending = [] } },
    load: async () => ({ session: { formatVersion: 1, events: [...written] } }),
    list: async () => ["s"], close: async () => {}, putDocument: async () => {}, getDocument: async () => undefined,
  } as unknown as SessionCoordinator
}

function seededOverdueOneShot(session: Session, sessionId: string, coordinator: SessionCoordinator): void {
  const record = createAfterScheduleRecord("schedule-1", "check the build", 1, Date.now() - 10_000)
  append(session, { type: "schedule/change", version: 1, operation: "create", schedule: record })
}
```

（session 用 `createSession((ev) => coordinator.enqueue(sessionId, [ev]))` 建，鏡像照真正宿主的形狀。）

測試：

1. **「閒置 ⇒ 一個 dispatch 都沒有；turn 來了才投遞，而且模型與使用者都看到」**：
   - mount 後 `await sleep(200)`：`session.events` 沒有 dispatch、`coordinator.written` 也沒有（**這條要能紅**：把觸發換成 `setInterval` ⇒ 立刻紅）。
   - `await assembly.agent.run("hello")`（mock client 兩步：`[{text:"ok"}, {text:"second"}]`）：斷言 ——
     - **模型面**：第二個 request 的 messages 裡有含 `[SCHEDULE REMINDER]` 的 user 訊息；
     - **使用者面＋阻斷性檢查**：`session.events` 有那則 `user/message`，`source.kind === "plugin"`、`source.plugin === "i-harness/system-input"`、**`internal === undefined`**（加 `internal: true` ⇒ 必須紅）；
     - **命令列**：`deriveMessages(session)` 也含它；
     - **耐久＋原子**：`coordinator.written` 含 dispatch 與 admitted，且**兩者在同一批、相鄰**（`batches` 裡同一陣列內 index 相差 1）；
     - **§4.4 的 pump**：使用者一個 turn 帶出了第二個 turn（`turn/start` 出現兩次）。
2. **fork 不繼承**：`session.header = { seedLength: 1 }`、`events[0]` ＝ 父的 overdue create ⇒ run 後**零** dispatch（`slice(seedLength)` 不切 ⇒ 紅）。
3. **批次端到端**：兩筆 overdue every ⇒ 一次投遞：一則 admitted（文字含 `[SCHEDULE REMINDER BATCH]`）、**兩個** dispatch、同一批相鄰；run 後 fold 顯示兩筆都推進到新的 `scheduledAt`。
4. **重啟 re-drive 免費**：拿 1 的 `written` 當既有日誌、用新的 session（seed ＝ written）＋ 新 assembly ⇒ tick 不再投遞（fold 消費了 dispatch）。

- [ ] **Step 2: 跑，確認紅**

```bash
pnpm --filter @i-harness/session-executor test
```

- [ ] **Step 3: 實作（assembly.ts）**

`packages/session-executor/package.json` 加 `"@i-harness/schedule": "workspace:*"`（dep）＋ 頂部 import：

```ts
import { createScheduleDriver } from "@i-harness/schedule/driver"
import { createScheduleTools } from "@i-harness/schedule/tools"
```

在 session-scoped 工具區（`:807-810` 之後）加：

```ts
  // E9 schedule (spec 2026-09-20-schedule-design §4.2/§4.6): the delivery mount. Gated on the
  // DURABLE path — coordinator + sessionId, the same condition as the session mirror above —
  // because the acceptance contract IS "dispatch + admission in one durable batch", and without
  // a coordinator there is no batch to speak of. Tools and driver mount together: tools alone
  // would be a fifth zero-source (writes the log, nothing folds it — spec §10).
  if (opts.coordinator !== undefined && opts.sessionId !== undefined) {
    const coordinator = opts.coordinator
    const scheduleSessionId = opts.sessionId
    for (const tool of createScheduleTools({ session })) tools.register(tool)
    const scheduleDriver = createScheduleDriver({
      sessions: () => [scheduleSessionId],
      // Fork (§5): the driver owns only THIS session's own suffix — an inherited prefix
      // (subagent seeds) is never dispatched; the same slice task-protocol.ts:355 takes.
      events: (id) => (id === scheduleSessionId ? session.events.slice(session.header?.seedLength ?? 0) : undefined),
      deliver: async (delivery) => {
        // §3.4 (corrected): the canonical append() path (seq + write-behind mirror + subscribers)
        // for BOTH events, then the flush barrier — the pair lands in ONE backend append, and
        // `deliver` returns only after durability. The engine does not write; this does.
        for (const ev of delivery.dispatchEvents) append(session, ev)
        inbox.admit({ inputId: delivery.inputId, text: delivery.text, delivery: "steer", intent: "system" })
        await coordinator.flush(scheduleSessionId)
      },
    })
    // §4.2: the trigger is the step boundary — no timer exists, so idle means no step means no
    // tick (I5 structurally). The handler MUST return undefined (block body, awaited inside):
    // emit() feeds a plain listener's non-undefined return into the waterfall chain payload, and
    // hooks HAS a waterfall on this same event (hooks/src/index.ts:411).
    ctx.on("agent/pre-step", async () => { await scheduleDriver.tick() })
  }
```

（`append` 若未在 import 清單：加進 `@i-harness/core-session` 的 import。）

`projection.ts` 第 15-17 行改成量到的新實況（**先寫句子，再在同一次編輯後 `grep -n` 量行號**，把 spec §1 修正 2 的引用一起更新）：

```ts
// snapshots). The "schedule" group is part of the summary union for hosts
// that mount a schedule source; an assembly now MOUNTS a real schedule driver
// (session-executor's schedule delivery mount, 2026-09-21), but no schedule
// source is fed to THIS projection yet — rows stay absent until a host provides
// one (honestly).
```

- [ ] **Step 4: 跑，確認綠**

```bash
pnpm --filter @i-harness/session-executor test && pnpm --filter @i-harness/session-executor typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/session-executor/src/assembly.ts packages/session-executor/package.json packages/session-executor/test/schedule-delivery.test.ts packages/subagent/src/projection.ts docs/superpowers/specs/2026-09-20-schedule-design.md pnpm-lock.yaml
git commit -m "feat(session-executor): the schedule mount — tick at the step boundary, and the host owns the atomic [dispatch, admitted] batch"
```

---

### Task 6: 收尾 — torn-tail 量測、transcript、狀態

**Files:**
- Modify: `packages/session-persistence-jsonl/test/jsonl.test.ts`
- Modify: `apps/cli/test/sessions.test.ts`
- Modify: `docs/superpowers/specs/2026-09-20-schedule-design.md`（檔頭：計畫已執行；§3.4 的殘餘視窗若量到更具體的行為就補上量到的）
- Modify: `docs/handoff/2026-09-20-queued-work.md`（§9.2 A1 → ✅）

- [ ] **Step 1: torn-tail 的量測（在既有 test 的體例上加）**

`jsonl.test.ts` 已有「repair truncates a torn tail」的體例（用一個手工截斷的檔，因為「deterministic failure injection is not possible through the public seam」）。加一條：**兩事件批次的 torn tail** —— 寫入 `[dispatch, admitted]` 後把檔尾截在第二條的中間，`repair` 後**逐條斷言實際留下什麼**（讀 `repair.ts` 的預期是「截到最後一條完整行」＝留下第一條；**以量到的為準寫斷言**），並在 spec §3.4 的更正註記補上這一句量到的結果。**這一條不是缺陷修復，是把殘餘視窗寫成事實。**

- [ ] **Step 2: 使用者面的 transcript 案例**

`apps/cli/test/sessions.test.ts` 的 `renderTranscript` describe 加：

```ts
  it("a delivered schedule reminder is user-visible — no `internal`, so the transcript prints it", () => {
    const session = createSession()
    append(session, { type: "turn/start" })
    append(session, { type: "user/message", text: "[SCHEDULE REMINDER]\nPresent reminder_prompt_json …\nschedule_id_json: \"schedule-1\"", source: { kind: "plugin", plugin: "i-harness/system-input" } })
    const text = renderTranscript(session, 20)
    expect(text).toContain("❯ [SCHEDULE REMINDER]")
  })
```

- [ ] **Step 3: 全套閘門（最終）**

```bash
pnpm verify:all
```
Expected: 五步全綠（母體 66；`pnpm -r --no-bail test`、母體檢查、typecheck、`pnpm e2e`、`--gate`）—— **`--gate` 這一刻必須是 `PASS -- no new rows`**（Task 4 的中途 NEW rows 在 Task 5 被消費）。

- [ ] **Step 4: 更新兩份文件**

- spec 檔頭：`這不是施工計畫` 那句之後加一行 —— 計畫路徑 ＋ 已執行（this plan, dated）。
- queued-work §9.2 A1：`**✅ 完成**（計畫 `docs/superpowers/plans/2026-09-21-schedule-delivery.md`；引擎 `…`／工具 `…`／掛載 `…` 提交）` —— **照那一節自己的規矩：狀態與事實同一個提交**。

- [ ] **Step 5: Commit**

```bash
git add packages/session-persistence-jsonl/test/jsonl.test.ts apps/cli/test/sessions.test.ts docs/superpowers/specs/2026-09-20-schedule-design.md docs/handoff/2026-09-20-queued-work.md
git commit -m "test+docs(schedule): the torn-tail measurement, the user-visible transcript case, and A1 closed"
```

---

## Self-review（寫完後跑過的檢查）

**Spec §8 測試表 → 任務對映：**

| spec §8 的對象 | 落點 |
|---|---|
| §4.2 的閘門（閒置零 dispatch；`setInterval` ⇒ 紅） | T5.1（第一段） |
| §3.4 的單一 append（兩筆都在；失敗 ⇒ 兩筆都不在） | T5.1（原子斷言）＋ T6.1（torn-tail 量測；**例外路徑的注入在 public seam 不可能 —— 既有的 jsonl 測試已如此記載**，改以 repair 契約斷言） |
| §3.5 的 inputId（第二次 occurrence；record-keyed ⇒ 紅） | T1（指名紅線） |
| §3.2.1 阻斷性檢查（`internal` 必須缺席） | T5.1（指名斷言） |
| O1 兩者都要（模型面 ＋ 使用者面） | T5.1（模型面、`deriveMessages`）＋ T6.2（`renderTranscript`） |
| §3.3 framing 不動 | Global Constraints（`schedule.test.ts:134` 不動） |
| §6.3 批次界（N ⇒ 一則；一次性讓位；同 tick 不重複） | T3（三條） |
| §5 fork | T5.2 |
| §4.5 守衛 | T2（指名紅線） |
| fold 的腐敗（合法日誌被兩次 dispatch ⇒ `ScheduleLogError`） | T3「no double delivery inside one tick」＋ T5 的批次測試（用 `foldScheduleEvents` 在 run 後重摺驗證） |
| 重啟 re-drive | T5.4（＋既有 driver 測試 2） |
| `schedule_list` 不載入任何東西 | T4（單元）＋ T5 工具經 registry——**T4 的 list 測試直接讀記憶體 session，即「不載入」的實證** |

**沒有做的（明說）：**
- **`packages/subagent/src/projection.ts` 的 schedule rows** —— 不填（spec §9：實作層；`SubagentTaskSource` 今天沒有 schedule 輸入，接它是另一個單元）。只把第 15-17 行的句子修準（T5）。
- **SDK／ACP 宿主掛不掛**（§4.6）—— 不決定、不實作（它們今天不建 assembly）。
- **視野上限、開關預設值** —— 留空（§6.3.4；Global Constraints）。
- **`start()`／`stop()`／`pollMs`** —— 留著不用（§4.3）；宿主只呼 `tick()`。

**型別一致性：**`ScheduleDelivery`（T1）在三處出現：driver 的 Options（T1）、T5 的 deliver 實作、測試 fixture —— 欄位名一致（`dispatchEvents`／`text`／`inputId`／`due`）。`decideDue`（T3）的回傳在 driver 內圈消費；`ScheduleDecision` 只在兩處（定義、driver）。`createScheduleTools`（T4）的回傳 `Tool[]` 與 assembly 的 `tools.register(tool)` 沿用 todo 的形狀。
