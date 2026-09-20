import { describe, expect, it, vi } from "vitest"
import { createSession, type Session, type SessionEvent } from "@i-harness/core-session"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { createMockClient } from "@i-harness/llm-mock"
import { RUNTIME_CONTEXT_SOURCE_PLUGIN } from "@i-harness/runtime-context"
import { createSessionAssembly } from "../src/assembly.ts"

// W11, end to end, through the REAL assembly — the wiring the unasked path
// depends on cannot be proved from the section's own unit tests: those call the
// getter directly. Here the assembly mounts it, `agent/pre-step` calls it, and
// the snapshot that reaches the session log is the artifact under test.
//
// Timing is real, never mocked: the child's model turn is held by a promise, so
// "the child has been running longer than the threshold" is reached by actually
// waiting, and no assertion depends on a clock the test controls.

type Gate = { promise: Promise<void>; release: () => void }

function gate(): Gate {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function snapshots(session: Session): string[] {
  return session.events
    .filter(
      (e): e is Extract<SessionEvent, { type: "user/message" }> =>
        e.type === "user/message" && e.source?.kind === "plugin" && e.source.plugin === RUNTIME_CONTEXT_SOURCE_PLUGIN,
    )
    .map((e) => e.text)
}

/** A model routed by message content (the shape assembly.test.ts's Task-12
 * fixture uses, for the same reason: the child's first stream call races the
 * parent's continuation, so "who is asking" cannot be a call counter).
 *
 * parent: step 1 spawns a child whose turn blocks; steps 2 and 3 wait real
 * time on it (300ms each) so the child crosses a 100ms threshold while the
 * parent is still working; step 4 releases the child and waits for it to
 * settle; step 5 finishes the run. */
function sectionFixture(childGate: Gate): { model: ModelClient; calls: () => number } {
  let spawned = false
  let waits = 0
  let calls = 0
  const model: ModelClient = {
    async *stream(request: LLMRequest) {
      calls += 1
      const last = request.messages.at(-1)
      const isChild = last?.role === "user" && typeof last.content === "string" && last.content.includes("inspect code")
      if (isChild) {
        await childGate.promise
        yield { type: "text/chunk", text: "child ok" }
        yield { type: "end" }
        return
      }
      if (!spawned) {
        spawned = true
        yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "inspect code", task_name: "helper" } } }
        yield { type: "end" }
        return
      }
      if (waits < 3) {
        waits += 1
        // The third wait releases the child first, so its turn ENDS while the
        // parent is inside the wait — the "an agent that finishes leaves the
        // list" half of the render behaviour, reached without a second run.
        if (waits === 3) childGate.release()
        yield { type: "tool_call", call: { name: "wait_agent", args: { target: "root/helper", timeout_ms: 300 } } }
        yield { type: "end" }
        return
      }
      yield { type: "text/chunk", text: "parent done" }
      yield { type: "end" }
    },
  }
  return { model, calls: () => calls }
}

describe("W11 subagents section through the assembly", () => {
  it("appears once when the child crosses the threshold, survives an unchanged step, and leaves when the run ends", async () => {
    const childGate = gate()
    const { model } = sectionFixture(childGate)
    const session = createSession()
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      session,
      model,
      approveAll: true,
      subagentStaleAfterMs: 100,
    })
    try {
      await assembly.agent.run("spawn a helper")
      const texts = snapshots(session)
      const withSection = texts.filter((t) => t.includes("## subagents"))
      // ONE render for the crossing. The parent takes five steps and two of
      // them (3 and 4) see the child past the threshold with the set unchanged;
      // a section whose text carried the elapsed, or any other per-minute
      // value, would have appended again on the second of those steps.
      expect(withSection).toHaveLength(1)
      expect(withSection[0]).toContain("root/helper")
      expect(withSection[0]).toContain("role general")
      expect(withSection[0]).toContain("100ms")
      // And it LEAVES: the final render (the child settled during the third
      // wait) no longer carries the section, while earlier snapshots do — so
      // this is a change in the section's presence, not a missing render.
      expect(texts.at(-1)).not.toContain("## subagents")
      expect(texts.length).toBeGreaterThan(withSection.length)
    } finally {
      childGate.release()
      await assembly.dispose()
    }
  }, 20_000)

  it("starts no turn: a session left idle past the threshold stays idle", async () => {
    const childGate = gate()
    let spawned = false
    let calls = 0
    const model: ModelClient = {
      async *stream(request: LLMRequest) {
        calls += 1
        const last = request.messages.at(-1)
        if (last?.role === "user" && typeof last.content === "string" && last.content.includes("inspect code")) {
          await childGate.promise
          yield { type: "text/chunk", text: "child ok" }
          yield { type: "end" }
          return
        }
        if (!spawned) {
          spawned = true
          yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "inspect code", task_name: "helper" } } }
          yield { type: "end" }
          return
        }
        yield { type: "text/chunk", text: "parent done" }
        yield { type: "end" }
      },
    }
    const session = createSession()
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      session,
      model,
      approveAll: true,
      subagentStaleAfterMs: 50,
    })
    try {
      await assembly.agent.run("spawn a helper")
      // The child was spawned BEFORE this run returned, so the idle window
      // below is a LOWER BOUND on its age: 400ms of waiting means it has been
      // running at least 8x the 50ms threshold while the session is idle.
      const eventsAfterRun = session.events.length
      const callsAfterRun = calls
      const turnsAfterRun = session.events.filter((e) => e.type === "turn/start").length
      await sleep(400)
      // The measurement, not the argument: an idle session (no turn in flight)
      // gains no event, starts no turn, and asks the model nothing — however
      // far past the threshold the child has run. The section is rendered at
      // `agent/pre-step`, and there is no step without a turn.
      expect(calls).toBe(callsAfterRun)
      expect(session.events.length).toBe(eventsAfterRun)
      expect(session.events.filter((e) => e.type === "turn/start").length).toBe(turnsAfterRun)
      // …and the child really is still running, so the window was not empty.
      expect(assembly.tasks().some((row) => row.id === "root/helper" && row.status === "running")).toBe(true)
    } finally {
      childGate.release()
      await assembly.dispose()
    }
  }, 20_000)

  it("warns when the threshold can never fire or always fires — the two sides of the same defect", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const warningsFor = async (subagentStaleAfterMs: number | undefined): Promise<string[]> => {
      // Per-call, not cumulative: the spy survives all four mounts.
      warn.mockClear()
      const assembly = await createSessionAssembly({
        workspace: process.cwd(),
        model: createMockClient([{ role: "assistant", text: "ok" }]),
        ...(subagentStaleAfterMs !== undefined ? { subagentStaleAfterMs } : {}),
      })
      await assembly.dispose()
      return warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes("subagentStaleAfterMs"))
    }
    try {
      const defaults = await warningsFor(undefined)
      expect(defaults).toEqual([])
      // Fires constantly: every running child is past it the moment it starts.
      const zero = await warningsFor(0)
      expect(zero).toHaveLength(1)
      expect(zero[0]).toContain("not a positive number")
      // Never fires: and its silence is indistinguishable from "nothing to report".
      const infinite = await warningsFor(Number.POSITIVE_INFINITY)
      expect(infinite).toHaveLength(1)
      expect(infinite[0]).toContain("not finite")
      // NaN takes the not-positive arm (`!(x > 0)`), not the finite one: a NaN
      // threshold makes every comparison false, so nothing is ever listed.
      const nan = await warningsFor(Number.NaN)
      expect(nan).toHaveLength(1)
      expect(nan[0]).toContain("not a positive number")
    } finally {
      warn.mockRestore()
    }
  }, 20_000)
})
