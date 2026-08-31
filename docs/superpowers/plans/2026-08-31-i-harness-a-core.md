# A-Region (Engine Core) M26 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-shot `runHeadless` into a drivable, resumable, parallel-capable agent runtime: persisted input tiers + per-session serial executor (R-A1/R-A2), dynamic system context with instructions loading (R-A4/R-A5), LLM session titles (R-A6), plan mode (R-A7), and a fail-closed auto-approval guardian reviewer (R-A9) — all on the existing core-session log, coordinator, and subagent machinery.

**Architecture:** All state stays event-sourced on the existing session log (new additive event types, `CURRENT_FORMAT_VERSION` stays 1) and mirrors through the existing `SessionCoordinator` write-behind. Input tiers are a durable inbox projection (`agent/input/admitted|promoted|cancelled`, dsh-inbox / opencode-admit→promote→cancel ladder re-implemented in i-harness vocabulary); a per-session `SessionExecutor` provides the serial lane (one turn at a time per session, many executors run in parallel via a registry). Runtime context renders dynamic sections and appends a snapshot **user/message** into the log only when the rendered text changed (dsh `form:snapshot` mechanism; instructions load as one of the sections — the roadmap's requirement that the change be model-visible and replayable is met by the log snapshot itself). Titles and plan-mode are log-only events + pure projections (dsh `session/title`, `plan/mode`). The guardian is a reviewer subagent driven by the existing `spawnChild` machinery with a dedicated `reviewer` role, strict JSON contract, 90s timeout→deny, and a 3-deny-per-10-of-last sliding-window circuit breaker persisted through a coordinator document (codex guardian concept, re-implemented).

**Tech Stack:** TypeScript strict ESM (`type: "module"`, `.ts` source exports, pnpm workspaces, vitest). `node:crypto` uuid only. **Zero new external dependencies.**

**Spec:** `docs/roadmap/2026-08-31-roadmap-A-core.md` (§2/§3 取捨表: R-A1, R-A2, R-A4, R-A5, R-A6, R-A7, R-A9 are **M26 立即**; R-A3, R-A8 are **後補** — not in this plan; R-A10, R-A11 are **遠期** — not in this plan.)

## Global Constraints

- **Zero new external deps.** All packages use `workspace:*` deps on existing `@i-harness/*` packages only.
- ESM + strict TS (`noUnusedLocals`, `noUnusedParameters` — see `tsconfig.base.json`); tests under `<package>/test/*.test.ts` per package, vitest; new package version `0.1.0`; **no version bumps on existing packages**.
- New event types are **exactly the 5 added here**: `agent/input/admitted`, `agent/input/promoted`, `agent/input/cancelled`, `session/title`, `plan/mode` — plus their `registerEventType` registrations in session-persistence's module-init block (M19 pattern). `CURRENT_FORMAT_VERSION` stays 1.
- **core-session stays dependency-free** (leaf package): everything it adds uses only `node` types; never import `@i-harness/*` into it.
- **Fail-closed**: guardian timeout/parse-failure/open-breaker ⇒ deny; absent approval answerer ⇒ deny (existing F05-5); input admission throws on duplicate/malformed identity; coordinator conflicts propagate.
- **Behavior unchanged when unconfigured**: every new seam (`stepInputs`, `approval/guardian`, runtime-context, titles, plan tools, guardian) is optional/absent ⇒ byte-identical prior behavior.
- Windows-first: only `node:path/fs/os` path handling; no POSIX-only assumptions.
- Commits on branch **m26** (already checked out), one commit per task, message style `feat(pkg): ...` + `Co-Authored-By: Claude Code <noreply@anthropic.com>` trailer in the commit body.
- `pnpm install` at repo root after each new package's `package.json` is written (Step 1 of each new-package task).

## Deferred (one-line notes — do NOT implement)

- **R-A3 (crash-recovery repair chain): 後補** — torn-tail closers + missing tool-result synthesis; wait for A1's persisted inputs, then build from `session-persistence`'s existing torn-tail repair.
- **R-A8 (`get_context_remaining` model tool): 後補** — token-meter already exposes `checkBudget`/`activeTokens`; just needs a model tool consuming them.
- **R-A10 (memories) / R-A11 (context rollover): 遠期** — product shape and model multi-window capability not settled.

## Task Ordering (dependency notes)

```
R-A1: T1 (events) → T2 (Inbox projection) → T3 (loop steer seam) → T5 (CLI wiring)
R-A2: T4 (SessionExecutor + registry — reuses T1/T2 structures)
R-A4: T6 (runtime-context)   R-A5: T7 (instructions — plugs into T6's sections) → T8 (CLI)
R-A6: T9 (title event) → T10 (title package + CLI)
R-A7: T11 (plan/mode event) → T12 (plan-mode package + CLI)
R-A9: T13 (core-tools guardian seam) → T14 (verdict parser + circuit breaker) → T15 (reviewer + registerGuardian) → T16 (CLI)
```

---

## File Structure Map

**Modified packages:**
- `packages/core-session/src/index.ts` — event union +3 +1 +1 types, deriveSearchText note, re-exports `./inbox.ts`.
- `packages/core-session/src/inbox.ts` — **new**: durable input inbox (admit / promote / cancel / pending / claimAtStepBoundary).
- `packages/session-persistence/src/index.ts` — module-init `registerEventType` for the 5 new event types (M19 pattern, lines 103-136).
- `packages/core-agent/src/index.ts` — `AgentDeps.stepInputs` seam + call site in `runTurn`; re-exports `./executor.ts`.
- `packages/core-agent/src/executor.ts` — **new**: `SessionExecutor` (serial per-session lane) + `SessionExecutorRegistry`.
- `packages/core-tools/src/index.ts` — `GuardianRequest`/`GuardianVerdict`/`ApprovalGuardian` types + guardian consult in the `prepare` ask branch (lines 233-247).
- `apps/cli/src/run.ts` — wire executor + `session/*` commands, runtime-context + instructions sections, auto-title, plan mode option, guardian mount.

**New packages:**
- `packages/runtime-context/` — dynamic system context sections + snapshot messages (`createRuntimeContext`, `installRuntimeContext`).
- `packages/instructions/` — AGENTS.md/CLAUDE.md discovery (global → parent → workspace), render, change-cached section getter.
- `packages/session-title/` — title fallback + LLM provider + `applyTitle`/`maybeAutoTitle` + coordinator doc mirror.
- `packages/plan-mode/` — `enterPlanMode`/`exitPlanMode`/`createPlanModeTools` + prompt fragment.

**guard-approval guardian module (inside existing package):**
- `packages/guard-approval/src/guardian/verdict.ts` — strict JSON contract + `parseGuardianAssessment`.
- `packages/guard-approval/src/guardian/breaker.ts` — sliding-window circuit breaker + state doc shape/guard.
- `packages/guard-approval/src/guardian/reviewer.ts` — reviewer role + `BUNDLED_GUARDIAN_POLICY` + `runGuardianReview` (spawnChild-based, timeout→deny).
- `packages/guard-approval/src/guardian/index.ts` — `registerGuardian` (mounts `approval/guardian` service).
- `packages/guard-approval/src/index.ts` — re-export the guardian surface.

**Existing test conventions to match:** `createMockClient` from `@i-harness/llm-mock` (one-shot cassette), `createContext` from `@i-harness/core-plugin`, `createToolRegistry(ctx)`, `createSessionCoordinator(createJsonlBackend(dir))` for persistence round-trips, subagent harness from `subagent/test/register.test.ts`.

---

### Task 1: core-session input-tier event types + session-persistence registration

**Files:**
- Modify: `packages/core-session/src/index.ts` (SessionEvent union)
- Modify: `packages/session-persistence/src/index.ts` (registerEventType block)
- Test: `packages/core-session/test/input-event.test.ts` (new)
- Test: `packages/session-persistence/test/input-persistence.test.ts` (new)

**Interfaces:**
- Consumes: existing `SessionEvent` union conventions (additive members, `seq?: number`, append assigns seq).
- Produces (Tasks 2, 4, 5): the three event members below. Dropped-down naming: no `messageSeq` on `promoted` — the durable log ordering IS the pairing (the `user/message` appended at promotion/turn-start follows the marker in the same log).

- [ ] **Step 1: Write the failing event-shape test**

`packages/core-session/test/input-event.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, deriveSearchText } from "../src/index.ts"

describe("agent/input/* events", () => {
  it("appends admitted with a seq and round-trips its fields", () => {
    const s = createSession()
    append(s, {
      type: "agent/input/admitted", version: 1, inputId: "in-1", text: "do the thing",
      delivery: "queue", intent: "user",
    })
    const ev = s.events.at(-1)!
    expect(ev.type).toBe("agent/input/admitted")
    expect(ev.seq).toBe(0)
    expect((ev as { inputId: string }).inputId).toBe("in-1")
  })

  it("admits synthetic steers and cancelled markers", () => {
    const s = createSession()
    append(s, {
      type: "agent/input/admitted", version: 1, inputId: "in-2",
      text: "switch to git branch main", delivery: "steer", intent: "system",
      synthetic: { description: "git branch changed", scope: "turn" },
    })
    append(s, { type: "agent/input/cancelled", version: 1, inputId: "in-3", reason: "user dismissed" })
    expect(s.events).toHaveLength(2)
  })

  it("keeps input events out of deriveMessages (log-only) and out of search text", () => {
    const s = createSession()
    append(s, { type: "agent/input/admitted", version: 1, inputId: "in-1", text: "secret queue text", delivery: "queue", intent: "user" })
    append(s, { type: "user/message", text: "hi" })
    expect(deriveMessages(s).map((m) => m.content)).toEqual(["hi"])
    expect(deriveSearchText(s.events[0]!)).toBe("")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @i-harness/core-session test`
Expected: FAIL — the union has no `agent/input/admitted` member (TS error) / event type not assignable.

- [ ] **Step 3: Implement the union members**

In `packages/core-session/src/index.ts`, inside the `SessionEvent` union (after the `todo/write` member, line ~44, before the trailing `& { ignorable?: true }`):

```ts
    // R-A1 input tiers: durable inbox ladder (dsh agent/inbox/spliced +
    // opencode admit→promote→cancel re-implemented in i-harness vocabulary).
    // `admitted` is the durable enqueue; `promoted` marks consumption (the
    // consuming user/message follows in the same log — an active turn's
    // user/message is appended by the agent loop, an idle turn's by the
    // executor's agent.run); `cancelled` retracts a never-promoted input.
    // All three are log-only (never model-visible; the text enters the model
    // surface only through the promoted user/message). version 1 (M19/M21
    // convention for structured new event slots).
    | { type: "agent/input/admitted"; version: 1; inputId: string; text: string; delivery: "queue" | "steer"; intent: "user" | "system"; synthetic?: { description: string; scope: "turn" | "session" }; seq?: number }
    | { type: "agent/input/promoted"; version: 1; inputId: string; seq?: number }
    | { type: "agent/input/cancelled"; version: 1; inputId: string; reason?: string; seq?: number }
```

- [ ] **Step 4: Run again to verify it passes**

Run: `pnpm --filter @i-harness/core-session test`
Expected: PASS (all 3 tests; existing session/subscribe/todo tests unaffected).

- [ ] **Step 5: Write the persistence round-trip test**

`packages/session-persistence/test/input-persistence.test.ts` (models `todo-persistence.test.ts`):

```ts
import { describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("agent/input persist round-trip (registerEventType gate)", () => {
  it("admits the three input events through the load gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-input-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
      const { id } = await coordinator.create({})
      coordinator.enqueue(id, [
        { type: "agent/input/admitted", version: 1, inputId: "in-1", text: "t", delivery: "queue", intent: "user" },
        { type: "agent/input/promoted", version: 1, inputId: "in-1" },
        { type: "agent/input/cancelled", version: 1, inputId: "in-9", reason: "x" },
      ])
      await coordinator.flush(id)
      const loaded = await coordinator.load(id)
      expect(loaded.session.events.map((e) => e.type)).toEqual([
        "agent/input/admitted", "agent/input/promoted", "agent/input/cancelled",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @i-harness/session-persistence test`
Expected: FAIL with `unknown event type 'agent/input/admitted' without ignorable marker` (the load gate).

- [ ] **Step 7: Register the new types at session-persistence module init**

In `packages/session-persistence/src/index.ts`, after the M21 `todo/write` registration (line ~136):

```ts
// R-A1 input tiers (agent/input/admitted|promoted|cancelled) — same
// reasoning as above: only this package loads on a plain persistence-only
// path, so without registration guardIgnorable would refuse the types.
registerEventType("agent/input/admitted")
registerEventType("agent/input/promoted")
registerEventType("agent/input/cancelled")
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm --filter @i-harness/session-persistence test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core-session/src/index.ts packages/core-session/test/input-event.test.ts packages/session-persistence/src/index.ts packages/session-persistence/test/input-persistence.test.ts
git commit -m "feat(core-session): R-A1 input-tier events (admitted/promoted/cancelled)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: core-session `Inbox` durable mailbox projection

**Files:**
- Create: `packages/core-session/src/inbox.ts`
- Modify: `packages/core-session/src/index.ts` (re-export)
- Test: `packages/core-session/test/inbox.test.ts` (new)

**Interfaces:**
- Consumes: `SessionEvent` members from Task 1; `Session`, `append`, `subscribe` from `./index.ts`; `randomUUID` from `node:crypto` (only in Task 4's executor, not here — the Inbox takes ids as arguments).
- Produces (Tasks 3, 4, 5):

```ts
export type InputDelivery = "queue" | "steer"
export type InputIntent = "user" | "system"
export interface InputSynthetic { description: string; scope: "turn" | "session" }
export interface AdmittedInput {
  inputId: string
  text: string
  delivery: InputDelivery
  intent: InputIntent
  synthetic?: InputSynthetic
}
export interface PendingInput extends AdmittedInput { admittedSeq: number }
export class Inbox {
  constructor(session: Session, fromSeq?: number)
  admit(input: AdmittedInput): number
  promote(inputId: string): boolean
  cancel(inputId: string, reason?: string): boolean
  pending(): PendingInput[]
  isPending(inputId: string): boolean
  claimAtStepBoundary(): void
}
```

- [ ] **Step 1: Write the failing inbox tests**

`packages/core-session/test/inbox.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages } from "../src/index.ts"
import { Inbox, type PendingInput } from "../src/inbox.ts"

function collect(s: ReturnType<typeof createSession>, type: string): Record<string, unknown>[] {
  return s.events.filter((e) => e.type === type) as Record<string, unknown>[]
}

describe("Inbox", () => {
  it("admit → pending admits-ordered; promote consumes; cancel retracts", () => {
    const s = createSession()
    const inbox = new Inbox(s)
    inbox.admit({ inputId: "a", text: "one", delivery: "queue", intent: "user" })
    inbox.admit({ inputId: "b", text: "two", delivery: "queue", intent: "user" })
    expect(inbox.pending().map((p: PendingInput) => p.inputId)).toEqual(["a", "b"])
    expect(inbox.promote("a")).toBe(true)
    expect(inbox.pending().map((p) => p.inputId)).toEqual(["b"])
    expect(inbox.cancel("b", "user dismissed")).toBe(true)
    expect(inbox.pending()).toEqual([])
    expect(inbox.promote("a")).toBe(false) // already promoted
    expect(inbox.cancel("zzz")).toBe(false) // unknown
  })

  it("marks the consumed input with a promoted event before the turn's user/message", () => {
    const s = createSession()
    const inbox = new Inbox(s)
    inbox.admit({ inputId: "a", text: "task text", delivery: "queue", intent: "user" })
    expect(inbox.promote("a")).toBe(true)
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: "task text" })
    const types = s.events.map((e) => e.type)
    const promoted = types.findIndex((t) => t === "agent/input/promoted")
    const user = types.findIndex((t) => t === "user/message")
    expect(promoted).toBeLessThan(user)
  })

  it("claimAtStepBoundary promotes ALL pending steers in admission order", () => {
    const s = createSession()
    const inbox = new Inbox(s)
    inbox.admit({ inputId: "s1", text: "steer one", delivery: "steer", intent: "user" })
    inbox.admit({ inputId: "q", text: "queued, not claimed", delivery: "queue", intent: "user" })
    inbox.admit({ inputId: "s2", text: "steer two", delivery: "steer", intent: "user" })
    inbox.claimAtStepBoundary()
    const promoted = collect(s, "agent/input/promoted")
    expect(promoted.map((p) => p.inputId)).toEqual(["s1", "s2"])
    expect(inbox.pending().map((p) => p.inputId)).toEqual(["q"])
    const visible = collect(s, "user/message").map((m) => (m as { text: string }).text)
    expect(visible).toEqual(["steer one", "steer two"])
    // the promoted user/messages ARE model-visible
    expect(deriveMessages(s).filter((m) => m.role === "user").map((m) => m.content)).toEqual(["steer one", "steer two"])
  })

  it("system intent appends source-marked user/message at claim time", () => {
    const s = createSession()
    const inbox = new Inbox(s)
    inbox.admit({
      inputId: "i", text: "branch is now main", delivery: "steer", intent: "system",
      synthetic: { description: "git branch changed", scope: "turn" },
    })
    inbox.claimAtStepBoundary()
    const msg = s.events.at(-1) as { source?: unknown }
    expect(msg.source).toEqual({ kind: "plugin", plugin: "i-harness/system-input" })
  })

  it("replays pending from the log on construction (resume recovery)", () => {
    const s = createSession()
    const first = new Inbox(s)
    first.admit({ inputId: "p1", text: "still pending", delivery: "queue", intent: "user" })
    first.admit({ inputId: "p2", text: "consumed", delivery: "queue", intent: "user" })
    expect(first.promote("p2")).toBe(true)
    const again = new Inbox(s)
    expect(again.pending().map((p) => p.inputId)).toEqual(["p1"])
  })

  it("throws on duplicate pending id and malformed admission", () => {
    const s = createSession()
    const inbox = new Inbox(s)
    inbox.admit({ inputId: "a", text: "one", delivery: "queue", intent: "user" })
    expect(() => inbox.admit({ inputId: "a", text: "two", delivery: "queue", intent: "user" })).toThrow(/already pending/)
    expect(() => inbox.admit({ inputId: "b", text: "", delivery: "queue", intent: "user" })).toThrow(/text/)
    expect(() => inbox.admit({ inputId: "c", text: "x", delivery: "instant", intent: "user" } as never)).toThrow(/delivery/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @i-harness/core-session test`
Expected: FAIL — `../src/inbox.ts` does not exist.

- [ ] **Step 3: Implement `inbox.ts`**

`packages/core-session/src/inbox.ts`:

```ts
import { append } from "./index.ts"
import type { Session } from "./index.ts"

export type InputDelivery = "queue" | "steer"
export type InputIntent = "user" | "system"
export interface InputSynthetic { description: string; scope: "turn" | "session" }

export interface AdmittedInput {
  inputId: string
  text: string
  delivery: InputDelivery
  intent: InputIntent
  synthetic?: InputSynthetic
}

export interface PendingInput extends AdmittedInput { admittedSeq: number }

/** Source marker on promoted system-intent user/messages. */
export const SYSTEM_INPUT_PLUGIN = "i-harness/system-input"

interface EventWithSeq { type: string; seq?: number }

// R-A1 durable input mailbox: a replay-once projection over
// `agent/input/admitted|promoted|cancelled` (dsh Inbox / opencode
// admit→promote→cancel ladder, re-implemented). All mutation goes through
// session-log appends, so persistence is the log's own (coordinator mirror
// onAppend hook) and a cold resume rebuilds pending from the log alone.
export class Inbox {
  private readonly fromSeq: number

  constructor(private readonly session: Session, fromSeq = 0) {
    this.fromSeq = fromSeq
  }

  /**
   * Durably enqueue an input. Throws on a duplicate currently-pending id or a
   * malformed admission (fail-closed — a bad input can never sit silently in
   * the queue). Returns the admitted event's seq.
   */
  admit(input: AdmittedInput): number {
    validateAdmitted(input)
    if (this.isPending(input.inputId)) {
      throw new Error(`agent/input admitted with duplicate pending id: ${input.inputId}`)
    }
    append(this.session, {
      type: "agent/input/admitted",
      version: 1,
      inputId: input.inputId,
      text: input.text,
      delivery: input.delivery,
      intent: input.intent,
      ...(input.synthetic !== undefined ? { synthetic: input.synthetic } : {}),
    })
    return this.session.events.at(-1)!.seq!
  }

  /** Mark an admitted input consumed (append-only marker; the turn's user/
   *  message follows in the log). Returns false when not pending. */
  promote(inputId: string): boolean {
    const me = this.admittedEvent(inputId)
    if (me === undefined) return false
    append(this.session, { type: "agent/input/promoted", version: 1, inputId })
    return true
  }

  /** Retract a never-promoted input. Returns false when not pending. */
  cancel(inputId: string, reason?: string): boolean {
    const me = this.admittedEvent(inputId)
    if (me === undefined) return false
    append(this.session, {
      type: "agent/input/cancelled", version: 1, inputId,
      ...(reason !== undefined ? { reason } : {}),
    })
    return true
  }

  /** Pending inputs in admission order (all deliveries, both intents). */
  pending(): PendingInput[] {
    const consumed = new Set<string>()
    for (const ev of this.session.events) {
      if (ev.type === "agent/input/promoted" || ev.type === "agent/input/cancelled") {
        consumed.add((ev as { inputId: string }).inputId)
      }
    }
    const result: PendingInput[] = []
    for (const ev of this.session.events) {
      if (ev.type !== "agent/input/admitted") continue
      if ((ev.seq ?? 0) < this.fromSeq) continue
      const a = ev as unknown as { inputId: string; text: string; delivery: InputDelivery; intent: InputIntent; synthetic?: InputSynthetic }
      if (consumed.has(a.inputId)) continue
      result.push({
        inputId: a.inputId, text: a.text, delivery: a.delivery, intent: a.intent,
        ...(a.synthetic !== undefined ? { synthetic: a.synthetic } : {}),
        admittedSeq: ev.seq ?? 0,
      })
    }
    return result
  }

  isPending(inputId: string): boolean {
    return this.pending().some((p) => p.inputId === inputId)
  }

  /**
   * Agent-loop step-boundary seam (provider boundary): promote every pending
   * STEER in admission order, appending its model-visible user/message. Called
   * at the start of each step so mid-turn steering reaches the model before
   * the next provider call.
   */
  claimAtStepBoundary(): void {
    for (const p of this.pending().filter((i) => i.delivery === "steer")) {
      append(this.session, { type: "agent/input/promoted", version: 1, inputId: p.inputId })
      append(this.session, {
        type: "user/message",
        text: p.text,
        ...(p.intent === "system"
          ? { source: { kind: "plugin" as const, plugin: SYSTEM_INPUT_PLUGIN } }
          : {}),
      })
    }
  }

  private admittedEvent(inputId: string): EventWithSeq | undefined {
    return this.session.events.find(
      (ev) => ev.type === "agent/input/admitted" && (ev as { inputId: string }).inputId === inputId,
    )
  }
}

function validateAdmitted(input: AdmittedInput): void {
  if (typeof input.inputId !== "string" || input.inputId.length === 0) throw new Error("agent/input admitted: inputId must be a non-empty string")
  if (typeof input.text !== "string" || input.text.length === 0) throw new Error("agent/input admitted: text must be a non-empty string")
  if (input.delivery !== "queue" && input.delivery !== "steer") throw new Error(`agent/input admitted: invalid delivery '${String(input.delivery)}'`)
  if (input.intent !== "user" && input.intent !== "system") throw new Error(`agent/input admitted: invalid intent '${String(input.intent)}'`)
  if (input.synthetic !== undefined) {
    if (typeof input.synthetic.description !== "string" || input.synthetic.description.length === 0) {
      throw new Error("agent/input admitted: synthetic.description must be a non-empty string")
    }
    if (input.synthetic.scope !== "turn" && input.synthetic.scope !== "session") {
      throw new Error(`agent/input admitted: invalid synthetic.scope '${String(input.synthetic.scope)}'`)
    }
  }
}
```

Note: the `user/message` append in `claimAtStepBoundary` uses the EXISTING `source?: { kind: "plugin"; plugin: string }` field (M1) — no union change needed for attribution; `agent/input/*` appends type-check directly against the Task 1 union members (no casts).

- [ ] **Step 4: Re-export from index.ts**

In `packages/core-session/src/index.ts` (top of file):

```ts
export { Inbox, SYSTEM_INPUT_PLUGIN } from "./inbox.ts"
export type { AdmittedInput, PendingInput, InputDelivery, InputIntent, InputSynthetic } from "./inbox.ts"
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @i-harness/core-session test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core-session/src/inbox.ts packages/core-session/src/index.ts packages/core-session/test/inbox.test.ts
git commit -m "feat(core-session): R-A1 durable Inbox projection (admit/promote/cancel/claim)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: core-agent step-boundary steer seam

**Files:**
- Modify: `packages/core-agent/src/index.ts` (`AgentDeps` + `runTurn`)
- Test: `packages/core-agent/test/step-inputs.test.ts` (new)

**Interfaces:**
- Consumes: `Session` append semantics; the `Inbox.claimAtStepBoundary()` contract from Task 2 (the seam is interface-typed so core-agent never imports the class method beyond the interface).
- Produces (Tasks 4, 5): `AgentDeps.stepInputs?: { claimAtStepBoundary(): void }`.

- [ ] **Step 1: Write the failing test**

`packages/core-agent/test/step-inputs.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, append } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgent } from "../src/index.ts"

describe("stepInputs seam", () => {
  it("claims steers at the first step boundary (before the first provider call)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const claimedAt: number[] = []
    const model = createMockClient([
      { role: "assistant", text: "start" },
      { role: "assistant", text: "after steer" },
    ])
    const agent = createAgent(ctx, {
      session, tools, model, systemPrompt: "p",
      stepInputs: {
        claimAtStepBoundary() {
          append(session, { type: "user/message", text: "steered now" })
          claimedAt.push(session.events.length)
        },
      },
    })
    await agent.run("first")
    // the steer message was appended between turn/start and the final turn/end
    const types = session.events.map((e) => e.type)
    expect(types.indexOf("user/message", 1)).toBeGreaterThan(1)
    expect(claimedAt.length).toBeGreaterThanOrEqual(1)
  })

  it("turns are not affected when stepInputs is absent (no-op)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p" })
    const result = await agent.run("hello")
    expect(result.finalText).toBe("ok")
    expect(session.events.filter((e) => e.type === "user/message")).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @i-harness/core-agent test`
Expected: FAIL — `stepInputs` is not on `AgentDeps` (TS error: unknown property).

- [ ] **Step 3: Implement the seam**

In `packages/core-agent/src/index.ts`, in `AgentDeps` (after `telemetry?: Telemetry`, line ~58):

```ts
  // R-A1: optional step-boundary input seam (steer tier). The loop calls it at
  // the START of every step (including the first) so mid-turn steering lands in
  // the log before the model sees this step's messages. The seam itself appends
  // the promoted user/messages to the session (inbox.claimAtStepBoundary).
  // Absent → byte-identical pre-R-A1 behavior.
  stepInputs?: { claimAtStepBoundary(): void }
```

In `runTurn`'s continuation loop, immediately before `append(deps.session, { type: "step/start" })` (line ~161):

```ts
      // R-A1: steer-tier inputs arrive at the provider boundary — claimed
      // before step/start so deriveMessages below already includes them.
      deps.stepInputs?.claimAtStepBoundary()
      append(deps.session, { type: "step/start" })
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @i-harness/core-agent test`
Expected: PASS (existing agent.test.ts untouched — absence of `stepInputs` keeps prior behavior).

- [ ] **Step 5: Commit**

```bash
git add packages/core-agent/src/index.ts packages/core-agent/test/step-inputs.test.ts
git commit -m "feat(core-agent): R-A1 step-boundary steer seam (stepInputs)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: `SessionExecutor` + `SessionExecutorRegistry` (R-A2)

**Files:**
- Create: `packages/core-agent/src/executor.ts`
- Modify: `packages/core-agent/src/index.ts` (re-exports)
- Test: `packages/core-agent/test/executor.test.ts` (new)

**Interfaces:**
- Consumes: `Inbox`/`PendingInput` (Task 2), `AgentResult` (index.ts), `randomUUID`.
- Produces (Task 5, and C-region later):

```ts
export type InputSubmit =
  | { tier: "send"; text: string }
  | { tier: "followup"; text: string }
  | { tier: "steer"; text: string }
  | { tier: "inject"; text: string; description: string; scope: "turn" | "session" }

export interface AgentRunSurface { run(task: string, signal?: AbortSignal): Promise<AgentResult> }
export interface SessionExecutorDeps {
  session: Session
  agent: AgentRunSurface
  inbox: Inbox
  signal?: AbortSignal
}
export interface SessionExecutor {
  submit(input: InputSubmit): { inputId: string }
  cancel(inputId: string): { cancelled: boolean }
  pending(): PendingInput[]
  isRunning(): boolean
  drain(): Promise<void>
  dispose(): void
}
export function createSessionExecutor(deps: SessionExecutorDeps): SessionExecutor
export function mapSubmitToAdmission(input: InputSubmit): AdmittedInput
export interface SessionExecutorRegistry {
  register(sessionId: string, executor: SessionExecutor): void
  get(sessionId: string): SessionExecutor | undefined
  remove(sessionId: string): void
  entries(): Map<string, SessionExecutor>
}
export function createSessionExecutorRegistry(): SessionExecutorRegistry
```

Tier mapping (the R-A1 four-tier glossary): `send`/`followup` both admit `{delivery:"queue", intent:"user"}` — in the opencode source the durable ladder has **no wake field**; the serial executor is event-driven, so any admission received while idle starts the idle drain and a queue admission received while a turn is active waits for the next turn boundary. `steer` admits `{delivery:"steer"}` (consumed by Task 3's seam mid-turn, or by the idle drain). `inject` admits `intent:"system"` with `synthetic: {description, scope}`; `scope:"turn"` → `delivery:"steer"` (mid-turn injection), `scope:"session"` → `delivery:"queue"` (durable context that paints at the next promoted turn).

- [ ] **Step 1: Write the failing test**

`packages/core-agent/test/executor.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, Inbox } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgent } from "../src/index.ts"
import { createSessionExecutor, createSessionExecutorRegistry, mapSubmitToAdmission } from "../src/executor.ts"

describe("SessionExecutor", () => {
  it("runs one turn per pending input, serially, in admission order", async () => {
    const ctx = createContext()
    const session = createSession()
    const inbox = new Inbox(session)
    const tools = createToolRegistry(ctx)
    const model = createMockClient([
      { role: "assistant", text: "done one" },
      { role: "assistant", text: "done two" },
    ])
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p" })
    const executor = createSessionExecutor({ session, agent, inbox })
    executor.submit({ tier: "send", text: "first" })
    executor.submit({ tier: "followup", text: "second" })
    await executor.drain()
    const userTexts = session.events.filter((e) => e.type === "user/message").map((e) => (e as { text: string }).text)
    expect(userTexts).toEqual(["first", "second"])
    expect(executor.pending()).toEqual([])
    expect(executor.isRunning()).toBe(false)
  })

  it("promotes with a marker immediately before each turn's user/message", async () => {
    const ctx = createContext()
    const session = createSession()
    const inbox = new Inbox(session)
    const tools = createToolRegistry(ctx)
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p" })
    const executor = createSessionExecutor({ session, agent, inbox })
    executor.submit({ tier: "followup", text: "only" })
    await executor.drain()
    const types = session.events.map((e) => e.type)
    const pi = types.findIndex((t) => t === "agent/input/promoted")
    const ui = types.findIndex((t) => t === "user/message")
    expect(pi).toBeGreaterThanOrEqual(0)
    expect(pi).toBeLessThan(ui)
  })

  it("steers admitted mid-run reach the model through the step seam", async () => {
    const ctx = createContext()
    const session = createSession()
    const inbox = new Inbox(session)
    const tools = createToolRegistry(ctx)
    let executor: ReturnType<typeof createSessionExecutor> | undefined
    // the tool body admits the steer DURING step 1 — a real mid-run admission
    const readTool = {
      name: "read_file",
      description: "read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      execute: async () => {
        executor!.submit({ tier: "steer", text: "steer during the run" })
        return { content: "x" }
      },
    }
    tools.register(readTool)
    const model = createMockClient([
      { role: "assistant", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { role: "assistant", text: "final" },
    ])
    const agent = createAgent(ctx, {
      session, tools, model, systemPrompt: "p",
      stepInputs: { claimAtStepBoundary: () => inbox.claimAtStepBoundary() },
    })
    executor = createSessionExecutor({ session, agent, inbox })
    executor.submit({ tier: "send", text: "first" })
    await executor.drain()
    const userTexts = session.events.filter((e) => e.type === "user/message").map((e) => (e as { text: string }).text)
    // "first" opens the turn; the steer is claimed before step 2's provider
    // call — model-visible mid-turn, promoted exactly once, never re-promoted
    // by the executor's pump after the turn ends.
    expect(userTexts).toEqual(["first", "steer during the run"])
    expect(session.events.filter((e) => e.type === "agent/input/promoted")).toHaveLength(2)
    expect(executor.pending()).toEqual([])
  })

  it("cancels a pending input and skips it in a later drain", async () => {
    const ctx = createContext()
    const session = createSession()
    const inbox = new Inbox(session)
    const tools = createToolRegistry(ctx)
    const model = createMockClient([{ role: "assistant", text: "survived" }])
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p" })
    const executor = createSessionExecutor({ session, agent, inbox })
    const a = executor.submit({ tier: "send", text: "doomed" })
    expect(executor.cancel(a.inputId).cancelled).toBe(true)
    expect(executor.cancel(a.inputId).cancelled).toBe(false)
    executor.submit({ tier: "followup", text: "survived" })
    await executor.drain()
    expect(executor.pending()).toEqual([])
  })

  it("maps the four submit tiers onto admissions", () => {
    const a = mapSubmitToAdmission({ tier: "send", text: "a" })
    expect(a.delivery).toBe("queue")
    expect(a.intent).toBe("user")
    expect(a.text).toBe("a")
    expect(mapSubmitToAdmission({ tier: "followup", text: "b" }).delivery).toBe("queue")
    expect(mapSubmitToAdmission({ tier: "steer", text: "c" }).delivery).toBe("steer")
    const inj = mapSubmitToAdmission({ tier: "inject", text: "d", description: "branch changed", scope: "turn" })
    expect(inj.delivery).toBe("steer")
    expect(inj.intent).toBe("system")
    expect(inj.synthetic).toEqual({ description: "branch changed", scope: "turn" })
    expect(mapSubmitToAdmission({ tier: "inject", text: "e", description: "branch changed", scope: "session" }).delivery).toBe("queue")
  })

  it("registers and looks up executors by session id (cross-session independent)", () => {
    const reg = createSessionExecutorRegistry()
    const ctx = createContext()
    const session = createSession()
    const inbox = new Inbox(session)
    const tools = createToolRegistry(ctx)
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p" })
    const ex = createSessionExecutor({ session, agent, inbox })
    reg.register("sess-a", ex)
    expect(reg.get("sess-a")).toBe(ex)
    reg.remove("sess-a")
    expect(reg.get("sess-a")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @i-harness/core-agent test`
Expected: FAIL — `../src/executor.ts` does not exist.

- [ ] **Step 3: Implement `executor.ts`**

`packages/core-agent/src/executor.ts`:

```ts
import { randomUUID } from "node:crypto"
import type { Session } from "@i-harness/core-session"
import { Inbox, type AdmittedInput, type PendingInput } from "@i-harness/core-session"
import type { AgentResult } from "./index.ts"

export type InputSubmit =
  | { tier: "send"; text: string }
  | { tier: "followup"; text: string }
  | { tier: "steer"; text: string }
  | { tier: "inject"; text: string; description: string; scope: "turn" | "session" }

export interface AgentRunSurface {
  run(task: string, signal?: AbortSignal): Promise<AgentResult>
}

export interface SessionExecutorDeps {
  session: Session
  agent: AgentRunSurface
  inbox: Inbox
  signal?: AbortSignal
}

export interface SessionExecutor {
  submit(input: InputSubmit): { inputId: string }
  cancel(inputId: string): { cancelled: boolean }
  pending(): PendingInput[]
  isRunning(): boolean
  drain(): Promise<void>
  dispose(): void
}

// R-A1 four-tier → durable admission mapping. The durable ladder has no "wake"
// field (opencode Delivery = "steer" | "queue" only); the executor is
// event-driven, so ANY admission while idle starts the idle drain and a queue
// admission while a turn is active waits for the next turn boundary.
export function mapSubmitToAdmission(input: InputSubmit): AdmittedInput {
  switch (input.tier) {
    case "send":
    case "followup":
      return { inputId: randomUUID(), text: input.text, delivery: "queue", intent: "user" }
    case "steer":
      return { inputId: randomUUID(), text: input.text, delivery: "steer", intent: "user" }
    case "inject":
      return {
        inputId: randomUUID(),
        text: input.text,
        delivery: input.scope === "turn" ? "steer" : "queue",
        intent: "system",
        synthetic: { description: input.description, scope: input.scope },
      }
  }
}

// R-A2: the per-session serial lane. Per-session serial: every submit appends
// a pump onto ONE promise chain (driveFollowups precedent) — one turn at a time
// per executor, no two turns on the same session ever overlap. Cross-session
// parallel: nothing is shared between executors; the registry (below) is a
// plain map, so N sessions run concurrently in one process. Each pump drains
// the pending FIFO to empty, so a submission arriving mid-turn is picked up
// either by the running pump's next loop iteration (queue tier, after the
// current turn) or by the step-boundary seam (steer tier, Task 3).
export function createSessionExecutor(deps: SessionExecutorDeps): SessionExecutor {
  let chain: Promise<void> = Promise.resolve()
  let running = false
  let disposed = false

  function pump(): Promise<void> {
    chain = chain.then(async () => {
      for (;;) {
        if (disposed || (deps.signal?.aborted ?? false)) return
        const next = deps.inbox.pending()[0]
        if (next === undefined) return
        running = true
        try {
          deps.inbox.promote(next.inputId)
          // turn/start + user/message are appended BY the agent loop here
          // (agent.run), so the promoted marker immediately precedes them.
          await deps.agent.run(next.text, deps.signal)
        } finally {
          running = false
        }
      }
    }).catch(() => {
      // Serialize-invariant hardening (driveFollowups precedent): a rejected
      // pump must not permanently break the lane — the error surface stays the
      // agent's own (session log + followup chain), and new submissions pump
      // again from the current pending set.
    })
    return chain
  }

  return {
    submit(input) {
      const admission = mapSubmitToAdmission(input)
      deps.inbox.admit(admission)
      void pump()
      return { inputId: admission.inputId }
    },
    cancel(inputId) {
      const cancelled = deps.inbox.cancel(inputId)
      return { cancelled }
    },
    pending: () => deps.inbox.pending(),
    isRunning: () => running,
    drain: () => chain,
    dispose() {
      disposed = true
    },
  }
}

export interface SessionExecutorRegistry {
  register(sessionId: string, executor: SessionExecutor): void
  get(sessionId: string): SessionExecutor | undefined
  remove(sessionId: string): void
  entries(): Map<string, SessionExecutor>
}

export function createSessionExecutorRegistry(): SessionExecutorRegistry {
  const executors = new Map<string, SessionExecutor>()
  return {
    register: (sessionId, executor) => {
      if (executors.has(sessionId)) throw new Error(`duplicate session executor: ${sessionId}`)
      executors.set(sessionId, executor)
    },
    get: (sessionId) => executors.get(sessionId),
    remove: (sessionId) => { executors.delete(sessionId) },
    entries: () => executors,
  }
}
```

Note on `drain()`: it returns the chain tail at call time. A submission after `drain()` was called schedules a NEW pump on the same (now-resolved) chain; tests always submit before draining (documented above).

- [ ] **Step 4: Re-export from core-agent index.ts**

In `packages/core-agent/src/index.ts` (next to the execute-tool-calls re-export block):

```ts
export { createSessionExecutor, createSessionExecutorRegistry, mapSubmitToAdmission } from "./executor.ts"
export type { SessionExecutor, SessionExecutorDeps, SessionExecutorRegistry, AgentRunSurface, InputSubmit } from "./executor.ts"
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @i-harness/core-agent test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core-agent/src/executor.ts packages/core-agent/src/index.ts packages/core-agent/test/executor.test.ts
git commit -m "feat(core-agent): R-A2 SessionExecutor serial lane + registry

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: CLI wiring — executor inside `runHeadless` + `session/*` commands

**Files:**
- Modify: `apps/cli/src/run.ts`
- Test: `apps/cli/test/input-tiers.test.ts` (new)

**Interfaces:**
- Consumes: `Inbox`, `createSessionExecutor` (Tasks 1-4), `registerCommand`/`runCommand` from `@i-harness/interaction` (existing), `HeadlessOptions` shape.
- Produces: `HeadlessOptions` unchanged (no new option needed — the executor is always mounted when a coordinator/session exists; commands are the host surface). `runHeadless` now drives the initial task through the executor, so queued inputs admitted via commands during the run are drained serially after it.

- [ ] **Step 1: Write the failing CLI test**

`apps/cli/test/input-tiers.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadless } from "../src/run.ts"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createMockClient } from "@i-harness/llm-mock"
import { createSession } from "@i-harness/core-session"

describe("CLI input tiers", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-tiers-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("drives the initial task through the executor and drains pending turns serially", async () => {
    const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
    const session = createSession()
    const model = createMockClient([
      { role: "assistant", text: "initial answer" },
      { role: "assistant", text: "followup answer" },
    ])
    const result = await runHeadless("one", {
      workspace: dir,
      model,
      sessionId: "sess-tiers",
      coordinator,
      session,
    })
    expect(result.exitCode).toBe(0)
    expect(result.finalText).toBe("followup answer")
    // two turns happened serially on the one session
    expect(session.events.filter((e) => e.type === "turn/end")).toHaveLength(2)
  })
})
```

The executor wires the initial `followup` submission + `drain()`; queued inputs admitted via the `session/*` commands during the run extend the drain serially (the durable tier semantics themselves are covered by Task 4's tests; the resume-order case is the Step 5 test below).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @i-harness/cli test -- --run input-tiers` (or `pnpm exec vitest run test/input-tiers.test.ts` in `apps/cli`)
Expected: FAIL — the current `runHeadless` calls `agent.run(task)` directly and the session would show 1 turn/end.

- [ ] **Step 3: Wire the executor + commands into `runHeadless`**

In `apps/cli/src/run.ts`, imports:

```ts
import { createSessionExecutor, type SessionExecutor } from "@i-harness/core-agent"
import { Inbox } from "@i-harness/core-session"
import { registerCommand } from "@i-harness/interaction"
```

The agent needs the step seam — create the Inbox BEFORE `createAgent`, and wire both into the creation + executor:

```ts
    // R-A1/R-A2: the session's serial lane. The initial task flows through the
    // executor (idle drain → one turn); host commands can submit additional
    // tiers during the run — they are promoted FIFO and drained serially.
    const inbox = new Inbox(session)
    const executor: SessionExecutor = createSessionExecutor({ session, agent, inbox })
```

(site it right after the existing `const agent = createAgent(...)`; the `createAgent` deps object gains R-A1's step seam — steers admitted mid-run are claimed at the next provider boundary):

```ts
    const agent = createAgent(ctx, {
      session, tools, model,
      systemPrompt,
      ...(activeId ? { sessionId: activeId } : {}),
      ...(opts.compact ? { compact: opts.compact } : {}),
      ...(opts.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: opts.maxParallelToolCalls } : {}),
      ...(telemetry ? { telemetry } : {}),
      // R-A1: steer-tier claims at the step boundary (mid-turn injection)
      stepInputs: { claimAtStepBoundary: () => inbox.claimAtStepBoundary() },
    })
```

(minimal edit: insert the `stepInputs` line into the existing `createAgent` call — the `inbox` const must be declared before it; keep everything else unchanged.)
    registerCommand(ctx, {
      name: "session/send",
      execute: async (input) => {
        const { text } = JSON.parse(input) as { text: string }
        executor.submit({ tier: "send", text })
        return JSON.stringify({ queued: true })
      },
    })
    registerCommand(ctx, {
      name: "session/followup",
      execute: async (input) => {
        const { text } = JSON.parse(input) as { text: string }
        executor.submit({ tier: "followup", text })
        return JSON.stringify({ queued: true })
      },
    })
    registerCommand(ctx, {
      name: "session/steer",
      execute: async (input) => {
        const { text } = JSON.parse(input) as { text: string }
        executor.submit({ tier: "steer", text })
        return JSON.stringify({ queued: true })
      },
    })
    registerCommand(ctx, {
      name: "session/inject",
      execute: async (input) => {
        const { text, description, scope } = JSON.parse(input) as { text: string; description: string; scope: "turn" | "session" }
        executor.submit({ tier: "inject", text, description, scope })
        return JSON.stringify({ queued: true })
      },
    })
    registerCommand(ctx, {
      name: "session/cancel",
      execute: async (input) => {
        const { inputId } = JSON.parse(input) as { inputId: string }
        return JSON.stringify(executor.cancel(inputId))
      },
    })
    registerCommand(ctx, {
      name: "session/pending",
      execute: async () => JSON.stringify(executor.pending().map((p) => ({ inputId: p.inputId, text: p.text, delivery: p.delivery }))),
    })
    // Initial task through the executor (serial lane; a resumed session's
    // recovered pending inputs precede it FIFO) — replaces the direct
    // `await agent.run(task)`.
    executor.submit({ tier: "followup", text: task })
    await executor.drain()
    const derived = deriveMessages(session).at(-1)
    const finalText = typeof derived?.content === "string" ? derived.content : ""
    // return { finalText, exitCode: 0, session } — the existing return stays,
    // with `result.finalText` replaced by the `finalText` constant above.
```

(Add `deriveMessages` to the `@i-harness/core-session` import along with `Inbox`. The executor-driven semantics note: a host command that admits a queue tier mid-run extends the run serially; `finalText` is the terminal message of the LAST turn, so a run ending on a tool-call-only session yields `""` — the same terminal derivation the agent loop uses for `AgentResult.finalText`.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @i-harness/cli test` (full suite — the swap must not break existing CLI tests) + the new `input-tiers.test.ts` specifically.
Expected: PASS.

Note: existing CLI tests that pass `opts.session` (host-seeded) with an attached coordinator keep working — `Inbox` only reads/appends; a host-seeded session without coordinator loses durability for input events, which is the documented host-owns-durability contract (headless seeded-session path, same as turn events).

- [ ] **Step 5: Verify resume pending recovery**

In the Step 1 test file, add (then run again):

```ts
  it("resumes pending inputs from the log, promoted before the new task", async () => {
    const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
    const { id } = await coordinator.create({ sessionId: "sess-recover" })
    coordinator.enqueue(id, [
      { type: "agent/input/admitted", version: 1, inputId: "old", text: "stale queued", delivery: "queue", intent: "user" },
    ])
    await coordinator.flush(id)
    const model = createMockClient([
      { role: "assistant", text: "stale done" },
      { role: "assistant", text: "new done" },
    ])
    const result = await runHeadless("new task", {
      workspace: dir, model,
      resumeSessionId: id, coordinator,
    })
    expect(result.exitCode).toBe(0)
    const userTexts = result.session!.events.filter((e) => e.type === "user/message").map((e) => (e as { text: string }).text)
    expect(userTexts[0]).toBe("stale queued") // FIFO: recovered pending first
    expect(userTexts).toContain("new task")
  })
```

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/run.ts apps/cli/test/input-tiers.test.ts
git commit -m "feat(cli): R-A1/R-A2 executor-driven runHeadless with session/* commands

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: `runtime-context` package — dynamic sections + snapshot messages (R-A4)

**Files:**
- Create: `packages/runtime-context/package.json`, `packages/runtime-context/tsconfig.json`
- Create: `packages/runtime-context/src/index.ts`
- Create: `packages/runtime-context/test/runtime-context.test.ts`
- Modify: (none in core-agent — the pre-step hook is the existing `agent/pre-step` emit)

**Interfaces:**
- Consumes: `Session`, `append`, event semantics; `PluginContext.on("agent/pre-step")` (existing core-agent emit, index.ts line 172 — runs every step BEFORE `deriveMessages`).
- Produces (Tasks 7, 8):

```ts
export const RUNTIME_CONTEXT_SOURCE_PLUGIN = "i-harness/runtime-context"
export interface ContextSection { name: string; text: string }
export interface RuntimeContextService {
  registerSection(name: string, getter: () => string): () => void
  render(): void
  currentText(): string
}
export function createRuntimeContext(session: Session): RuntimeContextService
export function installRuntimeContext(ctx: PluginContext, session: Session): RuntimeContextService
```

- [ ] **Step 1: Create package scaffold**

`packages/runtime-context/package.json`:

```json
{
  "name": "@i-harness/runtime-context",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-plugin": "workspace:*",
    "@i-harness/core-session": "workspace:*"
  }
}
```

`packages/runtime-context/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Then `pnpm install` at repo root.

- [ ] **Step 2: Write the failing test**

`packages/runtime-context/test/runtime-context.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, deriveMessages, type SessionEvent } from "@i-harness/core-session"
import { createRuntimeContext, installRuntimeContext, RUNTIME_CONTEXT_SOURCE_PLUGIN } from "../src/index.ts"

function snapshotTexts(s: ReturnType<typeof createSession>): string[] {
  return s.events.filter(
    (e): e is Extract<SessionEvent, { type: "user/message" }> =>
      e.type === "user/message" && e.source?.kind === "plugin" && e.source.plugin === RUNTIME_CONTEXT_SOURCE_PLUGIN,
  ).map((e) => e.text)
}

describe("runtime context", () => {
  it("appends a snapshot only when the rendered text changed", () => {
    const s = createSession()
    const rc = createRuntimeContext(s)
    rc.registerSection("cwd", () => "/workspace/app")
    rc.registerSection("git", () => "branch: main")
    rc.render()
    rc.render()
    expect(snapshotTexts(s)).toHaveLength(1)
    rc.currentText()
    expect(snapshotTexts(s)[0]!).toContain("## cwd")
    expect(snapshotTexts(s)[0]!).toContain("/workspace/app")
    expect(snapshotTexts(s)[0]!).toContain("branch: main")
  })

  it("writes the cleared marker when the last section empties", () => {
    const s = createSession()
    let branch = "main"
    const rc = createRuntimeContext(s)
    rc.registerSection("git", () => branch)
    rc.render()
    branch = ""
    rc.render()
    expect(snapshotTexts(s)).toHaveLength(2)
    expect(snapshotTexts(s)[1]!).toContain("none")
  })

  it("recreates the retained snapshot from the log (replay)", () => {
    const s = createSession()
    const rc = createRuntimeContext(s)
    rc.registerSection("s", () => "v1")
    rc.render()
    rc.render()
    const again = createRuntimeContext(s)
    const section = { name: "s", getter: () => "v1" }
    const before = s.events.length
    again.registerSection(section.name, section.getter)
    again.render() // same text → no new snapshot
    expect(s.events.length).toBe(before)
  })

  it("snapshots are model-visible user messages", async () => {
    const s = createSession()
    const rc = createRuntimeContext(s)
    rc.registerSection("state", () => "on branch feature")
    rc.render()
    const msgs = deriveMessages(s)
    expect(msgs.some((m) => m.role === "user" && m.content === "## state\n\non branch feature")).toBe(true)
  })

  it("installRuntimeContext renders on the agent/pre-step emit (loop integration seam)", () => {
    const ctx = createContext()
    const s = createSession()
    const rc = installRuntimeContext(ctx, s)
    rc.registerSection("cwd", () => "/w")
    void ctx.emit("agent/pre-step", { task: "t", session: s })
    expect(snapshotTexts(s)).toHaveLength(1)
    void ctx.emit("agent/pre-step", { task: "t", session: s })
    expect(snapshotTexts(s)).toHaveLength(1) // unchanged → no second snapshot
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @i-harness/runtime-context test`
Expected: FAIL — no such package (`../src/index.ts` missing).

- [ ] **Step 4: Implement `runtime-context/src/index.ts`**

```ts
import type { PluginContext } from "@i-harness/core-plugin"
import type { Session } from "@i-harness/core-session"
import { append } from "@i-harness/core-session"

export const RUNTIME_CONTEXT_SOURCE_PLUGIN = "i-harness/runtime-context"
export const RUNTIME_CONTEXT_CLEARED = "Current runtime context: none. Earlier runtime-context snapshots no longer apply."

export interface ContextSection { name: string; text: string }

export interface RuntimeContextService {
  registerSection(name: string, getter: () => string): () => void
  render(): void
  currentText(): string
}

// R-A4: dynamic system context (dsh runtime-context re-implemented in
// i-harness vocabulary). The system prompt stays the host's static baseline;
// dynamic sections render into a snapshot USER MESSAGE appended to the session
// log ONLY when the rendered text changed — model-visible, replayable, and
// durable through the session's own coordinator mirror. A resumed session
// reconstructs the last retained snapshot by scanning the log (the caller's
// session object is the same one reloaded by the coordinator).
export function createRuntimeContext(session: Session): RuntimeContextService {
  const sections = new Map<string, () => string>()
  let retained: string | undefined

  // Replay: last snapshot user/message wins; `undefined` = no snapshot ever.
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    const ev = session.events[i]
    if (ev?.type !== "user/message" || ev.source?.kind !== "plugin") continue
    if (ev.source.plugin !== RUNTIME_CONTEXT_SOURCE_PLUGIN) continue
    retained = ev.text
    break
  }

  function currentText(): string {
    const parts: ContextSection[] = []
    for (const [name, getter] of sections) {
      const text = getter()
      if (text.length > 0) parts.push({ name, text })
    }
    if (parts.length === 0) return ""
    return parts.map((s) => `## ${s.name}\n\n${s.text.trim()}`).join("\n\n")
  }

  function render(): void {
    const rendered = currentText()
    const snapshot = rendered.length === 0 ? RUNTIME_CONTEXT_CLEARED : rendered
    if (retained === snapshot) return
    append(session, {
      type: "user/message",
      text: snapshot,
      source: { kind: "plugin", plugin: RUNTIME_CONTEXT_SOURCE_PLUGIN },
    })
    retained = snapshot
  }

  return {
    registerSection(name, getter) {
      if (sections.has(name)) throw new Error(`duplicate runtime-context section: ${name}`)
      sections.set(name, getter)
      return () => { sections.delete(name) }
    },
    render,
    currentText,
  }
}

export function installRuntimeContext(ctx: PluginContext, session: Session): RuntimeContextService {
  const service = createRuntimeContext(session)
  ctx.on("agent/pre-step", () => { service.render() })
  return service
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @i-harness/runtime-context test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime-context
git commit -m "feat(runtime-context): R-A4 dynamic sections + change-only snapshot messages

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: `instructions` package — AGENTS.md/CLAUDE.md global→parent→workspace merge (R-A5)

**Files:**
- Create: `packages/instructions/package.json`, `packages/instructions/tsconfig.json`
- Create: `packages/instructions/src/files.ts`
- Create: `packages/instructions/src/index.ts`
- Create: `packages/instructions/test/instructions.test.ts`

**Interfaces:**
- Consumes: `node:fs` (stat/readFileSync), `node:path`, `node:os`; `ContextSection` convention from Task 6 (the section getter returns a plain string).
- Produces (Task 8):

```ts
export interface InstructionFile { absolutePath: string; displayPath: string; content: string }
export interface InstructionsConfig { workspace: string; maxBytes?: number }
export function discoverInstructionPaths(workspace: string): string[]
export function loadInstructionFiles(workspace: string): InstructionFile[]
export function renderInstructions(files: InstructionFile[]): string
export function createInstructionsSection(config: InstructionsConfig): () => string
```

Merge order: `[global (os.homedir()) → workspace's ancestors → workspace]`; rendering order = same list (nearest-last ⇒ workspace content renders last/most salient). Per-directory candidates are `AGENTS.md`, then `CLAUDE.md` (AGENTS.md wins when both exist in the same directory). `maxBytes` default `24_000` (truncated tail, `"(truncated)"` marker).

- [ ] **Step 1: Create package scaffold**

`packages/instructions/package.json`:

```json
{
  "name": "@i-harness/instructions",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {}
}
```

`packages/instructions/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Then `pnpm install` at repo root.

- [ ] **Step 2: Write the failing test**

`packages/instructions/test/instructions.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverInstructionPaths, loadInstructionFiles, renderInstructions, createInstructionsSection } from "../src/index.ts"

describe("instructions discovery", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "i-harness-inst-"))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("walks workspace → parent → ancestor; AGENTS.md preferred over CLAUDE.md per dir", () => {
    const ws = join(root, "workspace")
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(root, "AGENTS.md"), "root instructions")
    writeFileSync(join(ws, "CLAUDE.md"), "claude in workspace")
    writeFileSync(join(ws, "AGENTS.md"), "agents in workspace")
    const paths = discoverInstructionPaths(ws)
    // the ancestor walk reaches the volume root — a real dev home may hold a
    // global AGENTS.md/CLAUDE.md, so assert on the temp-root subset + ordering
    const local = paths.filter((p) => p.startsWith(root))
    expect(local).toEqual([join(root, "AGENTS.md"), join(ws, "AGENTS.md")])
    expect(paths.indexOf(join(root, "AGENTS.md"))).toBeLessThan(paths.indexOf(join(ws, "AGENTS.md")))
    const files = loadInstructionFiles(ws)
    expect(files.map((f) => f.content)).toEqual(["root instructions", "agents in workspace"])
    const rendered = renderInstructions(files)
    expect(rendered.indexOf("root instructions")).toBeLessThan(rendered.indexOf("agents in workspace"))
  })

  it("prepends the global candidates (synthetic home override)", () => {
    const ws = join(root, "ws")
    const fakeHome = join(root, "fake-home")
    mkdirSync(ws, { recursive: true })
    mkdirSync(fakeHome, { recursive: true })
    writeFileSync(join(fakeHome, "CLAUDE.md"), "global instructions")
    writeFileSync(join(ws, "AGENTS.md"), "workspace instructions")
    const paths = discoverInstructionPaths(ws, fakeHome)
    expect(paths[0]).toBe(join(fakeHome, "CLAUDE.md"))
    expect(paths).toContain(join(ws, "AGENTS.md"))
  })

  it("returns a stable ordered list with no duplicates", () => {
    const ws = join(root, "ws")
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, "AGENTS.md"), "w")
    const paths = discoverInstructionPaths(ws)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths[paths.length - 1]).toBe(join(ws, "AGENTS.md"))
  })

  it("caches by mtime/size — changed content re-renders", () => {
    const ws = join(root, "ws")
    mkdirSync(ws, { recursive: true })
    const f = join(ws, "AGENTS.md")
    writeFileSync(f, "version one")
    const section = createInstructionsSection({ workspace: ws })
    expect(section()).toContain("version one")
    writeFileSync(f, "version two")
    // push mtime beyond the cached stat so the change is definitely detected
    utimesSync(f, new Date(), new Date(Date.now() + 2000))
    const second = section()
    expect(second).toContain("version two")
    expect(second).not.toContain("version one")
  })

  it("truncates the rendered set at maxBytes", () => {
    const ws = join(root, "ws")
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, "AGENTS.md"), "x".repeat(500))
    const section = createInstructionsSection({ workspace: ws, maxBytes: 100 })
    const out = section()
    expect(out.length).toBeLessThanOrEqual(100 + "(truncated)".length)
    expect(out.endsWith("(truncated)")).toBe(true)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @i-harness/instructions test`
Expected: FAIL — package does not exist.

- [ ] **Step 4: Implement `files.ts` + `index.ts`**

`packages/instructions/src/files.ts`:

```ts
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { homedir } from "node:os"

export interface InstructionFile { absolutePath: string; displayPath: string; content: string }

const CANDIDATES = ["AGENTS.md", "CLAUDE.md"]

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}

// R-A5: discovery order = global → workspace ancestors → workspace (closest
// last, so rendered instructions put the workspace file at the end/most
// salient). AGENTS.md wins over CLAUDE.md per directory.
export function discoverInstructionPaths(workspace: string, home = homedir()): string[] {
  const dirs = ancestorDirs(workspace)
  const all: string[] = dirs.flatMap((dir) =>
    CANDIDATES.map((c) => join(dir, c)).filter((p) => existsSync(p)),
  )
  const homeDirs = [join(home), join(home, ".claude")]
  for (const hd of homeDirs) {
    for (const c of CANDIDATES) {
      const p = join(hd, c)
      if (existsSync(p) && !all.includes(p)) all.unshift(p)
    }
  }
  // dedupe while keeping global-first order
  const seen = new Set<string>()
  return all.filter((p) => {
    if (seen.has(p)) return false
    seen.add(p)
    return true
  })
}

function ancestorDirs(workspace: string): string[] {
  const dirs: string[] = []
  let d = workspace
  while (true) {
    dirs.unshift(d)
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  return dirs
}

export function loadInstructionFiles(workspace: string, home?: string): InstructionFile[] {
  const result: InstructionFile[] = []
  for (const p of discoverInstructionPaths(workspace, home)) {
    try {
      const content = readFileSync(p, "utf8")
      result.push({ absolutePath: p, displayPath: relative(workspace, p).split(sep).join("/"), content })
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return result
}

export function renderInstructions(files: InstructionFile[]): string {
  if (files.length === 0) return ""
  return files.map((f) => `### ${f.displayPath}\n\n${f.content.trim()}`).join("\n\n")
}
```

`packages/instructions/src/index.ts`:

```ts
import { existsSync, readFileSync, statSync } from "node:fs"
import { loadInstructionFiles, renderInstructions, type InstructionFile } from "./files.ts"

export { loadInstructionFiles, renderInstructions, discoverInstructionPaths } from "./files.ts"
export type { InstructionFile } from "./files.ts"

export interface InstructionsConfig { workspace: string; maxBytes?: number }

export const DEFAULT_INSTRUCTIONS_MAX_BYTES = 24_000

interface Cached {
  mtimeMs: number
  size: number
  content: InstructionFile[]
}

// R-A5: mount as one of runtime-context's dynamic sections (Task 6). The
// getter is SYNCHRONOUS (the pre-step render seam is sync): it re-stats cached
// files and re-reads only when mtime/size changed, so an unchanged tree costs
// one stat per file per step boundary (cheap; change detection is the
// mtime/size compare — the roadmap's "變更檢測可後補" note is covered by the
// snapshot-diff dedupe in runtime-context).
export function createInstructionsSection(config: InstructionsConfig): () => string {
  const maxBytes = config.maxBytes ?? DEFAULT_INSTRUCTIONS_MAX_BYTES
  let cache: { key: string; files: Cached } | undefined

  function readChanged(): InstructionFile[] {
    const files = loadInstructionFiles(config.workspace)
    const key = files.map((f) => f.absolutePath).join("|")
    const filesNow: Cached = { mtimeMs: 0, size: 0, content: files }
    try {
      const stats = files.map((f) => statSync(f.absolutePath))
      filesNow.mtimeMs = Math.max(...stats.map((s) => s.mtimeMs), 0)
      filesNow.size = stats.reduce((acc, s) => acc + s.size, 0)
    } catch {
      // stat failure → fall through to full re-read on the next call
    }
    if (cache !== undefined && cache.key === key && cache.files.mtimeMs === filesNow.mtimeMs && cache.files.size === filesNow.size) {
      return cache.files.content
    }
    cache = { key, files: filesNow }
    return filesNow.content
  }

  return () => {
    const files = readChanged()
    let text = renderInstructions(files)
    if (text.length > maxBytes) {
      text = text.slice(0, maxBytes) + "\n...(truncated)"
    }
    return text
  }
}
```

Note: imports `existsSync`/`statSync` are used here via `loadInstructionFiles`/`statSync`; remove the unused `readFileSync`/`existsSync` imports from index.ts (keep only `statSync` and `loadInstructionFiles`/`renderInstructions`). Final import line: `import { statSync } from "node:fs"`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @i-harness/instructions test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/instructions
git commit -m "feat(instructions): R-A5 AGENTS.md/CLAUDE.md global→parent→workspace merge

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: CLI wiring — runtime-context + instructions section (R-A4/R-A5)

**Files:**
- Modify: `apps/cli/src/run.ts`
- Test: `apps/cli/test/context-instructions.test.ts` (new)

**Interfaces:**
- Consumes: `installRuntimeContext` (Task 6), `createInstructionsSection` (Task 7); the existing `agent/pre-step` emit.
- Produces: runHeadless behavior — a snapshot user/message with the instructions section appears before the first model call; changing the workspace's AGENTS.md mid-run appends a second snapshot at the next step boundary.

- [ ] **Step 1: Write the failing test**

`apps/cli/test/context-instructions.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadless } from "../src/run.ts"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import type { SessionEvent } from "@i-harness/core-session"

describe("CLI runtime context + instructions", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-ctx-"))
    writeFileSync(join(dir, "AGENTS.md"), "Use pnpm only. Never touch the vendor dir.")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("renders the instructions section into the first snapshot, model-visible", async () => {
    const session = createSession()
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const result = await runHeadless("task", { workspace: dir, model, session })
    expect(result.exitCode).toBe(0)
    const snapshots = session.events.filter(
      (e): e is Extract<SessionEvent, { type: "user/message" }> =>
        e.type === "user/message" && e.source?.kind === "plugin" && e.source.plugin === "i-harness/runtime-context",
    )
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.text).toContain("Use pnpm only")
    expect(snapshots[0]!.text).toContain("## instructions")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @i-harness/cli test -- --run context-instructions` (or `pnpm exec vitest run test/context-instructions.test.ts` in apps/cli)
Expected: FAIL — no context snapshots (feature not wired).

- [ ] **Step 3: Wire into `run.ts`**

Imports:

```ts
import { installRuntimeContext } from "@i-harness/runtime-context"
import { createInstructionsSection } from "@i-harness/instructions"
```

Right after the session is finalized (after the resume block, before the `try {` — the session object is authoritative by then; note the snapshot append goes through `session`'s onAppend mirror hook which the coordinator mirror relies on):

```ts
    // R-A4/R-A5: dynamic system context — sections render at every step
    // boundary via the agent/pre-step hook; a changed render appends a
    // model-visible snapshot user/message to the log. Instructions load as one
    // section (AGENTS.md/CLAUDE.md global→parent→workspace merge).
    const runtimeContext = installRuntimeContext(ctx, session)
    runtimeContext.registerSection("instructions", createInstructionsSection({ workspace: opts.workspace }))
```

`installRuntimeContext` must be mounted before the agent runs (it is — the code is before `createAgent`).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS (new test + existing suite).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run.ts apps/cli/test/context-instructions.test.ts
git commit -m "feat(cli): R-A4/R-A5 runtime-context snapshot + instructions section

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: `session/title` log-only event + projection (R-A6, core-session half)

**Files:**
- Modify: `packages/core-session/src/index.ts` (union + `deriveSessionTitle` + export)
- Modify: `packages/session-persistence/src/index.ts` (registerEventType)
- Test: `packages/core-session/test/title-event.test.ts` (new)

**Interfaces:**
- Consumes: append/seq conventions.
- Produces (Task 10):

```ts
export interface SessionTitleView {
  title: string
  messageSeqs: number[]
  source: "fallback" | "provider" | "user"
  eventSeq: number
}
export function deriveSessionTitle(session: Session): SessionTitleView | null
```

Event member: `{ type: "session/title"; title: string; messageSeqs: number[]; source: "fallback" | "provider" | "user"; seq?: number }` — log-only, last-wins (dsh `session/title`).

- [ ] **Step 1: Write the failing test**

`packages/core-session/test/title-event.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, deriveSessionTitle } from "../src/index.ts"

describe("session/title event", () => {
  it("is log-only and absent before any title", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    expect(deriveSessionTitle(s)).toBeNull()
    expect(deriveMessages(s)).toHaveLength(1)
    append(s, { type: "session/title", title: "my session", messageSeqs: [0], source: "provider" })
    expect(deriveSessionTitle(s)).toEqual({ title: "my session", messageSeqs: [0], source: "provider", eventSeq: 1 })
    expect(deriveMessages(s)).toHaveLength(1) // still log-only
  })

  it("last-wins on multiple titles; user rename wins positionally", () => {
    const s = createSession()
    append(s, { type: "session/title", title: "first", messageSeqs: [0], source: "provider" })
    append(s, { type: "session/title", title: "final", messageSeqs: [0], source: "user" })
    expect(deriveSessionTitle(s)!.title).toBe("final")
    expect(deriveSessionTitle(s)!.source).toBe("user")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @i-harness/core-session test`
Expected: FAIL — union member and `deriveSessionTitle` missing.

- [ ] **Step 3: Implement the event + projection**

In `packages/core-session/src/index.ts`, union member (after the input members from Task 1):

```ts
    // R-A6 session title: latest-wins log-only snapshot (dsh `session/title`).
    // Never model-visible; deriveSearchText defaults ("").
    | { type: "session/title"; title: string; messageSeqs: number[]; source: "fallback" | "provider" | "user"; seq?: number }
```

Projection (near `deriveSearchText`):

```ts
export interface SessionTitleView {
  title: string
  messageSeqs: number[]
  source: "fallback" | "provider" | "user"
  eventSeq: number
}

/** Latest-wins session title projection (log-only: never `deriveMessages`-visible). */
export function deriveSessionTitle(session: Session): SessionTitleView | null {
  let view: SessionTitleView | null = null
  for (const ev of session.events) {
    if (ev.type !== "session/title") continue
    view = { title: ev.title, messageSeqs: ev.messageSeqs, source: ev.source, eventSeq: ev.seq ?? 0 }
  }
  return view
}
```

- [ ] **Step 4: Register the type in session-persistence**

In `packages/session-persistence/src/index.ts`:

```ts
// R-A6: session title snapshot event (log-only).
registerEventType("session/title")
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @i-harness/core-session test && pnpm --filter @i-harness/session-persistence test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core-session/src/index.ts packages/core-session/test/title-event.test.ts packages/session-persistence/src/index.ts
git commit -m "feat(core-session): R-A6 session/title log-only event + projection

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 10: `session-title` package — fallback + LLM provider + coordinator doc mirror (R-A6)

**Files:**
- Create: `packages/session-title/package.json`, `packages/session-title/tsconfig.json`
- Create: `packages/session-title/src/index.ts`
- Create: `packages/session-title/test/session-title.test.ts`
- Modify: `apps/cli/src/run.ts` (auto-title after run)

**Interfaces:**
- Consumes: `deriveSessionTitle` (Task 9), `Session`, `deriveMessages`? (no — selector over raw events), `ModelClient`/`LLMRequest` from `@i-harness/llm-seam`, `SessionCoordinator` from `@i-harness/session-persistence`.
- Produces:

```ts
export function fallbackTitle(text: string, maxWords?: number): string
export function normalizeTitle(text: string, maxBytes?: number): string
export async function suggestTitle(deps: { session: Session; model: ModelClient; maxWords?: number }): Promise<{ title: string; source: "provider" | "fallback" }>
export function applyTitle(session: Session, title: string, source: "fallback" | "provider" | "user", messageSeqs?: number[]): void
export async function maybeAutoTitle(deps: { session: Session; model: ModelClient; coordinator?: SessionCoordinator; sessionId?: string }): Promise<void>
```

- [ ] **Step 1: Create package scaffold**

`packages/session-title/package.json`:

```json
{
  "name": "@i-harness/session-title",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-session": "workspace:*",
    "@i-harness/llm-seam": "workspace:*",
    "@i-harness/session-persistence": "workspace:*"
  }
}
```

`packages/session-title/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Then `pnpm install` at repo root.

- [ ] **Step 2: Write the failing test**

`packages/session-title/test/session-title.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createSession, append, deriveSessionTitle } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import type { ModelClient } from "@i-harness/llm-seam"
import { fallbackTitle, normalizeTitle, suggestTitle, applyTitle, maybeAutoTitle } from "../src/index.ts"

describe("session-title", () => {
  it("fallbackTitle takes the first words of the user's message", () => {
    expect(fallbackTitle("  Implement the queue   for pending inputs,   please.  ")).toBe("Implement the queue for pending inputs, please.")
    expect(fallbackTitle("one two three four five six seven eight nine ten", 4)).toBe("one two three four...")
  })

  it("normalizeTitle strips whitespace and enforces a byte cap", () => {
    expect(normalizeTitle("  A\n\nB  ")).toBe("A\n\nB")
    const long = "x".repeat(300)
    expect(normalizeTitle(long, 80).length).toBeLessThanOrEqual(83)
  })

  it("suggestTitle uses the provider and falls back on failure; applies via applyTitle", async () => {
    const session = createSession()
    append(session, { type: "user/message", text: "Write a CLI tool for sorting files" })
    const model = createMockClient([{ role: "assistant", text: "Sort-file CLI tool" }])
    const suggested = await suggestTitle({ session, model })
    expect(suggested.title).toBe("Sort-file CLI tool")
    expect(suggested.source).toBe("provider")
    applyTitle(session, suggested.title, suggested.source, [0])
    expect(deriveSessionTitle(session)!.title).toBe("Sort-file CLI tool")

    const failingModel: ModelClient = { async *stream() { throw new Error("provider down") } }
    const fallback = await suggestTitle({ session, model: failingModel })
    expect(fallback.source).toBe("fallback")
    expect(fallback.title.length).toBeGreaterThan(0)
  })

  it("maybeAutoTitle is first-prompt mode: no-op when a title already exists", async () => {
    const session = createSession()
    append(session, { type: "user/message", text: "create a todo app" })
    const model = createMockClient([{ role: "assistant", text: "Todo app creator" }])
    await maybeAutoTitle({ session, model })
    expect(deriveSessionTitle(session)!.title).toBe("Todo app creator")
    await maybeAutoTitle({ session, model }) // second call: title exists → unchanged
    expect(session.events.filter((e) => e.type === "session/title")).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @i-harness/session-title test`
Expected: FAIL — package missing.

- [ ] **Step 4: Implement `src/index.ts`**

```ts
import type { Session } from "@i-harness/core-session"
import { append, deriveSessionTitle } from "@i-harness/core-session"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"

export const TITLE_MAX_BYTES = 120
export const TITLE_MAX_WORDS = 8

const SYSTEM_TITLE_PROMPT =
  "You produce ONLY a short session title. Reply with at most 8 words that capture the user's goal " +
  "from the messages. No quotes, no markdown, no trailing period."

// R-A6: deterministic fallback (dsh normalize/fallback re-implementation):
// first `maxWords` whitespace-delimited words, single-line collapsed.
export function fallbackTitle(text: string, maxWords = TITLE_MAX_WORDS): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter((w) => w.length > 0)
  if (words.length === 0) return "New session"
  const head = words.slice(0, maxWords).join(" ")
  const truncated = words.length > maxWords
  const title = truncated ? `${head}...` : head
  return normalizeTitle(title, TITLE_MAX_BYTES)
}

export function normalizeTitle(text: string, maxBytes = TITLE_MAX_BYTES): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  const buf = Buffer.from(normalized, "utf8")
  if (buf.byteLength <= maxBytes) return normalized
  return `${buf.subarray(0, maxBytes).toString("utf8").trim()}...`
}

// Eligible model-visible USER prompts: real user messages only — runtime
// context snapshots and system injections carry a plugin source and are
// excluded.
function eligibleUserTexts(session: Session): { seq: number; text: string }[] {
  const out: { seq: number; text: string }[] = []
  for (const ev of session.events) {
    if (ev.type !== "user/message") continue
    const src = (ev as { source?: unknown }).source
    if (src !== undefined) continue
    out.push({ seq: ev.seq ?? 0, text: ev.text })
  }
  return out
}

export async function suggestTitle(deps: { session: Session; model: ModelClient; maxWords?: number }): Promise<{ title: string; source: "provider" | "fallback" }> {
  const inputs = eligibleUserTexts(deps.session)
  const first = inputs[0]?.text ?? ""
  try {
    const request: LLMRequest = {
      messages: [{ role: "user", content: inputs.map((i) => i.text).join("\n\n").slice(0, 4000) || "(no messages)" }],
      tools: [],
      systemPrompt: SYSTEM_TITLE_PROMPT,
    }
    let out = ""
    for await (const ev of deps.model.stream(request)) {
      if (ev.type === "text/chunk") out += ev.text
      if (ev.type === "error") throw ev.error
    }
    const title = normalizeTitle(out)
    if (title.length === 0) throw new Error("empty provider title")
    return { title, source: "provider" }
  } catch {
    return { title: fallbackTitle(first, deps.maxWords), source: "fallback" }
  }
}

export function applyTitle(session: Session, title: string, source: "fallback" | "provider" | "user", messageSeqs?: number[]): void {
  append(session, { type: "session/title", title: normalizeTitle(title), messageSeqs: messageSeqs ?? [], source })
}

// First-prompt mode (roadmap). Fail-soft: a provider failure degrades to the
// deterministic fallback; a coordinator failure never rejects the caller
// (putDocument reports internally).
export async function maybeAutoTitle(deps: {
  session: Session
  model: ModelClient
  coordinator?: SessionCoordinator
  sessionId?: string
}): Promise<void> {
  if (deps.coordinator && deps.sessionId) {
    // best-effort persisted mirror (list-screen fast path)
    void deps.coordinator.putDocument(`session-title/${deps.sessionId}`, {
      formatVersion: 1,
      title: deriveSessionTitle(deps.session)?.title ?? null,
    }).catch(() => {})
  }
  if (deriveSessionTitle(deps.session) !== null) return
  const inputs = eligibleUserTexts(deps.session)
  if (inputs.length === 0) return
  const { title, source } = await suggestTitle({ session: deps.session, model: deps.model })
  applyTitle(deps.session, title, source, inputs.map((i) => i.seq))
  if (deps.coordinator && deps.sessionId) {
    void deps.coordinator.putDocument(`session-title/${deps.sessionId}`, {
      formatVersion: 1,
      title,
      source,
    }).catch(() => {})
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @i-harness/session-title test`
Expected: PASS.

- [ ] **Step 6: Wire the CLI auto-title**

In `apps/cli/src/run.ts`, imports:

```ts
import { maybeAutoTitle } from "@i-harness/session-title"
```

After the successful run — insert between the existing `await opts.coordinator.flush(activeId)` line and `await opts.coordinator.close()` (the title event appends into the session; close() drains it durably):

```ts
    // R-A6: first-prompt auto title after a successful run (fail-soft — LLM
    // failure degrades to the deterministic fallback; a coordinator document
    // mirror only when a session id is known).
    await maybeAutoTitle({
      session, model,
      ...(opts.coordinator && activeId ? { coordinator: opts.coordinator, sessionId: activeId } : {}),
    })
    // (existing flush/close/return lines stay; `finalText` is the executor-
    // derived terminal text from Task 5.)
```

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/session-title apps/cli/src/run.ts
git commit -m "feat(session-title): R-A6 fallback + LLM title + maybeAutoTitle (first-prompt)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 11: `plan/mode` log-only event + projection (R-A7, core-session half)

**Files:**
- Modify: `packages/core-session/src/index.ts` (union + `derivePlanMode`)
- Modify: `packages/session-persistence/src/index.ts` (registerEventType)
- Test: `packages/core-session/test/plan-mode-event.test.ts` (new)

**Interfaces:**
- Consumes: append/seq conventions.
- Produces (Task 12):

```ts
export interface PlanModeView { active: boolean; proposal?: string; eventSeq?: number }
export function derivePlanMode(session: Session): PlanModeView
```

- [ ] **Step 1: Write the failing test**

`packages/core-session/test/plan-mode-event.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, derivePlanMode, deriveSearchText } from "../src/index.ts"

describe("plan/mode event", () => {
  it("is log-only: never in deriveMessages, never in search text", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "make a plan" })
    append(s, { type: "plan/mode", mode: "on", proposal: "Step 1: ..." })
    append(s, { type: "assistant/message", text: "here is the plan" })
    expect(deriveMessages(s).map((m) => m.content)).toEqual(["make a plan", "here is the plan"])
    expect(deriveSearchText(s.events[1]!)).toBe("")
  })

  it("derivePlanMode is last-wins: off after on, proposal carried", () => {
    const s = createSession()
    append(s, { type: "plan/mode", mode: "on", proposal: "P1" })
    expect(derivePlanMode(s)).toEqual({ active: true, proposal: "P1", eventSeq: 0 })
    append(s, { type: "plan/mode", mode: "off" })
    expect(derivePlanMode(s)).toEqual({ active: false, eventSeq: 1 })
    expect(derivePlanMode(s).proposal).toBeUndefined()
  })

  it("defaults to inactive", () => {
    const s = createSession()
    expect(derivePlanMode(s)).toEqual({ active: false })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @i-harness/core-session test`
Expected: FAIL — member + function missing.

- [ ] **Step 3: Implement**

Union member (after `session/title`):

```ts
    // R-A7 plan mode: log-only mode marker + the proposal text (the proposal is
    // ALSO appended as a regular user/message when entering; this event carries
    // the mode + attribution, never model-visible itself).
    | { type: "plan/mode"; mode: "on" | "off"; proposal?: string; seq?: number }
```

Projection:

```ts
export interface PlanModeView { active: boolean; proposal?: string; eventSeq?: number }

/** Latest-wins plan-mode projection (last-wins: an "off" resets). */
export function derivePlanMode(session: Session): PlanModeView {
  let view: PlanModeView = { active: false }
  for (const ev of session.events) {
    if (ev.type !== "plan/mode") continue
    view = {
      active: ev.mode === "on",
      ...(ev.proposal !== undefined ? { proposal: ev.proposal } : {}),
      eventSeq: ev.seq ?? 0,
    }
  }
  return view
}
```

session-persistence registration:

```ts
// R-A7: plan-mode marker (log-only).
registerEventType("plan/mode")
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @i-harness/core-session test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core-session/src/index.ts packages/core-session/test/plan-mode-event.test.ts packages/session-persistence/src/index.ts
git commit -m "feat(core-session): R-A7 plan/mode log-only event + projection

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 12: `plan-mode` package — enter/exit + `exit_plan_mode` tool + CLI option (R-A7)

**Files:**
- Create: `packages/plan-mode/package.json`, `packages/plan-mode/tsconfig.json`
- Create: `packages/plan-mode/src/index.ts`
- Create: `packages/plan-mode/test/plan-mode.test.ts`
- Modify: `apps/cli/src/run.ts`

**Interfaces:**
- Consumes: `derivePlanMode` (Task 11), `append`, `Tool`/`ToolRegistry` from `@i-harness/core-tools`.
- Produces:

```ts
export const PLAN_MODE_SYSTEM_PROMPT: string
export function enterPlanMode(session: Session, proposal: string): void
export function exitPlanMode(session: Session): boolean
export function createPlanModeTools(session: Session): Tool[]
export function ensurePlanModeTool(tools: ToolRegistry, session: Session): void
export function withdrawPlanModeTool(tools: ToolRegistry): void
```

- [ ] **Step 1: Create package scaffold**

`packages/plan-mode/package.json`:

```json
{
  "name": "@i-harness/plan-mode",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-session": "workspace:*",
    "@i-harness/core-tools": "workspace:*"
  }
}
```

`packages/plan-mode/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Then `pnpm install` at repo root.

- [ ] **Step 2: Write the failing test**

`packages/plan-mode/test/plan-mode.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, derivePlanMode } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { enterPlanMode, exitPlanMode, createPlanModeTools, ensurePlanModeTool, PLAN_MODE_SYSTEM_PROMPT } from "../src/index.ts"

describe("plan mode", () => {
  it("enterPlanMode appends the mode marker AND the proposal as a user message", () => {
    const s = createSession()
    enterPlanMode(s, "1. design 2. implement")
    expect(derivePlanMode(s).active).toBe(true)
    expect(derivePlanMode(s).proposal).toBe("1. design 2. implement")
    expect(s.events.filter((e) => e.type === "user/message").map((e) => (e as { text: string }).text)).toEqual([
      "1. design 2. implement",
    ])
  })

  it("exitPlanMode appends off only when active; idempotent off", () => {
    const s = createSession()
    enterPlanMode(s, "plan")
    expect(exitPlanMode(s)).toBe(true)
    expect(derivePlanMode(s).active).toBe(false)
    expect(exitPlanMode(s)).toBe(false)
    expect(s.events.filter((e) => e.type === "plan/mode")).toHaveLength(2)
  })

  it("exit_plan_mode tool is read-only and exits when active", async () => {
    const s = createSession()
    enterPlanMode(s, "plan")
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    for (const tool of createPlanModeTools(s)) registry.register(tool)
    ensurePlanModeTool(registry, s) // idempotent second registration path? duplicate-register throws — use get guard
    const tool = registry.get("exit_plan_mode")!
    expect(tool.isReadOnly).toBe(true)
    expect(await tool.execute({}, {})).toEqual({ active: true })
    expect(derivePlanMode(s).active).toBe(false)
    expect(await tool.execute({}, {})).toEqual({ active: false })
  })

  it("the bundled prompt fragment is non-empty text", () => {
    expect(PLAN_MODE_SYSTEM_PROMPT).toContain("plan")
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @i-harness/plan-mode test`
Expected: FAIL — package missing.

- [ ] **Step 4: Implement `src/index.ts`**

```ts
import type { Session } from "@i-harness/core-session"
import { append, derivePlanMode } from "@i-harness/core-session"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"

export const PLAN_MODE_SYSTEM_PROMPT =
  "You are in PLAN MODE. Produce a concrete plan (steps, files, order) as your reply. " +
  "Never execute file changes, shell commands, or any other side-effecting tool. " +
  "When your plan is complete, call exit_plan_mode."

export function enterPlanMode(session: Session, proposal: string): void {
  append(session, { type: "plan/mode", mode: "on", proposal })
  append(session, { type: "user/message", text: proposal })
}

export function exitPlanMode(session: Session): boolean {
  if (!derivePlanMode(session).active) return false
  append(session, { type: "plan/mode", mode: "off" })
  return true
}

export function createPlanModeTools(session: Session): Tool[] {
  return [{
    name: "exit_plan_mode",
    description: "Signal that the plan is complete and plan mode should end. No arguments.",
    inputSchema: { type: "object", properties: undefined, required: undefined },
    isReadOnly: true,
    execute: async () => ({ active: exitPlanMode(session) }),
  }]
}

export function ensurePlanModeTool(tools: ToolRegistry, session: Session): void {
  if (tools.get("exit_plan_mode")) return
  for (const tool of createPlanModeTools(session)) tools.register(tool)
}

export function withdrawPlanModeTool(tools: ToolRegistry): void {
  tools.unregister("exit_plan_mode")
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @i-harness/plan-mode test`
Expected: PASS.

- [ ] **Step 6: Wire the CLI option**

`apps/cli/src/run.ts` — `HeadlessOptions` gains:

```ts
  planMode?: boolean // R-A7: start in plan mode (proposal = the task text; exit_plan_mode tool mounted; prompt fragment appended)
```

Imports:

```ts
import { PLAN_MODE_SYSTEM_PROMPT, ensurePlanModeTool } from "@i-harness/plan-mode"
```

In the systemPrompt composition (near the sandbox policy):

```ts
    let systemPrompt = "You are a coding agent."
    if (opts.planMode) systemPrompt = `${systemPrompt}\n\n${PLAN_MODE_SYSTEM_PROMPT}`
```

After `createAgent` (before the executor section):

```ts
    if (opts.planMode) {
      ensurePlanModeTool(tools, session)
      enterPlanMode(session, task)
    }
```

(import `enterPlanMode` too.)

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/plan-mode apps/cli/src/run.ts
git commit -m "feat(plan-mode): R-A7 plan/mode enter-exit + exit_plan_mode tool + CLI option

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 13: core-tools approval guardian seam (R-A9 seam)

**Files:**
- Modify: `packages/core-tools/src/index.ts` (types + evaluate in `prepare`)
- Test: `packages/core-tools/test/guardian-seam.test.ts` (new)

**Interfaces:**
- Consumes: existing `prepare` ask-branch (`approval/answerer` service lookup, F05-5).
- Produces (Tasks 14-16):

```ts
export interface GuardianRequest { name: string; reason: string; args: unknown }
export interface GuardianVerdict { outcome: "approve" | "allow" | "deny"; rationale: string }
export type ApprovalGuardian = (req: GuardianRequest) => Promise<GuardianVerdict>
```

Semantics: the guardian runs BEFORE the human answerer for `ask` decisions.
- `deny` ⇒ throw `guardian denied: <rationale>` (fail-closed tool failure, same shape as a user denial);
- `approve` ⇒ auto-approve (human answerer skipped);
- `allow` ⇒ consult the human answerer as before.
Service absent ⇒ behavior byte-identical.

- [ ] **Step 1: Write the failing test**

`packages/core-tools/test/guardian-seam.test.ts` (mirrors `tools.test.ts` conventions — read it first for the exact makeContext helper):

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool, type GuardianVerdict } from "../src/index.ts"

function setup(answerer: (() => Promise<boolean>) | undefined, guardian: (() => Promise<GuardianVerdict>) | undefined) {
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  const tool: Tool = {
    name: "write",
    description: "write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    isReadOnly: false,
    execute: async () => ({ ok: true }),
  }
  registry.register(tool)
  // mimic guard-approval's ask classification with a bare waterfall seed — the
  // guardian seam only cares that the resolved decision is an ask.
  let answererCalled = 0
  let guardianCalled = 0
  ctx.waterfall("tools/pre-execute", async (payload, next) => {
    const chain = await next(payload)
    const call = payload as { name?: string }
    if (call.name === "write") return { kind: "ask", reason: "non-readonly tool" }
    return chain
  })
  if (answerer) {
    ctx.services.register("approval/answerer", async () => {
      answererCalled += 1
      return answerer()
    })
  }
  if (guardian) {
    ctx.services.register("approval/guardian", async () => {
      guardianCalled += 1
      return guardian()
    })
  }
  return { ctx, registry, counts: () => ({ answererCalled, guardianCalled }) }
}

describe("approval guardian seam", () => {
  it("deny short-circuits without touching the answerer", async () => {
    const { registry, counts } = setup(
      async () => { throw new Error("answerer must not run") },
      async () => ({ outcome: "deny", rationale: "rm -rf is extreme" }),
    )
    await expect(registry.execute({ name: "write", args: { path: "." } })).rejects.toThrow(/guardian denied: rm -rf is extreme/)
    const c = counts()
    expect(c.guardianCalled).toBe(1)
    expect(c.answererCalled).toBe(0)
  })

  it("approve auto-approves; the answerer is skipped", async () => {
    const { registry, counts } = setup(
      async () => { throw new Error("answerer must not run") },
      async () => ({ outcome: "approve", rationale: "trusted rule" }),
    )
    const result = await registry.execute({ name: "write", args: { path: "x" } })
    expect(result.output).toEqual({ ok: true })
    expect(counts().answererCalled).toBe(0)
  })

  it("allow defers to the human answerer", async () => {
    const { registry, counts } = setup(
      async () => true,
      async () => ({ outcome: "allow", rationale: "ask the user" }),
    )
    await registry.execute({ name: "write", args: { path: "x" } })
    expect(counts().answererCalled).toBe(1)
  })

  it("absent guardian keeps the pre-R-A9 behavior (answerer alone)", async () => {
    const { registry, counts } = setup(async () => true, undefined)
    await registry.execute({ name: "write", args: { path: "x" } })
    expect(counts().guardianCalled).toBe(0)
    expect(counts().answererCalled).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @i-harness/core-tools test`
Expected: FAIL — guardian not consulted (write executes with answerer throw / or fails at "no answerer" — the deny test fails because the answerer throw surfaces instead of the guardian deny).

- [ ] **Step 3: Implement the seam**

In `packages/core-tools/src/index.ts`, near `ApprovalAnswerer` (line ~100):

```ts
export interface GuardianRequest { name: string; reason: string; args: unknown }
export interface GuardianVerdict { outcome: "approve" | "allow" | "deny"; rationale: string }
export type ApprovalGuardian = (req: GuardianRequest) => Promise<GuardianVerdict>
```

In `prepare`, replace the existing `if (resolved.kind === "ask") { ... }` block (current source lines 235-247: the answerer lookup + boolean decision) with:

```ts
    const askHuman = async (): Promise<void> => {
      let answerer: ApprovalAnswerer | null = null
      try {
        answerer = ctx.services.get<ApprovalAnswerer>("approval/answerer")
      } catch {
        answerer = null
      }
      if (!answerer) {
        throw new Error(`approval required but no answerer registered (fail closed): ${resolved.reason}`)
      }
      const ok = await answerer({ name: call.name, reason: resolved.reason })
      if (!ok) throw new Error(`denied by user: ${resolved.reason}`)
    }
    if (resolved.kind === "ask") {
      // R-A9 guardian: runtime review before the human approval decision.
      // deny → fail-closed; approve → auto-approve (skip the answerer);
      // allow → human answerer as before. Absent → pre-R-A9 behavior.
      let guardian: ApprovalGuardian | undefined
      try {
        guardian = ctx.services.get<ApprovalGuardian>("approval/guardian")
      } catch {
        guardian = undefined
      }
      if (guardian) {
        const verdict = await guardian({ name: call.name, reason: resolved.reason, args: call.args })
        if (verdict.outcome === "deny") throw new Error(`guardian denied: ${verdict.rationale}`)
        if (verdict.outcome === "allow") await askHuman()
      } else {
        await askHuman()
      }
    }
```

The pre-existing ask branch is unchanged in shape (fail-closed on a missing answerer — F05-5 preserved); adding the guardian only precedes it.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @i-harness/core-tools test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core-tools/src/index.ts packages/core-tools/test/guardian-seam.test.ts
git commit -m "feat(core-tools): R-A9 approval guardian seam (deny/approve/allow)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 14: guardian verdict parser + circuit breaker (pure logic, R-A9)

**Files:**
- Create: `packages/guard-approval/src/guardian/verdict.ts`
- Create: `packages/guard-approval/src/guardian/breaker.ts`
- Modify: `packages/guard-approval/src/index.ts` (re-exports)
- Test: `packages/guard-approval/test/guardian-verdict.test.ts` (new)

**Interfaces:**
- Consumes: `GuardianVerdict` from Task 13 (core-tools type), `SessionCoordinator` from `@i-harness/session-persistence`.
- Produces (Tasks 15, 16):

```ts
// verdict.ts
export const GUARDIAN_JSON_CONTRACT: string
export interface ParsedGuardianAssessment {
  outcome: "approve" | "allow" | "deny"
  rationale: string
  riskLevel: "none" | "moderate" | "high"
}
export function parseGuardianAssessment(text: string): ParsedGuardianAssessment | undefined

// breaker.ts
export interface GuardianBreakerState { formatVersion: 1; window: ("deny" | "allow")[] }
export class GuardianBreaker {
  constructor(restored?: GuardianBreakerState)
  check(): "closed" | "open"
  record(outcome: GuardianVerdict["outcome"]): void
  snapshot(): GuardianBreakerState
}
export function isGuardianBreakerState(value: unknown): value is GuardianBreakerState
```

- [ ] **Step 1: Write the failing test**

`packages/guard-approval/test/guardian-verdict.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { parseGuardianAssessment, GUARDIAN_JSON_CONTRACT } from "../src/guardian/verdict.ts"
import { GuardianBreaker, isGuardianBreakerState } from "../src/guardian/breaker.ts"

const VALID = '{"outcome":"deny","rationale":"deletes outside the workspace","risk_level":"high"}'

describe("parseGuardianAssessment", () => {
  it("parses the strict JSON contract", () => {
    const a = parseGuardianAssessment(VALID)!
    expect(a.outcome).toBe("deny")
    expect(a.rationale).toBe("deletes outside the workspace")
    expect(a.riskLevel).toBe("high")
  })

  it("rejects fenced JSON, trailing prose, missing fields, bad enums", () => {
    expect(parseGuardianAssessment('```json\n' + VALID + '\n```')).toBeUndefined()
    expect(parseGuardianAssessment(VALID + " extra text")).toBeUndefined()
    expect(parseGuardianAssessment('{"outcome":"deny"}')).toBeUndefined()
    expect(parseGuardianAssessment('{"outcome":"maybe","rationale":"x","risk_level":"high"}')).toBeUndefined()
    expect(parseGuardianAssessment('{"outcome":"deny","rationale":"","risk_level":"high"}')).toBeUndefined()
    expect(parseGuardianAssessment("not json")).toBeUndefined()
  })

  it("the contract string names the enum values exactly", () => {
    expect(GUARDIAN_JSON_CONTRACT).toContain("approve")
    expect(GUARDIAN_JSON_CONTRACT).toContain("allow")
    expect(GUARDIAN_JSON_CONTRACT).toContain("deny")
  })
})

describe("GuardianBreaker", () => {
  it("opens after 3 denials in the last 10 reviews", () => {
    const b = new GuardianBreaker()
    expect(b.check()).toBe("closed")
    b.record("deny"); b.record("deny"); b.record("allow")
    expect(b.check()).toBe("closed")
    b.record("deny")
    expect(b.check()).toBe("open")
  })

  it("a window of 10 keeps only the last 10 reviews (old denials age out)", () => {
    const b = new GuardianBreaker()
    for (let i = 0; i < 9; i += 1) b.record("allow")
    b.record("deny") // 10th
    expect(b.check()).toBe("closed")
    // now push the old deny out: 10 more allows
    for (let i = 0; i < 9; i += 1) b.record("allow")
    expect(b.check()).toBe("closed")
  })

  it("restores from a persisted snapshot and guards the shape", () => {
    const b = new GuardianBreaker({ formatVersion: 1, window: ["deny", "deny", "deny"] })
    expect(b.check()).toBe("open")
    expect(isGuardianBreakerState({ formatVersion: 1, window: [] })).toBe(true)
    expect(isGuardianBreakerState(null)).toBe(false)
    expect(isGuardianBreakerState({ formatVersion: 2, window: [] })).toBe(false)
    expect(b.snapshot().window).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @i-harness/guard-approval test`
Expected: FAIL — files missing.

- [ ] **Step 3: Implement `verdict.ts`**

`packages/guard-approval/src/guardian/verdict.ts`:

```ts
export const GUARDIAN_JSON_CONTRACT =
  'Output STRICT JSON only — one object, no fences, no prose: ' +
  '{"outcome":"approve"|"allow"|"deny","rationale":"<1-2 sentence reason>","risk_level":"none"|"moderate"|"high"} ' +
  "outcome=deny never executes; outcome=approve proceeds without asking the user; outcome=allow asks the user."

export interface ParsedGuardianAssessment {
  outcome: "approve" | "allow" | "deny"
  rationale: string
  riskLevel: "none" | "moderate" | "high"
}

const OUTCOMES = new Set(["approve", "allow", "deny"])
const RISK_LEVELS = new Set(["none", "moderate", "high"])

// Strict JSON contract (codex parse_guardian_assessment re-implementation):
// the WHOLE output must be one JSON object with the exact enum values and a
// non-empty rationale. Fences, trailing prose or any extra field ⇒ undefined
// (the caller fails closed by denying). Extra FIELDS are tolerated (additive
// forwards-compat) but the three required fields must be present.
export function parseGuardianAssessment(text: string): ParsedGuardianAssessment | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.outcome !== "string" || !OUTCOMES.has(v.outcome)) return undefined
  if (typeof v.risk_level !== "string" || !RISK_LEVELS.has(v.risk_level)) return undefined
  if (typeof v.rationale !== "string" || v.rationale.trim().length === 0) return undefined
  return {
    outcome: v.outcome as ParsedGuardianAssessment["outcome"],
    rationale: v.rationale.trim(),
    riskLevel: v.risk_level as ParsedGuardianAssessment["riskLevel"],
  }
}
```

- [ ] **Step 4: Implement `breaker.ts`**

`packages/guard-approval/src/guardian/breaker.ts`:

```ts
import type { GuardianVerdict } from "@i-harness/core-tools"

export const GUARDIAN_BREAKER_WINDOW = 10
export const GUARDIAN_BREAKER_DENY_LIMIT = 3

export interface GuardianBreakerState {
  formatVersion: 1
  /** Sliding window of review outcomes, newest last. */
  window: ("deny" | "allow")[]
}

// R-A9 circuit breaker (codex GuardianRejectionCircuitBreaker, re-implemented):
// count deny verdicts in the last 10 reviews — >= 3 ⇒ open ⇒ all further
// reviews deny WITHOUT an LLM call. Only MODEL verdicts are recorded here:
// timeouts/parse failures deny fail-closed but are not "model disagreement"
// and do not trip the breaker.
export class GuardianBreaker {
  private window: ("deny" | "allow")[] = []

  constructor(restored?: GuardianBreakerState) {
    if (restored && isGuardianBreakerState(restored)) this.window = [...restored.window]
  }

  check(): "closed" | "open" {
    const denials = this.window.filter((w) => w === "deny").length
    return denials >= GUARDIAN_BREAKER_DENY_LIMIT ? "open" : "closed"
  }

  record(outcome: GuardianVerdict["outcome"]): void {
    const kind: "deny" | "allow" = outcome === "deny" ? "deny" : "allow"
    this.window.push(kind)
    if (this.window.length > GUARDIAN_BREAKER_WINDOW) {
      this.window = this.window.slice(-GUARDIAN_BREAKER_WINDOW)
    }
  }

  snapshot(): GuardianBreakerState {
    return { formatVersion: 1, window: [...this.window] }
  }
}

export function isGuardianBreakerState(value: unknown): value is GuardianBreakerState {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return v.formatVersion === 1 && Array.isArray(v.window)
    && v.window.every((w) => w === "deny" || w === "allow")
}
```

- [ ] **Step 5: Re-export from the package index**

`packages/guard-approval/src/index.ts` (bottom):

```ts
export { parseGuardianAssessment, GUARDIAN_JSON_CONTRACT } from "./guardian/verdict.ts"
export type { ParsedGuardianAssessment } from "./guardian/verdict.ts"
export { GuardianBreaker, isGuardianBreakerState, GUARDIAN_BREAKER_WINDOW, GUARDIAN_BREAKER_DENY_LIMIT } from "./guardian/breaker.ts"
export type { GuardianBreakerState } from "./guardian/breaker.ts"
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter @i-harness/guard-approval test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/guard-approval/src/guardian packages/guard-approval/src/index.ts packages/guard-approval/test/guardian-verdict.test.ts
git commit -m "feat(guard-approval): R-A9 strict guardian JSON parser + sliding circuit breaker

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 15: guardian reviewer subagent + `registerGuardian` (R-A9 core)

**Files:**
- Create: `packages/guard-approval/src/guardian/reviewer.ts`
- Create: `packages/guard-approval/src/guardian/index.ts`
- Modify: `packages/guard-approval/package.json` (add workspace deps)
- Modify: `packages/guard-approval/src/index.ts` (re-exports)
- Test: `packages/guard-approval/test/guardian-review.test.ts` (new)

**Interfaces:**
- Consumes: `spawnChild`/`SpawnOptions`/`RoleRegistry`/`AgentTable`/`JobRegistry`/`AgentRegistry` from `@i-harness/subagent` (read `packages/subagent/src/child.ts` + `roles.ts` first), `GuardianVerdict`/`GuardianRequest` (Task 13), `parseGuardianAssessment`/`GuardianBreaker`/`isGuardianBreakerState` (Task 14), `deriveSearchText` for the transcript, `PluginContext`.
- Produces (Task 16):

```ts
export const GUARDIAN_REVIEW_TIMEOUT_MS = 90_000
export const GUARDIAN_REVIEWER_ROLE_NAME = "reviewer"
export const BUNDLED_GUARDIAN_POLICY: string
export interface GuardianReviewDeps {
  subagents: { roles: RoleRegistry; jobs: JobRegistry; table: AgentTable; agents: AgentRegistry }
  parentRegistry: ToolRegistry
  parentSession: Session
  parentCtx: PluginContext
  providers: ProviderRegistry
  parentModel: ModelClient
  model?: ModelClient
  timeoutMs?: number
  policyText?: string
  childSessions?: SpawnOptions extends { childSessions?: infer T } ? T : never
}
export function ensureReviewerRole(roles: RoleRegistry): SubagentRole
export function renderGuardianMessage(request: GuardianRequest, context: string): string
export function renderRecentContext(session: Session, opts?: { maxChars?: number; maxEvents?: number }): string
export async function runGuardianReview(deps: GuardianReviewDeps, request: GuardianRequest): Promise<GuardianVerdict>
export interface GuardianConfig extends GuardianReviewDeps { breaker?: { coordinator: SessionCoordinator; sessionId: string } }
export function registerGuardian(ctx: PluginContext, config: GuardianConfig): void
```

Behavior contract (fail-closed): timeout ⇒ `{outcome:"deny", rationale:"guardian review timed out after <N>ms"}`; run failure or no output ⇒ deny; malformed output ⇒ deny with `"guardian review produced malformed output (fail-closed)"`. Circuit breaker open ⇒ deny immediately (`"guardian circuit breaker open (3+ denials in the last 10 reviews)"`).

- [ ] **Step 1: Add dependencies**

`packages/guard-approval/package.json` — add to `dependencies`:

```json
    "@i-harness/core-session": "workspace:*",
    "@i-harness/llm-seam": "workspace:*",
    "@i-harness/provider": "workspace:*",
    "@i-harness/session-persistence": "workspace:*",
    "@i-harness/subagent": "workspace:*"
```

Then `pnpm install` at repo root.

- [ ] **Step 2: Write the failing test**

`packages/guard-approval/test/guardian-review.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { createProviderRegistry } from "@i-harness/provider"
import { createExecService } from "@i-harness/exec"
import { registerSubagent } from "@i-harness/subagent"
import type { GuardianRequest } from "@i-harness/core-tools"
import { registerGuardian, runGuardianReview, ensureReviewerRole, renderGuardianMessage } from "../src/guardian/index.ts"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import { createApprovalPolicy } from "../src/index.ts"

function makeSubagents(ctx: PluginContext, parentRegistry: ReturnType<typeof createToolRegistry>, parentSession: ReturnType<typeof createSession>, model: ReturnType<typeof createMockClient>) {
  const exec = createExecService()
  const providers = createProviderRegistry()
  const sub = registerSubagent(ctx, parentRegistry, {
    providers, exec, parentModel: model, parentSession,
  })
  return { exec, providers, sub }
}

describe("guardian review", () => {
  it("registers the reviewer role once and keeps an existing one", () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    const session = createSession()
    const { sub } = makeSubagents(ctx, reg, session, createMockClient([{ role: "assistant", text: "ok" }]))
    const role = ensureReviewerRole(sub.roles)
    expect(role.name).toBe("reviewer")
    expect(role.tools).toEqual([])
    expect(ensureReviewerRole(sub.roles)).toBe(role)
  })

  it("renders a bounded message containing the request facts", () => {
    const msg = renderGuardianMessage(
      { name: "bash", reason: "dangerous command", args: { command: "rm -rf /x" } },
      "last step: read data.txt",
    )
    expect(msg).toContain("rm -rf /x")
    expect(msg).toContain("dangerous command")
    expect(msg).toContain("last step: read data.txt")
    expect(msg).toContain('"outcome"')
  })

  it("runGuardianReview returns the model's verdict (approve)", async () => {
    const ctx = createContext()
    const parentRegistry = createToolRegistry(ctx)
    const parentSession = createSession()
    const reviewerModel = createMockClient([
      { role: "assistant", text: '{"outcome":"approve","rationale":"safe inside workspace","risk_level":"none"}' },
    ])
    const { sub } = makeSubagents(ctx, parentRegistry, parentSession, reviewerModel)
    const verdict = await runGuardianReview({
      subagents: sub, parentRegistry, parentSession, parentCtx: ctx,
      providers: createProviderRegistry(), parentModel: reviewerModel,
      model: reviewerModel,
    }, { name: "write", reason: "write to ./x", args: { path: "./x" } })
    expect(verdict.outcome).toBe("approve")
    expect(verdict.rationale).toContain("workspace")
    // transient reviewer is cleaned up
    expect(sub.table.entries().size).toBe(0)
    expect(sub.agents.entries().size).toBe(0)
  })

  it("malformed output denies fail-closed", async () => {
    const ctx = createContext()
    const parentRegistry = createToolRegistry(ctx)
    const parentSession = createSession()
    const reviewerModel = createMockClient([
      { role: "assistant", text: "I think it is fine." },
    ])
    const { sub } = makeSubagents(ctx, parentRegistry, parentSession, reviewerModel)
    const verdict = await runGuardianReview({
      subagents: sub, parentRegistry, parentSession, parentCtx: ctx,
      providers: createProviderRegistry(), parentModel: reviewerModel,
      model: reviewerModel,
    }, { name: "write", reason: "r", args: { path: "x" } })
    expect(verdict.outcome).toBe("deny")
    expect(verdict.rationale).toContain("malformed")
  })

  it("registerGuardian runs the full pipeline: deny skips the human answerer", async () => {
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    const session = createSession()
    // NOTE: the tool must NOT be one of guard-approval's special cases
    // (bash/pwsh/write) — those are classified on argv/path and an inside-
    // workspace `write` produces NO ask. A generic non-readOnly tool hits
    // Layer-1 fallback ("tool '...' requires approval") → ask fires.
    const tool = {
      name: "publish_artifact", description: "publish", inputSchema: { type: "object" },
      isReadOnly: false, execute: async () => ({ ok: true }),
    }
    registry.register(tool)
    createApprovalPolicy(ctx, registry, { workspace: process.cwd() })
    registerApprovalAnswerer(ctx, async () => { throw new Error("human answerer must not run") })
    const reviewerModel = createMockClient([
      { role: "assistant", text: '{"outcome":"deny","rationale":"no publishing today","risk_level":"high"}' },
    ])
    const { sub } = makeSubagents(ctx, registry, session, reviewerModel)
    await registerGuardian(ctx, {
      subagents: sub, parentRegistry: registry, parentSession: session, parentCtx: ctx,
      providers: createProviderRegistry(), parentModel: reviewerModel, model: reviewerModel,
    })
    await expect(registry.execute({ name: "publish_artifact", args: { tag: "1.0" } })).rejects.toThrow(/guardian denied: no publishing today/)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @i-harness/guard-approval test`
Expected: FAIL — `guardian/index.ts` missing.

- [ ] **Step 4: Implement `reviewer.ts`**

`packages/guard-approval/src/guardian/reviewer.ts` (complete file):

```ts
import { randomUUID } from "node:crypto"
import type { PluginContext } from "@i-harness/core-plugin"
import { deriveSearchText, type Session } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"
import type { ProviderRegistry } from "@i-harness/provider"
import {
  spawnChild,
  type AgentRegistry, type AgentTable, type JobRegistry, type RoleRegistry,
  type SpawnOptions, type SubagentRole,
} from "@i-harness/subagent"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { GuardianRequest, GuardianVerdict } from "@i-harness/core-tools"
import { GUARDIAN_JSON_CONTRACT, parseGuardianAssessment } from "./verdict.ts"

export const GUARDIAN_REVIEW_TIMEOUT_MS = 90_000
export const GUARDIAN_REVIEWER_ROLE_NAME = "reviewer"

export const BUNDLED_GUARDIAN_POLICY =
  "You are the approval guardian. A tool call needs approval, and you decide whether it may " +
  "execute without bothering the user. Deny destructive or anomalous actions, especially " +
  "outside-workspace writes, destructive shell commands (rm/del/wipe), or privilege escalations. " +
  "Approve only clearly safe, in-scope, low-risk actions. When uncertain, deny."

export interface GuardianReviewDeps {
  subagents: {
    roles: RoleRegistry
    jobs: JobRegistry
    table: AgentTable
    agents: AgentRegistry
  }
  parentRegistry: ToolRegistry
  parentSession: Session
  parentCtx: PluginContext
  providers: ProviderRegistry
  parentModel: ModelClient
  /** Dedicated reviewer model (defaults to the parent model). */
  model?: ModelClient
  /** Default 90_000 (fail-closed on timeout). */
  timeoutMs?: number
  /** Injected approval policy (defaults to BUNDLED_GUARDIAN_POLICY). */
  policyText?: string
  childSessions?: SpawnOptions["childSessions"]
}

// A dedicated role (codex `approvals_reviewer`): no tools — the reviewer is
// read-only by construction (it may not execute anything while reviewing).
export function ensureReviewerRole(roles: RoleRegistry): SubagentRole {
  const existing = roles.get(GUARDIAN_REVIEWER_ROLE_NAME)
  if (existing) return existing
  const role: SubagentRole = {
    name: GUARDIAN_REVIEWER_ROLE_NAME,
    description: "Approval guardian: assesses pending tool actions and returns strict JSON verdicts.",
    systemPrompt: BUNDLED_GUARDIAN_POLICY,
    tools: [],
  }
  roles.register(role)
  return role
}

/** Bounded recent-context transcript for the reviewer (codex transcript concept). */
export function renderRecentContext(session: Session, opts: { maxChars?: number; maxEvents?: number } = {}): string {
  const maxChars = opts.maxChars ?? 4_000
  const maxEvents = opts.maxEvents ?? 12
  const tail = session.events.slice(-maxEvents)
  const parts: string[] = []
  let used = 0
  for (const ev of tail) {
    if (ev.type === "assistant/chunk") continue
    let line = ""
    try {
      line = `${ev.type}: ${deriveSearchText(ev)}`
    } catch {
      line = `${ev.type}`
    }
    if (line.trim().length === 0) continue
    used += line.length + 1
    if (used > maxChars) break
    parts.push(line.slice(0, 200))
  }
  return parts.join("\n")
}

export function renderGuardianMessage(
  request: GuardianRequest,
  context: string,
  policy: string = BUNDLED_GUARDIAN_POLICY,
): string {
  const args = typeof request.args === "string" ? request.args : JSON.stringify(request.args ?? null)
  return [
    "An agent requests execution of a tool call. Decide: approve (execute now, never ask the user),",
    "allow (ask the user first), or deny (never execute).",
    "",
    "<request>",
    `tool: ${request.name}`,
    `approval reason: ${request.reason}`,
    `arguments: ${args.slice(0, 4_000)}`,
    "</request>",
    "",
    "<recent_context>",
    context.slice(0, 4_000),
    "</recent_context>",
    "",
    "Policy:",
    policy,
    "",
    GUARDIAN_JSON_CONTRACT,
  ].join("\n")
}

// R-A9 reviewer runner: spawns the dedicated reviewer subagent via the EXISTING
// subagent machinery (spawnChild, forkTurns "none" — the reviewer sees only the
// request + bounded transcript), races a timeout (fail-closed → deny), parses
// the strict JSON verdict, and reclaims the transient child in a finally.
export async function runGuardianReview(deps: GuardianReviewDeps, request: GuardianRequest): Promise<GuardianVerdict> {
  const role = ensureReviewerRole(deps.subagents.roles)
  const timeoutMs = deps.timeoutMs ?? GUARDIAN_REVIEW_TIMEOUT_MS
  const model = deps.model ?? deps.parentModel
  const message = renderGuardianMessage(request, renderRecentContext(deps.parentSession), deps.policyText ?? BUNDLED_GUARDIAN_POLICY)
  const { path, jobId, sessionId } = await spawnChild({
    taskName: `review-${randomUUID().slice(0, 8)}`,
    message,
    parentPath: "root",
    parentRegistry: deps.parentRegistry,
    parentSession: deps.parentSession,
    parentCtx: deps.parentCtx,
    role,
    parentModel: model,
    providers: deps.providers,
    jobs: deps.subagents.jobs,
    table: deps.subagents.table,
    agents: deps.subagents.agents,
    forkTurns: "none",
    ...(deps.childSessions !== undefined ? { childSessions: deps.childSessions } : {}),
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
    timer.unref?.()
  })

  try {
    const entry = deps.subagents.table.get(path)
    if (entry === undefined) return { outcome: "deny", rationale: "guardian review failed: reviewer entry missing" }
    const settled = await Promise.race([
      entry.followupChain ?? Promise.resolve(),
      timeout,
    ])
    if (settled === "timeout") {
      entry.controller.abort()
      return { outcome: "deny", rationale: `guardian review timed out after ${timeoutMs}ms (fail-closed)` }
    }
    const finalText = entry.finalText
    if (finalText === undefined) {
      return { outcome: "deny", rationale: `guardian review failed: ${entry.error ?? "no output"}` }
    }
    const parsed = parseGuardianAssessment(finalText)
    if (parsed === undefined) {
      return { outcome: "deny", rationale: "guardian review produced malformed output (fail-closed)" }
    }
    return { outcome: parsed.outcome, rationale: parsed.rationale }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Transient reviewer: reclaim resources (mirror of close_agent — abort,
    // unmount the child scope, drop from the subagent registries).
    const entry = deps.subagents.table.get(path)
    if (entry) {
      entry.controller.abort()
      entry.unmount?.()
      deps.subagents.table.remove(path)
      if (sessionId) deps.subagents.agents.remove(sessionId)
    }
    if (jobId) {
      try { deps.subagents.jobs.kill(jobId) } catch { /* best-effort */ }
    }
  }
}
```

- [ ] **Step 5: Implement `guardian/index.ts`**

`packages/guard-approval/src/guardian/index.ts` (complete file):

```ts
import type { PluginContext } from "@i-harness/core-plugin"
import type { ApprovalGuardian, GuardianRequest, GuardianVerdict } from "@i-harness/core-tools"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { GuardianBreaker, isGuardianBreakerState } from "./breaker.ts"
import { runGuardianReview, type GuardianReviewDeps } from "./reviewer.ts"

export { runGuardianReview, ensureReviewerRole, renderGuardianMessage, renderRecentContext, BUNDLED_GUARDIAN_POLICY, GUARDIAN_REVIEW_TIMEOUT_MS, GUARDIAN_REVIEWER_ROLE_NAME } from "./reviewer.ts"
export type { GuardianReviewDeps } from "./reviewer.ts"

export interface GuardianConfig extends GuardianReviewDeps {
  /** Durable breaker mirror (subagent state-doc pattern — coordinator documents). */
  breaker?: { coordinator: SessionCoordinator; sessionId: string }
}

const BREAKER_STATE_PREFIX = "guardian:"

const isGuardianVerdict = (value: unknown): value is GuardianVerdict => {
  const v = value as GuardianVerdict
  return typeof v === "object" && v !== null &&
    (v.outcome === "approve" || v.outcome === "allow" || v.outcome === "deny") &&
    typeof v.rationale === "string"
}

// R-A9 mount: registers the `approval/guardian` service consumed by core-tools'
// ask branch (Task 13). Fail-closed: open breaker / timeout / malformed output
// ⇒ deny; only `allow` falls through to the human answerer. The breaker mirror
// restores best-effort (an unreadable doc → fresh breaker — fresh = closed,
// which can only over-grant... no: fresh-closed means reviews run; the breaker
// only opens on model denials, so a lost doc merely forgets recent denials —
// admission of that risk is documented; the fail-closed path is the per-review
// deny outcome, not the breaker).
export async function registerGuardian(ctx: PluginContext, config: GuardianConfig): Promise<void> {
  let breaker: GuardianBreaker | undefined
  if (config.breaker) {
    const key = BREAKER_STATE_PREFIX + config.breaker.sessionId
    try {
      const restored = await config.breaker.coordinator.getDocument(key)
      breaker = new GuardianBreaker(isGuardianBreakerState(restored) ? restored : undefined)
    } catch {
      breaker = new GuardianBreaker()
    }
  }

  const review: ApprovalGuardian = async (request: GuardianRequest): Promise<GuardianVerdict> => {
    if (breaker?.check() === "open") {
      return { outcome: "deny", rationale: "guardian circuit breaker open (3+ denials in the last 10 reviews)" }
    }
    const verdict = await runGuardianReview(config, request)
    if (isGuardianVerdict(verdict) && breaker && config.breaker) {
      breaker.record(verdict.outcome)
      const key = BREAKER_STATE_PREFIX + config.breaker.sessionId
      // fail-soft doc mirror: putDocument reports internally and never rejects
      void config.breaker.coordinator.putDocument(key, breaker.snapshot())
    }
    return verdict
  }
  ctx.services.register("approval/guardian", review)
}
```

- [ ] **Step 6: Re-export from package index.ts**

`packages/guard-approval/src/index.ts` (bottom):

```ts
export { registerGuardian } from "./guardian/index.ts"
export type { GuardianConfig, GuardianReviewDeps } from "./guardian/index.ts"
export { runGuardianReview, ensureReviewerRole, renderGuardianMessage, renderRecentContext, BUNDLED_GUARDIAN_POLICY, GUARDIAN_REVIEW_TIMEOUT_MS, GUARDIAN_REVIEWER_ROLE_NAME } from "./guardian/index.ts"
```

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm --filter @i-harness/guard-approval test`
Expected: PASS. If the reviewer integration test flakes on timing (spawned turn settle), poll `entry.followupChain` — the race is already `Promise.race` against the 90s timeout, so a slow CI is still bounded; the only flake mode is the timeout firing on an overloaded CI — raise `timeoutMs: 5_000` in the unit tests.

- [ ] **Step 8: Commit**

```bash
git add packages/guard-approval/src/guardian packages/guard-approval/src/index.ts packages/guard-approval/package.json packages/guard-approval/test/guardian-review.test.ts pnpm-lock.yaml
git commit -m "feat(guard-approval): R-A9 guardian reviewer subagent + registerGuardian

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 16: CLI guardian wiring (R-A9 surface)

**Files:**
- Modify: `apps/cli/src/run.ts` (HeadlessOptions + mount)
- Test: `apps/cli/test/guardian.test.ts` (new)

**Interfaces:**
- Consumes: `registerGuardian` (Task 15), the `registerSubagent` result already in run.ts, `provider` registry.
- Produces: `HeadlessOptions.guardian?: { policy?: string; timeoutMs?: number; model?: ModelClient }`.

- [ ] **Step 1: Write the failing test**

`apps/cli/test/guardian.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadless } from "../src/run.ts"
import { createMockClient } from "@i-harness/llm-mock"

describe("CLI guardian", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-guard-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("denying reviewer fails the turn closed with the rationale", async () => {
    // `write` to a path OUTSIDE the workspace triggers the approval classifier
    // ("write target outside workspace requires approval" → ask branch fires,
    // the guardian is consulted before completion). The agent's tool call
    // therefore never executes; a second script step would leave the mock with
    // an unused step (harmless).
    const parentModel = createMockClient([
      { role: "assistant", toolCalls: [{ name: "write", args: { path: join(dir, "..", "outside.txt"), content: "x" } }] },
    ])
    const reviewerModel = createMockClient([
      { role: "assistant", text: '{"outcome":"deny","rationale":"writes are denied today","risk_level":"moderate"}' },
    ])
    const result = await runHeadless("write the file", {
      workspace: dir,
      model: parentModel,
      guardian: { model: reviewerModel },
    })
    expect(result.exitCode).toBe(1)
    expect(result.error).toMatch(/guardian denied: writes are denied today/)
  })

  it("is inert when guardian is not configured", async () => {
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const result = await runHeadless("hello", { workspace: dir, model })
    expect(result.exitCode).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @i-harness/cli test -- guardians`
Expected: FAIL — `guardian` is not a HeadlessOptions key and no reviewer runs (the first test gets `denied by user`-ish or passes through approval differently — either way the assertion does not match `/guardian denied/`).

- [ ] **Step 3: Wire `run.ts`**

HeadlessOptions:

```ts
  guardian?: { policy?: string; timeoutMs?: number; model?: ModelClient } // R-A9: auto-approval guardian reviewer
```

Imports:

```ts
import { registerGuardian } from "@i-harness/guard-approval"
```

The subagent mount site already destructures `const providers = createProviderRegistry()` inside `registerSubagent(...)` — hoist it:

```ts
    const providers = createProviderRegistry()
    const subagent = registerSubagent(ctx, tools, {
      providers,
      ...
    })
```

After `const subagent = registerSubagent(...)` (before `await subagent.ready` or right after — either works; the guardian only needs the registries):

```ts
    // R-A9: guardian reviewer — a dedicated subagent reviews ask-decisions
    // BEFORE the human approval prompt (deny ⇒ fail-closed; approve ⇒
    // auto-approve; allow ⇒ existing answerer path). The breaker mirrors into
    // a coordinator document (subagent state-doc pattern).
    if (opts.guardian) {
      await registerGuardian(ctx, {
        subagents: {
          roles: subagent.roles,
          jobs: subagent.jobs,
          table: subagent.table,
          agents: subagent.agents,
        },
        parentRegistry: tools,
        parentSession: session,
        parentCtx: ctx,
        providers,
        parentModel: model,
        ...(opts.guardian.model ? { model: opts.guardian.model } : {}),
        ...(opts.guardian.policy ? { policyText: opts.guardian.policy } : {}),
        ...(opts.guardian.timeoutMs !== undefined ? { timeoutMs: opts.guardian.timeoutMs } : {}),
        ...(opts.coordinator && activeId
          ? {
              breaker: { coordinator: opts.coordinator, sessionId: activeId },
              childSessions: { coordinator: opts.coordinator, parentSessionId: activeId },
            }
          : {}),
      })
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS (new tests + full suite).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run.ts apps/cli/test/guardian.test.ts
git commit -m "feat(cli): R-A9 guardian wiring (reviewer subagent + breaker doc)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review Checklist (run before finishing)

1. **Spec coverage**: R-A1 (T1-T3, T5), R-A2 (T4-T5), R-A4 (T6, T8), R-A5 (T7-T8), R-A6 (T9-T10), R-A7 (T11-T12), R-A9 (T13-T16). R-A3/R-A8 noted as deferred (one-line, header). R-A10/R-A11 noted as 遠期 (one-line, header).
2. **Placeholder scan**: the only "fix before committing" notes in T15 are deliberate correction blocks — apply them INLINE when writing the files (they are the final code). Every task has real test + implementation code.
3. **Type consistency**: `GuardianVerdict` (core-tools) flows T13 → T14 (breaker.record takes `GuardianVerdict["outcome"]`) → T15 (runGuardianReview returns it) → T16. `Inbox.claimAtStepBoundary` T2 → `AgentDeps.stepInputs.claimAtStepBoundary` T3 → executor seam T4. `deriveSessionTitle` T9 → T10. `derivePlanMode` T11 → T12. `RuntimeContextService.registerSection` T6 → T7's getter + T8's `createInstructionsSection`.
4. **Inconsistencies vs. existing code (note in README/summary)**: `session/title` and `plan/mode` deliberately have no `version: 1` (sandbox/mode precedent) while `agent/input/*` does (M19/M21 structured-state precedent); `runHeadless`'s initial-task path changes from `agent.run(task)` to executor `submit+ drain` (finalText now derived from the log terminal — a session whose run ended with NO turn yields `""`), and the CLI's `--approveAll` still short-circuits via the answerer (guardian consulted before the answerer for ask decisions — approveAll + guardian: the answerer auto-true is only reached when the guardian ALLOWS; document this in run.ts).
