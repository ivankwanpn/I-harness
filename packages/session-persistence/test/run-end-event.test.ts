// packages/session-persistence/test/run-end-event.test.ts
// M3 §3.4: `operator/run-end` must be registered with the load gate. A durable
// session carries the record in its jsonl; without the registration
// guardIgnorable throws SessionFormatUnsupportedError and the session cannot be
// loaded after a restart. The trap has shipped twice (rewind/point,
// sandbox/mode), so the shape asserted here is a LOAD ROUND-TRIP.
import { describe, expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("operator/run-end persistence (M3 §3.4)", () => {
  it("round-trips through jsonl: load() keeps the record and its fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-run-end-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
    try {
      const { id } = await coordinator.create({})
      const log = createSession()
      append(log, { type: "turn/start" })
      append(log, { type: "turn/end" })
      append(log, {
        type: "operator/run-end",
        version: 1,
        runId: "run-fixture-1",
        exitCode: 1,
        durationMs: 1234,
        phase: "run",
        error: "the summarizer exploded",
      })
      coordinator.enqueue(id, log.events)
      await coordinator.flush(id)
      await coordinator.close()

      // Fresh coordinator over the same dir = the restart path.
      const reopened = createSessionCoordinator(createJsonlBackend(dir), {})
      try {
        const loaded = await reopened.load(id)
        expect(loaded.session.events.map((e) => e.type)).toEqual([
          "turn/start", "turn/end", "operator/run-end",
        ])
        expect(loaded.session.events.at(-1)).toMatchObject({
          type: "operator/run-end",
          version: 1,
          runId: "run-fixture-1",
          exitCode: 1,
          durationMs: 1234,
          phase: "run",
          error: "the summarizer exploded",
        })
      } finally {
        await reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
