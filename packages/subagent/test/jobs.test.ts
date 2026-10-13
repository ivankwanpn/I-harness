import { afterEach, describe, expect, it, vi } from "vitest"
import { createJobRegistry } from "../src/jobs.ts"
import { persistentJobRegistry, restoreState, snapshotState } from "../src/persist.ts"
import { createAgentTable } from "../src/agent-table.ts"
import { createRoleRegistry } from "../src/roles.ts"
afterEach(() => vi.useRealTimers())

it.each([Infinity, NaN, -Infinity, -1])("preserves legacy job timeout %s", async timeoutMs => {
  vi.useFakeTimers()
  const jobs = createJobRegistry(), { id } = jobs.registerJob("root", "subagent", "work")
  const waiting = jobs.wait(id, timeoutMs)
  expect(vi.getTimerCount()).toBe(0)
  if (timeoutMs === Infinity || Number.isNaN(timeoutMs)) jobs.updateJob(id, { status: "completed" })
  await waiting
})
it("keeps newer subscriptions when an old disposer is called twice", () => {
  const jobs = createJobRegistry(), { id } = jobs.registerJob("root", "subagent", "work")
  const off = jobs.subscribe(id, () => {})
  off()
  let delivered = false
  jobs.subscribe(id, () => { delivered = true })
  off()
  jobs.updateJob(id, { status: "completed" })
  expect(delivered).toBe(true)
})

it("observes a terminal transition even if the same job immediately reopens", async () => {
  vi.useFakeTimers()
  const timers = vi.spyOn(globalThis, "setTimeout")
  const jobs = createJobRegistry(), { id } = jobs.registerJob("root", "subagent", "work")
  const seen: string[] = []
  const off = jobs.subscribe(id, snapshot => seen.push(snapshot.status))
  const waiting = jobs.wait(id, 30_000)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(vi.getTimerCount()).toBe(1)
  expect(timers).toHaveBeenCalledTimes(1)
  jobs.updateJob(id, { status: "completed", output: "first" })
  jobs.updateJob(id, { status: "running", output: "" })
  await waiting
  expect(jobs.read(id).status).toBe("running")
  expect(seen).toEqual(["completed", "running"])
  expect(vi.getTimerCount()).toBe(0)
  off()
})
it("copies coherent job changes, isolates failed listeners and unsubscribes", async () => {
  const jobs = createJobRegistry(), producer = jobs.registerJob("root", "code", "work", undefined, undefined, () => {})
  expect(() => jobs.subscribe("absent", () => {})).toThrow("unknown job")
  await expect(jobs.wait("absent", 100)).resolves.toBeUndefined()
  const seen: unknown[] = []
  jobs.subscribe(producer.id, () => { throw new Error("listener") })
  const off = jobs.subscribe(producer.id, snapshot => seen.push(snapshot))
  jobs.kill(producer.id)
  producer.finish!("killed", "partial")
  producer.finish!("killed", "ignored")
  expect(seen).toHaveLength(2)
  expect(seen[0]).toMatchObject({ status: "killed", output: "", endedAt: expect.any(Number) })
  expect(seen[1]).toMatchObject({ status: "killed", output: "partial" })
  off()
  jobs.updateJob(producer.id, { status: "running" })
  expect(seen).toHaveLength(2)
})

describe("job registry", () => {
  it("publishes a cancelled producer's final output without reopening or replacing its killed disposition", () => {
    const controller = new AbortController(), jobs = persistentJobRegistry(createJobRegistry(), async () => {})
    const producer = jobs.registerJob("root", "code-context", "Index sources", undefined, undefined, () => controller.abort())
    jobs.kill(producer.id)
    producer.finish!("killed", '{"outcome":"cancelled","generation":1}')
    expect(jobs.read(producer.id)).toMatchObject({ status: "killed", output: '{"outcome":"cancelled","generation":1}' })
    producer.finish!("completed", "late claimed success")
    jobs.updateJob(producer.id, { status: "completed", output: "late generic update" })
    expect(jobs.read(producer.id)).toMatchObject({ status: "killed", output: '{"outcome":"cancelled","generation":1}' })
  })

  it("cancels live work through the durable job wrapper without serializing its callback", () => {
    const controller = new AbortController()
    const raw = createJobRegistry(), jobs = persistentJobRegistry(raw, async () => {})
    const { id } = jobs.registerJob("root", "code-context", "Index sources", "code-context-fixture", undefined, () => controller.abort())
    const snap = snapshotState({ jobs, table: createAgentTable(), roles: createRoleRegistry() })
    expect(snap.jobs[0]).toMatchObject({ id, kind: "code-context", status: "running" })
    expect(JSON.stringify(snap)).not.toContain('cancel')
    expect(jobs.kill(id)).toBe("cancellation-requested")
    expect(controller.signal.aborted).toBe(true)
    expect(jobs.kill(id)).toBe("already-finished")
    const restored = { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }
    restoreState(restored, JSON.parse(JSON.stringify(snap)))
    expect(restored.jobs.read(id)).toMatchObject({ status: "error", output: "interrupted by resume" })
    expect(restored.jobs.kill(id)).toBe("already-finished")
  })

  it("keeps a failed cancellation visible and retryable", () => {
    const controller = new AbortController(), jobs = createJobRegistry()
    let first = true
    const { id } = jobs.registerJob("root", "code-context", "Index sources", undefined, undefined, () => {
      if (first) { first = false; throw new Error("Cancellation transport failed") }
      controller.abort()
    })
    expect(() => jobs.kill(id)).toThrow("Cancellation transport failed")
    expect(jobs.read(id).status).toBe("running")
    expect(jobs.kill(id)).toBe("cancellation-requested")
    expect(controller.signal.aborted).toBe(true)
  })

  it("issues ids with per-kind monotonic counters", () => {
    const jobs = createJobRegistry()
    expect(jobs.registerJob("a", "bash", "build").id).toBe("bash-1")
    expect(jobs.registerJob("a", "subagent", "child").id).toBe("subagent-1")
    expect(jobs.registerJob("a", "bash", "test").id).toBe("bash-2")
  })

  it("read/list reflect updates; kill is terminal and blocks later updates", () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("a", "bash", "build")
    jobs.updateJob(id, { output: "compiling..." })
    expect(jobs.read(id).output).toBe("compiling...")
    expect(jobs.list("a")).toHaveLength(1)
    expect(jobs.list("other")).toHaveLength(0)
    expect(jobs.kill(id)).toBe("cancellation-requested")
    jobs.updateJob(id, { status: "completed", output: "late" })
    expect(jobs.read(id).status).toBe("killed")
    expect(jobs.read(id).output).toBe("compiling...")
  })

  it("wait resolves on terminal status", async () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("a", "bash", "build")
    let settled = false
    const p = jobs.wait(id, 2000).then(() => { settled = true })
    setTimeout(() => jobs.updateJob(id, { status: "completed" }), 20)
    await p
    expect(settled).toBe(true)
  })

  it("wait resolves on timeout without terminal status", async () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("a", "bash", "long")
    const started = Date.now()
    await jobs.wait(id, 50)
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
    expect(jobs.read(id).status).toBe("running")
  })

  // M24a (G2): registerJob accepts an explicit persisted id; duplicates fail
  // loud; updateJob reports unknown ids via false (observable, not silent).
  it("registerJob accepts a persisted id (duplicate throws); updateJob returns boolean", () => {
    const jobs = createJobRegistry()
    expect(jobs.registerJob("root", "subagent", "h", "subagent-7").id).toBe("subagent-7")
    expect(() => jobs.registerJob("root", "subagent", "dup", "subagent-7")).toThrow(/duplicate job id/)
    // Ruling M24a-T1a: explicit ids seed the per-kind counter, so the auto
    // generator continues AFTER the highest known id (skips occupied ids).
    expect(jobs.registerJob("root", "subagent", "next").id).toBe("subagent-8")
    expect(jobs.updateJob("subagent-7", { status: "completed", output: "done" })).toBe(true)
    expect(jobs.read("subagent-7").status).toBe("completed")
    expect(jobs.updateJob("unknown-id", { status: "completed" })).toBe(false)
  })

  // Ruling M24a-T1a: an explicit-id registration seeds the per-kind counter,
  // so the auto generator skips occupied ids instead of colliding post-resume.
  it("registerJob with explicit id seeds the counter (auto next skips occupied)", () => {
    const reg = createJobRegistry()
    reg.registerJob("root", "subagent", "a", "subagent-7")
    const { id } = reg.registerJob("root", "subagent", "b") // auto
    expect(id).toBe("subagent-8")
  })

  it("updateJob re-opens a terminal job when set to running again", () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("root", "subagent", "h")
    jobs.updateJob(id, { status: "completed", output: "done" })
    expect(jobs.read(id).status).toBe("completed")
    jobs.updateJob(id, { status: "running" })
    expect(jobs.read(id).status).toBe("running")
    jobs.updateJob(id, { status: "completed", output: "second" })
    expect(jobs.read(id).status).toBe("completed")
    expect(jobs.read(id).output).toBe("second")
  })

  // Task 4.4: job lifecycle stamps (startedAt/endedAt) — the honest source for
  // the web jobs surface's duration display.
  it("records startedAt on register; endedAt appears on terminal transitions and clears on re-open", () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("root", "subagent", "h")
    const fresh = jobs.read(id)
    expect(typeof fresh.startedAt).toBe("number")
    expect(fresh.endedAt).toBeUndefined()
    jobs.updateJob(id, { status: "completed", output: "done" })
    const done = jobs.read(id)
    expect(typeof done.startedAt).toBe("number")
    expect(typeof done.endedAt).toBe("number")
    // re-open to running clears the end stamp (the same logical job is live again)
    jobs.updateJob(id, { status: "running" })
    expect(jobs.read(id).endedAt).toBeUndefined()
    // kill stamps too
    jobs.kill(id)
    expect(typeof jobs.read(id).endedAt).toBe("number")
  })

  it("registerJob accepts an explicit startedAt (restore path); list/read carry the stamps", () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("root", "subagent", "h", undefined, 1234)
    jobs.updateJob(id, { status: "completed", output: "x", startedAt: 1234, endedAt: 2234 })
    expect(jobs.read(id)).toMatchObject({ startedAt: 1234, endedAt: 2234 })
    expect(jobs.list("root")[0]).toMatchObject({ startedAt: 1234, endedAt: 2234 })
  })
})
