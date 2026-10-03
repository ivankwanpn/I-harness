import { expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
import { createSessionService } from "@i-harness/session-executor"
import { approvalPolicyIdentity } from "../src/approval-policy-identity.ts"
import { createApprovalRulesAdapter } from "../src/approval-rules.ts"

it.each(["sandbox", "approval", "project"] as const)("still refuses actual %s authority changes during an awaited execution hook", async change => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-policy-change-"))
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", codeMode: { mode: "mixed" }, sandbox: "read-only" })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let outcome: Promise<unknown> | undefined
  try {
    const assembly = await service.assemblyFor("owner")
    let roots = [root]
    const options = { workspace: root, sandbox: "read-only", approval: "dangerous", project: () => ({ id: "project", name: "Project", primaryRoot: root, roots }), hookConfigs: [], grantPaths: [], pluginAuthority: [] }
    createApprovalRulesAdapter({ filePath: join(root, "rules.json"), policyIdentity: () => approvalPolicyIdentity(assembly, options) }).attach(assembly)
    assembly.ctx.onCascade("tools/execute", async (_input, next) => { entered.resolve(); await release.promise; return next() })
    const prepared = await assembly.tools.prepare({ name: "list_dir", args: { path: "." } }, undefined, { sessionId: "owner" })
    const dispatch = assembly.tools.dispatch(prepared)
    outcome = dispatch.catch(error => error)
    await entered.promise
    if (change === "sandbox") { service.updateSandboxMode("danger-full-access"); options.sandbox = "danger-full-access" }
    if (change === "approval") options.approval = "ask-all"
    if (change === "project") roots = [root, join(root, "another-root")]
    release.resolve(); expect(String(await outcome)).toMatch(/prepared approval authority or policy changed/)
  } finally { release.resolve(); await outcome; await service.close(); await rm(root, { recursive: true, force: true }) }
})

it("keeps presentation of changing live cell IDs out of pending tool authority during an awaited hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-presentation-"))
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", codeMode: { mode: "mixed" }, sandbox: "read-only" })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let outcome: Promise<{ value?: unknown; error?: unknown }> | undefined
  try {
    const assembly = await service.assemblyFor("owner")
    const options = { workspace: root, sandbox: "read-only", approval: "dangerous", project: () => undefined, hookConfigs: [], grantPaths: [], pluginAuthority: [] }
    const identity = () => approvalPolicyIdentity(assembly, options)
    createApprovalRulesAdapter({ filePath: join(root, "rules.json"), policyIdentity: identity }).attach(assembly)
    const before = identity(), waitDescription = assembly.tools.get("code_wait")!.description
    assembly.ctx.onCascade("tools/execute", async (input, next) => { if ((input as { name: string }).name === "list_dir") { entered.resolve(); await release.promise }; return next() })
    const prepared = await assembly.tools.prepare({ name: "list_dir", args: { path: "." } }, undefined, { sessionId: "owner" })
    outcome = assembly.tools.dispatch(prepared).then(value => ({ value }), error => ({ error }))
    await entered.promise
    const cell = await assembly.tools.execute({ name: "code_exec", args: { code: "await new Promise(()=>{})", yield_time_ms: 0 } })
    const cellId = (cell.output as { cell_id: string }).cell_id
    assembly.executionState!()
    expect(identity()).toEqual(before); expect(assembly.tools.get("code_wait")!.description).toBe(waitDescription)
    await assembly.stopCodeCell!(cellId)
    assembly.executionState!(); expect(identity()).toEqual(before)
    release.resolve(); expect(await outcome).toMatchObject({ value: { entries: [] } })
  } finally { release.resolve(); await outcome; await service.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(["mixed", "only"] as const)("takes a coherent approval authority snapshot when saved %s Code Mode refreshes its schemas", async mode => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-authority-"))
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", codeMode: { mode }, sandbox: "read-only" })
  try {
    const assembly = await service.assemblyFor("owner")
    const options = { workspace: root, sandbox: "read-only", approval: "dangerous", project: () => undefined, hookConfigs: [], grantPaths: [], pluginAuthority: [] }
    const first = approvalPolicyIdentity(assembly, options), second = approvalPolicyIdentity(assembly, options)
    expect(first).toBeDefined(); expect(first).toEqual(second)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(["off", "mixed", "only"] as const)("forwards saved %s Code Mode and normalized limits through the Desktop host", async (mode) => {
  const bodies: Array<{ tools?: Array<{ function: { name: string } }> }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()))
    const delta = mode !== "off" && bodies.length === 1
      ? { tool_calls: [{ index: 0, id: "code-fixture", function: { name: "code_exec", arguments: JSON.stringify({ code: 'text("long result for clamp"); await tools.list_dir({path:"."});' }) } }] }
      : { content: "done" }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const origin = `http://127.0.0.1:${address.port}`
  const originalFetch = globalThis.fetch
  const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== origin) throw new Error("Code Mode fixture refused non-loopback provider request")
    return originalFetch(input, init)
  })
  const root = await mkdtemp(join(tmpdir(), "ih-code-desktop-"))
  const workspace = join(root, "workspace"); await mkdir(workspace)
  const settingsPath = join(root, "settings.json")
  const credentialsPath = join(root, "credentials.json")
  await writeFile(settingsPath, JSON.stringify({ sandboxMode: "read-only", codeMode: { mode, defaultOutputTokens: 1 }, llm: { providers: { fixture: { protocol: "openai-completions", baseURL: `${origin}/v1`, apiKeyEnv: "IH_CODE_FIXTURE_KEY", models: [{ id: "fixture", contextWindow: 272000 }] } }, defaultModel: { provider: "fixture", model: "fixture" } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_CODE_FIXTURE_KEY: "fixture" } }))
  const frames: RpcMessage[] = []
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  let id = 0
  const call = async (method: string, params = {}) => {
    const requestId = ++id
    await host!.handleLine(encodeFrame(makeRequest(requestId, method, params)))
    const reply = frames.find(frame => "id" in frame && frame.id === requestId)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  try {
    host = await createDesktopHost({ workspace, settingsPath, credentialsPath, sessionDir: join(root, "sessions"), onWrite: frame => frames.push(frame) })
    await call("initialize")
    const { sessionId } = await call("session/create") as { sessionId: string }
    await call("session/prompt", { sessionId, prompt: "run fixture" })
    const names = bodies[0]!.tools!.map(tool => tool.function.name)
    if (mode === "only") expect(names).toEqual(["code_exec", "code_wait"])
    else { expect(names).toContain("list_dir"); expect(names.includes("code_exec")).toBe(mode === "mixed") }
    const { events } = await call("session/history", { sessionId, afterSeq: 0, limit: 200 }) as { events: Array<{ type: string; name?: string; state?: string; error?: string; isError?: boolean; output?: unknown }> }
    if (mode !== "off") {
      expect(events.filter(event => event.type === "code/cell" && event.state === "failed")).toEqual([])
      expect(events.some(event => event.type === "code/dispatch")).toBe(true)
      expect(events.find(event => event.type === "code/result" && event.name === "list_dir")).toMatchObject({ output: { entries: [] } })
      expect(events.find(event => event.type === "tool/result")).toMatchObject({ output: { status: "completed", text: "long", truncated: true } })
    } else expect(events.some(event => event.type.startsWith("code/"))).toBe(false)
  } finally {
    await host?.close()
    fetchGuard.mockRestore()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
