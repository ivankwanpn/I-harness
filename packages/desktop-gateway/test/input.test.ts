import { expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionService, createDurableSessionLoader } from "@i-harness/session-executor"
type ModelClient = NonNullable<Parameters<typeof createSessionService>[0]["model"]>
type LLMRequest = Parameters<ModelClient["stream"]>[0]
import { createDesktopInput } from "../src/input.ts"

it("Desktop input wakes only its exact live Session's human observer and a later prompt retrieves the same cell", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-input-steer-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  for (const sessionId of ["a", "b"]) await coordinator.create({ sessionId })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const requests = new Map<string, LLMRequest[]>(), calls = new Map<string, number>(), cells = new Map<string, string>()
  let finished = 0, activeAborts = 0
  const model: ModelClient = { async *stream(request) {
    const id = request.messages.some(message => message.role === "user" && message.content === "start a") ? "a" : "b"
    const seen = requests.get(id) ?? []; seen.push(request); requests.set(id, seen)
    if (seen.length === 1) yield { type: "tool_call", call: { id: `start-${id}`, name: "code_exec", args: { code: `text(await tools.held_read({id:${JSON.stringify(id)}}));`, yield_time_ms: 60_000 } } }
    else if (seen.length === 3) yield { type: "tool_call", call: { name: "code_wait", args: { cell_id: cells.get(id), yield_time_ms: 5000 } } }
    else yield { type: "text/chunk", text: "parent turn ended" }
    yield { type: "end" }
  } }
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model, sandbox: "danger-full-access", approveAll: true, codeMode: { mode: "mixed" }, additionalTools: [{
    name: "held_read", description: "Held exact-session producer", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, isReadOnly: true,
    execute: async (args: { id: string }, exec) => { calls.set(args.id, (calls.get(args.id) ?? 0) + 1); let done = false; exec.abortSignal?.addEventListener("abort", () => { if (!done) activeAborts++ }, { once: true }); await held; done = true; finished++; return `original ${args.id}` },
  }] })
  const input = createDesktopInput(coordinator, service)
  try {
    const a = await service.assemblyFor("a"), b = await service.assemblyFor("b")
    // Cancellation is tested before observation: an admission already cancelled
    // cannot remain a pending source. Cancellation after a delivered wake does
    // not retroactively undo that wake.
    a.inbox.admit({ inputId: "cancelled-human", text: "cancelled direction", delivery: "steer", intent: "user" })
    a.inbox.cancel("cancelled-human")
    await input.admit("a", { text: "start a", delivery: "queue" }); await input.admit("b", { text: "start b", delivery: "queue" })
    await vi.waitFor(() => { expect(calls.get("a")).toBe(1); expect(calls.get("b")).toBe(1) }, { timeout: 5000 })
    const queued = await input.admit("a", { text: "queued direction", delivery: "queue", start: false })
    a.inbox.admit({ inputId: "system-steer", text: "system direction", delivery: "steer", intent: "system", synthetic: { description: "fixture", scope: "turn" } })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(requests.get("a")).toHaveLength(1); expect(requests.get("b")).toHaveLength(1)
    await input.cancel("a", queued.inputId)
    const bSteer = await input.admit("b", { text: "human b direction", delivery: "steer" })
    await vi.waitFor(() => expect(requests.get("b")).toHaveLength(2), { timeout: 5000 })
    expect(requests.get("a")).toHaveLength(1)
    const aSteer = await input.admit("a", { text: "human a direction", delivery: "steer" })
    await vi.waitFor(() => expect(requests.get("a")).toHaveLength(2), { timeout: 5000 }); await input.drain()
    expect(finished).toBe(0); expect(activeAborts).toBe(0)
    for (const [id, assembly, steer] of [["a", a, aSteer], ["b", b, bSteer]] as const) {
      expect(service.queueState(id).running).toBe(false)
      const observation = assembly.session.events.find(event => event.type === "tool/result" && event.name === "code_exec")
      expect(observation?.type).toBe("tool/result")
      const output = (observation as { output: { cell_id: string; status: string; yield_reason: string } }).output
      expect(output).toMatchObject({ status: "running", yield_reason: "user-steer" }); cells.set(id, output.cell_id)
      expect(assembly.session.events.filter(event => event.type === "agent/input/promoted" && event.inputId === steer.inputId)).toHaveLength(1)
      expect(requests.get(id)![1]!.messages.filter(message => message.role === "user" && message.content === `human ${id} direction`)).toHaveLength(1)
      expect(assembly.session.events.filter(event => event.type === "user/message" && event.text === `human ${id} direction`)).toHaveLength(1)
      expect(assembly.session.events.filter(event => event.type === "user/message" && event.text === "cancelled direction")).toHaveLength(0)
    }
    release()
    for (const id of ["a", "b"]) await input.admit(id, { text: "retrieve", delivery: "queue" })
    await input.drain()
    for (const [id, assembly] of [["a", a], ["b", b]] as const) {
      const observation = assembly.session.events.find(event => event.type === "tool/result" && event.name === "code_wait") as { output: unknown }
      expect(observation.output).toMatchObject({ cell_id: cells.get(id), status: "completed" })
      expect(JSON.stringify(observation.output)).toContain(`original ${id}`)
      expect(assembly.session.events.filter(event => event.type === "code/cell" && event.state === "started")).toHaveLength(1)
      expect(assembly.session.events.filter(event => event.type === "code/result")).toHaveLength(1)
      expect(calls.get(id)).toBe(1)
    }
    expect(finished).toBe(2); expect(activeAborts).toBe(0)
  } finally { release(); await input.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
}, 15_000)

it("admits a second input durably before the first provider response and preserves FIFO", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-input-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "s" })
  let release!: () => void
  let entered!: () => void
  const began = new Promise<void>((done) => { entered = done })
  const hold = new Promise<void>((done) => { release = done })
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) { requests.push(request); if (requests.length === 1) { entered(); await hold }; yield { type: "text/chunk", text: "ok" }; yield { type: "end" } } }
  const service = createSessionService({ workspace: root, model, coordinator, sessionFor: createDurableSessionLoader(coordinator) })
  const input = createDesktopInput(coordinator, service)
  try {
    await input.admit("s", { text: "first", delivery: "queue" })
    await began
    const second = await input.admit("s", { text: "second", delivery: "queue" })
    expect((await input.state("s")).items.find((row) => row.id === second.inputId)).toMatchObject({ text: "second", state: "queued" })
    expect((await coordinator.snapshot!("s")).session.events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(2)
    expect(requests).toHaveLength(1)
    release()
    await input.drain()
    expect(requests).toHaveLength(2)
    expect(service.liveSession("s")!.events.filter((event) => event.type === "user/message" && ["first", "second"].includes(event.text)).map((event) => event.type === "user/message" && event.text)).toEqual(["first", "second"])
  } finally { release(); await service.close(); await input.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("recovers cold queued answers once and refuses changed recovery retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-input-cold-"))
  let coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "s" })
  let service = createSessionService({ workspace: root, coordinator, modelPolicy: "required" })
  let input = createDesktopInput(coordinator, service)
  try {
    await input.admit("s", { inputId: "recovery-one", text: "saved answer", delivery: "queue", start: false })
    await input.admit("s", { inputId: "recovery-one", text: "saved answer", delivery: "queue", start: false })
    await expect(input.admit("s", { inputId: "recovery-one", text: "changed answer", delivery: "queue", start: false })).rejects.toThrow("does not match")
    await service.close(); await input.close(); await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(root))
    const model: ModelClient = { async *stream() { yield { type: "text/chunk", text: "ok" }; yield { type: "end" } } }
    service = createSessionService({ workspace: root, model, coordinator, sessionFor: createDurableSessionLoader(coordinator) })
    input = createDesktopInput(coordinator, service)
    expect(await input.state("s")).toMatchObject({ resumable: true, items: [{ id: "recovery-one", text: "saved answer" }] })
    await input.admit("s", { text: "new input", delivery: "queue" }); await input.drain()
    const delivered = service.liveSession("s")!.events.filter((event) => event.type === "user/message" && ["saved answer", "new input"].includes(event.text)).map((event) => event.type === "user/message" && event.text)
    expect(delivered).toEqual(["saved answer", "new input"])
    expect((await input.state("s")).items).toHaveLength(0)
  } finally { await service.close(); await input.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("revives a canceled recovery admission with a fresh exactly-once generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-input-retry-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "s" })
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: "required" })
  const input = createDesktopInput(coordinator, service)
  try {
    await input.admit("s", { inputId: "recover", text: "answer", delivery: "queue", start: false })
    expect(await input.cancel("s", "recover")).toEqual({ cancelled: true })
    const revived = await input.admit("s", { inputId: "recover", text: "answer", delivery: "queue", start: false })
    expect(revived.inputId).not.toBe("recover")
    expect(await input.admit("s", { inputId: "recover", text: "answer", delivery: "queue", start: false })).toEqual(revived)
    expect((await input.state("s")).items.map((row) => row.id)).toEqual([revived.inputId])
  } finally { await input.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
