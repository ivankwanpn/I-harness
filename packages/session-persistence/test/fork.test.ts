import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { append, createSession, rewindCuts, type SessionEvent } from "@i-harness/core-session"
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
  it("cannot read or copy an outside JSONL artifact through a traversal id", async () => {
    const outer = await mkdtemp(join(tmpdir(), "ih-session-fork-boundary-"))
    const root = join(outer, "store")
    await mkdir(root)
    const outsidePath = join(outer, "secret.jsonl")
    const outside = [
      JSON.stringify({ formatVersion: 1, sessionId: "secret", createdAt: "x" }),
      JSON.stringify({ type: "turn/start", seq: 0 }),
      JSON.stringify({ type: "user/message", text: "outside secret", seq: 1 }),
      JSON.stringify({ type: "turn/end", seq: 2 }),
      "",
    ].join("\n")
    await writeFile(outsidePath, outside, "utf8")
    const coordinator = createSessionCoordinator(createJsonlBackend(root))
    try {
      await expect(forkSession(coordinator, "../secret")).rejects.toThrow(/outside the JSONL store root/)
      expect(await coordinator.list()).toEqual([])
      expect(await readFile(outsidePath, "utf8")).toBe(outside)
    } finally {
      await coordinator.close()
      await rm(outer, { recursive: true, force: true })
    }
  })

  it("creates a child from the latest completed-turn prefix and preserves lineage/title", async () => {
    const { coordinator, cleanup } = await fixture()
    try {
      await coordinator.create({ sessionId: "source", title: "Source title", workspaceId: "ws-source" })
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
        workspaceId: "ws-source",
      })
    } finally {
      await cleanup()
    }
  })

  it("uses the first completed turn whose end reaches atSeq", async () => {
    const { coordinator, cleanup } = await fixture()
    try {
      await coordinator.create({ sessionId: "source", workspaceId: "ws-source" })
      await coordinator.append("source", [
        { type: "turn/start", seq: 0 },
        { type: "user/message", text: "one", seq: 1 },
        { type: "assistant/message", text: "answer one", seq: 2 },
        { type: "turn/end", seq: 3 },
        { type: "turn/start", seq: 4 },
        { type: "turn/end", seq: 5 },
      ])

      const result = await forkSession(coordinator, "source", {
        atSeq: 1,
        title: "Fork title",
        workspaceId: "ws-override",
      })
      expect(result).toMatchObject({ seedLength: 4, title: "Fork title" })
      expect((await coordinator.load(result.sessionId)).session.events).toHaveLength(4)
      expect((await coordinator.profile(result.sessionId)).meta.workspaceId).toBe("ws-override")
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

  // M54 A3 (research G5): a rewind/point marker hides [anchorSeq, markerSeq) on
  // the source's model surface (deriveMessages via rewindCuts). The fork seed
  // must match that surface: pre-fix the prefix copied the hidden turn AND the
  // marker into the child, resurrecting turns the source no longer shows.
  it("excludes rewind-hidden turns and the rewind marker from the child seed", async () => {
    const { coordinator, cleanup } = await fixture()
    try {
      await coordinator.create({ sessionId: "source", workspaceId: "ws-source" })
      const log = createSession()
      append(log, { type: "turn/start" })                                        // 0
      append(log, { type: "user/message", text: "one" })                          // 1
      append(log, { type: "assistant/message", text: "answer one" })              // 2
      append(log, { type: "turn/end" })                                           // 3
      append(log, { type: "turn/start" })                                         // 4 hidden
      append(log, { type: "user/message", text: "hidden two" })                   // 5 hidden
      append(log, { type: "assistant/message", text: "hidden answer two" })       // 6 hidden
      append(log, { type: "turn/end" })                                           // 7 hidden
      append(log, { type: "rewind/point", version: 1, targetTurn: 2, anchorSeq: 4, mode: "all", fileOps: [] }) // 8
      append(log, { type: "turn/start" })                                         // 9
      append(log, { type: "user/message", text: "three" })                        // 10
      append(log, { type: "assistant/message", text: "answer three" })            // 11
      append(log, { type: "turn/end" })                                           // 12
      await coordinator.append("source", log.events)

      const result = await forkSession(coordinator, "source")
      expect(result.seedLength).toBe(8)
      const child = (await coordinator.load(result.sessionId)).session
      expect(child.events.map((event) => event.type)).toEqual([
        "turn/start", "user/message", "assistant/message", "turn/end",
        "turn/start", "user/message", "assistant/message", "turn/end",
      ])
      expect(child.events
        .filter((event) => event.type === "user/message" || event.type === "assistant/message")
        .map((event) => (event as { text: string }).text))
        .toEqual(["one", "answer one", "three", "answer three"])
      // The child is a fresh session: seq === index (loadOwned's invariant) and
      // no phantom rewind cut of its own (the child never had those turns).
      expect(child.events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      expect(rewindCuts(child)).toEqual([])
      const owned = await coordinator.loadOwned(result.sessionId)
      expect(owned.session.events).toHaveLength(8)

      // atSeq inside the hidden turn still resolves to the visible prefix:
      // the boundary is the hidden turn's own end, which the cut then drops.
      const atHidden = await forkSession(coordinator, "source", { atSeq: 5 })
      expect(atHidden.seedLength).toBe(4)
      expect((await coordinator.load(atHidden.sessionId)).session.events.map((event) => event.seq))
        .toEqual([0, 1, 2, 3])
    } finally {
      await cleanup()
    }
  })

  it("renumbers the seed and remaps seq references when a cut drops events", () => {
    const events: SessionEvent[] = [
      { type: "turn/start", seq: 0 },
      { type: "user/message", text: "one", seq: 1 },
      { type: "assistant/message", text: "answer one", seq: 2 },
      { type: "turn/end", seq: 3 },
      { type: "turn/start", seq: 4 },                                    // hidden
      { type: "user/message", text: "hidden two", seq: 5 },              // hidden
      { type: "compaction/summary", text: "sum", shadowedSeqs: [5], seq: 6 }, // hidden
      { type: "turn/end", seq: 7 },                                      // hidden
      { type: "rewind/point", version: 1, targetTurn: 2, anchorSeq: 4, mode: "all", fileOps: [], seq: 8 },
      { type: "session/title", title: "T", messageSeqs: [1, 5], source: "provider", seq: 9 },
      { type: "turn/start", seq: 10 },
      { type: "user/message", text: "three", seq: 11 },
      { type: "compaction/reset", removedSeqs: [5, 11], seq: 12 },
      { type: "turn/end", seq: 13 },
    ]
    const prefix = completedTurnPrefix(events, "source", undefined)
    expect(prefix.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(prefix.map((event) => event.type)).toEqual([
      "turn/start", "user/message", "assistant/message", "turn/end",
      "session/title", "turn/start", "user/message", "compaction/reset", "turn/end",
    ])
    // refs into the dropped region are dropped; refs to kept events shift.
    expect((prefix[4] as { messageSeqs: number[] }).messageSeqs).toEqual([1])
    expect((prefix[7] as { removedSeqs: number[] }).removedSeqs).toEqual([6])
  })
})
