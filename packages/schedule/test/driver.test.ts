import { afterEach, describe, expect, it, vi } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import { createAfterScheduleRecord, createEveryScheduleRecord, type ScheduleRecord } from "../src/index.ts"
import { createScheduleDriver, type ScheduleDelivery, type ScheduleDriverOptions } from "../src/driver.ts"

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

  it("a rejected delivery is reported and not counted without inferring host acceptance", async () => {
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
    expect(result.delivered).toBe(0) // … and rejected: no returned handoff to count
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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** Array publication tests the library seam only; managed host acceptance has its own suite. */
function deadlineFixture(options: Partial<ScheduleDriverOptions> = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  const sessions: Record<string, FixtureSession> = {}
  const deliveries: ScheduleDelivery[] = []
  const warnings: string[] = []
  const listeners = new Set<(id?: string) => void>()
  const driver = createScheduleDriver({
    sessions: () => Object.keys(sessions),
    events: (id) => sessions[id]?.events,
    deliver: (delivery) => {
      deliveries.push(delivery)
      sessions[delivery.sessionId]!.events.push(...delivery.dispatchEvents)
      for (const listener of listeners) listener(delivery.sessionId)
    },
    subscribeMutations: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    logWarn: (warning) => { warnings.push(warning) },
    ...options,
  })
  return { driver, sessions, deliveries, warnings, listeners,
    changed(id?: string) { for (const listener of listeners) listener(id) },
  }
}

// These tests catch ownership/admission bugs: they observe host handoffs, deadlines and
// listener lifetime, rather than an interval implementation or a private dirty flag.
describe("schedule deadline lifecycle", () => {
  afterEach(() => { vi.useRealTimers() })

  it("has no empty timer and ignores pollMs while owning the nearest target across sessions", async () => {
    const f = deadlineFixture({ pollMs: 1 })
    expect(f.listeners.size).toBe(0)
    await f.driver.start()
    expect(vi.getTimerCount()).toBe(0)
    f.sessions.later = afterSession("later", 20)
    f.sessions.earlier = afterSession("earlier", 10)
    f.changed()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(f.deliveries).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(f.deliveries.map((d) => d.sessionId)).toEqual(["earlier"])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.deliveries.map((d) => d.sessionId)).toEqual(["earlier", "later"])
    expect(vi.getTimerCount()).toBe(0)
    await f.driver.close()
  })

  it("replaces deadlines on earlier create and delete, and stopped mutation cannot deliver", async () => {
    const f = deadlineFixture()
    f.sessions.s = afterSession("s", 30)
    await f.driver.start()
    f.sessions.s.events.push(createEvent(createAfterScheduleRecord("early", "early", 5, NOW)))
    f.changed("s")
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    f.sessions.s.events.push({ type: "schedule/change", version: 1, operation: "delete", id: "early" })
    f.changed("s")
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.deliveries).toEqual([])
    f.driver.stop()
    expect(f.listeners.size).toBe(0)
    f.driver.invalidate("mutation", "s")
    await vi.advanceTimersByTimeAsync(40_000)
    expect(f.deliveries).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect((await f.driver.tick()).delivered).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    await f.driver.close()
  })

  it("subscribes before the first read and shares concurrent start without overlap", async () => {
    const held = deferred()
    const order: string[] = []
    let listener: ((id?: string) => void) | undefined
    let handoffs = 0
    const session = afterSession("s", 1)
    const f = deadlineFixture({
      sessions: () => { order.push("read"); return ["s"] },
      events: () => session.events,
      now: () => NOW + 2_000,
      subscribeMutations: (changed) => { order.push("subscribe"); listener = changed; return () => { order.push("unsubscribe") } },
      deliver: async (delivery) => { handoffs++; await held.promise; session.events.push(...delivery.dispatchEvents); listener?.("s") },
    })
    const first = f.driver.start()
    const second = f.driver.start()
    expect(first).toBe(second)
    expect(order.slice(0, 2)).toEqual(["subscribe", "read"])
    expect((await f.driver.tick()).delivered).toBe(0)
    listener?.("s")
    held.resolve()
    expect((await first).delivered).toBe(1)
    expect(await second).toEqual(await first)
    expect(handoffs).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    f.driver.stop()
    f.driver.stop()
    expect(order.filter((entry) => entry === "unsubscribe")).toHaveLength(1)
    await f.driver.close()
  })

  it("fences later sessions at stop and a new start waits for the older held pass", async () => {
    const held = deferred()
    const f = deadlineFixture({ deliver: async (delivery) => {
      f.deliveries.push(delivery)
      if (f.deliveries.length === 1) await held.promise
      f.sessions[delivery.sessionId]!.events.push(...delivery.dispatchEvents)
    } })
    f.sessions.a = afterSession("a", 1)
    f.sessions.b = afterSession("b", 1)
    vi.setSystemTime(NOW + 2_000)
    const oldStart = f.driver.start()
    f.driver.stop()
    const restarted = f.driver.start()
    await Promise.resolve()
    expect(f.deliveries.map((d) => d.sessionId)).toEqual(["a"])
    held.resolve()
    await oldStart
    expect((await restarted).delivered).toBe(1)
    expect(f.deliveries.map((d) => d.sessionId)).toEqual(["a", "b"])
    expect(f.listeners.size).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    await f.driver.close()
  })

  it("a rejected older generation cannot suppress the explicit retry of a waiting new start", async () => {
    const held = deferred()
    const f = deadlineFixture({ deliver: async (delivery) => {
      f.deliveries.push(delivery)
      if (f.deliveries.length === 1) { await held.promise; throw new Error("old rejection") }
      f.sessions.s!.events.push(...delivery.dispatchEvents)
    } })
    f.sessions.s = afterSession("s", 1)
    vi.setSystemTime(NOW + 2_000)
    const old = f.driver.start()
    f.driver.stop()
    const restarted = f.driver.start()
    held.resolve()
    expect((await old).deliveryErrors).toEqual(["s: old rejection"])
    expect((await restarted).delivered).toBe(1)
    expect(f.deliveries).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    await f.driver.close()
  })

  it("close is terminal, shares its attempt and joins an already handed-off delivery", async () => {
    const held = deferred()
    const f = deadlineFixture({ deliver: async (delivery) => { f.deliveries.push(delivery); await held.promise } })
    f.sessions.a = afterSession("a", 1)
    f.sessions.b = afterSession("b", 1)
    vi.setSystemTime(NOW + 2_000)
    const started = f.driver.start()
    const close = f.driver.close()
    expect(f.driver.close()).toBe(close)
    let settled = false
    void close.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    held.resolve()
    await started
    await close
    expect(f.deliveries.map((d) => d.sessionId)).toEqual(["a"])
    expect(f.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await expect(f.driver.start()).rejects.toThrow(/closed/)
    await expect(f.driver.tick()).rejects.toThrow(/closed/)
    f.driver.invalidate("retry")
    expect(f.driver.close()).toBe(close)
  })

  it("publishes pass ownership before synchronous host callbacks can request close", async () => {
    const held = deferred()
    let close!: Promise<void>
    let settled = false
    const f = deadlineFixture({ deliver: () => {
      close = f.driver.close()
      void close.then(() => { settled = true })
      return held.promise
    } })
    f.sessions.s = afterSession("s", 1)
    vi.setSystemTime(NOW + 2_000)
    const started = f.driver.start()
    await Promise.resolve()
    expect(settled).toBe(false)
    held.resolve()
    await started
    await close
    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("retains a failed known disposer, blocks restart and retries cleanup on a later close", async () => {
    const held = deferred()
    let cleanups = 0
    let acquisitions = 0
    const f = deadlineFixture({
      now: () => NOW + 2_000,
      subscribeMutations: () => { acquisitions++; return () => { cleanups++; if (cleanups === 1) throw new Error("unsubscribe failed") } },
      deliver: async () => { await held.promise },
    })
    f.sessions.s = afterSession("s", 1)
    const started = f.driver.start()
    f.driver.stop()
    await expect(f.driver.start()).rejects.toThrow(/cleanup/)
    expect(acquisitions).toBe(1)
    // The next explicit cleanup attempt is shared while accepted host work is joined.
    const close = f.driver.close()
    expect(f.driver.close()).toBe(close)
    held.resolve()
    await started
    await close
    expect(cleanups).toBe(2)
    expect(acquisitions).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("a failed close joins work before rejection and permits another cleanup attempt", async () => {
    const held = deferred()
    let cleanups = 0
    const f = deadlineFixture({
      now: () => NOW + 2_000,
      subscribeMutations: () => () => { cleanups++; if (cleanups === 1) throw new Error("cleanup failed") },
      deliver: () => held.promise,
    })
    f.sessions.s = afterSession("s", 1)
    const started = f.driver.start()
    const close = f.driver.close()
    const rejection = expect(close).rejects.toThrow("cleanup failed")
    expect(f.driver.close()).toBe(close)
    held.resolve()
    await started
    await rejection
    await f.driver.close()
    expect(cleanups).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("permits reusable start only after a retained disposer succeeds on explicit stop retry", async () => {
    let cleanups = 0
    let acquisitions = 0
    const f = deadlineFixture({ subscribeMutations: () => {
      acquisitions++
      return () => { if (++cleanups === 1) throw new Error("cleanup failed") }
    } })
    await f.driver.start()
    f.driver.stop()
    await expect(f.driver.start()).rejects.toThrow(/cleanup/)
    expect(acquisitions).toBe(1)
    f.driver.stop()
    await f.driver.start()
    expect(acquisitions).toBe(2)
    await f.driver.close()
    expect(cleanups).toBe(3)
  })

  it("fences unknown acquisition failure without inventing a cleanup handle", async () => {
    let acquisitions = 0
    const f = deadlineFixture({ subscribeMutations: () => { acquisitions++; throw new Error("atomic acquisition failed") } })
    const result = await f.driver.start()
    expect(result.deliveryErrors).toEqual(["<driver>: atomic acquisition failed"])
    expect(f.driver.isRunning()).toBe(false)
    await expect(f.driver.start()).rejects.toThrow(/acquisition/)
    await expect(f.driver.close()).rejects.toThrow(/acquisition/)
    await expect(f.driver.close()).rejects.toThrow(/acquisition/)
    expect(acquisitions).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps acquisition and known cleanup fenced even when callbacks throw undefined", async () => {
    const unknown = deadlineFixture({ subscribeMutations: () => { throw undefined } })
    expect((await unknown.driver.start()).deliveryErrors).toEqual(["<driver>: undefined"])
    await expect(unknown.driver.start()).rejects.toThrow(/acquisition/)
    await expect(unknown.driver.close()).rejects.toThrow(/acquisition/)
    let attempts = 0
    const known = deadlineFixture({ subscribeMutations: () => () => { if (++attempts === 1) throw undefined } })
    await known.driver.start()
    known.driver.stop()
    await expect(known.driver.start()).rejects.toThrow(/cleanup/)
    await known.driver.close()
    expect(attempts).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("ignores an obsolete queued timeout and subscription callback after restart", async () => {
    let oldChanged!: (id?: string) => void
    const f = deadlineFixture({ subscribeMutations: (changed) => { oldChanged ??= changed; return () => {} } })
    f.sessions.s = afterSession("s", 10)
    const timeout = vi.spyOn(globalThis, "setTimeout")
    await f.driver.start()
    const oldTimeout = timeout.mock.calls[0]![0] as () => void
    f.driver.stop()
    await f.driver.start()
    f.sessions.s.events.push(createEvent(createAfterScheduleRecord("new", "new", 1, NOW)))
    oldTimeout()
    oldChanged("s")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.deliveries).toEqual([])
    f.driver.invalidate("mutation", "s")
    await vi.advanceTimersByTimeAsync(0)
    expect(f.deliveries.map((d) => d.due[0]!.record.id)).toEqual(["new"])
    await f.driver.close()
    timeout.mockRestore()
  })

  it("rereads final create/delete state after held delivery without repeating that occurrence", async () => {
    const held = deferred()
    const f = deadlineFixture({ deliver: async (delivery) => {
      f.deliveries.push(delivery)
      await held.promise
      f.sessions.s!.events.push(...delivery.dispatchEvents)
      f.changed("s")
    } })
    f.sessions.s = afterSession("s", 1)
    vi.setSystemTime(NOW + 2_000)
    const started = f.driver.start()
    f.sessions.s.events.push(createEvent(createAfterScheduleRecord("deleted", "deleted", 3, NOW)))
    f.changed("s")
    f.sessions.s.events.push({ type: "schedule/change", version: 1, operation: "delete", id: "deleted" })
    f.sessions.s.events.push(createEvent(createAfterScheduleRecord("final", "final", 5, NOW)))
    f.changed("s")
    held.resolve()
    await started
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(f.deliveries).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.deliveries.map((d) => d.due[0]!.record.id)).toEqual(["schedule-1", "final"])
    expect(vi.getTimerCount()).toBe(0)
    await f.driver.close()
  })

  it("re-drives progressed overdue remainder through a one-shot callback, one decision per session", async () => {
    const f = deadlineFixture()
    f.sessions.s = afterSession("s", 1)
    f.sessions.s.events.push(createEvent(createEveryScheduleRecord("every", "every", 300, NOW)))
    vi.setSystemTime(NOW + 600_000)
    expect((await f.driver.start()).delivered).toBe(1)
    expect(f.deliveries).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.deliveries).toHaveLength(2)
    expect(f.deliveries[1]!.inputId).toBe("schedule-batch@2026-08-31T10:10:00.000Z")
    expect(f.deliveries[1]!.due[0]!.occurrenceAt).toBe("2026-08-31T10:10:00.000Z")
    await f.driver.close()
  })

  it("rechecks wall time after backward jumps and responds to explicit forward clock/resume invalidation", async () => {
    let wall = NOW
    const f = deadlineFixture({ now: () => wall })
    f.sessions.s = afterSession("s", 10)
    await f.driver.start()
    wall = NOW - 5_000
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.deliveries).toEqual([])
    expect(vi.getTimerCount()).toBe(1)
    wall = NOW + 11_000
    f.driver.invalidate("clock")
    await vi.advanceTimersByTimeAsync(0)
    expect(f.deliveries).toHaveLength(1)
    f.sessions.s.events.push(createEvent(createAfterScheduleRecord("later", "later", 30, NOW)))
    f.changed("s")
    await vi.advanceTimersByTimeAsync(0)
    wall = NOW + 31_000
    f.driver.invalidate("resume")
    await vi.advanceTimersByTimeAsync(0)
    expect(f.deliveries).toHaveLength(2)
    await f.driver.close()
  })

  it("caps platform timeout without delivering the still-future target", async () => {
    const f = deadlineFixture()
    f.sessions.s = afterSession("s", 3_000_000)
    await f.driver.start()
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(f.deliveries).toEqual([])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(852_516_352)
    expect(f.deliveries).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(f.deliveries).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    await f.driver.close()
  })

  it("does not arm exhausted every records or redeliver accepted occurrences on cold restart", async () => {
    const max = Date.parse("9999-12-31T23:59:59.999Z")
    const f = deadlineFixture({ now: () => max })
    f.sessions.s = { events: [createEvent(createEveryScheduleRecord("last", "last", 300, max - 300_000))] }
    await f.driver.start()
    expect(f.deliveries).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    await f.driver.close()
    const restarted = createScheduleDriver({ sessions: () => ["s"], events: () => f.sessions.s!.events,
      deliver: () => { throw new Error("accepted occurrence repeated") }, now: () => max })
    expect((await restarted.start()).deliveryErrors).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    await restarted.close()
  })
})

describe("schedule deadline failures", () => {
  afterEach(() => { vi.useRealTimers() })

  it("settles enumeration errors, guards a throwing warning callback and permits explicit retry", async () => {
    let broken = true
    const f = deadlineFixture({ sessions: () => { if (broken) throw new Error("enumeration failed"); return ["s"] },
      logWarn: () => { throw new Error("warning failed") } })
    f.sessions.s = afterSession("s", 1)
    vi.setSystemTime(NOW + 2_000)
    expect((await f.driver.start()).deliveryErrors).toEqual(["<driver>: enumeration failed"])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(100_000)
    broken = false
    f.driver.invalidate("retry")
    await vi.advanceTimersByTimeAsync(0)
    expect(f.deliveries).toHaveLength(1)
    await f.driver.close()
  })

  it.each(["read", "fold", "decision"] as const)("contains %s failure per session and continues healthy deadlines", async (failure) => {
    let broken = true
    const f = deadlineFixture({
      events: (id) => {
        if (id === "bad" && broken && failure === "read") throw new Error("read failed")
        return f.sessions[id]?.events
      },
      now: failure === "decision" ? () => Date.parse("9999-12-31T23:59:59.999Z") + 1 : undefined,
      logWarn: () => { throw new Error("warning failed") },
    })
    f.sessions.bad = failure === "decision" ? everySession("bad", 300) : afterSession("bad", 1)
    if (failure === "fold") f.sessions.bad.events.push(createEvent(createAfterScheduleRecord("schedule-1", "duplicate", 1, NOW)))
    f.sessions.good = afterSession("good", 5)
    vi.setSystemTime(NOW + 2_000)
    const result = await f.driver.start()
    expect(result.deliveryErrors).toHaveLength(1)
    expect(result.deliveryErrors[0]).toMatch(/^bad:/)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.deliveries.map((d) => d.sessionId)).toEqual(["good"])
    expect(vi.getTimerCount()).toBe(0)
    if (failure === "read") {
      broken = false
      expect((await f.driver.tick()).delivered).toBe(1)
    }
    await f.driver.close()
  })

  it.each(["nothing", "unrelated"] as const)("reports success with %s publication as no progress and never spins", async (publication) => {
    const f = deadlineFixture({ deliver: (delivery) => {
      f.deliveries.push(delivery)
      if (publication === "unrelated") f.sessions.s!.events.push({ type: "schedule/change", version: 1,
        operation: "create", schedule: createAfterScheduleRecord("unrelated", "unrelated", 60, NOW) })
    } })
    f.sessions.s = afterSession("s", 1)
    vi.setSystemTime(NOW + 2_000)
    const result = await f.driver.start()
    expect(result.delivered).toBe(1)
    expect(result.deliveryErrors).toEqual(["s: delivery did not advance schedule state"])
    expect(vi.getTimerCount()).toBe(0)
    for (let n = 0; n < 5; n++) { f.changed("s"); await vi.advanceTimersByTimeAsync(0) }
    await vi.advanceTimersByTimeAsync(100_000)
    expect(f.deliveries).toHaveLength(1)
    await f.driver.close()
  })

  it("cannot treat a missing post-handoff source as acknowledgement of the occurrence", async () => {
    let visible = true
    const f = deadlineFixture({
      events: (id) => visible ? f.sessions[id]?.events : undefined,
      deliver: (delivery) => { f.deliveries.push(delivery); visible = false },
    })
    f.sessions.s = afterSession("s", 1)
    vi.setSystemTime(NOW + 2_000)
    const result = await f.driver.start()
    expect(result.delivered).toBe(1)
    expect(result.deliveryErrors).toEqual(["s: delivery did not advance schedule state"])
    visible = true
    f.changed("s")
    await vi.advanceTimersByTimeAsync(100_000)
    expect(f.deliveries).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    await f.driver.close()
  })

  it("suppresses unchanged failed tuples on notifications but retries scoped progression and explicit triggers", async () => {
    const attempts: string[] = []
    const f = deadlineFixture({ deliver: (delivery) => {
      attempts.push(delivery.sessionId)
      if (delivery.sessionId === "bad") throw new Error("ambiguous handoff")
      f.sessions[delivery.sessionId]!.events.push(...delivery.dispatchEvents)
    } })
    f.sessions.bad = afterSession("bad", 1)
    f.sessions.good = afterSession("good", 10)
    vi.setSystemTime(NOW + 2_000)
    expect((await f.driver.start()).deliveryErrors).toEqual(["bad: ambiguous handoff"])
    for (let n = 0; n < 5; n++) { f.changed("bad"); await vi.advanceTimersByTimeAsync(0) }
    expect(attempts).toEqual(["bad"])
    await vi.advanceTimersByTimeAsync(8_000)
    expect(attempts).toEqual(["bad", "good"])
    f.driver.invalidate("retry", "good")
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toEqual(["bad", "good"])
    f.driver.invalidate("retry", "bad")
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toEqual(["bad", "good", "bad"])
    f.sessions.bad.events.push(createEvent(createAfterScheduleRecord("new", "new", 20, NOW)))
    f.changed("bad")
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toEqual(["bad", "good", "bad", "bad"])
    await f.driver.tick()
    expect(attempts).toHaveLength(5)
    f.driver.stop()
    await f.driver.start()
    expect(attempts).toHaveLength(6)
    expect(vi.getTimerCount()).toBe(0)
    await f.driver.close()
  })

  it("rereads a rejected handoff that really advanced and delivers only the overdue remainder", async () => {
    const f = deadlineFixture({ deliver: (delivery) => {
      f.deliveries.push(delivery)
      f.sessions.s!.events.push(...delivery.dispatchEvents)
      if (f.deliveries.length === 1) throw new Error("committed then rejected")
    } })
    f.sessions.s = afterSession("s", 1)
    f.sessions.s.events.push(createEvent(createAfterScheduleRecord("second", "second", 2, NOW)))
    vi.setSystemTime(NOW + 3_000)
    const result = await f.driver.start()
    expect(result.delivered).toBe(0)
    expect(result.deliveryErrors).toEqual(["s: committed then rejected"])
    await vi.advanceTimersByTimeAsync(0)
    expect(f.deliveries.map((d) => d.inputId)).toEqual([
      "schedule-1@2026-08-31T10:00:01.000Z", "second@2026-08-31T10:00:02.000Z",
    ])
    expect(vi.getTimerCount()).toBe(0)
    await f.driver.close()
  })

  it("requires all handed-off every occurrences to advance before automatic catch-up", async () => {
    const f = deadlineFixture({ deliver: (delivery) => {
      f.deliveries.push(delivery)
      f.sessions.s!.events.push(delivery.dispatchEvents[0]!)
    } })
    f.sessions.s = everySession("s", 300)
    f.sessions.s.events.push(createEvent(createEveryScheduleRecord("second", "second", 300, NOW)))
    vi.setSystemTime(NOW + 600_000)
    const result = await f.driver.start()
    expect(result.delivered).toBe(2)
    expect(result.deliveryErrors).toEqual(["s: delivery did not advance schedule state"])
    f.changed("s")
    await vi.advanceTimersByTimeAsync(1_000_000)
    expect(f.deliveries).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    await f.driver.close()
  })

  it("contains autonomous timer failures without an unhandled rejection or retry timer", async () => {
    let attempts = 0
    const f = deadlineFixture({ deliver: () => { attempts++; throw new Error("timer handoff failed") },
      logWarn: () => { throw new Error("warning failed") } })
    f.sessions.s = afterSession("s", 1)
    await f.driver.start()
    await vi.advanceTimersByTimeAsync(100_000)
    expect(attempts).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect((await f.driver.tick()).deliveryErrors).toEqual(["s: timer handoff failed"])
    expect(attempts).toBe(2)
    await f.driver.close()
  })
})
