import { afterEach as afterFixture, vi as fixtureVi } from 'vitest'
afterFixture(() => fixtureVi.unstubAllGlobals())
import { controlledModel } from "./controlled-model.ts"
import { subscribe } from '@i-harness/core-session'
import { expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { createDurableSessionLoader, createSessionService } from "../src/index.ts"
import { registerCodeMode, type CodeModeFactory } from "@i-harness/code-mode"
import { inspect } from 'node:util'

it("keeps child outputs and stored state through snapshot-before-close at the exact second-turn receipt boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-children-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "parent" })
  const requests: LLMRequest[] = []
  const parallelLimits: Array<number | undefined> = []
  const factory: CodeModeFactory = (ctx, tools, mountOptions) => {
    parallelLimits.push(mountOptions.maxParallel)
    return registerCodeMode(ctx, tools, mountOptions)
  }
  const child: ModelClient = controlledModel(async function* (request) {
    requests.push(request)
    const last = request.messages.at(-1)
    if (last?.role === "user") yield { type: "tool_call", call: { name: "code_exec", args: { code: 'text(ALL_TOOLS.map(t=>t.name)); text(await tools.list_dir({path:"."})); store("turn",(load("turn")??0)+1); text(load("turn"));' } } }
    else yield { type: "text/chunk", text: "child complete" }
    yield { type: "end" }
  })
  const parent: ModelClient = controlledModel(async function* () { yield { type: "text/chunk", text: "parent" }; yield { type: "end" } })
  const options = {
    workspace: root, model: parent, coordinator, sessionFor: createDurableSessionLoader(coordinator), codeMode: { mode: "only" as const },
    codeModeFactory: factory, maxParallelToolCalls: 1,
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
        expect(events.filter(e => e.type === "code/output")).toEqual(expect.arrayContaining([expect.objectContaining({ content: { type: "text", text: '["list_dir"]' } })]))
      }
    }) }
    await waitTurns(1)
    let boundaryClose: Promise<void> | undefined
    let boundaryState: ReturnType<typeof assembly.subagentState> | undefined
    const endings = new Map(ids.map(id => [id, 1]))
    const boundaryUnsubscribers = await Promise.all(ids.map(async id => subscribe((await coordinator.openManagedDocument(id)).view, event => {
      if (event.type !== 'turn/end') return
      endings.set(id, endings.get(id)! + 1)
      if ([...endings.values()].every(count => count === 2) && !boundaryClose) {
        boundaryState = assembly.subagentState()
        boundaryClose = service.close()
        void boundaryClose.catch(error => console.error('Exact turn-end close failure', inspect(error, { depth: 12 })))
      }
    })))
    expect(parallelLimits).toEqual([1, 1, 1])
    for (const request of requests) {
      expect(request.tools.map(t => t.name)).toEqual(["code_exec", "code_status", "code_wait"])
      expect(request.maxOutputTokens).toBe(123)
    }
    expect(assembly.session.events.some(e => e.type === "code/dispatch")).toBe(false)
    await execute("followup_task", { target: "root/normal", message: "followup" })
    await execute("team_followup_task", { target: "helper", message: "followup" })
    await waitTurns(2)
    const restoredState = boundaryState ?? assembly.subagentState()
    await (boundaryClose ?? service.close())
    for (const unsubscribe of boundaryUnsubscribers) unsubscribe()
    service = createSessionService({ ...options, restoredState })
    assembly = await service.assemblyFor("parent")
    await execute("followup_task", { target: "root/normal", message: "restored followup" })
    await execute("team_followup_task", { target: "helper", message: "restored followup" })
    await waitTurns(3)
    for (const id of ids) {
      const events = (await coordinator.snapshot!(id)).session.events
      const numbers = events.filter(e => e.type === "code/output").map(e => (e as { content: { text?: string } }).content.text).filter(text => /^\d+$/.test(text ?? ""))
      expect(numbers).toEqual(["1", "2", "3"])
    }
  } catch (error) {
    failed = true
    primaryFailure = error
    console.error('Code Mode child primary failure', inspect(error, { depth: 12 }))
    throw error
  } finally {
    try { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
    catch (cleanup) {
      console.error('Code Mode child cleanup failure', inspect(cleanup, { depth: 12 }))
      if (failed) throw new AggregateError([primaryFailure, cleanup], 'Code Mode child assertion and cleanup failed', { cause: primaryFailure })
      throw cleanup
    }
  }
}, 15_000)
