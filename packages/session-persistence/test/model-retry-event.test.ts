// v0.1.11: `model/retry` must be registered with the load gate.
//
// THIRD instance of this defect class (`rewind/point` M53 G1, then
// `sandbox/mode` M1 Phase B — see test/rewind-event.test.ts and
// test/sandbox-mode-event.test.ts for the precedents). In both earlier cases
// the latent cause was identical: `guardIgnorable` (packages/session-persistence/
// src/index.ts) refuses any type outside KNOWN_EVENT_TYPES ∪ registered, so the
// moment an event gains a PRODUCTION producer, every session that recorded one
// becomes unloadable:
//
//   SessionFormatUnsupportedError: unknown event type '<type>' without ignorable marker
//
// `sandbox/mode` was explicit about why the class recurs: the event "stayed
// latent only because the event had ZERO production producers". `model/retry`
// has no such excuse — its producer shipped WITH the type, in the same release.
//
// THE PRODUCER: `packages/core-agent/src/index.ts:588` appends a `model/retry`
// event on every model-retry transition, which is precisely what v0.1.11's
// bounded-wait work made reachable (`docs/releases/v0.1.11.md`: the first-response
// and progress deadlines reuse the existing automatic model retry). It is a
// DURABLE event — `append`, not `publishTransient` — so it is written to the
// session log. Its sibling `model/activity` is deliberately transient and
// `packages/core-session/src/index.ts:413` throws if anyone tries to append it
// durably, so the two must NOT be treated symmetrically here: only `model/retry`
// needs registration.
//
// MEASURED CONSEQUENCE BEFORE THIS REGISTRATION (pre-fix, this file): the
// round-trip below throws at load() with
//   unknown event type 'model/retry' without ignorable marker
// which is the SAME failure the child/subagent path reports as
// "unknown event type 'model/retry' without ignorable marker" — a retry inside a
// child session makes that child's log unloadable, so delegation fails. Any
// `--resume`, fork, `session/history` read or restart over a session that ever
// retried fails identically.
//
// NOT `ignorable: true`: load() DROPS ignorable events, which would erase the
// record of the retry a session actually went through. Registering keeps it.
import { describe, expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The producer's real payload shape (`ModelRetryInfo`, core-session:6-16). */
const retry = {
  requestId: "req-1",
  phase: "waiting" as const,
  attempt: 1,
  maxRetries: 5,
  delayMs: 500,
  code: "ETIMEDOUT",
}

describe("model/retry persistence (v0.1.11)", () => {
  it("round-trips through jsonl: load() and loadOwned() keep a recorded retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-model-retry-event-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
    try {
      const { id } = await coordinator.create({})
      // Build the log through core-session so every event carries its seq
      // (loadOwned enforces seq === index).
      const log = createSession()
      // The producer's real position: inside a step, between the provider call
      // and its settlement, in the SAME turn — so it must survive the turn.
      append(log, { type: "turn/start" })
      append(log, { type: "user/message", text: "turn one" })
      append(log, { type: "model/retry", version: 1, ts: 1_700_000_000_000, retry })
      append(log, { type: "assistant/message", text: "recovered" })
      append(log, { type: "turn/end" })
      coordinator.enqueue(id, log.events)
      await coordinator.flush(id)
      await coordinator.close()

      // Fresh coordinator over the same dir = the restart path.
      const reopened = createSessionCoordinator(createJsonlBackend(dir), {})
      try {
        const loaded = await reopened.load(id)
        expect(loaded.session.events.map((e) => e.type)).toEqual([
          "turn/start", "user/message", "model/retry", "assistant/message", "turn/end",
        ])
        // Kept, not dropped: the retry the session went through is still
        // readable after a restart, which is what the diagnostics/usage surface
        // reads back.
        expect(loaded.session.events[2]).toMatchObject({ type: "model/retry", retry })

        const owned = await reopened.loadOwned(id)
        expect(owned.session.events.map((e) => e.type)).toEqual([
          "turn/start", "user/message", "model/retry", "assistant/message", "turn/end",
        ])
        // the strict seq === index invariant still holds with the event kept
        expect(owned.session.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4])
        expect(owned.session.events[2]).toMatchObject({ type: "model/retry", retry })
      } finally {
        await reopened.close()
      }
    } finally {
      await coordinator.close().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not disturb a log that never retried", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-model-retry-absent-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
    try {
      const { id } = await coordinator.create({})
      const log = createSession()
      append(log, { type: "turn/start" })
      append(log, { type: "user/message", text: "turn one" })
      append(log, { type: "assistant/message", text: "no retry here" })
      append(log, { type: "turn/end" })
      coordinator.enqueue(id, log.events)
      await coordinator.flush(id)
      await coordinator.close()

      const reopened = createSessionCoordinator(createJsonlBackend(dir), {})
      try {
        const owned = await reopened.loadOwned(id)
        expect(owned.session.events.some((e) => e.type === "model/retry")).toBe(false)
        expect(owned.session.events.map((e) => e.seq)).toEqual([0, 1, 2, 3])
      } finally {
        await reopened.close()
      }
    } finally {
      await coordinator.close().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
