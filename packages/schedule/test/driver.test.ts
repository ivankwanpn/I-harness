import { describe, expect, it, vi } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import { createAfterScheduleRecord, createEveryScheduleRecord } from "../src/index.ts"
import { createScheduleDriver, type ScheduleDelivery } from "../src/driver.ts"

/** In-memory fixture session: the foldable event stream. The DRIVER never writes it — the host
 *  fixture below appends what the driver handed over (the engine only produces the delivery). */
interface FixtureSession {
  events: SessionEvent[]
}

const NOW = Date.parse("2026-08-31T10:00:00.000Z")

/** A session whose stream carries ONE due-in-N-s one-shot reminder. */
function afterSession(_id: string, dueAfterSeconds: number): FixtureSession {
  const record = createAfterScheduleRecord("schedule-1", "remind me", dueAfterSeconds, NOW)
  return {
    events: [{ type: "schedule/change", version: 1, operation: "create", schedule: record } as unknown as SessionEvent],
  }
}

/** A session whose stream carries ONE every-record (anchor NOW + everySeconds). */
function everySession(_id: string, everySeconds: number): FixtureSession {
  const record = createEveryScheduleRecord("schedule-1", "every ten", everySeconds, NOW)
  return {
    events: [{ type: "schedule/change", version: 1, operation: "create", schedule: record } as unknown as SessionEvent],
  }
}

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

describe("schedule driver", () => {
  it("delivers a due one-shot exactly once, handing the host the dispatch event + text + inputId", async () => {
    const deliveries: ScheduleDelivery[] = []
    const sessions = { "sess-1": afterSession("sess-1", 1) } // due at 10:00:01.000Z (NOW + 1s)
    // (plan fixture: tick at NOW would be in the record's own creation window —
    // scheduleView says "scheduled" there; the driver clock is advanced past the
    // 1s target exactly like the every-record test advances its clock)
    const driver = driverOver(sessions, deliveries, NOW + 2_000)
    const result = await driver.tick()
    expect(result.delivered).toBe(1)
    expect(result.due).toEqual([
      {
        sessionId: "sess-1",
        record: expect.objectContaining({ id: "schedule-1", kind: "after" }),
        occurrenceAt: "2026-08-31T10:00:01.000Z",
      },
    ])
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.sessionId).toBe("sess-1")
    expect(deliveries[0]!.inputId).toBe("schedule-1@2026-08-31T10:00:01.000Z")
    expect(deliveries[0]!.text).toContain("[SCHEDULE REMINDER]")
    expect(deliveries[0]!.text).toContain("occurrence_at: 2026-08-31T10:00:01.000Z")
    expect(deliveries[0]!.dispatchEvents).toHaveLength(1)
    expect(deliveries[0]!.dispatchEvents[0]).toMatchObject({
      type: "schedule/change",
      operation: "dispatch",
      id: "schedule-1",
    })
    // Re-tick (restart semantics): the fold now consumes the host's dispatch → no re-delivery.
    const again = await driver.tick()
    expect(again.delivered).toBe(0)
    expect(deliveries).toHaveLength(1)
    expect(result.deliveryErrors).toEqual([])
  })

  it("restart re-drive: a NEW driver over the same events delivers only the never-dispatched overdue remainder", async () => {
    const deliveries: ScheduleDelivery[] = []
    const sessions = { "sess-1": afterSession("sess-1", 1), "sess-2": afterSession("sess-2", 2) }
    // driver A (pre-restart) delivers sess-1; sess-2 stays overdue.
    const driverA = driverOver(sessions, deliveries, NOW + 2_000)
    await driverA.tick()
    // crash/restart: events persisted as-is → a fresh driver re-drives at start().
    const driverB = driverOver(sessions, deliveries, NOW + 2_000)
    await driverB.start()
    expect(deliveries).toHaveLength(2)
    expect(deliveries.map((d) => d.sessionId).sort()).toEqual(["sess-1", "sess-2"])
    await driverB.stop()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(deliveries).toHaveLength(2) // poll timer stopped → no third delivery
  })

  it("drives every records with occurrence-aligned dispatch + advance (and no re-delivery on later ticks)", async () => {
    const deliveries: ScheduleDelivery[] = []
    const sessions = { "sess-e": everySession("sess-e", 600) } // anchor 10:10:00Z
    const driver = driverOver(sessions, deliveries, NOW + 25 * 60_000) // "10:25"
    const result = await driver.tick()
    expect(result.delivered).toBe(1)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.due[0]!.occurrenceAt).toBe("2026-08-31T10:20:00.000Z")
    expect((deliveries[0]!.dispatchEvents[0] as { acceptedAt?: string }).acceptedAt)
      .toBe("2026-08-31T10:25:00.000Z")
    expect(deliveries[0]!.inputId).toBe("schedule-1@2026-08-31T10:20:00.000Z")
    // The framing states the OCCURRENCE it was accepted for — not the record's lagging
    // scheduledAt (10:10:00.000Z, the creation target).
    expect(deliveries[0]!.text).toContain("occurrence_at: 2026-08-31T10:20:00.000Z")
    await driver.tick()
    expect(deliveries).toHaveLength(1) // no second delivery for the same acceptance
  })

  it("deliver failure suppresses the delivery (fail-closed: the host threw ⇒ nothing accepted, nothing counted)", async () => {
    const deliveries: ScheduleDelivery[] = []
    let attempts = 0
    const driver = createScheduleDriver({
      sessions: () => ["sess-1"],
      events: () => afterSession("sess-1", 1).events,
      deliver: async () => {
        attempts += 1
        throw new Error("disk full")
      },
      now: () => NOW + 2_000,
    })
    const result = await driver.tick()
    expect(attempts).toBe(1) // the host WAS handed the delivery …
    expect(result.delivered).toBe(0) // … and refused it: no durable accept ⇒ no due, no count
    expect(result.due).toEqual([])
    expect(result.deliveryErrors).toEqual(["sess-1: disk full"])
    expect(deliveries).toHaveLength(0)
  })

  it("unknown session ids are skipped, never a throw; no deliveries leak", async () => {
    const deliver = vi.fn(() => {
      throw new Error("must not be called")
    })
    const driver = createScheduleDriver({
      sessions: () => ["ghost"],
      events: () => undefined,
      deliver,
      now: () => NOW,
    })
    const result = await driver.tick()
    expect(result.delivered).toBe(0)
    expect(result.deliveryErrors).toEqual([])
    expect(deliver).not.toHaveBeenCalled()
  })

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
})
