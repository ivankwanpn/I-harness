// M26-D1: subagent/start|end 事件型別 round-trip —— 仿 todo-persistence.test.ts
// 的 team/* 先例：registerEventType 於 module init 已註冊，load gate
// （guardIgnorable）需放行該二型別且不明文 drop。
import { describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("subagent/* persistence", () => {
  it("survives append + JSONL load (KNOWN_EVENT_TYPES accepts them)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-subagent-event-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
      const { id } = await coordinator.create({})
      coordinator.enqueue(id, [
        { type: "subagent/start", version: 1, taskId: "task-1", agentPath: "root/helper", role: "general", description: "helper" },
        { type: "subagent/end", version: 1, taskId: "task-1", outcome: "completed", resultText: "done" },
      ])
      await coordinator.flush(id)
      const loaded = await coordinator.load(id)
      expect(loaded.session.events.map((e) => e.type)).toEqual(["subagent/start", "subagent/end"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
