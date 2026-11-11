import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import type { LLMRequest, ModelClient } from "../../llm-seam/src/index.ts"
import { createSessionService, createUnmanagedTaskChildHost } from "@i-harness/session-executor"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createApprovalRulesAdapter } from "../src/approval-rules.ts"
import { approvalPolicyIdentity } from "../src/approval-policy-identity.ts"
import { createToolRegistry, type ApprovalAuthorityProvider, type ToolRegistry } from "@i-harness/core-tools"

// Genuine persisted Task creation and joined child turns take about 9s on native Windows.
const nativeChildTimeout = 30000

it.each([false, true])("allows an owned subagent's unchanged read-only tool with the real Desktop approval adapter attached=%s", async (attach) => {
  const root = await mkdtemp(join(tmpdir(), "ih-child-approval-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "lead" })
  await writeFile(join(root, "fixture.txt"), "Owned read fixture")
  const requests: LLMRequest[] = []
  let parentRounds = 0
  const parent: ModelClient = controlledModel(request => ({ async *stream() {
    if (++parentRounds === 1) yield {type:'tool_call',call:{name:'spawn_agent',args:{task_name:'helper',agent_type:'explore',message:'Read fixture.txt',fork_turns:'none',background:true}}}
    else yield {type:'text/chunk',text:'Parent received reply'}
    yield {type:'end'}
  } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  const child: ModelClient = controlledModel(request => ({ async *stream(request) {
    requests.push(request)
    if (requests.length === 1) yield { type: "tool_call", call: { id: "child-read", name: "read", args: { path: "fixture.txt" } } }
    else yield { type: "text/chunk", text: "Child reply ended" }
    yield { type: "end" }
  } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  const service = createSessionService({ workspace: root, model: parent, sandbox: "read-only", approveAll: true, coordinator, prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),
    roleSelectionFor: (role) => role === "explore" ? { provider: "local", model: "fixture" } : undefined,
    allowSubagentModelSelection: true, resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }),
  })
  try {
    const assembly = await service.assemblyFor("lead")
    const options = { workspace: root, sandbox: "read-only", approval: "dangerous", project: () => undefined, hookConfigs: [], grantPaths: [], pluginAuthority: [] }
    const policy = () => approvalPolicyIdentity(assembly, options)
    const before = policy()
    expect(before).toBeDefined()
    if (attach) createApprovalRulesAdapter({ filePath: join(root, "rules.json"), policyIdentity: policy }).attach(assembly)
    const rootRead = await assembly.tools.prepare({ name: "read", args: { path: "fixture.txt" } }, undefined, { sessionId: "lead" })
    expect(await assembly.tools.dispatch(rootRead)).toEqual({ content: "Owned read fixture", instruction_scope: { status: "reference-only", reason: "outside-root" } })
    await service.submit('lead','Create the fixture subagent',new AbortController().signal)
    expect(assembly.subagentState().agentTable.map(row=>row.path)).toContain('root/helper')
    await vi.waitFor(() => expect(requests).toHaveLength(2), {timeout:10000})
    await vi.waitFor(() => expect(assembly.subagentState().jobs.some((job) => job.status === "completed")).toBe(true), {timeout:10000})
    expect(policy()).toEqual(before)
    const owned = assembly.subagentState().agentTable.find((entry) => entry.path === "root/helper")
    expect(owned?.sessionId).toBeDefined()
    const cold = await coordinator.snapshot!(owned!.sessionId!)
    expect(cold.session.header).toMatchObject({ parentSession: "lead", origin: "subagent" })
    const result = cold.session.events.find((event) => event.type === "tool/result" && event.callId === "child-read")
    expect(result).toMatchObject({ name: "read", envelope: { execution: { outcome: "succeeded", dispatch: "dispatched" }, retention: { kind: "inline", value: { content: "Owned read fixture" } } } })
    expect(result).not.toHaveProperty("isError")
  } finally {
    await service.close()
    await coordinator.close()
    await rm(root, { recursive: true, force: true })
  }
}, nativeChildTimeout)

async function heldChildFixture(constantPolicy = false, codeWrapper = false) {
  const root = await mkdtemp(join(tmpdir(), "ih-child-approval-held-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "lead" })
  await writeFile(join(root, "fixture.txt"), "Owned read fixture")
  let bodies = 0
  let parentRounds = 0
  const parent: ModelClient = controlledModel(request => ({ async *stream() {
    if (++parentRounds === 1) yield {type:'tool_call',call:{name:'spawn_agent',args:{task_name:'helper',agent_type:'explore',message:'Read fixture.txt',fork_turns:'none',background:true}}}
    else yield {type:'text/chunk',text:'Received'}
    yield {type:'end'}
  } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  let childRounds = 0
  const child: ModelClient = controlledModel(request => ({ async *stream() {
    if (++childRounds === 1) yield { type: "tool_call", call: codeWrapper
      ? { id: "held-wrapper", name: "code_exec", args: { code: 'const result = await tools.read({path:"fixture.txt"});text(result.content)' } }
      : { id: "held-read", name: "read", args: { path: "fixture.txt" } } }
    else yield { type: "text/chunk", text: "Reply ended" }
    yield { type: "end" }
  } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  const service = createSessionService({ workspace: root, model: parent, sandbox: "read-only", approveAll: true, coordinator, prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),
    roleSelectionFor: (role) => role === "explore" ? { provider: "local", model: "fixture" } : undefined,
    allowSubagentModelSelection: true, resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }),
    pluginAgents: [{ name: "explore", description: "Owned fixture role", systemPrompt: "Read the fixture", tools: ["read"] }],
    ...(codeWrapper ? { codeMode: { mode: "mixed" as const } } : {}),
  })
  const assembly = await service.assemblyFor("lead")
  const original = assembly.tools.get("read")!
  assembly.tools.unregister("read")
  assembly.tools.register({ ...original, execute: async (args, exec) => { bodies++; return original.execute(args, exec) } })
  const options = { workspace: root, sandbox: "read-only", approval: "dangerous", project: () => undefined as { id: string; name: string; primaryRoot: string; roots: string[] } | undefined, hookConfigs: [], grantPaths: [], pluginAuthority: [] }
  let policyAvailable = true
  createApprovalRulesAdapter({ filePath: join(root, "rules.json"), policyIdentity: () => policyAvailable
    ? constantPolicy ? { workspaceId: root, revision: "unchanged-root" } : approvalPolicyIdentity(assembly, options)
    : undefined }).attach(assembly)
  let childRegistry: ToolRegistry | undefined
  if (codeWrapper) {
    const mount = assembly.ctx.scope.mount
    assembly.ctx.scope.mount = () => {
      const childCtx = mount()
      const inherited = childCtx.services.get<ApprovalAuthorityProvider>("approval/authority")
      childCtx.services.register("approval/authority", (input: Parameters<ApprovalAuthorityProvider>[0]) => {
        childRegistry = input.registry
        return inherited(input)
      })
      return childCtx
    }
  }
  const release = Promise.withResolvers<void>()
  let entered = false, run: Promise<unknown> | undefined
  assembly.ctx.onCascade("tools/execute", async (input, next) => {
    const call = input as { name: string; exec: { sessionId?: string } }
    if (call.name === (codeWrapper ? "code_exec" : "read") && call.exec.sessionId !== "lead") { entered = true; await release.promise }
    return next()
  })
  return {
    assembly, service, coordinator, options, original,
    bodies: () => bodies,
    childRegistry: () => childRegistry,
    missingPolicy: () => { policyAvailable = false },
    async spawn() {
      run=service.submit('lead','Create the held fixture subagent',new AbortController().signal)
      void run.catch(()=>{})
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10000, interval: 10 })
      return assembly.subagentState().agentTable.find((entry) => entry.path === "root/helper")!.sessionId!
    },
    release: release.resolve,
    async settled() { await run?.catch(()=>{}); await vi.waitFor(() => expect(assembly.subagentState().jobs.every((job) => job.status !== "running")).toBe(true), {timeout:10000}) },
    async close() { release.resolve(); await run?.catch(()=>{}); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) },
  }
}

it("rejects foreign and spoofed caller identities without blocking the actual owned child", async () => {
  const f = await heldChildFixture()
  await f.coordinator.create({sessionId:'foreign-parent'})
  await f.coordinator.create({sessionId:'child-foreign',parentSession:'foreign-parent',origin:'subagent',seedLength:0})
  const siblingCtx = f.assembly.ctx.scope.mount()
  try {
    const childId = await f.spawn()
    await expect(f.assembly.tools.prepare({ name: 'read', args: {path:'fixture.txt'} }, undefined, {sessionId:'child-foreign'})).rejects.toThrow('Result source host unavailable')
    const spoofed = await f.assembly.tools.prepare({name:'read',args:{path:'fixture.txt'}},undefined,{sessionId:childId})
    await expect(f.assembly.tools.dispatch(spoofed)).rejects.toThrow('prepared approval authority or policy changed before dispatch')
    const sibling = createToolRegistry(siblingCtx)
    sibling.register(f.assembly.tools.get("read")!)
    const spoofedRoot = await sibling.prepare({ name: "read", args: { path: "fixture.txt" } }, undefined, { sessionId: "lead" })
    await expect(sibling.dispatch(spoofedRoot)).rejects.toThrow("prepared approval authority or policy changed before dispatch")
    expect(f.bodies()).toBe(0)
    f.release(); await f.settled()
    expect(f.bodies()).toBe(1)
  } finally { siblingCtx.scope.unmount(); await f.close() }
}, nativeChildTimeout)

it.each([false, true])("only trusts the exact child factory wrapper, same-name replacement=%s", async (replace) => {
  const f = await heldChildFixture(true, true)
  try {
    const childId = await f.spawn()
    const registry = f.childRegistry()!
    expect(registry).toBeDefined()
    expect(f.assembly.subagentState().agentTable[0]).not.toHaveProperty("toolRegistry")
    expect(f.assembly.subagentState().agentTable[0]).not.toHaveProperty("factoryTools")
    let replacementBodies = 0
    let refusal: Promise<void> | undefined
    if (replace) {
      const original = registry.get("code_exec")!
      registry.unregister("code_exec")
      registry.register({ ...original, execute: async () => { replacementBodies++; return "untrusted replacement" } })
      const prepared = await registry.prepare({ name: "code_exec", args: { code: 'text("must not run")' } }, undefined, { sessionId: childId })
      refusal = expect(registry.dispatch(prepared)).rejects.toThrow("prepared approval authority or policy changed before dispatch")
    }
    f.release(); await f.settled(); await refusal
    expect(replacementBodies).toBe(0)
    expect(f.bodies()).toBe(replace ? 0 : 1)
  } finally { await f.close() }
}, nativeChildTimeout)

it.each(["role", "replace", "revoke", "policy", "project", "missing-policy", "stop", "close"] as const)("prevents an owned child tool body after %s while the execution hook awaits", async (change) => {
  const f = await heldChildFixture(change === "role" || change === "replace" || change === "revoke")
  let closing: Promise<void> | undefined
  try {
    await f.spawn()
    if (change === "role") f.assembly.subagentState().roles.find((role) => role.name === "explore")!.tools = []
    if (change === "replace") { f.assembly.tools.unregister("read"); f.assembly.tools.register({ ...f.original }) }
    if (change === "revoke") f.assembly.tools.unregister("read")
    if (change === "policy") f.options.approval = "ask-all"
    if (change === "project") f.options.project = () => ({ id: "changed", name: "Changed", primaryRoot: "changed-root", roots: ["changed-root"] })
    if (change === "missing-policy") f.missingPolicy()
    if (change === "stop") expect(f.assembly.cancelTask("root/helper")).toBe("cancellation-requested")
    if (change === "close") closing = f.service.closeSession("lead")
    if (change === "close") await vi.waitFor(() => expect(f.service.liveAssembly("lead")).toBeUndefined())
    f.release()
    await f.settled()
    await closing
    expect(f.bodies()).toBe(0)
  } finally { f.release(); await closing; await f.close() }
}, nativeChildTimeout)
