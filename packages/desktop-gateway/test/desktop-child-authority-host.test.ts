import { createServer } from "node:http"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { PluginRegistry } from "@i-harness/plugin-registry"
import { createHookTrustStore, sha256ClaudePluginTreeSync } from "@i-harness/hooks"
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
import { createHostFixtureTrace } from "./host-fixture-trace.ts"
import { createHostFixtureModel } from "./host-fixture-model.ts"

it("the real Desktop host registers authority for spawned child and teammate ordinary and Code Mode tool dispatch", async () => {
  const trace = createHostFixtureTrace('desktop-child-authority-host')
  let parentRound = 0
  let toolNumber = 0
  const childRounds = new Map<string, number>()
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    let delta: unknown = { content: "Reply ended" }
    const call = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: `call-${++toolNumber}`, function: { name, arguments: JSON.stringify(args) } }] })
    if (body.model === "parent") {
      if (++parentRound === 1) delta = call("spawn_agent", { task_name: "helper", agent_type: "explore", message: "Read fixture.txt", background: false })
      else if (parentRound === 2) delta = call("spawn_teammate", { name: "helper-team", description: "Read the fixture", prompt: "Read fixture.txt", context: "fresh" })
      else if (parentRound === 3) delta = call("wait_agent", { timeout_ms: 5000 })
    } else {
      const system = JSON.stringify(body.messages[0]?.content)
      const path = system.includes("lead/helper-team") ? "lead/helper-team" : "root/helper"
      const round = (childRounds.get(path) ?? 0) + 1; childRounds.set(path, round)
      if (round === 1) delta = call("read", { path: "fixture.txt" })
      else if (round === 2) delta = call("code_exec", { code: path.startsWith("lead/")
        ? 'const file = await tools.read({path:"fixture.txt"});text(file.content);const team = await tools.list_members({});text(team.members.map(m=>m.name));text(await tools.team_task_list({}))'
        : 'const file = await tools.read({path:"fixture.txt"});text(file.content)' })
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const root = await mkdtemp(join(tmpdir(), "ih-desktop-child-authority-host-")), workspace = join(root, "workspace")
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  try {
  await mkdir(workspace); await writeFile(join(workspace, "fixture.txt"), "Desktop host fixture")
  const registry = new PluginRegistry({ root: join(root, "plugins") })
  await registry.addSource(fileURLToPath(new URL("./fixtures/official-plugins", import.meta.url)))
  await registry.install("Official fixture subset__explanatory-output-style"); await registry.enable("Official fixture subset__explanatory-output-style")
  const plugin = join(root, "plugins", "Official fixture subset__explanatory-output-style")
  createHookTrustStore(join(root, "hook-trust.json")).approve({ sha256: sha256ClaudePluginTreeSync(plugin), script: plugin, handlerId: "claude:SessionStart:0:0" })
  const settingsPath = join(root, "settings.json")
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, approvalMode: "full-access", sandboxMode: "danger-full-access", plugins: { subagentModel: true }, codeMode: { mode: "mixed" },
    agents: { roles: { explore: { provider: "fixture", model: "child" }, teammate: { provider: "fixture", model: "child" } } },
    llm: { providers: { fixture: { protocol: "openai-completions", baseURL: `${origin}/v1`, models: [{ id: "parent", contextWindow: 272000 }, { id: "child", contextWindow: 272000 }] } }, defaultModel: { provider: "fixture", model: "parent" } } }))
  const frames: RpcMessage[] = []
  host = await trace.run('host/create', () => createDesktopHost({ workspace, settingsPath, sessionDir: join(root, "sessions"), buildProviderClient: createHostFixtureModel(origin, trace), onWrite: frame => { trace.observe(frame); frames.push(frame) } }))
  let id = 0
  async function rpc(method: string, params = {}): Promise<unknown> {
    const requestId = ++id; await trace.run(method, () => host!.handleLine(encodeFrame(makeRequest(requestId, method, params))))
    const reply = frames.find(frame => "id" in frame && frame.id === requestId)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
    await rpc("initialize")
    await rpc("desktop/provider/mutate", { action: "key/set", id: "fixture", value: "test-only-key" })
    const { sessionId } = await rpc("session/create") as { sessionId: string }
    await rpc("session/prompt", { sessionId, prompt: "Delegate the fixture checks" })
    const catalog = await rpc("desktop/session/subagents/list", { sessionId }) as { agents: { path: string; sessionId: string }[] }
    expect(catalog.agents.map(agent => agent.path).sort()).toEqual(["lead/helper-team", "root/helper"])
    for (const agent of catalog.agents) {
      const { events } = await rpc("desktop/session/subagents/history", { sessionId, childSessionId: agent.sessionId }) as { events: { type: string; name?: string; output?: unknown; isError?: boolean }[] }
      const results = events.filter(event => event.type === "tool/result")
      expect(results.some(event => event.isError)).toBe(false)
      expect(results.find(event => event.name === "read")).toMatchObject({ output: { content: "Desktop host fixture" } })
      expect(JSON.stringify(results.find(event => event.name === "code_exec")?.output)).toContain("Desktop host fixture")
      if (agent.path.startsWith("lead/")) expect(JSON.stringify(results.find(event => event.name === "code_exec")?.output)).toContain("helper-team")
    }
  } finally {
    try { await trace.run('host/close', async () => { await host?.close() }) }
    finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    }
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
