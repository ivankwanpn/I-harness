# `operator/run-end`（durable run 紀錄）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次 CLI 執行結束時，把它的身分與結局（runId、exitCode、時長、phase、已 redact 的 error）寫進 session 的 durable log，並讓 `sessions list`／`sessions show` 讀得到。

**Architecture:** 一個新的 `SessionEvent` 成員（additive、引擎型別、非 wire）＋ 註冊進載入閘門；生產者是 `runHeadless` 的**三個 append 站點**，各自緊鄰既有的 `flush`／`close`（**不是** `emitSessionEnd` 漏斗——量測：成功路徑在 `run.ts:748` 就 `close()` 了，漏斗在 `:778` 才發）；表面改 `sessions.ts` 的兩處渲染。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-22-operator-run-end-design.md`（本計畫的權威；它記著每個決定的理由與量測）

## Global Constraints

- **未設 `I_HARNESS_LOG` 的行為逐位元組不變**：本單元**不動 console 通道**——`emitSessionEnd` 漏斗一字不改（它只發 telemetry），append 走 session log。
- **新事件必須註冊、且絕不 `ignorable`**：`load()` 對未註冊型別拋 `SessionFormatUnsupportedError`（`packages/session-persistence/src/index.ts:421-425`），而 ignorable 會被 `load()` 丟掉。這個缺陷類在本樹**出貨過兩次**（`rewind/point`、`sandbox/mode`）⇒ 驗收是**載入往返**，不是 append 斷言。
- **寫進記錄的 `error` 必須是衍生、已 redact 的一行**（`fromError(err, redactor).message`，`packages/diagnostics/src/record.ts:87`）；**沒有 redactor ⇒ 省略 `error` 欄位**，永不寫未 redact 的訊息（W6 §3.5 強制力第 2 層）。
- **既有測試案例一條不改**；新增的案例**附加**在既有測試檔尾（`sessions.test.ts`）或新檔。
- **零新外部依賴**；只加 workspace link。**`--gate` 不得新增 row**（新 export 需真消費者，否則逐列 allowlist 附 `reason`＋`dated`）。
- **不 amend 任何已回報的提交；提交訊息不加 attribution trailer**；blobs LF、無 BOM；引用的 `path:line` 寫入前先重量。
- 最終閘是 **`pnpm verify:all`**（`pnpm -r --no-bail test` 單獨跑不是閘門；本 suite 有已量測的負載 flake，可疑失敗先單獨跑該套件）。

---

### Task 1: 事件＋載入閘門（引擎切片）

**Files:**
- Modify: `packages/core-session/src/index.ts`（union 尾端加一個成員）
- Modify: `packages/session-persistence/src/index.ts`（`registerEventType` 一條，放在 `:247` 的 `tool/dispatch` 旁）
- Test: `packages/session-persistence/test/run-end-event.test.ts`（新，形狀照 `test/rewind-event.test.ts`）

**Interfaces:**
- Produces: `SessionEvent` 成員 `{ type: "operator/run-end"; version: 1; runId: string; exitCode: number; durationMs: number; phase: …字面 union…; error?: string; seq?: number }`（Task 2 的 append 與 Task 3 的渲染消費它）

- [ ] **Step 1: 寫紅測試**

```ts
// packages/session-persistence/test/run-end-event.test.ts
// M3 §3.4: `operator/run-end` must be registered with the load gate. A durable
// session carries the record in its jsonl; without the registration
// guardIgnorable throws SessionFormatUnsupportedError and the session cannot be
// loaded after a restart. The trap has shipped twice (rewind/point,
// sandbox/mode), so the shape asserted here is a LOAD ROUND-TRIP.
import { describe, expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("operator/run-end persistence (M3 §3.4)", () => {
  it("round-trips through jsonl: load() keeps the record and its fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-run-end-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
    try {
      const { id } = await coordinator.create({})
      const log = createSession()
      append(log, { type: "turn/start" })
      append(log, { type: "turn/end" })
      append(log, {
        type: "operator/run-end",
        version: 1,
        runId: "run-fixture-1",
        exitCode: 1,
        durationMs: 1234,
        phase: "run",
        error: "the summarizer exploded",
      })
      coordinator.enqueue(id, log.events)
      await coordinator.flush(id)
      await coordinator.close()

      // Fresh coordinator over the same dir = the restart path.
      const reopened = createSessionCoordinator(createJsonlBackend(dir), {})
      try {
        const loaded = await reopened.load(id)
        expect(loaded.session.events.map((e) => e.type)).toEqual([
          "turn/start", "turn/end", "operator/run-end",
        ])
        expect(loaded.session.events.at(-1)).toMatchObject({
          type: "operator/run-end",
          version: 1,
          runId: "run-fixture-1",
          exitCode: 1,
          durationMs: 1234,
          phase: "run",
          error: "the summarizer exploded",
        })
      } finally {
        await reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 跑它，看到 RED #1（型別不存在）**

Run: `pnpm --filter @i-harness/session-persistence test run-end-event`
Expected: **編譯失敗**——`operator/run-end` 不在 `SessionEvent` 裡（`tsc`／vitest 的 transform 報 unknown property）。這是紅 #1。

- [ ] **Step 3: 加 union 成員**

在 `packages/core-session/src/index.ts` 的 `SessionEvent` union 尾端（`rewind/point` 之後）加：

```ts
    // M3 §3.4: the durable run-end record. The CLI's run path appends it at
    // each producing exit (pre-assembly failure / success / run failure) so a
    // failed run is diagnosable AFTER the fact — `failureReport` lives only on
    // stderr, and the completion definition ("一次失敗的執行不需要人手讀 JSONL
    // 就能定位") needs a record that outlives the process. The phase vocabulary
    // is @i-harness/diagnostics' DiagnosticPhase — INLINED because core-session
    // must stay dependency-free (job/status precedent, :81-83); the producer
    // (the CLI run path) owns the event, and its assignment is the compile-time
    // check that the two sets stay equal. UI-plane: deriveMessages' default
    // branch keeps it model-invisible and deriveSearchText would return ""
    // (unindexed). Additive; format version stays 1.
    | { type: "operator/run-end"; version: 1; runId: string; exitCode: number; durationMs: number; phase: "cli" | "config" | "run" | "turn" | "sdk" | "acp" | "session" | "mount" | "telemetry" | "shutdown"; error?: string; seq?: number }
```

- [ ] **Step 4: 跑它，看到 RED #2（行為紅：載入閘門）**

Run: `pnpm --filter @i-harness/session-persistence test run-end-event`
Expected: 編譯過了，測試紅在 `SessionFormatUnsupportedError: unknown event type 'operator/run-end' without ignorable marker`——**這正是先例註解預言的紅**。

- [ ] **Step 5: 註冊它**

在 `packages/session-persistence/src/index.ts` 的其餘 `registerEventType(...)` 旁（`:247` 的 `registerEventType("tool/dispatch")` 之後）加：

```ts
// M3 §3.4: the CLI run path's durable run-end record. NOT `ignorable: true`:
// load() DROPS ignorable events, which would erase the very record this event
// exists to keep — the same defect class as `rewind/point` above and
// `sandbox/mode` before it.
registerEventType("operator/run-end")
```

- [ ] **Step 6: 跑它，GREEN**

Run: `pnpm --filter @i-harness/session-persistence test run-end-event` → PASS；再跑 `pnpm --filter @i-harness/session-persistence test` 與 `pnpm --filter @i-harness/core-session test` 兩套全綠。

- [ ] **Step 7: typecheck 與 gate**

Run: `pnpm --filter @i-harness/core-session typecheck` ＋ `node scripts/audit/check-reachability.mjs --gate`
Expected: typecheck exit 0；gate `PASS -- no new rows`（本任務不加 export）。

- [ ] **Step 8: Commit**

```bash
git add packages/core-session/src/index.ts packages/session-persistence/src/index.ts packages/session-persistence/test/run-end-event.test.ts
git commit -m "feat(core-session,session-persistence): the durable run-end event — the record survives the load gate, and the round-trip test is the shape that catches the trap"
```

---

### Task 2: 生產者（CLI run 路徑的三個站點）

> **2026-09-22 計畫更正（執行期量測，SDD preflight）**：測試原稿的 `run` 呼叫**沒有** `--session-dir`。
> 量測（`apps/cli/src/index.ts:345-376`）顯示**協調器只在 `--session-dir` 下才接線**：沒有它 ⇒ 沒有 session
> 文件、`activeId === undefined` ⇒ 生產者**什麼都不寫**。原稿的四條正向案例會全數落空；而「resume 不寫」
> 那條**會因為錯誤的理由通過**（它會先撞上 `:336-339` 的 `--resume requires --session-dir DIR` 拒絕）。
> 更正：**每個 run 都帶 `--session-dir storeDir`**（每測一個 temp 目錄），**掃描也讀同一目錄**——
> `resolveSessionStoreRoot()` 回答的是 config home，是別的地方。
> 附帶後果（Task 4 的記錄要寫進去）：**ephemeral run（無 `--session-dir`）沒有紀錄**，這比 spec §4.1
> 原稿寫的「session 存在之前就死」更寬——它是**永不落地**的整類執行。

**Files:**
- Modify: `apps/cli/src/diagnostics-bootstrap.ts`（回傳 `runId`＋`redactor`）
- Modify: `apps/cli/src/run.ts`（`HeadlessOptions` 兩個欄位、`runStartedAt`、三個 append 站點）
- Modify: `apps/cli/src/index.ts`（`run` 命令把 `boot.runId`／`boot.redactor` 傳進 opts）
- Test: `apps/cli/test/run-end.test.ts`（新）

**Interfaces:**
- Consumes: Task 1 的 `operator/run-end` 成員；`createCliDiagnostics` 的既有回傳
- Produces: `createCliDiagnostics(...)` → `{ diagnostics, uninstall, runId: string, redactor: Redactor }`；`HeadlessOptions` 新增 `runId?: string`、`redactor?: Redactor`

- [ ] **Step 1: bootstrap 回傳 runId 與 redactor**

`diagnostics-bootstrap.ts` 的工廠內、`createDiagnostics` 之前把 runId 提出成變數，並在回傳物件加兩個欄位（`CliDiagnostics` 介面同步加 `runId: string; redactor: Redactor`；import `type { Redactor } from "@i-harness/diagnostics"`）：

```ts
  const runId = opts.runId ?? randomUUID()
  const diagnostics = createDiagnostics({ runId, redactor })
  const uninstall = installDiagnostics(diagnostics)
  return {
    diagnostics,
    runId,
    redactor,
    uninstall: () => { /* 既有內容不變 */ },
  }
```

- [ ] **Step 2: 寫紅測試（六條）**

```ts
// apps/cli/test/run-end.test.ts
// M3 §3.4 + docs/superpowers/specs/2026-09-22-operator-run-end-design.md: a run
// leaves a durable record at each PRODUCING exit (pre-assembly failure →
// `mount`, success → `run`, run failure → `run`). The resume-load-failure exit
// writes NOTHING — loadOwned failed, so no session document exists to hold it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"

const { main } = await import("../src/index.ts")

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The built-in `deepseek` profile is openai-compatible, so one SSE body is a
// whole turn — the fixture is diagnostics-bootstrap.test.ts:86/481's.
const SSE_OK = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`
// MEASURED 2026-09-22 (`apps/cli/src/index.ts:345-376`): the CLI wires the session
// coordinator ONLY under `--session-dir`. An ephemeral run has no session document,
// hence no `activeId`, and the producer writes nothing — so every run below is
// store-backed, and every assertion is about a store the test named itself.
const runArgs = (): string[] => ["node", "i-harness", "run", "hello", "--session-dir", storeDir, "--model", "deepseek:deepseek-chat", "--api-key", "sk-fixture-key-1234"]

let configDir: string
let storeDir: string
let previousConfigDir: string | undefined
const envSet: string[] = []

beforeEach(() => {
  // Hermetic config home: an EMPTY temp config dir is what keeps a run from
  // resolving a real provider (diagnostics-bootstrap.test.ts:150-160).
  configDir = mkdtempSync(join(tmpdir(), "ih-run-end-"))
  // The store the run is TOLD to use. The scan below reads exactly here —
  // `resolveSessionStoreRoot()` answers for the CONFIG HOME, a different place,
  // and reading it would find nothing.
  storeDir = mkdtempSync(join(tmpdir(), "ih-run-end-store-"))
  previousConfigDir = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = configDir
  delete process.env.I_HARNESS_LOG
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const name of envSet.splice(0)) delete process.env[name]
  if (previousConfigDir === undefined) delete process.env.IH_CONFIG_DIR
  else process.env.IH_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
  rmSync(storeDir, { recursive: true, force: true })
})

/** Every `operator/run-end` the run's own store (`--session-dir`) holds. */
async function runEndRecords(): Promise<Array<{ runId: string; exitCode: number; durationMs: number; phase: string; error?: string }>> {
  const coordinator = createSessionCoordinator(createJsonlBackend(storeDir), {})
  try {
    const out: Array<{ runId: string; exitCode: number; durationMs: number; phase: string; error?: string }> = []
    for (const id of await coordinator.list()) {
      const { session } = await coordinator.load(id)
      for (const ev of session.events) {
        if (ev.type === "operator/run-end") out.push(ev)
      }
    }
    return out
  } finally {
    await coordinator.close()
  }
}

describe("the durable run-end record (M3 §3.4)", () => {
  it("success: exit 0 · phase run · a positive durationMs and a minted runId", async () => {
    vi.stubGlobal("fetch", (async () => new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch)
    vi.spyOn(console, "log").mockImplementation(() => {})
    expect(await main(runArgs())).toBe(0)

    const records = await runEndRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ exitCode: 0, phase: "run" })
    expect(records[0]!.durationMs).toBeGreaterThan(0)
    expect(records[0]!.runId).toMatch(UUID_RE)
    expect(records[0]!.error).toBeUndefined()
  })

  it("run failure: exit 1 · phase run · the adapter's error, redacted", async () => {
    vi.stubGlobal("fetch", (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch)
    expect(await main(runArgs())).toBe(1)
    const records = await runEndRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ exitCode: 1, phase: "run" })
    expect(records[0]!.error).toContain("401")
  })

  it("pre-assembly failure: exit 1 · phase mount (an empty config home fails at model resolution)", async () => {
    // No fetch stub: the run dies before any provider call. diagnostics-bootstrap
    // .test.ts:465-469 pins the same trigger as "No model configured". Store-backed,
    // so the pre-assembly catch has a session to write the record into.
    expect(await main(["node", "i-harness", "run", "hello", "--session-dir", storeDir])).toBe(1)
    const records = await runEndRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ exitCode: 1, phase: "mount" })
  })

  it("resume of a missing session: no record — there is no document to hold one", async () => {
    // Store-backed, so this is the REAL resume-load-failure path (`run.ts:342-346`
    // returns early, before any append site) — not the `--resume`-without-store
    // refusal at `index.ts:336-339`, which would make this case pass vacuously.
    expect(await main(["node", "i-harness", "run", "hello", "--session-dir", storeDir, "--resume", "no-such-session"])).toBe(1)
    expect(await runEndRecords()).toEqual([])
  })
})

describe("the record joins the live JSONL (spec §1.3)", () => {
  it("the JSONL's `run` field equals the durable record's runId", async () => {
    process.env.I_HARNESS_LOG = "stderr"
    const chunks: string[] = []
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { chunks.push(String(chunk)); return true }) as never)
    vi.stubGlobal("fetch", (async () => new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch)
    vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      expect(await main(runArgs())).toBe(0)
    } finally {
      spy.mockRestore()
    }
    const firstLine = chunks.join("").split("\n").filter((l) => l !== "")[0]!
    const first = JSON.parse(firstLine) as { run: string }
    const records = await runEndRecords()
    expect(records[0]!.runId).toBe(first.run)
  })

  it("a registered secret in the provider's error never reaches the record", async () => {
    process.env.CORP_TOKEN = "corp-abc123"
    envSet.push("CORP_TOKEN")
    vi.stubGlobal("fetch", (async () => new Response("unauthorized: Authorization: Bearer corp-abc123", { status: 401 })) as unknown as typeof fetch)
    expect(await main(runArgs())).toBe(1)
    const records = await runEndRecords()
    expect(records[0]!.error).toBeDefined()
    expect(records[0]!.error).not.toContain("corp-abc123")
    expect(records[0]!.error).toContain("[REDACTED]")
  })
})
```

- [ ] **Step 3: 跑它，看到 RED**

Run: `pnpm --filter @i-harness/cli test run-end`
Expected: **五條紅**（案例 1、2、3、5、6）——`runEndRecords()` 回空陣列，第 5、6 條的斷言無對象。**第 4 條（resume 不寫）在 RED 階段本來就會通過**：它斷言的是「沒有紀錄」，而此刻什麼都還沒寫。那不是缺陷，是負向案例的性質——它的判別力在**實作之後**（例如有人把 append 放進 resume 的失敗分支）才生效，所以 Step 5 的突變證明不可省。

- [ ] **Step 4: 實作三站**

`run.ts`：
1. `HeadlessOptions` 加兩個欄位（含註解：`runId` 是宿主的身分、`redactor` 缺席 ⇒ 不寫 error）。
2. 在 `session/start` 發射**之外**（無條件）加 `const runStartedAt = Date.now()`。
3. 加一個 helper —— **定義在 `runHeadless` 之內**（它關閉 `session`／`activeId`／`opts`／`runStartedAt`，且必須早於 `:397` 的 `try`，三個站點才都在作用域內）：

```ts
  // M3 §3.4: the durable run-end record. Written while the coordinator is still
  // open — the success path closes it at `:748`, which is why this is NOT part
  // of `emitSessionEnd` (that funnel fires at `:778`, after the close).
  const appendRunEnd = (exitCode: number, phase: DiagnosticPhase, err?: unknown): void => {
    if (!opts.coordinator || activeId === undefined) return
    const error = err !== undefined && opts.redactor !== undefined ? fromError(err, opts.redactor).message : undefined
    append(session, {
      type: "operator/run-end", version: 1,
      runId: opts.runId ?? randomUUID(),
      exitCode, durationMs: Date.now() - runStartedAt, phase,
      ...(error !== undefined ? { error } : {}),
    })
  }
```

4. 三個站點（各自緊鄰既有的排空）：

```ts
  // ① 組裝前 catch（原 :652-655）：emitSessionEnd(1) 之後、close() 之前
      appendRunEnd(1, "mount", err)
      telemetry?.close()
      if (opts.coordinator) await opts.coordinator.close().catch(() => {})

  // ② 成功（原 :740-741）：在 flush 之前
      appendRunEnd(0, "run")
      if (opts.coordinator) {
        if (activeId) await opts.coordinator.flush(activeId)
      }

  // ③ run 失敗 catch（原 :782-784）：emitSessionEnd(1) 之後、close() 之前
      appendRunEnd(1, "run", err)
      telemetry?.close()
      if (opts.coordinator) await opts.coordinator.close().catch(() => {})
```

5. import：`append` 自 `@i-harness/core-session`、`fromError` 自 `@i-harness/diagnostics`、`randomUUID` 自 `node:crypto`、`type { DiagnosticPhase }` 自 `@i-harness/diagnostics`（`DiagnosticPhase` 的賦值就是 §1.1 說的編譯期漂移檢查）。

`index.ts`（`run` 命令）：`const boot = createCliDiagnostics()` 之後加 `opts.runId = boot.runId; opts.redactor = boot.redactor`。

- [ ] **Step 5: 跑它，GREEN＋突變證明**

Run: `pnpm --filter @i-harness/cli test run-end` → 6/6。
**突變**：把成功站點的 `appendRunEnd(0, "run")` 刪掉 ⇒ 第 1 條紅、其餘仍綠；把 `coordinator.close()` 之前的 append 移到 `emitSessionEnd` 內（即失敗站點改在 close 後 append）⇒ 第 2 條紅。逐條回退、`sha` 驗檔。
再跑 `pnpm --filter @i-harness/cli test`（全套餐）——預期既有案例全綠（量過：`runHeadless` 的 85 個測試呼叫端沒有一條斷言精確事件序列，`cli.test.ts:2098` 用 `toContain`、`:1024` 用 `toBeGreaterThan`）。

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/diagnostics-bootstrap.ts apps/cli/src/run.ts apps/cli/src/index.ts apps/cli/test/run-end.test.ts
git commit -m "feat(cli): the run path leaves a durable record — three sites beside the existing drains, a redacted error, and the runId the live JSONL already carries"
```

---

### Task 3: 表面（`sessions list` ＋ `sessions show`）

> **2026-09-22 執行期裁定（R9，計畫內部衝突）**：`apps/cli/test/sessions.test.ts:126` 的既有斷言
> `expect(lines[0]).toMatch(/^ID\s+TITLE\s+TURNS\s+UPDATED$/)` 是**錨定的（`$`）**，新增欄位必然打破它。
> 它**必須**隨新欄更新為 `/^ID\s+TITLE\s+TURNS\s+UPDATED\s+LAST RUN$/`——這是本單元**唯一**被改動的既有斷言
> （已量測：`ID/TITLE/TURNS/UPDATED` 的字串只在 `test/sessions.test.ts:126` 被斷言）。
> 這與 Global Constraints「既有測試案例一條不改」**表面**衝突；該條的**意圖**是「不得為了讓新碼通過而**弱化**既有測試」，
> 而這裡是**設計刻意改變了格式**，釘住格式的斷言隨之更新——**只改這一條**，且不得改動它的意圖（欄位對齊與欄序）。
> 同檔 `:113` 的 doc comment 也列了欄名，一起更新（那是 src，不受此限）。

**Files:**
- Modify: `apps/cli/src/sessions.ts`
- Test: `apps/cli/test/sessions.test.ts`（**追加**案例到檔尾；既有案例不動）

**Interfaces:**
- Consumes: Task 1 的事件、Task 2 的記錄
- Produces: `StoredSessionRow.lastRun?: { exitCode: number; durationMs: number; error?: string }`；`formatLastRun(lastRun): string`

- [ ] **Step 1: 追加紅測試**

在 `apps/cli/test/sessions.test.ts` 檔尾追加：

```ts
describe("sessions — the durable run-end record (M3 §3.4)", () => {
  it("list renders ok / failed / — and the transcript renders the run-end line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ih-sessions-run-end-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
    try {
      const ok = await coordinator.create({})
      const failed = await coordinator.create({})
      const older = await coordinator.create({})
      const logOk = createSession()
      append(logOk, { type: "turn/start" })
      append(logOk, { type: "turn/end" })
      append(logOk, { type: "operator/run-end", version: 1, runId: "r-ok", exitCode: 0, durationMs: 1200, phase: "run" })
      const logFailed = createSession()
      append(logFailed, { type: "turn/start" })
      append(logFailed, { type: "turn/end" })
      append(logFailed, { type: "operator/run-end", version: 1, runId: "r-bad", exitCode: 1, durationMs: 400, phase: "run", error: "boom" })
      const logOlder = createSession()
      append(logOlder, { type: "turn/start" })
      append(logOlder, { type: "turn/end" })
      coordinator.enqueue(ok.id, logOk.events)
      coordinator.enqueue(failed.id, logFailed.events)
      coordinator.enqueue(older.id, logOlder.events)
      await coordinator.flush(ok.id)
      await coordinator.flush(failed.id)
      await coordinator.flush(older.id)

      const rows = await listStoredSessions(coordinator, dir)
      const table = renderSessionTable(rows, Date.now())
      expect(table.split("\n")[0]).toContain("LAST RUN")
      expect(table).toContain("ok 1.2s")
      expect(table).toContain("failed exit 1 0.4s")
      expect(table.split("\n").find((line) => line.startsWith(older.id))).toContain("—")

      const { session } = await coordinator.load(failed.id)
      expect(renderTranscript(session, 20)).toContain("run end: exit 1 · 0.4s — boom")
    } finally {
      await coordinator.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("two records for one run: the LAST one is what the row shows", async () => {
    // The success path appends exit 0 BEFORE the durable flush; when that flush
    // rejects, the run-failure catch appends exit 1, and the write-behind retains
    // the failed batch so close() drains both. The reader's contract is
    // **last wins** — the later record is the exit that actually happened.
    const dir = mkdtempSync(join(tmpdir(), "ih-sessions-run-end-twice-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
    try {
      const { id } = await coordinator.create({})
      const log = createSession()
      append(log, { type: "turn/start" })
      append(log, { type: "operator/run-end", version: 1, runId: "r-twice", exitCode: 0, durationMs: 800, phase: "run" })
      append(log, { type: "operator/run-end", version: 1, runId: "r-twice", exitCode: 1, durationMs: 900, phase: "run", error: "durable write failed" })
      coordinator.enqueue(id, log.events)
      await coordinator.flush(id)

      const rows = await listStoredSessions(coordinator, dir)
      expect(rows[0]!.lastRun).toMatchObject({ exitCode: 1, durationMs: 900 })
      expect(formatLastRun(rows[0]!.lastRun)).toBe("failed exit 1 0.9s")
      const { session } = await coordinator.load(id)
      expect(renderTranscript(session, 20)).toContain("run end: exit 1 · 0.9s — durable write failed")
    } finally {
      await coordinator.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

（`formatLastRun` 的契約：`undefined` ⇒ `"—"`；否則 `` `${exitCode === 0 ? "ok" : `failed exit ${exitCode}`} ${(durationMs / 1000).toFixed(1)}s` ``。測試檔需要的 import：`listStoredSessions`、`renderSessionTable`、`renderTranscript`、`formatLastRun` 自 `../src/sessions.ts`，`createSessionCoordinator`／`createJsonlBackend`／`createSession`／`append` 照 Task 1 測試的形狀。）

- [ ] **Step 2: 跑它，看到 RED**

Run: `pnpm --filter @i-harness/cli test sessions`
Expected: **兩條都紅**——`formatLastRun is not a function`／`lastRun` 欄位不存在，且表頭沒有 `LAST RUN`。

- [ ] **Step 3: 實作**

`sessions.ts`：
1. `StoredSessionRow` 加 `lastRun?: { exitCode: number; durationMs: number; error?: string }`。
2. `listStoredSessions` 既有的 `coordinator.load(id)` 掃描裡（`turnCount` 旁）取**最後一個** `operator/run-end`：

```ts
      try {
        const { session } = await coordinator.load(id)
        row.turnCount = session.events.filter((ev) => ev.type === "turn/start").length
        // M3 §3.4: the same full-log read the turn count already pays for.
        // LAST one wins: a run whose success `flush` rejected carries TWO records
        // (exit 0 appended before the flush, exit 1 appended by the failure catch)
        // and the later one is the exit that actually happened. Keep `.at(-1)`.
        const last = session.events.filter((ev) => ev.type === "operator/run-end").at(-1)
        if (last !== undefined) {
          row.lastRun = { exitCode: last.exitCode, durationMs: last.durationMs, ...(last.error !== undefined ? { error: last.error } : {}) }
        }
      } catch (error) { /* 既有 */ }
```

3. 新 export `formatLastRun(lastRun): string` ⇒ `lastRun === undefined ? "—" : `${lastRun.exitCode === 0 ? "ok" : "failed exit " + lastRun.exitCode} ${(lastRun.durationMs / 1000).toFixed(1)}s``。
4. `renderSessionTable` 的表頭與每列各加一欄（`LAST RUN`，寬度照 `turnsOf` 的既有做法）。
5. `transcriptLine` 加：

```ts
    case "operator/run-end":
      return `── run end: exit ${ev.exitCode} · ${(ev.durationMs / 1000).toFixed(1)}s${ev.error !== undefined ? ` — ${ev.error}` : ""}`
```

- [ ] **Step 4: 跑它，GREEN＋全套餐**

Run: `pnpm --filter @i-harness/cli test sessions` → PASS；再 `pnpm --filter @i-harness/cli test` 全綠（**既有案例不動**）。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/sessions.ts apps/cli/test/sessions.test.ts
git commit -m "feat(cli): sessions list and show read the durable run-end — a LAST RUN column, the transcript line, and an honest dash for sessions older than the record"
```

---

### Task 4: 收尾（閘門＋記錄）

**Files:**
- Modify: `docs/handoff/2026-09-20-queued-work.md`（C1 列）
- Modify: `docs/superpowers/specs/2026-09-17-m3-measurement-foundation-design.md`（§3.4 加 dated 落地註記）
- Modify: `docs/superpowers/specs/2026-09-22-operator-run-end-design.md`（§4 加一條新的「不保證」）

- [ ] **Step 1: `pnpm verify:all`**（母體 67；五步全綠；`--gate` 不得新增 row）——若 suite 紅在負載 flake，隔離跑該套件、兩個讀數都記。

- [ ] **Step 2: 記錄**
1. queue doc `:950` 的 C1 列 → **✅ 完成**，附提交區間與一句「§3.4 落地」＋它現在的消費面（`sessions list`／`show`）。
2. **本單元自己的 spec**（`docs/superpowers/specs/2026-09-22-operator-run-end-design.md`）§4「它不保證什麼」加第 5 條：**一次 durable 寫入失敗的 run 可能有兩筆 `operator/run-end`**（成功站點在 flush 前寫的 `exit 0`，與失敗 catch 寫的 `exit 1`；write-behind 保留失敗批次，`close()` best-effort 排空，兩筆都可能落地）。**讀取端的契約是最後一筆為準**——`listStoredSessions` 的 `.at(-1)`，Task 3 的測試釘住它。這條是 T2 複審的 Important 發現（labeled plan-mandated），裁定寫在 ledger R7。
3. M3 spec `:197-213` 的 §3.4 旁加 dated 註記：實作落點與**三處與原稿不同**的量測事實（生產者是三站不是漏斗；完成定義的「失敗那一行」取在 `sessions show`；**紀錄只存在於 store-backed 的執行**——協調器只在 `--session-dir` 下接線，`apps/cli/src/index.ts:345-376`，所以無 store 的 `i-harness run` 一律不留紀錄，這比 §4.1 原稿的「session 存在之前就死」更寬）。行號寫入前重量。

- [ ] **Step 3: Commit**

```bash
git add docs/handoff/2026-09-20-queued-work.md docs/superpowers/specs/2026-09-17-m3-measurement-foundation-design.md docs/superpowers/specs/2026-09-22-operator-run-end-design.md
git commit -m "docs(queue,spec): §3.4 lands — the orphan row closes, and the record says which three facts moved from the original sketch"
```

> **2026-09-22 執行期更正（控制器）**：原稿的 `git add` **漏了第三個檔**（本單元自己的 spec），而 Step 2 已要求改它；提交訊息也還寫著「two facts」，但 Step 2 第 3 條列的是**三**條。兩處都已在上面更正。另：Step 2 所有出現的行號（queue doc 的 C1 列、M3 spec 的 §3.4）**寫入前先重量**——遷移到私人電腦後工作區是全新的 checkout，舊行號一律視為已腐。
