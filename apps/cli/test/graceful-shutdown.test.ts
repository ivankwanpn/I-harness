import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { failureReport, runHeadless } from "../src/run.ts"

// M3, deliverable 2: **fail-loud crash handling and graceful shutdown.**
//
// The gap was MEASURED, not assumed: `runHeadless` had no signal handling at all
// (`grep -n "SIGINT\|process.on" apps/cli/src/run.ts` → nothing), while `sdk` and
// `acp` both had a `teardown()` wired to SIGINT/SIGTERM. Its session's onAppend
// hands every event to `coordinator.enqueue` and flushes only on `turn/end`, so an
// interrupt mid-turn skipped the `finally` entirely — no dispose, no
// `coordinator.close()`, and therefore no drain of the write-behind's pending
// batch. **The process died, and the machinery that makes events durable was
// never reached.**
//
// The fix is a WIRE, not new machinery: `agent.run(task, signal?)` already exists
// and already throws `agent aborted` on an aborted signal (core-agent:192,246),
// and the run's own `catch` already calls `coordinator.close()`, which drains.
// Nothing could abort it.
//
// THREE assertions, because they catch three different failures:
//   1. the signal is HONOURED        — an unwired signal would let the run finish
//   2. the handlers are INSTALLED    — an unwired process would be killed outright
//   3. the handlers are REMOVED      — a leak accumulates one pair per run

describe("graceful shutdown — an interrupted run unwinds instead of being killed", () => {
  let root: string

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "i-harness-shutdown-")) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** A model that emits one delta and then waits on a gate the TEST owns, so the
   * run is deterministically mid-turn when the signal fires. `release` is called
   * either way: if the abort was honoured it changes nothing, and if it was NOT
   * honoured it lets the run finish — which turns "the fix is missing" into a
   * failing assertion instead of a hanging test. */
  function gatedModel(): { model: ModelClient; release: () => void; started: Promise<void> } {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let markStarted!: () => void
    const started = new Promise<void>((r) => { markStarted = r })
    const model: ModelClient = {
      async *stream(_req: LLMRequest) {
        yield { type: "text/chunk", text: "working" }
        markStarted()
        await gate
        yield { type: "end" }
      },
    }
    return { model, release, started }
  }

  it("an aborted run unwinds (exitCode 1, the abort named) and leaves no signal handlers behind", async () => {
    const sigintBefore = process.listenerCount("SIGINT")
    const sigtermBefore = process.listenerCount("SIGTERM")

    const coordinator = createSessionCoordinator(createJsonlBackend(root))
    const { model, release, started } = gatedModel()
    const controller = new AbortController()

    const running = runHeadless("do the thing", {
      workspace: root,
      sessionId: "s-shutdown",
      coordinator,
      model,
      signal: controller.signal,
    })

    await started
    // (2) INSTALLED while the run is live — the handlers that make a real SIGINT
    //     unwind rather than kill. Before the fix these counts did not move.
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1)
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1)

    controller.abort()
    release()

    const result = await running

    // (1) HONOURED: an unwired signal would have let the gated model finish and
    //     the run report success.
    expect(result.exitCode).toBe(1)
    expect(String(result.error)).toMatch(/abort/i)

    // (3) REMOVED: a run that leaves its handlers behind accumulates one pair per
    //     invocation, and a long-lived host that runs many sessions would reach
    //     Node's listener warning.
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore)
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore)
  }, 30_000)
})

// The other half of "fail-loud crash handling": what the process PRINTS when it
// is about to die from an unhandled error. Today Node prints a bare stack trace
// that names no session, so the reader cannot tell WHICH run broke or HOW MUCH of
// it survived — which is exactly what M3's completion definition asks for ("一次
// 失敗的執行不需要人手讀 JSONL 就能定位").
// M3's diagnose-ability requirement, applied to BOTH ways a run ends badly.
// Measured before building: the CLI printed `console.error(r.error)` for a
// failed run — ONE bare line, no session, no context — while an unhandled error
// got Node's stack trace, also naming no run. They are the same report, so they
// are the same function.
describe("failureReport — a run that ends badly says WHICH run and WHAT survived", () => {
  it("names the session, the error, and what the durable log can and cannot hold", () => {
    const out = failureReport(new Error("kaboom"), { sessionId: "s-shutdown", kind: "failed" })
    expect(out).toContain("s-shutdown")
    expect(out).toContain("kaboom")
    // THE DIAGNOSE-ABILITY PART: the reader learns what is at risk without
    // reading the JSONL. This is the loss contract, and it had never been
    // written down anywhere (backlog §6.2).
    expect(out).toMatch(/flush/i)
    expect(out).toMatch(/tail/i)
  })

  it("distinguishes a CRASH from a FAILED run — they are different operator events", () => {
    expect(failureReport(new Error("x"), { sessionId: "s1", kind: "crashed" })).toMatch(/crash/i)
    expect(failureReport(new Error("x"), { sessionId: "s1", kind: "failed" })).not.toMatch(/crash/i)
  })

  it("says so when the failure preceded any session — never a blank field", () => {
    const out = failureReport("string failure", { kind: "crashed" })
    expect(out).toMatch(/no session|before/i)
    expect(out).toContain("string failure")
  })

  it("takes a non-Error without throwing (a rejection can carry anything)", () => {
    expect(() => failureReport({ code: 7 }, { sessionId: "s1", kind: "failed" })).not.toThrow()
    expect(failureReport(undefined, { sessionId: "s1", kind: "failed" })).toContain("s1")
  })
})
