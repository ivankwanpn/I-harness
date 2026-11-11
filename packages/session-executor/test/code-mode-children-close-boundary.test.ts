import { afterEach as afterFixture, vi as fixtureVi } from 'vitest'
afterFixture(() => fixtureVi.unstubAllGlobals())
import { controlledModel } from "./controlled-model.ts"
import { subscribe } from '@i-harness/core-session'
import { expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { createDurableSessionLoader, createSessionService, createUnmanagedTaskChildHost } from "../src/index.ts"
import { registerCodeMode, type CodeModeFactory } from "@i-harness/code-mode"
import { inspect } from 'node:util'

function codeObservation(request: LLMRequest) {
  const last = request.messages.at(-1)
  if (last?.role !== "tool" || last.isError || typeof last.content !== "string") throw new Error("Expected the actual successful Code Mode tool result: " + JSON.stringify({ sessionId: request.sessionId, last }))
  const call = request.messages.flatMap(message => message.role === "assistant" ? message.toolCalls ?? [] : []).find(call => call.id === last.toolCallId)
  if (!call || !["code_exec", "code_wait"].includes(call.name)) throw new Error("Expected a Code Mode observation call")
  const output = JSON.parse(last.content)
  if (!output || typeof output.cell_id !== "string" || !output.cell_id || !["running", "completed"].includes(output.status) || output.error) throw new Error("Expected a running or completed Code Mode observation: " + last.content)
  if (call.name === "code_wait") expect(output.cell_id).toBe((call.args as { cell_id: string }).cell_id)
  return output as { cell_id: string; status: "running" | "completed" }
}

async function evidence(name: string, value: unknown) {
  if (!process.env.IH_CODE_CLOSE_EVIDENCE) return
  await mkdir(process.env.IH_CODE_CLOSE_EVIDENCE, { recursive: true })
  await writeFile(join(process.env.IH_CODE_CLOSE_EVIDENCE, name + ".json"), JSON.stringify(value, null, 2))
}

it("keeps child outputs and stored state through snapshot-before-close at the exact second-turn receipt boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-children-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "parent" })
  const requests: LLMRequest[] = []
  const parallelLimits: Array<number | undefined> = []
  const factory: CodeModeFactory = (ctx, tools, mountOptions) => {
    parallelLimits.push(mountOptions.maxParallel)
    return registerCodeMode(ctx, tools, { ...mountOptions, ...(mountOptions.sessionId === "parent" ? { config: { mode: "mixed" as const } } : {}) })
  }
  const child: ModelClient = controlledModel(async function* (request) {
    requests.push(request)
    const last = request.messages.at(-1)
    if (last?.role === "user") yield { type: "tool_call", call: { name: "code_exec", args: { code: 'text(ALL_TOOLS.map(t=>t.name)); text(await tools.list_dir({path:"."})); store("turn",(load("turn")??0)+1); text(load("turn"));' } } }
    else {
      const output = codeObservation(request)
      if (output.status === "running") yield { type: "tool_call", call: { name: "code_wait", args: { cell_id: output.cell_id } } }
      else yield { type: "text/chunk", text: "child complete" }
    }
    yield { type: "end" }
  })
  const parentCalls: Array<{ name: string; args: unknown }> = []
  const parent: ModelClient = controlledModel(async function* (request) {
    const call = request.messages.at(-1)?.role === "user" ? parentCalls.shift() : undefined
    if (call) yield { type: "tool_call", call }
    else yield { type: "text/chunk", text: "parent" }
    yield { type: "end" }
  })
  const options = {
    workspace: root, model: parent, coordinator, sessionFor: createDurableSessionLoader(coordinator), codeMode: { mode: "only" as const },
    codeModeFactory: factory, maxParallelToolCalls: 1,
    approveAll: true, prepareTaskChild: createUnmanagedTaskChildHost({ coordinator, policy: "unmanaged" }), sandbox: "danger-full-access" as const, contextWindow: 100_000, maxOutputTokens: 123,
    pluginAgents: ["probe", "helper"].map(name => ({ name, description: "Code Mode read fixture", systemPrompt: "Read files", tools: ["list_dir", "code_exec", "code_wait"] })),
    additionalTools: [{ name: "secret", description: "Parent secret", inputSchema: { type: "object", properties: {} }, execute: async () => "secret" }],
    roleSelectionFor: () => ({ provider: "fixture", model: "child" }), allowSubagentModelSelection: true,
    resolveRoleModel: async () => ({ status: "ready" as const, binding: { client: child, contextWindow: 100_000, maxOutputTokens: 123 } }),
  }
  let service = createSessionService(options)
  let primaryFailure: unknown, failed = false
  const childViews = new Map<string, Awaited<ReturnType<typeof coordinator.openManagedDocument>>["view"]>()
  let boundaryFacts: unknown
  const restoredFacts: Array<{ id: string; events: unknown }> = []
  try {
    let assembly = await service.assemblyFor("parent")
    const execute = async (name: string, args: unknown) => {
      const before = assembly.session.events.length
      parentCalls.push({ name, args })
      await service.submit("parent", "Perform the scheduled fixture operation", new AbortController().signal)
      const result = assembly.session.events.slice(before).find(event => event.type === "tool/result" && event.name === name)
      if (result?.type !== "tool/result" || result.envelope?.retention.kind !== "inline") throw new Error("Expected original inline parent operation result: " + name)
      if (result.envelope.execution.outcome !== "succeeded") throw new Error("Parent operation failed: " + JSON.stringify(result.envelope))
      return result.envelope.retention.value
    }
    await execute("spawn_agent", { task_name: "normal", agent_type: "probe", message: "read normal", fork_turns: "none", background: false })
    await execute("spawn_agent", { task_name: "helper", agent_type: "helper", message: "read helper", fork_turns: "none", background: false })
    const rows = (await execute("list_agents", {}) as { agents: Array<{ path: string; sessionId: string }> }).agents
    const ids = ["root/normal", "root/helper"].map(path => rows.find(row => row.path === path)!.sessionId)
    for (const id of ids) childViews.set(id, (await coordinator.openManagedDocument(id)).view)
    const waitTurns = async (count: number) => {
      for (const id of ids) {
        const document = await coordinator.openManagedDocument(id)
        await new Promise<void>(done => {
          const reached = () => document.view.events.filter(event => event.type === 'turn/end').length >= count
          const off = subscribe(document.view, event => { if (event.type === 'turn/end' && reached()) { off(); done() } })
          if (reached()) { off(); done() }
        })
        // Inspect the genuine committed live view after its receipt. A cold
        // snapshot is fenced while unrelated owner metadata is still draining.
        const events = document.view.events
        expect(events.filter(e => e.type === "turn/end")).toHaveLength(count)
        expect(events.some(e => e.type === "code/call" && e.name === "list_dir")).toBe(true)
        expect(events.filter(e => e.type === "code/output")).toEqual(expect.arrayContaining([expect.objectContaining({ envelope: expect.objectContaining({ preview: '["list_dir"]' }) })]))
      }
    }
    await waitTurns(1)
    let boundaryClose: Promise<void> | undefined
    let boundaryState: ReturnType<typeof assembly.subagentState> | undefined
    const reachedBoundary = Promise.withResolvers<void>()
    // The receipt observer records synchronous evidence. An external
    // continuation owns close; the child callback cannot join its own drive.
    const closingAtReceipt = reachedBoundary.promise.then(() => {
      boundaryClose = service.close()
      return boundaryClose
    })
    void closingAtReceipt.catch(() => {})
    const endings = new Map(ids.map(id => [id, 1]))
    const boundaryUnsubscribers = await Promise.all(ids.map(async id => subscribe((await coordinator.openManagedDocument(id)).view, event => {
      if (event.type !== 'turn/end') return
      endings.set(id, endings.get(id)! + 1)
      if ([...endings.values()].every(count => count === 2) && !boundaryState) {
        try {
          // These are synchronous receipt-time facts, before snapshot/close.
          // A final model sentence alone cannot establish completed work.
          for (const [id, view] of childViews) {
            expect(view.events.filter(event => event.type === "turn/end"), id).toHaveLength(2)
            const stores = view.events.filter(event => event.type === "code/store")
            expect(stores.map(event => event.writes), id).toEqual([[["turn", 1]], [["turn", 2]]])
            const completed = view.events.filter(event => event.type === "code/cell").filter(event => event.state === "completed")
            expect(completed.map(event => event.cellId), id).toEqual(stores.map(event => event.cellId))
            expect(stores.every(store => completed.some(cell => cell.cellId === store.cellId && cell.seq! > store.seq!)), id).toBe(true)
          }
          boundaryFacts = [...childViews].map(([id, view]) => ({ id, events: [...view.events] }))
        } catch (error) { reachedBoundary.reject(error); return }
        boundaryState = assembly.subagentState()
        reachedBoundary.resolve()
      }
    })))
    expect(parallelLimits).toEqual([1, 1, 1])
    for (const request of requests) {
      expect(request.tools.map(t => t.name)).toEqual(["code_exec", "code_status", "code_wait"])
      expect(request.maxOutputTokens).toBe(123)
    }
    expect(assembly.session.events.some(e => e.type === "code/dispatch")).toBe(false)
    await execute("followup_task", { target: "root/normal", message: "followup" })
    await execute("followup_task", { target: "root/helper", message: "followup" })
    // The external exact-receipt continuation closes the original owner. Its cold
    // snapshot is intentionally unavailable while that drain is pending; wait
    // for the observed receipt and the real close, without weakening the fence
    // or increasing this test's existing deadline.
    await reachedBoundary.promise
    expect(boundaryState).toBeDefined()
    expect(boundaryClose).toBeDefined()
    const restoredState = boundaryState!
    await closingAtReceipt
    await waitTurns(2)
    for (const unsubscribe of boundaryUnsubscribers) unsubscribe()
    service = createSessionService({ ...options, restoredState })
    assembly = await service.assemblyFor("parent")
    await execute("followup_task", { target: "root/normal", message: "restored followup" })
    await execute("followup_task", { target: "root/helper", message: "restored followup" })
    await waitTurns(3)
    await service.close()
    for (const id of ids) {
      const events = (await coordinator.snapshot!(id)).session.events
      restoredFacts.push({ id, events })
      const numbers = events.filter(e => e.type === "code/output").map(e => e.envelope?.preview).filter(text => /^\d+$/.test(text ?? ""))
      expect(numbers).toEqual(["1", "2", "3"])
    }
    for (const request of requests) {
      expect(request.tools.map(tool => tool.name)).toEqual(["code_exec", "code_status", "code_wait"])
      expect(request.maxOutputTokens).toBe(123)
    }
    expect(requests.filter(request => request.messages.at(-1)?.role === "tool").map(codeObservation).filter(output => output.status === "completed")).toHaveLength(6)
  } catch (error) {
    failed = true
    primaryFailure = error
    console.error('Code Mode child primary failure', inspect(error, { depth: 12 }))
    throw error
  } finally {
    await evidence("completed", { requests: requests.map(request => request.messages), boundaryFacts, originalChildren: [...childViews].map(([id, view]) => ({ id, events: view.events })), restoredFacts, error: inspect(primaryFailure, { depth: 12 }) })
    try { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
    catch (cleanup) {
      console.error('Code Mode child cleanup failure', inspect(cleanup, { depth: 12 }))
      if (failed) throw new AggregateError([primaryFailure, cleanup], 'Code Mode child assertion and cleanup failed', { cause: primaryFailure })
      throw cleanup
    }
  }
// This actual two-birth/six-Code-turn reconstruction measured 43s alone.
}, 60_000)

it("joins a genuinely running guest at turn-end close and cannot revive its unfinished continuation on reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-running-close-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "running" })
  const document = await coordinator.openManagedDocument("running")
  const entered = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>(), held = Promise.withResolvers<void>()
  const boundary = Promise.withResolvers<void>()
  const requests: LLMRequest[] = []
  let bodies = 0, bodySettled = false, closeSettled = false, runningCell: string | undefined
  let boundaryFacts: unknown, failure: unknown
  let restoredFacts: unknown
  const model = controlledModel(async function* (request) {
    requests.push(request)
    const last = request.messages.at(-1)
    if (last?.role === "user") {
      const followup = last.content === "distinct explicit followup"
      yield { type: "tool_call", call: { name: "code_exec", args: { code: followup
        ? 'text(load("unfinished") ?? "no unfinished store");'
        : 'await tools.held_read({}); store("unfinished",true); text("old continuation ran");', ...(followup ? {} : { yield_time_ms: 0 }) } } }
    } else {
      const output = codeObservation(request)
      if (!runningCell) {
        expect(output.status).toBe("running")
        runningCell = output.cell_id
        // Real dispatch has entered the held body before the actual turn ends.
        await entered.promise
        yield { type: "text/chunk", text: "guest remains running" }
      } else if (output.status === "running") yield { type: "tool_call", call: { name: "code_wait", args: { cell_id: output.cell_id } } }
      else yield { type: "text/chunk", text: "distinct followup complete" }
    }
    yield { type: "end" }
  })
  const options = { workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model,
    codeMode: { mode: "only" as const }, sandbox: "danger-full-access" as const, contextWindow: 100_000,
    additionalTools: [{ name: "held_read", description: "Held real nested body", inputSchema: { type: "object", properties: {} }, isReadOnly: true,
      execute: async (_args: unknown, exec: import("@i-harness/core-tools").ToolExec) => {
        bodies++; entered.resolve()
        const onAbort = () => aborted.resolve()
        exec.abortSignal?.addEventListener("abort", onAbort, { once: true })
        if (exec.abortSignal?.aborted) onAbort()
        try { await held.promise; bodySettled = true; return "original held body settled" }
        finally { exec.abortSignal?.removeEventListener("abort", onAbort) }
      } }],
  }
  let service = createSessionService(options)
  let closing: Promise<void> | undefined
  const unsubscribe = subscribe(document.view, event => {
    if (event.type !== "turn/end" || closing) return
    try {
      expect(runningCell).toBeDefined()
      expect(bodies).toBe(1); expect(bodySettled).toBe(false)
      expect(document.view.events.filter(event => event.type === "code/store")).toEqual([])
      expect(document.view.events.filter(event => event.type === "code/cell" && event.state === "completed")).toEqual([])
      boundaryFacts = [...document.view.events]
      closing = service.close().then(() => { closeSettled = true })
      void closing.catch(error => boundary.reject(error))
      boundary.resolve()
    } catch (error) { boundary.reject(error) }
  })
  let submission: Promise<unknown> | undefined
  try {
    submission = service.submit("running", "hold original guest", new AbortController().signal)
    void submission.catch(() => {})
    await boundary.promise
    await aborted.promise
    expect(closeSettled).toBe(false)
    expect(bodySettled).toBe(false)
    held.resolve()
    await closing!
    await submission
    unsubscribe()
    expect(closeSettled).toBe(true); expect(bodySettled).toBe(true)
    const originalEvents = (await coordinator.snapshot!("running")).session.events
    expect(originalEvents.filter(event => event.type === "code/cell" && event.cellId === runningCell).at(-1)).toMatchObject({ state: "terminated" })
    expect(originalEvents.filter(event => event.type === "code/store")).toEqual([])
    service = createSessionService(options)
    const reopened = await service.assemblyFor("running")
    expect(reopened.liveResources!().codeCells).toEqual([])
    expect(bodies).toBe(1)
    expect(requests).toHaveLength(2)
    await service.submit("running", "distinct explicit followup", new AbortController().signal)
    await service.close()
    const events = (await coordinator.snapshot!("running")).session.events
    restoredFacts = events
    expect(bodies).toBe(1)
    expect(events.filter(event => event.type === "code/store")).toEqual([])
    expect(events.filter(event => event.type === "code/cell" && event.cellId === runningCell && event.state === "completed")).toEqual([])
    expect(events.filter(event => event.type === "code/output").map(event => event.envelope?.preview)).toEqual(["no unfinished store"])
    expect(events.filter(event => event.type === "code/call" && event.name === "held_read")).toHaveLength(1)
    expect(events.filter(event => event.type === "code/dispatch")).toHaveLength(1)
    expect(events.filter(event => event.type === "user/message").map(event => event.text)).toEqual(["hold original guest", "distinct explicit followup"])
    expect(events.filter(event => event.type === "turn/end")).toHaveLength(2)
  } catch (error) { failure = error; throw error }
  finally {
    unsubscribe(); held.resolve()
    try { await service.close(); await submission }
    finally {
      await evidence("running", { requests: requests.map(request => request.messages), runningCell, bodies, bodySettled, closeSettled, boundaryFacts, originalEvents: document.view.events, restoredFacts, error: inspect(failure, { depth: 12 }) })
      await coordinator.close(); await rm(root, { recursive: true, force: true })
    }
  }
}, 15_000)
