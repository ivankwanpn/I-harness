import { expect, it } from "vitest"
import { createSession } from "@i-harness/core-session"
import { createSessionService } from "@i-harness/session-executor"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { createSdkServer } from "../src/server.ts"
import { createRefreshScheduler } from "../../desktop/src/renderer/session/refresh-scheduler.ts"

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

it.each(["stop", "flush"])("refreshes an internally submitted parent result after delayed %s settles", async delay => {
  const session = createSession(), stop = gate(), entered = gate(), read = gate()
  const service = createSessionService({ workspace: process.cwd(), session,
    ...(delay === "flush" ? { coordinator: { flush: async () => {
      // Admission also checkpoints before transport. Hold the final durable
      // turn boundary whose delayed settlement this refresh case exercises.
      if (session.events.at(-1)?.type === "turn/end") { entered.release(); await stop.promise }
    } } as unknown as SessionCoordinator } : {}),
    model: { async *stream() { yield { type: "text/chunk", text: "received" }; yield { type: "end" } } } })
  let renderedRunning = false
  const snapshots: boolean[] = []
  const refresh = createRefreshScheduler(async () => {
    renderedRunning = service.queueState("parent").running
    snapshots.push(renderedRunning)
    read.release()
  }, 5)
  const server = createSdkServer(service, { onNotify(message) {
    if (["session/event", "session/status", "session/execution-state"].includes(message.method)) refresh.schedule()
  } })
  try {
    const assembly = await service.assemblyFor("parent")
    if (delay === "stop") assembly.ctx.on("agent/stop", async () => { entered.release(); await stop.promise })
    assembly.inbox.admit({ inputId: "parent-notify-fixture", text: "child result", delivery: "steer", intent: "system",
      synthetic: { description: "fixture", scope: "turn" } })
    const execution = service.submit("parent", "child result", new AbortController().signal, { admittedInputId: "parent-notify-fixture" })
    await entered.promise
    await read.promise
    expect(session.events.at(-1)?.type).toBe("turn/end")
    expect(renderedRunning).toBe(true)
    stop.release()
    await execution
    await expect.poll(() => snapshots.at(-1)).toBe(false)
    expect(service.queueState("parent")).toEqual({ running: false, queued: 0 })
    expect(snapshots.at(-1)).toBe(false)
    expect(session.events.filter(event => event.type === "user/message" && event.text === "child result")).toHaveLength(1)
  } finally { stop.release(); refresh.dispose(); await server.close(); await service.close() }
})

it("forwards future service changes once and detaches on SDK close", async () => {
  const service = createSessionService({ workspace: process.cwd(), session: createSession(), model: { async *stream() { yield { type: "end" } } } })
  const received: unknown[] = []
  const server = createSdkServer(service, { onNotify(message) { if (message.method === "session/execution-state") received.push(message.params) } })
  try {
    await service.submit("s", "first", new AbortController().signal)
    expect(received.at(-1)).toMatchObject({ sessionId: "s", running: false, queued: 0 })
    await service.closeSession("s")
    const before = received.length
    const assembly = await service.assemblyFor("s")
    assembly.inbox.admit({ inputId: "next", text: "next", delivery: "queue", intent: "user" })
    expect(received).toHaveLength(before + 1)
    await server.close()
    const closedCount = received.length
    assembly.inbox.cancel("next")
    await service.submit("s", "after close", new AbortController().signal)
    expect(received).toHaveLength(closedCount)
  } finally { await server.close(); await service.close() }
})

it("accepts a legacy service without the optional subscription", async () => {
  const service = createSessionService({ workspace: process.cwd(), session: createSession(), model: { async *stream() { yield { type: "end" } } } })
  const server = createSdkServer({ ...service, onExecutionState: undefined })
  try { await service.submit("s", "legacy", new AbortController().signal) }
  finally { await server.close(); await service.close() }
})
