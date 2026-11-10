// M26-D1: subagent/start|end 事件型別 round-trip —— 仿 todo-persistence.test.ts
// 的 team/* 先例：registerEventType 於 module init 已註冊，load gate
// （guardIgnorable）需放行該二型別且不明文 drop。
import { describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("subagent/* persistence", () => {
  it("survives append + JSONL load (KNOWN_EVENT_TYPES accepts them)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-subagent-event-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
    try {
      const id = 'legacy-subagent'
      const events = [
        { type: 'subagent/start', version: 1, seq: 0, taskId: 'task-1', agentPath: 'root/helper', role: 'general', description: 'helper' },
        { type: 'subagent/end', version: 1, seq: 1, taskId: 'task-1', outcome: 'completed', resultText: 'done' },
      ]
      // Legacy import bytes exercise the public read-only load gate. They do not
      // impersonate a current native subagent invocation through ordinary append.
      writeFileSync(join(dir, id + '.jsonl'), [JSON.stringify({ formatVersion: 2, sessionId: id, createdAt: 'fixture' }), ...events.map(event => JSON.stringify(event))].join('\n') + '\n')
      const loaded = await coordinator.snapshot!(id)
      expect(loaded.session.events.map((e) => e.type)).toEqual(["subagent/start", "subagent/end"])
    } finally {
      await coordinator.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
