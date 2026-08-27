// 仿 coordinator.test.ts 的 team event round-trip：registerEventType 於 module
// init 已註冊，load gate（guardIgnorable）需放行 todo/write 且不明文 drop。
import { describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("todo/write persistence", () => {
  it("survives append + JSONL load (KNOWN_EVENT_TYPES accepts it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-todo-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
      const { id } = await coordinator.create({})
      coordinator.enqueue(id, [
        { type: "todo/write", version: 1, items: [{ content: "step 1", status: "pending" }] },
      ])
      await coordinator.flush(id)
      const loaded = await coordinator.load(id)
      expect(loaded.session.events.map((e) => e.type)).toEqual(["todo/write"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
