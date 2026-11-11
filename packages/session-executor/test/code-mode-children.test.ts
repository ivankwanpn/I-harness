import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { subscribe } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { createDurableSessionLoader, createSessionService, createUnmanagedTaskChildHost } from "../src/index.ts"
import { registerCodeMode, type CodeModeFactory } from "@i-harness/code-mode"
import { controlledModel } from "./controlled-model.ts"
import { inspect } from 'node:util'
import { createTelemetry, type TelemetryEvent } from '@i-harness/telemetry'
afterEach(() => vi.unstubAllGlobals())

it("ordinary children keep role-local Code Mode through followup and resident reconstruction", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-children-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "parent" })
  const requests: LLMRequest[] = []
  const executionErrors: TelemetryEvent[] = []
  const executionFailed = Promise.withResolvers<never>()
  void executionFailed.promise.catch(() => {})
  const telemetry = createTelemetry([{ onEvent(event) { if (event.type === 'session/error') { executionErrors.push(event); executionFailed.reject(new Error('Original child execution failed: ' + JSON.stringify(event))) } } }])
  const parallelLimits: Array<number | undefined> = []
  const factory: CodeModeFactory = (ctx, tools, mountOptions) => {
    parallelLimits.push(mountOptions.maxParallel)
    return registerCodeMode(ctx, tools, { ...mountOptions, ...(mountOptions.sessionId === "parent" ? { config: { mode: "mixed" as const } } : {}) })
  }
  const child = controlledModel(async function* (request) {
    requests.push(request)
    const last = request.messages.at(-1)
    if (last?.role === "user") yield { type: "tool_call", call: { name: "code_exec", args: { code: 'text(ALL_TOOLS.map(t=>t.name)); text(await tools.list_dir({path:"."})); store("turn",(load("turn")??0)+1); text(load("turn"));' } } }
    else if (last?.role === "tool" && typeof last.content === "string") {
      const output = JSON.parse(last.content)
      if (output.status === "running") yield { type: "tool_call", call: { name: "code_wait", args: { cell_id: output.cell_id } } }
      else yield { type: "text/chunk", text: "child complete" }
    } else throw new Error("Expected original Code observation")
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
    codeModeFactory: factory, maxParallelToolCalls: 1, telemetry,
    approveAll: true, prepareTaskChild: createUnmanagedTaskChildHost({ coordinator, policy: "unmanaged" }), sandbox: "danger-full-access" as const, contextWindow: 100_000, maxOutputTokens: 123,
    pluginAgents: ["probe", "helper"].map(name => ({ name, description: "Code Mode read fixture", systemPrompt: "Read files", tools: ["list_dir", "code_exec", "code_wait"] })),
    additionalTools: [{ name: "secret", description: "Parent secret", inputSchema: { type: "object", properties: {} }, execute: async () => "secret" }],
    roleSelectionFor: () => ({ provider: "fixture", model: "child" }), allowSubagentModelSelection: true,
    resolveRoleModel: async () => ({ status: "ready" as const, binding: { client: child, contextWindow: 100_000, maxOutputTokens: 123 } }),
  }
  let service = createSessionService(options)
  let primaryFailure: unknown, failed = false
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
    const waitTurns = async (count: number) => {
      for (const id of ids) {
        const document = await coordinator.openManagedDocument(id)
        let off: (() => void) | undefined
        try {
          await Promise.race([new Promise<void>(resolve => {
            const reached = () => document.view.events.filter(event => event.type === "turn/end").length >= count
            off = subscribe(document.view, event => { if (event.type === "turn/end" && reached()) resolve() })
            if (reached()) resolve()
          }), executionFailed.promise])
        } finally { off?.() }
      }
      for (const id of ids) {
        await coordinator.flush(id)
        const events = (await coordinator.snapshot!(id)).session.events
        expect(events.filter(e => e.type === "turn/end")).toHaveLength(count)
        expect(events.some(e => e.type === "code/call" && e.name === "list_dir")).toBe(true)
        expect(events.filter(e => e.type === "code/output")).toEqual(expect.arrayContaining([expect.objectContaining({ envelope: expect.objectContaining({
          version: 1, preview: '["list_dir"]', retention: expect.objectContaining({ kind: 'artifact', ref: expect.objectContaining({ codec: 'json-utf8-v1', completeness: 'complete', encodedBytes: 16 }) }),
        }) })]))
      }
    }
    await waitTurns(1)
    expect(parallelLimits).toEqual([1, 1, 1])
    for (const request of requests) {
      expect(request.tools.map(t => t.name)).toEqual(["code_exec", "code_status", "code_wait"])
      expect(request.maxOutputTokens).toBe(123)
    }
    expect(assembly.session.events.some(e => e.type === "code/dispatch")).toBe(false)
    await execute("followup_task", { target: "root/normal", message: "followup" })
    await execute("followup_task", { target: "root/helper", message: "followup" })
    await waitTurns(2)
    const restoredState = assembly.subagentState()
    await service.close()
    service = createSessionService({ ...options, restoredState })
    assembly = await service.assemblyFor("parent")
    await execute("followup_task", { target: "root/normal", message: "restored followup" })
    await execute("followup_task", { target: "root/helper", message: "restored followup" })
    await waitTurns(3)
    for (const id of ids) {
      const events = (await coordinator.snapshot!(id)).session.events
      const numbers = events.filter(e => e.type === "code/output").filter(e => /^\d+$/.test(e.envelope?.preview ?? ''))
      expect(numbers.map(event => event.envelope!.preview)).toEqual(["1", "2", "3"])
      for (const event of numbers) expect(event.envelope).toMatchObject({ version: 1, retention: { kind: 'artifact', ref: { codec: 'json-utf8-v1', completeness: 'complete', encodedBytes: 3 } } })
    }
    expect(executionErrors).toEqual([])
    console.log(JSON.stringify({ control: 'original role-local Code Mode children', turns: 3, values: ['1', '2', '3'], children: ids.length, executionErrors: executionErrors.length }))
  } catch (error) {
    failed = true
    primaryFailure = error
    const diagnostics = []
    for (const id of await coordinator.list()) {
      const events = (await coordinator.snapshot!(id)).session.events
      diagnostics.push({ id, events: events.filter(event => ['turn/start', 'turn/end', 'code/cell', 'context/action', 'context/attempt', 'context/recovery', 'user/message', 'agent/input/admitted', 'tool/result'].includes(event.type)).slice(-35) })
    }
    const diagnosticPath = join(process.env.IH_STRUCTURE_EVIDENCE_ROOT!, 'code-mode-children-boundaries.json')
    await writeFile(diagnosticPath, JSON.stringify({ root, executionErrors, requests: requests.map(request => ({ messages: request.messages, maxOutputTokens: request.maxOutputTokens })), diagnostics }, null, 2))
    console.error('Code Mode child boundary evidence', diagnosticPath)
    console.error('Code Mode child primary failure', inspect(error, { depth: 12 }))
    throw error
  } finally {
    try { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
    catch (cleanup) {
      const diagnosticPath = join(process.env.IH_STRUCTURE_EVIDENCE_ROOT!, 'code-mode-children-cleanup.json')
      await writeFile(diagnosticPath, JSON.stringify({ root, executionErrors, queue: service.queueState('parent'), liveParentEvents: service.liveAssembly('parent')?.session.events, cleanup: inspect(cleanup, { depth: 12 }) }, null, 2))
      console.error('Code Mode child cleanup evidence', diagnosticPath)
      console.error('Code Mode child cleanup failure', inspect(cleanup, { depth: 12 }))
      if (failed) throw new AggregateError([primaryFailure, cleanup], 'Code Mode child assertion and cleanup failed', { cause: primaryFailure })
      throw cleanup
    }
  }
// Two real child births, six Code turns and cold reconstruction take 44s
// in the single-worker native qualification; keep a finite workload budget.
}, 60_000)
