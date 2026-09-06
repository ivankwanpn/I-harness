// Backend bridge G3 (M37a) — in-process tests over a REAL SessionService
// (mock llm script where a turn runs; manual log appends where the batching
// window is under test). No persistence dependency: the service is wired
// coordinator-less exactly like the bridge's own defaultEmbeddedFactory.
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import type { MockStep } from "@i-harness/llm-mock"
import type { ModelClient } from "@i-harness/llm-seam"
import { createSessionService, type SessionService } from "@i-harness/session-executor"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { activeTokens } from "@i-harness/token-meter"
import {
  createEmbeddedBackend,
  createEventMapState,
  defaultEmbeddedFactory,
  mapSessionEvent,
  toolResultIsError,
} from "../src/backend/embedded.ts"
import type { TuiEvent } from "../src/contracts.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const tmp = (): string => mkdtempSync(join(tmpdir(), "ih-tui-backend-"))

async function waitFor(cond: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await sleep(10)
  }
  throw new Error("waitFor: condition not met within budget")
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function makeService(opts: { sessionId?: string; mockScript?: MockStep[] }): SessionService {
  return createSessionService({
    workspace: tmp(),
    approveAll: true,
    modelPolicy: "test-mock",
    ...(opts.mockScript !== undefined ? { mockScript: opts.mockScript } : { mockCycles: true }),
  })
}

describe("mapSessionEvent", () => {
  it("maps the spec table 1:1 with seq preserved", () => {
    // engine logs are strictly increasing (append stamps seq = length) — the
    // fixtures mirror that
    const state = createEventMapState()
    const m1 = mapSessionEvent({ type: "user/message", text: "hi", seq: 0 } as never, state)!
    expect(m1).toEqual({ type: "user", text: "hi", seq: 0, ts: m1.ts })
    const m2 = mapSessionEvent({ type: "reasoning", text: "think", seq: 1 } as never, state)!
    expect(m2).toEqual({ type: "thinking", text: "think", seq: 1, ts: m2.ts })
    expect(mapSessionEvent({ type: "turn/start", seq: 2 } as never, state)).toMatchObject({ type: "turn", phase: "start" })
    expect(mapSessionEvent({ type: "turn/end", seq: 3 } as never, state)).toMatchObject({ type: "turn", phase: "end" })
    expect(mapSessionEvent({ type: "plan/mode", mode: "on", seq: 4 } as never, state)).toMatchObject({ type: "plan", phase: "on" })
    expect(mapSessionEvent({ type: "session/title", title: "T", messageSeqs: [], source: "provider", seq: 8 } as never, state)).toMatchObject({ type: "title", title: "T", seq: 8 })
  })

  it("assistant dedupe: chunks delivered → aggregate message skipped", () => {
    const state = createEventMapState()
    expect(mapSessionEvent({ type: "assistant/chunk", text: "he", seq: 1 } as never, state)).toMatchObject({ type: "assistant", text: "he", seq: 1 })
    expect(mapSessionEvent({ type: "assistant/chunk", text: "llo", seq: 2 } as never, state)).toMatchObject({ type: "assistant", text: "llo", seq: 2 })
    // aggregate for the same step → skipped
    expect(mapSessionEvent({ type: "assistant/message", text: "hello", seq: 3 } as never, state)).toBeUndefined()
    // message WITHOUT chunks (the engine's real path) → emitted
    expect(mapSessionEvent({ type: "assistant/message", text: "ok", seq: 9 } as never, state)).toMatchObject({ type: "assistant", text: "ok", seq: 9 })
  })

  it("tool: call → running, result → done/error by callId, kind lookup", () => {
    const state = createEventMapState()
    expect(mapSessionEvent({ type: "tool/call", callId: "c1", name: "bash", args: {}, seq: 4 } as never, state)).toEqual({
      type: "tool", callId: "c1", name: "bash", kind: "execute", status: "running", seq: 4, ts: expect.any(Number),
    })
    expect(mapSessionEvent({ type: "tool/result", callId: "c1", name: "bash", output: { content: "out" }, seq: 5 } as never, state)).toMatchObject({
      type: "tool", callId: "c1", status: "done", output: '{\n  "content": "out"\n}', seq: 5,
    })
    expect(mapSessionEvent({ type: "tool/result", callId: "c1", name: "bash", output: { error: "boom" }, seq: 6 } as never, state)).toMatchObject({
      type: "tool", status: "error", error: '{\n  "error": "boom"\n}', seq: 6,
    })
    expect(toolResultIsError({ error: "boom" })).toBe(true)
    expect(toolResultIsError("Error: nope")).toBe(true)
    expect(toolResultIsError({ content: "ok" })).toBe(false)
    expect(toolResultIsError(null)).toBe(false)
  })

  it("system/compaction/todo/goal/subagent/command families + skipped bookkeeping", () => {
    const state = createEventMapState()
    expect(mapSessionEvent({ type: "compaction/start", seq: 10 } as never, state)).toMatchObject({ type: "compaction", phase: "start" })
    expect(mapSessionEvent({ type: "compaction/summary", text: "s", shadowedSeqs: [], seq: 11 } as never, state)).toEqual({ type: "system", text: "compacted", seq: 11, ts: expect.any(Number) })
    expect(mapSessionEvent({ type: "compaction/reset", removedSeqs: [], seq: 12 } as never, state)).toMatchObject({ type: "system", text: "context reset", seq: 12 })
    const todo = mapSessionEvent({ type: "todo/write", version: 1, items: [{ content: "a", status: "pending" }, { content: "b", status: "in_progress" }], seq: 13 } as never, state)!
    expect(todo).toMatchObject({ type: "todo", seq: 13 })
    expect(todo.type === "todo" && todo.items).toEqual([
      { id: "13-0", text: "a", status: "pending" },
      { id: "13-1", text: "b", status: "in_progress" },
    ])
    expect(mapSessionEvent({ type: "goal/change", version: 1, operation: "create", goal: { id: "g", revision: 1, objective: "do it", phase: "active" }, seq: 14 } as never, state)).toMatchObject({ type: "goal", label: "do it", state: "active", seq: 14 })
    expect(mapSessionEvent({ type: "command/run", commandId: "x", name: "theme", args: "dark", source: { kind: "user" }, seq: 15 } as never, state)).toMatchObject({ type: "system", text: "command: theme dark", seq: 15 })
    expect(mapSessionEvent({ type: "subagent/start", version: 1, taskId: "t", agentPath: "a", role: "explorer", description: "d", seq: 16 } as never, state)).toMatchObject({ type: "system", text: "subagent started: explorer", seq: 16 })
    // log-only bookkeeping → no M37a UI surface
    expect(mapSessionEvent({ type: "step/start", seq: 17 } as never, state)).toBeUndefined()
    expect(mapSessionEvent({ type: "step/end", seq: 18 } as never, state)).toBeUndefined()
  })
})

describe("embedded backend", () => {
  const backends: { close: () => Promise<void> }[] = []
  afterEach(async () => {
    for (const b of backends.splice(0)) await b.close().catch(() => {})
  })

  it("creates/forks sessions and refreshes per-session model state after selection", async () => {
    const root = tmp()
    const seenSelections: Array<{ provider: string; model: string; reasoningEffort?: string } | undefined> = []
    const model: ModelClient = {
      async *stream() {
        yield { type: "text/chunk", text: "ok" }
        yield { type: "end" }
      },
    }
    const backend = await defaultEmbeddedFactory({
      workspace: tmp(),
      prompt: "",
      storeRoot: root,
      modelPolicy: "required",
      modelBindingFor: async (_sessionId, meta) => {
        const selection = meta?.modelSelection
        seenSelections.push(selection)
        const providerId = selection?.provider ?? "fixture"
        const modelId = selection?.model ?? "default"
        return {
          status: "ready",
          binding: { model, providerId, modelId, label: `${providerId}:${modelId}` },
        }
      },
    })
    backends.push(backend)

    const initial = (await backend.listSessions())[0]!.id
    await expect(backend.modelState()).resolves.toEqual({
      status: "ready",
      providerId: "fixture",
      modelId: "default",
      label: "fixture:default",
    })
    await expect(backend.setSessionModel({
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "high",
    })).resolves.toEqual({
      status: "ready",
      providerId: "deepseek",
      modelId: "deepseek-chat",
      label: "deepseek:deepseek-chat",
    })
    expect(seenSelections.at(-1)).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "high",
    })

    await backend.submit("fork source")
    const forked = await backend.forkSession()
    expect(forked).not.toBe(initial)
    expect((await backend.replay(-1)).some((event) => event.type === "user" && event.text === "fork source")).toBe(true)

    const created = await backend.createSession()
    expect(created).not.toBe(forked)
    expect(backend.seqCursor()).toBe(-1)
  })

  it("updates per-session model state for an ephemeral embedded session", async () => {
    const seenSelections: Array<{ provider: string; model: string; reasoningEffort?: string } | undefined> = []
    const model: ModelClient = {
      async *stream() {
        yield { type: "text/chunk", text: "ok" }
        yield { type: "end" }
      },
    }
    const backend = await defaultEmbeddedFactory({
      workspace: tmp(),
      prompt: "",
      modelPolicy: "required",
      modelBindingFor: async (_sessionId, meta) => {
        const selection = meta?.modelSelection
        seenSelections.push(selection)
        const providerId = selection?.provider ?? "fixture"
        const modelId = selection?.model ?? "default"
        return {
          status: "ready",
          binding: { model, providerId, modelId, label: `${providerId}:${modelId}` },
        }
      },
    })
    backends.push(backend)

    await expect(backend.setSessionModel({
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "high",
    })).resolves.toEqual({
      status: "ready",
      providerId: "deepseek",
      modelId: "deepseek-chat",
      label: "deepseek:deepseek-chat",
    })
    await backend.submit("use the selected model")
    expect(seenSelections.at(-1)).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "high",
    })
  })

  it("16ms batching: a burst is delivered in one window, in order, with increasing seq", async () => {
    const sessionId = "s1"
    const service = makeService({ sessionId })
    const backend = createEmbeddedBackend({ service, sessionId, batchMs: 40 })
    backends.push(backend)
    const assembly = await service.assemblyFor(sessionId)
    const session = assembly.session

    const it = backend.events()[Symbol.asyncIterator]()
    const firstPull = it.next() // starts the generator (subscribe right after ensure)
    await sleep(50) // assembly + subscription settled
    const t0 = Date.now()
    append(session, { type: "user/message", text: "hi" })
    append(session, { type: "assistant/chunk", text: "he" })
    append(session, { type: "assistant/chunk", text: "llo" })
    append(session, { type: "tool/call", callId: "call_1", name: "read", args: { path: "a" } })
    append(session, { type: "tool/result", callId: "call_1", name: "read", output: { content: "ok" } })

    const first = await firstPull
    const tFirst = Date.now() - t0
    expect(first.value).toMatchObject({ type: "user", text: "hi", seq: 0 })
    // the batch window elapsed (ONE drain) — not per-append delivery
    expect(tFirst).toBeGreaterThanOrEqual(20)
    const rest: TuiEvent[] = []
    const tSecond = Date.now()
    for (let i = 0; i < 4; i += 1) {
      rest.push((await it.next()).value!)
    }
    // remaining four arrive in the same drain burst (no further window)
    expect(Date.now() - tSecond).toBeLessThan(25)
    expect(rest.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect(rest).toMatchObject([
      { type: "assistant", text: "he" },
      { type: "assistant", text: "llo" },
      { type: "tool", callId: "call_1", status: "running" },
      { type: "tool", callId: "call_1", status: "done" },
    ])
    expect(backend.seqCursor()).toBe(4)
  })

  it("replay(afterSeq) is the determinism anchor: same mapper → same order+seqs", async () => {
    const sessionId = "s2"
    const service = makeService({ sessionId })
    const backend = createEmbeddedBackend({ service, sessionId, batchMs: 20 })
    backends.push(backend)
    const assembly = await service.assemblyFor(sessionId)
    const session = assembly.session
    append(session, { type: "user/message", text: "hi" })
    append(session, { type: "assistant/chunk", text: "he" })
    append(session, { type: "assistant/chunk", text: "llo" })
    append(session, { type: "assistant/message", text: "hello" }) // aggregate → skipped
    append(session, { type: "tool/call", callId: "c", name: "read", args: {} })
    append(session, { type: "tool/result", callId: "c", name: "read", output: { content: "ok" } })
    append(session, { type: "turn/end" })

    // replay is EXCLUSIVE: -1 = everything (the host bootstrap call)
    const full = await backend.replay(-1)
    expect(full.map((e) => `${e.type}:${e.seq}`)).toEqual([
      "user:0", "assistant:1", "assistant:2", "tool:4", "tool:5", "turn:6",
    ])
    const tail = await backend.replay(3)
    expect(tail.map((e) => `${e.type}:${e.seq}`)).toEqual(["tool:4", "tool:5", "turn:6"])
    expect(backend.seqCursor()).toBe(6)
    // an unknown session before any assembly → empty, never throws
    const other = createEmbeddedBackend({ service, sessionId: "nope", batchMs: 20 })
    backends.push(other)
    expect(await other.replay(0)).toEqual([])
  })

  it("submit actually turns (mock) — live stream and replay agree", async () => {
    const sessionId = "s3"
    const service = makeService({ sessionId, mockScript: [{ role: "assistant", text: "Hello 世界" }] })
    const backend = createEmbeddedBackend({ service, sessionId })
    backends.push(backend)
    await service.assemblyFor(sessionId) // pre-build: the 60ms settle below is enough for subscribe

    const collected: TuiEvent[] = []
    const consumer = (async () => {
      for await (const ev of backend.events()) {
        collected.push(ev)
        if (ev.type === "turn" && ev.phase === "end") return
      }
    })()
    await sleep(60) // subscription live before the turn starts
    await backend.submit("kick it off")
    await consumer

    // the real one-step turn: [admitted, promoted, step/start, step/end]
    // skipped; runtime-context injects a user/message at the step pre-seam,
    // then turn/start, user/message, [runtime user], assistant/message, turn/end
    expect(collected.map((e) => `${e.type}:${e.seq}`)).toEqual([
      "turn:2", "user:3", "user:5", "assistant:6", "turn:8",
    ])
    expect(collected[1]).toMatchObject({ type: "user", text: "kick it off" })
    expect(collected[2]).toMatchObject({ type: "user", seq: 5 }) // runtime context
    expect(collected[3]).toMatchObject({ type: "assistant", text: "Hello 世界" })

    const replayed = await backend.replay(-1)
    expect(replayed.map((e) => `${e.type}:${e.seq}`)).toEqual(collected.map((e) => `${e.type}:${e.seq}`))
    expect(backend.status()).toEqual({ running: false, queued: 0 })
  })

  it("cancel(): an aborted queued submit never turns (no hung mock — documented limitation)", async () => {
    const sessionId = "s4"
    const service = makeService({ sessionId, mockScript: [{ role: "assistant", text: "ok" }] })
    const backend = createEmbeddedBackend({ service, sessionId })
    backends.push(backend)
    const p1 = backend.submit("A")
    const p2 = backend.submit("B") // queued behind A
    await backend.cancel() // aborts the latest submit's controller (the queued one)
    await Promise.all([p1, p2])
    // note: the assembly's runtime-context section appends its own log-only
    // user/message — assert on the AUTHORING texts only
    const users = (await backend.replay(-1)).filter((e) => e.type === "user").map((e) => (e as { text: string }).text)
    expect(users[0]).toBe("A")
    expect(users).not.toContain("B")
  })

  it("replay preserves order+seq for plan/title records", async () => {
    const sessionId = "s5"
    const service = makeService({ sessionId })
    const backend = createEmbeddedBackend({ service, sessionId, modelLabel: "mock" })
    backends.push(backend)
    const assembly = await service.assemblyFor(sessionId)
    append(assembly.session, { type: "plan/mode", mode: "off" })
    append(assembly.session, { type: "session/title", title: "My Session", messageSeqs: [], source: "user" })
    expect((await backend.replay(-1)).map((e) => `${e.type}:${e.seq}`)).toEqual(["plan:0", "title:1"])
  })

  it("steer while idle degrades to a send-tier turn (running case needs a live turn — M37a seam)", async () => {
    const sessionId = "s6"
    const service = makeService({ sessionId })
    const backend = createEmbeddedBackend({ service, sessionId })
    backends.push(backend)
    await backend.steer("idle steer")
    const deadline = Date.now() + 4000
    let users: string[] = []
    for (;;) {
      users = (await backend.replay(-1)).filter((e) => e.type === "user").map((e) => (e as { text: string }).text)
      if (users.some((t) => t === "idle steer") || Date.now() > deadline) break
      await sleep(60)
    }
    expect(users.filter((t) => t === "idle steer")).toEqual(["idle steer"])
  })

  it("context(): REAL token-meter usage (M40 G2) — no total when the host did not resolve a window", async () => {
    const sessionId = "s-ctx1"
    const service = makeService({ sessionId })
    const backend = createEmbeddedBackend({ service, sessionId })
    backends.push(backend)
    const assembly = await service.assemblyFor(sessionId)
    const session = assembly.session
    append(session, { type: "user/message", text: "hello world" })
    append(session, { type: "assistant/message", text: "ok" })
    const ctx = await backend.context?.()
    expect(ctx).toBeDefined()
    // the used count IS the token-meter projection over this session's log
    // (deriveMessages output — the same estimator the engine's context tool
    // and the M25 usage telemetry use; never a fabricated estimate).
    expect(ctx!.used).toBe(activeTokens(session))
    expect(ctx!.used).toBeGreaterThan(0)
    expect("total" in (ctx!)).toBe(false)
  })

  it("context(): total present when the host resolved a context window (shape with total)", async () => {
    const sessionId = "s-ctx2"
    const service = makeService({ sessionId })
    const backend = createEmbeddedBackend({ service, sessionId, contextWindow: 128_000 })
    backends.push(backend)
    const assembly = await service.assemblyFor(sessionId)
    append(assembly.session, { type: "user/message", text: "hi" })
    const ctx = await backend.context?.()
    expect(ctx).toEqual({ used: activeTokens(assembly.session), total: 128_000 })
  })

  it("defaultEmbeddedFactory: mock turn + auto-submit of the initial prompt on open", async () => {
    const backend = await defaultEmbeddedFactory({ modelPolicy: "test-mock", workspace: tmp(), prompt: "kickoff" })
    backends.push(backend)
    const rows = await backend.listSessions()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: expect.any(String), title: "Session", turnCount: 0 })
    await backend.open(rows[0]!.id)
    // poll the log for the auto-submitted turn (cyclic mock answers "ok")
    const deadline = Date.now() + 4000
    let events: TuiEvent[] = []
    for (;;) {
      events = await backend.replay(0)
      if (events.some((e) => e.type === "user" && (e as { text: string }).text === "kickoff")) break
      if (Date.now() > deadline) throw new Error("factory auto-submit did not turn within 4s")
      await sleep(60)
    }
    const assistant = events.find((e) => e.type === "assistant")
    expect(assistant !== undefined && (assistant as { text: string }).text).toBe("ok")
    expect(backend.status()).toEqual({ running: false, queued: 0 })
  })
  it("durable TUI session survives close and reopen without repeating kickoff", async () => {
    const root = tmp()
    const first = await defaultEmbeddedFactory({ modelPolicy: "test-mock", workspace: tmp(), prompt: "kickoff", storeRoot: root })
    const rows = await first.listSessions()
    expect(rows).toHaveLength(1)
    const id = rows[0]!.id
    await first.open(id)
    await first.submit("distinct history")
    await first.close()
    const second = await defaultEmbeddedFactory({ modelPolicy: "test-mock", workspace: tmp(), prompt: "kickoff", storeRoot: root, resumeSessionId: id })
    await second.open(id)
    const restored = await second.replay(-1)
    const resumedRows = await second.listSessions()
    expect(resumedRows[0]).toMatchObject({ id, turnCount: 2 })
    expect(restored.filter((e) => e.type === "user" && (e as { text: string }).text === "kickoff")).toHaveLength(1)
    expect(restored.some((e) => e.type === "user" && (e as { text: string }).text === "distinct history")).toBe(true)
    await second.submit("after resume")
    await second.close()
    const third = await defaultEmbeddedFactory({ modelPolicy: "test-mock", workspace: tmp(), prompt: "kickoff", storeRoot: root, resumeSessionId: id })
    const persistedAfterResume = await third.replay(-1)
    expect(persistedAfterResume.some((e) => e.type === "user" && (e as { text: string }).text === "after resume")).toBe(true)
    await third.close()
  })

  it("durable TUI factory rejects an unknown resume session", async () => {
    await expect(defaultEmbeddedFactory({ modelPolicy: "test-mock", workspace: tmp(), prompt: "", storeRoot: tmp(), resumeSessionId: "missing" })).rejects.toThrow()
  })

  it("isolates resumed session state when opening another durable session", async () => {
    const root = tmp()
    const seed = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    await seed.create({ sessionId: "session-a" })
    await seed.create({ sessionId: "session-b" })
    await seed.append("session-a", [
      { type: "turn/start" },
      { type: "user/message", text: "A history" },
      { type: "assistant/message", text: "A answer" },
      { type: "step/end" },
      { type: "turn/end" },
    ])
    await seed.close()
    const backend = await defaultEmbeddedFactory({ modelPolicy: "test-mock", workspace: tmp(), prompt: "", storeRoot: root, resumeSessionId: "session-a" })
    await backend.open("session-b")
    const bEvents = await backend.replay(-1)
    expect(bEvents.some((event) => event.type === "user" && (event as { text: string }).text === "A history")).toBe(false)
    await backend.submit("B prompt")
    await backend.close()
    const check = createSessionCoordinator(createJsonlBackend(root))
    try {
      const a = await check.load("session-a")
      const b = await check.load("session-b")
      expect(a.session.events.some((event) => event.type === "user/message" && event.text === "B prompt")).toBe(false)
      expect(b.session.events.some((event) => event.type === "user/message" && event.text === "B prompt")).toBe(true)
    } finally {
      await check.close()
    }
  })

  it("keeps the newest session selected when concurrent opens finish out of order", async () => {
    const initial = createSession()
    const sessionA = createSession()
    const sessionB = createSession()
    append(sessionA, { type: "user/message", text: "A history" })
    append(sessionB, { type: "user/message", text: "B history" })
    const pendingA = deferred<{ session: typeof sessionA }>()
    const pendingB = deferred<{ session: typeof sessionB }>()
    const submitted: string[] = []
    const service = {
      submit: async (sessionId: string) => { submitted.push(sessionId) },
      assemblyFor: async (sessionId: string) => {
        if (sessionId === "initial") return { session: initial }
        if (sessionId === "session-a") return pendingA.promise
        if (sessionId === "session-b") return pendingB.promise
        throw new Error(`unexpected session: ${sessionId}`)
      },
      liveSession: () => undefined,
      hasAssembly: () => false,
      queueState: () => ({ running: false, queued: 0 }),
      onAssembly: () => () => {},
      close: async () => {},
    } as unknown as SessionService
    const backend = createEmbeddedBackend({ service, sessionId: "initial", prompt: "" })

    const openA = backend.open("session-a")
    const openB = backend.open("session-b")
    pendingB.resolve({ session: sessionB })
    await openB
    pendingA.resolve({ session: sessionA })
    await openA

    const replayed = await backend.replay(-1)
    expect(replayed.some((event) => event.type === "user" && event.text === "B history")).toBe(true)
    expect(replayed.some((event) => event.type === "user" && event.text === "A history")).toBe(false)
    await backend.submit("newest")
    expect(submitted).toEqual(["session-b"])
    await backend.close()
  })

  it("lists durable sessions without locking or poisoning the picker", async () => {
    const root = tmp()
    const seed = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    await seed.create({ sessionId: "good" })
    await seed.create({ sessionId: "locked" })
    await seed.close()
    writeFileSync(join(root, "broken.jsonl"), "{not-json}\n", "utf8")
    const holder = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    await holder.adoptOwnership("locked")
    const backend = await defaultEmbeddedFactory({ modelPolicy: "test-mock", workspace: tmp(), prompt: "", storeRoot: root, resumeSessionId: "good" })
    try {
      const rows = await backend.listSessions()
      expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining(["good", "locked"]))
      expect(rows.map((row) => row.id)).not.toContain("broken")
    } finally {
      await backend.close()
      await holder.close()
    }
  })

  it("rebinds the live event stream when opening another durable session", async () => {
    const root = tmp()
    const seed = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    await seed.create({ sessionId: "session-a" })
    await seed.create({ sessionId: "session-b" })
    await seed.close()
    const backend = await defaultEmbeddedFactory({ modelPolicy: "test-mock", workspace: tmp(), prompt: "", storeRoot: root, resumeSessionId: "session-a" })
    const iterator = backend.events()[Symbol.asyncIterator]()
    try {
      let pending: Promise<IteratorResult<TuiEvent>> = iterator.next()
      await backend.open("session-b")
      await backend.submit("B live")
      let sawB = false
      const deadline = Date.now() + 2_000
      while (!sawB && Date.now() < deadline) {
        const next = await Promise.race([
          pending,
          new Promise<IteratorResult<TuiEvent>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined as never }), 100)),
        ])
        if (next.done) break
        sawB = next.value.type === "user" && next.value.text === "B live"
        if (!sawB) pending = iterator.next()
      }
      expect(sawB).toBe(true)
    } finally {
      await backend.close()
      await iterator.return?.()
    }
  })

  it("emits session/open before the replacement session history", async () => {
    const initial = createSession()
    const next = createSession()
    append(next, { type: "user/message", text: "replacement history" })
    const service = createSessionService({
      workspace: tmp(),
      approveAll: true,
      modelPolicy: "test-mock",
      sessionFor: async (sessionId) => sessionId === "initial" ? initial : next,
    })
    const backend = createEmbeddedBackend({ service, sessionId: "initial", prompt: "", batchMs: 0 })
    const seen: TuiEvent[] = []
    const consume = (async () => {
      for await (const event of backend.events()) seen.push(event)
    })()
    try {
      await backend.open("next")
      await waitFor(() => seen.length >= 1)
      expect(seen[0]).toMatchObject({ type: "session/open", sessionId: "next", seq: -1 })
      await waitFor(() => seen.length >= 2)
      expect(seen[1]).toMatchObject({ type: "user", text: "replacement history", seq: 0 })
    } finally {
      await backend.close()
      await consume
    }
  })

  it("durable session ownership rejects a second adopter", async () => {
    const root = tmp()
    const seed = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    const id = (await seed.create()).id
    await seed.close()
    const first = await defaultEmbeddedFactory({ modelPolicy: "test-mock", workspace: tmp(), prompt: "", storeRoot: root, resumeSessionId: id })
    const secondCoordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    await expect(defaultEmbeddedFactory({ modelPolicy: "test-mock", workspace: tmp(), prompt: "", coordinator: secondCoordinator, resumeSessionId: id })).rejects.toThrow()
    await expect(first.submit("original owner remains usable")).resolves.toBeUndefined()
    await first.close(); await secondCoordinator.close()
  })

  it("acquires durable ownership before loading the resume snapshot", async () => {
    const root = tmp()
    const seed = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    await seed.create({ sessionId: "owned-load" })
    await seed.append("owned-load", [
      { type: "turn/start", seq: 0 },
      { type: "turn/end", seq: 1 },
    ])
    await seed.close()

    const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    const originalLoad = coordinator.load.bind(coordinator)
    let interposed = false
    coordinator.load = async (sessionId) => {
      const stale = await originalLoad(sessionId)
      const external = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
      await external.adoptOwnership(sessionId)
      await external.append(sessionId, [
        { type: "turn/start", seq: 2 },
        { type: "turn/end", seq: 3 },
      ])
      await external.close()
      interposed = true
      return stale
    }

    const backend = await defaultEmbeddedFactory({
      modelPolicy: "test-mock",
      workspace: tmp(),
      prompt: "",
      coordinator,
      resumeSessionId: "owned-load",
    })
    try {
      await backend.submit("continued")
      await backend.close()
      const raw = await createJsonlBackend(root).read("owned-load")
      expect(raw.events.map((event) => event.seq)).toEqual(raw.events.map((_, index) => index))
      expect(interposed).toBe(false)
    } finally {
      await coordinator.close()
    }
  })

  it("injected resumed coordinator remains caller-owned", async () => {
    const root = tmp()
    const seed = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    const id = (await seed.create()).id
    await seed.close()
    const injected = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    const backend = await defaultEmbeddedFactory({ modelPolicy: "test-mock", workspace: tmp(), prompt: "", coordinator: injected, resumeSessionId: id })
    await backend.close()
    const fresh = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    await expect(fresh.adoptOwnership(id)).rejects.toThrow()
    await injected.close()
    await expect(fresh.adoptOwnership(id)).resolves.toBeUndefined()
    await fresh.close()
  })

  it("does not fabricate turnCount for an unopened non-blank session on an injected coordinator", async () => {
    const root = tmp()
    const seed = createSessionCoordinator(createJsonlBackend(root))
    await seed.create({ sessionId: "current" })
    await seed.create({ sessionId: "unopened" })
    await seed.append("unopened", [{ type: "turn/start" }, { type: "turn/end" }])
    await seed.close()
    const injected = createSessionCoordinator(createJsonlBackend(root))
    const backend = await defaultEmbeddedFactory({
      modelPolicy: "test-mock",
      workspace: tmp(),
      prompt: "",
      coordinator: injected,
      resumeSessionId: "current",
    })
    try {
      const rows = await backend.listSessions()
      expect(rows.find((row) => row.id === "current")?.turnCount).toBe(0)
      expect(rows.find((row) => row.id === "unopened")?.turnCount).toBeUndefined()
    } finally {
      await backend.close()
      await injected.close()
    }
  })

  it("durable close is shared and idempotent across concurrent callers", async () => {
    const root = tmp()
    const seed = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    const id = (await seed.create()).id
    await seed.close()
    const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    const backend = await defaultEmbeddedFactory({ modelPolicy: "test-mock", workspace: tmp(), prompt: "", coordinator, resumeSessionId: id })
    let flushes = 0
    let closes = 0
    const flush = coordinator.flush.bind(coordinator)
    const close = coordinator.close.bind(coordinator)
    coordinator.flush = async (sessionId) => { flushes++; await sleep(20); return flush(sessionId) }
    coordinator.close = async () => { closes++; return close() }
    const first = backend.close()
    const second = backend.close()
    expect(first).toBe(second)
    await Promise.all([first, second, backend.close()])
    expect(flushes).toBe(1)
    expect(closes).toBe(0)
  })

  it("durable close propagates flush failure and still closes an owned coordinator", async () => {
    const root = tmp()
    const coordinator = createSessionCoordinator(createJsonlBackend(root))
    const backend = await defaultEmbeddedFactory({ modelPolicy: "test-mock", workspace: tmp(), prompt: "", storeRoot: root, coordinator })
    const originalFlush = coordinator.flush
    coordinator.flush = async () => { throw new Error("flush failed") }
    await expect(backend.close()).rejects.toThrow("flush failed")
    coordinator.flush = originalFlush
    await coordinator.close()
  })

})
