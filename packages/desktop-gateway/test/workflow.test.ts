import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeJsonlTaskTransitionCoordinator } from "../../session-persistence-jsonl/src/task-document-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { applyGoalMutation, foldGoal } from "@i-harness/goal"
import { append, createSession, metadataFactsFor, committedFactSeqs } from '@i-harness/core-session'
import { createDurableSessionLoader, createSessionService } from "@i-harness/session-executor"
import { createDesktopWorkflow, createDesktopGoalTools, createDesktopOwnedGoalTools } from "../src/workflow.ts"

it('owned goal tools preserve revision checks and commit the original goal fact',async()=>{
 const session=createSession()
 append(session,applyGoalMutation(null,'create',{objective:'verify'},1).event)
 const tools=createDesktopOwnedGoalTools({read:()=>foldGoal(session.events),complete:async(ref,signal)=>{const mutation=applyGoalMutation(foldGoal(session.events),'complete',{ref},Date.now());committedFactSeqs(await metadataFactsFor(session,undefined,signal).admit(mutation.event));return foldGoal(session.events)}},()=>{})
 const read=tools.find(tool=>tool.name==='goal_read')!,complete=tools.find(tool=>tool.name==='goal_complete')!
 const goal=await read.execute({}, {}) as {id:string;revision:number}
 await expect(complete.execute({id:goal.id,revision:goal.revision+1},{})).rejects.toThrow(/stale/i)
 expect((await complete.execute(goal,{}))).toMatchObject({phase:'complete',revision:2})
 expect(foldGoal(session.events)).toMatchObject({phase:'complete',revision:2})
})

it('complete Session goal tools retain their original read and completion behavior',async()=>{
 const session=createSession()
 append(session,applyGoalMutation(null,'create',{objective:'verify'},1).event)
 const tools=createDesktopGoalTools(id=>id==='s'?session:undefined,()=>{})
 const read=tools.find(tool=>tool.name==='goal_read')!,complete=tools.find(tool=>tool.name==='goal_complete')!
 const goal=await read.execute({},{sessionId:'s'}) as {id:string;revision:number}
 await expect(complete.execute({id:goal.id,revision:goal.revision+1},{sessionId:'s'})).rejects.toThrow(/stale/i)
 expect(await complete.execute(goal,{sessionId:'s'})).toMatchObject({phase:'complete',revision:2})
})

it("persists Goal/Plan controls and job history, rejecting stale Goal edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-workflow-"))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: "s" })
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", coordinator, sessionFor: createDurableSessionLoader(coordinator) })
  const workflow = createDesktopWorkflow(coordinator, service)
  try {
    const created = await workflow.mutate("s", { action: "goal", operation: "create", request: { objective: "Read a file" } })
    const ref = { id: created.goal!.id, revision: created.goal!.revision }
    expect(created.goal!.phase).toBe("active")
    expect(created.goal!.maxGoalRounds).toBeUndefined()
    const paused = await workflow.mutate("s", { action: "goal", operation: "pause", request: { ref } })
    expect(paused.goal!.phase).toBe("paused")
    await expect(workflow.mutate("s", { action: "goal", operation: "edit", request: { ref, objective: "stale" } })).rejects.toThrow(/revision|stale/i)
    expect((await workflow.mutate("s", { action: "plan", enabled: true, proposal: "Inspect first" })).plan.active).toBe(true)
    const assembly = await service.assemblyFor("s")
    expect(assembly.session.events).toContainEqual(expect.objectContaining({ type: "user/message", text: "Inspect first" }))
    await (await coordinator.openManagedDocument('s')).delivery.record({ type: "job/status", version: 1, job: { jobId: "job-1", kind: "shell", label: "test", status: "completed", outputAvailable: false } })
    await coordinator.flush("s")
    await service.closeSession("s")
    const restored = await workflow.read("s")
    expect(restored.goal!.phase).toBe("paused")
    expect(restored.plan.active).toBe(true)
    expect(restored.jobs).toMatchObject([{ jobId: "job-1", status: "completed", live: false, canCancel: false }])
  } finally { await workflow.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
it.each(["refused", "empty"] as const)("pauses an autonomous Goal after a provider %s result", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "ih-goal-terminal-"))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: "s" })
  let calls = 0
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator),
    model: controlledModel(request => ({ async *stream() { calls++; yield { type: "end", ...(kind === "refused" ? { refused: true as const } : {}) } } } as import('@i-harness/llm-seam').ModelClient).stream(request)) })
  const workflow = createDesktopWorkflow(coordinator, service)
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    await workflow.mutate("s", { action: "goal", operation: "create", request: { objective: "Do work" }, start: true })
    await vi.waitFor(async () => { const view = await workflow.read("s"); expect(view.goal?.phase).toBe("paused"); expect(view.goalRun?.error).toMatch(/refused|usable/i) })
    expect(calls).toBe(1)
  } finally { warn.mockRestore(); await workflow.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
it("contains background recovery persistence failures and reports them to the UI", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-goal-disk-"))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: "s" })
  const put = coordinator.putDocument.bind(coordinator)
  vi.spyOn(coordinator, "putDocument").mockImplementation(async (key, value) => { if (key.startsWith("desktop-goal-")) throw new Error("disk unavailable"); await put(key, value) })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model: controlledModel(request => ({ async *stream() { throw new Error("provider unavailable") } } as import('@i-harness/llm-seam').ModelClient).stream(request)) })
  const errors: string[] = []
  const workflow = createDesktopWorkflow(coordinator, service, { onRunningChanged: (_id, running, error) => { if (!running && error) errors.push(error) } })
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    await workflow.mutate("s", { action: "goal", operation: "create", request: { objective: "Do work" }, start: true })
    await vi.waitFor(() => expect(errors.some((error) => error.includes("could not be saved"))).toBe(true))
    expect((await workflow.read("s")).goalRun?.error).toContain("disk unavailable")
  } finally { warn.mockRestore(); await workflow.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
it("restarts a paused Goal while the old aborted provider request is still settling", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-goal-resume-"))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: "s" })
  let release!: () => void
  const old = new Promise<void>((done) => { release = done })
  let calls = 0
  const states: boolean[] = []
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator),
    additionalTools: createDesktopGoalTools((id) => service.liveSession(id), () => {},id=>service.liveAssembly(id)?.metadataFacts),
    model: controlledModel(request => ({ async *stream(request) {
      if (++calls === 1) { await old; request.signal?.throwIfAborted() }
      else if (calls === 2) { const goal = foldGoal(service.liveSession("s")!.events)!; yield { type: "tool_call", call: { name: "goal_complete", args: { id: goal.id, revision: goal.revision } } } }
      else yield { type: "text/chunk", text: "Verified done" }
      yield { type: "end" }
    } } as import('@i-harness/llm-seam').ModelClient).stream(request)) })
  const workflow = createDesktopWorkflow(coordinator, service, { onRunningChanged: (_id, value) => states.push(value) })
  try {
    const first = await workflow.mutate("s", { action: "goal", operation: "create", request: { objective: "Verify done" }, start: true })
    await vi.waitFor(() => expect(calls).toBe(1))
    const paused = await workflow.mutate("s", { action: "goal", operation: "pause", request: { ref: first.goal! } })
    await workflow.mutate("s", { action: "goal", operation: "resume", request: { ref: paused.goal! }, start: true })
    release()
    await vi.waitFor(async () => expect((await workflow.read("s")).goal?.phase).toBe("complete"))
    await vi.waitFor(() => expect(states.at(-1)).toBe(false))
    expect(calls).toBe(3)
    expect(states).toEqual([true, true, false])
  } finally { release(); await workflow.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses removed Team commands before resolving a runtime', async () => {
 const activate=vi.fn(async()=>{throw Error('must not activate')})
 const workflow=createDesktopWorkflow({} as never,{} as never,{managedForMutation:activate})
 await expect(workflow.mutate('saved',{action:'team',tool:'spawn_teammate',args:{}})).rejects.toThrow('Unknown workflow command')
 expect(activate).not.toHaveBeenCalled()
 await workflow.close()
})
