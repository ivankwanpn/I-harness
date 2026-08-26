import { describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// M19: the 4 team/* session event types must survive a JSONL append + load
// round-trip — i.e. pass the KNOWN_EVENT_TYPES guard in guardIgnorable.
describe("team event types round-trip", () => {
  it("all 4 team/* events survive append + load (KNOWN_EVENT_TYPES accepts them)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-team-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
      const { id } = await coordinator.create({})
      coordinator.enqueue(id, [
        {
          type: "team/member", version: 1, teamId: id,
          member: { id: "child-1", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" },
        },
        {
          type: "team/task", version: 1, teamId: id,
          task: { id: "t-1", revision: 1, subject: "Sub", description: "desc", status: "pending", blockedBy: [], writeScopes: [] },
        },
        {
          type: "team/message/queued", version: 1, teamId: id,
          message: { id: "m-1", senderId: "child-1", senderName: "helper", targetId: id, delivery: "quiet", content: "hi" },
        },
        { type: "team/message/delivered", version: 1, teamId: id, messageId: "m-1", targetId: "child-1" },
      ])
      await coordinator.flush(id)
      const loaded = await coordinator.load(id)
      expect(loaded.session.events.map((e) => e.type)).toEqual([
        "team/member",
        "team/task",
        "team/message/queued",
        "team/message/delivered",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
