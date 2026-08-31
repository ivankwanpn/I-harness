import { describe, expect, it } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import { createAfterScheduleRecord, createEveryScheduleRecord } from "../src/index.ts"
import { createScheduleDriver, type ScheduleDue } from "../src/driver.ts"

/** In-memory fixture session: foldable events + the driver's appends. */
interface FixtureSession {
  events: SessionEvent[]
  appends: SessionEvent[][]
}

const NOW = Date.parse("2026-08-31T10:00:00.000Z")

/** A session whose stream carries ONE due-in-N-s one-shot reminder. */
function afterSession(_id: string, dueAfterSeconds: number): FixtureSession {
  const record = createAfterScheduleRecord("schedule-1", "remind me", dueAfterSeconds, NOW)
  return {
    events: [{ type: "schedule/change", version: 1, operation: "create", schedule: record } as unknown as SessionEvent],
    appends: [],
  }
}

/** A session whose stream carries ONE every-record (anchor NOW + everySeconds). */
function everySession(_id: string, everySeconds: number): FixtureSession {
  const record = createEveryScheduleRecord("schedule-1", "every ten", everySeconds, NOW)
  return {
    events: [{ type: "schedule/change", version: 1, operation: "create", schedule: record } as unknown as SessionEvent],
    appends: [],
  }
}

function driverOver(
  sessions: Record<string, FixtureSession>,
  onDue: (due: ScheduleDue) => void,
  now = NOW,
): ReturnType<typeof createScheduleDriver> {
  return createScheduleDriver({
    sessions: () => Object.keys(sessions),
    events: (id) => sessions[id]?.events,
    append: async (id, events) => {
      sessions[id]!.appends.push([...events])
      sessions[id]!.events.push(...events)
    },
    onDue,
    now: () => now,
    pollMs: 60_000,
  })
}

describe("schedule driver", () => {
  it("delivers a due one-shot exactly once, with the durable dispatch appended BEFORE delivery", async () => {
    const due: ScheduleDue[] = []
    const s1 = afterSession("sess-1", 1) // due at 10:00:01.000Z (NOW + 1s)
    const sessions = { "sess-1": s1 }
    // (plan fixture: tick at NOW would be in the record's own creation window —
    // scheduleView says "scheduled" there; the driver clock is advanced past the
    // 1s target exactly like the every-record test advances its clock)
    const driver = driverOver(sessions, (d) => due.push(d), NOW + 2_000)
    const result = await driver.tick()
    expect(result.delivered).toBe(1)
    expect(result.due).toEqual([
      {
        sessionId: "sess-1",
        record: expect.objectContaining({ id: "schedule-1", kind: "after" }),
        occurrenceAt: "2026-08-31T10:00:01.000Z",
      },
    ])
    expect(s1.appends.map((a) => a[0]!.type)).toEqual(["schedule/change"])
    expect((s1.appends[0]![0] as { operation: string; id: string }).operation).toBe("dispatch")
    // Re-tick (restart semantics): the fold now consumes the dispatch → no re-delivery.
    const again = await driver.tick()
    expect(again.delivered).toBe(0)
    expect(due).toHaveLength(1)
    expect(result.deliveryErrors).toEqual([])
  })

  it("restart re-drive: a NEW driver over the same events delivers only the never-dispatched overdue remainder", async () => {
    const due: ScheduleDue[] = []
    const sessions = { "sess-1": afterSession("sess-1", 1), "sess-2": afterSession("sess-2", 2) }
    // driver A (pre-restart) delivers sess-1; sess-2 stays overdue.
    const driverA = driverOver(sessions, (d) => due.push(d), NOW + 2_000)
    await driverA.tick()
    // crash/restart: events persisted as-is → a fresh driver re-drives at start().
    const driverB = driverOver(sessions, (d) => due.push(d), NOW + 2_000)
    await driverB.start()
    expect(due).toHaveLength(2)
    expect(due.map((d) => d.sessionId).sort()).toEqual(["sess-1", "sess-2"])
    await driverB.stop()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(due).toHaveLength(2) // poll timer stopped → no third delivery
  })

  it("drives every records with occurrence-aligned dispatch + advance (and no re-delivery on later ticks)", async () => {
    const due: ScheduleDue[] = []
    const sessions = { "sess-e": everySession("sess-e", 600) } // anchor 10:10:00Z
    const driver = driverOver(sessions, (d) => due.push(d), NOW + 25 * 60_000) // "10:25"
    const result = await driver.tick()
    expect(result.delivered).toBe(1)
    expect(due[0]).toMatchObject({ occurrenceAt: "2026-08-31T10:20:00.000Z" })
    expect((sessions["sess-e"]!.events.at(-1)! as { acceptedAt?: string }).acceptedAt)
      .toBe("2026-08-31T10:25:00.000Z")
    await driver.tick()
    expect(due).toHaveLength(1) // no second delivery for the same acceptance
  })

  it("append failure suppresses delivery (fail-closed: no durable dispatch → no prompt)", async () => {
    const due: ScheduleDue[] = []
    const driver = createScheduleDriver({
      sessions: () => ["sess-1"],
      events: () => afterSession("sess-1", 1).events,
      append: async () => { throw new Error("disk full") },
      onDue: (d) => { due.push(d) },
      now: () => NOW + 2_000,
    })
    const result = await driver.tick()
    expect(result.delivered).toBe(0)
    expect(result.deliveryErrors).toEqual(["sess-1: disk full"])
    expect(due).toHaveLength(0)
  })

  it("unknown session ids are skipped, never a throw; no deliveries leak", async () => {
    const driver = createScheduleDriver({
      sessions: () => ["ghost"],
      events: () => undefined,
      append: async () => { throw new Error("must not be called") },
      now: () => NOW,
    })
    const result = await driver.tick()
    expect(result.delivered).toBe(0)
    expect(result.deliveryErrors).toEqual([])
  })
})
