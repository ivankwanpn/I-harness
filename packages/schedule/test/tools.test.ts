import { describe, expect, it } from "vitest"
import { append, createSession, type SessionEvent } from "@i-harness/core-session"
import {
  MIN_EVERY_INTERVAL_SECONDS,
  ScheduleInputError,
  foldScheduleEvents,
  type ScheduleRecord,
} from "../src/index.ts"
import { createScheduleTools } from "../src/tools.ts"

/** The three tools over one fresh session — `execute(args, {})` is the direct call shape. */
function setup(header?: { seedLength: number }) {
  const session = createSession()
  if (header !== undefined) session.header = header
  const tools = createScheduleTools({ session })
  const [create, list, remove] = tools
  return { session, tools, create, list, remove }
}

/** The rejection reason, typed — `rejects.toThrow` cannot read `.code`. */
async function failureOf(promise: Promise<unknown>): Promise<ScheduleInputError> {
  try {
    await promise
  } catch (err) {
    return err as ScheduleInputError
  }
  throw new Error("expected the call to reject, but it resolved")
}

function createEvent(schedule: ScheduleRecord): SessionEvent {
  return { type: "schedule/change", version: 1, operation: "create", schedule }
}

describe("schedule_create (the exactly-one selector lives in the handler — no oneOf in the dialect)", () => {
  it("after: allocates schedule-1 then schedule-2 (ids never reuse)", async () => {
    const { session, create, remove } = setup()
    expect(await create.execute({ prompt: "a", after_seconds: 60 }, {})).toMatchObject({ id: "schedule-1", kind: "after" })
    expect(await create.execute({ prompt: "b", after_seconds: 120 }, {})).toMatchObject({ id: "schedule-2", kind: "after" })
    // one append per accepted create, carrying the ENGINE's record (not the model's args)
    expect(session.events).toHaveLength(2)
    expect(session.events[0]).toMatchObject({
      type: "schedule/change",
      version: 1,
      operation: "create",
      schedule: { id: "schedule-1", kind: "after", prompt: "a", afterSeconds: 60 },
    })
    await remove.execute({ id: "schedule-1" }, {})
    // the freed id is NOT reused: the id space is append-only
    expect(await create.execute({ prompt: "c", after_seconds: 60 }, {})).toMatchObject({ id: "schedule-3" })
  })

  it("trims the prompt; an empty prompt is invalid_prompt and appends NOTHING", async () => {
    const { session, create } = setup()
    await create.execute({ prompt: "  water the plants  ", after_seconds: 60 }, {})
    expect(session.events[0]).toMatchObject({ schedule: { prompt: "water the plants" } })
    const err = await failureOf(create.execute({ prompt: "   ", after_seconds: 60 }, {}))
    expect(err).toBeInstanceOf(ScheduleInputError)
    expect(err.code).toBe("invalid_prompt")
    expect(session.events).toHaveLength(1)
  })

  it("at: a past instant is not_future; a future offset instant converts to UTC", async () => {
    const { create } = setup()
    const err = await failureOf(create.execute({ prompt: "x", at: "2020-01-01T00:00:00.000Z" }, {}))
    expect(err).toBeInstanceOf(ScheduleInputError)
    expect(err.code).toBe("not_future")
    expect(await create.execute({ prompt: "call home", at: "2999-01-01T00:00:00+08:00" }, {}))
      .toMatchObject({ kind: "at", scheduledAt: "2998-12-31T16:00:00.000Z" })
  })

  it("every: below the 300 s floor is frequency_too_high; the floor itself is accepted", async () => {
    const { create } = setup()
    const err = await failureOf(create.execute({ prompt: "x", every_seconds: MIN_EVERY_INTERVAL_SECONDS - 1 }, {}))
    expect(err).toBeInstanceOf(ScheduleInputError)
    expect(err.code).toBe("frequency_too_high")
    expect(await create.execute({ prompt: "ping the build", every_seconds: MIN_EVERY_INTERVAL_SECONDS }, {}))
      .toMatchObject({ kind: "every" })
  })

  it("zero selectors is invalid_rule, and the message names the exactly-one rule the schema cannot", async () => {
    const { session, create } = setup()
    const err = await failureOf(create.execute({ prompt: "x" }, {}))
    expect(err).toBeInstanceOf(ScheduleInputError)
    expect(err.code).toBe("invalid_rule")
    expect(err.message).toMatch(/exactly one of after_seconds, at, every_seconds/)
    expect(session.events).toHaveLength(0) // checked BEFORE the fold/append
  })

  it("two selectors is invalid_rule as well", async () => {
    const { session, create } = setup()
    const err = await failureOf(create.execute({ prompt: "x", after_seconds: 60, every_seconds: 600 }, {}))
    expect(err).toBeInstanceOf(ScheduleInputError)
    expect(err.code).toBe("invalid_rule")
    expect(err.message).toMatch(/exactly one/)
    expect(session.events).toHaveLength(0)
  })
})

describe("schedule_list", () => {
  it("reports state scheduled vs overdue", async () => {
    const { session, create, list } = setup()
    await create.execute({ prompt: "future", after_seconds: 3600 }, {})
    // create*ScheduleRecord refuses past instants, so the overdue record is HAND-BUILT —
    // the fold accepts a past scheduledAt (a valid durable record, merely late).
    append(session, createEvent({ id: "schedule-2", kind: "at", prompt: "late", scheduledAt: "2020-01-01T00:00:00.000Z" }))
    expect(await list.execute({}, {})).toMatchObject({
      schedules: [
        { id: "schedule-1", kind: "after", prompt: "future", afterSeconds: 3600, state: "scheduled", deliveryMode: "session-local" },
        { id: "schedule-2", kind: "at", prompt: "late", scheduledAt: "2020-01-01T00:00:00.000Z", state: "overdue", deliveryMode: "session-local" },
      ],
    })
  })

  it("in a seeded session it shows ONLY the session's own suffix", async () => {
    // The forked-session shape (§5): events[0] is the parent's record, header.seedLength = 1.
    const parent = createEvent({ id: "schedule-1", kind: "at", prompt: "the parent's", scheduledAt: "2020-01-01T00:00:00.000Z" })
    const child = setup({ seedLength: 1 })
    append(child.session, parent)
    // Fixture sanity: the record IS in the raw stream (a whole-stream fold sees it), so the
    // empty list below proves the SLICE, not an absent event.
    expect(foldScheduleEvents(child.session.events).active).toHaveLength(1)
    expect(await child.list.execute({}, {})).toEqual({ schedules: [] })
    // The same log without the seed header: the parent's record is listed, and reads overdue.
    const plain = setup()
    append(plain.session, parent)
    expect(await plain.list.execute({}, {})).toMatchObject({ schedules: [{ id: "schedule-1", state: "overdue" }] })
  })
})

describe("schedule_delete", () => {
  it("removes an active record; an unknown id throws and appends NOTHING", async () => {
    const { session, create, list, remove } = setup()
    await create.execute({ prompt: "bye", after_seconds: 60 }, {})
    expect(await remove.execute({ id: "schedule-1" }, {})).toEqual({ deleted: "schedule-1" })
    expect(session.events.at(-1)).toMatchObject({ type: "schedule/change", version: 1, operation: "delete", id: "schedule-1" })
    expect(await list.execute({}, {})).toEqual({ schedules: [] })
    const before = session.events.length
    // already deleted ⇒ inactive; never created ⇒ unknown — both are soft body failures
    expect((await failureOf(remove.execute({ id: "schedule-1" }, {}))).message)
      .toMatch(/no active schedule with id "schedule-1"/)
    expect((await failureOf(remove.execute({ id: "schedule-99" }, {}))).message)
      .toMatch(/no active schedule with id "schedule-99"/)
    expect(session.events).toHaveLength(before)
  })

  it("in a seeded session, the parent's id is not this session's to delete", async () => {
    const child = setup({ seedLength: 1 })
    append(child.session, createEvent({ id: "schedule-1", kind: "at", prompt: "the parent's", scheduledAt: "2020-01-01T00:00:00.000Z" }))
    expect((await failureOf(child.remove.execute({ id: "schedule-1" }, {}))).message).toMatch(/no active schedule/)
    expect(child.session.events).toHaveLength(1) // the seeded prefix only
    // …and the child's own id space starts at schedule-1: it never saw the parent's.
    expect(await child.create.execute({ prompt: "mine", after_seconds: 60 }, {})).toMatchObject({ id: "schedule-1" })
    expect(child.session.events.at(-1)).toMatchObject({ operation: "create", schedule: { id: "schedule-1", prompt: "mine" } })
  })
})

describe("tool flags", () => {
  it("create/delete are NOT concurrency-safe (fold-read-then-append); list is read-only", () => {
    const { tools } = setup()
    expect(tools.map((tool) => tool.name)).toEqual(["schedule_create", "schedule_list", "schedule_delete"])
    const [create, list, remove] = tools
    // Two parallel creates would fold the SAME state and allocate the SAME id — the
    // scheduler serializes non-safe tools for exactly this shape. (todo_write can be
    // safe because it REPLACES; these append, so their reads and writes must not split.)
    expect(create.isConcurrencySafe).toBe(false)
    expect(remove.isConcurrencySafe).toBe(false)
    expect(create.isReadOnly).toBe(false)
    expect(remove.isReadOnly).toBe(false)
    expect(list.isReadOnly).toBe(true) // reads the log, writes nothing
    expect(list.isConcurrencySafe).toBe(true)
  })
})
