# M74 — 子代理的預算要撐得住 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓子代理撐得住它自己的預算——給它一台 compactor（這樣超壓時它**壓縮後繼續**，而不是 `prompt_too_long` 硬失敗），並先修掉一個**今天就存在**的缺陷：`forkTurns` 把父的壓縮標記連同**父的 seq 號碼**交給子代理。

**Architecture:** 兩件事都**極小**，因為 M73 已經把需要的值全部算出來了。①`forkTurns` 在切片之後補一段重映射，而那段**已經有現成的實作**（`session-persistence` 的 `remapSeedEvent`，現在只是沒匯出）。②兩個子代理建構點各加一個 `compact` 鍵——`requestShape` 由 core-agent 自己用子代理的 prompt／tools 建、`maxOutputTokens` M73 已經傳了，所以**沒有任何新的穿線**。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-23-child-budget-compaction-design.md`（權威；§1 是設計、§2 是驗收）

## Global Constraints

- **紅先測試 ＋ 變異證明**：每一條修法都要先看到紅；實作後**把修法拿掉一次**、確認**具名的那條**測試變紅、再用 Edit 工具還原（**絕不**用 `git checkout --`），並以 `sha256sum` 確認位元組還原。
  - **突變是預測**：本計畫寫「拿掉哪一條規則 ⇒ 哪一條測試必須紅」。**哪一行字面編輯能達到那個效果，由你量測決定並記錄**——M72／M73 兩個階段裡，計畫的字面突變預測錯了**十三次**。若你找不到能讓它紅的突變，**那是發現，回報它**，不要換一條測試來遷就。
- **既有測試只在「它刻意斷言的正是這次要改的契約」時才改**，而且要**具名說明**、不得放鬆。本計畫預期**只有一條**：`packages/subagent/test/child.test.ts` 的「a child past its window FAILS CLOSED」（Task 4）。**若你跑出來紅的不是那一條，回報它**——錯的清單比沒有清單更糟。
- **缺席即缺席**：沒有窗口就不寫 `compact` 鍵——**不得注入預設**。
- **提交訊息不加任何 attribution trailer**；**不 amend**；blobs LF；檔案用 Write/Edit 工具寫。
- **每個任務只跑自己套件的測試與 typecheck**；`pnpm verify:all` **整支分支只跑一次**（收尾任務）。
- **不要動 `docs/`**（紀錄由控制器寫）。**不要動 seam 的事件聯集與 `LLMUsage` 的欄位**。
- **一條規則只落一處**：`remapSeedEvent` **只准有一份**（Task 1 就是把它接給第二個呼叫者）。

---

### Task 1: `forkTurns` 把壓縮標記重映射到子代理的座標（前置）

**Files:**
- Modify: `packages/session-persistence/src/fork.ts:164`（`function` → `export function`，並補一句它現在有第三個消費者）
- Modify: `packages/session-persistence/src/index.ts:13-16`（把 `remapSeedEvent` 加進 `./fork.ts` 的 export 區塊）
- Modify: `packages/subagent/src/fork.ts`（整支 12 行）
- Test: `packages/subagent/test/child.test.ts`（`describe("fork.ts")`，`:23-33`）

**Interfaces:**
- Consumes: `remapSeedEvent(event, index, renumbered: ReadonlyMap<number, number>): SessionEvent`（`session-persistence/src/fork.ts:164`；`@i-harness/session-persistence` 已是 subagent 的依賴）
- Produces: 行為——`forkTurns(events, n)` 的輸出在**子代理的座標**裡（`seq === index`、引用指向子代理的事件、指向切片外的事件不再被引用）

**實況（量測）**：`forkTurns` 是 12 行的 raw slice（`subagent/src/fork.ts`），三個 return 路徑（`n === 0`、沒有 turn/start、切片）都**逐字**交出事件。`append` 只重寫事件自己的 `seq`（`core-session:353`），**不動** `shadowedSeqs`／`removedSeqs` 裡引用的索引。`"all"` 時整份都在、索引重合（無害）；`forkTurns: N` 時切片從後面的 `turn/start` 開始，而父的頭部相對引用現在指向**子代理座標裡完全不同的那些事件**——包含它自己。

- [ ] **Step 1: 寫紅測試**

在 `describe("fork.ts")`（`child.test.ts:23-33`）內加：

```ts
  // M74: the slice used to be handed over VERBATIM, so a parent's compaction
  // marker carried the PARENT's seq numbers into a log that starts at 0. With
  // "all" the indices coincide and nothing shows; with N they name unrelated
  // events — and a `compaction/summary`'s shadowedSeqs would hide the child's
  // OWN turn, including the summary itself. The fix is the same remap the
  // session-fork path has always done (session-persistence's remapSeedEvent).
  it("M74: a parent's compaction marker is remapped into the child's coordinates", () => {
    const events: SessionEvent[] = []
    // `seq` is assigned by `append` in production (core-session:353) and the remap
    // is a function of those numbers — so this unit test gives each event the same
    // dense 0..n-1 the real log would carry.
    const push = (type: string, extra: Record<string, unknown> = {}) =>
      events.push({ type, seq: events.length, ...extra } as SessionEvent)
    push("turn/start"); push("user/message", { text: "a" }); push("assistant/message", { text: "A" }); push("turn/end")
    // the parent compacted at its head: this summary shadows the four events above
    push("compaction/summary", { version: 1, text: "S", shadowedSeqs: [0, 1, 2, 3] })
    push("turn/start"); push("user/message", { text: "b" }); push("assistant/message", { text: "B" }); push("turn/end")

    const seed = forkTurns(events, 1) // the last turn — the slice starts at index 4

    // the marker rides along (it is not a cut), but the four events it named are
    // NOT in this child: those references have no target and are dropped.
    expect(seed[0]).toMatchObject({ type: "compaction/summary", shadowedSeqs: [] })
    // every event is renumbered into the child's coordinates (seq === index)
    expect(seed.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4])
    expect(seed.map((e) => e.type)).toEqual([
      "compaction/summary", "turn/start", "user/message", "assistant/message", "turn/end",
    ])
  })

  it("M74: a marker whose region IS in the child keeps its references, in child coordinates", () => {
    const events: SessionEvent[] = []
    const push = (type: string, extra: Record<string, unknown> = {}) =>
      events.push({ type, seq: events.length, ...extra } as SessionEvent)
    push("turn/start"); push("user/message", { text: "a" }); push("assistant/message", { text: "A" }); push("turn/end")
    push("compaction/summary", { version: 1, text: "S", shadowedSeqs: [0, 1] })
    push("turn/start"); push("user/message", { text: "b" }); push("assistant/message", { text: "B" }); push("turn/end")

    const seed = forkTurns(events, 2) // the whole log: nothing is dropped

    expect(seed[4]).toMatchObject({ type: "compaction/summary", shadowedSeqs: [0, 1] })
  })
```

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/subagent test`
Expected: 第 1 條紅——今天 `seed[0]` 的 `shadowedSeqs` 是 `[0,1,2,3]`（父的座標），而且**沒有任何 `seq` 被重新編號**。第 2 條**綠先**（`"all"` 那條路今天就不會壞）——它的殺手是 Step 5 的變異。

- [ ] **Step 3: 匯出既有的實作（session-persistence）**

`packages/session-persistence/src/fork.ts:164`：

```ts
export function remapSeedEvent(event: SessionEvent, index: number, renumbered: ReadonlyMap<number, number>): SessionEvent {
```

並把上面那段註解（`:161-163`）補一句：**它從 M74 起有第三個消費者**（原本是 `completedTurnPrefix`，現在加上 subagent 的 `forkTurns`）。

`packages/session-persistence/src/index.ts` 的出口區塊（`:13-16`）：

```ts
export {
  forkSession,
  remapSeedEvent,
  type ForkSessionOptions,
} from "./fork.ts"
```

- [ ] **Step 4: 讓 `forkTurns` 用它**

`packages/subagent/src/fork.ts` 全檔：

```ts
import type { SessionEvent } from "@i-harness/core-session"
import { remapSeedEvent } from "@i-harness/session-persistence"

/** The last N parent turns as a child's SEED — in the CHILD's coordinates.
 *
 * M74: this used to return a raw slice, so a parent's compaction markers
 * carried the parent's seq numbers into a log that starts at 0. With "all" the
 * indices coincide; with N they name unrelated events, and a summary's
 * `shadowedSeqs` would hide the child's own turn (itself included) — silent
 * content loss with no test covering it. The remap is the SAME one the session
 * fork has always applied (session-persistence's `remapSeedEvent`): renumber to
 * the child's coordinates, and drop references into events this child never
 * received. `append` only rewrites an event's own `seq`, never the seqs it
 * NAMES — which is exactly why this pass has to exist here. */
export function forkTurns(events: SessionEvent[], n: number): SessionEvent[] {
  const seed = sliceTurns(events, n)
  // Every return path goes through the remap, including the untouched ones: for
  // a whole-log seed it is the identity, and making it unconditional is what
  // keeps the contract ("the output is in child coordinates") true for all of them.
  const renumbered = new Map<number, number>()
  for (const [index, event] of seed.entries()) {
    if (event.seq !== undefined) renumbered.set(event.seq, index)
  }
  return seed.map((event, index) => remapSeedEvent(event, index, renumbered))
}

function sliceTurns(events: SessionEvent[], n: number): SessionEvent[] {
  if (n === 0) return []
  const turnStarts: number[] = []
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.type === "turn/start") turnStarts.push(i)
  }
  if (turnStarts.length === 0) return events
  if (turnStarts.length <= n) return events
  return events.slice(turnStarts[turnStarts.length - n]!)
}
```

（切片邏輯**逐字不變**，只是搬進 `sliceTurns`；`remapSeedEvent` 的 `index` 就是 `entries()` 的索引。）

- [ ] **Step 5: 跑它，看到綠 ＋ 變異證明**

Run: `pnpm --filter @i-harness/subagent test`、`pnpm --filter @i-harness/session-persistence test`、兩個 typecheck。

變異：把 `forkTurns` 的 return 改回 `sliceTurns(events, n)`（即拿掉重映射）⇒ 第 1 條必須紅。記錄實際編輯與 `sha256sum`。

- [ ] **Step 6: Commit**

```bash
git add packages/session-persistence/src/fork.ts packages/session-persistence/src/index.ts packages/subagent/src/fork.ts packages/subagent/test/child.test.ts
git commit -m "fix(subagent): a forked seed arrives in the child's coordinates, markers included (M74)"
```

---

### Task 2: 子代理的 compactor（兩個站點）

**Files:**
- Modify: `packages/subagent/src/child.ts:356-373`（spawn 的 deps；含**改寫 M73 那段現在已經變成假的註解**）
- Modify: `packages/subagent/src/tools.ts:687-693`（rebuild 的孿生）
- Test: `packages/subagent/test/child.test.ts`

**Interfaces:**
- Consumes: `AgentConfig.compact?: CompactionConfig`（`core-agent:48`，`contextWindow` 必填）；`CompactionConfig`（`compaction/src/config.ts:28-59`）；`contextWindow`／`overheadTokens` 兩個區域變數（M73 已算好）
- Produces: 行為——超壓的子代理**壓縮後繼續**，而不再 `prompt_too_long`

**實況（量測）**：階梯的第 1、2 層都要 compactor（`core-agent:230-238`），而子代理的 deps 沒有它 ⇒ 只有第 3 層。子代理的預算是 `contextWindow * 0.9`（`core-agent:31`），壓力門檻是 `0.8`（`config.ts:106`）——**那 10% 就是壓縮的餘裕**。`requestShape` **不用做**：core-agent 自己用 `deps.systemPrompt` ＋ `deps.tools.schemas()` 建它（`:189-193`）⇒ 子代理的引擎自動拿到子代理自己的 prefix。`maxOutputTokens` M73 已經傳了。

- [ ] **Step 1: 寫紅測試**

```ts
  // M74. Before this, a child past `window * 0.9` had exactly one ladder layer
  // left — the fail-closed throw — because no compactor was built. Now it has
  // one: the pass shadows the region and the turn CONTINUES.
  it("M74: a child past its window COMPACTS and finishes", async () => {
    const f = spawnFixture()
    // A parent log big enough that the seed alone puts the child over the
    // pressure gate of the window below. Built with the real `append` (not a
    // raw push): it is what assigns `seq`, and the seed's coordinates depend on
    // those numbers. (`append` 加進本檔第 3 行既有的 `@i-harness/core-session` import。)
    for (let i = 0; i < 12; i++) {
      append(f.parentSession, { type: "turn/start" })
      append(f.parentSession, { type: "user/message", text: `q${i} ` + "filler ".repeat(60) })
      append(f.parentSession, { type: "assistant/message", text: `a${i} ` + "filler ".repeat(60) })
      append(f.parentSession, { type: "turn/end" })
    }
    const SUMMARY = "## Primary Request and Intent\n- " + "work ".repeat(120) // ≥ 500 chars (the floor)
    const requests: LLMRequest[] = []
    const client: ModelClient = {
      async *stream(request) {
        requests.push(request)
        const last = request.messages.at(-1)
        const isSummary = typeof last?.content === "string" && last.content.includes("summar")
        yield { type: "text/chunk", text: isSummary ? SUMMARY : "child done" }
        yield { type: "end" }
      },
    }
    const { jobId } = await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: f.roles.get("general")!,
      parentModel: client, resolveModel: noRoleModel,
      contextWindow: 2_000, // the seed alone is over 0.8 × this
      jobs: f.jobs, table: f.table, agents: f.agents,
    })
    for (let i = 0; i < 300 && f.jobs.read(jobId).status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }

    // it FINISHED — the pre-M74 behaviour was a `prompt_too_long` error here
    expect(f.jobs.read(jobId).status).toBe("completed")
    // …and the model really was asked to summarise (the child's own engine)
    expect(requests.length).toBeGreaterThan(1)
  }, 15_000)
```

**數字是預測**：`12` 輪 × 約 420 字元 ≈ 3.2k 字元 ≈ 800 token，窗口 2000 ⇒ 0.8 × 2000 = 1600 —— 上面那組**應該**超壓。若你的量測顯示沒超（或超太多以致摘要也救不回來），**調整數字並在報告裡寫明你改成什麼、量到什麼**。

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/subagent test`
Expected: 紅——`status` 是 `"error"`（`prompt_too_long`），而且 `requests` 是空的（一條請求都沒出去）。

- [ ] **Step 3: 實作（兩個站點同一個鍵）**

`packages/subagent/src/child.ts`：把 M73 那段註解（`:362-370`，它現在說「a spawn passes no `compact` deps … FAILS CLOSED … 那是刻意的取捨」，而 M74 讓它變成假的）**改寫成真的事實**，並在 `budget` 的 spread 之後加：

```ts
    // M74: the child's OWN compactor. Without it the ladder's first two layers
    // are unreachable (core-agent builds one only from `compact`) and a child
    // past `window * 0.9` has exactly one layer left — the fail-closed throw.
    // With it, the pass shadows the region and the turn continues; the 10%
    // between the pressure gate (0.8) and the budget (0.9) is its head start.
    // `requestShape` needs no wiring here: core-agent builds it from THIS
    // child's systemPrompt and tools, so the summarizer's call is a byte-prefix
    // of the child's own request (the provider cache serves it). `auto` is not
    // written — it already defaults true, and a knob that can only be turned off
    // would be a surface a child has no handle to use (`Agent.compact` is
    // reachable only through a SessionAssembly).
    ...(contextWindow !== undefined
      ? { compact: { contextWindow, ...(overheadTokens !== undefined ? { overheadTokens } : {}) } }
      : {}),
```

`packages/subagent/src/tools.ts`：在 rebuild 的 `budget` spread（`:691-693`）之後加**同形**的一段（含一句「與 spawn 同形、同源——只出現在第一次 spawn 的 compactor 會在每次 resume 時消失」）。

- [ ] **Step 4: 跑它，看到綠**

Run: `pnpm --filter @i-harness/subagent test`、該套件 typecheck。
Expected: 新的綠。**既有的案例**——除了 Task 4 要處理的那一條——都必須**原樣**綠；特別是 `resume.test.ts` 一族（它們的 fixture 很小，不該觸發壓縮；**若有一條因為多了一次摘要請求而紅，回報它**，那代表門檻比預期低）。

- [ ] **Step 5: 變異證明**

拿掉 `child.ts` 的 `compact` spread（只拿掉 spawn 那一個）⇒ 新測試必須紅（回到 `prompt_too_long`）。還原並 `sha256sum`。

- [ ] **Step 6: Commit**

```bash
git add packages/subagent/src/child.ts packages/subagent/src/tools.ts packages/subagent/test/child.test.ts
git commit -m "feat(subagent): a child gets its own compactor, from the values M73 already resolved (M74)"
```

---

### Task 3: 不會有兩份摘要 ＋ 摘要請求帶的是子代理自己的 prefix

**Files:**
- Test: `packages/subagent/test/child.test.ts`（只加測試——**若這裡需要改程式，那是一個發現，回報它**）

**Interfaces:**
- Consumes: Task 2 的 `compact` 鍵
- Produces: 兩條被釘住的性質

**實況（量測）**：`lastSummaryText` 掃**整份** log（`compaction/src/index.ts:547-556`）並把找到的摘要當 `<previous-summary>` 注入；而 `deriveMessages` 把 `compaction/summary` 渲染成一個 `user` 訊息（`core-session:561-563`）⇒ 子代理的第一次壓縮會「更新」一份關於**父的歷史**的摘要，而**若沒把它 shadow 掉**，模型會同時看到兩份。`retainTokens: 0` 的預設讓 region 從頭開始 ⇒ **應該**涵蓋它——**這一條要量**。

- [ ] **Step 1: 寫測試**

```ts
// 第 3 行的 import 補成：import { createSession, deriveMessages, type SessionEvent } from "@i-harness/core-session"
  it("M74: a compacted child's surface shows ONE summary — the inherited one is shadowed", async () => {
    const f = spawnFixture()
    const PARENT_SUMMARY = "PARENT-SUMMARY-SENTINEL " + "old ".repeat(200)
    append(f.parentSession, { type: "turn/start" })
    append(f.parentSession, { type: "user/message", text: "q " + "filler ".repeat(300) })
    append(f.parentSession, { type: "assistant/message", text: "a " + "filler ".repeat(300) })
    append(f.parentSession, { type: "turn/end" })
    append(f.parentSession, { type: "compaction/summary", version: 1, text: PARENT_SUMMARY, shadowedSeqs: [1, 2] })
    const CHILD_SUMMARY = "CHILD-SUMMARY-SENTINEL " + "new ".repeat(200)
    const client: ModelClient = {
      async *stream(request) {
        const last = request.messages.at(-1)
        const isSummary = typeof last?.content === "string" && last.content.includes("summar")
        yield { type: "text/chunk", text: isSummary ? CHILD_SUMMARY : "child done" }
        yield { type: "end" }
      },
    }
    const { path, jobId } = await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: f.roles.get("general")!,
      parentModel: client, resolveModel: noRoleModel,
      contextWindow: 2_000,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })
    for (let i = 0; i < 300 && f.jobs.read(jobId).status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(f.jobs.read(jobId).status).toBe("completed")

    const childSession = f.table.get(path)!.session
    const surface = deriveMessages(childSession).map((m) => typeof m.content === "string" ? m.content : "").join("\n")
    // the child's own summary is on the surface…
    expect(surface).toContain("CHILD-SUMMARY-SENTINEL")
    // …and the one it inherited is NOT — two summaries would mean the model is
    // reading a description of the parent's history next to its own.
    expect(surface).not.toContain("PARENT-SUMMARY-SENTINEL")
  }, 15_000)
```

（兩個存取子都**已量過**：`f.table.get(path)!.session` 是本檔既有的慣例（`child.test.ts:153-155` 的 `table.get("root/helper")` ＋ `entry.session.header`），而 `deriveMessages` 要加進本檔第 3 行既有的 `@i-harness/core-session` import。）

- [ ] **Step 2: 跑它**

Run: `pnpm --filter @i-harness/subagent test`
Expected: **可能綠先**（`retainTokens: 0` 應該讓 region 涵蓋繼承的摘要）。它的價值是**釘住**那條性質：Step 3 的變異才是它的殺手。

- [ ] **Step 3: 變異證明**

讓 region **不**涵蓋繼承的摘要——最容易的方式是在 `compact` 的 config 裡給 `retainTokens` 一個大到會保住它的值（例如 `retainTokens: 10_000`）⇒ 這條測試必須紅。記錄你實際用的編輯與它紅的方式。還原並 `sha256sum`。

- [ ] **Step 4: 加第二條（摘要請求的 prefix）**

在 Task 2 的測試（或新的一條）裡，於 `requests` 上斷言：**摘要器那一次**請求帶的是**子代理自己的** system prompt：

```ts
    // The summarizer's call is a byte-prefix of the child's own request — that is
    // what requestShape buys, and core-agent builds it from THIS child's deps.
    // (The legacy text form would carry systemPrompt: "".)
    const summarizerReq = requests.find((r) => {
      const last = r.messages.at(-1)
      return typeof last?.content === "string" && last.content.includes("summar")
    })
    expect(summarizerReq?.systemPrompt).toBe(composeSubagentPrompt(f.roles.get("general")!.systemPrompt))
```

（`composeSubagentPrompt` 由 `../src/child.ts` 匯出，本檔已 import。）

- [ ] **Step 5: 跑它，看到綠 ＋ Commit**

Run: 該套件 test ＋ typecheck。

```bash
git add packages/subagent/test/child.test.ts
git commit -m "test(subagent): a compacted child shows one summary, and its summarizer reuses its own prefix (M74)"
```

---

### Task 4: M73 的 fail-closed 契約改成更精確的說法 ＋ 缺席即缺席

**Files:**
- Modify: `packages/subagent/test/child.test.ts:877-909`（**本計畫唯一預期要改的既有斷言**）
- Test: 同檔

**Interfaces:**
- Consumes: Task 2 的 `compact` 鍵
- Produces: 行為——超窗的子代理仍然 fail-closed，但「沒有請求出去」變成「只有摘要器那一次」

**實況（量測）**：那一條今天斷言 `expect(parentClient.requests).toHaveLength(0)`（`:908`），而它的註解（`:877-885`）說「a spawn hands core-agent NO `compact` deps, so no compactor is built」。M74 讓兩者都變成假的：有了 compactor，引擎會在 `enforceBudget` **之前**跑 `maybeCompact`（`core-agent:285` 先於 `:290`），於是**摘要器**會發一次請求。

- [ ] **Step 1: 改寫那條測試（具名：這是刻意的收緊，不是放寬）**

- 標題：`"a child past its window FAILS CLOSED — one summarizer call, and no over-window request"`
- 註解（`:877-885`）改寫成真的事實：**有了 compactor，失敗前會有一次摘要器呼叫**（那正是 M74 要的），而**超窗的主要請求仍然一條都沒出去**。
- 斷言改成：

```ts
    expect(f.jobs.read(jobId).status).toBe("error")
    expect(f.jobs.read(jobId).output).toMatch(/prompt_too_long/)
    // 而不是送出超窗請求 — the ladder runs at the step boundary BEFORE the model
    // is called. M74: with a child compactor the FIRST thing that happens is a
    // summarizer call; what must never happen is the over-window MAIN request.
    // (The summarizer's own request never carries the over-window messages.)
    const mainRequests = parentClient.requests.filter((r) => {
      const last = r.messages.at(-1)
      return !(typeof last?.content === "string" && last.content.includes("summar"))
    })
    expect(mainRequests).toHaveLength(0)
```

- [ ] **Step 2: 跑它，看到綠**

Run: `pnpm --filter @i-harness/subagent test`。**其餘全部案例都必須原樣綠。**

- [ ] **Step 3: 加「缺席即缺席」那一條**

```ts
  it("M74: with no window there is no compactor — absent stays absent", async () => {
    const f = spawnFixture()
    const requests: LLMRequest[] = []
    const client: ModelClient = {
      async *stream(request) {
        requests.push(request)
        yield { type: "text/chunk", text: "child done" }
        yield { type: "end" }
      },
    }
    const { path, jobId } = await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: f.roles.get("general")!,
      parentModel: client, resolveModel: noRoleModel,
      jobs: f.jobs, table: f.table, agents: f.agents, // no contextWindow, no maxOutputTokens
    })
    await settled(f.jobs, jobId)

    // no window ⇒ no `budget` ⇒ the ladder never runs ⇒ no `compact` either:
    // the child cannot compact, and nothing invents a window to let it.
    const childSession = f.table.get(path)!.session
    expect(childSession.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
    expect(requests).toHaveLength(1)
  }, 10_000)
```

- [ ] **Step 4: 跑它，看到綠；變異：讓 `compact` 無條件寫入（沒有窗口時也寫）⇒ 建構會拋（`config.ts:103-105` 驗窗口）——**記錄你實際量到的紅**。

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/test/child.test.ts
git commit -m "test(subagent): the fail-closed case says what it actually asserts, and absence stays absent (M74)"
```

---

### Task 5: 收尾（閘門＋報告）

**Files:** 無（只跑閘門與寫報告）

- [ ] **Step 1: `pnpm verify:all`**

Run: `pnpm verify:all`
Expected: 五步全綠（母體 67）。**注意 reachability 的列數**：本階段把 `remapSeedEvent` 匯出（連同從 package index 轉出）——它有**一個消費者**（subagent 的 `forkTurns`），所以**不該**新增未消費的列；**若閘門說有未消費的 row，那是真的，回報而不要加 allowlist**。
- **若 suite 紅在已量測的負載 flake**（`apps/cli` 的 M12 retry、`session-executor` 的 `shell-promotion W10`、`apps/cli` 的 headless W10）：依既有先例隔離跑、**兩個讀數都記**。**本機跑閘門時不要同時跑其他 subagent。**

- [ ] **Step 2: 報告**（寫給控制器，不進 git）

每個任務各自的：紅先證據、GREEN、**每一條變異證明與其 sha 驗證**（含你實際用的那一行編輯）、被改動的既有斷言（引用前後並說明為何是**刻意**而非放鬆）、以及**沒有做的事**（見 §殘餘）。

---

## 驗收（照 spec §2）

1. **`forkTurns: N` 帶著壓縮標記的父 log** ⇒ 引用落在子代理座標、沒有內容無聲消失（Task 1）。
2. **超壓的子代理壓縮後繼續**（Task 2 的第 1 條）。
3. **摘要請求帶子代理自己的 prefix**（Task 3 第 4 步）。
4. **不會有兩份摘要**（Task 3 第 1 條）。
5. **重建的路徑也一樣**（Task 2 第 3 步的兩個站點；`resume.test.ts` 既有案例原樣綠）。
6. **缺席即缺席**（Task 4 第 3 步）。
7. **M73 的 fail-closed 契約不放寬**（Task 4 第 1 步）。
8. `pnpm verify:all` 五步全綠、`--gate` 無新增 row（Task 5）。

**每一條都要有對應的變異證明**（把修法拿掉 ⇒ 該條紅）。

## 殘餘（本階段**不做**，寫出來不是忘了）

- **inbox 游標的邊角**：`compaction/reset` 會讓一則 inbox 訊息對模型不可見、卻仍算已消費（`tools.ts:750-753` 讀原始事件）。改了會讓壓縮在最需要的時候失效（spec §1.5）。
- **子代理的 telemetry**：`compaction/attempt` 對它仍不可見——但**主要 session 的引擎今天也沒收到 telemetry**（core-agent 不傳），那是既存的對等缺口。
- **子代理的 `modelPolicies`／catalog 窗口**：同上，主要 session 的引擎也沒有 `profile`／`modelId`／`provider`。
- **`forkTurns` 的預設值**（`"all"`）——產品決定：它決定子代理「看得到什麼」。
- **`forkTurns` 在非耐久臂的 seq 混用**：非耐久臂用 `events.push` 播種（保留父的 seq），之後的 `append` 重新編號。那份混用不會被任何耐久讀者看到，但它是同一個函式家族的另一個未爆彈。
- **子代理的壓縮門檻客製化**：沒有 host 介面，走預設。
