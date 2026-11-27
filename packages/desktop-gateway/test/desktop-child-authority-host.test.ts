import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { PluginRegistry } from "@i-harness/plugin-registry"
import { createHookTrustStore, sha256ClaudePluginTreeSync } from "@i-harness/hooks"
import { encodeFrame, isRpcSuccess, makeRequest, type HistoryRange, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
import { createHostFixtureTrace } from "./host-fixture-trace.ts"
import { createHostFixtureModel } from "./host-fixture-model.ts"
import { append, createSession, deriveMessages, fromJSONL, toJSONL } from '@i-harness/core-session'
import { createLoopbackProvider, writeSplitSse } from "../../core-agent/test/helpers/provider-loopback.ts"

function hostRpc(host: Awaited<ReturnType<typeof createDesktopHost>>, frames: RpcMessage[], trace: ReturnType<typeof createHostFixtureTrace>) {
  let nextId = 0
  return async (method: string, params = {}): Promise<unknown> => {
    const requestId = ++nextId
    await trace.run(method, () => host.handleLine(encodeFrame(makeRequest(requestId, method, params))))
    const reply = frames.find(frame => "id" in frame && frame.id === requestId)
    if (!isRpcSuccess(reply)) throw new Error(method + ": " + JSON.stringify(reply))
    return reply.result
  }
}

it("the real Desktop host registers authority for independent child ordinary and Code Mode tool dispatch", async () => {
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
      else if (parentRound === 2) delta = call("spawn_agent", { task_name: "helper-second", agent_type: "explore", message: "Read fixture.txt", background: false })
    } else {
      const system = JSON.stringify(body.messages[0]?.content)
      const path = system.includes("root/helper-second") ? "root/helper-second" : "root/helper"
      const round = (childRounds.get(path) ?? 0) + 1; childRounds.set(path, round)
      if (round === 1) delta = call("read", { path: "fixture.txt" })
      else if (round === 2) delta = call("code_exec", { code: 'const file = await tools.read({path:"fixture.txt"});text(file.content)' })
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: typeof delta === 'object' && delta !== null && 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
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
    agents: { roles: { explore: { provider: "fixture", model: "child" } } },
    llm: { providers: { fixture: { protocol: "openai-completions", baseURL: `${origin}/v1`, models: [{ id: "parent", contextWindow: 272000 }, { id: "child", contextWindow: 272000 }] } }, defaultModel: { provider: "fixture", model: "parent" } } }))
  const frames: RpcMessage[] = []
  host = await trace.run('host/create', () => createDesktopHost({ workspace, settingsPath, sessionDir: join(root, "sessions"), buildProviderClient: createHostFixtureModel(origin, trace), onWrite: frame => { trace.observe(frame); frames.push(frame) } }))
  const rpc = hostRpc(host, frames, trace)
    await rpc("initialize")
    await rpc("desktop/provider/mutate", { action: "key/set", id: "fixture", value: "test-only-key" })
    const { sessionId } = await rpc("session/create") as { sessionId: string }
    await rpc("desktop/session/project/bind", {sessionId})
    await rpc("session/prompt", { sessionId, prompt: "Delegate the fixture checks" })
    const catalog = await rpc("desktop/session/subagents/list", { sessionId }) as { agents: { path: string; sessionId: string }[] }
    expect(catalog.agents.map(agent => agent.path).sort()).toEqual(["root/helper", "root/helper-second"])
    for (const agent of catalog.agents) {
      const { events } = await rpc("desktop/session/subagents/history", { sessionId, childSessionId: agent.sessionId }) as HistoryRange
      const results = events.filter(event => event.type === "tool/result")
      expect(results.length).toBeGreaterThanOrEqual(2)
      // Validate copies of the genuine matching DTOs through public intake and
      // cold decoding. This selection is not the complete original child/F1 log.
      const selection = createSession()
      for (const result of results) {
        const call = events.find(event => event.type === 'tool/call' && event.callId === result.callId)
        if (call?.type !== 'tool/call') throw new Error('Expected genuine matching child tool call')
        expect(call.name).toBe(result.name)
        append(selection, call)
        append(selection, result)
        if (!result.envelope) throw new Error('Expected retained child result envelope')
        expect(result.envelope.execution).toEqual({ outcome: 'succeeded', dispatch: 'dispatched' })
        expect(Buffer.byteLength(JSON.stringify(result.envelope))).toBeLessThanOrEqual(64000)
      }
      const cold = fromJSONL(toJSONL(selection))
      expect(cold.events).toEqual(selection.events)
      for (const message of deriveMessages(cold).filter(message => message.role === 'tool'))
        expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(64000)
      const inlineValue = (name: string) => {
        const result = cold.events.find(event => event.type === 'tool/result' && event.name === name)
        if (result?.type !== 'tool/result' || result.envelope?.retention.kind !== 'inline') throw new Error(`Expected complete inline ${name} fixture value`)
        return result.envelope.retention.value
      }
      expect(inlineValue('read')).toEqual({ content: 'Desktop host fixture', instruction_scope: { status: 'queued' } })
      const text = 'Desktop host fixture'
      // The complete small observation is inline. Its nested text index has
      // separate retained-code qualification; this test exercises tool authority.
      expect(inlineValue('code_exec')).toMatchObject({ status: 'completed', text, truncated: false,
        textRetention: { stored: true, complete: true, omittedBytes: 0, truncated: false, admittedBytes: Buffer.byteLength(text) } })
    }
  } finally {
    try { await trace.run('host/close', async () => { await host?.close() }) }
    finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    }
    await rm(root, { recursive: true, force: true })
  }
// Two native inherited-history births each execute ordinary read and Code Mode;
// the complete measured workload, history reads, and cleanup took 35–42s.
}, 60_000)

it.skipIf(process.platform !== "win32")("a real restricted Task child searches its bound project and persists both tool results", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-desktop-child-file-search-"))
  const workspace = join(root, "workspace"), sibling = join(root, "other"), sessions = join(root, "sessions")
  const settingsPath = join(root, "settings.json"), credentialsPath = join(root, "credentials.json")
  const allowed = "scope marker in the bound project", decoy = "scope marker in the other project"
  const childAnswer = "Child search finished", parentAnswer = "Parent received child search"
  const trace = createHostFixtureTrace("desktop-task-child-file-search")
  const completes = { type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 6 } } }
  const text = (delta: string) => ({ type: "response.output_text.delta", delta })
  const call = (name: string, args: object, index = 0) => {
    const item = { id: name, call_id: name, type: "function_call", name, arguments: "" }
    const encoded = JSON.stringify(args)
    return [
      { type: "response.output_item.added", output_index: index, item },
      { type: "response.function_call_arguments.done", item_id: item.id, arguments: encoded },
      { type: "response.output_item.done", output_index: index, item: { ...item, arguments: encoded } },
    ]
  }
  const server = await createLoopbackProvider("/v1/responses", [
    async (response, request) => {
      expect(request.body.model).toBe("fixture-parent")
      await writeSplitSse(response, [...call("spawn_agent", {
        task_name: "scout", agent_type: "explore", message: "Search this project for the marker.", fork_turns: "none", background: false,
      }), completes])
    },
    async (response, request) => {
      expect(request.body.model).toBe("fixture-child")
      const catalog = request.body.tools as Array<{ name: string }> | undefined
      expect(catalog?.map(tool => tool.name).sort() ?? []).toEqual(["glob", "grep"])
      await writeSplitSse(response, [
        ...call("glob", { pattern: "*.txt" }),
        ...call("grep", { pattern: "scope marker", mode: "literal" }, 1),
        completes,
      ])
    },
    async (response, request) => {
      expect(request.body.model).toBe("fixture-child")
      const input = JSON.stringify(request.body.input)
      expect(input).toContain(allowed)
      expect(input).not.toContain(decoy)
      await writeSplitSse(response, [text(childAnswer), completes])
    },
    async (response, request) => {
      expect(request.body.model).toBe("fixture-parent")
      expect(JSON.stringify(request.body.input)).toContain(childAnswer)
      await writeSplitSse(response, [text(parentAnswer), completes])
    },
  ])
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  try {
    await Promise.all([mkdir(workspace), mkdir(sibling), mkdir(join(root, "plugins"))])
    await Promise.all([
      writeFile(join(workspace, "found.txt"), allowed + "\n"),
      writeFile(join(sibling, "found.txt"), decoy + "\n"),
      writeFile(join(sibling, "other.txt"), decoy + "\n"),
      writeFile(join(root, "plugins", "state.json"), JSON.stringify({ version: 1, sources: [], plugins: [] })),
      writeFile(credentialsPath, JSON.stringify({ refs: { IH_CHILD_FILE_SEARCH_FIXTURE_KEY: "loopback-only" } })),
      writeFile(settingsPath, JSON.stringify({
        autoTitle: false, approvalMode: "dangerous", sandboxMode: "read-only", windowsSandboxBackend: "legacy", codeMode: { mode: "off" },
        plugins: { subagentModel: true },
        agents: { roles: { explore: { provider: "fixture", model: "fixture-child" } }, roleTools: { explore: ["glob", "grep"] } },
        llm: { defaultModel: { provider: "fixture", model: "fixture-parent" }, providers: { fixture: {
          baseURL: server.baseUrl, protocol: "openai-responses", apiKeyEnv: "IH_CHILD_FILE_SEARCH_FIXTURE_KEY",
          models: ["fixture-parent", "fixture-child"].map(id => ({ id, contextWindow: 128_000 })),
        } } },
      })),
    ])
    const frames: RpcMessage[] = []
    host = await trace.run("host/create", () => createDesktopHost({
      workspace, sessionDir: sessions, settingsPath, credentialsPath, sessionStore: "jsonl",
      onWrite: frame => { trace.observe(frame); frames.push(frame) },
    }))
    const rpc = hostRpc(host, frames, trace)
    await rpc("initialize")
    await rpc("desktop/project/sync", { projects: [
      { id: "bound", name: "Bound project", roots: [workspace], primaryRoot: workspace },
      { id: "other", name: "Other project", roots: [sibling], primaryRoot: sibling },
    ] })
    const { sessionId } = await rpc("session/create") as { sessionId: string }
    await rpc("desktop/session/project/bind", { sessionId, projectId: "bound" })
    await expect(rpc("desktop/session/input/submit", {
      sessionId, text: "Delegate the search", delivery: "queue", clientToken: "task-child-scoped-search",
    })).resolves.toMatchObject({ accepted: true })
    await trace.run("parent/turn-end", () => vi.waitFor(() => {
      if (server.errors.length) return
      expect(frames.some(frame => {
        if (!("method" in frame) || frame.method !== "session/event") return false
        const params = frame.params as { sessionId?: string; event?: { type?: string } }
        return params.sessionId === sessionId && params.event?.type === "turn/end"
      })).toBe(true)
    }, { timeout: 25_000 }))
    expect(server.errors).toEqual([])
    expect(server.requests).toHaveLength(4)
    const catalog = await rpc("desktop/session/subagents/list", { sessionId }) as { agents: Array<{ sessionId: string; path: string }> }
    expect(catalog.agents).toEqual([expect.objectContaining({ path: "root/scout", roleName: "explore", status: "completed" })])
    const childSessionId = catalog.agents[0]!.sessionId
    expect(await rpc("desktop/session/project/state", { sessionId: childSessionId })).toMatchObject({ projectId: "bound" })
    const child = await rpc("desktop/session/subagents/history", { sessionId, childSessionId }) as HistoryRange
    const parent = await rpc("session/history", { sessionId }) as HistoryRange
    expect(parent.events.filter(event => event.type === "tool/call").map(event => event.name)).toEqual(["spawn_agent"])
    expect(parent.events).toContainEqual(expect.objectContaining({ type: "assistant/message", text: parentAnswer }))

    await trace.run("host/close", () => host!.close())
    host = undefined
    const durable = fromJSONL(await readFile(join(sessions, childSessionId + ".jsonl"), "utf8"))
    expect(durable.header).toMatchObject({ parentSession: sessionId, origin: "subagent" })
    expect(durable.events).toContainEqual(expect.objectContaining({ type: "assistant/message", text: childAnswer }))
    const results = durable.events.filter(event => event.type === "tool/result")
    expect(results.map(result => result.name).sort()).toEqual(["glob", "grep"])
    for (const result of results) {
      expect(result.envelope?.execution).toEqual({ outcome: "succeeded", dispatch: "dispatched" })
      expect(child.events).toContainEqual(result)
    }
    const resultFor = (name: string) => results.find(result => result.name === name)?.envelope?.retention
    expect(resultFor("glob")).toMatchObject({ kind: "inline", value: { matches: ["found.txt"] } })
    expect(resultFor("grep")).toMatchObject({ kind: "inline", value: { matches: [expect.objectContaining({ path: "found.txt", text: allowed })] } })
  } finally {
    try { await host?.close() } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
  }
}, 45_000)
