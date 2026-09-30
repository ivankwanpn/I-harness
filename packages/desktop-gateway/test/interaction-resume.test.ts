import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService } from "@i-harness/session-executor"
import { createDesktopInput } from "../src/input.ts"
import { createInteractionBridge } from "../src/interaction.ts"
import { openInteractionPersistence } from "../src/interaction-persistence.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe("interrupted interaction continuation", () => {
  it.each(["question", "approval"] as const)("saves a restored %s response without a model and consumes its input once after restart", async (kind) => {
    const path = await mkdtemp(join(tmpdir(), "interaction-resume-"))
    directories.push(path)
    const sessionDir = join(path, "sessions")
    const firstCoordinator = createSessionCoordinator(createJsonlBackend(sessionDir))
    await firstCoordinator.create({ sessionId: "s1" })
    const firstService = createSessionService({ workspace: path, coordinator: firstCoordinator, modelPolicy: "required" })
    const firstInput = createDesktopInput(firstCoordinator, firstService)
    const store = await openInteractionPersistence(sessionDir, path)
    store.write([{ requestId: "r1", sessionId: "s1", kind, payload: kind === "question" ? { prompt: "Which plan?", options: ["A", "B"] } : { name: "write", reason: "edit notes" }, openedAt: Date.now() }])
    const firstBridge = createInteractionBridge(() => {}, { persistence: store, recover: async ({ request, inputId, text, signal }) => {
      signal.throwIfAborted()
      await firstInput.admit(request.sessionId, { inputId, text, delivery: "queue", start: false })
    } })
    try {
      await firstBridge.reply({ requestId: "r1", sessionId: "s1", decision: kind === "question" ? { kind, answer: "B" } : { kind, approved: true } })
      expect(firstService.hasAssembly("s1")).toBe(false)
      expect((await firstInput.state("s1")).items).toEqual([expect.objectContaining({ id: "interaction-recovery-r1", state: "queued" })])
      const events = (await firstCoordinator.snapshot!("s1")).session.events
      expect(events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(1)
      expect(events.some((event) => event.type === "tool/call" || event.type === "user/message")).toBe(false)
    } finally { firstBridge.close(); await firstInput.close(); await firstService.close(); await firstCoordinator.close() }

    const coordinator = createSessionCoordinator(createJsonlBackend(sessionDir))
    const service = createSessionService({ workspace: path, coordinator, sessionFor: createDurableSessionLoader(coordinator), modelPolicy: "test-mock", mockScript: [{ role: "assistant", text: "Continued safely" }] })
    const input = createDesktopInput(coordinator, service)
    try {
      expect((await openInteractionPersistence(sessionDir, path)).read()).toEqual([])
      expect((await input.state("s1")).resumable).toBe(true)
      await input.resume("s1")
      await vi.waitFor(async () => expect((await input.state("s1")).items).toEqual([]))
      await input.close()
      await coordinator.flush("s1")
      const events = (await coordinator.snapshot!("s1")).session.events
      expect(events.filter((event) => event.type === "agent/input/admitted" && event.inputId === "interaction-recovery-r1")).toHaveLength(1)
      expect(events.filter((event) => event.type === "agent/input/promoted" && event.inputId === "interaction-recovery-r1")).toHaveLength(1)
      expect(events.filter((event) => event.type === "user/message" && !event.internal)).toHaveLength(1)
      expect(events.some((event) => event.type === "tool/call" || event.type === "tool/dispatch")).toBe(false)
      expect((await input.state("s1")).items).toEqual([])
      const message = events.find((event) => event.type === "user/message")
      if (message?.type !== "user/message") throw new Error("recovered input was not delivered")
      expect(message.text).toMatch(kind === "question" ? /My answer: B/ : /Reassess/)
    } finally { await input.close(); await service.close(); await coordinator.close() }
  })
})
