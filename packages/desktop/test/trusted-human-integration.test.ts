import { controlledModel } from "../../session-executor/test/controlled-model.ts"
import { expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeJsonlTaskTransitionCoordinator } from "../../session-persistence-jsonl/src/backend-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"
const createSessionCoordinator = (backend: Parameters<typeof composeJsonlTaskTransitionCoordinator>[0], options: Parameters<typeof composeJsonlTaskTransitionCoordinator>[1] = {}) => composeJsonlTaskTransitionCoordinator(backend, { ...options, lock: { enabled: true, ...options.lock } }, taskDocumentStorageContract)
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { createDurableSessionLoader, createSessionService } from "../../session-executor/src/index.ts"
import { createApprovalRulesAdapter } from "../../desktop-gateway/src/approval-rules.ts"
import { approvalPolicyIdentity } from "../../desktop-gateway/src/approval-policy-identity.ts"
import { createInteractionBridge } from "../../desktop-gateway/src/interaction.ts"
import { createDesktopRouter } from "../../desktop-gateway/src/router.ts"
import { createSdkServer } from "@i-harness/sdk/server"
import { encodeFrame, makeRequest, isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { dispatchDesktopRequest, type DesktopIpcDependencies } from "../src/main/ipc.ts"
import { createWorkspaceCatalog } from "../src/main/workspaces.ts"

it("preserves explicit native human remember through the real router into actual guarded filesystem execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-native-human-")), coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "human-owner" }); await writeFile(join(root, "notes.txt"), "old")
  const catalog = createWorkspaceCatalog(join(root, "workspaces.json")), entry = await catalog.open(root)
  const rules = createApprovalRulesAdapter({ filePath: join(root, "rules.json"), policyIdentity: assembly => approvalPolicyIdentity(assembly, {
    workspace: root, sandbox: "workspace-write", approval: "ask-all", project: () => undefined, hookConfigs: [], grantPaths: [], pluginAuthority: [] }) })
  let modelCalls = 0, issued = false
  const model = controlledModel(async function* () {
    if (!issued) { issued = true; yield { type: 'tool_call', call: { id: 'write-' + (++modelCalls), name: 'write', args: { path: 'notes.txt', text: 'human-approved' } } } }
    else yield { type: 'text/chunk', text: 'done' }
    yield { type: 'end' }
  })
  const service = createSessionService({ model, codeMode: { mode: 'off' }, workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), modelPolicy: "test-mock", sandbox: "workspace-write", approvalMode: "ask-all" })
  const bridge = createInteractionBridge(() => {}, { approvalRules: rules })
  const off = service.onAssembly(assembly => {
    bridge.attach(assembly)
  })
  const frames: RpcMessage[] = [], send = (frame: RpcMessage) => frames.push(frame)
  const base = createSdkServer(service, { coordinator, onWrite: send })
  const router = createDesktopRouter(base, send, { workspace: root, interaction: bridge, approvalRules: rules, assertSession: async id => { await coordinator.profile(id) } })
  let sequence = 0
  const request = async (method: string, params: unknown) => {
    const id = ++sequence; await router.handleLine(encodeFrame(makeRequest(id, method, params)))
    const reply = frames.find(frame => "id" in frame && frame.id === id)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  const dependencies = { catalog, runtimes: { get: async () => ({ client: { request }, info: { capabilities: {} } }) } } as unknown as DesktopIpcDependencies
  const native = (value: unknown) => dispatchDesktopRequest(value, dependencies)
  try {
    await request("initialize", {})
    const assembly = await service.assemblyFor('human-owner')
    const first = service.submit('human-owner', 'write notes', AbortSignal.timeout(20000))
    void first.catch(() => {})
    while (!bridge.pending().length) await Promise.race([first.then(() => { throw new Error('Turn completed without approval') }), new Promise<void>(resolve => setImmediate(resolve))])
    const pending = bridge.pending()[0]!, remember = { scope: "session", expiresAt: Date.now() + 60000 }
    await expect(request("desktop/interaction/reply", { sessionId: "human-owner", requestId: pending.requestId, decision: { kind: "approval", approved: true, remember } } )).rejects.toThrow(/trusted/)
    await native({ kind: "desktop/interaction/reply", workspaceId: entry.id, sessionId: "human-owner", requestId: pending.requestId, decision: { kind: "approval", approved: true, remember } })
    await first
    const { readFile } = await import("node:fs/promises")
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("human-approved")
    expect(await native({ kind: "desktop/approval-rules/state", workspaceId: entry.id })).toMatchObject({ rules: [{ scope: { kind: "session", sessionId: "human-owner" } }] })
    await writeFile(join(root, 'notes.txt'), 'after-first-sentinel')
    issued = false
    const second = service.submit('human-owner', 'write again', AbortSignal.timeout(20000)); void second.catch(() => {})
    // Atomic write replaced the protected inode. The old rule must not grant
    // authority over this new file binding, even for identical arguments.
    while (!bridge.pending().length) await Promise.race([second.then(() => { throw new Error('Replacement write completed without fresh approval') }), new Promise<void>(resolve => setImmediate(resolve))])
    const replacement = bridge.pending()[0]!
    expect(replacement.payload).toMatchObject({ name: 'write', remember: { available: true } })
    await native({ kind: 'desktop/approval-rules/revoke', workspaceId: entry.id, ruleId: rules.list(root)[0]!.id })
    await native({ kind: 'desktop/interaction/reply', workspaceId: entry.id, sessionId: 'human-owner', requestId: replacement.requestId, decision: { kind: 'approval', approved: false } })
    await expect(second).rejects.toThrow(/denied by user/)
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('after-first-sentinel')
    expect(service.liveAssembly("human-owner")).toBe(assembly)
  } finally { bridge.close(); off(); await router.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
}, 30_000)
