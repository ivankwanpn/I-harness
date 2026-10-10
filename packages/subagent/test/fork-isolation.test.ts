import { expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { registerExec } from "@i-harness/exec"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { registerSubagent } from "../src/index.ts"
import { spawnChild } from "../src/child.ts"

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
