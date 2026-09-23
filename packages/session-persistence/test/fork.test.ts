import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { append, createSession, deriveMessages, rewindCuts, type SessionEvent } from "@i-harness/core-session"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import {
  createSessionCoordinator,
  forkSession,
  remapSeedEvent,
} from "../src/index.ts"
// Task 2A: `SessionForkUnavailableError` and `completedTurnPrefix` are no longer
// exported through the package entry (their only outside consumer was this
// test); the behavior under test is unchanged, so the assertions below are
// untouched and only the import path moves to the declaring module.
import { SessionForkUnavailableError, completedTurnPrefix } from "../src/fork.ts"

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
  // PRODUCTION ANCHORING: the rewind engine anchors at the hidden turn's FIRST
  // user/message (rewind/src/types.ts:29-31, assembly.ts:320-323 first-wins),
  // and core-agent appends turn/start immediately before it (core-agent
  // index.ts:180-182) — so the raw window excludes the hidden turn's turn/start.
  it("excludes rewind-hidden turns and the rewind marker from the child seed", async () => {
    const { coordinator, cleanup } = await fixture()
    try {
      await coordinator.create({ sessionId: "source", workspaceId: "ws-source" })
      const log = createSession()
      append(log, { type: "turn/start" })                                        // 0
      append(log, { type: "user/message", text: "one" })                          // 1
      append(log, { type: "assistant/message", text: "answer one" })              // 2
      append(log, { type: "turn/end" })                                           // 3
      append(log, { type: "turn/start" })                                         // 4 hidden turn start
      append(log, { type: "user/message", text: "hidden two" })                   // 5 ANCHOR
      append(log, { type: "assistant/message", text: "hidden answer two" })       // 6 hidden
      append(log, { type: "turn/end" })                                           // 7 hidden
      append(log, { type: "rewind/point", version: 1, targetTurn: 2, anchorSeq: 5, mode: "all", fileOps: [] }) // 8
      append(log, { type: "turn/start" })                                         // 9
      append(log, { type: "user/message", text: "three" })                        // 10
      append(log, { type: "assistant/message", text: "answer three" })            // 11
      append(log, { type: "turn/end" })                                           // 12
      await coordinator.append("source", log.events)
      expect(rewindCuts((await coordinator.load("source")).session))
        .toEqual([{ cutFrom: 5, markerSeq: 8 }])

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
      const atHidden = await forkSession(coordinator, "source", { atSeq: 6 })
      expect(atHidden.seedLength).toBe(4)
      expect((await coordinator.load(atHidden.sessionId)).session.events.map((event) => event.seq))
        .toEqual([0, 1, 2, 3])
    } finally {
      await cleanup()
    }
  })

  it("does not leave an orphan turn/start when the hidden turn is the log tail", async () => {
    const { coordinator, cleanup } = await fixture()
    try {
      await coordinator.create({ sessionId: "source" })
      const log = createSession()
      append(log, { type: "turn/start" })                                     // 0
      append(log, { type: "user/message", text: "one" })                       // 1
      append(log, { type: "assistant/message", text: "answer one" })           // 2
      append(log, { type: "turn/end" })                                        // 3
      append(log, { type: "turn/start" })                                      // 4 hidden turn start
      append(log, { type: "user/message", text: "hidden two" })                // 5 ANCHOR
      append(log, { type: "assistant/message", text: "hidden answer two" })    // 6 hidden
      append(log, { type: "turn/end" })                                        // 7 hidden
      append(log, { type: "rewind/point", version: 1, targetTurn: 2, anchorSeq: 5, mode: "all", fileOps: [] }) // 8
      await coordinator.append("source", log.events)

      const result = await forkSession(coordinator, "source")
      expect(result.seedLength).toBe(4)
      const child = (await coordinator.load(result.sessionId)).session
      // No orphan trailing turn/start (which repairTurnTail would close with a
      // synthetic turn/end, rewriting the child's file on the next loadOwned).
      expect(child.events.map((event) => event.type))
        .toEqual(["turn/start", "user/message", "assistant/message", "turn/end"])
      expect(child.events.map((event) => event.seq)).toEqual([0, 1, 2, 3])
      expect((await coordinator.loadOwned(result.sessionId)).session.events
        .map((event) => event.type))
        .toEqual(["turn/start", "user/message", "assistant/message", "turn/end"])
    } finally {
      await cleanup()
    }
  })

  it("keeps compaction markers (shadowing survives) and remaps seq references", () => {
    const events: SessionEvent[] = [
      { type: "turn/start", seq: 0 },
      { type: "user/message", text: "one", seq: 1 },
      { type: "assistant/message", text: "answer one", seq: 2 },
      { type: "turn/end", seq: 3 },
      { type: "turn/start", seq: 4 },                                                   // hidden turn start
      { type: "user/message", text: "hidden two", seq: 5 },                             // ANCHOR
      { type: "compaction/summary", text: "in-window sum", shadowedSeqs: [1], seq: 6 }, // IN-WINDOW: kept
      { type: "assistant/message", text: "hidden answer two", seq: 7 },
      { type: "turn/end", seq: 8 },
      { type: "rewind/point", version: 1, targetTurn: 2, anchorSeq: 5, mode: "all", fileOps: [], seq: 9 },
      { type: "session/title", title: "T", messageSeqs: [1, 5], source: "provider", seq: 10 },
      { type: "compaction/summary", text: "kept sum", shadowedSeqs: [2, 5], seq: 11 },
      { type: "turn/start", seq: 12 },
      { type: "user/message", text: "three", seq: 13 },
      { type: "compaction/reset", removedSeqs: [5, 13], seq: 14 },
      { type: "turn/end", seq: 15 },
    ]
    const prefix = completedTurnPrefix(events, "source", undefined)
    expect(prefix.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(prefix.map((event) => event.type)).toEqual([
      "turn/start", "user/message", "assistant/message", "turn/end",
      "compaction/summary", "session/title", "compaction/summary",
      "turn/start", "user/message", "compaction/reset", "turn/end",
    ])
    // An in-window compaction marker is NOT dropped: its shadow set still
    // covers kept seqs (a rewind never un-shadows compaction's removed seqs).
    expect((prefix[4] as { shadowedSeqs: number[] }).shadowedSeqs).toEqual([1])
    // refs into the dropped region are dropped; refs to kept events shift.
    expect((prefix[5] as { messageSeqs: number[] }).messageSeqs).toEqual([1])
    expect((prefix[6] as { shadowedSeqs: number[] }).shadowedSeqs).toEqual([2])
    expect((prefix[9] as { removedSeqs: number[] }).removedSeqs).toEqual([8])

    // A marker anchored at the turn/start itself (not emitted by the engine,
    // but a valid rewindCuts input) must not extend back into the PREVIOUS
    // turn — both anchor shapes drop the same hidden turn.
    const atTurnStart = events.map((event) =>
      event.type === "rewind/point" ? { ...event, anchorSeq: 4 } : event)
    expect(completedTurnPrefix(atTurnStart, "source", undefined).map((event) => event.seq))
      .toEqual(prefix.map((event) => event.seq))
  })

  // M76 ③: `anchorSeq` names a seq like `shadowedSeqs` does, so the seed pass
  // remaps it through the SAME map. From HERE it never mattered — the session
  // fork DROPS every rewind marker before the remap (:150-152) — but the pass has
  // a second consumer that keeps the marker: the subagent's `forkTurns`
  // (packages/subagent/src/fork.ts:30-42), which seeds a child with the last N
  // turn blocks renumbered into its own coordinates. A carried-over parent anchor
  // names an unrelated child event there, so `rewindCuts` resolves a subset
  // window — or none at all once the stale anchor lands at or past the marker —
  // and the region the rewind hid comes back onto the child's surface.
  //
  // Input shaped like that caller's seed: the last three turn blocks (the slice
  // starts at the turn/start on parent seq 4) plus the seq → index map it builds
  // from the slice. The assertions read POINTERS — walk each seq to the event it
  // names and compare those — never a literal index: `forkTurns: 3` moves every
  // index, so a literal would be an artefact of the fixture.
  it("M76: a seeded rewind marker's anchorSeq is remapped into the child's coordinates", () => {
    type RewindPoint = Extract<SessionEvent, { type: "rewind/point" }>
    const isMarker = (event: SessionEvent): event is RewindPoint => event.type === "rewind/point"
    const atSeq = (events: readonly SessionEvent[], seq: number | undefined): SessionEvent | undefined =>
      events.find((event) => event.seq === seq)
    // What makes an event *that* event: the renumbering rewrites `seq`, so the
    // child's copy is a different OBJECT and type + text are what crosses logs.
    const identityOf = (event: SessionEvent | undefined): string =>
      event === undefined ? "<none>" : `${event.type}${"text" in event ? `:${event.text ?? ""}` : ""}`

    const parent = createSession()
    append(parent, { type: "turn/start" })                                                             // 0
    append(parent, { type: "user/message", text: "turn 1 user" })                                       // 1
    append(parent, { type: "assistant/message", text: "turn 1 answer" })                                // 2
    append(parent, { type: "turn/end" })                                                               // 3
    append(parent, { type: "turn/start" })                                                             // 4 ← the forkTurns slice starts here
    append(parent, { type: "user/message", text: "turn 2 user" })                                       // 5 ← ANCHOR
    append(parent, { type: "assistant/message", text: "turn 2 answer" })                                // 6
    append(parent, { type: "turn/end" })                                                               // 7
    append(parent, { type: "turn/start" })                                                             // 8
    append(parent, { type: "user/message", text: "turn 3 user" })                                       // 9
    append(parent, { type: "assistant/message", text: "turn 3 answer" })                                // 10
    append(parent, { type: "turn/end" })                                                               // 11
    append(parent, { type: "rewind/point", version: 1, targetTurn: 2, anchorSeq: 5, mode: "all", fileOps: [] }) // 12 ← MARKER
    append(parent, { type: "turn/start" })                                                             // 13
    append(parent, { type: "user/message", text: "turn 4 user" })                                       // 14
    append(parent, { type: "assistant/message", text: "turn 4 answer" })                                // 15
    append(parent, { type: "turn/end" })                                                               // 16
    // `append` numbers densely (seq === index): the parent's OWN surface hides
    // the rewound turn 2 and the turn that followed it, and shows turn 4 again.
    expect(rewindCuts(parent)).toEqual([{ cutFrom: 5, markerSeq: 12 }])

    const remapSeedOf = (from: number): SessionEvent[] => {
      const slice = parent.events.slice(from)
      const renumbered = new Map<number, number>()
      for (const [index, event] of slice.entries()) {
        if (event.seq !== undefined) renumbered.set(event.seq, index)
      }
      return slice.map((event, index) => remapSeedEvent(event, index, renumbered))
    }

    const child = remapSeedOf(4)
    const parentMarker = parent.events.find(isMarker)!
    const marker = child.find(isMarker)!
    const anchor = atSeq(parent.events, parentMarker.anchorSeq)!
    // the slice moved every index (were they to coincide, this case would pass
    // with no mapping at all), and the child's anchor names the SAME event
    expect(marker.anchorSeq).not.toBe(parentMarker.anchorSeq)
    expect(identityOf(atSeq(child, marker.anchorSeq))).toBe(identityOf(anchor))
    // the marker's own seq still names the marker itself
    expect(atSeq(child, marker.seq)).toBe(marker)
    // the stale parent coordinate, read in the child, names a DIFFERENT event —
    // which is what makes the identity check above able to fail
    expect(identityOf(atSeq(child, parentMarker.anchorSeq))).not.toBe(identityOf(anchor))

    const childLog = createSession()
    childLog.events.push(...child)
    const cuts = rewindCuts(childLog)
    // the marker is a LIVE window in the child and opens at the anchor it points
    // at: the content the parent's surface hides stays hidden here
    expect(cuts).toHaveLength(1)
    expect(identityOf(atSeq(child, cuts[0]!.cutFrom))).toBe(identityOf(anchor))
    expect(identityOf(atSeq(child, cuts[0]!.markerSeq))).toBe(identityOf(marker))
    const shown = deriveMessages(childLog).map((message) => JSON.stringify(message.content)).join(" ")
    expect(shown).toContain("turn 4 user")
    expect(shown).not.toContain("turn 2 user")
    expect(shown).not.toContain("turn 2 answer")

    // `forkTurns: 2` starts the slice INSIDE the window the marker opened — at
    // turn 3's own turn/start (parent seq 8) — so the anchor event (parent 5) is
    // NOT in the seed and has no child-side target. Everything this child owns
    // before the marker was hidden on the parent's surface, so the window opens
    // on the child's FIRST event rather than on a parent coordinate that names an
    // unrelated child event.
    const child2 = remapSeedOf(8)
    const marker2 = child2.find(isMarker)!
    expect(marker2.anchorSeq).toBe(child2[0]!.seq)
    const childLog2 = createSession()
    childLog2.events.push(...child2)
    expect(rewindCuts(childLog2)).toEqual([{ cutFrom: child2[0]!.seq!, markerSeq: marker2.seq! }])
    const shown2 = deriveMessages(childLog2).map((message) => JSON.stringify(message.content)).join(" ")
    expect(shown2).toContain("turn 4 user")
    expect(shown2).not.toContain("turn 3 user")
  })
})
