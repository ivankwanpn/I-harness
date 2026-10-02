import { expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createAgentRegistry } from "@i-harness/core-agent"
import { createMockClient } from "@i-harness/llm-mock"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { registerCodeMode } from "@i-harness/code-mode"
import { createAgentTable, type ChildAgentEntry } from "../src/agent-table.ts"
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry } from "../src/roles.ts"
import { spawnChild, type SpawnOptions } from "../src/child.ts"
import { createSubagentTools, driveFollowups, ensureResidentAgent, type SubagentToolDeps } from "../src/tools.ts"
import { registerExec } from "@i-harness/exec"
import { createTaskRegistry } from "../src/task-protocol.ts"

function fixture() {
  const parentCtx = createContext()
  const parentRegistry = createToolRegistry(parentCtx)
  const parentSession = createSession()
  parentRegistry.register({ name: "allowed", description: "Role read", inputSchema: { type: "object", properties: {} }, isReadOnly: true, execute: async () => "role-local" })
  parentRegistry.register({ name: "secret", description: "Parent only", inputSchema: { type: "object", properties: {} }, execute: async () => "secret" })
  const parentMount = registerCodeMode(parentCtx, parentRegistry, { session: parentSession, config: { mode: "only" } })
  const requests: LLMRequest[] = []
  const script = createMockClient([
    { role: "assistant", toolCalls: [{ name: "code_exec", args: { code: 'text(ALL_TOOLS.map(t=>t.name)); text(await tools.allowed({}));' } }] },
    { role: "assistant", text: "done" },
  ])
  const parentModel: ModelClient = { async *stream(request) { requests.push(request); yield* script.stream(request) } }
  const role = { name: "probe", description: "test role", systemPrompt: "Read the allowed tool", tools: ["allowed", "code_exec", "code_wait"] }
  const deps = { parentCtx, parentRegistry, parentSession, parentModel, resolveModel: async () => ({ status: "unconfigured" as const, reason: "unused" }), exec: registerExec(parentCtx), tasks: createTaskRegistry({}), jobs: createJobRegistry(), table: createAgentTable(), agents: createAgentRegistry(), codeModeFactory: registerCodeMode, codeMode: { mode: "only" as const }, contextWindow: 10_000, maxOutputTokens: 123 }
  return { deps, role, parentMount, requests }
}

it("ordinary children mount their own role-scoped Code Mode and never copy parent wrappers", async () => {
  const f = fixture()
  try {
    const spawned = await spawnChild({ ...f.deps, role: f.role, taskName: "probe", message: "read", parentPath: "root", forkTurns: "none" } as SpawnOptions)
    const child = f.deps.table.get(spawned.path)!
    await child.followupChain
    expect(child.error).toBeUndefined()
    expect(child.finalText).toBe("done")
    expect(f.requests[0]!.tools.map(t => t.name)).toEqual(["code_exec", "code_wait"])
    expect(f.requests[0]!.maxOutputTokens).toBe(123)
    const output = child.session.events.find(event => event.type === "code/output")
    expect(output).toMatchObject({ content: { text: '["allowed"]' } })
    expect(child.session.events.some(event => event.type === "code/call" && event.name === "allowed")).toBe(true)
    expect(f.deps.parentSession.events.some(event => event.type === "code/dispatch")).toBe(false)
    await child.dispose?.()
  } finally { await f.parentMount.dispose() }
})

it("disposing a child stops its queued followups from starting fresh turns", async () => {
  const f = fixture()
  let calls = 0
  const model: ModelClient = { async *stream(request) {
    if (++calls === 1) await new Promise<void>((_resolve, reject) => {
      request.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    })
    yield { type: "end" }
  } }
  const entry: ChildAgentEntry = { path: "root/probe", status: "waiting", sessionId: "restored", roleName: f.role.name, session: createSession(), controller: new AbortController(), mailbox: [] }
  const roles = createRoleRegistry(); roles.register(f.role)
  f.deps.table.add(entry.path, entry)
  try {
    expect(await ensureResidentAgent({ ...f.deps, parentModel: model, roles }, entry)).toBe(true)
    append(entry.session, { type: "subagent/inbox", messageId: "one", message: "one" })
    append(entry.session, { type: "subagent/inbox", messageId: "two", message: "two" })
    void driveFollowups(f.deps, entry, entry.sessionId!)
    await vi.waitFor(() => expect(calls).toBe(1))
    await entry.dispose!()
    expect(calls).toBe(1)
  } finally { await entry.dispose?.(); await f.parentMount.dispose() }
})

it("a restored resident mounts a fresh role-local runtime and closes its producers", async () => {
  const f = fixture()
  const entry: ChildAgentEntry = { path: "root/probe", status: "waiting", sessionId: "restored", roleName: f.role.name, session: createSession(), controller: new AbortController(), mailbox: [] }
  const roles = createRoleRegistry(); roles.register(f.role)
  f.deps.table.add(entry.path, entry)
  try {
    expect(await ensureResidentAgent({ ...f.deps, roles } as SubagentToolDeps, entry)).toBe(true)
    await f.deps.agents.get("restored")!.run("read")
    expect(entry.session.events.some(event => event.type === "code/call" && event.name === "allowed")).toBe(true)
    expect(f.deps.parentSession.events.some(event => event.type === "code/dispatch")).toBe(false)
    expect(f.requests[0]!.tools.map(t => t.name)).toEqual(["code_exec", "code_wait"])
    expect(entry.dispose).toBeTypeOf("function")
  } finally { await entry.dispose?.(); await f.parentMount.dispose() }
})

it.each(["followup", "resume"] as const)("interrupt_agent drains live code and allows a later explicit %s on the retained runtime", async (action) => {
  const f = fixture()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let entered = false
  let aborted = false
  f.deps.parentRegistry.get("allowed")!.execute = async (_args, exec) => {
    entered = true
    exec.abortSignal!.addEventListener("abort", () => { aborted = true }, { once: true })
    await held
    return "role-local"
  }
  const model: ModelClient = { async *stream(request) {
    const task = request.messages.findLast(message => message.role === "user")!.content
    if (request.messages.at(-1)?.role === "user") {
      const code = task === "seed" ? 'store("memo","kept");'
        : task === "hold" ? 'await tools.allowed({});'
          : 'text(load("memo")); text(await tools.allowed({}));'
      yield { type: "tool_call", call: { name: "code_exec", args: { code, ...(task === "hold" ? { yield_time_ms: 0 } : {}) } } }
    } else if (task === "hold") {
      await new Promise<void>((_resolve, reject) => request.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
    } else yield { type: "text/chunk", text: "done" }
    yield { type: "end" }
  } }
  const entry: ChildAgentEntry = { path: "root/probe", status: "waiting", sessionId: "live", roleName: f.role.name, session: createSession(), controller: new AbortController(), mailbox: [] }
  const roles = createRoleRegistry(); roles.register(f.role)
  f.deps.table.add(entry.path, entry)
  const deps = { ...f.deps, parentModel: model, roles }
  const tools = createSubagentTools(deps)
  const execute = (name: string, args: unknown) => tools.find(tool => tool.name === name)!.execute(args, {})
  try {
    expect(await ensureResidentAgent(deps, entry)).toBe(true)
    await f.deps.agents.get("live")!.run("seed")
    await execute("followup_task", { target: entry.path, message: "hold" })
    await vi.waitFor(() => expect(entered).toBe(true))
    let interrupted = false
    const interrupt = execute("interrupt_agent", { target: entry.path }).then(result => { interrupted = true; return result })
    await vi.waitFor(() => expect(aborted).toBe(true))
    expect(interrupted).toBe(false)
    release()
    expect(await interrupt).toEqual({ previous_status: "running" })
    await entry.followupChain
    expect(entry.closing).not.toBe(true)
    if (action === "followup") await execute("followup_task", { target: entry.path, message: "after" })
    else {
      await execute("send_message", { target: entry.path, message: "after" })
      expect(await execute("resume_agent", { target: entry.path })).toEqual({ resumed: true })
    }
    await entry.followupChain
    expect(entry.finalText).toBe("done")
    expect(entry.error).toBeUndefined()
    expect(entry.session.events.some(event => event.type === "code/output" && (event.content as { text?: string }).text === "kept")).toBe(true)
    expect(f.deps.parentSession.events.some(event => event.type === "code/call")).toBe(false)
  } finally { release(); await entry.dispose?.(); await f.parentMount.dispose() }
})
