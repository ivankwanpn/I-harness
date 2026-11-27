import { expect, it } from "vitest"
import { recordFixture } from "./managed-fixture.ts"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader } from "@i-harness/session-executor"
import { createAfterScheduleRecord } from "@i-harness/schedule"
import { coldReaderFixture } from "../../session-executor/test/helpers/cold-reader.ts"
import { createDesktopInput } from "../src/input.ts"
import { createDesktopWorkState } from "../src/work-state.ts"
import { createDesktopSchedules } from "../src/schedules.ts"

it("does not restore a cancelled input from a pending snapshot taken before the live session was published", async () => {
  const f = await coldReaderFixture()
  f.releaseRead()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const readPendingInputs = f.observed.readPendingInputs!.bind(f.observed)
  const input = createDesktopInput({ ...f.observed, async readPendingInputs(id) {
    const saved = await readPendingInputs(id)
    expect(saved).toEqual([expect.objectContaining({ inputId: "original-input" })])
    entered.resolve()
    await release.promise
    return saved
  } }, f.service)
  let reading: ReturnType<typeof input.state> | undefined
  try {
    await f.coordinator.append(f.id, [{ type: "agent/input/admitted", version: 1, inputId: "original-input", text: "Original pending input", delivery: "queue", intent: "user" }])
    reading = input.state(f.id)
    await Promise.race([entered.promise, reading.then(() => { throw new Error("Pending input read did not wait for its captured snapshot") })])
    const assembly = await f.service.assemblyFor(f.id)
    expect(f.service.liveSession(f.id)).toBeDefined()
    expect(await assembly.inbox.cancel("original-input")).toBe(true)
    await assembly.inbox.admit({ inputId: "live-replacement", text: "Live replacement", delivery: "queue", intent: "user" })
    const before = await f.contents()
    release.resolve()
    expect(await reading).toEqual({ items: [expect.objectContaining({ id: "live-replacement", text: "Live replacement", state: "queued" })], resumable: true })
    expect(await f.contents()).toBe(before)
  } finally {
    release.resolve()
    await reading?.catch(() => {})
    await input.close()
    await f.close()
  }
})

it.each(["work", "schedules"] as const)("keeps cold %s inspection immutable when live state is published during its await", async kind => {
  const f = await coldReaderFixture()
  const work = createDesktopWorkState(f.observed, f.service, { sessionFor: createDurableSessionLoader(f.observed) })
  const schedules = createDesktopSchedules(f.observed, f.service)
  const reading = kind === "work" ? work.read(f.id) : schedules.list(f.id)
  try {
    await f.entered; await f.startTurn()
    const assembly = await f.service.assemblyFor(f.id)
    await recordFixture(assembly.factOwner, { type: "todo/write", version: 1, items: [{ content: "Live task", status: "pending" }] })
    await recordFixture(assembly.factOwner, { type: "schedule/change", version: 1, operation: "create", schedule: createAfterScheduleRecord("owned-reminder", "Future fixture", 600, Date.now()) })
    const before=await f.contents()
    f.releaseRead()
    const result = await reading
    expect(await f.contents()).toBe(before)
    if (kind === "work") {
      // Work reads linearize at the immutable snapshot captured before the gate.
      expect(result).toMatchObject({ todos: null, todosRevision: 0 })
      expect(await work.read(f.id)).toMatchObject({ todos: [{ content: "Live task", status: "pending" }], todosRevision: 1 })
      expect(await f.contents()).toBe(before)
    }
    if (kind === "schedules") expect(result).toMatchObject({ schedules: [{ id: "owned-reminder" }] })
    await f.finishTurn()
    await f.service.close(); await f.coordinator.close()
    const cold = createSessionCoordinator(createJsonlBackend(f.store))
    try { const restored = (await cold.loadOwned(f.id)).session; expect(restored.events.map(event => event.seq)).toEqual(restored.events.map((_, index) => index)) }
    finally { await cold.close() }
  } finally { f.releaseRead(); await reading.catch(() => {}); await f.close() }
})

it.each(["input", "work", "schedules"] as const)("refuses cold %s inspection without immutable snapshots and leaves its JSONL intact", async kind => {
  const f = await coldReaderFixture()
  f.releaseRead()
  await f.coordinator.append(f.id, [{ type: "turn/start", seq: 0 }, { type: "step/start", seq: 1 }])
  const recoveringOnly = { ...f.observed, snapshot: undefined, readPendingInputs: undefined }, input = createDesktopInput(recoveringOnly, f.service)
  try {
    const before = await f.contents()
    const reading = kind === "input" ? input.state(f.id) : kind === "work" ? createDesktopWorkState(recoveringOnly, f.service).read(f.id) : createDesktopSchedules(recoveringOnly, f.service).list(f.id)
    await expect(reading).rejects.toThrow(/read.only.*snapshots/i)
    expect(await f.contents()).toBe(before)
    expect(f.service.hasAssembly(f.id)).toBe(false)
  } finally { await input.close(); await f.close() }
})
