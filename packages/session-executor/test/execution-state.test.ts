import { expect, it, vi } from "vitest"
import { createSession } from "@i-harness/core-session"
import { createSessionService, type SessionExecutionState, type SessionService } from "../src/service.ts"

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function observe(service: SessionService) {
  const states: SessionExecutionState[] = []
  const snapshots: { running: boolean; queued: number }[] = []
  const off = service.onExecutionState?.(state => {
    states.push(state)
    snapshots.push(service.queueState(state.sessionId))
  })
  return { states, snapshots, off }
}

it("keeps the executing row authoritative until host completion and then publishes settled bookkeeping", async () => {
  const entered = gate(), completion = gate()
  const service = createSessionService({ workspace: process.cwd(), session: createSession(),
    model: { async *stream() { yield { type: "end" } } },
    afterSuccessfulSubmit: async () => { entered.release(); await completion.promise },
  })
  const { states, snapshots, off } = observe(service)
  try {
    const turn = service.submit("s", "first", new AbortController().signal)
    await entered.promise
    expect(service.queueState("s")).toEqual({ running: true, queued: 0 })
    completion.release()
    await turn
    expect(states.at(-1)).toMatchObject({ running: false, queued: 0 })
    expect(states.some(state => state.running)).toBe(true)
    expect(states.every((state, index) => index === 0 || state.revision > states[index - 1]!.revision)).toBe(true)
    expect(snapshots).toEqual(states.map(({ running, queued }) => ({ running, queued })))
  } finally { completion.release(); off?.(); await service.close() }
})

it("publishes queued follow-on work without dropping it when the previous submit settles", async () => {
  const first = gate(), second = gate(), firstEntered = gate(), secondEntered = gate()
  let calls = 0
  const service = createSessionService({ workspace: process.cwd(), session: createSession(), model: {
    async *stream() {
      const n = ++calls
      ;(n === 1 ? firstEntered : secondEntered).release()
      await (n === 1 ? first : second).promise
      yield { type: "end" }
    },
  } })
  const { states } = observe(service)
  try {
    const a = service.submit("s", "first", new AbortController().signal)
    await firstEntered.promise
    const start = states.length
    const b = service.submit("s", "second", new AbortController().signal)
    expect(states.at(-1)).toMatchObject({ running: true, queued: 1 })
    first.release()
    await a
    await secondEntered.promise
    expect(states.at(-1)).toMatchObject({ running: true, queued: 0 })
    expect(states.slice(start).every(state => state.running || state.queued > 0)).toBe(true)
    second.release()
    await b
    expect(states.at(-1)).toMatchObject({ running: false, queued: 0 })
    expect(calls).toBe(2)
  } finally { first.release(); second.release(); await service.close() }
})

it.each(["service", "caller"])("keeps a stopped turn running through delayed stop hooks (%s cancellation)", async mode => {
  const entered = gate(), stop = gate(), signal = new AbortController()
  const service = createSessionService({ workspace: process.cwd(), session: createSession(), model: { async *stream() { yield { type: "end" } } } })
  const { states } = observe(service)
  try {
    const assembly = await service.assemblyFor("s")
    assembly.ctx.on("agent/stop", async () => { entered.release(); await stop.promise })
    const turn = service.submit("s", "first", signal.signal)
    await entered.promise
    if (mode === "service") expect(service.cancelRunning?.("s")).toEqual({ cancelled: true })
    else signal.abort()
    expect(states.at(-1)).toMatchObject({ running: true, queued: 0 })
    stop.release()
    await turn
    expect(states.at(-1)).toMatchObject({ running: false, queued: 0 })
  } finally { stop.release(); await service.close() }
})

it("publishes queued cancellation immediately without executing the cancelled prompt", async () => {
  const entered = gate(), stop = gate(), session = createSession()
  const service = createSessionService({ workspace: process.cwd(), session, model: { async *stream() { entered.release(); await stop.promise; yield { type: "end" } } } })
  const { states } = observe(service)
  try {
    const a = service.submit("s", "first", new AbortController().signal)
    await entered.promise
    const b = service.submit("s", "cancel me", new AbortController().signal)
    const id = service.queue("s").find(row => row.text === "cancel me")!.id
    expect(service.cancelQueued("s", id)).toEqual({ cancelled: true })
    expect(states.at(-1)).toMatchObject({ running: true, queued: 0 })
    stop.release()
    await Promise.all([a, b])
    expect(session.events.flatMap(event => event.type === "user/message" && !event.internal ? [event.text] : [])).toEqual(["first"])
    expect(states.at(-1)).toMatchObject({ running: false, queued: 0 })
  } finally { stop.release(); await service.close() }
})

it("publishes idle after a failed stop hook without swallowing the submit failure", async () => {
  const service = createSessionService({ workspace: process.cwd(), session: createSession(), model: { async *stream() { yield { type: "end" } } } })
  const { states } = observe(service)
  try {
    const assembly = await service.assemblyFor("s")
    assembly.ctx.on("agent/stop", () => { throw new Error("stop failed") })
    await expect(service.submit("s", "first", new AbortController().signal)).rejects.toThrow("stop failed")
    expect(states.at(-1)).toMatchObject({ running: false, queued: 0 })
    expect(service.queue("s")).toEqual([])
  } finally { await service.close() }
})

it("isolates throwing listeners and detaches listeners, assembly subscriptions and caller abort handlers", async () => {
  const session = createSession(), signal = new AbortController()
  const service = createSessionService({ workspace: process.cwd(), session, model: { async *stream() { yield { type: "end" } } } })
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  const offThrowing = service.onExecutionState?.(() => { throw new Error("listener failed") })
  const { states, off } = observe(service)
  try {
    const assembly = await service.assemblyFor("s")
    await service.submit("s", "first", signal.signal)
    expect(states.at(-1)).toMatchObject({ running: false, queued: 0 })
    const settledCount = states.length
    signal.abort()
    expect(states).toHaveLength(settledCount)
    offThrowing?.()
    await service.closeSession("s")
    const closedCount = states.length
    assembly.inbox.admit({ inputId: "orphan", text: "orphan", delivery: "queue", intent: "user" })
    expect(states).toHaveLength(closedCount)
    const rebuilt = await service.assemblyFor("s")
    rebuilt.inbox.admit({ inputId: "rebuilt", text: "rebuilt", delivery: "queue", intent: "user" })
    expect(states).toHaveLength(closedCount + 1)
    off?.()
    rebuilt.inbox.cancel("rebuilt")
    expect(states).toHaveLength(closedCount + 1)
    const last = observe(service)
    await service.close()
    rebuilt.inbox.cancel("orphan")
    expect(last.states).toEqual([])
  } finally { offThrowing?.(); off?.(); warning.mockRestore(); await service.close() }
})
