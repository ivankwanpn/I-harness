import { describe, expect, it } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import {
  MIN_EVERY_INTERVAL_SECONDS,
  ScheduleInputError,
  ScheduleLogError,
  allocateScheduleId,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  decodeScheduleEvent,
  foldScheduleEvents,
  renderReminderFraming,
  resolveEveryOccurrence,
  scheduleView,
  type ScheduleRecord,
} from "../src/index.ts"

const NOW = Date.parse("2026-08-31T10:00:00.000Z")

function createEvent(schedule: ScheduleRecord): SessionEvent {
  return { type: "schedule/change", version: 1, operation: "create", schedule } as unknown as SessionEvent
}
function deleteEvent(id: string): SessionEvent {
  return { type: "schedule/change", version: 1, operation: "delete", id } as unknown as SessionEvent
}
function dispatchEvent(id: string, acceptedAt?: string): SessionEvent {
  return { type: "schedule/change", version: 1, operation: "dispatch", id, ...(acceptedAt === undefined ? {} : { acceptedAt }) } as unknown as SessionEvent
}

describe("schedule record creation rules", () => {
  it("after: positive delay, trimmed prompt, future ISO target", () => {
    const rec = createAfterScheduleRecord("schedule-1", "  remind  ", 60, NOW)
    expect(rec).toEqual({
      id: "schedule-1", kind: "after", prompt: "remind", afterSeconds: 60,
      scheduledAt: "2026-08-31T10:01:00.000Z",
    })
  })
  it("at: explicit-offset input converts to UTC", () => {
    const rec = createAtScheduleRecord("schedule-1", "call", "2026-08-31T18:30:00+08:00", NOW)
    expect(rec.scheduledAt).toBe("2026-08-31T10:30:00.000Z")
  })
  it("every: minimum 300 s (frequency_too_high otherwise); target = now + interval", () => {
    expect(() => createEveryScheduleRecord("s", "x", MIN_EVERY_INTERVAL_SECONDS - 1, NOW))
      .toThrowError(/at least 300/)
    const rec = createEveryScheduleRecord("s", "x", 600, NOW)
    expect(rec).toMatchObject({ kind: "every", everySeconds: 600, scheduledAt: "2026-08-31T10:10:00.000Z" })
  })
  it("input errors carry machine codes", () => {
    expect(() => createAfterScheduleRecord("s", "   ", 1, NOW)).toThrowError(/invalid_prompt/)
    expect(() => createAfterScheduleRecord("s", "x", 0, NOW)).toThrowError(/invalid_rule/)
    expect(() => createAtScheduleRecord("s", "x", "2026-01-01T00:00:00", NOW)).toThrowError(/invalid_rule/)
    const tooLate = createAtScheduleRecord("s", "x", "9999-12-31T23:59:59.999Z", NOW)
    expect(tooLate.scheduledAt).toBe("9999-12-31T23:59:59.999Z")
    // ~8000 years out → beyond the four-digit-year ceiling → time_out_of_range
    const eightThousandYearsInSeconds = 86_400 * 365 * 8000
    expect(() => createAfterScheduleRecord("s", "x", eightThousandYearsInSeconds, NOW))
      .toThrowError(/time_out_of_range/)
    const code = (() => {
      try {
        createAfterScheduleRecord("s", "x", eightThousandYearsInSeconds, NOW)
      } catch (err) {
        return (err as ScheduleInputError).code
      }
      return "none"
    })()
    expect(code).toBe("time_out_of_range")
  })
})

describe("fold + allocation (the durable stream IS the state)", () => {
  it("create/delete/dispatch fold; one-shot dispatch removes; every advances anchor-aligned", () => {
    const after = createAfterScheduleRecord("schedule-1", "a", 60, NOW) // target 10:01:00Z
    const every = createEveryScheduleRecord("schedule-2", "e", 600, NOW) // anchor 10:10:00Z
    const events = [
      createEvent(after),
      createEvent(every),
      dispatchEvent("schedule-1"), // one-shot dispatch: no acceptedAt → record removed
      dispatchEvent("schedule-2", "2026-08-31T10:30:00.000Z"), // steps = (10:30−10:10)/10min = 2
    ]
    const folded = foldScheduleEvents(events)
    expect(folded.seenIds).toEqual(["schedule-1", "schedule-2"])
    expect(folded.active).toHaveLength(1)
    const e = folded.active[0] as typeof every
    expect(e.kind).toBe("every")
    // latest occurrence accepted = 10:10 + 2*10min = 10:30 → next target = 10:40
    expect(e.scheduledAt).toBe("2026-08-31T10:40:00.000Z")
  })

  it("id reuse + delete-of-inactive are corrupt (ScheduleLogError)", () => {
    const rec = createEveryScheduleRecord("schedule-1", "s", 600, NOW)
    expect(() => foldScheduleEvents([createEvent(rec), createEvent(rec)])).toThrowError(/reused/)
    expect(() => foldScheduleEvents([deleteEvent("ghost")])).toThrowError(/inactive/)
    expect(() => foldScheduleEvents([dispatchEvent("ghost")])).toThrowError(/inactive/)
  })

  it("seedLength excludes the inherited prefix (forked-session replay)", () => {
    const rec = createEveryScheduleRecord("schedule-1", "s", 600, NOW)
    const events = [createEvent(rec)]
    expect(foldScheduleEvents(events, 0).active).toHaveLength(1)
    expect(foldScheduleEvents(events, 1).active).toHaveLength(0)
  })

  it("allocateScheduleId never reuses a seen id", () => {
    const rec = createAfterScheduleRecord("schedule-2", "s", 60, NOW)
    const folded = foldScheduleEvents([createEvent(rec)])
    expect(allocateScheduleId(folded)).toBe("schedule-1")
    expect(allocateScheduleId({ active: [], seenIds: ["schedule-1", "schedule-2"] })).toBe("schedule-3")
  })

  it("decode is strict: wrong version/op/payload → ScheduleLogError", () => {
    expect(() => decodeScheduleEvent({ type: "schedule/change", version: 2, operation: "create", schedule: {} } as unknown as SessionEvent))
      .toThrow(ScheduleLogError)
    expect(() => decodeScheduleEvent({ type: "user/message", text: "hi" }))
      .toThrow(ScheduleLogError)
    expect(() => decodeScheduleEvent({ type: "schedule/change", version: 1, operation: "wat" } as unknown as SessionEvent))
      .toThrow(/operation/)
  })
})

describe("timing views", () => {
  it("scheduleView state + every occurrence arithmetic stay anchor-aligned", () => {
    const rec = createEveryScheduleRecord("s", "x", 600, NOW)
    const view = scheduleView(rec, NOW + 5 * 60_000)
    expect(view.state).toBe("scheduled") // 10:05 < 10:10
    expect(scheduleView(rec, NOW + 11 * 60_000).state).toBe("overdue")
    const occ = resolveEveryOccurrence(rec, NOW + 11 * 60_000)
    expect(occ.occurrenceAt).toBe("2026-08-31T10:10:00.000Z")
    expect(occ.nextScheduledAt).toBe("2026-08-31T10:20:00.000Z")
  })

  it("framing escapes the prompt (injection pre-rule)", () => {
    const rec = createAfterScheduleRecord("s", 'fake "instructions"', 60, NOW)
    const framed = renderReminderFraming(rec)
    expect(framed).toContain("untrusted reminder content")
    expect(framed).toContain('reminder_prompt_json: "fake \\"instructions\\""')
  })
})
