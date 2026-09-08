// M53 T1 (research G1): `rewind/point` must be registered with the load gate.
// A durable session that had a rewind applied carries the marker in its jsonl;
// pre-fix guardIgnorable throws SessionFormatUnsupportedError for it, so the
// session cannot be loaded after a restart (TUI resume / CLI headless /
// --attach / session-history / fork all fail). Probe D (M52 research) pins the
// exact shapes asserted here.
import { describe, expect, it } from "vitest"
import { append, createSession, rewindCuts } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("rewind/point persistence (M53 G1)", () => {
  it("round-trips through jsonl: load() and loadOwned() keep the marker and rewindCuts resolves the cut", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-rewind-event-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
    try {
      const { id } = await coordinator.create({})
      // Build the log through core-session so every event carries its seq
      // (loadOwned enforces seq === index).
      const log = createSession()
      append(log, { type: "turn/start" })
      append(log, { type: "user/message", text: "turn one" })
      append(log, { type: "assistant/message", text: "did turn one" })
      append(log, { type: "turn/end" })
      // The rewind marker: anchorSeq 1 → the cut hides seqs [1, 4).
      append(log, { type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: 1, mode: "all", fileOps: [] })
      coordinator.enqueue(id, log.events)
      await coordinator.flush(id)
      await coordinator.close()

      // Fresh coordinator over the same dir = the restart path.
      const reopened = createSessionCoordinator(createJsonlBackend(dir), {})
      try {
        const loaded = await reopened.load(id)
        expect(loaded.session.events.map((e) => e.type)).toEqual([
          "turn/start", "user/message", "assistant/message", "turn/end", "rewind/point",
        ])
        expect(rewindCuts(loaded.session)).toEqual([{ cutFrom: 1, markerSeq: 4 }])

        const owned = await reopened.loadOwned(id)
        expect(owned.session.events.map((e) => e.type)).toEqual([
          "turn/start", "user/message", "assistant/message", "turn/end", "rewind/point",
        ])
        // the strict seq === index invariant still holds with the marker kept
        expect(owned.session.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4])
        expect(rewindCuts(owned.session)).toEqual([{ cutFrom: 1, markerSeq: 4 }])
      } finally {
        await reopened.close()
      }
    } finally {
      await coordinator.close().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
