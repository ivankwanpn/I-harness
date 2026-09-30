import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionService, createDurableSessionLoader } from "@i-harness/session-executor"
type ModelClient = NonNullable<Parameters<typeof createSessionService>[0]["model"]>
type LLMRequest = Parameters<ModelClient["stream"]>[0]
import { createDesktopInput } from "../src/input.ts"

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
