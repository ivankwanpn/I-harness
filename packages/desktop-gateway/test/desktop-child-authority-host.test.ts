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
import { createLoopbackProvider, writeSplitSse, type LoopbackRound } from "../../core-agent/test/helpers/provider-loopback.ts"

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

it.skipIf(process.platform !== "win32").each(["off", "only"] as const)("a real restricted Task child searches its bound project in Code Mode %s", async mode => {
  const codeOnly = mode === "only"
  const roleTools = codeOnly ? ["grep"] : ["glob", "grep"]
  const codeTools = ["code_exec", "code_status", "code_wait"]
  const root = await mkdtemp(join(tmpdir(), "ih-desktop-child-file-search-"))
  const workspace = join(root, "workspace"), sibling = join(root, "other"), sessions = join(root, "sessions")
  const settingsPath = join(root, "settings.json"), credentialsPath = join(root, "credentials.json")
  const allowed = "scope marker in the bound project", decoy = "scope marker in the other project"
  const childAnswer = "Child search finished", parentAnswer = "Parent received child search"
  const trace = createHostFixtureTrace("desktop-task-child-file-search-" + mode)
  const completes = { type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 6 } } }
  const text = (delta: string) => ({ type: "response.output_text.delta", delta })
  const schemas = (body: Record<string, unknown>) => ((body.tools ?? []) as Array<{ name: string }>).map(tool => tool.name).sort()
  const spawn = { task_name: "scout", agent_type: "explore", message: "Search this project for the marker.", fork_turns: "none", background: false }
  const code = (code: string) => ({ code, yield_time_ms: 60_000 })
  const codeSearch = [
    'const search = describeTool("grep");',
    'if (search.name !== "grep" || ALL_TOOLS.map(tool => tool.name).join(",") !== "grep") throw Error("Unexpected role tool catalog");',
    'text({ checkedTool: search.name, result: await tools.grep({ pattern: "scope marker", mode: "literal" }) });',
  ].join("\n")
  const call = (name: string, args: object, index = 0, callId = name) => {
    const item = { id: callId, call_id: callId, type: "function_call", name, arguments: "" }
    const encoded = JSON.stringify(args)
    return [
      { type: "response.output_item.added", output_index: index, item },
      { type: "response.function_call_arguments.done", item_id: item.id, arguments: encoded },
      { type: "response.output_item.done", output_index: index, item: { ...item, arguments: encoded } },
    ]
  }
  const rounds: LoopbackRound[] = [
    async (response, request) => {
      expect(request.body.model).toBe("fixture-parent")
      if (codeOnly) expect(schemas(request.body)).toEqual(codeTools)
      const dispatch = codeOnly ? call("code_exec", code('text(await tools.spawn_agent(' + JSON.stringify(spawn) + '));')) : call("spawn_agent", spawn)
      await writeSplitSse(response, [...dispatch, completes])
    },
    async (response, request) => {
      expect(request.body.model).toBe("fixture-child")
      expect(schemas(request.body)).toEqual(codeOnly ? codeTools : roleTools)
      const dispatch = codeOnly ? call("code_exec", code(codeSearch)) : [
        ...call("glob", { pattern: "*.txt" }), ...call("grep", { pattern: "scope marker", mode: "literal" }, 1),
      ]
      await writeSplitSse(response, [...dispatch, completes])
    },
    async (response, request) => {
      expect(request.body.model).toBe("fixture-child")
      const input = JSON.stringify(request.body.input)
      if (codeOnly) {
        const items = request.body.input as Array<{ type: string; call_id?: string; output?: string }>
        const output = items.find(item => item.type === "function_call_output" && item.call_id === "code_exec")?.output
        const result = JSON.parse(output ?? "null") as { status?: string; text?: string; error?: string } | null
        expect(result?.status, result?.error).toBe("completed")
        expect(result?.text).toContain("checkedTool")
      }
      expect(input).toContain(allowed)
      expect(input).not.toContain(decoy)
      await writeSplitSse(response, [text(childAnswer), completes])
    },
    async (response, request) => {
      expect(request.body.model).toBe("fixture-parent")
      expect(JSON.stringify(request.body.input)).toContain(childAnswer)
      await writeSplitSse(response, [text(parentAnswer), completes])
    },
  ]
  const server = await createLoopbackProvider("/v1/responses", rounds)
  const frames: RpcMessage[] = []
  const childStarted = Promise.withResolvers<void>()
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  async function openHost() {
    frames.length = 0
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
    return rpc
  }
  async function submit(rpc: ReturnType<typeof hostRpc>, sessionId: string, prompt: string, clientToken: string) {
    await expect(rpc("desktop/session/input/submit", {
      sessionId, text: prompt, delivery: "queue", clientToken,
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
  }
  try {
    await Promise.all([mkdir(workspace), mkdir(sibling), mkdir(join(root, "plugins"))])
    await Promise.all([
      writeFile(join(workspace, "found.txt"), allowed + "\n"),
      writeFile(join(sibling, "found.txt"), decoy + "\n"),
      writeFile(join(sibling, "other.txt"), decoy + "\n"),
      writeFile(join(root, "plugins", "state.json"), JSON.stringify({ version: 1, sources: [], plugins: [] })),
      writeFile(credentialsPath, JSON.stringify({ refs: { IH_CHILD_FILE_SEARCH_FIXTURE_KEY: "loopback-only" } })),
      writeFile(settingsPath, JSON.stringify({
        autoTitle: false, approvalMode: "dangerous", sandboxMode: "read-only", windowsSandboxBackend: "legacy", codeMode: { mode },
        plugins: { subagentModel: true },
        agents: { roles: { explore: { provider: "fixture", model: "fixture-child" } }, roleTools: { explore: roleTools } },
        llm: { defaultModel: { provider: "fixture", model: "fixture-parent" }, providers: { fixture: {
          baseURL: server.baseUrl, protocol: "openai-responses", apiKeyEnv: "IH_CHILD_FILE_SEARCH_FIXTURE_KEY",
          models: ["fixture-parent", "fixture-child"].map(id => ({ id, contextWindow: 128_000 })),
        } } },
      })),
    ])
    const rpc = await openHost()
    const { sessionId } = await rpc("session/create") as { sessionId: string }
    await rpc("desktop/session/project/bind", { sessionId, projectId: "bound" })
    await submit(rpc, sessionId, "Delegate the search", "task-child-scoped-search")
    expect(server.requests).toHaveLength(4)
    const catalog = await rpc("desktop/session/subagents/list", { sessionId }) as { agents: Array<{ sessionId: string; path: string }> }
    expect(catalog.agents).toEqual([expect.objectContaining({ path: "root/scout", roleName: "explore", status: "completed" })])
    const childSessionId = catalog.agents[0]!.sessionId
    expect(await rpc("desktop/session/project/state", { sessionId: childSessionId })).toMatchObject({ projectId: "bound" })
    const child = await rpc("desktop/session/subagents/history", { sessionId, childSessionId }) as HistoryRange
    const parent = await rpc("session/history", { sessionId }) as HistoryRange
    expect(parent.events.filter(event => event.type === "tool/call").map(event => event.name)).toEqual([codeOnly ? "code_exec" : "spawn_agent"])
    if (codeOnly) expect(parent.events.filter(event => event.type === "code/call").map(event => event.name)).toEqual(["spawn_agent"])
    expect(parent.events).toContainEqual(expect.objectContaining({ type: "assistant/message", text: parentAnswer }))

    await trace.run("host/close", () => host!.close())
    host = undefined
    const journalPath = join(sessions, childSessionId + ".jsonl")
    const original = await readFile(journalPath)
    const durable = fromJSONL(original.toString("utf8"))
    expect(durable.header).toMatchObject({ parentSession: sessionId, origin: "subagent" })
    expect(durable.events).toContainEqual(expect.objectContaining({ type: "assistant/message", text: childAnswer }))
    const results = codeOnly ? durable.events.filter(event => event.type === "code/result") : durable.events.filter(event => event.type === "tool/result")
    expect(results.map(result => result.name).sort()).toEqual(roleTools)
    for (const result of results) {
      expect(result.envelope?.execution).toEqual({ outcome: "succeeded", dispatch: "dispatched" })
      expect(child.events).toContainEqual(result)
    }
    const resultFor = (name: string) => results.find(result => result.name === name)?.envelope?.retention
    if (codeOnly) {
      const outer = durable.events.filter(event => event.type === "tool/call")
      const calls = durable.events.filter(event => event.type === "code/call")
      expect(outer.map(event => event.name)).toEqual(["code_exec"])
      expect(calls).toEqual([expect.objectContaining({ name: "grep", parentCallId: outer[0]!.callId })])
      const [invocation] = calls
      expect(results[0]).toMatchObject({ cellId: invocation!.cellId, callId: invocation!.callId })
      expect(durable.events).toContainEqual(expect.objectContaining({ type: "code/cell", cellId: invocation!.cellId, state: "completed" }))
    } else expect(resultFor("glob")).toMatchObject({ kind: "inline", value: { matches: ["found.txt"] } })
    expect(resultFor("grep")).toMatchObject({ kind: "inline", value: { matches: [expect.objectContaining({ path: "found.txt", text: allowed })] } })

    if (codeOnly) return
    const priorLastSeq = durable.events.at(-1)?.seq
    if (priorLastSeq === undefined) throw Error("Original child journal has no committed sequence")
    const followup = "Find the resident marker in the bound project."
    const second = "resident marker in the bound project", secondDecoy = "resident marker in the other project"
    const resumedAnswer = "Original child completed the followup"
    await Promise.all([
      writeFile(join(workspace, "second.txt"), second + "\n"),
      writeFile(join(sibling, "second.txt"), secondDecoy + "\n"),
    ])
    let parentRounds = 0, childRounds = 0
    const resume: LoopbackRound = async (response, request) => {
      const input = JSON.stringify(request.body.input)
      if (request.body.model === "fixture-parent") {
        const items = request.body.input as { call_id?: string; output?: string }[]
        const output = (id: string) => items.find(item => item.call_id === id && item.output !== undefined)?.output
        if (++parentRounds === 1) {
          expect(input).toContain(parentAnswer)
          await writeSplitSse(response, [...call("followup_task", { target: "root/scout", message: followup }), completes])
        } else if (parentRounds === 2) {
          expect(JSON.parse(output("followup_task") ?? "null")).toMatchObject({ delivered: true })
          // Wait for the new child turn to start, so wait_agent observes that
          // turn instead of returning the result of the previous one.
          await childStarted.promise
          await writeSplitSse(response, [...call("wait_agent", { target: "root/scout" }), completes])
        } else {
          expect(output("wait_agent")).toContain(resumedAnswer)
          expect(output("wait_agent")).toContain(childSessionId)
          await writeSplitSse(response, [text("Parent delivered the followup"), completes])
        }
      } else {
        expect(request.body.model).toBe("fixture-child")
        expect(schemas(request.body)).toEqual(roleTools)
        expect(input).toContain(followup)
        if (++childRounds === 1) {
          childStarted.resolve()
          await writeSplitSse(response, [...call("grep", { pattern: "resident marker", mode: "literal" }, 0, "resident-grep"), completes])
        } else {
          expect(input).toContain(second)
          expect(input).not.toContain(secondDecoy)
          await writeSplitSse(response, [text(resumedAnswer), completes])
        }
      }
    }
    rounds.push(resume, resume, resume, resume, resume)
    const restarted = await openHost()
    const cold = await restarted("desktop/session/subagents/list", { sessionId }) as typeof catalog
    expect(cold.agents).toEqual([expect.objectContaining({ sessionId: childSessionId, path: "root/scout", live: false, status: "completed" })])
    expect(await restarted("desktop/session/project/state", { sessionId: childSessionId })).toMatchObject({ projectId: "bound" })
    await submit(restarted, sessionId, "Delegate the followup search", "task-child-resident-search")
    const resumed = await vi.waitFor(async () => {
      expect(server.errors).toEqual([])
      const history = await restarted("desktop/session/subagents/history", {
        sessionId, childSessionId, afterSeq: priorLastSeq + 1,
      }) as HistoryRange
      expect(history.events.some(event => event.type === "turn/end" && (event.seq ?? -1) > priorLastSeq)).toBe(true)
      return history
    }, { timeout: 25_000 })
    expect([parentRounds, childRounds]).toEqual([3, 2])
    expect(resumed.events).toContainEqual(expect.objectContaining({ type: "subagent/inbox", message: followup }))
    expect(resumed.events).toContainEqual(expect.objectContaining({ type: "assistant/message", text: resumedAnswer }))
    const resumedGrep = resumed.events.filter(event => event.type === "tool/result")
      .find(event => event.name === "grep" && event.callId === "resident-grep" && (event.seq ?? -1) > priorLastSeq)
    const grepSeq = resumedGrep?.seq
    if (grepSeq === undefined) throw Error("The new child turn has no committed grep result")
    expect(resumedGrep?.envelope).toMatchObject({
      execution: { outcome: "succeeded", dispatch: "dispatched" },
      retention: { kind: "inline", value: { matches: [expect.objectContaining({ path: "second.txt", text: second })] } },
    })
    expect(resumed.events.some(event => event.type === "turn/end" && (event.seq ?? -1) > grepSeq)).toBe(true)
    await trace.run("host/close", () => host!.close())
    host = undefined
    const saved = await readFile(journalPath)
    expect(saved.subarray(0, original.length).equals(original)).toBe(true)
    expect(fromJSONL(saved.toString("utf8")).events.slice(durable.events.length)).toContainEqual(resumedGrep)

    const savedRegistry = async () => JSON.parse(await readFile(join(sessions, sessionId + ".doc.jsonl"), "utf8"))
    const previous = (await savedRegistry()).agentTable.find((entry: { sessionId: string }) => entry.sessionId === childSessionId)
    expect(previous).toMatchObject({ finalText: resumedAnswer, lastInboxSeq: expect.any(Number), result: { kind: "retained" } })
    rounds.push(async (response, request) => {
      expect(request.body.model).toBe("fixture-parent")
      await writeSplitSse(response, [text("Parent continued alone"), completes])
    })
    const nextHost = await openHost()
    await submit(nextHost, sessionId, "Continue the parent conversation", "parent-only-after-resident")
    const afterParentOnly = await nextHost("desktop/session/subagents/list", { sessionId }) as typeof catalog
    expect(afterParentOnly.agents).toContainEqual(expect.objectContaining({
      sessionId: childSessionId, finalText: resumedAnswer, result: expect.objectContaining({ revision: previous.result.revision }),
    }))
    await trace.run("host/close", () => host!.close())
    host = undefined
    const reopened = await savedRegistry()
    expect(reopened.agentTable).toContainEqual(expect.objectContaining({
      sessionId: childSessionId, lastInboxSeq: previous.lastInboxSeq, finalText: resumedAnswer, result: expect.objectContaining({ revision: previous.result.revision }),
    }))
    expect(reopened.jobs).toContainEqual(expect.objectContaining({ id: previous.jobId, output: resumedAnswer, result: expect.objectContaining({ revision: previous.result.revision }) }))
    expect(await readFile(journalPath)).toEqual(saved)
  } finally {
    childStarted.resolve()
    try { await host?.close() } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
  }
}, 60_000)
