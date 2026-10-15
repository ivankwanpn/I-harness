import { describe, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { append, createSession, Inbox } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgentRegistry, type Agent } from "@i-harness/core-agent"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { registerExec } from "@i-harness/exec"
import { createWorkflowExecutor, createWorkflowJobStore, type WorkflowDefinition } from "@i-harness/workflow"
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"
import { createAgentTable } from "../src/agent-table.ts"
import { createSubagentTools, driveFollowups } from "../src/tools.ts"
import { createTaskRegistry } from "../src/task-protocol.ts"
import { createNotificationDrain } from "../src/task-notification.ts"
import { registerSubagent } from "../src/index.ts"

/** The seam is required; no role in this suite carries a model, so this
 * resolver is never reached — the cases that exercise a role's model supply
 * their own. */
const noRoleModel = async () => ({ status: "unconfigured" as const, reason: "unused" })

function setup() {
  const ctx = createContext()
  const parentReg = createToolRegistry(ctx)
  parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
  const session = createSession()
  const jobs = createJobRegistry()
  const table = createAgentTable()
  const roles = createRoleRegistry()
  for (const r of builtinRoles()) roles.register(r)
  const resolveModel = noRoleModel
  const exec = registerExec(createContext())
  const model = createMockClient([{ role: "assistant", text: "child done" }])
  const tasks = createTaskRegistry()
  const tools = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks })
  return { ctx, parentReg, session, jobs, table, roles, resolveModel, model, exec, tools, tasks }
}

describe("subagent tools", () => {
  it.each(["wait_agent", "get_task_output", "job_output"])("%s abort removes only the observation and code consumers keep awaiting real settlement", async name => {
    vi.useFakeTimers()
    const { tools, table, jobs, tasks, session } = setup()
    const entry = { path: "root/held", status: "running" as const, session: createSession(), controller: new AbortController(), mailbox: [] }
    table.add(entry.path, entry)
    const task = tasks.submit({ identity: { parentSessionId: "p" }, agentPath: entry.path, description: "held", prompt: "go", agent: "general", delivery: "tool" })
    const job = jobs.registerJob("root", "subagent", "held")
    const args = name === "wait_agent" ? { target: entry.path } : name === "get_task_output" ? { task_ids: [task.id], wait: true } : { job_id: job.id, wait: true }
    const tool = tools.find(t => t.name === name)!, controller = new AbortController()
    try {
      const observing = tool.execute(args, { session, abortSignal: controller.signal })
      const rejection = expect(observing).rejects.toThrow("observer stopped")
      controller.abort(new Error("observer stopped"))
      await rejection
      expect(vi.getTimerCount()).toBe(0)
      expect(entry.controller.signal.aborted).toBe(false)
      expect(jobs.read(job.id).status).toBe("running")
      expect(tasks.get(task.id)!.outcome).toBeUndefined()
      let settled = false
      const nested = tool.execute(args, { session, resultConsumer: "code" }).then(out => { settled = true; return out })
      new Inbox(session).admit({ inputId: "steer", text: "refocus", intent: "user", delivery: "steer" })
      await Promise.resolve(); expect(settled).toBe(false)
      table.update(entry.path, entry, { status: "waiting", finalText: "actual" })
      tasks.terminalize({ taskId: task.id, outcome: "completed", resultText: "actual" })
      jobs.updateJob(job.id, { status: "completed", output: "actual" })
      expect(await nested).not.toHaveProperty("yielded")
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it("multi-task observation uses one overall deadline and cleans partial subscription failure", async () => {
    vi.useFakeTimers()
    const { tools, tasks, session } = setup()
    const ids = [1, 2].map(n => tasks.submit({ identity: { parentSessionId: "p", callEventSeq: n }, agentPath: `root/${n}`, description: "held", prompt: "go", agent: "general", delivery: "tool" }).id)
    const tool = tools.find(t => t.name === "get_task_output")!
    try {
      const observing = tool.execute({ task_ids: ids, wait: true, timeout_ms: 1000 }, { session })
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(900)
      tasks.terminalize({ taskId: ids[0]!, outcome: "completed" })
      await vi.advanceTimersByTimeAsync(100)
      const out = await observing as { tasks: { task_id: string; outcome?: string }[] }
      expect(out.tasks.map(t => t.task_id)).toEqual(ids)
      expect(out.tasks[1]!.outcome).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
      const off = vi.fn(), original = tasks.subscribe.bind(tasks)
      vi.spyOn(tasks, "subscribe").mockImplementation((id, listener) => {
        if (id === ids[1]) throw new Error("subscription failure")
        const unsubscribe = original(id, listener)
        return () => { unsubscribe(); off() }
      })
      await expect(tool.execute({ task_ids: ids, wait: true }, { session })).rejects.toThrow("subscription failure")
      expect(off).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it("all-agent wait includes children added while waiting and target wait observes followup lifecycle", async () => {
    const { tools, table, tasks, session } = setup(), wait = tools.find(t => t.name === "wait_agent")!
    const entry = { path: "root/held", status: "running" as const, session: createSession(), controller: new AbortController(), mailbox: [] }
    const task = tasks.submit({ identity: { parentSessionId: "p" }, agentPath: entry.path, description: "old", prompt: "go", agent: "general", delivery: "tool" })
    tasks.terminalize({ taskId: task.id, outcome: "completed", resultText: "initial" })
    table.add(entry.path, entry)
    let settled = false
    const all = wait.execute({}, { session }).then(out => { settled = true; return out })
    const target = wait.execute({ target: entry.path }, { session })
    const newer = { ...entry, path: "root/new" }; table.add(newer.path, newer)
    table.update(entry.path, entry, { status: "waiting", finalText: "followup" })
    expect(await target).toMatchObject({ finalText: "followup", timed_out: false })
    expect(settled).toBe(false)
    table.update(newer.path, newer, { status: "waiting" })
    expect(await all).toMatchObject({ timed_out: false })
  })

  it("job observation latches completion even if the job reopens before rendering", async () => {
    const { tools, jobs, session } = setup(), job = jobs.registerJob("root", "subagent", "held")
    const observing = tools.find(t => t.name === "job_output")!.execute({ job_id: job.id, wait: true }, { session })
    jobs.updateJob(job.id, { status: "completed", output: "first" })
    jobs.updateJob(job.id, { status: "running", output: "second" })
    expect(await observing).toEqual({ status: "running", text: "second\n[status: running]" })
  })

  it.each([true, false])("wait_agent target=%s renders a reopened lifecycle without inventing a timeout", async target => {
    const { tools, table, session } = setup()
    const entry = { path: "root/held", status: "running" as const, session: createSession(), controller: new AbortController(), mailbox: [] }
    table.add(entry.path, entry)
    const observing = tools.find(t => t.name === "wait_agent")!.execute(target ? { target: entry.path } : {}, { session })
    table.update(entry.path, entry, { status: "waiting", finalText: "initial" })
    table.update(entry.path, entry, { status: "running", finalText: undefined })
    const out = await observing as { message: string }
    expect(out).toMatchObject({ timed_out: false })
    expect(out).not.toHaveProperty("yielded")
    expect(out.message).not.toMatch(/timed out|settled/)
    expect(out.message).toMatch(/running/)
  })
  it.each([true, false])("user steer releases wait_agent target=%s without aborting its child", async target => {
    const { tools, table, session } = setup()
    const entry = { path: "root/held", status: "running" as const, session: createSession(), sessionId: "original-session", jobId: "original-job", controller: new AbortController(), mailbox: [] }
    table.add(entry.path, entry)
    const wait = tools.find(t => t.name === "wait_agent")!
    const observation = wait.execute({ ...(target ? { target: entry.path } : {}), timeout_ms: 100 }, { session })
    new Inbox(session).admit({ inputId: "steer", text: "refocus", intent: "user", delivery: "steer" })
    expect(await observation).toMatchObject({ yielded: true, yield_reason: "user-steer", timed_out: false })
    expect(entry.controller.signal.aborted).toBe(false)
    new Inbox(session).claimAtStepBoundary()
    table.update(entry.path, entry, { status: "waiting", finalText: "real result" })
    expect(await wait.execute({ target: entry.path }, { session })).toMatchObject({ status: "waiting", finalText: "real result", timed_out: false })
  })

  it("target replacement yields the original identity instead of a false timeout", async () => {
    const { tools, table, session } = setup()
    const entry = { path: "root/held", status: "running" as const, session: createSession(), sessionId: "original-session", jobId: "original-job", controller: new AbortController(), mailbox: [] }
    table.add(entry.path, entry)
    const observation = tools.find(t => t.name === "wait_agent")!.execute({ target: entry.path, timeout_ms: 100 }, { session })
    table.add(entry.path, { ...entry, sessionId: "replacement-session" })
    expect(await observation).toMatchObject({ path: entry.path, session_id: "original-session", job_id: "original-job", yielded: true, yield_reason: "target-changed", timed_out: false })
  })

  it.each(["steer", "abort"])("foreground spawn %s releases observation and keeps tool delivery through actual completion", async mode => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, exec } = setup()
    const tasks = createTaskRegistry(), held = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
    const model: ModelClient = { async *stream() { started.resolve(); await held.promise; yield { type: "text/chunk", text: "actual" }; yield { type: "end" } } }
    const tools = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks, foregroundWaitMs: 100 })
    try {
      const controller = new AbortController()
      const observation = tools.find(t => t.name === "spawn_agent")!.execute({ message: "go", task_name: "held", background: false }, { session, abortSignal: controller.signal })
      await started.promise
      let out: { task_id: string }
      if (mode === "abort") {
        const rejection = expect(observation).rejects.toThrow("stop observing")
        controller.abort(new Error("stop observing")); await rejection
        out = { task_id: tasks.list()[0]!.id }
      } else {
        new Inbox(session).admit({ inputId: "steer", text: "refocus", intent: "user", delivery: "steer" })
        out = await observation as { task_id: string }
        expect(out).toMatchObject({ agent_path: "root/held", yielded: true, yield_reason: "user-steer", timed_out: false })
      }
      expect(tasks.get(out.task_id)).toMatchObject({ delivery: "tool" })
      expect(tasks.get(out.task_id)!.outcome).toBeUndefined()
      expect(table.get("root/held")!.controller.signal.aborted).toBe(false)
      held.resolve(); await table.get("root/held")!.followupChain
      expect(tasks.get(out.task_id)).toMatchObject({ outcome: "completed", resultText: "actual", delivery: "tool" })
      expect(tasks.notifications()).toEqual([])
    } finally { held.resolve() }
  })

  it("multi-task steer returns all current snapshots in input order with no continuing wait", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, exec, model } = setup(), tasks = createTaskRegistry()
    const ids = [1, 2].map(n => tasks.submit({ identity: { parentSessionId: "p", callEventSeq: n }, agentPath: `root/${n}`, description: `${n}`, prompt: "go", agent: "general", delivery: "tool" }).id)
    const tools = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks })
    const tool = tools.find(t => t.name === "get_task_output")!
    const observation = tool.execute({ task_ids: ids, wait: true, timeout_ms: 100 }, { session })
    new Inbox(session).admit({ inputId: "steer", text: "refocus", intent: "user", delivery: "steer" })
    const out = await observation as { tasks: { task_id: string }[] }
    expect(out).toMatchObject({ yielded: true, yield_reason: "user-steer" })
    expect(out.tasks.map(t => t.task_id)).toEqual(ids)
    const subscribe = vi.spyOn(tasks, "subscribe")
    await expect(tool.execute({ task_ids: [...ids, "missing"], wait: true }, { session })).rejects.toThrow("unknown task")
    expect(subscribe).not.toHaveBeenCalled()
    for (const taskId of ids) tasks.terminalize({ taskId, outcome: "completed", resultText: "actual" })
    expect(await tool.execute({ task_ids: ids }, { session })).not.toHaveProperty("yielded")
  })

  it.each(["subagent", "exec", "workflow"].flatMap(backend => ["steer", "abort"].map(mode => ({ backend, mode }))))("job_output $mode observes $backend without canceling it", async ({ backend, mode }) => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, exec, model } = setup()
    const listeners = new Set<(view: { status: "running" | "completed"; stdout: string; stderr: string; id: string }) => void>()
    const id = backend === "workflow" ? "workflow-held" : backend === "exec" ? "bash-held" : jobs.registerJob("root", "subagent", "held").id
    const view = { id, status: "running" as "running" | "completed", stdout: "", stderr: "" }
    const read = () => ({ ...view })
    const subscribe = (jobId: string, listener: (v: typeof view) => void) => { expect(jobId).toBe(id); listeners.add(listener); return () => { listeners.delete(listener) } }
    const workflow = { getOutput: read, subscribeJob: subscribe, runWorkflow: vi.fn(), listJobs: () => [], killJob: vi.fn() }
    const tools = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec: { ...exec, getOutput: read, subscribeJob: subscribe }, workflow, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const tool = tools.find(t => t.name === "job_output")!
    const controller = new AbortController()
    const observation = tool.execute({ job_id: id, wait: true, timeout_ms: 100 }, { session, abortSignal: controller.signal })
    if (mode === "abort") {
      const rejection = expect(observation).rejects.toThrow("stop observing")
      controller.abort(new Error("stop observing")); await rejection
    } else {
      new Inbox(session).admit({ inputId: "steer", text: "refocus", intent: "user", delivery: "steer" })
      expect(await observation).toMatchObject({ status: "running", text: "(no output)\n[status: running]", yielded: true, yield_reason: "user-steer" })
    }
    expect(listeners.size).toBe(0)
    expect(workflow.killJob).not.toHaveBeenCalled()
    view.status = "completed"; view.stdout = "actual"
    if (backend === "subagent") jobs.updateJob(id, { status: "completed", output: "actual" })
    expect(await tool.execute({ job_id: id }, { session })).toMatchObject({ status: "completed", text: "actual\n[status: completed]" })
  })
  it("close publishes admission barrier and preserves an entry replaced during drain", async () => {
    const { tools, table } = setup(), release = Promise.withResolvers<void>()
    const original = { path: "root/c", status: "running" as const, session: createSession(), controller: new AbortController(), mailbox: [], dispose: () => release.promise }
    table.add(original.path, original)
    const seen: unknown[] = []
    table.subscribe(change => seen.push({ kind: change.kind, closing: change.entry.closing }))
    const closing = tools.find(t => t.name === "close_agent")!.execute({ target: original.path }, {})
    const replacement = { ...original, controller: new AbortController() }
    try {
      expect(seen).toEqual([{ kind: "update", closing: true }])
      table.add(original.path, replacement)
      release.resolve(); await closing
      expect(table.get(original.path)).toBe(replacement)
      expect(replacement.controller.signal.aborted).toBe(false)
    } finally { release.resolve(); await closing }
  })
  it("publishes spawn settlement and protects a replacement from late settlement and disposal", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, exec } = setup()
    const release = Promise.withResolvers<void>()
    const model: ModelClient = { async *stream() { await release.promise; yield { type: "text/chunk", text: "done" }; yield { type: "end" } } }
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const seen: unknown[] = []
    table.subscribe(change => seen.push({ kind: change.kind, status: change.entry.status, text: change.entry.finalText }))
    try {
      await all.find(t => t.name === "spawn_agent")!.execute({ message: "go", task_name: "helper" }, {})
      const original = table.get("root/helper")!
      const replacement = { ...original, controller: new AbortController(), session: createSession(), finalText: "replacement" }
      table.add(original.path, replacement)
      release.resolve()
      await original.followupChain
      expect(table.get(original.path)).toBe(replacement)
      expect(replacement).toMatchObject({ status: "running", finalText: "replacement" })
      await original.dispose!()
      expect(replacement.controller.signal.aborted).toBe(false)
      expect(replacement.closing).toBeUndefined()
      expect(seen).toHaveLength(2)
    } finally { release.resolve() }
  })

  it("publishes complete followup lifecycle patches and clears previous output at start", async () => {
    const { table, jobs } = setup(), agents = createAgentRegistry()
    const release = Promise.withResolvers<{ finalText: string; turns: number; reasoning: never[] }>()
    agents.register("child", { run: async () => ({ finalText: "", turns: 0, reasoning: [] }), followup: () => release.promise })
    const entry = { path: "root/c", status: "waiting" as const, session: createSession(), controller: new AbortController(), mailbox: [], finalText: "old", error: "old error" }
    table.add(entry.path, entry)
    append(entry.session, { type: "subagent/inbox", message: "next", messageId: "next-1" })
    const seen: unknown[] = []
    table.subscribe(change => seen.push({ status: change.entry.status, finalText: change.entry.finalText, error: change.entry.error, startedAt: change.entry.startedAt, controller: change.entry.controller }))
    const previousController = entry.controller
    const waiting = driveFollowups({ table, jobs, agents }, entry, "child")
    try {
      await Promise.resolve()
      expect(seen[0]).toMatchObject({ status: "running", finalText: undefined, error: undefined, startedAt: expect.any(Number) })
      expect(entry.controller).not.toBe(previousController)
      release.resolve({ finalText: "new", turns: 1, reasoning: [] })
      await waiting
      expect(seen[1]).toMatchObject({ status: "waiting", finalText: "new", error: undefined })
      expect(seen).toHaveLength(2)
    } finally { release.resolve({ finalText: "cleanup", turns: 1, reasoning: [] }); await waiting }
  })
  it("registers spawn_agent, wait_agent, list_agents", () => {
    const { tools } = setup()
    const names = tools.map((t) => t.name).sort()
    expect(names).toContain("spawn_agent")
    expect(names).toContain("wait_agent")
    expect(names).toContain("list_agents")
  })

  it("spawn_agent returns a job id; list_agents shows it; wait_agent observes completion", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const list = all.find((t) => t.name === "list_agents")!
    const wait = all.find((t) => t.name === "wait_agent")!
    const changes: unknown[] = []
    table.subscribe(change => changes.push({ kind: change.kind, status: change.entry.status, finalText: change.entry.finalText }))
    const spawnOut = await spawn.execute({ message: "do it", task_name: "helper" }, {})
    expect((spawnOut as { job_id: string }).job_id).toMatch(/^subagent-\d+$/)
    expect((spawnOut as { agent_path: string }).agent_path).toBe("root/helper")
    const listed = await list.execute({ path_prefix: "root/" }, {})
    expect((listed as { agents: { path: string }[] }).agents.map((a) => a.path)).toEqual(["root/helper"])
    const waitOut = await wait.execute({ timeout_ms: 5000 }, {})
    expect((waitOut as { timed_out: boolean }).timed_out).toBe(false)
    expect(changes).toEqual([{ kind: "add", status: "running", finalText: undefined }, { kind: "update", status: "waiting", finalText: "child done" }])
  }, 10_000)

  it("spawn_agent with unknown agent_type errors", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    await expect(spawn.execute({ message: "x", task_name: "h", agent_type: "nope" }, {})).rejects.toThrow(/unknown role/i)
  })
})

describe("subagent control tools", () => {
  it("send_message queues into the child mailbox", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const send = all.find((t) => t.name === "send_message")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const out = await send.execute({ target: "root/helper", message: "extra" }, {})
    expect(out).toEqual({ queued: true })
    expect(table.get("root/helper")!.mailbox).toContain("extra")
  }, 10_000)

  it("close_agent aborts and removes the child", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const close = all.find((t) => t.name === "close_agent")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    expect(table.get("root/helper")).toBeDefined()
    const out = await close.execute({ target: "root/helper" }, {})
    expect((out as { previous_status: string }).previous_status).toBe("running")
    expect(table.get("root/helper")).toBeUndefined()
  }, 10_000)

  it("interrupt_agent aborts the controller but keeps the agent", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const interrupt = all.find((t) => t.name === "interrupt_agent")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const entry = table.get("root/helper")!
    const out = await interrupt.execute({ target: "root/helper" }, {})
    expect((out as { previous_status: string }).previous_status).toBe("running")
    expect(table.get("root/helper")).toBeDefined()
    expect(entry.controller.signal.aborted).toBe(true)
  }, 10_000)

  it("resume_agent on a resident waiting child just re-drives the inbox (no rebuild)", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const agents = createAgentRegistry()
    const entrySession = createSession()
    append(entrySession, { type: "subagent/inbox", messageId: "m1", message: "pending" })
    const followup = vi.fn().mockResolvedValue({ finalText: "ok", turns: 1, reasoning: [] })
    const fakeAgent: Agent = { run: vi.fn(), followup }
    agents.register("child-1", fakeAgent)
    table.add("root/helper", {
      path: "root/helper",
      status: "waiting",
      session: entrySession,
      controller: new AbortController(),
      mailbox: [],
      sessionId: "child-1",
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents, tasks: createTaskRegistry() })
    const resume = all.find((t) => t.name === "resume_agent")!
    const entry = table.get("root/helper")!
    const out = await resume.execute({ target: "root/helper" }, {})
    expect(out).toEqual({ resumed: true })
    expect(agents.get("child-1")).toBe(fakeAgent) // unchanged — NOT rebuilt
    await entry.followupChain
    expect(followup).toHaveBeenCalledWith("pending", expect.any(AbortSignal), { provenance: { kind: "inherited", authority: "observation", scope: "turn", producer: "subagent.inbox" } })
    expect(entry.status).toBe("waiting")
    expect(entry.finalText).toBe("ok")
  }, 10_000)

  it("resume_agent rebuilds the child from the loaded session + role", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, exec } = setup()
    const agents = createAgentRegistry()
    // Entry restored by M8's resume-load: loaded durable session, sessionId,
    // roleName, status "error" (running/waiting → error on restore). Registry
    // is empty so resume must rebuild the agent. The snapshot ALSO restores the
    // inbox consumption cursor (lastInboxSeq) marking "pre-consumed" as already
    // followed up — cold resume must NOT re-drain it into a duplicate turn.
    const loadedSession = createSession()
    append(loadedSession, { type: "turn/start" })
    append(loadedSession, { type: "user/message", text: "first task" })
    append(loadedSession, { type: "assistant/message", text: "first answer" })
    append(loadedSession, { type: "turn/end" })
    append(loadedSession, { type: "subagent/inbox", messageId: "in-0", message: "pre-consumed" })
    const consumedSeq = loadedSession.events.length - 1
    append(loadedSession, { type: "subagent/inbox", messageId: "in-1", message: "queued before resume" })
    table.add("root/helper", {
      path: "root/helper",
      status: "error",
      session: loadedSession,
      controller: new AbortController(),
      mailbox: [],
      sessionId: "child-abc",
      roleName: "general",
      lastInboxSeq: consumedSeq,
    })
    const model = createMockClient([
      { role: "assistant", text: "queued handled" },
      { role: "assistant", text: "child done" },
    ])
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents, tasks: createTaskRegistry() })
    const resume = all.find((t) => t.name === "resume_agent")!
    const follow = all.find((t) => t.name === "followup_task")!
    const entry = table.get("root/helper")!
    const out = await resume.execute({ target: "root/helper" }, {})
    expect(out).toEqual({ resumed: true })
    const rebuilt = agents.get("child-abc")
    expect(rebuilt).toBeDefined()
    expect(entry.session).toBe(loadedSession) // rebuilt on the persisted session, not a fresh one
    // Cold resume drains ONLY the unconsumed inbox on the rebuilt agent (turn 1);
    // the cursor-restored "pre-consumed" message must not be re-processed.
    await entry.followupChain
    expect(entry.status).toBe("waiting")
    expect(entry.finalText).toBe("queued handled")
    expect(loadedSession.events.some((e) => e.type === "user/message" && e.text === "queued before resume")).toBe(true)
    expect(loadedSession.events.some((e) => e.type === "user/message" && e.text === "pre-consumed")).toBe(false)
    // The rebuilt agent is retained; a followup_task drives a further turn (turn 2).
    expect(agents.get("child-abc")).toBe(rebuilt)
    await follow.execute({ target: "root/helper", message: "continue" }, {})
    await entry.followupChain
    expect(entry.status).toBe("waiting")
    expect(entry.finalText).toBe("child done")
    expect(loadedSession.events.some((e) => e.type === "user/message" && e.text === "continue")).toBe(true)
  }, 10_000)

  it("cold resume skips a previously-consumed inbox when the snapshot carries the cursor", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, exec } = setup()
    const agents = createAgentRegistry()
    // Exact M9 e2e bug: the child's durable log still holds the inbox event
    // that was already consumed into a followup turn, and the restored snapshot
    // carries lastInboxSeq marking it consumed. driveFollowups must treat only
    // genuinely-new inbox events as pending — otherwise the child re-processes
    // the old message and appends a duplicate user/message turn.
    const loadedSession = createSession()
    append(loadedSession, { type: "turn/start" })
    append(loadedSession, { type: "user/message", text: "first task" })
    append(loadedSession, { type: "assistant/message", text: "first answer" })
    append(loadedSession, { type: "turn/end" })
    append(loadedSession, { type: "subagent/inbox", messageId: "old-1", message: "already handled" })
    const consumedSeq = loadedSession.events.length - 1
    append(loadedSession, { type: "subagent/inbox", messageId: "new-1", message: "fresh after resume" })
    table.add("root/helper", {
      path: "root/helper",
      status: "error",
      session: loadedSession,
      controller: new AbortController(),
      mailbox: [],
      sessionId: "child-cursor",
      roleName: "general",
      lastInboxSeq: consumedSeq, // restored via restoreState from the snapshot
    })
    const model = createMockClient([{ role: "assistant", text: "handled" }])
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents, tasks: createTaskRegistry() })
    const resume = all.find((t) => t.name === "resume_agent")!
    const entry = table.get("root/helper")!
    await resume.execute({ target: "root/helper" }, {})
    await entry.followupChain
    // Only the unconsumed message became a turn; the consumed one was NOT
    // re-processed into a duplicate user/message.
    const userTexts = loadedSession.events.filter((e) => e.type === "user/message").map((e) => e.text)
    expect(userTexts).toEqual(["first task", "fresh after resume"])
    expect(loadedSession.events.some((e) => e.type === "user/message" && e.text === "already handled")).toBe(false)
    expect(entry.status).toBe("waiting")
    expect(entry.finalText).toBe("handled")
  }, 10_000)

  it("resume_agent on a path with no entry errors", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const resume = all.find((t) => t.name === "resume_agent")!
    await expect(resume.execute({ target: "root/ghost" }, {})).rejects.toThrow(/unknown subagent/)
  })

  it("send_message appends a durable subagent/inbox event to the child session", async () => {
    const spy = vi.fn()
    const entrySession = createSession((ev) => { spy(ev) })
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    table.add("root/helper", {
      path: "root/helper",
      status: "running",
      session: entrySession,
      controller: new AbortController(),
      mailbox: [],
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const send = all.find((t) => t.name === "send_message")!
    const out = await send.execute({ target: "root/helper", message: "ping" }, {})
    expect(out).toEqual({ queued: true })
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: "subagent/inbox", message: "ping" }))
    expect((spy.mock.calls[0]![0] as { messageId: string }).messageId).toBeTruthy()
    expect(table.get("root/helper")?.mailbox).toEqual(["ping"])
  })

  it("followup_task queues, marks delivered, and appends a durable subagent/inbox event", async () => {
    const spy = vi.fn()
    const entrySession = createSession((ev) => { spy(ev) })
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    table.add("root/helper", {
      path: "root/helper",
      status: "running",
      session: entrySession,
      controller: new AbortController(),
      mailbox: [],
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const follow = all.find((t) => t.name === "followup_task")!
    const out = await follow.execute({ target: "root/helper", message: "more" }, {})
    expect((out as { delivered: boolean }).delivered).toBe(true)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: "subagent/inbox", message: "more" }))
    expect((spy.mock.calls[0]![0] as { messageId: string }).messageId).toBeTruthy()
    expect(table.get("root/helper")!.mailbox).toContain("more")
  })

  it("resume_agent refuses to overwrite a running entry", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const resume = all.find((t) => t.name === "resume_agent")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    await expect(resume.execute({ target: "root/helper" }, {})).rejects.toThrow(/already running/i)
  })

  it("followup_task drives a turn on the child (appends inbox + wakes the driver)", async () => {
    const spy = vi.fn()
    const entrySession = createSession((ev) => { spy(ev) })
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const agents = createAgentRegistry()
    const followup = vi.fn().mockResolvedValue({ finalText: "ok2", turns: 2, reasoning: [] })
    const fakeAgent: Agent = { run: vi.fn(), followup }
    agents.register("child-1", fakeAgent)
    const { id: jobId } = jobs.registerJob("root", "subagent", "helper")
    table.add("root/helper", {
      path: "root/helper",
      status: "waiting",
      session: entrySession,
      controller: new AbortController(),
      mailbox: [],
      sessionId: "child-1",
      jobId,
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents, tasks: createTaskRegistry() })
    const follow = all.find((t) => t.name === "followup_task")!
    const entry = table.get("root/helper")!
    const out = await follow.execute({ target: "root/helper", message: "again" }, {})
    expect(out).toEqual({ delivered: true })
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: "subagent/inbox", message: "again" }))
    await entry.followupChain
    expect(followup).toHaveBeenCalledWith("again", expect.any(AbortSignal), { provenance: { kind: "inherited", authority: "observation", scope: "turn", producer: "subagent.followup" } })
    expect(entry.status).toBe("waiting")
    expect(entry.finalText).toBe("ok2")
    expect(jobs.read(jobId).status).toBe("completed")
    expect(jobs.read(jobId).output).toBe("ok2")
  })

  it("interrupt → aborted → a fresh followup succeeds (driver clears stale error)", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const agents = createAgentRegistry()
    const followup = vi.fn().mockResolvedValue({ finalText: "recovered", turns: 2, reasoning: [] })
    const fakeAgent: Agent = { run: vi.fn(), followup }
    agents.register("child-1", fakeAgent)
    const { id: jobId } = jobs.registerJob("root", "subagent", "helper")
    const entrySession = createSession()
    table.add("root/helper", {
      path: "root/helper",
      status: "waiting",
      session: entrySession,
      controller: new AbortController(),
      mailbox: [],
      jobId,
      sessionId: "child-1",
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents, tasks: createTaskRegistry() })
    const follow = all.find((t) => t.name === "followup_task")!
    const entry = table.get("root/helper")!
    // Turn 1 simulates the child's run loop observing an interrupt: the
    // controller was aborted and the run surfaced an AbortError. Turn 2 (the
    // default mock) succeeds.
    followup.mockImplementationOnce(() => {
      entry.controller.abort()
      return Promise.reject(new DOMException("Aborted", "AbortError"))
    })

    // Turn 1: the child's turn is interrupted → entry.error "aborted", job killed.
    await follow.execute({ target: "root/helper", message: "first" }, {})
    await entry.followupChain
    expect(followup).toHaveBeenCalledTimes(1)
    expect(entry.error).toBe("aborted")
    expect(entry.status).toBe("waiting")
    expect(jobs.read(jobId).status).toBe("killed")

    // Hold the retry in flight: list_agents must stop reporting the old turn's
    // error as soon as a new turn begins, not only after it succeeds.
    let finishRetry!: (result: { finalText: string; turns: number; reasoning: string[] }) => void
    followup.mockImplementationOnce(() => new Promise((resolve) => { finishRetry = resolve }))
    await follow.execute({ target: "root/helper", message: "retry" }, {})
    try {
      const listed = await all.find((tool) => tool.name === "list_agents")!.execute({}, {}) as { agents: { status: string; error?: string }[] }
      expect(listed.agents[0]?.status).toBe("running")
      expect(listed.agents[0]?.error).toBeUndefined()
    } finally {
      finishRetry({ finalText: "recovered", turns: 2, reasoning: [] })
    }
    await entry.followupChain
    expect(followup).toHaveBeenCalledTimes(2)
    expect(entry.error).toBeUndefined()
    expect(entry.status).toBe("waiting")
    expect(entry.finalText).toBe("recovered")
    expect(jobs.read(jobId).status).toBe("completed")
    expect(jobs.read(jobId).output).toBe("recovered")
  })

  it("two rapid followups serialize deterministically (second turn waits for the first)", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const agents = createAgentRegistry()
    const calls: string[] = []
    let resolveFirst: ((v: { finalText: string; turns: number; reasoning: string[] }) => void) | undefined
    const firstTurn = new Promise<{ finalText: string; turns: number; reasoning: string[] }>((r) => { resolveFirst = r })
    const followup = vi.fn().mockImplementation((msg: string) => {
      calls.push(msg)
      return calls.length === 1 ? firstTurn : Promise.resolve({ finalText: `ok:${msg}`, turns: 2, reasoning: [] })
    })
    const fakeAgent: Agent = { run: vi.fn(), followup }
    agents.register("child-1", fakeAgent)
    const { id: jobId } = jobs.registerJob("root", "subagent", "helper")
    const entrySession = createSession()
    table.add("root/helper", {
      path: "root/helper",
      status: "waiting",
      session: entrySession,
      controller: new AbortController(),
      mailbox: [],
      jobId,
      sessionId: "child-1",
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents, tasks: createTaskRegistry() })
    const follow = all.find((t) => t.name === "followup_task")!
    const entry = table.get("root/helper")!

    // Two followup_tasks back to back: both queue durably, both wake the driver.
    await follow.execute({ target: "root/helper", message: "one" }, {})
    await follow.execute({ target: "root/helper", message: "two" }, {})
    // Turn 1 is in flight; turn 2 must NOT have started yet (serialized chain).
    expect(calls).toEqual(["one"])
    expect(entry.status).toBe("running")
    expect(jobs.read(jobId).status).toBe("running")

    // Release turn 1 → turn 2 runs to completion, then the chain settles.
    resolveFirst!({ finalText: "ok:one", turns: 1, reasoning: [] })
    await entry.followupChain
    expect(calls).toEqual(["one", "two"])
    expect(entry.status).toBe("waiting")
    expect(entry.finalText).toBe("ok:two")
    expect(jobs.read(jobId).status).toBe("completed")
    expect(jobs.read(jobId).output).toBe("ok:two")
  })

  it("close_agent mid-drain stops the driver (no further followup calls)", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const agents = createAgentRegistry()
    const calls: string[] = []
    let resolveFirst: ((v: { finalText: string; turns: number; reasoning: string[] }) => void) | undefined
    const firstTurn = new Promise<{ finalText: string; turns: number; reasoning: string[] }>((r) => { resolveFirst = r })
    const followup = vi.fn().mockImplementation((msg: string) => {
      calls.push(msg)
      return calls.length === 1 ? firstTurn : Promise.resolve({ finalText: `ok:${msg}`, turns: 2, reasoning: [] })
    })
    const fakeAgent: Agent = { run: vi.fn(), followup }
    agents.register("child-1", fakeAgent)
    const { id: jobId } = jobs.registerJob("root", "subagent", "helper")
    const entrySession = createSession()
    table.add("root/helper", {
      path: "root/helper",
      status: "waiting",
      session: entrySession,
      controller: new AbortController(),
      mailbox: [],
      jobId,
      sessionId: "child-1",
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents, tasks: createTaskRegistry() })
    const follow = all.find((t) => t.name === "followup_task")!
    const close = all.find((t) => t.name === "close_agent")!
    const entry = table.get("root/helper")!

    // Queue TWO pending inbox messages; turn 1 hangs on the deferred promise.
    await follow.execute({ target: "root/helper", message: "one" }, {})
    await follow.execute({ target: "root/helper", message: "two" }, {})
    expect(calls).toEqual(["one"])

    // Close the agent mid-drain (entry removed) while turn 1 is still in flight.
    await close.execute({ target: "root/helper" }, {})
    expect(table.get("root/helper")).toBeUndefined()
    // Release turn 1; the driver must observe the removed entry and stop
    // without ever starting a turn for the second pending message.
    resolveFirst!({ finalText: "ok:one", turns: 1, reasoning: [] })
    await entry.followupChain
    expect(calls).toEqual(["one"])
  })

  it("close_agent unregisters the child agent from the registry", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const agents = createAgentRegistry()
    const fakeAgent: Agent = { run: vi.fn(), followup: vi.fn() }
    agents.register("child-2", fakeAgent)
    table.add("root/helper", {
      path: "root/helper",
      status: "waiting",
      session: createSession(),
      controller: new AbortController(),
      mailbox: [],
      sessionId: "child-2",
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents, tasks: createTaskRegistry() })
    const close = all.find((t) => t.name === "close_agent")!
    expect(agents.get("child-2")).toBeDefined()
    const out = await close.execute({ target: "root/helper" }, {})
    expect((out as { previous_status: string }).previous_status).toBe("waiting")
    expect(table.get("root/helper")).toBeUndefined()
    expect(agents.get("child-2")).toBeUndefined()
  })
})

describe("job tools", () => {
  it("job_output reads a completed job; job_list enumerates it", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const output = all.find((t) => t.name === "job_output")!
    const list = all.find((t) => t.name === "job_list")!
    const spawnOut = await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const jobId = (spawnOut as { job_id: string }).job_id
    await new Promise((r) => setTimeout(r, 150))
    const read = await output.execute({ job_id: jobId }, {})
    const body = read as { text: string; status: string }
    expect(body.text).toContain("[status: completed]")
    const jobsOut = await list.execute({}, {})
    expect((jobsOut as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toContain(jobId)
  }, 10_000)

  it("job_kill cancels a running job", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const kill = all.find((t) => t.name === "job_kill")!
    const spawnOut = await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const jobId = (spawnOut as { job_id: string }).job_id
    const out = await kill.execute({ job_id: jobId }, {})
    expect(["cancellation-requested", "already-finished"]).toContain((out as { outcome: string }).outcome)
  }, 10_000)
})

describe("job tools bridge", () => {
  it("job_output reads an exec/bash background job via the exec bridge", async () => {
    const { exec, jobs, table, roles, parentReg, session, resolveModel, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: createContext(), parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const output = all.find((t) => t.name === "job_output")!
    const { jobId } = await exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>console.log('bg done'), 100)"] })
    expect(jobId).toMatch(/^bash-\d+$/)
    // wait:true exercises the exec-fallback poll-wait path and avoids a fixed sleep.
    const read = await output.execute({ job_id: jobId, wait: true, timeout_ms: 5000 }, {})
    expect((read as { status: string }).status).toBe("completed")
    expect((read as { text: string }).text).toContain("bg done")
    expect((read as { text: string }).text).toContain("[status: completed]")
  }, 10_000)

  it("job_list enumerates both subagent and bash jobs", async () => {
    const { exec, jobs, table, roles, parentReg, session, resolveModel, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: createContext(), parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const list = all.find((t) => t.name === "job_list")!
    const spawnOut = await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const subId = (spawnOut as { job_id: string }).job_id
    const { jobId } = await exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>{}, 50)"] })
    const listed = await list.execute({}, {})
    const ids = (listed as { jobs: { id: string; kind: string }[] }).jobs.map((j) => j.id)
    expect(ids).toContain(subId)
    expect(ids).toContain(jobId)
    const kinds = (listed as { jobs: { kind: string }[] }).jobs.map((j) => j.kind)
    expect(kinds).toContain("subagent")
    expect(kinds).toContain("bash")
  }, 10_000)

  it("job_kill cancels a bash job via the exec bridge", async () => {
    const { exec, jobs, table, roles, parentReg, session, resolveModel, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: createContext(), parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const kill = all.find((t) => t.name === "job_kill")!
    const { jobId } = await exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>{}, 5000)"] })
    const out = await kill.execute({ job_id: jobId }, {})
    expect((out as { outcome: string }).outcome).toBe("cancellation-requested")
  }, 10_000)

  it("close_agent aborts, kills the subagent job, and removes the entry", async () => {
    const { ctx, exec, jobs, table, roles, parentReg, session, resolveModel } = setup()
    // A slow model keeps the child RUNNING so close_agent's kill is observable
    // (a fast mock may already have completed before close runs).
    const slowModel: ModelClient = {
      async *stream() {
        yield { type: "text/chunk", text: "working" }
        await new Promise((r) => setTimeout(r, 500))
        yield { type: "end" }
      },
    }
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: slowModel, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const close = all.find((t) => t.name === "close_agent")!
    const spawnOut = await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const subId = (spawnOut as { job_id: string }).job_id
    expect(table.get("root/helper")).toBeDefined()
    const out = await close.execute({ target: "root/helper" }, {})
    expect((out as { previous_status: string }).previous_status).toBe("running")
    expect(table.get("root/helper")).toBeUndefined()
    expect(jobs.read(subId).status).toBe("killed")
  }, 10_000)
})

// M24b (spec §3.3): the job_* third layer. A `workflow-` prefixed id routes to
// the workflow executor's job store when the host injected one (deps.workflow)
// — additive: without the dep the chain stays subagent → exec (current
// behavior), and a workflow- id then fails visibly as unknown job.
describe("job tools workflow layer (M24b spec §3.3)", () => {
  const finishedDef: WorkflowDefinition = {
    name: "echo-ok",
    description: "One fast step",
    steps: [{ name: "greet", command: `node -e "console.log('wf step ok')"` }],
  }
  const slowDef: WorkflowDefinition = {
    name: "slow",
    description: "One slow step",
    steps: [{ name: "wait", command: `node -e "setTimeout(()=>{}, 30_000)"` }],
  }

  it("job_output routes a workflow-* id to the workflow executor layer", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const workflow = createWorkflowExecutor({ exec, jobs: createWorkflowJobStore() })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), workflow, tasks: createTaskRegistry() })
    const output = all.find((t) => t.name === "job_output")!
    const { jobId } = workflow.runWorkflow(finishedDef)
    expect(jobId).toMatch(/^workflow-\d+$/)
    // wait:true exercises the workflow-layer poll-wait path (mirrors exec).
    const read = await output.execute({ job_id: jobId, wait: true, timeout_ms: 10_000 }, {})
    const body = read as { text: string; status: string }
    expect(body.status).toBe("completed")
    expect(body.text).toContain("wf step ok")
    expect(body.text).toContain("[step 1/1 greet] ok")
    expect(body.text).toContain("[status: completed]")
  }, 15_000)

  it("job_list includes workflow jobs with kind workflow", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const workflow = createWorkflowExecutor({ exec, jobs: createWorkflowJobStore() })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), workflow, tasks: createTaskRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const list = all.find((t) => t.name === "job_list")!
    const spawnOut = await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const subId = (spawnOut as { job_id: string }).job_id
    const { jobId } = workflow.runWorkflow(slowDef)
    const listed = await list.execute({}, {})
    const entries = (listed as { jobs: { id: string; kind: string; status: string }[] }).jobs
    expect(entries.map((j) => j.id)).toContain(subId)
    const wfEntry = entries.find((j) => j.id === jobId)
    expect(wfEntry).toBeDefined()
    expect(wfEntry!.kind).toBe("workflow")
    expect(wfEntry!.status).toBe("running")
  }, 10_000)

  it("job_kill routes a workflow-* id to the workflow executor layer", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const workflow = createWorkflowExecutor({ exec, jobs: createWorkflowJobStore() })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), workflow, tasks: createTaskRegistry() })
    const kill = all.find((t) => t.name === "job_kill")!
    const output = all.find((t) => t.name === "job_output")!
    const { jobId } = workflow.runWorkflow(slowDef)
    const out = await kill.execute({ job_id: jobId }, {})
    expect((out as { outcome: string }).outcome).toBe("cancellation-requested")
    // The kill is observable through job_output: the run ends killed.
    const read = await output.execute({ job_id: jobId }, {})
    expect((read as { status: string }).status).toBe("killed")
  }, 10_000)

  it("without the workflow dep a workflow-* id fails visibly as unknown job (additive safety)", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const output = all.find((t) => t.name === "job_output")!
    await expect(output.execute({ job_id: "workflow-9" }, {})).rejects.toThrow(/unknown job/)
  }, 10_000)
})

// M24a: nested delegation (max_depth guard) + wait_agent target / list_agents
// fields & scope extensions.
describe("M24a nested delegation and wait/list extensions", () => {
  it("spawn_agent rejects when caller depth >= maxDepth", async () => {
    const { ctx, table, jobs, roles, parentReg, resolveModel, model, exec } = setup()
    const session = createSession()
    session.header = { delegationDepth: 1, origin: "subagent" }
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), maxDepth: 1, tasks: createTaskRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    await expect(spawn.execute({ message: "x", task_name: "y" }, {})).rejects.toThrow(/max/)
    expect(table.get("root/y")).toBeUndefined() // nothing was spawned
  })

  it("spawn_agent allows nesting when caller depth < maxDepth (child of depth-1 parent, maxDepth 2)", async () => {
    const { ctx, table, jobs, roles, parentReg, resolveModel, model, exec } = setup()
    const session = createSession()
    session.header = { delegationDepth: 1, origin: "subagent" }
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), maxDepth: 2, tasks: createTaskRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const out = await spawn.execute({ message: "do it", task_name: "helper" }, {})
    expect((out as { agent_path: string }).agent_path).toBe("root/helper")
    expect(table.get("root/helper")).toBeDefined()
  })

  it("wait_agent with target waits for that specific child and returns its summary", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const wait = all.find((t) => t.name === "wait_agent")!
    table.add("root/helper", {
      path: "root/helper",
      status: "running",
      session: createSession(),
      controller: new AbortController(),
      mailbox: [],
      roleName: "researcher",
      jobId: "subagent-1",
      sessionId: "child-1",
    })
    // The child settles shortly after the wait starts.
    setTimeout(() => {
      const e = table.get("root/helper")
      if (e) table.update(e.path, e, { status: "waiting", finalText: "done!" })
    }, 60)
    const out = await wait.execute({ target: "root/helper", timeout_ms: 5000 }, {}) as { path: string; status: string; finalText?: string; timed_out: boolean }
    expect(out.path).toBe("root/helper")
    expect(out.status).toBe("waiting")
    expect(out.finalText).toBe("done!")
    expect(out.timed_out).toBe(false)
  }, 10_000)

  it("wait_agent with target reports an errored child and throws on an unknown target", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const wait = all.find((t) => t.name === "wait_agent")!
    table.add("root/broken", {
      path: "root/broken",
      status: "error",
      session: createSession(),
      controller: new AbortController(),
      mailbox: [],
      error: "boom",
    })
    const out = await wait.execute({ target: "root/broken", timeout_ms: 1000 }, {}) as { path: string; status: string; error?: string; timed_out: boolean }
    expect(out.path).toBe("root/broken")
    expect(out.status).toBe("error")
    expect(out.error).toBe("boom")
    expect(out.timed_out).toBe(false)
    await expect(wait.execute({ target: "root/ghost" }, {})).rejects.toThrow(/unknown subagent/)
  })

  it("wait_agent with target stops early when the target is closed mid-wait (M24a hardening)", async () => {
    const { table, tools } = setup()
    const wait = tools.find((t) => t.name === "wait_agent")!
    table.add("root/worker", {
      path: "root/worker",
      status: "running", // never settles on its own
      session: createSession(),
      controller: new AbortController(),
      mailbox: [],
    })
    // close_agent removes the entry from the table mid-wait (its status object
    // still says "running") — the wait must break out instead of spinning to
    // the (here deliberately huge) deadline.
    setTimeout(() => table.remove("root/worker"), 60)
    const start = Date.now()
    const out = await wait.execute({ target: "root/worker", timeout_ms: 30_000 }, {}) as { path: string; status: string; timed_out: boolean }
    const elapsed = Date.now() - start
    expect(out).toMatchObject({ timed_out: false, yielded: true, yield_reason: "target-changed" })
    expect(elapsed).toBeLessThan(5_000) // hardened: broke out at ~60ms, not 30s
  }, 10_000)

  it("wait_agent clamps the timeout to [100ms, 300000ms]", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const wait = all.find((t) => t.name === "wait_agent")!
    table.add("root/slow", {
      path: "root/slow",
      status: "running", // never settles within the wait
      session: createSession(),
      controller: new AbortController(),
      mailbox: [],
    })
    const start = Date.now()
    const out = await wait.execute({ target: "root/slow", timeout_ms: 10 }, {}) as { timed_out: boolean }
    const elapsed = Date.now() - start
    expect(out.timed_out).toBe(true)
    // timeout_ms 10 is clamped UP to the 100ms floor.
    expect(elapsed).toBeGreaterThanOrEqual(100)
  })

  it("list_agents returns roleName/jobId/sessionId/finalText/error fields when present", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const list = all.find((t) => t.name === "list_agents")!
    table.add("root/helper", {
      path: "root/helper",
      status: "waiting",
      session: createSession(),
      controller: new AbortController(),
      mailbox: [],
      roleName: "researcher",
      jobId: "subagent-7",
      sessionId: "child-abc",
      finalText: "answer",
    })
    table.add("root/broken", {
      path: "root/broken",
      status: "error",
      session: createSession(),
      controller: new AbortController(),
      mailbox: [],
      error: "boom",
    })
    const out = await list.execute({}, {}) as { agents: Record<string, unknown>[] }
    const helper = out.agents.find((a) => a.path === "root/helper")!
    expect(helper).toMatchObject({ status: "waiting", roleName: "researcher", jobId: "subagent-7", sessionId: "child-abc", finalText: "answer" })
    expect(helper).not.toHaveProperty("error")
    const broken = out.agents.find((a) => a.path === "root/broken")!
    expect(broken).toMatchObject({ status: "error", error: "boom" })
    expect(broken).not.toHaveProperty("finalText")
    expect(broken).not.toHaveProperty("roleName")
  })

  it("list_agents scope children/descendants filters the tree (path_prefix kept for compat)", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
    const list = all.find((t) => t.name === "list_agents")!
    const add = (path: string) =>
      table.add(path, { path, status: "waiting", session: createSession(), controller: new AbortController(), mailbox: [] })
    add("root/a")
    add("root/a/b")
    add("root/a/b/c")
    add("root/z")

    // children (default base "root") → direct children only, no grandchildren.
    const kids = await list.execute({ scope: "children" }, {}) as { agents: { path: string }[] }
    expect(kids.agents.map((a) => a.path).sort()).toEqual(["root/a", "root/z"])

    // descendants of root/a → the whole subtree below it.
    const desc = await list.execute({ scope: "descendants", path_prefix: "root/a" }, {}) as { agents: { path: string }[] }
    expect(desc.agents.map((a) => a.path).sort()).toEqual(["root/a/b", "root/a/b/c"])

    // Legacy path_prefix WITHOUT scope keeps the existing startsWith semantics.
    const legacy = await list.execute({ path_prefix: "root/a" }, {}) as { agents: { path: string }[] }
    expect(legacy.agents.map((a) => a.path).sort()).toEqual(["root/a", "root/a/b", "root/a/b/c"])
  })
})

describe("M26-D2 background delivery", () => {
  it("background:false blocks until the task settles and returns the summary", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const tasks = createTaskRegistry()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const out = await spawn.execute({ message: "do it", task_name: "helper", background: false }, { sessionId: "s-main", callEventSeq: 5 })
    expect(out).toMatchObject({ agent_path: "root/helper", task_id: "task-1", status: "completed", outcome: "completed", resultText: "child done" })
    expect(table.get("root/helper")?.status).toBe("waiting")
  }, 15_000)

  // W12: this drives a REAL timeout — the injected bound (50ms) is passed to the
  // real registry's `wait`, which polls to that deadline against a child that is
  // still mid-turn, so the tool returns from the timeout arm and not from a mock.
  // (Without the seam the bound is 300_000, which no test can afford to reach.)
  it("background:false that times out says so — the task is still running, not 'settled'", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, exec } = setup()
    // The child must outlive the 50ms wait: its initial turn streams a chunk and
    // then sleeps well past it, so at the deadline the task is still non-terminal.
    const slowModel: ModelClient = {
      async *stream() {
        yield { type: "text/chunk", text: "working" }
        await new Promise((r) => setTimeout(r, 2_000))
        yield { type: "end" }
      },
    }
    const tasks = createTaskRegistry()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: slowModel, resolveModel, exec, agents: createAgentRegistry(), tasks, foregroundWaitMs: 50 })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const out = await spawn.execute({ message: "do it", task_name: "helper", background: false }, { sessionId: "s-main", callEventSeq: 5 }) as { task_id: string; status?: string; outcome?: string; resultText?: string; timed_out?: boolean; message?: string }
    expect(out.timed_out).toBe(true)
    expect(out.message).toBe("wait timed out for root/helper (still running)")
    expect(out.status).toBe("running")
    // …and it really is still running: no outcome on the durable record, a live
    // table entry, and no summary fields invented for a settlement that has not
    // happened.
    expect(tasks.get(out.task_id)!.outcome).toBeUndefined()
    expect(table.get("root/helper")?.status).toBe("running")
    expect(out.outcome).toBeUndefined()
    expect(out.resultText).toBeUndefined()
  }, 15_000)

  it("terminalize delivers to the parent immediately (drain hooked to onTerminalized)", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
    const session = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const resolveModel = noRoleModel
    const exec = registerExec(createContext())
    // slow child so terminalize happens after spawn returns — ADAPTATION
    // (plan T7 Step 1 test 2): the plan used an instant mock, but its own
    // comment ("slow child") requires terminalize to not race the first
    // assertion; a streaming mock with a sleep makes that deterministic.
    const slowModel: ModelClient = {
      async *stream() {
        yield { type: "text/chunk", text: "late answer" }
        await new Promise((r) => setTimeout(r, 500))
        yield { type: "end" }
      },
    }
    // let-deferred: onTerminalized 只在 terminalize 時執行（那時 drainRef 已賦值）
    let drainRef: { drain: () => Promise<number> } | undefined
    const tasks = createTaskRegistry({ onTerminalized: () => { void drainRef?.drain() } })
    const admits: string[] = []
    drainRef = createNotificationDrain({
      tasks,
      admit: { admit: async (a) => { admits.push(a.text) }, wake: () => {} },
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: slowModel, resolveModel, exec, agents: createAgentRegistry(), tasks })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const out = await spawn.execute({ message: "do it", task_name: "helper" }, { sessionId: "s-main", callEventSeq: 7 }) as { task_id: string }
    expect(admits).toHaveLength(0) // still running (child needs ~500ms)
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !tasks.get(out.task_id)?.outcome) {
      await new Promise((r) => setTimeout(r, 50))
    }
    await new Promise((r) => setTimeout(r, 20))
    expect(admits).toHaveLength(1)
    expect(tasks.notifications()[0]!.status).toBe("woken")
  }, 15_000)

  it("registerSubagent wires the drain (background:true spawn → completion admiss to the parent)", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    const session = createSession()
    const admits: string[] = []
    const mounted = registerSubagent(ctx, parentReg, {
      resolveModel: noRoleModel,
      exec: registerExec(createContext()),
      parentModel: createMockClient([{ role: "assistant", text: "done here" }]),
      parentSession: session,
      parentNotify: { admit: async (a) => { admits.push(a.text) }, wake: () => {} },
    })
    const spawn = parentReg.get("spawn_agent")!
    const taskId = (await spawn.execute({ message: "do it", task_name: "helper" }, { sessionId: "s-main", callEventSeq: 1 }) as { task_id: string }).task_id
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !mounted.tasks.get(taskId)?.outcome) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(mounted.tasks.get(taskId)!.outcome).toBe("completed")
    await new Promise((r) => setTimeout(r, 50))
    expect(admits).toHaveLength(1)
    expect(mounted.tasks.notifications()[0]!.status).toBe("woken")
  }, 15_000)
})

describe("M26-D1 spawn_agent task records", () => {
  it("submit→spawn→claim; returns task_id; terminalize lands in the registry", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const tasks = createTaskRegistry()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const out = await spawn.execute({ message: "do it", task_name: "helper" }, { sessionId: "s-main", callId: "call_1", callEventSeq: 9 })
    expect(out).toMatchObject({ agent_path: "root/helper", task_id: "task-1" })
    expect((out as { job_id: string }).job_id).toMatch(/^subagent-\d+$/)
    expect(tasks.get("task-1")).toMatchObject({ parentSessionId: "s-main", callEventSeq: 9, agentPath: "root/helper" })
    await new Promise((r) => setTimeout(r, 150))
    expect(tasks.get("task-1")!.outcome).toBe("completed")
    expect(tasks.get("task-1")!.resultText).toBe("child done")
    // claim 的狀態轉移已發生（record 現在是 running/terminal 而非 accepted）
    expect(["running", "completed"]).toContain(tasks.get("task-1")!.status)
  }, 15_000)

  it("job_output still reads subagent jobs (unchanged path)", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const tasks = createTaskRegistry()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const jobOut = all.find((t) => t.name === "job_output")!
    const spawned = await spawn.execute({ message: "do it", task_name: "h" }, { sessionId: "s", callEventSeq: 1 }) as { task_id: string; job_id: string }
    await tasks.wait(spawned.task_id, 10_000)
    const out = await jobOut.execute({ job_id: spawned.job_id }, {}) as { status: string }
    expect(out.status).toBe("completed")
  }, 15_000)

  it("exact-retry adopts the existing task (no re-spawn); conflicting reuse throws", async () => {
    const { ctx, table, jobs, roles, parentReg, session, resolveModel, model, exec } = setup()
    const tasks = createTaskRegistry()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, resolveModel, exec, agents: createAgentRegistry(), tasks })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const a = await spawn.execute({ message: "same", task_name: "h" }, { sessionId: "s-main", callEventSeq: 3 }) as { task_id: string }
    const b = await spawn.execute({ message: "same", task_name: "h" }, { sessionId: "s-main", callEventSeq: 3 }) as { task_id: string }
    expect(b.task_id).toBe(a.task_id)
    expect(tasks.list()).toHaveLength(1)
    await expect(spawn.execute({ message: "different", task_name: "h" }, { sessionId: "s-main", callEventSeq: 3 })).rejects.toThrow(/identity conflict/i)
  }, 15_000)
})

// ── W11: `list_agents` reports the elapsed of a running child ────────────────
// Every case here runs on the REAL clock: the child's model turn is held by a
// promise, so the child is genuinely `running` for the duration the case waits,
// and the durations asserted are durations that actually passed. No clock is
// mocked or injected, and the elapsed is never read from a fixture.
describe("W11 elapsed on a running subagent", () => {
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

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  async function waitFor(cond: () => boolean, budgetMs = 5000): Promise<void> {
    const deadline = Date.now() + budgetMs
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("waitFor: condition not met within budget")
      await sleep(5)
    }
  }

  /** tools.test.ts `setup`, with the parent model swapped for a gated one (the
   * child inherits it: no role in this file declares a model). */
  function gatedSetup(model: ModelClient) {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
    const session = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const tools = createSubagentTools({
      table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx,
      parentModel: model, resolveModel: noRoleModel,
      exec: registerExec(createContext()), agents: createAgentRegistry(), tasks: createTaskRegistry(),
    })
    return { table, tools }
  }

  type ListRow = { path: string; status: string; elapsed_ms?: number }

  it("reports elapsed_ms for a running child, from the real clock (two samples, growing)", async () => {
    const gate = deferred()
    const { table, tools } = gatedSetup(gatedClient([gate.promise]))
    const spawn = tools.find((t) => t.name === "spawn_agent")!
    const list = tools.find((t) => t.name === "list_agents")!

    await spawn.execute({ message: "work", task_name: "helper" }, {})
    const first = ((await list.execute({}, {})) as { agents: ListRow[] }).agents
    expect(first).toHaveLength(1)
    expect(first[0]!.path).toBe("root/helper")
    expect(first[0]!.status).toBe("running")
    expect(typeof first[0]!.elapsed_ms).toBe("number")

    await sleep(120) // real time passes; nothing is mocked
    const second = ((await list.execute({}, {})) as { agents: ListRow[] }).agents
    // The second reading is the first plus at least the sleep that really
    // elapsed — which is what "drives real elapsed time" means: a frozen or
    // fabricated stamp would fail this line, not merely a wrong constant.
    expect(second[0]!.elapsed_ms! - first[0]!.elapsed_ms!).toBeGreaterThanOrEqual(100)

    gate.resolve()
    await waitFor(() => table.get("root/helper")!.status !== "running")
  }, 15_000)

  it("a re-driven child's elapsed restarts with the new run", async () => {
    // The STAMP is asserted exactly, not by a duration bound: a stale stamp and
    // a re-stamped one differ by the 500ms planted below, and the assertion
    // compares against an instant the test itself recorded — immune to a loaded
    // machine, unlike an "elapsed should be small" bound.
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    const session = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const agents = createAgentRegistry()
    const followup = vi.fn().mockResolvedValue({ finalText: "again", turns: 1, reasoning: [] })
    agents.register("child-1", { run: vi.fn(), followup } as unknown as Agent)
    const entrySession = createSession()
    append(entrySession, { type: "subagent/inbox", messageId: "m1", message: "again" })
    // The entry as a woken child finds it: settled, with the stamp of the run
    // that ended 500ms ago (spawn-time semantics would have kept that stamp).
    const staleStamp = Date.now() - 500
    table.add("root/helper", {
      path: "root/helper",
      status: "waiting",
      session: entrySession,
      controller: new AbortController(),
      mailbox: [],
      sessionId: "child-1",
      roleName: "general",
      startedAt: staleStamp,
    })
    const tools = createSubagentTools({
      table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx,
      parentModel: createMockClient([{ role: "assistant", text: "unused" }]), resolveModel: noRoleModel,
      exec: registerExec(createContext()), agents, tasks: createTaskRegistry(),
    })
    const follow = tools.find((t) => t.name === "followup_task")!
    const entry = table.get("root/helper")!

    const calledAt = Date.now()
    await follow.execute({ target: "root/helper", message: "again" }, {})
    await entry.followupChain
    expect(followup).toHaveBeenCalledWith("again", expect.any(AbortSignal), { provenance: { kind: "inherited", authority: "observation", scope: "turn", producer: "subagent.followup" } })
    expect(entry.status).toBe("waiting")
    expect(entry.startedAt!).toBeGreaterThanOrEqual(calledAt)
    expect(Date.now() - entry.startedAt!).toBeLessThan(500) // a fresh clock, not the 500ms-old one
  }, 15_000)

  it("omits elapsed_ms once the run has settled — absent, never 0", async () => {
    const gate = deferred()
    const { table, tools } = gatedSetup(gatedClient([gate.promise]))
    const spawn = tools.find((t) => t.name === "spawn_agent")!
    const list = tools.find((t) => t.name === "list_agents")!

    await spawn.execute({ message: "work", task_name: "helper" }, {})
    gate.resolve()
    await waitFor(() => table.get("root/helper")!.status !== "running")
    const row = ((await list.execute({}, {})) as { agents: ListRow[] }).agents[0]!
    expect(row.status).toBe("waiting")
    // A settled child has no run in flight; a stale duration would read as if
    // it did, and 0 would read as "just started".
    expect(row.elapsed_ms).toBeUndefined()
  }, 15_000)
})
