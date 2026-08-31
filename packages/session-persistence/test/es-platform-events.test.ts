import { describe, expect, it } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// E-region foundation: the goal/change + job/status session events (recovered
// from the frontend-web branch) must survive a JSONL append + load round-trip
// — i.e. pass the KNOWN_EVENT_TYPES guard in guardIgnorable.
describe("e-region event types round-trip (goal/change, job/status)", () => {
  it("goal/change + job/status survive append + load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-e-region-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
      const { id } = await coordinator.create({})
      coordinator.enqueue(id, [
        {
          type: "goal/change", version: 1, operation: "create",
          goal: { id: "goal-1", revision: 1, objective: "write the report", phase: "active", maxGoalRounds: 5 },
          updatedAt: 10,
        },
        {
          type: "goal/change", version: 1, operation: "clear",
          cleared: { id: "goal-1", revision: 2 },
        },
        {
          type: "job/status", version: 1,
          job: { jobId: "subagent-1", kind: "subagent", label: "helper", status: "running", outputAvailable: false, startedAt: 1000 },
        },
        {
          type: "schedule/change", version: 1, operation: "create",
          schedule: { id: "schedule-1", kind: "after", prompt: "remind me", afterSeconds: 60, scheduledAt: "2026-08-31T10:01:00.000Z" },
        },
      ])
      await coordinator.flush(id)
      const loaded = await coordinator.load(id)
      expect(loaded.session.events.map((e) => e.type)).toEqual([
        "goal/change", "goal/change", "job/status", "schedule/change",
      ])
      const first = loaded.session.events[0] as Extract<SessionEvent, { type: "goal/change" }>
      expect(first).toMatchObject({ operation: "create", goal: { id: "goal-1", revision: 1, phase: "active", maxGoalRounds: 5 } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
