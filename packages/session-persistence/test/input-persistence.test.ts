import { describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("agent/input persist round-trip (registerEventType gate)", () => {
  it("admits the three input events through the load gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-input-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
      const { id } = await coordinator.create({})
      coordinator.enqueue(id, [
        { type: "agent/input/admitted", version: 1, inputId: "in-1", text: "t", delivery: "queue", intent: "user" },
        { type: "agent/input/promoted", version: 1, inputId: "in-1" },
        { type: "agent/input/cancelled", version: 1, inputId: "in-9", reason: "x" },
      ])
      await coordinator.flush(id)
      const loaded = await coordinator.load(id)
      expect(loaded.session.events.map((e) => e.type)).toEqual([
        "agent/input/admitted", "agent/input/promoted", "agent/input/cancelled",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
