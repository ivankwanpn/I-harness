import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadless } from "../src/run.ts"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createMockClient } from "@i-harness/llm-mock"
import { createSession } from "@i-harness/core-session"

describe("CLI input tiers", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-tiers-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("drives the initial task through the executor (one submitted input = one serial turn)", async () => {
    const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
    const session = createSession()
    const model = createMockClient([
      { role: "assistant", text: "initial answer" },
    ])
    const result = await runHeadless("one", {
      workspace: dir,
      model,
      sessionId: "sess-tiers",
      coordinator,
      session,
    })
    expect(result.exitCode).toBe(0)
    expect(result.finalText).toBe("initial answer")
    // one submitted input drives exactly one serial turn on the session
    expect(session.events.filter((e) => e.type === "turn/end")).toHaveLength(1)
  })

  it("resumes pending inputs from the log, promoted before the new task", async () => {
    const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
    const { id } = await coordinator.create({ sessionId: "sess-recover" })
    coordinator.enqueue(id, [
      { type: "agent/input/admitted", version: 1, inputId: "old", text: "stale queued", delivery: "queue", intent: "user" },
    ])
    await coordinator.flush(id)
    const model = createMockClient([
      { role: "assistant", text: "stale done" },
      { role: "assistant", text: "new done" },
    ])
    const result = await runHeadless("new task", {
      workspace: dir, model,
      resumeSessionId: id, coordinator,
    })
    expect(result.exitCode).toBe(0)
    const userTexts = result.session!.events.filter((e) => e.type === "user/message").map((e) => (e as { text: string }).text)
    expect(userTexts[0]).toBe("stale queued") // FIFO: recovered pending first
    expect(userTexts).toContain("new task")
  })
})
