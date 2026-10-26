import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { createDurableSessionLoader, createSessionService } from "../src/index.ts"
import { registerCodeMode, type CodeModeFactory } from "@i-harness/code-mode"
import { controlledModel } from "./controlled-model.ts"
import { inspect } from 'node:util'
import { createTelemetry, type TelemetryEvent } from '@i-harness/telemetry'

afterEach(() => vi.unstubAllGlobals())

it("ordinary and Team children keep role-local Code Mode through followup and resident reconstruction", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-children-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "parent" })
  const requests: LLMRequest[] = []
  const executionErrors: TelemetryEvent[] = []
  const telemetry = createTelemetry([{ onEvent(event) { if (event.type === 'session/error') executionErrors.push(event) } }])
  const parallelLimits: Array<number | undefined> = []
  const factory: CodeModeFactory = (ctx, tools, mountOptions) => {
    parallelLimits.push(mountOptions.maxParallel)
    return registerCodeMode(ctx, tools, mountOptions)
  }
  const child = controlledModel(async function* (request) {
    requests.push(request)
    const last = request.messages.at(-1)
    if (last?.role === "user") yield { type: "tool_call", call: { name: "code_exec", args: { code: 'text(ALL_TOOLS.map(t=>t.name)); text(await tools.list_dir({path:"."})); store("turn",(load("turn")??0)+1); text(load("turn"));' } } }
    else yield { type: "text/chunk", text: "child complete" }
    yield { type: "end" }
  })
  const parent: ModelClient = controlledModel(async function* () { yield { type: "text/chunk", text: "parent" }; yield { type: "end" } })
  const options = {
    workspace: root, model: parent, coordinator, sessionFor: createDurableSessionLoader(coordinator), codeMode: { mode: "only" as const },
    codeModeFactory: factory, maxParallelToolCalls: 1, telemetry,
    team: {}, concurrentSessionTeams: true, sandbox: "danger-full-access" as const, contextWindow: 100_000, maxOutputTokens: 123,
    pluginAgents: ["probe", "teammate"].map(name => ({ name, description: "Code Mode read fixture", systemPrompt: "Read files", tools: ["list_dir", "code_exec", "code_wait"] })),
    additionalTools: [{ name: "secret", description: "Parent secret", inputSchema: { type: "object", properties: {} }, execute: async () => "secret" }],
    roleSelectionFor: () => ({ provider: "fixture", model: "child" }), allowSubagentModelSelection: true,
    resolveRoleModel: async () => ({ status: "ready" as const, binding: { client: child, contextWindow: 100_000, maxOutputTokens: 123 } }),
  }
  let service = createSessionService(options)
  let primaryFailure: unknown, failed = false
  try {
    let assembly = await service.assemblyFor("parent")
    const execute = (name: string, args: unknown) => assembly.tools.get(name)!.execute(args, { sessionId: "parent" })
    await execute("spawn_agent", { task_name: "normal", agent_type: "probe", message: "read normal", fork_turns: "none", background: false })
    await execute("spawn_teammate", { name: "helper", description: "read fixture", prompt: "read teammate", context: "fresh" })
    const rows = (await execute("list_agents", {}) as { agents: Array<{ path: string; sessionId: string }> }).agents
    const ids = ["root/normal", "lead/helper"].map(path => rows.find(row => row.path === path)!.sessionId)
    const waitTurns = async (count: number) => { await vi.waitFor(async () => {
      for (const id of ids) {
        await coordinator.flush(id)
        const events = (await coordinator.snapshot!(id)).session.events
        expect(events.filter(e => e.type === "turn/end")).toHaveLength(count)
        expect(events.some(e => e.type === "code/call" && e.name === "list_dir")).toBe(true)
        expect(events.filter(e => e.type === "code/output")).toEqual(expect.arrayContaining([expect.objectContaining({ envelope: expect.objectContaining({
          version: 1, preview: '["list_dir"]', retention: expect.objectContaining({ kind: 'artifact', ref: expect.objectContaining({ codec: 'json-utf8-v1', completeness: 'complete', encodedBytes: 16 }) }),
        }) })]))
      }
    }, { timeout: 5000 }) }
    await waitTurns(1)
    expect(parallelLimits).toEqual([1, 1, 1])
    for (const request of requests) {
      expect(request.tools.map(t => t.name)).toEqual(["code_exec", "code_status", "code_wait"])
      expect(request.maxOutputTokens).toBe(123)
    }
    expect(assembly.session.events.some(e => e.type === "code/dispatch")).toBe(false)
    await execute("followup_task", { target: "root/normal", message: "followup" })
    await execute("team_followup_task", { target: "helper", message: "followup" })
    await waitTurns(2)
    const restoredState = assembly.subagentState()
    await service.close()
    service = createSessionService({ ...options, restoredState })
    assembly = await service.assemblyFor("parent")
    await execute("followup_task", { target: "root/normal", message: "restored followup" })
    await execute("team_followup_task", { target: "helper", message: "restored followup" })
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
}, 15_000)
