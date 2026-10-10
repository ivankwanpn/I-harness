import { afterEach, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createAgent, createAgentRegistry, executeToolCalls } from "@i-harness/core-agent"
import { createMockClient } from "@i-harness/llm-mock"
import { createHookRegistry, loadHooksConfig, HookBlockedError, runHookHandler, HookOutputError } from "../src/index.ts"
import { spawnChild } from "../../subagent/src/child.ts"
import { createJobRegistry } from "../../subagent/src/jobs.ts"
import { createAgentTable } from "../../subagent/src/agent-table.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(events: Record<string, string | undefined>, body = "process.stdout.write('{}')", readInput = true) {
  const root = await mkdtemp(join(tmpdir(), "ih-claude-protocol-")); roots.push(root)
  const plugin = join(root, "plugin"), cwd = join(root, "project"), capture = join(root, "capture.jsonl"), release = join(root, "release")
  await mkdir(join(plugin, "hooks"), { recursive: true }); await mkdir(cwd)
  await writeFile(join(plugin, "handler.cjs"), `const fs=require('node:fs');const input=${readInput ? "JSON.parse(fs.readFileSync(0,'utf8'))" : "{}"};const row={...input,pid:process.pid};if(input.transcript_path)row.projected=fs.readFileSync(input.transcript_path,'utf8');fs.appendFileSync(process.env.CAPTURE,JSON.stringify(row)+'\\n');${body}`)
  const hooks = Object.fromEntries(Object.entries(events).map(([event, matcher]) => [event, [{ ...(matcher !== undefined ? { matcher } : {}), hooks: [{ type: "command", command: '"$TEST_NODE" "${CLAUDE_PLUGIN_ROOT}/handler.cjs"' }] }]]))
  const configPath = join(plugin, "hooks", "hooks.json")
  await writeFile(configPath, JSON.stringify({ hooks }))
  const granted = new Set<string>(), approvals = { isApproved: (hash: string) => granted.has(hash), approve: ({ sha256 }: { sha256: string }) => { granted.add(sha256) }, revoke: (hash: string) => { granted.delete(hash) }, list: () => [] }
  const initial = await loadHooksConfig(configPath, plugin, approvals, { claudePluginRoot: plugin })
  const grant = () => { for (const handler of initial) granted.add(handler.spec.trust.sha256) }
  const rows = async (): Promise<Array<Record<string, any>>> => (await readFile(capture, "utf8")).trim().split("\n").filter(Boolean).map(row => JSON.parse(row))
  return { root, plugin, cwd, configPath, capture, release, approvals, initial, grant, rows,
    env: { CAPTURE: capture, RELEASE: release, TEST_NODE: process.execPath.replaceAll("\\", "/") } }
}

async function waitFor(file: string) {
  for (let index = 0; index < 300; index += 1) { if (existsSync(file)) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error(`hook did not reach the gate: ${file}`)
}

it("sends canonical Claude pre/post payloads with the captured call identity and real result", async () => {
  const f = await fixture({ PreToolUse: "Write", PostToolUse: "Write", PermissionRequest: "Write" }); f.grant()
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, session, sessionId: "owner" })
  tools.register({ name: "write", description: "", inputSchema: {}, execute: async () => ({ ok: true, result: "real output" }) })
  try {
    const prepared = await tools.prepare({ name: "write", args: { path: "relative.txt", text: "body" } }, undefined, { session, sessionId: "actual", callId: "call-7" })
    await tools.dispatch(prepared)
    const rows = await f.rows()
    expect(rows.map(row => row.hook_event_name)).toEqual(["PermissionRequest", "PreToolUse", "PostToolUse"])
    expect(rows.every(row => row.session_id === "actual" && row.tool_use_id === "call-7" && row.tool_name === "Write")).toBe(true)
    expect(rows[0]).toMatchObject({ permission_suggestions: [], permission_mode: "default" })
    expect(rows[1]).toMatchObject({ cwd: f.cwd, tool_input: { file_path: join(f.cwd, "relative.txt"), content: "body" } })
    expect(rows[2]).toMatchObject({ tool_response: { ok: true, result: "real output" } })
    expect(rows.every(row => !existsSync(row.transcript_path))).toBe(true)
    const directory = dirname(rows[0]!.transcript_path)
    await registry.dispose(); expect(existsSync(directory)).toBe(false)
  } finally { await registry.dispose() }
})

it("does not run a Bash matcher for captured PowerShell and keeps the post alias after a preference change", async () => {
  const f = await fixture({ PreToolUse: "^Bash$", PostToolUse: "^PowerShell$" }); f.grant()
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin })
  let dialect: "posix" | "powershell" = "powershell"
  tools.register({ name: "shell", description: "", inputSchema: {}, commandDialect: () => dialect, execute: async () => { dialect = "posix"; return { stdout: "done" } } })
  try {
    await tools.execute({ name: "shell", args: { command: "Get-Date" } })
    const rows = await f.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ hook_event_name: "PostToolUse", tool_name: "PowerShell", tool_input: { command: "Get-Date" }, tool_response: { stdout: "done" } })
  } finally { await registry.dispose() }
})

it("an unapproved Claude permission declaration neither runs nor denies an independent tool", async () => {
  const f = await fixture({ PermissionRequest: "*" }, 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"deny"}}}))')
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, report: () => {} })
  tools.register({ name: "read", description: "", inputSchema: {}, execute: async () => ({ completed: true }) })
  try {
    expect(await tools.execute({ name: "read", args: {} })).toMatchObject({ output: { completed: true } })
    expect(existsSync(f.capture)).toBe(false)
  } finally { await registry.dispose() }
})

it("Claude permission allow cannot override an IH authority guard", async () => {
  const f = await fixture({ PermissionRequest: "*" }, 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"allow"}}}))'); f.grant()
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin })
  let bodyRan = false
  ctx.guard("tools/execute", () => "owner revoked")
  tools.register({ name: "write", description: "", inputSchema: {}, execute: async () => { bodyRan = true; return {} } })
  try {
    await expect(tools.execute({ name: "write", args: {} })).rejects.toThrow("owner revoked")
    expect(bodyRan).toBe(false)
    expect((await f.rows())[0]).toMatchObject({ hook_event_name: "PermissionRequest" })
  } finally { await registry.dispose() }
})

it("a trusted SubagentStop reads the actual child's transcript and returns continuation across the parent scope", async () => {
  const f = await fixture({ Stop: undefined, SubagentStop: "Explore" }, 'process.stdout.write(JSON.stringify(input.last_assistant_message==="child draft"?{decision:"block",reason:"Finish child verification."}:{}))'); f.grant()
  const ctx = createContext(), parentSession = createSession(), childSession = createSession()
  append(parentSession, { type: "assistant/message", text: "ROOT_SECRET_NOT_CHILD" })
  append(childSession, { type: "assistant/message", text: "ROOT_SECRET_NOT_CHILD" })
  childSession.header = { origin: "subagent", parentSession: "parent", seedLength: 1 }
  const parentBefore = JSON.stringify(parentSession.events)
  const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, session: parentSession, sessionId: "parent" })
  const child = ctx.scope.mount(); child.services.register("hooks/agent-type", "explore")
  const agent = createAgent(child, { session: childSession, sessionId: "child", tools: createToolRegistry(child), systemPrompt: "test",
    model: createMockClient([{ role: "assistant", text: "child draft" }, { role: "assistant", text: "child complete" }]),
  })
  try {
    expect(await agent.run("child task")).toMatchObject({ finalText: "child complete", turns: 2 })
    const rows = await f.rows()
    expect(rows.map(row => row.hook_event_name)).toEqual(["SubagentStop", "SubagentStop"])
    expect(rows.map(row => row.stop_hook_active)).toEqual([false, true])
    expect(rows.every(row => row.session_id === "child" && row.agent_id === "child" && row.agent_type === "Explore")).toBe(true)
    expect(rows[0]!.projected).toContain("child draft")
    expect(rows.every(row => !row.projected.includes("ROOT_SECRET_NOT_CHILD"))).toBe(true)
    expect(JSON.stringify(parentSession.events)).toBe(parentBefore)
  } finally { await registry.dispose() }
})

it("grant revocation while a pre-tool command waits prevents its body and stale feedback", async () => {
  const f = await fixture({ PreToolUse: "*" }, '(async()=>{while(!fs.existsSync(process.env.RELEASE))await new Promise(r=>setTimeout(r,10));process.stdout.write(JSON.stringify({systemMessage:"stale feedback"}))})()'); f.grant()
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, session })
  let bodyRan = false
  tools.register({ name: "write", description: "", inputSchema: {}, execute: async () => { bodyRan = true; return {} } })
  try {
    const pending = tools.execute({ name: "write", args: {} })
    await waitFor(f.capture)
    f.approvals.revoke(f.initial[0]!.spec.trust.sha256)
    await writeFile(f.release, "release")
    await expect(pending).rejects.toBeInstanceOf(HookBlockedError)
    expect(bodyRan).toBe(false)
  } finally { await registry.dispose() }
})

it("owner cancellation interrupts a running Stop command and prevents another model request", async () => {
  const f = await fixture({ Stop: undefined }, 'setTimeout(()=>process.stdout.write(JSON.stringify({decision:"block",reason:"late continuation"})),1000)'); f.grant()
  const ctx = createContext(), session = createSession(), controller = new AbortController()
  const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, session, sessionId: "s", report: () => {} })
  const agent = createAgent(ctx, { session, sessionId: "s", tools: createToolRegistry(ctx), systemPrompt: "test", model: createMockClient([{ role: "assistant", text: "draft" }]) })
  try {
    const pending = agent.run("task", controller.signal)
    await waitFor(f.capture); controller.abort()
    await expect(pending).rejects.toThrow("agent aborted")
    expect(session.events.filter(event => event.type === "step/start")).toHaveLength(1)
  } finally { await registry.dispose() }
})

it("a large input pipe failure during owner cancellation still terminates and drains the child", async () => {
  const f = await fixture({ PreToolUse: undefined }, "process.stdin.destroy();setTimeout(()=>process.stdout.write('{}'),1000)", false); f.grant()
  const controller = new AbortController()
  const pending = runHookHandler(f.initial[0]!.spec, { event: "pre-tool", tool: { name: "write", args: { text: "x".repeat(512 * 1024) } } }, f.plugin,
    { env: f.env, cwd: f.cwd, signal: controller.signal }).then(() => "resolved", error => error)
  await waitFor(f.capture); controller.abort()
  expect(await pending).toBeInstanceOf(HookOutputError)
  // The working directory can be removed immediately only once the owned
  // subprocess has actually exited; an early promise rejection leaves it busy.
  await rm(f.cwd, { recursive: true, force: true })
})

it("an unserializable trusted context closes the owned process instead of abandoning an open input pipe", async () => {
  const f = await fixture({ PreToolUse: undefined }, "process.stdin.destroy();setTimeout(()=>process.stdout.write('{}'),1000)", false); f.grant()
  const args: { self?: unknown } = {}; args.self = args
  await expect(runHookHandler(f.initial[0]!.spec, { event: "pre-tool", tool: { name: "write", args } }, f.plugin, { env: f.env, cwd: f.cwd })).rejects.toThrow(/circular|serialize|context/)
  await rm(f.cwd, { recursive: true, force: true })
})

it("delivers lifecycle matcher fields and payloads for notifications and session end", async () => {
  const f = await fixture({ Notification: "^idle_prompt$", SessionEnd: "^prompt_input_exit$" }); f.grant()
  const ctx = createContext(), session = createSession()
  const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, session, sessionId: "owner" })
  try {
    await registry.fire("notification", { message: "Waiting for user", sessionId: "actual", notificationType: "idle_prompt", session })
    await registry.fire("session/end", { sessionId: "actual", reason: "prompt_input_exit", session })
    const rows = await f.rows()
    expect(rows).toMatchObject([
      { hook_event_name: "Notification", session_id: "actual", notification_type: "idle_prompt", message: "Waiting for user" },
      { hook_event_name: "SessionEnd", session_id: "actual", reason: "prompt_input_exit" },
    ])
  } finally { await registry.dispose() }
})

it("keeps stable independent identities for ephemeral root and child Stop hooks", async () => {
  const f = await fixture({ Stop: undefined, SubagentStop: undefined }, 'process.stdout.write(JSON.stringify(input.last_assistant_message.endsWith("draft")?{decision:"block",reason:"Continue verification."}:{}))'); f.grant()
  const ctx = createContext(), parentSession = createSession(), childSession = createSession()
  childSession.header = { origin: "subagent", seedLength: 0 }
  const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, session: parentSession, sessionId: "stable-root-hook-id" })
  const rootAgent = createAgent(ctx, { session: parentSession, tools: createToolRegistry(ctx), systemPrompt: "test", model: createMockClient([{ role: "assistant", text: "root draft" }, { role: "assistant", text: "root complete" }]) })
  const child = ctx.scope.mount(); child.services.register("hooks/agent-type", "explore")
  const childAgent = createAgent(child, { session: childSession, tools: createToolRegistry(child), systemPrompt: "test", model: createMockClient([{ role: "assistant", text: "child draft" }, { role: "assistant", text: "child complete" }]) })
  try {
    await rootAgent.run("root task"); await childAgent.run("child task")
    const rows = await f.rows()
    expect(rows.slice(0, 2).map(row => row.session_id)).toEqual(["stable-root-hook-id", "stable-root-hook-id"])
    const childId = rows[2]!.session_id
    expect(childId).toBeTruthy()
    expect(childId).not.toBe("stable-root-hook-id")
    expect(rows[3]!.session_id).toBe(childId)
    expect(rows.slice(2).every(row => row.agent_id === childId)).toBe(true)
  } finally { await registry.dispose() }
})

it.each(["before post starts", "while post runs"] as const)("retains a completed real write when the owner cancels %s", async timing => {
  const f = await fixture({ PostToolUse: undefined }, "setTimeout(()=>process.stdout.write('{}'),1000)"); f.grant()
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), owner = new AbortController()
  const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, session })
  const path = join(f.cwd, "written.txt")
  tools.register({ name: "write", description: "", inputSchema: {}, execute: async () => {
    await writeFile(path, "real")
    if (timing === "before post starts") owner.abort()
    return { completed: true, bytesWritten: 4 }
  } })
  try {
    const pending = executeToolCalls(ctx, session, tools, [{ callId: "written", name: "write", args: { path, text: "real" } }], { maxParallel: 1, signal: owner.signal })
    if (timing === "while post runs") { await waitFor(f.capture); owner.abort() }
    await expect(pending).rejects.toThrow("agent aborted")
    expect(await readFile(path, "utf8")).toBe("real")
    expect(session.events.filter(event => event.type === "tool/result")).toMatchObject([
      { callId: "written", output: { completed: true, bytesWritten: 4 } },
    ])
    if (timing === "before post starts") expect(existsSync(f.capture)).toBe(false)
  } finally { await registry.dispose() }
})

it("a real ephemeral spawnChild preserves explicit model inheritance while its hooks use child lineage and owned transcript", async () => {
  const f = await fixture({ Stop: undefined, SubagentStop: undefined }, 'process.stdout.write(JSON.stringify(input.hook_event_name==="SubagentStop"&&input.last_assistant_message==="draft"?{decision:"block",reason:"Verify child work"}:{}))'); f.grant()
  const ctx = createContext(), parent = createSession(), jobs = createJobRegistry(), table = createAgentTable()
  append(parent, { type: "turn/start" }); append(parent, { type: "user/message", text: "parent task" })
  append(parent, { type: "assistant/message", text: "ROOT_SECRET_PARENT" }); append(parent, { type: "turn/end" })
  const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, session: parent, sessionId: "parent" })
  const script = createMockClient([{ role: "assistant", text: "draft" }, { role: "assistant", text: "verified" }])
  const requests: Parameters<typeof script.stream>[0][] = []
  let childPath: string | undefined
  try {
    const spawned = await spawnChild({ taskName: "ephemeral", message: "child task", parentPath: "root", parentRegistry: createToolRegistry(ctx), parentSession: parent, parentCtx: ctx,
      role: { name: "explore", description: "test", systemPrompt: "test", tools: [] }, parentModel: { async *stream(request) { requests.push(structuredClone(request)); yield* script.stream(request) } },
      resolveModel: async () => ({ status: "unconfigured", reason: "unused" }), jobs, table, agents: createAgentRegistry(), forkTurns: "all" })
    childPath = spawned.path
    await table.get(childPath)!.followupChain
    const rows = await f.rows()
    expect(rows.map(row => row.hook_event_name)).toEqual(["SubagentStop", "SubagentStop"])
    expect(rows.some(row => row.projected.includes("ROOT_SECRET_PARENT"))).toBe(false)
    expect(table.get(childPath)?.finalText).toBe("verified")
    expect(requests[0]!.messages.some(message => typeof message.content === "string" && message.content.includes("ROOT_SECRET_PARENT"))).toBe(true)
    expect(table.get(childPath)?.session.header).toMatchObject({ origin: "subagent", seedLength: 4, delegationDepth: 1 })
  } finally { await (childPath ? table.get(childPath)?.dispose?.() : undefined); await registry.dispose() }
})
