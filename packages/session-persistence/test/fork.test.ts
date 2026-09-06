import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import {
  SessionForkUnavailableError,
  completedTurnPrefix,
  createSessionCoordinator,
  forkSession,
} from "../src/index.ts"

async function fixture(): Promise<{
  root: string
  coordinator: ReturnType<typeof createSessionCoordinator>
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), "ih-session-fork-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  return {
    root,
    coordinator,
    cleanup: async () => {
      await coordinator.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe("forkSession", () => {
  it("creates a child from the latest completed-turn prefix and preserves lineage/title", async () => {
    const { coordinator, cleanup } = await fixture()
    try {
      await coordinator.create({ sessionId: "source", title: "Source title" })
      await coordinator.append("source", [
        { type: "turn/start", seq: 0 },
        { type: "user/message", text: "one", seq: 1 },
        { type: "assistant/message", text: "answer one", seq: 2 },
        { type: "turn/end", seq: 3 },
        { type: "turn/start", seq: 4 },
        { type: "user/message", text: "two", seq: 5 },
        { type: "assistant/message", text: "answer two", seq: 6 },
        { type: "turn/end", seq: 7 },
      ])

      const result = await forkSession(coordinator, "source")
      expect(result).toMatchObject({ sessionId: expect.any(String), seedLength: 8, title: "Source title" })
      const child = await coordinator.load(result.sessionId)
      expect(child.session.events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      expect((await coordinator.profile(result.sessionId)).meta).toMatchObject({
        parentSession: "source",
        seedLength: 8,
        title: "Source title",
      })
    } finally {
      await cleanup()
    }
  })

  it("uses the first completed turn whose end reaches atSeq", async () => {
    const { coordinator, cleanup } = await fixture()
    try {
      await coordinator.create({ sessionId: "source" })
      await coordinator.append("source", [
        { type: "turn/start", seq: 0 },
        { type: "user/message", text: "one", seq: 1 },
        { type: "assistant/message", text: "answer one", seq: 2 },
        { type: "turn/end", seq: 3 },
        { type: "turn/start", seq: 4 },
        { type: "turn/end", seq: 5 },
      ])

      const result = await forkSession(coordinator, "source", { atSeq: 1, title: "Fork title" })
      expect(result).toMatchObject({ seedLength: 4, title: "Fork title" })
      expect((await coordinator.load(result.sessionId)).session.events).toHaveLength(4)
    } finally {
      await cleanup()
    }
  })

  it("keeps inter-turn events but excludes the next incomplete turn", async () => {
    const prefix = completedTurnPrefix([
      { type: "turn/start", seq: 0 },
      { type: "user/message", text: "one", seq: 1 },
      { type: "turn/end", seq: 2 },
      { type: "command/done", commandId: "c1", kind: "success", seq: 3 },
      { type: "turn/start", seq: 4 },
      { type: "user/message", text: "incomplete", seq: 5 },
    ], "source", undefined)
    expect(prefix.map((event) => event.seq)).toEqual([0, 1, 2, 3])
  })

  it("rejects atSeq inside an incomplete turn", () => {
    expect(() => completedTurnPrefix([
        { type: "turn/start", seq: 0 },
        { type: "user/message", text: "incomplete", seq: 1 },
      ], "source", 1)).toThrow('session "source" has not completed the turn containing event 1')
  })

  it("rejects a source with no completed turn", async () => {
    const { coordinator, cleanup } = await fixture()
    try {
      await coordinator.create({ sessionId: "source" })
      await expect(forkSession(coordinator, "source")).rejects.toBeInstanceOf(SessionForkUnavailableError)
    } finally {
      await cleanup()
    }
  })
})
