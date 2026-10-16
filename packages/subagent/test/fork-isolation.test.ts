import { expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { registerExec } from "@i-harness/exec"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { registerSubagent } from "../src/index.ts"
import { spawnChild } from "../src/child.ts"
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator, SessionForkUnavailableError } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createAgentTable } from '../src/agent-table.ts'
import { createJobRegistry } from '../src/jobs.ts'
import { forkTurns } from '../src/fork.ts'

it('refuses last-one-turn replacement tails before actual child creation or model resolution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f2-partial-child-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const ctx = createContext(), parentRegistry = createToolRegistry(ctx), table = createAgentTable(), jobs = createJobRegistry(), agents = createAgentRegistry()
  const parentSession: import('@i-harness/core-session').Session = { formatVersion: 7, events: [
    { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, text: 'H1' }, { type: 'step/start', seq: 2 }, { type: 'assistant/message', seq: 3, text: 'E1' }, { type: 'step/end', seq: 4 }, { type: 'turn/end', seq: 5 },
    { type: 'turn/start', seq: 6 }, { type: 'user/message', seq: 7, text: 'H2' }, { type: 'step/start', seq: 8 }, { type: 'assistant/message', seq: 9, text: 'tail' }, { type: 'step/end', seq: 10 }, { type: 'turn/end', seq: 11 },
    { type: 'compaction/replacement', version: 1, seq: 12, replacementId: 'partial', text: 'S', coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] }], insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } },
  ] }
  const create = vi.spyOn(coordinator, 'create'), resolve = vi.fn(async () => ({ status: 'unconfigured' as const, reason: 'unused' }))
  let sends = 0
  try {
    expect(forkTurns(parentSession.events, Infinity, 7).at(-1)).toMatchObject({ type: 'compaction/replacement' })
    await expect(spawnChild({ taskName: 'partial', message: 'instruction', parentPath: 'root', parentCtx: ctx, parentSession, parentRegistry,
      role: { name: 'observer', description: '', systemPrompt: 'Observe', tools: [] }, parentModel: { async *stream() { sends++; yield { type: 'end' } } }, resolveModel: resolve,
      table, jobs, agents, forkTurns: 1, childSessions: { coordinator, parentSessionId: 'parent' },
    })).rejects.toBeInstanceOf(SessionForkUnavailableError)
    expect(create).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled(); expect(sends).toBe(0)
    expect(await coordinator.list()).toEqual([])
    expect(table.entries().size).toBe(0); expect(jobs.listAll()).toEqual([])
  } finally { await coordinator.close(); await ctx.scope.unmount() }
})

it.each([
  { fork: undefined, first: false, last: false },
  { fork: "none", first: false, last: false },
  { fork: "all", first: true, last: true },
  { fork: 1, first: false, last: true },
  { fork: "1", first: false, last: true },
] as const)("spawn_agent separates its own identity and tool surface with fork_turns=$fork", async ({ fork, first, last }) => {
  const ctx = createContext(), registry = createToolRegistry(ctx), parentSession = createSession()
  registry.register({ name: "read", description: "Read child fixture", inputSchema: {}, isReadOnly: true, execute: async () => "read" })
  registry.register({ name: "parent_only", description: "Parent capability", inputSchema: {}, execute: async () => "parent" })
  for (const text of ["Parent first sentinel", "Parent last sentinel"]) {
    append(parentSession, { type: "turn/start" })
    append(parentSession, { type: "user/message", text })
    append(parentSession, { type: "tool/call", callId: text, name: "parent_only", args: {} })
    append(parentSession, { type: "tool/result", callId: text, name: "parent_only", output: "Parent performed work" })
    append(parentSession, { type: "assistant/message", text: "Parent action report" })
    append(parentSession, { type: "turn/end" })
  }
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) { requests.push(request); yield { type: "text/chunk", text: "Child report" }; yield { type: "end" } } }
  const state = registerSubagent(ctx, registry, { parentSession, parentModel: model, exec: registerExec(ctx), resolveModel: async () => ({ status: "unconfigured", reason: "unused" }) })
  state.roles.register({ name: "observer", description: "Observe only", systemPrompt: "Investigate the delegated task.", tools: ["read"] })
  try {
    const prepared = await registry.prepare({ name: "spawn_agent", args: { task_name: "observer-child", message: "Child task sentinel", agent_type: "observer", ...(fork === undefined ? {} : { fork_turns: fork }) } })
    await registry.dispatch(prepared)
    await vi.waitFor(() => expect(state.jobs.listAll()[0]?.status).toBe("completed"))
    const request = requests[0]!
    const messages = JSON.stringify(request.messages)
    expect(messages.includes("Parent first sentinel")).toBe(first)
    expect(messages.includes("Parent last sentinel")).toBe(last)
    expect(messages).toContain("Child task sentinel")
    expect(request.tools.map(tool => tool.name)).toEqual(["read"])
    expect(request.systemPrompt).toContain("root/observer-child")
    expect(request.systemPrompt).toContain("observer")
    expect(request.systemPrompt).toContain('Available tools: ["read"]')
    expect(request.systemPrompt).toContain("Parent history is context supplied by the parent")
  } finally { await state.dispose(); await ctx.scope.unmount() }
})

it("direct child spawns also start without parent history when forkTurns is omitted", async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx), parentSession = createSession()
  append(parentSession, { type: "user/message", text: "Parent private sentinel" })
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) { requests.push(request); yield { type: "text/chunk", text: "Done" }; yield { type: "end" } } }
  const state = registerSubagent(ctx, registry, { parentSession, parentModel: model, exec: registerExec(ctx), resolveModel: async () => ({ status: "unconfigured", reason: "unused" }) })
  try {
    await spawnChild({ taskName: "direct", message: "Child task", parentPath: "root", parentRegistry: registry, parentSession, parentCtx: ctx,
      role: { name: "observer", description: "Observe", systemPrompt: "Observe", tools: [] }, parentModel: model,
      resolveModel: async () => ({ status: "unconfigured", reason: "unused" }), jobs: state.jobs, table: state.table, agents: state.agents })
    await vi.waitFor(() => expect(state.jobs.listAll()[0]?.status).toBe("completed"))
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("Parent private sentinel")
  } finally { await state.dispose(); await ctx.scope.unmount() }
})

it.each(["bogus", 0, -1, 1.5])("refuses invalid fork_turns=%s before creating a task or child", async fork => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  const model: ModelClient = { async *stream() { yield { type: "end" } } }
  const state = registerSubagent(ctx, registry, { parentSession: createSession(), parentModel: model, exec: registerExec(ctx), resolveModel: async () => ({ status: "unconfigured", reason: "unused" }) })
  try {
    const prepared = await registry.prepare({ name: "spawn_agent", args: { task_name: "invalid", message: "Task", fork_turns: fork } })
    await expect(registry.dispatch(prepared)).rejects.toThrow("fork_turns must be none, all, or a positive integer")
    expect(state.jobs.listAll()).toEqual([])
    expect(state.table.entries().size).toBe(0)
    expect(state.tasks.list()).toEqual([])
  } finally { await state.dispose(); await ctx.scope.unmount() }
})
