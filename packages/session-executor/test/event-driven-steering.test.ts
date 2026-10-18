import { afterEach as afterFixture, vi as fixtureVi } from 'vitest'
afterFixture(() => fixtureVi.unstubAllGlobals())
import { controlledModel } from "./controlled-model.ts"
import { describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionExecutor } from "@i-harness/core-agent"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import type { ExecService } from "@i-harness/exec"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { taskDocKey, type TaskProtocolDocument } from "@i-harness/subagent"
import { createSessionAssembly, type SessionAssembly } from "../src/assembly.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

// The mock still goes through the real agent/registry/lane. Only provider output
// and the producer's completion are controlled; no wait implementation is faked.
function modelFixture(script: MockStep[]) {
  const requests: LLMRequest[] = [], next = deferred()
  const mock = createMockClient(script)
  const model: ModelClient = controlledModel(async function* (request) {
    requests.push(request)
    if (requests.length === 2) next.resolve()
    yield* mock.stream(request)
  })
  return { model, requests, next, script }
}

async function untilStarted(control: ReturnType<typeof deferred>) {
  let entered = false
  void control.promise.then(() => { entered = true })
  await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 })
}

function results(assembly: SessionAssembly, name: string) {
  return assembly.session.events.filter(event => event.type === "tool/result" && event.name === name)
    .map(event => event as { callId: string; output: Record<string, unknown> })
}

async function dispatched(assembly: SessionAssembly, name: string) {
  await vi.waitFor(() => expect(assembly.session.events.some(event => event.type === "tool/call" && event.name === name)).toBe(true), { timeout: 5000 })
}

function assertAdmission(assembly: SessionAssembly, inputId: string, request: LLMRequest) {
  expect(assembly.session.events.filter(event => event.type === "agent/input/promoted" && event.inputId === inputId)).toHaveLength(1)
  expect(assembly.session.events.filter(event => event.type === "user/message" && event.text === "new direction")).toHaveLength(1)
  expect(request.messages.filter(message => message.role === "user" && message.content === "new direction")).toHaveLength(1)
}

describe("real assembly: steering releases observation and preserves the producer", () => {
  it.each(["foreground", "target", "all", "tasks", "subagent-job"] as const)("%s child wait lets the parent turn end, then a later turn retrieves the same work", async family => {
    const root = await mkdtemp(join(tmpdir(), "ih-steer-child-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } })
    await coordinator.create({ sessionId: "parent" })
    const started = deferred(), release = deferred()
    let childCalls = 0, childFinished = 0, aborts = 0
    const child: ModelClient = controlledModel(async function* (request) {
      childCalls++; request.signal?.addEventListener("abort", () => { aborts++ }, { once: true })
      started.resolve(); await release.promise; childFinished++
      yield { type: "text/chunk", text: "original child result" }; yield { type: "end" }
    })
    const fixture = modelFixture([])
    const assembly = await createSessionAssembly({ workspace: root, sessionId: "parent", coordinator, model: fixture.model,
      approveAll: true, sandbox: "danger-full-access", pluginAgents: [{ name: "probe", description: "Controlled child", systemPrompt: "Complete the fixture", tools: [] }],
      roleSelectionFor: () => ({ provider: "fixture", model: "child" }), allowSubagentModelSelection: true,
      resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }),
    })
    const executor = createSessionExecutor({ session: assembly.session, agent: assembly.agent, inbox: assembly.inbox })
    try {
      const spawn = (name: string) => assembly.tools.execute({ name: "spawn_agent", args: { task_name: name, agent_type: "probe", message: "held work" } })
      const handles = family === "foreground" ? [] : [(await spawn("held")).output as Record<string, string>]
      if (family === "tasks") handles.push((await spawn("second")).output as Record<string, string>)
      const name = family === "foreground" ? "spawn_agent" : family === "tasks" ? "get_task_output" : family === "subagent-job" ? "job_output" : "wait_agent"
      const args = family === "foreground" ? { task_name: "held", agent_type: "probe", message: "held work", background: false }
        : family === "tasks" ? { task_ids: handles.map(handle => handle.task_id), wait: true, timeout_ms: 300_000 }
        : family === "subagent-job" ? { job_id: handles[0]!.job_id, wait: true, timeout_ms: 300_000 }
        : { ...(family === "target" ? { target: "root/held" } : {}), timeout_ms: 300_000 }
      fixture.script.push({ role: "assistant", toolCalls: [{ name, args }] }, { role: "assistant", text: "parent can finish now" })
      executor.submit({ tier: "send", text: "start held work" })
      await untilStarted(started); await dispatched(assembly, name)
      const steer = executor.submit({ tier: "steer", text: "new direction" })
      await untilStarted(fixture.next)
      expect(fixture.requests).toHaveLength(2)
      await executor.drain()
      assertAdmission(assembly, steer.inputId, fixture.requests[1]!)
      expect(childFinished).toBe(0); expect(aborts).toBe(0)
      expect(childCalls).toBe(family === "tasks" ? 2 : 1)
      expect(executor.isRunning()).toBe(false)
      expect(assembly.session.events.filter(event => event.type === "turn/end")).toHaveLength(1)
      const yielded = results(assembly, name).at(-1)!
      expect(yielded.output).toMatchObject({ yielded: true, yield_reason: "user-steer" })
      if (family === "target") expect(yielded.output).toMatchObject({ path: handles[0]!.agent_path, job_id: handles[0]!.job_id, status: "running", timed_out: false })
      if (family === "tasks") expect(yielded.output.tasks).toEqual(handles.map(handle => expect.objectContaining({ task_id: handle.task_id, status: "running" })))
      if (family === "subagent-job") expect(yielded.output.status).toBe("running")
      if (family === "foreground") {
        handles.push(yielded.output as Record<string, string>)
        expect(yielded.output).toMatchObject({ timed_out: false, status: "running" })
        await vi.waitFor(async () => expect(((await coordinator.getDocument(taskDocKey("parent"))) as TaskProtocolDocument).tasks[0]?.delivery).toBe("tool"))
      }
      const expectedTaskIds = handles.map(handle => handle.task_id)
      release.resolve()
      fixture.script.push({ role: "assistant", toolCalls: [{ name: "get_task_output", args: { task_ids: expectedTaskIds, wait: true } }] }, { role: "assistant", text: "retrieved" })
      executor.submit({ tier: "send", text: "retrieve original work" }); await executor.drain()
      const output = results(assembly, "get_task_output").at(-1)!.output
      expect(output.tasks).toEqual(expectedTaskIds.map(task_id => expect.objectContaining({ task_id, outcome: "completed", resultText: "original child result" })))
      expect(childCalls).toBe(expectedTaskIds.length); expect(childFinished).toBe(expectedTaskIds.length); expect(aborts).toBe(0)
      expect(assembly.session.events.filter(event => event.type === "subagent/start")).toHaveLength(expectedTaskIds.length)
      expect(assembly.session.events.filter(event => event.type === "tool/result" && event.callId === yielded.callId)).toHaveLength(1)
      expect(assembly.session.events.filter(event => event.type === "tool/dispatch" && event.callId === yielded.callId)).toHaveLength(1)
      if (family === "foreground") {
        await vi.waitFor(async () => {
          const document = await coordinator.getDocument(taskDocKey("parent")) as TaskProtocolDocument
          expect(document.tasks[0]).toMatchObject({ id: expectedTaskIds[0], delivery: "tool", outcome: "completed" })
          expect(document.notifications).toHaveLength(0)
        })
        expect(assembly.session.events.filter(event => event.type === "agent/input/admitted" && event.intent === "system")).toHaveLength(0)
      }
    } finally { release.resolve(); executor.dispose(); await assembly.dispose(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
  }, 15_000)

  it.each(["code_exec", "code_wait"] as const)("%s yields only the outer observer, while an arbitrary nested invocation outlives the parent turn", async name => {
    const root = await mkdtemp(join(tmpdir(), "ih-steer-cell-")), started = deferred(), release = deferred()
    let calls = 0, finished = false, aborts = 0
    const fixture = modelFixture([])
    const assembly = await createSessionAssembly({ workspace: root, sessionId: "parent", model: fixture.model, approveAll: true, sandbox: "danger-full-access", codeMode: { mode: "mixed" }, additionalTools: [{
      name: "held_read", description: "Controlled producer", inputSchema: { type: "object" }, isReadOnly: true,
      execute: async (_args, exec) => { calls++; exec.abortSignal?.addEventListener("abort", () => { if (!finished) aborts++ }, { once: true }); started.resolve(); await release.promise; finished = true; return "original nested result" },
    }] })
    const executor = createSessionExecutor({ session: assembly.session, agent: assembly.agent, inbox: assembly.inbox })
    try {
      const code = 'text("before"); text(await tools.held_read({})); text("after");'
      const initial = name === "code_wait" ? (await assembly.tools.execute({ name: "code_exec", args: { code, yield_time_ms: 0 } })).output as { cell_id: string } : undefined
      fixture.script.push({ role: "assistant", toolCalls: [{ name, args: initial ? { cell_id: initial.cell_id, yield_time_ms: 60_000 } : { code, yield_time_ms: 60_000 } }] }, { role: "assistant", text: "parent complete while cell runs" })
      executor.submit({ tier: "send", text: "start held work" })
      await untilStarted(started); await dispatched(assembly, name)
      const steer = executor.submit({ tier: "steer", text: "new direction" })
      await untilStarted(fixture.next); expect(fixture.requests).toHaveLength(2); await executor.drain()
      const observation = results(assembly, name).at(-1)!, id = observation.output.cell_id as string
      expect(observation.output).toMatchObject({ status: "running", yield_reason: "user-steer" })
      if (initial) expect(id).toBe(initial.cell_id)
      assertAdmission(assembly, steer.inputId, fixture.requests[1]!)
      expect(finished).toBe(false); expect(calls).toBe(1); expect(aborts).toBe(0); expect(executor.isRunning()).toBe(false)
      expect(assembly.liveResources!().codeCells).toEqual([{ id, status: "running" }])
      expect(assembly.session.events.filter(event => event.type === "code/result")).toHaveLength(0)
      release.resolve()
      fixture.script.push({ role: "assistant", toolCalls: [{ name: "code_wait", args: { cell_id: id, yield_time_ms: 5000 } }] }, { role: "assistant", text: "retrieved" })
      executor.submit({ tier: "send", text: "retrieve original cell" }); await executor.drain()
      const final = results(assembly, "code_wait").at(-1)!.output
      expect(final).toMatchObject({ cell_id: id, status: "completed" })
      // Already consumed output belongs to the first observation; the later
      // retrieval receives new items once, without replaying the old window.
      expect(JSON.stringify(observation.output)).toContain("before")
      expect(JSON.stringify(final)).toContain("original nested result"); expect(JSON.stringify(final)).toContain("after")
      expect(JSON.stringify(final)).not.toContain('"text":"before"')
      expect(assembly.session.events.filter(event => event.type === "code/call" && event.name === "held_read")).toHaveLength(1)
      const invocation = assembly.session.events.find(event => event.type === "code/call" && event.name === "held_read")!
      expect(assembly.session.events.filter(event => event.type === "code/result")).toEqual([expect.objectContaining({ cellId: id, callId: "callId" in invocation ? invocation.callId : undefined, name: "held_read", output: "original nested result" })])
      expect(assembly.session.events.filter(event => event.type === "tool/result" && event.callId === observation.callId)).toHaveLength(1)
      expect(calls).toBe(1); expect(aborts).toBe(0); expect(assembly.liveResources!().codeCells).toEqual([])
    } finally { release.resolve(); executor.dispose(); await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
  }, 15_000)

  it("closing the real child releases a long target observation and retains its original task result", async () => {
    const root = await mkdtemp(join(tmpdir(), "ih-steer-child-close-")), release = deferred()
    let childCalls = 0, aborts = 0
    const child: ModelClient = controlledModel(async function* (request) {
      childCalls++; request.signal?.addEventListener("abort", () => { aborts++; release.resolve() }, { once: true })
      await release.promise; yield { type: "text/chunk", text: "closed producer" }; yield { type: "end" }
    })
    const fixture = modelFixture([{ role: "assistant", toolCalls: [{ name: "wait_agent", args: { target: "root/held", timeout_ms: 300_000 } }] }, { role: "assistant", text: "closed child observed" }])
    const assembly = await createSessionAssembly({ workspace: root, sessionId: "parent", model: fixture.model, sandbox: "danger-full-access", approveAll: true,
      allowSubagentModelSelection: true, roleSelectionFor: () => ({ provider: "fixture", model: "child" }), resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }),
    })
    const executor = createSessionExecutor({ session: assembly.session, agent: assembly.agent, inbox: assembly.inbox })
    try {
      const handle = (await assembly.tools.execute({ name: "spawn_agent", args: { task_name: "held", message: "held child" } })).output as { task_id: string; job_id: string }
      await vi.waitFor(() => expect(childCalls).toBe(1))
      executor.submit({ tier: "send", text: "observe child" })
      await vi.waitFor(() => expect(assembly.session.events.some(event => event.type === "tool/dispatch")).toBe(true))
      await assembly.tools.execute({ name: "close_agent", args: { target: "root/held" } })
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(2), { timeout: 5000 }); await executor.drain()
      expect(results(assembly, "wait_agent")[0]!.output.timed_out).toBe(false)
      expect(aborts).toBe(1); expect(childCalls).toBe(1)
      expect(assembly.subagentState().agentTable).toHaveLength(0)
      const final = (await assembly.tools.execute({ name: "get_task_output", args: { task_ids: [handle.task_id] } })).output
      expect(final).toMatchObject({ tasks: [{ task_id: handle.task_id, outcome: "cancelled" }] })
      expect(results(assembly, "wait_agent")).toHaveLength(1)
    } finally { release.resolve(); executor.dispose(); await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
  }, 15_000)

  it("an already dispatched arbitrary direct sibling still bounds the next provider request", async () => {
    const root = await mkdtemp(join(tmpdir(), "ih-steer-sibling-")), started = deferred(), release = deferred(), observationReturned = deferred()
    let siblingCalls = 0, aborts = 0
    const fixture = modelFixture([{ role: "assistant", toolCalls: [{ name: "parallel_job_output", args: { job_id: "controlled-job", wait: true } }, { name: "held_read", args: {} }] }, { role: "assistant", text: "continued" }])
    const assembly = await createSessionAssembly({ workspace: root, model: fixture.model, sandbox: "danger-full-access", approveAll: true, maxParallelToolCalls: 2, additionalTools: [{
      name: "held_read", description: "Held sibling", inputSchema: { type: "object" }, isReadOnly: true, isConcurrencySafe: true,
      execute: async (_args, exec) => { siblingCalls++; exec.abortSignal?.addEventListener("abort", () => { aborts++ }, { once: true }); started.resolve(); await release.promise; return "sibling result" },
    }] })
    // Shipped job_output is exclusive. This fixture opts the existing body into
    // parallel dispatch explicitly, to exercise the already-dispatched boundary
    // without claiming that shipped exclusive tools acquire parallel siblings.
    const original = assembly.tools.get("job_output")!
    assembly.tools.register({ ...original, name: "parallel_job_output", isConcurrencySafe: true,
      execute: async (args, exec) => { const output = await original.execute(args, exec); observationReturned.resolve(); return output },
    })
    const job = assembly.registerBackgroundJob!({ id: "controlled-job", kind: "fixture", label: "Held job", cancel: () => { aborts++ } })
    const executor = createSessionExecutor({ session: assembly.session, agent: assembly.agent, inbox: assembly.inbox })
    try {
      executor.submit({ tier: "send", text: "start held work" }); await untilStarted(started)
      const steer = executor.submit({ tier: "steer", text: "new direction" })
      // The eligible observer has returned into the batch, but result logging
      // and the provider boundary still await the already dispatched sibling.
      await untilStarted(observationReturned)
      expect(fixture.requests).toHaveLength(1); expect(siblingCalls).toBe(1); expect(aborts).toBe(0)
      expect(assembly.tasks().some(task => task.id === "controlled-job" && task.status === "running")).toBe(true)
      release.resolve(); await executor.drain()
      expect(fixture.requests).toHaveLength(2); assertAdmission(assembly, steer.inputId, fixture.requests[1]!)
      expect(results(assembly, "parallel_job_output")).toHaveLength(1)
      expect(results(assembly, "parallel_job_output")[0]!.output).toMatchObject({ status: "running", yielded: true, yield_reason: "user-steer" })
      expect(results(assembly, "held_read")).toHaveLength(1); expect(siblingCalls).toBe(1); expect(aborts).toBe(0)
      job.finish("completed", "original job result")
    } finally { release.resolve(); job.finish("completed", "cleanup"); executor.dispose(); await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
  }, 15_000)

  it.each(["stop", "close"] as const)("%s after steering still cancels and joins the original nested owner", async action => {
    const root = await mkdtemp(join(tmpdir(), "ih-steer-stop-")), release = deferred()
    let calls = 0, aborts = 0, finished = false
    const fixture = modelFixture([{ role: "assistant", toolCalls: [{ name: "code_exec", args: { code: 'text(await tools.held_read({}));', yield_time_ms: 60_000 } }] }, { role: "assistant", text: "parent finished" }])
    const assembly = await createSessionAssembly({ workspace: root, model: fixture.model, sandbox: "danger-full-access", approveAll: true, codeMode: { mode: "mixed" }, additionalTools: [{
      name: "held_read", description: "Uncooperative controlled producer", inputSchema: { type: "object" }, isReadOnly: true,
      execute: async (_args, exec) => { calls++; exec.abortSignal?.addEventListener("abort", () => { aborts++ }, { once: true }); await release.promise; finished = true; return "drained" },
    }] })
    const executor = createSessionExecutor({ session: assembly.session, agent: assembly.agent, inbox: assembly.inbox })
    try {
      executor.submit({ tier: "send", text: "start held work" })
      await vi.waitFor(() => expect(calls).toBe(1), { timeout: 5000 })
      executor.submit({ tier: "steer", text: "new direction" }); await untilStarted(fixture.next); await executor.drain()
      const observation = results(assembly, "code_exec")[0]!, id = observation.output.cell_id as string
      expect(observation.output).toMatchObject({ status: "running", yield_reason: "user-steer" })
      expect(aborts).toBe(0); expect(finished).toBe(false)
      let joined = false
      const closing = (action === "stop" ? assembly.stopCodeCell!(id) : assembly.dispose()).then(() => { joined = true })
      await vi.waitFor(() => expect(aborts).toBe(1), { timeout: 5000 })
      expect(joined).toBe(false); expect(finished).toBe(false)
      release.resolve(); await closing
      expect(joined).toBe(true); expect(finished).toBe(true); expect(calls).toBe(1)
      expect(assembly.liveResources!().codeCells).toEqual([])
      expect(assembly.session.events.filter(event => event.type === "tool/result" && event.callId === observation.callId)).toHaveLength(1)
    } finally { release.resolve(); executor.dispose(); await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
  }, 15_000)

  it.each(["exec-job", "workflow-job", "workflow-run"] as const)("%s retains one real local process until release and retrieves it in a later turn", async family => {
    const root = await mkdtemp(join(tmpdir(), "ih-steer-process-")), launch = join(root, "launch"), release = join(root, "release"), producer = join(root, "producer.cjs")
    await writeFile(producer, `const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(launch)},'launch\\n'); console.log('started'); const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);console.log('original process result')}},20)`)
    await mkdir(join(root, "workflow"))
    await writeFile(join(root, "workflow", "held.yml"), `name: held\ndescription: Controlled process\nsteps:\n  - name: hold\n    command: ${JSON.stringify(`"${process.execPath.replace(/\\/g, "/")}" "${producer.replace(/\\/g, "/")}"`)}\n    timeout_ms: 300000\n`)
    const fixture = modelFixture([])
    const assembly = await createSessionAssembly({ workspace: root, model: fixture.model, sandbox: "danger-full-access", approveAll: true })
    const executor = createSessionExecutor({ session: assembly.session, agent: assembly.agent, inbox: assembly.inbox })
    try {
      let id: string | undefined
      if (family === "exec-job") id = (await assembly.ctx.services.get<ExecService>("exec/service").runBackground({ argv: [process.execPath, producer], cwd: root })).jobId
      if (family === "workflow-job") id = ((await assembly.tools.execute({ name: "workflow_run", args: { name: "held" } })).output as { job_id: string }).job_id
      const name = family === "workflow-run" ? "workflow_run" : "job_output"
      fixture.script.push({ role: "assistant", toolCalls: [{ name, args: id ? { job_id: id, wait: true, timeout_ms: 300_000 } : { name: "held", wait: true } }] }, { role: "assistant", text: "parent finished" })
      executor.submit({ tier: "send", text: "start held work" })
      await vi.waitFor(() => expect(existsSync(launch)).toBe(true), { timeout: 5000 }); await dispatched(assembly, name)
      const steer = executor.submit({ tier: "steer", text: "new direction" })
      await untilStarted(fixture.next); expect(fixture.requests).toHaveLength(2); await executor.drain()
      const observation = results(assembly, name)[0]!
      expect(observation.output).toMatchObject({ status: "running", yielded: true, yield_reason: "user-steer" })
      id ??= observation.output.job_id as string
      expect(id).toBeTruthy(); expect(existsSync(release)).toBe(false); expect(await readFile(launch, "utf8")).toBe("launch\n")
      expect(executor.isRunning()).toBe(false); assertAdmission(assembly, steer.inputId, fixture.requests[1]!)
      await writeFile(release, "go")
      fixture.script.push({ role: "assistant", toolCalls: [{ name: "job_output", args: { job_id: id, wait: true, timeout_ms: 5000 } }] }, { role: "assistant", text: "retrieved" })
      executor.submit({ tier: "send", text: "retrieve original process" }); await executor.drain()
      expect(results(assembly, "job_output").at(-1)!.output).toMatchObject({ status: "completed", text: expect.stringContaining("original process result") })
      expect(await readFile(launch, "utf8")).toBe("launch\n")
      expect(assembly.session.events.filter(event => event.type === "tool/result" && event.callId === observation.callId)).toHaveLength(1)
      expect(assembly.liveResources!().backgroundJobs).toEqual([])
    } finally { await writeFile(release, "cleanup"); executor.dispose(); await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
  }, 15_000)
})
