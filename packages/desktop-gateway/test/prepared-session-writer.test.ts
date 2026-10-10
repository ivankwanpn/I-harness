import { expect, it } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService, type SessionServiceOptions } from "@i-harness/session-executor"
import { createDesktopWorkState } from "../src/work-state.ts"
import { createDesktopInput } from "../src/input.ts"

type ModelClient = NonNullable<SessionServiceOptions["model"]>
type LLMRequest = Parameters<ModelClient["stream"]>[0]

async function fixture(phase: "prepared" | "mounting", ready = false, failFirstMount = false) {
  const root = await mkdtemp(join(tmpdir(), "ih-prepared-writer-")), coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  await coordinator.create({ sessionId: "owned" })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let attempts = 0
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) { requests.push(request); yield { type: "text/chunk", text: "Owned continuation" }; yield { type: "end" } } }
  const loader = createDurableSessionLoader(coordinator)
  const service = createSessionService({ workspace: root, coordinator, sessionFor: loader, sandbox: "read-only", model, modelPolicy: "test-mock",
    ...(ready ? { modelBindingFor: async () => ({ status: "ready" as const, binding: { model, providerId: "owned", modelId: "owned", label: "Owned" } }) } : {}),
    ...(phase === "prepared" ? { wslExecutionFor: async () => { entered.resolve(); await release.promise; return undefined } } : {}),
    extensionsFor: async () => ({ options: {}, mount: async () => {
      if (phase === "mounting" && ++attempts === 1) { entered.resolve(); await release.promise; if (failFirstMount) throw new Error("Owned mount refused") }
    } }),
  })
  const work = createDesktopWorkState(coordinator, service, { sessionFor: loader }), input = createDesktopInput(coordinator, service)
  const building = service.assemblyFor("owned")
  // Keep a failure owned while the test deliberately holds the build.
  void building.catch(() => {})
  await entered.promise
  return { root, coordinator, service, work, input, building, release, requests,
    async close() { release.resolve(); await building.catch(() => {}); await input.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) },
  }
}

async function withoutMount<T>(promise: Promise<T>): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Human admission waited for the held execution mount")), 1000) })]) }
  finally { if (deadline) clearTimeout(deadline) }
}

it.each(["prepared", "mounting"] as const)("retains an acknowledged Todo on the %s writer through publication and cold reopen", async phase => {
  const f = await fixture(phase)
  try {
    expect(f.service.liveSession("owned")).toBeUndefined()
    const items = [{ content: "Owned human Todo during startup", status: "pending" as const }]
    expect(await withoutMount(f.work.writeTodos("owned", { expectedRevision: 0, items }))).toMatchObject({ todos: items, todosRevision: 1 })
    expect(await f.work.read("owned")).toMatchObject({ todos: items, todosRevision: 1 })
    expect(f.requests).toHaveLength(0)
    f.release.resolve(); await f.building
    expect(await f.work.read("owned")).toMatchObject({ todos: items, todosRevision: 1 })
    await f.service.submit("owned", "Owned continuation after publication", new AbortController().signal)
    expect(f.requests[0]!.systemPrompt).toContain("Owned human Todo during startup")
    await f.service.closeSession("owned")
    await f.service.assemblyFor("owned")
    expect(await f.work.writeTodos("owned", { expectedRevision: 1, items: [{ content: items[0]!.content, status: "completed" }] })).toMatchObject({ todosRevision: 2 })
    await f.service.close(); await f.coordinator.close()
    const file = join(f.root, "owned.jsonl"), before = await readFile(file, "utf8"), cold = createSessionCoordinator(createJsonlBackend(f.root))
    try {
      const events = (await cold.loadOwned("owned")).session.events
      expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index))
      expect(events.filter(event => event.type === "todo/write")).toHaveLength(2)
      expect(await readFile(file, "utf8")).toBe(before)
    } finally { await cold.close() }
    await expect(f.work.writeTodos("owned", { expectedRevision: 2, items: [] })).rejects.toThrow(/closed/)
  } finally { await f.close() }
}, 15_000)

it.each([false, true])("retains a human input admitted during mount and runs its exact ID once (ready model=%s)", async ready => {
  const f = await fixture("mounting", ready)
  let admitting: Promise<unknown> | undefined
  try {
    admitting = f.input.admit("owned", { inputId: "owned-during-mount", text: "Owned queued input during mount", delivery: "queue", start: false })
    const accepted = await withoutMount(admitting)
    expect(accepted).toMatchObject({ accepted: true, inputId: "owned-during-mount" })
    expect(f.requests).toHaveLength(0)
    f.release.resolve(); const assembly = await f.building
    expect(assembly.inbox.pending().map(input => input.inputId)).toEqual(["owned-during-mount"])
    await f.input.resume("owned"); await f.input.drain()
    expect(f.requests).toHaveLength(1)
    expect(assembly.session.events.filter(event => event.type === "agent/input/promoted" && event.inputId === "owned-during-mount")).toHaveLength(1)
    const events = (await f.coordinator.snapshot!("owned")).session.events
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index))
  } finally { f.release.resolve(); await admitting?.catch(() => {}); await f.close() }
}, 15_000)

it("drains a failed mount's writer on close and restores acknowledged state on the same-ID retry", async () => {
  const f = await fixture("mounting", false, true)
  try {
    await f.work.writeTodos("owned", { expectedRevision: 0, items: [{ content: "Owned retained failed-mount Todo", status: "pending" }] })
    f.release.resolve()
    await expect(f.building).rejects.toThrow("Owned mount refused")
    expect(f.service.hasAssembly("owned")).toBe(false)
    await f.service.closeSession("owned")
    await f.service.assemblyFor("owned")
    expect(await f.work.read("owned")).toMatchObject({ todosRevision: 1, todos: [{ content: "Owned retained failed-mount Todo", status: "pending" }] })
    await f.work.writeTodos("owned", { expectedRevision: 1, items: [] })
    const events = (await f.coordinator.snapshot!("owned")).session.events
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index))
  } finally { await f.close() }
})

it.each(["prepared", "mounting"] as const)("refuses late %s publication after close and reopens only in the next lifecycle", async phase => {
  const f = await fixture(phase), published: unknown[] = []
  f.service.onAssembly(assembly => { published.push(assembly) })
  try {
    const closing = f.service.closeSession("owned")
    await expect(f.work.writeTodos("owned", { expectedRevision: 0, items: [] })).rejects.toThrow(/closing/)
    f.release.resolve()
    await closing
    await expect(f.building).rejects.toThrow(/closing/)
    expect(f.service.hasAssembly("owned")).toBe(false)
    expect(published).toHaveLength(0)
    await f.service.assemblyFor("owned")
    expect(published).toHaveLength(1)
  } finally { await f.close() }
})

it("owns a late cold writer load through close without publishing it or changing the saved session", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-late-writer-close-")), coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  await coordinator.create({ sessionId: "owned" })
  const file = join(root, "owned.jsonl"), before = await readFile(file, "utf8"), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let loads = 0
  const observed = { ...coordinator, loadOwned: async (id: string) => {
    const restored = await coordinator.loadOwned(id)
    if (++loads === 1) { entered.resolve(); await release.promise }
    return restored
  } }
  const service = createSessionService({ workspace: root, coordinator: observed, sessionFor: createDurableSessionLoader(observed), modelPolicy: "required" }), work = createDesktopWorkState(observed, service)
  const writing = work.writeTodos("owned", { expectedRevision: 0, items: [{ content: "Must not be acknowledged after close", status: "pending" }] })
  void writing.catch(() => {})
  try {
    await entered.promise
    const closing = service.closeSession("owned")
    release.resolve(); await closing
    await expect(writing).rejects.toThrow(/closing/)
    expect(service.hasAssembly("owned")).toBe(false)
    expect(await readFile(file, "utf8")).toBe(before)
    expect(await work.writeTodos("owned", { expectedRevision: 0, items: [{ content: "Owned next lifecycle", status: "pending" }] })).toMatchObject({ todosRevision: 1 })
    expect(loads).toBe(2)
    expect(service.hasAssembly("owned")).toBe(false)
  } finally { release.resolve(); await writing.catch(() => {}); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("retains the failed cleanup owner until an explicit close succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-mount-cleanup-owner-")), coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "owned" })
  let attempts = 0, failCleanup = true
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), modelPolicy: "test-mock",
    extensionsFor: async () => ({ options: {}, mount: async assembly => {
      if (++attempts !== 1) return
      const actualDispose = assembly.dispose.bind(assembly)
      assembly.dispose = async () => { if (failCleanup) throw new Error("Owned setup cleanup incomplete"); await actualDispose() }
      throw new Error("Owned setup rejected")
    } }),
  })
  const work = createDesktopWorkState(coordinator, service)
  try {
    await expect(service.assemblyFor("owned")).rejects.toThrow("Owned setup cleanup incomplete")
    await expect(service.assemblyFor("owned")).rejects.toThrow(/cleanup incomplete/)
    await expect(work.writeTodos("owned", { expectedRevision: 0, items: [] })).rejects.toThrow(/cleanup incomplete/)
    expect(attempts).toBe(1)
    failCleanup = false
    await service.closeSession("owned")
    await service.assemblyFor("owned")
    expect(attempts).toBe(2)
  } finally { failCleanup = false; await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
