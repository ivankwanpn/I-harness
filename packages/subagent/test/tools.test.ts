import { describe, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { append, createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgentRegistry, type Agent } from "@i-harness/core-agent"
import type { ModelClient } from "@i-harness/llm-seam"
import { createProviderRegistry } from "@i-harness/provider"
import { createExecService } from "@i-harness/exec"
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"
import { createAgentTable } from "../src/agent-table.ts"
import { createSubagentTools } from "../src/tools.ts"

function setup() {
  const ctx = createContext()
  const parentReg = createToolRegistry(ctx)
  parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
  const session = createSession()
  const jobs = createJobRegistry()
  const table = createAgentTable()
  const roles = createRoleRegistry()
  for (const r of builtinRoles()) roles.register(r)
  const providers = createProviderRegistry()
  const exec = createExecService()
  const model = createMockClient([{ role: "assistant", text: "child done" }])
  const tools = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry() })
  return { ctx, parentReg, session, jobs, table, roles, providers, model, exec, tools }
}

describe("subagent tools", () => {
  it("registers spawn_agent, wait_agent, list_agents", () => {
    const { tools } = setup()
    const names = tools.map((t) => t.name).sort()
    expect(names).toContain("spawn_agent")
    expect(names).toContain("wait_agent")
    expect(names).toContain("list_agents")
  })

  it("spawn_agent returns a job id; list_agents shows it; wait_agent observes completion", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const list = all.find((t) => t.name === "list_agents")!
    const wait = all.find((t) => t.name === "wait_agent")!
    const spawnOut = await spawn.execute({ message: "do it", task_name: "helper" }, {})
    expect((spawnOut as { job_id: string }).job_id).toMatch(/^subagent-\d+$/)
    expect((spawnOut as { agent_path: string }).agent_path).toBe("root/helper")
    const listed = await list.execute({ path_prefix: "root/" }, {})
    expect((listed as { agents: { path: string }[] }).agents.map((a) => a.path)).toEqual(["root/helper"])
    const waitOut = await wait.execute({ timeout_ms: 5000 }, {})
    expect((waitOut as { timed_out: boolean }).timed_out).toBe(false)
  }, 10_000)

  it("spawn_agent with unknown agent_type errors", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    await expect(spawn.execute({ message: "x", task_name: "h", agent_type: "nope" }, {})).rejects.toThrow(/unknown role/i)
  })
})

describe("subagent control tools", () => {
  it("send_message queues into the child mailbox", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const send = all.find((t) => t.name === "send_message")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const out = await send.execute({ target: "root/helper", message: "extra" }, {})
    expect(out).toEqual({ queued: true })
    expect(table.get("root/helper")!.mailbox).toContain("extra")
  }, 10_000)

  it("close_agent aborts and removes the child", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const close = all.find((t) => t.name === "close_agent")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    expect(table.get("root/helper")).toBeDefined()
    const out = await close.execute({ target: "root/helper" }, {})
    expect((out as { previous_status: string }).previous_status).toBe("running")
    expect(table.get("root/helper")).toBeUndefined()
  }, 10_000)

  it("interrupt_agent aborts the controller but keeps the agent", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry() })
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
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
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
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents })
    const resume = all.find((t) => t.name === "resume_agent")!
    const entry = table.get("root/helper")!
    const out = await resume.execute({ target: "root/helper" }, {})
    expect(out).toEqual({ resumed: true })
    expect(agents.get("child-1")).toBe(fakeAgent) // unchanged — NOT rebuilt
    await entry.followupChain
    expect(followup).toHaveBeenCalledWith("pending", expect.any(AbortSignal))
    expect(entry.status).toBe("waiting")
    expect(entry.finalText).toBe("ok")
  }, 10_000)

  it("resume_agent rebuilds the child from the loaded session + role", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, exec } = setup()
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
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents })
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
    const { ctx, table, jobs, roles, parentReg, session, providers, exec } = setup()
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
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents })
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
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry() })
    const resume = all.find((t) => t.name === "resume_agent")!
    await expect(resume.execute({ target: "root/ghost" }, {})).rejects.toThrow(/unknown subagent/)
  })

  it("send_message appends a durable subagent/inbox event to the child session", async () => {
    const spy = vi.fn()
    const entrySession = createSession((ev) => { spy(ev) })
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    table.add("root/helper", {
      path: "root/helper",
      status: "running",
      session: entrySession,
      controller: new AbortController(),
      mailbox: [],
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry() })
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
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    table.add("root/helper", {
      path: "root/helper",
      status: "running",
      session: entrySession,
      controller: new AbortController(),
      mailbox: [],
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry() })
    const follow = all.find((t) => t.name === "followup_task")!
    const out = await follow.execute({ target: "root/helper", message: "more" }, {})
    expect((out as { delivered: boolean }).delivered).toBe(true)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: "subagent/inbox", message: "more" }))
    expect((spy.mock.calls[0]![0] as { messageId: string }).messageId).toBeTruthy()
    expect(table.get("root/helper")!.mailbox).toContain("more")
  })

  it("resume_agent refuses to overwrite a running entry", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const resume = all.find((t) => t.name === "resume_agent")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    await expect(resume.execute({ target: "root/helper" }, {})).rejects.toThrow(/already running/i)
  })

  it("followup_task drives a turn on the child (appends inbox + wakes the driver)", async () => {
    const spy = vi.fn()
    const entrySession = createSession((ev) => { spy(ev) })
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
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
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents })
    const follow = all.find((t) => t.name === "followup_task")!
    const entry = table.get("root/helper")!
    const out = await follow.execute({ target: "root/helper", message: "again" }, {})
    expect(out).toEqual({ delivered: true })
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: "subagent/inbox", message: "again" }))
    await entry.followupChain
    expect(followup).toHaveBeenCalledWith("again", expect.any(AbortSignal))
    expect(entry.status).toBe("waiting")
    expect(entry.finalText).toBe("ok2")
    expect(jobs.read(jobId).status).toBe("completed")
    expect(jobs.read(jobId).output).toBe("ok2")
  })

  it("close_agent unregisters the child agent from the registry", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
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
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents })
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
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry() })
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
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry() })
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
    const { exec, jobs, table, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: createContext(), parentModel: model, providers, exec, agents: createAgentRegistry() })
    const output = all.find((t) => t.name === "job_output")!
    const { jobId } = exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>console.log('bg done'), 100)"] })
    expect(jobId).toMatch(/^bash-\d+$/)
    // wait:true exercises the exec-fallback poll-wait path and avoids a fixed sleep.
    const read = await output.execute({ job_id: jobId, wait: true, timeout_ms: 5000 }, {})
    expect((read as { status: string }).status).toBe("completed")
    expect((read as { text: string }).text).toContain("bg done")
    expect((read as { text: string }).text).toContain("[status: completed]")
  }, 10_000)

  it("job_list enumerates both subagent and bash jobs", async () => {
    const { exec, jobs, table, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: createContext(), parentModel: model, providers, exec, agents: createAgentRegistry() })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const list = all.find((t) => t.name === "job_list")!
    const spawnOut = await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const subId = (spawnOut as { job_id: string }).job_id
    const { jobId } = exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>{}, 50)"] })
    const listed = await list.execute({}, {})
    const ids = (listed as { jobs: { id: string; kind: string }[] }).jobs.map((j) => j.id)
    expect(ids).toContain(subId)
    expect(ids).toContain(jobId)
    const kinds = (listed as { jobs: { kind: string }[] }).jobs.map((j) => j.kind)
    expect(kinds).toContain("subagent")
    expect(kinds).toContain("bash")
  }, 10_000)

  it("job_kill cancels a bash job via the exec bridge", async () => {
    const { exec, jobs, table, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: createContext(), parentModel: model, providers, exec, agents: createAgentRegistry() })
    const kill = all.find((t) => t.name === "job_kill")!
    const { jobId } = exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>{}, 5000)"] })
    const out = await kill.execute({ job_id: jobId }, {})
    expect((out as { outcome: string }).outcome).toBe("cancellation-requested")
  }, 10_000)

  it("close_agent aborts, kills the subagent job, and removes the entry", async () => {
    const { ctx, exec, jobs, table, roles, parentReg, session, providers } = setup()
    // A slow model keeps the child RUNNING so close_agent's kill is observable
    // (a fast mock may already have completed before close runs).
    const slowModel: ModelClient = {
      async *stream() {
        yield { type: "text/chunk", text: "working" }
        await new Promise((r) => setTimeout(r, 500))
        yield { type: "end" }
      },
    }
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: slowModel, providers, exec, agents: createAgentRegistry() })
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
