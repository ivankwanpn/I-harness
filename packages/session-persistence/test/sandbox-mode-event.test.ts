// M1 Phase B (Task 1): `sandbox/mode` must be registered with the load gate.
//
// The defect stayed latent because the event had ZERO production producers: it
// was only ever appended by test code, so no real durable session ever carried
// one. `createSessionAssembly` now appends it at construction whenever the host
// passes a `sandbox` option, and `guardIgnorable` (packages/session-persistence/
// src/index.ts) refuses any type outside its allowlist — so pre-fix the first
// producer made every sandboxed session unloadable. Measured consequence before
// the registration: `apps/cli/test/web.test.ts` (M62 web confinement) failed,
// `GET /api/sessions/:id/events` answering 500
// `SessionFormatUnsupportedError: unknown event type 'sandbox/mode' without
// ignorable marker`; CLI `--resume`, TUI resume, `--attach` and fork would fail
// the same way. Same defect class as `rewind/point` (M53 G1) — see
// `test/rewind-event.test.ts` for that precedent.
import { describe, expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("sandbox/mode persistence (M1 Phase B)", () => {
  it("round-trips through jsonl: load() and loadOwned() keep the mode the assembly recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-sandbox-mode-event-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
    try {
      const { id } = await coordinator.create({})
      // Build the log through core-session so every event carries its seq
      // (loadOwned enforces seq === index).
      const log = createSession()
      // The producer's real position: at CONSTRUCTION, before the first turn.
      append(log, { type: "sandbox/mode", mode: "read-only" })
      append(log, { type: "turn/start" })
      append(log, { type: "user/message", text: "turn one" })
      append(log, { type: "assistant/message", text: "did turn one" })
      append(log, { type: "turn/end" })
      coordinator.enqueue(id, log.events)
      await coordinator.flush(id)
      await coordinator.close()

      // Fresh coordinator over the same dir = the restart path.
      const reopened = createSessionCoordinator(createJsonlBackend(dir), {})
      try {
        const loaded = await reopened.load(id)
        expect(loaded.session.events.map((e) => e.type)).toEqual([
          "sandbox/mode", "turn/start", "user/message", "assistant/message", "turn/end",
        ])
        // Kept, not dropped: the mode the session started under survives the
        // restart, which is what `effectiveSandboxMode` reads on the resume path.
        expect(loaded.session.events[0]).toMatchObject({ type: "sandbox/mode", mode: "read-only" })

        const owned = await reopened.loadOwned(id)
        expect(owned.session.events.map((e) => e.type)).toEqual([
          "sandbox/mode", "turn/start", "user/message", "assistant/message", "turn/end",
        ])
        // the strict seq === index invariant still holds with the event kept
        expect(owned.session.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4])
        expect(owned.session.events[0]).toMatchObject({ type: "sandbox/mode", mode: "read-only" })
      } finally {
        await reopened.close()
      }
    } finally {
      await coordinator.close().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
