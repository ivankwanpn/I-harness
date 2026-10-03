import { expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "../../session-persistence/src/index.ts"
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
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), modelPolicy: "test-mock", sandbox: "workspace-write", approvalMode: "ask-all" })
  const bridge = createInteractionBridge(() => {}, { approvalRules: rules })
  const off = service.onAssembly(assembly => bridge.attach(assembly))
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
    const assembly = await service.assemblyFor("human-owner"), call = { name: "write", args: { path: "notes.txt", text: "human-approved" } }
    const waiting = assembly.tools.prepare(call, undefined, { sessionId: "human-owner" })
    while (!bridge.pending().length) await new Promise<void>(resolve => setImmediate(resolve))
    const pending = bridge.pending()[0]!, remember = { scope: "session", expiresAt: Date.now() + 60000 }
    await expect(request("desktop/interaction/reply", { sessionId: "human-owner", requestId: pending.requestId, decision: { kind: "approval", approved: true, remember } })).rejects.toThrow(/trusted/)
    await native({ kind: "desktop/interaction/reply", workspaceId: entry.id, sessionId: "human-owner", requestId: pending.requestId, decision: { kind: "approval", approved: true, remember } })
    await assembly.tools.dispatch(await waiting)
    const { readFile } = await import("node:fs/promises")
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("human-approved")
    expect(await native({ kind: "desktop/approval-rules/state", workspaceId: entry.id })).toMatchObject({ rules: [{ scope: { kind: "session", sessionId: "human-owner" } }] })
    const reused = await assembly.tools.prepare(call, undefined, { sessionId: "human-owner" }); expect(bridge.pending()).toEqual([])
    await native({ kind: "desktop/approval-rules/revoke", workspaceId: entry.id, ruleId: rules.list(root)[0]!.id })
    await expect(assembly.tools.dispatch(reused)).rejects.toThrow(/changed/)
    expect(service.liveAssembly("human-owner")).toBe(assembly)
  } finally { bridge.close(); off(); await router.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
