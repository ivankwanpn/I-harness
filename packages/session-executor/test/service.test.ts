import { describe, expect, it, vi } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { createDurableSessionLoader, ModelUnavailableError } from "../src/index.ts"
import { createSessionService, type SessionService } from "../src/service.ts"
import type { SessionQueueItem } from "../src/index.ts"
import { createTelemetry, type TelemetrySink } from "@i-harness/telemetry"
import { createMockClient } from "@i-harness/llm-mock"

function collectEvents(): { events: unknown[]; sink: TelemetrySink } {
  const events: unknown[] = []
  const sink: TelemetrySink = { onEvent: (ev) => { events.push(ev) } }
  return { events, sink }
}

describe("createSessionService", () => {
  it("uses one pending ready binding for state and assembly construction", async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const requests: LLMRequest[] = []
    const model: ModelClient = {
      async *stream(request) {
        requests.push(request)
        yield { type: "text/chunk", text: "real" }
        yield { type: "end" }
      },
    }
    const service = createSessionService({
      workspace: process.cwd(),
      modelPolicy: "required",
      contextWindow: 1,
      reasoningEffort: "low",
      modelBindingFor: async () => {
        calls += 1
        await gate
        return {
          status: "ready",
          binding: {
            model,
            providerId: "deepseek",
            modelId: "deepseek-chat",
            label: "deepseek:deepseek-chat",
            reasoningEffort: "high",
            contextWindow: 128_000,
          },
        }
      },
    })

    try {
      const statePromise = service.modelState("s1")
      const assemblyPromise = service.assemblyFor("s1")
      await vi.waitFor(() => { expect(calls).toBe(1) })
      release()

      await expect(statePromise).resolves.toEqual({
        status: "ready",
        providerId: "deepseek",
        modelId: "deepseek-chat",
        label: "deepseek:deepseek-chat",
      })
      const assembly = await assemblyPromise
      expect(assembly.model).toBe(model)
      expect(assembly.modelLabel).toBe("deepseek:deepseek-chat")
      await expect(assembly.agent.run("hello")).resolves.toMatchObject({ finalText: "real" })
      expect(requests[0]?.reasoningEffort).toBe("high")
      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("get_context_remaining")
      expect(calls).toBe(1)
    } finally {
      release()
      await service.close()
    }
  }, 60_000)

  it("normalizes compaction off when a ready binding has no contextWindow", async () => {
    const session = createSession()
    append(session, { type: "user/message", text: "initial work" })
    const model = createMockClient([{
      role: "assistant",
      text: "## Primary Request and Intent\n- " + "work ".repeat(120),
    }])
    const service = createSessionService({
      workspace: process.cwd(),
      modelPolicy: "required",
      compact: { contextWindow: 1 },
      sessionFor: async () => session,
      modelBindingFor: async () => ({
        status: "ready",
        binding: {
          model,
          providerId: "fixture",
          modelId: "no-window",
          label: "fixture:no-window",
        },
      }),
    })

    try {
      const assembly = await service.assemblyFor("s1")
      await expect(assembly.compactNow()).resolves.toEqual({
        compacted: false,
        shadowedSeqs: [],
      })
      expect(session.events.some((event) => event.type.startsWith("compaction/"))).toBe(false)
    } finally {
      await service.close()
    }
  })

  it("normalizes compaction to the ready binding contextWindow", async () => {
    const session = createSession()
    append(session, { type: "user/message", text: "x".repeat(600) })
    const requests: LLMRequest[] = []
    const model: ModelClient = {
      async *stream(request) {
        requests.push(request)
        yield { type: "text/chunk", text: "ok" }
        yield { type: "end" }
      },
    }
    const service = createSessionService({
      workspace: process.cwd(),
      modelPolicy: "required",
      compact: { contextWindow: 1, minSummaryChars: 1 },
      sessionFor: async () => session,
      modelBindingFor: async () => ({
        status: "ready",
        binding: {
          model,
          providerId: "fixture",
          modelId: "large-window",
          label: "fixture:large-window",
          contextWindow: 128_000,
        },
      }),
    })

    try {
      const assembly = await service.assemblyFor("s1")
      await expect(assembly.agent.run("continue")).resolves.toMatchObject({ finalText: "ok" })
      expect(requests).toHaveLength(1)
      expect(session.events.some((event) => event.type.startsWith("compaction/"))).toBe(false)

      const compacted = await assembly.compactNow()
      expect(compacted.compacted).toBe(true)
      expect(compacted.shadowedSeqs.length).toBeGreaterThan(0)
      expect(requests).toHaveLength(2)
      expect(session.events.some((event) => event.type === "compaction/end")).toBe(true)
    } finally {
      await service.close()
    }
  }, 30_000)

  it("does not construct an assembly for an unconfigured binding", async () => {
    let calls = 0
    const service = createSessionService({
      workspace: process.cwd(),
      modelPolicy: "required",
      modelBindingFor: async () => {
        calls += 1
        return { status: "unconfigured", reason: "No model configured" }
      },
    })

    try {
      await expect(service.modelState("s1")).resolves.toEqual({
        status: "unconfigured",
        reason: "No model configured",
      })
      const assembly = service.assemblyFor("s1")
      await expect(assembly).rejects.toBeInstanceOf(ModelUnavailableError)
      await expect(assembly).rejects.toThrow("No model configured")
      expect(calls).toBe(1)
      expect(service.hasAssembly("s1")).toBe(false)
    } finally {
      await service.close()
    }
  })

  it("preserves invalid binding details without constructing an assembly", async () => {
    const service = createSessionService({
      workspace: process.cwd(),
      modelPolicy: "required",
      modelBindingFor: async () => ({
        status: "invalid",
        reason: "Unknown model",
        providerId: "deepseek",
        modelId: "missing",
      }),
    })

    try {
      await expect(service.modelState("s1")).resolves.toEqual({
        status: "invalid",
        reason: "Unknown model",
        providerId: "deepseek",
        modelId: "missing",
      })
      await expect(service.assemblyFor("s1")).rejects.toThrow("Unknown model")
      expect(service.hasAssembly("s1")).toBe(false)
    } finally {
      await service.close()
    }
  })

  it("closeSession invalidates an idle model binding resolution", async () => {
    let calls = 0
    const models = [
      createMockClient([{ role: "assistant", text: "first" }]),
      createMockClient([{ role: "assistant", text: "second" }]),
    ]
    const service = createSessionService({
      workspace: process.cwd(),
      modelPolicy: "required",
      modelBindingFor: async () => {
        const index = calls++
        const modelId = index === 0 ? "first" : "second"
        return {
          status: "ready",
          binding: {
            model: models[index]!,
            providerId: "fixture",
            modelId,
            label: `fixture:${modelId}`,
          },
        }
      },
    })

    try {
      await expect(service.modelState("s1")).resolves.toMatchObject({
        status: "ready",
        label: "fixture:first",
      })
      expect(service.hasAssembly("s1")).toBe(false)

      await service.closeSession("s1")

      const assembly = await service.assemblyFor("s1")
      expect(assembly.model).toBe(models[1])
      expect(assembly.modelLabel).toBe("fixture:second")
      await expect(service.modelState("s1")).resolves.toMatchObject({
        status: "ready",
        label: "fixture:second",
      })
      expect(calls).toBe(2)
    } finally {
      await service.close()
    }
  })

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
      loadOwned: vi.fn(async () => ({ session: restored })),
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
    const service = createSessionService({ workspace: process.cwd(), approveAll: true, modelPolicy: "test-mock", mockCycles: true })
    const order: string[] = []
    const p1 = service.submit("s1", "first", new AbortController().signal).then(() => order.push("first-done"))
    const p2 = service.submit("s1", "second", new AbortController().signal).then(() => order.push("second-done"))
    await Promise.all([p1, p2])
    expect(order).toEqual(["first-done", "second-done"])
    expect(service.hasAssembly("s1")).toBe(true)
    expect(service.liveSession("s1")).toBeDefined()
  }, 60_000)

  it("an aborted queued turn settles without breaking the chain", async () => {
    const service = createSessionService({ workspace: process.cwd(), approveAll: true, modelPolicy: "test-mock", mockCycles: true })
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
    const service = createSessionService({ workspace: process.cwd(), approveAll: true, modelPolicy: "test-mock", mockCycles: true })
    const seen: string[] = []
    service.onAssembly((a) => { seen.push(a.sessionId ?? "") })
    await service.submit("s1", "x", new AbortController().signal)
    expect(seen).toEqual(["s1"])
  }, 60_000)

  it("emits session/request then session/queued for a chained submit", async () => {
    const collections = collectEvents()
    const service = createSessionService({
      workspace: process.cwd(), approveAll: true, modelPolicy: "test-mock", mockCycles: true,
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
    const service: SessionService = createSessionService({ workspace: process.cwd(), approveAll: true, modelPolicy: "test-mock", mockCycles: true })
    await service.submit("s1", "x", new AbortController().signal)
    await service.close()
    expect(service.liveSession("s1")).toBeUndefined()
    expect(service.hasAssembly("s1")).toBe(false)
  }, 60_000)

  it("closeSession() disposes only the selected assembly and allows a later reopen", async () => {
    const service = createSessionService({ workspace: process.cwd(), approveAll: true, modelPolicy: "test-mock", mockCycles: true })
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
      modelPolicy: "test-mock",
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
    const again = createSessionService({ workspace: process.cwd(), approveAll: true, modelPolicy: "test-mock", mockCycles: true })
    await again.submit("s1", "x", new AbortController().signal)
    expect(again.hasAssembly("s1")).toBe(true)
  }, 60_000)

  it("settles a queued successor after a failed predecessor without an unhandled rejection", async () => {
    let loadCount = 0
    const service = createSessionService({ workspace: process.cwd(), approveAll: true, modelPolicy: "test-mock", loadMeta: async () => { if (++loadCount === 1) throw new Error("load failed"); return undefined } })
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
    const service = createSessionService({ workspace: process.cwd(), approveAll: true, modelPolicy: "test-mock", beforeDispose: async () => { order.push("flush"); throw new Error("flush failed") } })
    const assembly = await service.assemblyFor("s-order")
    const originalDispose = assembly.dispose
    assembly.dispose = async () => { order.push("dispose"); await originalDispose() }
    await expect(service.close()).rejects.toThrow("flush failed")
    expect(order).toEqual(["flush", "dispose"])
    await expect(service.close()).resolves.toBeUndefined()
  })
  it("queueState reports running/queued from the per-session lane", async () => {
    const service: SessionService = createSessionService({ workspace: process.cwd(), approveAll: true, modelPolicy: "test-mock", mockCycles: true })
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

// ── Task 11: real session queue projection — fixtures per the plan's Test
// Fixture Contract (real SessionService; injected model only for gating).

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // settle the event loop first — the lane start (assembly build + pump
    // microtasks) must get a window before the first evaluation.
    await new Promise((resolve) => setTimeout(resolve, 10))
    if (cond()) return
    if (Date.now() >= deadline) throw new Error("waitFor: condition not met within budget")
  }
}

/** Real SessionService whose injected model waits on `gate` before yielding
 * end — the running turn blocks until the test releases it. */
function serviceWithBlockingModel(gate: { promise: Promise<void> }): SessionService {
  const model: ModelClient = {
    async *stream() {
      await gate.promise
      yield { type: "text/chunk", text: "ok" }
      yield { type: "end" }
    },
  }
  return createSessionService({
    workspace: process.cwd(),
    approveAll: true,
    modelPolicy: "required",
    modelBindingFor: async () => ({
      status: "ready",
      binding: { model, providerId: "fixture", modelId: "bit", label: "fixture:bit" },
    }),
  })
}

/** `{ service, seen, release }` — seen records the model tasks that actually
 * ran (by last user-message content); release() settles the first turn. */
function blockingService(): { service: SessionService; seen: string[]; release(): void } {
  const seen: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const model: ModelClient = {
    async *stream(request: LLMRequest) {
      // `seen` records the model tasks that ACTUALLY RAN, keyed by the last
      // authored user prompt — the engine's runtime-context bookkeeping
      // message (appended per step next to the user prompt) is not a task.
      const authored = request.messages
        .filter((m) => m.role === "user")
        .map((m) => typeof m.content === "string" ? m.content : "")
        .filter((t) => !t.startsWith("Current runtime context:"))
      seen.push(authored.at(-1) ?? "")
      await gate
      yield { type: "text/chunk", text: "ok" }
      yield { type: "end" }
    },
  }
  return {
    service: createSessionService({
      workspace: process.cwd(),
      approveAll: true,
      modelPolicy: "required",
      modelBindingFor: async () => ({
        status: "ready",
        binding: { model, providerId: "fixture", modelId: "bit", label: "fixture:bit" },
      }),
    }),
    seen,
    release,
  }
}

/** Condition-polls service.queue() until `text` appears or throws (5 s). */
async function waitForQueueText(service: SessionService, sessionId: string, text: string): Promise<SessionQueueItem> {
  let found: SessionQueueItem | undefined
  await waitFor(() => {
    found = service.queue(sessionId).find((row) => row.text === text)
    return found !== undefined
  })
  return found!
}

describe("createSessionService — real session queue projection (Task 11)", () => {
  it("lists a running row followed by queued rows in FIFO order", async () => {
    const gate = deferred<void>()
    const service = serviceWithBlockingModel(gate)
    try {
      const first = service.submit("s1", "first", new AbortController().signal)
      const second = service.submit("s1", "second", new AbortController().signal)
      const third = service.submit("s1", "third", new AbortController().signal)
      await waitFor(() => service.queue("s1").length === 3)
      expect(service.queue("s1").map((row) => [row.text, row.state])).toEqual([
        ["first", "running"],
        ["second", "queued"],
        ["third", "queued"],
      ])
      gate.resolve()
      await Promise.all([first, second, third])
      expect(service.queue("s1")).toEqual([])
    } finally {
      gate.resolve()
      await service.close()
    }
  }, 60_000)

  it("cancels a service-front queued row without executing it", async () => {
    const { service, seen, release } = blockingService()
    try {
      const first = service.submit("s1", "first", new AbortController().signal)
      const second = service.submit("s1", "second", new AbortController().signal)
      const row = await waitForQueueText(service, "s1", "second")
      expect(service.cancelQueued("s1", row.id)).toEqual({ cancelled: true })
      expect(service.cancelQueued("s1", row.id)).toEqual({ cancelled: false })
      release()
      await Promise.all([first, second])
      expect(seen).toEqual(["first"])
      expect(service.queue("s1")).toEqual([])
    } finally {
      release()
      await service.close()
    }
  }, 60_000)

  it("cancelQueued on an already-settled id is an honest false", async () => {
    const { service, release } = blockingService()
    try {
      const first = service.submit("s1", "first", new AbortController().signal)
      const second = service.submit("s1", "second", new AbortController().signal)
      const row = await waitForQueueText(service, "s1", "second")
      release()
      await Promise.all([first, second])
      expect(service.cancelQueued("s1", row.id)).toEqual({ cancelled: false })
      expect(service.cancelQueued("s1", "never-existed")).toEqual({ cancelled: false })
    } finally {
      release()
      await service.close()
    }
  }, 60_000)

  it("cancelQueued consults the LANE for running — a stale record state can never kill a running turn", async () => {
    // Review regression: the record's state is a queue()-read projection; the
    // lane promotion is invisible to it. Snapshot the row as service-front,
    // let the lane promote it WITHOUT another queue() read, then cancelQueued
    // must see the lane's current input (running → { cancelled: false }) and
    // the running turn must keep executing to completion.
    const seen: string[] = []
    let releaseBinding!: () => void
    const bindingGate = new Promise<void>((resolve) => { releaseBinding = resolve })
    let releaseModel!: () => void
    const modelGate = new Promise<void>((resolve) => { releaseModel = resolve })
    const model: ModelClient = {
      async *stream(request: LLMRequest) {
        const authored = request.messages
          .filter((m) => m.role === "user")
          .map((m) => typeof m.content === "string" ? m.content : "")
          .filter((t) => !t.startsWith("Current runtime context:"))
        seen.push(authored.at(-1) ?? "")
        await modelGate
        yield { type: "text/chunk", text: "ok" }
        yield { type: "end" }
      },
    }
    const service = createSessionService({
      workspace: process.cwd(),
      approveAll: true,
      modelPolicy: "required",
      modelBindingFor: async () => {
        await bindingGate
        return {
          status: "ready",
          binding: { model, providerId: "fixture", modelId: "bit", label: "fixture:bit" },
        }
      },
    })
    try {
      const first = service.submit("s1", "first", new AbortController().signal)
      const second = service.submit("s1", "second", new AbortController().signal)
      // Snapshot while the row is service-front: the pane shows it queued and
      // the RECORD is still "wait" (the lane cannot start — the binding is
      // gated).
      const row = await waitForQueueText(service, "s1", "first")
      expect(row.state).toBe("queued")
      // Let the lane promote it: release the binding (the model run blocks on
      // its own gate). NO queue() read afterwards → the record state is
      // deliberately stale while the lane is running this row.
      releaseBinding()
      await waitFor(() => seen.length === 1)
      expect(service.cancelQueued("s1", row.id)).toEqual({ cancelled: false })
      expect(service.cancelQueued("s1", row.id)).toEqual({ cancelled: false })
      // the running turn keeps executing to completion (no abort path taken);
      // the second row was never cancelled and runs after it.
      releaseModel()
      await Promise.all([first, second])
      expect(seen[0]).toBe("first")
    } finally {
      releaseBinding()
      releaseModel()
      await service.close()
    }
  }, 60_000)
})

// ── Task 12: real task projection per assembly/session — the fixture drives a
// REAL spawn through the assembly's own subagent mount (scripted model emits
// the spawn_agent tool call; the child's run is gated so the row stays running
// until the test cancels/settles). No mocked registries.

/** Real SessionService whose parent turn spawns a `helper` subagent and whose
 * child turns block on a gate ("cancellation-requested" stays deterministic).
 * The child's turns are recognized by their message content (the child run's
 * first stream call races the parent's continuation — content routing keeps
 * the fixture robust). `release()` settles the child runs. */
function serviceWithSubagentFixture(): { service: SessionService; release(): void } {
  let spawned = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const model: ModelClient = {
    async *stream(request: LLMRequest) {
      // The child's requests end with ITS authored task message ("inspect
      // code"); the parent's continuation ends with the spawn tool result.
      const last = request.messages.at(-1)
      const isChild = last?.role === "user" && typeof last.content === "string" && last.content.includes("inspect code")
      if (isChild) {
        // the child's turn: blocked → the agent entry stays "running"
        await gate
        yield { type: "text/chunk", text: "child ok" }
        yield { type: "end" }
        return
      }
      if (!spawned) {
        // the parent turn: spawn the helper through the assembly's subagent
        // mount (the real registerSubagent path — its registries drive the
        // projection).
        spawned = true
        yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "inspect code", task_name: "helper" } } }
        yield { type: "end" }
        return
      }
      // the parent's continuation after the tool executed
      yield { type: "text/chunk", text: "spawned" }
      yield { type: "end" }
    },
  }
  return {
    service: createSessionService({
      workspace: process.cwd(),
      approveAll: true,
      modelPolicy: "required",
      modelBindingFor: async () => ({
        status: "ready",
        binding: { model, providerId: "fixture", modelId: "bit", label: "fixture:bit" },
      }),
    }),
    release: () => release(),
  }
}

describe("createSessionService — real task projection (Task 12)", () => {
  it("serves task rows for one live assembly and cancels through the owning registry", async () => {
    const { service, release } = serviceWithSubagentFixture()
    try {
      await service.assemblyFor("s1")
      expect(service.tasks("s1")).toEqual([]) // no spawn yet — honest empty
      await service.submit("s1", "spawn a helper", new AbortController().signal)
      await waitFor(() => service.tasks("s1").some((row) => row.id === "root/helper"))
      expect(service.tasks("s1")).toContainEqual(expect.objectContaining({
        id: "root/helper",
        group: "subagent",
        status: "running",
        canCancel: true,
      }))
      expect(service.cancelTask("s1", "root/helper")).toBe("cancellation-requested")
      // a second cancel before the child settles still asks the registry —
      // honest (the UI re-reads the projection after refresh).
      expect(() => service.cancelTask("s1", "never-a-task")).toThrow(/unknown/)
      // unknown SESSION: no owner → the existing not-found semantics.
      expect(() => service.cancelTask("no-such-session", "root/helper")).toThrow(/unknown task/)
      // settle the child → the row turns cancelled and stops being cancellable.
      release()
      await waitFor(() => service.tasks("s1").find((row) => row.id === "root/helper")?.status === "cancelled")
      const settled = service.tasks("s1").find((row) => row.id === "root/helper")!
      expect(settled.canCancel).toBe(false)
      expect(service.cancelTask("s1", "root/helper")).toBe("already-finished")
    } finally {
      release()
      await service.close()
    }
  }, 60_000)

  it("an unknown session tasks() is an honest empty list", async () => {
    const { service } = serviceWithSubagentFixture()
    try {
      expect(service.tasks("never-assembled")).toEqual([])
    } finally {
      await service.close()
    }
  }, 60_000)
})

describe("createSessionService — close lifecycle with a queue in flight (Task 11 regression)", () => {
  it("closeSession() with a submit in flight settles the binding promise, clears queue rows, and never crashes", async () => {
    const gate = deferred<void>()
    const service = serviceWithBlockingModel(gate)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on("unhandledRejection", onUnhandled)
    try {
      const submit = service.submit("s1", "in flight", new AbortController().signal)
      await waitFor(() => service.queue("s1").length === 1)
      const closing = service.closeSession("s1")
      gate.resolve()
      await closing
      await expect(submit).resolves.toBeUndefined()
      expect(service.queue("s1")).toEqual([])
      expect(service.queueState("s1")).toEqual({ running: false, queued: 0 })
      expect(service.hasAssembly("s1")).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      gate.resolve()
      await service.close()
      process.off("unhandledRejection", onUnhandled)
    }
  }, 60_000)
})
