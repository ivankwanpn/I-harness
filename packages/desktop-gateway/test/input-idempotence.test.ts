import { expect, it } from "vitest"
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
