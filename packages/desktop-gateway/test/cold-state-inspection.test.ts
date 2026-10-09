import { expect, it } from "vitest"
import { append } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader } from "@i-harness/session-executor"
import { createAfterScheduleRecord } from "@i-harness/schedule"
import { coldReaderFixture } from "../../session-executor/test/helpers/cold-reader.ts"
import { createDesktopInput } from "../src/input.ts"
import { createDesktopWorkState } from "../src/work-state.ts"
import { createDesktopSchedules } from "../src/schedules.ts"

it.each(["input", "work", "schedules"] as const)("keeps cold %s inspection immutable and prefers the live state published during its await", async kind => {
  const f = await coldReaderFixture(), input = createDesktopInput(f.observed, f.service)
  const work = createDesktopWorkState(f.observed, f.service, { sessionFor: createDurableSessionLoader(f.observed) })
  const schedules = createDesktopSchedules(f.observed, f.service)
  const reading = kind === "input" ? input.state(f.id) : kind === "work" ? work.read(f.id) : schedules.list(f.id)
  try {
    await f.entered; await f.startTurn()
    const before = await f.contents(), assembly = await f.service.assemblyFor(f.id)
    assembly.inbox.admit({ inputId: "owned-steer", text: "Owned steering", delivery: "steer", intent: "user" })
    append(assembly.session, { type: "todo/write", version: 1, items: [{ content: "Live task", status: "pending" }] })
    append(assembly.session, { type: "schedule/change", version: 1, operation: "create", schedule: createAfterScheduleRecord("owned-reminder", "Future fixture", 600, Date.now()) })
    f.releaseRead()
    const result = await reading
    expect(await f.contents()).toBe(before)
    if (kind === "input") expect(result).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: "owned-steer" })]) })
    if (kind === "work") expect(result).toMatchObject({ todos: [{ content: "Live task", status: "pending" }], todosRevision: 1 })
    if (kind === "schedules") expect(result).toMatchObject({ schedules: [{ id: "owned-reminder" }] })
    await f.finishTurn()
    await input.close(); await f.service.close(); await f.coordinator.close()
    const cold = createSessionCoordinator(createJsonlBackend(f.store))
    try { const restored = (await cold.loadOwned(f.id)).session; expect(restored.events.map(event => event.seq)).toEqual(restored.events.map((_, index) => index)) }
    finally { await cold.close() }
  } finally { f.releaseRead(); await reading.catch(() => {}); await input.close(); await f.close() }
})

it.each(["input", "work", "schedules"] as const)("refuses cold %s inspection without immutable snapshots and leaves its JSONL intact", async kind => {
  const f = await coldReaderFixture()
  f.releaseRead()
  await f.coordinator.append(f.id, [{ type: "turn/start", seq: 0 }, { type: "step/start", seq: 1 }])
  const recoveringOnly = { ...f.observed, snapshot: undefined }, input = createDesktopInput(recoveringOnly, f.service)
  try {
    const before = await f.contents()
    const reading = kind === "input" ? input.state(f.id) : kind === "work" ? createDesktopWorkState(recoveringOnly, f.service).read(f.id) : createDesktopSchedules(recoveringOnly, f.service).list(f.id)
    await expect(reading).rejects.toThrow(/read.only.*snapshots/i)
    expect(await f.contents()).toBe(before)
    expect(f.service.hasAssembly(f.id)).toBe(false)
  } finally { await input.close(); await f.close() }
})
