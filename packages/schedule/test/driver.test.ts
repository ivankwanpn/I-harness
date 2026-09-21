import { describe, expect, it, vi } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import { createAfterScheduleRecord, createEveryScheduleRecord, type ScheduleRecord } from "../src/index.ts"
import { createScheduleDriver, type ScheduleDelivery } from "../src/driver.ts"

/** In-memory fixture session: the foldable event stream. The DRIVER never writes it — the host
 *  fixture below appends what the driver handed over (the engine only produces the delivery). */
interface FixtureSession {
  events: SessionEvent[]
}

const NOW = Date.parse("2026-08-31T10:00:00.000Z")

/** The create event for one record (the fixtures below carry theirs inline). */
function createEvent(record: ScheduleRecord): SessionEvent {
  return { type: "schedule/change", version: 1, operation: "create", schedule: record } as unknown as SessionEvent
}

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
    // Every records ride the batch path: the idempotency key is the DECISION's, not the record's
    // (spec §3.5's batch inference — one admission, one inputId bound to the shared acceptedAt).
    expect(deliveries[0]!.inputId).toBe("schedule-batch@2026-08-31T10:25:00.000Z")
    // The framing states the OCCURRENCE it was accepted for — not the record's lagging
    // scheduledAt (10:10:00.000Z, the creation target).
    expect(deliveries[0]!.text).toContain("[SCHEDULE REMINDER BATCH]")
    expect(deliveries[0]!.text).toContain('"occurrence_at":"2026-08-31T10:20:00.000Z"')
    await driver.tick()
    expect(deliveries).toHaveLength(1) // no second delivery for the same acceptance
  })

  it("deliver failure suppresses the delivery (fail-closed: the host threw ⇒ the host did not accept, nothing counted)", async () => {
    const deliveries: ScheduleDelivery[] = []
    const warnings: string[] = []
    let attempts = 0
    const driver = createScheduleDriver({
      sessions: () => ["sess-1"],
      events: () => afterSession("sess-1", 1).events,
      deliver: async () => {
        attempts += 1
        throw new Error("disk full")
      },
      now: () => NOW + 2_000,
      logWarn: (message) => warnings.push(message), // collector — the suite transcript stays clean
    })
    const result = await driver.tick()
    expect(attempts).toBe(1) // the host WAS handed the delivery …
    expect(result.delivered).toBe(0) // … and did not accept: no durable accept here ⇒ no due, no count
    expect(result.due).toEqual([])
    expect(result.deliveryErrors).toEqual(["sess-1: disk full"])
    expect(deliveries).toHaveLength(0)
    // The failure is reported, not silent: one warn, naming the record and the reason.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("schedule-1")
    expect(warnings[0]).toContain("disk full")
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

  it("one tick in flight: a tick arriving while the host's delivery is still resolving is SKIPPED (one delivery, not two)", async () => {
    const deliveries: ScheduleDelivery[] = []
    // (brief snippet verbatim except this annotation: the literal object alone infers
    //  `{ "sess-e": FixtureSession }`, which cannot be indexed by the string `id` — TS7053)
    const sessions: Record<string, FixtureSession> = { "sess-e": everySession("sess-e", 600) }
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

  it("a batch bounds model turns: N overdue every records produce ONE delivery — one decision, one message", async () => {
    const deliveries: ScheduleDelivery[] = []
    // (typed like driverOver's parameter: the literal alone infers a session-keyed object
    //  that cannot be indexed by the fixture's string sessionId — TS7053)
    const sessions: Record<string, FixtureSession> = { "sess-a": everySession("sess-a", 600) }
    // The fixture helper makes schedule-1 only; the second record goes in as its own create event.
    sessions["sess-a"]!.events.push(createEvent(createEveryScheduleRecord("schedule-2", "every ten too", 600, NOW)))
    const driver = driverOver(sessions, deliveries, NOW + 25 * 60_000) // "10:25"
    const result = await driver.tick()
    expect(deliveries).toHaveLength(1) // one delivery per tick, two records in it — N messages would be 2
    expect(deliveries[0]!.dispatchEvents).toHaveLength(2)
    expect(deliveries[0]!.text).toContain("[SCHEDULE REMINDER BATCH]")
    expect(deliveries[0]!.inputId).toBe("schedule-batch@2026-08-31T10:25:00.000Z")
    expect(result.delivered).toBe(2)
    expect(result.due.map((entry) => [entry.record.id, entry.occurrenceAt])).toEqual([
      ["schedule-1", "2026-08-31T10:20:00.000Z"],
      ["schedule-2", "2026-08-31T10:20:00.000Z"],
    ])
  })

  it("one-shot takes precedence: a due one-shot is delivered ALONE, the overdue every records wait for the next tick", async () => {
    const deliveries: ScheduleDelivery[] = []
    const sessions: Record<string, FixtureSession> = { "sess-mix": afterSession("sess-mix", 60) } // due 10:01:00Z
    sessions["sess-mix"]!.events.push(createEvent(createEveryScheduleRecord("schedule-2", "every ten", 600, NOW)))
    const driver = driverOver(sessions, deliveries, NOW + 25 * 60_000)
    const first = await driver.tick()
    expect(first.delivered).toBe(1) // the every record is overdue too — and still is NOT in this delivery
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.dispatchEvents).toHaveLength(1)
    expect(deliveries[0]!.text).toContain("[SCHEDULE REMINDER]")
    expect(deliveries[0]!.text).not.toContain("[SCHEDULE REMINDER BATCH]")
    expect(deliveries[0]!.inputId).toBe("schedule-1@2026-08-31T10:01:00.000Z")
    // Same clock, next tick: the one-shot is consumed (its dispatch is in the log), the every is due.
    const second = await driver.tick()
    expect(second.delivered).toBe(1)
    expect(deliveries).toHaveLength(2)
    expect(deliveries[1]!.text).toContain("[SCHEDULE REMINDER BATCH]")
    expect(deliveries[1]!.inputId).toBe("schedule-batch@2026-08-31T10:25:00.000Z")
  })

  it("no double delivery inside one tick: after the batch the records are advanced, not re-due", async () => {
    const deliveries: ScheduleDelivery[] = []
    const sessions: Record<string, FixtureSession> = { "sess-n": everySession("sess-n", 600) }
    sessions["sess-n"]!.events.push(createEvent(createEveryScheduleRecord("schedule-2", "second every", 600, NOW)))
    const driver = driverOver(sessions, deliveries, NOW + 25 * 60_000)
    const first = await driver.tick()
    expect(first.delivered).toBe(2)
    expect(deliveries).toHaveLength(1)
    const again = await driver.tick()
    expect(again.delivered).toBe(0)
    expect(again.due).toEqual([])
    expect(deliveries).toHaveLength(1) // the host consumed BOTH dispatch events in the one batch
  })

  it("a decision the state cannot satisfy is that session's deliveryError — loud, loop continues", async () => {
    const deliveries: ScheduleDelivery[] = []
    const warnings: string[] = []
    const sessions: Record<string, FixtureSession> = {
      "sess-bad": everySession("sess-bad", 600),
      "sess-ok": afterSession("sess-ok", 60),
    }
    const driver = createScheduleDriver({
      sessions: () => Object.keys(sessions),
      events: (id) => sessions[id]?.events,
      deliver: async (delivery) => {
        deliveries.push(delivery)
        for (const ev of delivery.dispatchEvents) sessions[delivery.sessionId]!.events.push(ev)
      },
      // One millisecond past the last representable four-digit-year instant: the every occurrence
      // arithmetic refuses that accepted time, so sess-bad's DECISION throws — never tick() itself.
      now: () => Date.parse("9999-12-31T23:59:59.999Z") + 1,
      logWarn: (message) => warnings.push(message),
    })
    const result = await driver.tick()
    expect(result.deliveryErrors).toHaveLength(1)
    expect(result.deliveryErrors[0]).toMatch(/^sess-bad: /)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("sess-bad")
    expect(result.delivered).toBe(1) // the loop continued: sess-ok's one-shot still went out
    expect(deliveries.map((delivery) => delivery.sessionId)).toEqual(["sess-ok"])
  })
})
