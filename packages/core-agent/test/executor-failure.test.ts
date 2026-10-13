import { describe, expect, it } from "vitest"
import { createSession, Inbox } from "@i-harness/core-session"
import { createSessionExecutor, type SessionExecutorFailure } from "../src/index.ts"

function failingLane(failure: unknown = new Error("turn failed")) {
  const session = createSession(), inbox = new Inbox(session), tasks: string[] = []
  let start!: () => void, fail!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const blocked = new Promise<void>(resolve => { fail = resolve })
  const agent = {
    async run(task: string) {
      tasks.push(task)
      if (tasks.length === 1) {
        start()
        await blocked
        throw failure
      }
      return { finalText: "done", turns: 1, reasoning: [] }
    },
  }
  const executor = createSessionExecutor({ session, agent, inbox })
  return { executor, session, inbox, tasks, started, fail, failure }
}

function admitWaiting(inbox: Inbox) {
  for (const inputId of ["waiting-1", "waiting-2"]) inbox.admit({ inputId, text: inputId, delivery: "queue", intent: "user" })
}

describe("SessionExecutor failed pump", () => {
  // WHY: a durable admission is not another pump; queueing it directly pins
  // the fail-fast pause instead of scheduling a restart with a second submit
  // (packages/core-agent/src/executor.ts:143-145, 176).
  it("keeps remaining inputs after failure and drains them on the next submit", async () => {
    const { executor, inbox, tasks, started, fail, failure } = failingLane()
    const submitted = executor.submit({ tier: "send", text: "fail first" })
    expect(submitted.inputId).toEqual(expect.any(String))
    await started
    admitWaiting(inbox)
    const drained = executor.drain()
    fail()
    await expect(drained).rejects.toBe(failure)
    expect(tasks).toEqual(["fail first"])
    expect(executor.pending().map(input => input.inputId)).toEqual(["waiting-1", "waiting-2"])
    expect(executor.isRunning()).toBe(false)
    expect(executor.currentInput()).toBeUndefined()
    await expect(executor.drain()).rejects.toBe(failure)
    expect(tasks).toEqual(["fail first"])

    executor.submit({ tier: "followup", text: "resume" })
    await expect(executor.drain()).resolves.toBeUndefined()
    expect(tasks).toEqual(["fail first", "waiting-1", "waiting-2", "resume"])
    expect(executor.pending()).toEqual([])
  })

  it("rejects runAdmitted and drain for the failed durable turn without discarding pending inputs", async () => {
    const { executor, inbox, tasks, started, fail, failure } = failingLane()
    inbox.admit({ inputId: "first", text: "fail first", delivery: "queue", intent: "user" })
    const run = executor.runAdmitted("first")
    await started
    admitWaiting(inbox)
    fail()
    await expect(run).rejects.toBe(failure)
    await expect(executor.drain()).rejects.toBe(failure)
    expect(tasks).toEqual(["fail first"])
    expect(executor.pending().map(input => input.inputId)).toEqual(["waiting-1", "waiting-2"])
  })

  it("reports the paused pending count on the existing drain and runAdmitted rejection", async () => {
    for (const mode of ["submit", "runAdmitted"] as const) {
      const { executor, inbox, started, fail, failure } = failingLane()
      let execution: Promise<void>
      if (mode === "submit") {
        executor.submit({ tier: "send", text: "fail first" })
        execution = executor.drain()
      } else {
        inbox.admit({ inputId: "first", text: "fail first", delivery: "queue", intent: "user" })
        execution = executor.runAdmitted("first")
      }
      await started
      admitWaiting(inbox)
      fail()
      await expect(execution).rejects.toBe(failure)
      await expect(execution).rejects.toMatchObject({ pendingCount: 2 })
      await expect(executor.drain()).rejects.toBe(failure)
    }
  })

  it("keeps the failure-time count when pending inputs are subsequently cancelled", async () => {
    const { executor, inbox, started, fail } = failingLane()
    executor.submit({ tier: "send", text: "fail first" })
    await started
    admitWaiting(inbox)
    fail()
    const failure = await executor.drain().catch(error => error) as SessionExecutorFailure
    expect(failure.pendingCount).toBe(2)
    expect(executor.cancel("waiting-1")).toEqual({ cancelled: true })
    expect(executor.pending()).toHaveLength(1)
    await expect(executor.drain()).rejects.toBe(failure)
    expect(failure.pendingCount).toBe(2)
  })

  it("reports zero rather than counting the failed current input or cancelled inputs", async () => {
    const { executor, inbox, started, fail } = failingLane()
    executor.submit({ tier: "send", text: "fail first" })
    await started
    admitWaiting(inbox)
    executor.cancel("waiting-1")
    executor.cancel("waiting-2")
    fail()
    await expect(executor.drain()).rejects.toHaveProperty("pendingCount", 0)
    expect(executor.pending()).toEqual([])
  })

  it("preserves provider error identity and classification without adding enumerable wire fields", async () => {
    class ProviderFailure extends Error { code = "rate_limit" }
    const failure = new ProviderFailure("provider unavailable")
    const serialized = JSON.stringify(failure), keys = Object.keys(failure)
    const { executor, inbox, started, fail } = failingLane(failure)
    executor.submit({ tier: "send", text: "fail first" })
    await started
    admitWaiting(inbox)
    fail()
    const reported = await executor.drain().catch(error => error) as SessionExecutorFailure
    expect(reported).toBe(failure)
    expect(reported).toBeInstanceOf(ProviderFailure)
    expect(reported).toHaveProperty("code", "rate_limit")
    expect(reported.pendingCount).toBe(2)
    expect(JSON.stringify(reported)).toBe(serialized)
    expect(Object.keys(reported)).toEqual(keys)
  })

  it.each([
    ["frozen provider error", Object.freeze(new Error("provider unavailable"))],
    ["non-Error throw", "raw turn failure"],
  ])("retains %s as cause when it cannot carry pending metadata", async (_label, original) => {
    const { executor, inbox, started, fail } = failingLane(original)
    executor.submit({ tier: "send", text: "fail first" })
    await started
    admitWaiting(inbox)
    fail()
    const reported = await executor.drain().catch(error => error) as SessionExecutorFailure
    expect(reported).toBeInstanceOf(Error)
    expect(reported).not.toBe(original)
    expect(reported.cause).toBe(original)
    expect(reported.message).toBe(original instanceof Error ? original.message : original)
    expect(reported.pendingCount).toBe(2)
    expect(Object.keys(reported)).not.toContain("pendingCount")
    await expect(executor.drain()).rejects.toBe(reported)
  })

})
