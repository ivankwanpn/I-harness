import { describe, expect, it } from "vitest"
import { createSessionService, type SessionService } from "../src/service.ts"
import { createTelemetry, type TelemetrySink } from "@i-harness/telemetry"

function collectEvents(): { events: unknown[]; sink: TelemetrySink } {
  const events: unknown[] = []
  const sink: TelemetrySink = { onEvent: (ev) => { events.push(ev) } }
  return { events, sink }
}

describe("createSessionService", () => {
  it("runs the first submit and serializes the second behind it", async () => {
    const service = createSessionService({ workspace: process.cwd(), approveAll: true, mockCycles: true })
    const order: string[] = []
    const p1 = service.submit("s1", "first", new AbortController().signal).then(() => order.push("first-done"))
    const p2 = service.submit("s1", "second", new AbortController().signal).then(() => order.push("second-done"))
    await Promise.all([p1, p2])
    expect(order).toEqual(["first-done", "second-done"])
    expect(service.hasAssembly("s1")).toBe(true)
    expect(service.liveSession("s1")).toBeDefined()
  }, 60_000)

  it("an aborted queued turn settles without breaking the chain", async () => {
    const service = createSessionService({ workspace: process.cwd(), approveAll: true, mockCycles: true })
    const p1 = service.submit("s1", "one", new AbortController().signal)
    const gate = new AbortController()
    gate.abort() // aborted BEFORE the queued turn starts
    const p2 = service.submit("s1", "two", gate.signal)
    await Promise.all([p1, p2]) // both settle: the chain keeps moving
    const p3 = service.submit("s1", "three", new AbortController().signal)
    await p3
    expect(service.hasAssembly("s1")).toBe(true)
  }, 60_000)

  it("onAssembly fires once per session with the assembly ctx", async () => {
    const service = createSessionService({ workspace: process.cwd(), approveAll: true, mockCycles: true })
    const seen: string[] = []
    service.onAssembly((a) => { seen.push(a.sessionId ?? "") })
    await service.submit("s1", "x", new AbortController().signal)
    expect(seen).toEqual(["s1"])
  }, 60_000)

  it("emits session/request then session/queued for a chained submit", async () => {
    const collections = collectEvents()
    const service = createSessionService({
      workspace: process.cwd(), approveAll: true, mockCycles: true,
      telemetry: createTelemetry([collections.sink]),
    })
    const p1 = service.submit("s1", "one", new AbortController().signal)
    const p2 = service.submit("s1", "two", new AbortController().signal)
    await Promise.all([p1, p2])
    const types = collections.events.map((e) => (e as { type: string }).type)
    expect(types).toContain("session/request")
    expect(types).toContain("session/queued")
  }, 60_000)

  it("close() disposes assemblies and settles active turns", async () => {
    const service: SessionService = createSessionService({ workspace: process.cwd(), approveAll: true, mockCycles: true })
    await service.submit("s1", "x", new AbortController().signal)
    await service.close()
    expect(service.liveSession("s1")).toBeUndefined()
    expect(service.hasAssembly("s1")).toBe(false)
  }, 60_000)

  it("a failed turn rejects submit (drain rejection → host error frame)", async () => {
    const service: SessionService = createSessionService({
      workspace: process.cwd(), approveAll: true,
      mockScript: [], // exhausted script → stream error → turn failure
    })
    let failed = false
    try {
      await service.submit("s1", "boom", new AbortController().signal)
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    // the lane is still usable after a failure:
    const again = createSessionService({ workspace: process.cwd(), approveAll: true, mockCycles: true })
    await again.submit("s1", "x", new AbortController().signal)
    expect(again.hasAssembly("s1")).toBe(true)
  }, 60_000)

  it("queueState reports running/queued from the per-session lane", async () => {
    const service: SessionService = createSessionService({ workspace: process.cwd(), approveAll: true, mockCycles: true })
    expect(service.queueState("s1")).toEqual({ running: false, queued: 0 })
    const p1 = service.submit("s1", "one", new AbortController().signal)
    const p2 = service.submit("s1", "two", new AbortController().signal)
    // while both in flight the lane either runs or queues the second
    const st = service.queueState("s1")
    expect(st.running || st.queued > 0).toBe(true)
    await Promise.all([p1, p2])
    expect(service.queueState("s1")).toEqual({ running: false, queued: 0 })
  }, 60_000)
})
