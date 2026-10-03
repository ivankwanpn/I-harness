import { expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionService, createDurableSessionLoader } from "@i-harness/session-executor"
import { createDesktopInput, desktopInputReceiptDocumentKey } from "../src/input.ts"
it("admits a stable client token once with context/images across concurrent and restarted retries, rejecting changed payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-input-token-"))
  let coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "s" })
  let service = createSessionService({ workspace: root, coordinator, modelPolicy: "required" })
  let input = createDesktopInput(coordinator, service)
  const raw = { text: "draft", context: "file body", images: [{ mediaType: "image/png" as const, dataBase64: "aGVsbG8=" }], delivery: "queue" as const, clientToken: "stable-token-123456", start: false }
  try {
    const [first, retry] = await Promise.all([input.admit("s", raw), input.admit("s", raw)])
    expect(first.inputId).toBe(retry.inputId)
    expect((await coordinator.snapshot!("s")).session.events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(1)
    const receipt = await coordinator.getDocument(desktopInputReceiptDocumentKey("s"))
    expect(JSON.stringify(receipt)).not.toContain("aGVsbG8=")
    await input.close(); await service.close(); await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(root))
    service = createSessionService({ workspace: root, coordinator, modelPolicy: "required", sessionFor: createDurableSessionLoader(coordinator) })
    input = createDesktopInput(coordinator, service)
    expect((await input.admit("s", raw)).inputId).toBe(first.inputId)
    await expect(input.admit("s", { ...raw, context: "changed" })).rejects.toThrow(/match|payload/)
    await expect(input.admit("s", { ...raw, images: [] })).rejects.toThrow(/match|payload/)
    expect((await coordinator.snapshot!("s")).session.events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(1)
  } finally { await input.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("rejects same-token retry while admission flush still fails, then durably schedules the retained live input once", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-input-flush-"))
  const backend = createJsonlBackend(root)
  let blocked = true
  const append = vi.fn(async (...args: Parameters<typeof backend.append>) => {
    if (blocked && args[1].some((event) => event.type === "agent/input/admitted")) throw new Error("admission storage blocked")
    return backend.append(...args)
  })
  const coordinator = createSessionCoordinator({ ...backend, append }, { maxDelayMs: 60000 })
  await coordinator.create({ sessionId: "s" })
  const stream = vi.fn(async function* () { yield { type: "text/chunk" as const, text: "fixture result" }; yield { type: "end" as const } })
  const service = createSessionService({ workspace: root, coordinator, model: { stream }, sessionFor: createDurableSessionLoader(coordinator) })
  const input = createDesktopInput(coordinator, service)
  const raw = { text: "retain until durable", delivery: "queue" as const, clientToken: "flush-retry-token-123" }
  try {
    await expect(input.admit("s", raw)).rejects.toThrow("admission storage blocked")
    expect(service.liveSession("s")!.events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(1)
    expect((await coordinator.snapshot!("s")).session.events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(0)
    await expect(input.admit("s", raw)).rejects.toThrow("admission storage blocked")
    expect(stream).not.toHaveBeenCalled()
    blocked = false
    const accepted = await input.admit("s", raw)
    expect(accepted.accepted).toBe(true)
    await input.drain()
    expect(stream).toHaveBeenCalledTimes(1)
    expect((await coordinator.snapshot!("s")).session.events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(1)
    expect(await input.admit("s", raw)).toEqual(accepted)
    await input.drain()
    expect(stream).toHaveBeenCalledTimes(1)
  } finally { blocked = false; await input.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
