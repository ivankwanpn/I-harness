// packages/session-executor/test/schedule-delivery.test.ts — Task 5: the HOST
// mount (spec docs/superpowers/specs/2026-09-20-schedule-design.md
// §4.2/§4.4/§4.6/§5; plan docs/superpowers/plans/2026-09-21-schedule-delivery.md).
//
// The mount under test: tools + driver inside `createSessionAssembly`, gated on
// the DURABLE path (coordinator + sessionId), the tick triggered at
// `agent/pre-step`, and the host — not the engine — owning the atomic
// [dispatch, admitted] write.
//
// ONE SPLIT NEEDS SAYING UP FRONT, because §4.4 gives the delivered reminder two
// shapes of "becoming visible" and they are DIFFERENT code paths through the
// SAME durable admission. Neither assertion is copied onto the other path:
//
//   - CLAIMED at a step boundary — the reminder was admitted while a turn was
//     still running, so inbox.claimAtStepBoundary writes the user/message, with
//     the `source: { kind: "plugin", plugin: SYSTEM_INPUT_PLUGIN }` marker and
//     NO `internal`. §3.2.1's blocking check lives on THIS message (it is the
//     only producer on this path); the case "the next step boundary" pins it,
//     including the explicit `internal === undefined` assertion.
//   - PUMPED — the turn ended before the claim (§4.4's second half). The
//     executor's pump takes `pending()[0]` and runs it as its OWN turn, whose
//     task user/message is appended by the agent loop (core-session's
//     `agent/input/promoted` comment documents both shapes as intended). This
//     message carries NO `source` marker — the admission/promoted pair precedes
//     it in the log — so this file asserts `internal` only there. The case
//     "idle does no work" pins this path, `turn/start` ×2.
//
// The pump is a real, decided consequence (owner ruling O2(a) "wait"): a user
// turn can bring out a second turn whose content is the reminder.

import { describe, expect, it } from "vitest"
import {
  append,
  createSession,
  deriveMessages,
  SYSTEM_INPUT_PLUGIN,
  type Session,
  type SessionEvent,
} from "@i-harness/core-session"
import { createSessionExecutor } from "@i-harness/core-agent"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import {
  createAfterScheduleRecord,
  createEveryScheduleRecord,
  foldScheduleEvents,
  type AfterScheduleRecord,
  type EveryScheduleRecord,
} from "@i-harness/schedule"
import { createSessionAssembly, type SessionAssembly } from "../src/assembly.ts"

/* ── fixtures ──────────────────────────────────────────────────────────── */

interface BatchCoordinator extends SessionCoordinator {
  /** One entry per backend append — a flush moves the whole pending set as ONE batch. */
  batches: SessionEvent[][]
  /** Everything that reached the backend, in order. */
  written: SessionEvent[]
}

/** The coordinator double from assembly.test.ts's `memoryCoordinator`, extended
 * to record the WRITE-BEHIND boundary the §3.4 atomicity claim is about:
 * `enqueue` parks events, `flush` commits them as one batch (what the jsonl
 * backend writes in one write+sync), `append` commits directly. */
function batchCoordinator(): BatchCoordinator {
  const written: SessionEvent[] = []
  const batches: SessionEvent[][] = []
  let pending: SessionEvent[] = []
  return {
    batches,
    written,
    create: async (meta?: { sessionId?: string }) => ({ id: meta?.sessionId ?? "mem-0" }),
    append: async (_id: string, evs: SessionEvent[]) => {
      written.push(...evs)
      batches.push([...evs])
    },
    enqueue: (_id: string, evs: SessionEvent[]) => {
      pending.push(...evs)
    },
    flush: async () => {
      if (pending.length > 0) {
        written.push(...pending)
        batches.push(pending)
        pending = []
      }
    },
    load: async () => ({ session: { formatVersion: 1, events: [...written] } }),
    list: async () => ["s"],
    close: async () => {},
    putDocument: async () => {},
    getDocument: async () => undefined,
  } as unknown as BatchCoordinator // the shape's base is SessionCoordinator; the recorder fields are this double's own
}

/** The recorder+cassette pair this file's cases drive the mount through (the
 * same two pieces assembly.test.ts's `scriptedModel` joins): requests are
 * recorded, replies come from a destructive one-step-per-turn cassette. */
function scriptedModel(script: MockStep[]): ModelClient & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = []
  const cassette = createMockClient([...script])
  return {
    requests,
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      requests.push(request)
      yield* cassette.stream(request)
    },
  }
}

const SESSION_ID = "sched-host"

/** The brief's two-step cassette, and BOTH steps are load-bearing: turn 1 ends
 * at its first step (no tool call), so the reminder the tick admitted becomes
 * the PUMP's turn 2 — which is exactly §4.4's second half. */
function twoStepScript(): MockStep[] {
  return [
    { role: "assistant", text: "ok" },
    { role: "assistant", text: "second" },
  ]
}

/** An overdue ONE-SHOT. `createAfterScheduleRecord` requires a future target,
 * so the record is built as if created 10s ago — the FOLD's decoder only
 * requires a canonical instant, not a future one. */
function overdueOneShot(id = "schedule-1"): AfterScheduleRecord {
  return createAfterScheduleRecord(id, "check the build", 1, Date.now() - 10_000)
}

/** An overdue fixed-rate record: built as if created 15 minutes ago, i.e. its
 * target (creation + 300s) is 10 minutes past — overdue, and the dispatch
 * arithmetic still has a representable next occurrence. */
function overdueEvery(id: string): EveryScheduleRecord {
  return createEveryScheduleRecord(id, "check the build", 300, Date.now() - 900_000)
}

function seedCreate(session: Session, record: AfterScheduleRecord | EveryScheduleRecord): void {
  append(session, { type: "schedule/change", version: 1, operation: "create", schedule: record })
}

interface HostFixture {
  assembly: SessionAssembly
  session: Session
  coordinator: BatchCoordinator
  model: ModelClient & { requests: LLMRequest[] }
  /** submit + drain — the serial lane is the real drive, and its pump is
   * §4.4's second half (a pending steer runs as its own turn). */
  runTurn(text?: string): Promise<void>
}

/** One mounted host: session (mirrored into the coordinator double the way the
 * real host mirrors — `createSession(ev => coordinator.enqueue(...))` PLUS the
 * mirror's own `turn/end` flush, which is the shape `createSessionAssembly`
 * installs when IT creates the session, assembly.ts's session mirror), the
 * assembly over it, and the lane over the assembly's own agent + inbox. */
async function mountHost(opts: {
  seed?: (session: Session) => void
  script?: MockStep[]
} = {}): Promise<HostFixture> {
  const coordinator = batchCoordinator()
  const session = createSession((ev) => {
    coordinator.enqueue(SESSION_ID, [ev])
    if (ev.type === "turn/end") void coordinator.flush(SESSION_ID)
  })
  opts.seed?.(session)
  const model = scriptedModel(opts.script ?? twoStepScript())
  const assembly = await createSessionAssembly({
    workspace: process.cwd(),
    sessionId: SESSION_ID,
    session,
    coordinator,
    model,
  })
  const executor = createSessionExecutor({ session, agent: assembly.agent, inbox: assembly.inbox })
  return {
    assembly,
    session,
    coordinator,
    model,
    runTurn: async (text = "hello") => {
      executor.submit({ tier: "send", text })
      await executor.drain()
    },
  }
}

/* ── readers ───────────────────────────────────────────────────────────── */

const REMINDER = "[SCHEDULE REMINDER]"
const BATCH_REMINDER = "[SCHEDULE REMINDER BATCH]"

const isScheduleDispatch = (ev: SessionEvent): boolean =>
  ev.type === "schedule/change" && ev.operation === "dispatch"

type AdmittedEvent = Extract<SessionEvent, { type: "agent/input/admitted" }>
const isAdmission = (ev: SessionEvent): ev is AdmittedEvent => ev.type === "agent/input/admitted"
/** The SCHEDULE admissions only: the lane's own submit admits its input as an
 * `agent/input/admitted` too, and every `inputId` this mount mints starts with
 * the record id (`schedule-…`, §3.5) or `schedule-batch@…` (§3.5's batch id). */
const isScheduleAdmission = (ev: SessionEvent): ev is AdmittedEvent =>
  isAdmission(ev) && ev.inputId.startsWith("schedule-")

type UserMessageEvent = Extract<SessionEvent, { type: "user/message" }>

function reminderMessages(session: Session): UserMessageEvent[] {
  return session.events.filter(
    (ev): ev is UserMessageEvent => ev.type === "user/message" && ev.text.includes(REMINDER),
  )
}

/** The user messages of ONE request whose text carries `needle` — the model
 * surface side of the "both the model and the user see it" contract. */
function requestMessagesCarrying(request: LLMRequest, needle: string): string[] {
  return request.messages
    .filter((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(needle))
    .map((m) => m.content as string)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ── cases ─────────────────────────────────────────────────────────────── */

describe("createSessionAssembly — the schedule delivery mount (Task 5)", () => {
  it("idle does no work (no step ⇒ no tick ⇒ no dispatch); a user turn delivers once — the model sees the reminder in the pumped second turn, the user sees a message without `internal`, and [dispatch, admitted] is one adjacent durable batch", async () => {
    const record = overdueOneShot()
    const host = await mountHost({ seed: (session) => seedCreate(session, record) })
    try {
      // (a) §4.2's gate — the plan's headline mutation target. The trigger is
      // the step boundary, and an IDLE session takes no step. A timer (the
      // mutation: start()/setInterval) delivers here, with no turn at all.
      await sleep(200)
      expect(host.session.events.some(isScheduleDispatch)).toBe(false)
      expect(host.coordinator.written).toEqual([])

      await host.runTurn("hello")

      // (b) model-facing. Turn 1's request was built after the tick's admission
      // but the admission is not a user/message yet, so it carries NO reminder;
      // turn 1 ends at its first step (no tool call), the pending admission
      // becomes turn 2 (the pump), and THAT request carries the reminder.
      expect(host.model.requests).toHaveLength(2)
      expect(requestMessagesCarrying(host.model.requests[0]!, REMINDER)).toHaveLength(0)
      expect(requestMessagesCarrying(host.model.requests[1]!, REMINDER)).toHaveLength(1)

      // (c) §4.4's pump, spelled out: the user's ONE turn brought out a second.
      expect(host.session.events.filter((e) => e.type === "turn/start")).toHaveLength(2)

      // (d) user-facing + the §3.2.1 BLOCKING check. This is the PUMP path's
      // message (the promoted admission precedes it — core-session's
      // `agent/input/promoted` comment), so what this case pins is the load-
      // bearing half: it must NOT be `internal` — `internal: true` makes the
      // reminder model-only and silently breaks O1's "both" without any test
      // reddening elsewhere. (The `source` marker belongs to the claim path
      // and is pinned in the next case.)
      const reminders = reminderMessages(host.session)
      expect(reminders).toHaveLength(1)
      expect(reminders[0]!.internal).toBeUndefined()

      // (e) the transcript/CLI surface: deriveMessages — what the apps/cli
      // transcript reader projects from the same log — carries it too.
      expect(
        deriveMessages(host.session).some(
          (m) => m.role === "user" && typeof m.content === "string" && m.content.includes(REMINDER),
        ),
      ).toBe(true)

      // (f) durable + atomic (§3.4). Both events reached the backend, and the
      // admission sits IMMEDIATELY after its dispatch in the SAME batch — one
      // backend append, so a crash lands both or neither.
      expect(host.coordinator.written.filter(isScheduleDispatch)).toHaveLength(1)
      expect(host.coordinator.written.filter(isScheduleAdmission)).toHaveLength(1)
      const batch = host.coordinator.batches.find((b) => b.some(isScheduleDispatch))
      expect(batch).toBeDefined()
      const dispatchIndex = batch!.findIndex(isScheduleDispatch)
      expect(batch![dispatchIndex + 1]).toMatchObject({
        type: "agent/input/admitted",
        // §3.5's per-OCCURRENCE id and §3.2's tier/intent — the three fields
        // the HOST chooses in `deliver`, pinned at the host.
        inputId: `schedule-1@${record.scheduledAt}`,
        delivery: "steer",
        intent: "system",
      })
    } finally {
      await host.assembly.dispose()
    }
  }, 30_000)

  it("a reminder admitted after its step's own claim is spliced at the NEXT step boundary — the claimed user/message carries the plugin source marker and no `internal`", async () => {
    const record = overdueOneShot()
    const host = await mountHost({ seed: (session) => seedCreate(session, record) })
    try {
      // Turn 1: the tick runs at ITS first step's pre-step — AFTER that step's
      // claimAtStepBoundary — and the turn ends (no tool call) before any later
      // claim. The delivery is accepted; nothing is spliced yet.
      await host.assembly.agent.run("hello")
      expect(host.session.events.filter(isScheduleAdmission)).toHaveLength(1)
      expect(reminderMessages(host.session)).toHaveLength(0)

      // The next step boundary — here, the next turn's first step — is where
      // inbox.claimAtStepBoundary writes the message (before deriveMessages,
      // core-agent:263/277). This is the message §3.2.1's blocking check names,
      // and `source` exists on no other producer.
      await host.assembly.agent.run("next")
      const claimed = reminderMessages(host.session)
      expect(claimed).toHaveLength(1)
      expect(claimed[0]!.source).toEqual({ kind: "plugin", plugin: SYSTEM_INPUT_PLUGIN })
      expect(claimed[0]!.internal).toBeUndefined()
      expect(requestMessagesCarrying(host.model.requests[1]!, REMINDER)).toHaveLength(1)
    } finally {
      await host.assembly.dispose()
    }
  }, 30_000)

  it("a forked session does not dispatch its inherited prefix (§5): events() slices at header.seedLength", async () => {
    const inherited = overdueOneShot()
    const host = await mountHost({
      seed: (session) => {
        seedCreate(session, inherited) // the PARENT's record, at events[0]
        session.header = { seedLength: 1 } // …and this session owns none of it
      },
    })
    try {
      await host.runTurn("hello")
      // Zero dispatches, zero admissions, zero reminder messages: the parent's
      // overdue record is inert here. Without the slice the fold sees it as
      // this session's own and the tick delivers.
      expect(host.session.events.some(isScheduleDispatch)).toBe(false)
      expect(host.session.events.some(isScheduleAdmission)).toBe(false)
      expect(host.coordinator.batches.some((b) => b.some(isScheduleDispatch))).toBe(false)
      expect(reminderMessages(host.session)).toHaveLength(0)
    } finally {
      await host.assembly.dispose()
    }
  }, 30_000)

  it("the batch decision is ONE delivery: two overdue `every` records → one admitted ([SCHEDULE REMINDER BATCH]) with two dispatches in one adjacent batch, and the fold advances BOTH records", async () => {
    const first = overdueEvery("schedule-1")
    const second = overdueEvery("schedule-2")
    const host = await mountHost({
      seed: (session) => {
        seedCreate(session, first)
        seedCreate(session, second)
      },
    })
    try {
      const before = Date.now()
      await host.runTurn("hello")

      // ONE admission for two records (§6.3's bound: one decision, one model
      // message), carrying the batch framing.
      const admissions = host.session.events.filter(isScheduleAdmission)
      expect(admissions).toHaveLength(1)
      expect(admissions[0]!.text).toContain(BATCH_REMINDER)
      expect(requestMessagesCarrying(host.model.requests[1]!, BATCH_REMINDER)).toHaveLength(1)

      // The two dispatches land together, and the admission is adjacent to the
      // last of them — one batch, one backend append.
      const batch = host.coordinator.batches.find((b) => b.some(isScheduleDispatch))
      expect(batch).toBeDefined()
      const firstDispatch = batch!.findIndex(isScheduleDispatch)
      expect(batch![firstDispatch]!.type).toBe("schedule/change")
      expect(batch![firstDispatch + 1]!.type).toBe("schedule/change")
      expect(batch!.filter(isScheduleDispatch)).toHaveLength(2)
      expect(batch![firstDispatch + 2]).toMatchObject({
        type: "agent/input/admitted",
        delivery: "steer",
        intent: "system",
      })

      // The fold, re-read from the log, shows both records advanced past their
      // seeded (overdue) target into the next occurrence — the dispatch is the
      // durable acceptance that makes the re-drive free.
      const folded = foldScheduleEvents(host.session.events)
      expect(folded.active.map((r) => r.id).sort()).toEqual(["schedule-1", "schedule-2"])
      for (const foldedRecord of folded.active) {
        const seeded = foldedRecord.id === "schedule-1" ? first : second
        expect(Date.parse(foldedRecord.scheduledAt)).toBeGreaterThan(Date.parse(seeded.scheduledAt))
        expect(Date.parse(foldedRecord.scheduledAt)).toBeGreaterThan(before)
      }
    } finally {
      await host.assembly.dispose()
    }
  }, 30_000)

  it("restart re-drive is free: a fresh assembly over the same written log does not deliver again (the fold consumed the dispatch)", async () => {
    // Phase 1 — a delivered log, case 1's shape.
    const record = overdueOneShot()
    const delivered = await mountHost({ seed: (session) => seedCreate(session, record) })
    let written: SessionEvent[]
    try {
      await delivered.runTurn("hello")
      written = [...delivered.coordinator.written]
    } finally {
      await delivered.assembly.dispose()
    }
    expect(written.filter(isScheduleDispatch)).toHaveLength(1)
    expect(written.filter(isScheduleAdmission)).toHaveLength(1)

    // Phase 2 — a NEW session seeded FROM that log, a new assembly, a new
    // driver inside it. One step happens, so the tick DOES run.
    const host = await mountHost({
      seed: (session) => {
        for (const ev of written) append(session, ev)
      },
      script: [{ role: "assistant", text: "ok" }],
    })
    try {
      await host.runTurn("continue")
      // The tick found nothing due: dispatch, admission and reminder counts are
      // exactly the seeded ones. A driver that re-fired would append a second
      // dispatch for an inactive id — and the fold would then throw on the NEXT
      // tick (the daily double-delivery bug the in-flight guard exists for).
      expect(host.session.events.filter(isScheduleDispatch)).toHaveLength(1)
      expect(host.session.events.filter(isScheduleAdmission)).toHaveLength(1)
      expect(host.coordinator.batches.flat().filter(isScheduleDispatch)).toHaveLength(1)
      expect(reminderMessages(host.session)).toHaveLength(1) // only the seeded one
    } finally {
      await host.assembly.dispose()
    }
  }, 30_000)
})
