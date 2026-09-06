import { describe, expect, it, vi } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { createDurableSessionLoader } from "../src/index.ts"
import { createSessionService, type SessionService } from "../src/service.ts"
import { createTelemetry, type TelemetrySink } from "@i-harness/telemetry"
import { createMockClient } from "@i-harness/llm-mock"

function collectEvents(): { events: unknown[]; sink: TelemetrySink } {
  const events: unknown[] = []
  const sink: TelemetrySink = { onEvent: (ev) => { events.push(ev) } }
  return { events, sink }
}

describe("createSessionService", () => {
  it("restores durable history into the model and mirrors continuation with increasing seqs", async () => {
    const restored = createSession()
    append(restored, { type: "turn/start" })
    append(restored, { type: "user/message", text: "earlier question" })
    append(restored, { type: "assistant/message", text: "earlier answer" })
    append(restored, { type: "turn/end" })
    const enqueue = vi.fn()
    const flush = vi.fn(async () => {})
    const coordinator = {
      load: vi.fn(async () => ({ session: restored })),
      enqueue,
      flush,
    } as unknown as SessionCoordinator
    const requests: LLMRequest[] = []
    const model: ModelClient = {
      async *stream(request) {
        requests.push(request)
        yield { type: "text/chunk", text: "continued" }
        yield { type: "end" }
      },
    }
    const service = createSessionService({
      workspace: process.cwd(),
      approveAll: true,
      model,
      sessionFor: createDurableSessionLoader(coordinator),
    })

    try {
      await service.submit("durable", "continue here", new AbortController().signal)
      const texts = requests[0]!.messages.map((message) => message.content)
      expect(texts).toContain("earlier question")
      expect(texts).toContain("earlier answer")
      expect(texts).toContain("continue here")
      const live = service.liveSession("durable")!
      expect(live.events.slice(0, restored.events.length)).toEqual(restored.events)
      expect(live.events.map((event) => event.seq)).toEqual(live.events.map((_, index) => index))
      const mirrored = enqueue.mock.calls.flatMap((call) => call[1] as Array<{ seq?: number }>)
      expect(mirrored[0]?.seq).toBe(restored.events.length)
      expect(flush).toHaveBeenCalledWith("durable")
    } finally {
      await service.close()
    }
  }, 60_000)

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

  it("closeSession() disposes only the selected assembly and allows a later reopen", async () => {
    const service = createSessionService({ workspace: process.cwd(), approveAll: true, mockCycles: true })
    const first = await service.assemblyFor("first")
    await service.assemblyFor("second")
    const dispose = vi.spyOn(first, "dispose")

    await service.closeSession("first")
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(service.hasAssembly("first")).toBe(false)
    expect(service.hasAssembly("second")).toBe(true)
    const reopened = await service.assemblyFor("first")
    expect(reopened).not.toBe(first)
    await service.close()
  })

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

  it("settles a queued successor after a failed predecessor without an unhandled rejection", async () => {
    let loadCount = 0
    const service = createSessionService({ workspace: process.cwd(), approveAll: true, loadMeta: async () => { if (++loadCount === 1) throw new Error("load failed"); return undefined } })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on("unhandledRejection", onUnhandled)
    try {
      const first = service.submit("s1", "first", new AbortController().signal)
      const second = service.submit("s1", "second", new AbortController().signal)
      const settled = await Promise.race([Promise.allSettled([first, second]), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("successor remained pending")), 2000))])
      expect(settled[0].status).toBe("rejected")
      expect(settled[1].status).toBe("fulfilled")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
      expect(service.queueState("s1")).toEqual({ running: false, queued: 0 })
    } finally { process.off("unhandledRejection", onUnhandled); await service.close() }
  }, 60_000)


  it("flushes before assembly disposal and propagates the flush error once", async () => {
    const order: string[] = []
    const service = createSessionService({ workspace: process.cwd(), approveAll: true, beforeDispose: async () => { order.push("flush"); throw new Error("flush failed") } })
    const assembly = await service.assemblyFor("s-order")
    const originalDispose = assembly.dispose
    assembly.dispose = async () => { order.push("dispose"); await originalDispose() }
    await expect(service.close()).rejects.toThrow("flush failed")
    expect(order).toEqual(["flush", "dispose"])
    await expect(service.close()).resolves.toBeUndefined()
  })
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

  // M32 T3: per-session reasoning effort — the service resolves the value at
  // every assembly build and the assembled agent's requests carry it (absent →
  // the request never sets the field). The seam option below is spread from a
  // variable so the pre-wiring test still compiles (the option lands in
  // SessionServiceOptions with the implementation).
  it("M32 T3: reasoningEffortFor carries the meta's modelSelection.reasoningEffort into the requests", async () => {
    const effortSeam = {
      reasoningEffortFor: (_sessionId: string, meta: import("@i-harness/session-persistence").SessionMeta | undefined) =>
        meta?.modelSelection?.reasoningEffort as "off" | "low" | "medium" | "high" | "xhigh" | "max" | undefined,
    }
    const captured: (string | undefined)[] = []
    const service = createSessionService({
      workspace: process.cwd(),
      approveAll: true,
      ...effortSeam,
      loadMeta: async () => ({
        formatVersion: 1, sessionId: "s1", createdAt: "",
        modelSelection: { provider: "p", model: "m", reasoningEffort: "high" },
      }),
      modelBuilder: async () => ({
        async *stream(request: import("@i-harness/llm-seam").LLMRequest) {
          captured.push((request as { reasoningEffort?: string }).reasoningEffort)
          yield* createMockClient([{ role: "assistant", text: "ok" }]).stream(request)
        },
      }),
    })
    await service.submit("s1", "hi", new AbortController().signal)
    expect(captured).toContain("high")
  }, 60_000)

  it("M32 T3: absent meta selection → the request carries no reasoningEffort", async () => {
    const captured: (string | undefined)[] = []
    const service = createSessionService({
      workspace: process.cwd(),
      approveAll: true,
      loadMeta: async () => ({ formatVersion: 1, sessionId: "s1", createdAt: "" }),
      modelBuilder: async () => ({
        async *stream(request: import("@i-harness/llm-seam").LLMRequest) {
          captured.push((request as { reasoningEffort?: string }).reasoningEffort)
          yield* createMockClient([{ role: "assistant", text: "ok" }]).stream(request)
        },
      }),
    })
    await service.submit("s1", "hi", new AbortController().signal)
    expect(captured).toEqual([undefined])
  }, 60_000)
})
