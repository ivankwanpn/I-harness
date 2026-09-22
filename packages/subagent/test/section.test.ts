import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { registerExec } from "@i-harness/exec"
import { createAgentRegistry } from "@i-harness/core-agent"
import { createAgentTable } from "../src/agent-table.ts"
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"
import { createStaleSubagentsSection } from "../src/section.ts"
import { createTaskRegistry } from "../src/task-protocol.ts"
import { createSubagentTools } from "../src/tools.ts"

// W11, the unasked path. These cases run on the REAL clock — the child below
// stays `running` because its model's turn is held by a promise, and every
// assertion about "past the threshold" is reached by actually waiting. No
// clock is mocked, and `Date.now()` is never stubbed.
//
// What the render property reduces to here: runtime-context appends a snapshot
// ONLY when the rendered text changes (pinned in
// packages/runtime-context/test/runtime-context.test.ts:14). So a getter whose
// text is byte-identical across time cannot produce a log line, and "this
// section does not render every minute" is exactly "its text does not move
// while the set of stale children is fixed".

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function gatedClient(gates: Promise<void>[]): ModelClient {
  let call = 0
  return {
    async *stream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      const gate = gates[Math.min(call, gates.length - 1)]
      call += 1
      await gate
      yield { type: "text/chunk", text: "child done" }
      yield { type: "end" }
    },
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

async function waitFor(cond: () => boolean, budgetMs = 5000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met within budget")
    await sleep(5)
  }
}

/** The package's own harness (tools.test.ts `setup`), with the model swapped
 * for one whose turns block — so the spawned child is a REAL entry produced by
 * the REAL spawn path (`spawnChild`), sitting in `running` on the real clock. */
function harness(model: ModelClient) {
  const ctx = createContext()
  const parentReg = createToolRegistry(ctx)
  parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
  const session = createSession()
  const table = createAgentTable()
  const jobs = createJobRegistry()
  const roles = createRoleRegistry()
  for (const r of builtinRoles()) roles.register(r)
  const tools = createSubagentTools({
    table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx,
    parentModel: model,
    // No role in these cases carries a model, so this resolver is never reached.
    resolveModel: async () => ({ status: "unconfigured" as const, reason: "unused" }),
    exec: registerExec(createContext()), agents: createAgentRegistry(), tasks: createTaskRegistry(),
  })
  return { table, tools }
}

describe("W11 stale-subagents runtime-context section", () => {
  it("names a child only after REAL time carries it past the threshold, then stops naming it when the run ends", async () => {
    const gate = deferred()
    const { table, tools } = harness(gatedClient([gate.promise]))
    const spawn = tools.find((t) => t.name === "spawn_agent")!
    const section = createStaleSubagentsSection({ table, thresholdMs: 200 })

    await spawn.execute({ message: "work", task_name: "helper" }, {})
    await sleep(60) // a real run in flight, still under the threshold
    expect(section()).toBe("")

    await sleep(220) // real time — the crossing
    const crossed = section()
    expect(crossed).toContain("root/helper")
    expect(crossed).toContain("200ms") // the threshold is rendered (a constant, so it cannot move the text)
    expect(crossed).toContain("role general")
    expect(crossed).toContain("job subagent-1")

    gate.resolve()
    await waitFor(() => table.get("root/helper")!.status !== "running")
    // Leaving: the run ended, so the child is no longer named — and the text is
    // empty rather than a list of zero, which is what lets runtime-context
    // append its cleared marker (that path is pinned in the runtime-context
    // suite; here the getter's own answer is the fact).
    expect(section()).toBe("")
  }, 15_000)

  it("does not move while the set of stale children is fixed (the no-per-minute-tick proof)", async () => {
    const gate = deferred()
    const { table, tools } = harness(gatedClient([gate.promise]))
    const spawn = tools.find((t) => t.name === "spawn_agent")!
    const section = createStaleSubagentsSection({ table, thresholdMs: 120 })
    await spawn.execute({ message: "work", task_name: "helper" }, {})
    await sleep(200) // crossing

    // Five samples over ~400ms of real time — several times the threshold, and
    // long enough that any wall-clock value rendered into the text (an
    // elapsed, a bucket, a formatted duration) would differ between them.
    const samples: string[] = []
    for (let i = 0; i < 5; i += 1) {
      samples.push(section())
      await sleep(80)
    }
    expect(samples[0]).not.toBe("") // the setup is not vacuous: something IS stale
    expect(new Set(samples).size).toBe(1) // byte-identical ⇒ runtime-context appends NOTHING
    gate.resolve()
    await waitFor(() => table.get("root/helper")!.status !== "running")
  }, 15_000)

  it("is a knob: a threshold above the same child's age names nobody", async () => {
    const gate = deferred()
    const { table, tools } = harness(gatedClient([gate.promise]))
    const spawn = tools.find((t) => t.name === "spawn_agent")!
    await spawn.execute({ message: "work", task_name: "helper" }, {})
    await sleep(200)
    expect(createStaleSubagentsSection({ table, thresholdMs: 120 })()).toContain("root/helper")
    // Same entry, same instant, a higher threshold: the section is a function
    // of the knob, which is what makes "fires constantly" a configuration a
    // host can be warned about rather than a constant nobody can move.
    expect(createStaleSubagentsSection({ table, thresholdMs: 60_000 })()).toBe("")
    gate.resolve()
    await waitFor(() => table.get("root/helper")!.status !== "running")
  }, 15_000)

  it("names only the child that crossed, not its younger sibling", async () => {
    const older = deferred()
    const younger = deferred()
    const { table, tools } = harness(gatedClient([older.promise, younger.promise]))
    const spawn = tools.find((t) => t.name === "spawn_agent")!
    const section = createStaleSubagentsSection({ table, thresholdMs: 200 })
    await spawn.execute({ message: "work", task_name: "first" }, {})
    await sleep(260) // first crosses; second does not exist yet
    await spawn.execute({ message: "work", task_name: "second" }, {})
    await sleep(60) // second is 60ms old, first is ~320ms
    const text = section()
    expect(text).toContain("root/first")
    expect(text).not.toContain("root/second")
    older.resolve()
    younger.resolve()
    await waitFor(() => [...table.entries().values()].every((e) => e.status !== "running"))
  }, 15_000)

  it("reports a running child with no start stamp as UNKNOWN — never as healthy, never dropped", async () => {
    // This shape is NOT reachable on a shipped path (both sites that write
    // status "running" — spawnChild and driveFollowups — stamp it). It is
    // reachable by a host that builds AgentTable entries itself, and the arm
    // exists because the alternative is a section that silently omits the
    // child and therefore renders as "no agent needs attention" — a claim this
    // getter cannot make. So the entry is hand-written here; no fake TABLE is
    // involved (it is the real createAgentTable).
    const table = createAgentTable()
    table.add("root/unstamped", {
      path: "root/unstamped",
      status: "running",
      session: createSession(),
      controller: new AbortController(),
      mailbox: [],
    })
    const text = createStaleSubagentsSection({ table, thresholdMs: 1 })()
    expect(text).toContain("root/unstamped")
    expect(text).toContain("unknown")
    expect(text).not.toContain("Call list_agents") // no stale group at all: the two arms are independent
  })

  it("agrees with list_agents: a child the section names reports elapsed_ms >= the threshold", async () => {
    const gate = deferred()
    const { table, tools } = harness(gatedClient([gate.promise]))
    const spawn = tools.find((t) => t.name === "spawn_agent")!
    const list = tools.find((t) => t.name === "list_agents")!
    await spawn.execute({ message: "work", task_name: "helper" }, {})
    await sleep(200)
    expect(createStaleSubagentsSection({ table, thresholdMs: 120 })()).toContain("root/helper")
    // The two paths read ONE function (`runningElapsedMs`), so the asked path
    // cannot contradict the unasked one. This is the invariant that would break
    // first if a future change gave one of them its own clock.
    const row = ((await list.execute({}, {})) as { agents: { elapsed_ms?: number }[] }).agents[0]!
    expect(row.elapsed_ms).toBeGreaterThanOrEqual(120)
    gate.resolve()
    await waitFor(() => table.get("root/helper")!.status !== "running")
  }, 15_000)
})
