// M49 Task 13 — the truth source for the status line (spec §9.6):
// app/status-source.ts. Fixtures per the plan's Test Fixture Contract:
// scriptedStatusRunner() = condition-controlled runner returning each literal
// string/error in order; context() = literal status context with only fields
// named by the test; collectStatus() = the production builtin aggregator.

import { describe, expect, it } from "vitest"
import {
  collectStatus,
  capStatusText,
  sanitizeStatusText,
  firstNonEmptyLine,
  createCommandStatusSource,
  type StatusCommandContext,
  type StatusRunner,
} from "../src/app/status-source.ts"
import { fitStatusChips } from "../src/views/status.ts"

/** Literal command context — only the fields the tests name. */
function context(): StatusCommandContext {
  return { workspace: "D:/repo" }
}

/** Condition-controlled runner: each call returns the next literal in order
 * (a throw rejects that call; the last item repeats). */
function scriptedStatusRunner(items: Array<string | Error>): StatusRunner {
  let i = 0
  return async () => {
    const item = items[Math.min(i, items.length - 1)]!
    i++
    if (item instanceof Error) throw item
    return item
  }
}

describe("status source — builtin aggregation (Task 13 step 2)", () => {
  it("omits unknown status segments instead of fabricating defaults", async () => {
    const status = await collectStatus({
      workspace: "D:/repo",
      modelState: { status: "unconfigured", reason: "No model configured" },
      context: undefined,
      tasks: undefined,
    })
    expect(status.cwd).toBe("D:/repo")
    expect(status.model).toBeUndefined()
    expect(status.context).toBeUndefined()
    expect(status.tasks).toBeUndefined()
  })

  it("keeps only sourced segments: ready model/context/tasks ride real values", async () => {
    const status = await collectStatus({
      workspace: "D:/repo",
      branch: "m49",
      modelState: { status: "ready", providerId: "mock", modelId: "mock-story", label: "mock:mock-story" },
      context: { used: 8_500, total: 1_000_000 },
      queueState: { running: true, queued: 2 },
      tasks: { running: 1 },
      todo: { done: 2, total: 5 },
      goal: "ship it",
      turnTimerMs: 42_000,
      session: "Beta",
    })
    expect(status).toEqual({
      cwd: "D:/repo",
      branch: "m49",
      model: "mock:mock-story",
      context: { used: 8_500, total: 1_000_000 },
      queue: 2,
      tasks: { running: 1 },
      todo: { done: 2, total: 5 },
      goal: "ship it",
      turnTimerMs: 42_000,
      session: "Beta",
    })
  })
})

describe("status source — text sanitization and bounds (Task 13 step 7)", () => {
  it("takes the first non-empty line, caps at 4096 bytes, and strips control codes", () => {
    const long = "a".repeat(5000)
    const out = firstNonEmptyLine(sanitizeStatusText(`\x1b[31mfirst\x1b[0m\n\nsecond`))
    expect(out).toBe("first")
    expect(capStatusText(long).length).toBeLessThanOrEqual(4096)
    expect(sanitizeStatusText("a\x1b[31mb\x07c")).toBe("abc")
  })

  it("sanitizes and retains a command status through two failures", async () => {
    const runner = scriptedStatusRunner(["ok\x1b[31m\nsecond", new Error("x"), new Error("y"), new Error("z")])
    const source = createCommandStatusSource(runner, { timeoutMs: 1000, refreshMs: 1000 })
    expect(await source.refresh(context())).toBe("ok")
    expect(await source.refresh(context())).toBe("ok")
    expect(await source.refresh(context())).toBe("ok")
    expect(await source.refresh(context())).toContain("status command failed")
  })

  it("every explicit refresh runs the runner (the ≥300ms floor is the CALLER's cadence, not the source's)", async () => {
    let calls = 0
    const runner: StatusRunner = async () => {
      calls++
      return `run-${calls}`
    }
    const source = createCommandStatusSource(runner, { timeoutMs: 1000, refreshMs: 3000 })
    expect(await source.refresh(context())).toBe("run-1")
    expect(await source.refresh(context())).toBe("run-2")
    expect(calls).toBe(2)
  })

  it("an output longer than 4096 bytes is capped before the first-line cut", async () => {
    const runner = scriptedStatusRunner(["x".repeat(5000)])
    const source = createCommandStatusSource(runner, { timeoutMs: 1000, refreshMs: 1000 })
    const out = await source.refresh(context())
    expect(out.length).toBeLessThanOrEqual(4096)
  })
})

describe("status row fit (Task 13 step 7)", () => {
  it("drops whole rightmost low-priority segments before truncating text", () => {
    const chips = fitStatusChips([
      { text: "task", kind: "tasks", sepBefore: false },
      { text: "ctx", kind: "context", sepBefore: true },
      { text: "+1", kind: "queue", sepBefore: true },
      { text: "2/5", kind: "todo", sepBefore: false },
    ], 15)
    // full width = task(4) + sep(3) + ctx(3) + sep(3) + +1(2) + 2/5(3) = 18
    // > 15 → drop the rightmost "2/5" first (whole segment, no truncation).
    expect(chips.map((c) => c.text)).toEqual(["task", "ctx", "+1"])
  })

  it("drops further rightmost segments as the row narrows (text never truncated)", () => {
    const chips = fitStatusChips([
      { text: "task", kind: "tasks", sepBefore: false },
      { text: "ctx", kind: "context", sepBefore: true },
      { text: "+1", kind: "queue", sepBefore: true },
      { text: "2/5", kind: "todo", sepBefore: false },
    ], 5)
    expect(chips.map((c) => c.text)).toEqual(["task"])
  })

  it("keeps every segment when the row fits", () => {
    const chips = fitStatusChips([
      { text: "task", kind: "tasks", sepBefore: false },
      { text: "ctx", kind: "context", sepBefore: true },
    ], 200)
    expect(chips.map((c) => c.text)).toEqual(["task", "ctx"])
  })
})
