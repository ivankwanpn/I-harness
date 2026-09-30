import { it, expect, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
import * as agentSettingsModule from "../src/agent-settings.ts"
import * as subagentSettingsModule from "../src/subagent-settings.ts"
import * as pluginsModule from "../src/plugins.ts"

it.each([false, true])("reads cold history without executing a model and restores saved model selection (configured=%s)", async (configured) => {
  const root = await mkdtemp(join(tmpdir(), "ih-cold-history-"))
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  const sessionDir = join(root, "sessions")
  const coord = createSessionCoordinator(createJsonlBackend(sessionDir))
  const { id } = await coord.create({ modelSelection: { provider: "fixture", model: "chosen" } })
  await coord.append(id, [{ type: "user/message", text: "saved history", seq: 0 }])
  await coord.close()
  const logPath = join(sessionDir, id + ".jsonl")
  const before = await readFile(logPath, "utf8")
  const settingsPath = join(root, "settings.json")
  const credentialsPath = join(root, "credentials.json")
  await writeFile(settingsPath, JSON.stringify(configured ? { llm: {
    providers: { fixture: { protocol: "openai-completions", baseURL: "http://127.0.0.1:1", apiKeyEnv: "IH_COLD_TEST", models: [{ id: "chosen", contextWindow: 272000 }, { id: "default", contextWindow: 1000000 }] } },
    defaultModel: { provider: "fixture", model: "default" },
  } } : {}))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_COLD_TEST: "fixture" } }))
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, onWrite: f => frames.push(f) })
  const call = (requestId: number, method: string, params: unknown) => host.handleLine(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
  try {
    await call(1, "initialize", {})
    await call(2, "session/history", { sessionId: id, afterSeq: 0 })
    const history = frames.find(f => "id" in f && f.id === 2)
    expect(isRpcSuccess(history)).toBe(true)
    if (isRpcSuccess(history)) expect(history.result).toEqual({ events: [{ type: "user/message", text: "saved history", seq: 0 }], nextSeq: 1 })
    expect(await readFile(logPath, "utf8")).toBe(before)
    if (configured) {
      await call(3, "session/model/state", { sessionId: id })
      const model = frames.find(f => "id" in f && f.id === 3)
      expect(isRpcSuccess(model)).toBe(true)
      if (isRpcSuccess(model)) expect(model.result).toMatchObject({ status: "ready", modelId: "chosen" })
    }
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})

it("waits for both owned policy refreshes before closing even when one refresh rejects", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-cold-policy-close-"))
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  const settingsPath = join(root, "settings.json")
  await writeFile(settingsPath, "{}")
  let release!: () => void
  const held = new Promise<void>((done) => { release = done })
  let pluginsClosed!: () => void
  const reachedPluginClose = new Promise<void>((done) => { pluginsClosed = done })
  let policyFinished = false
  let policyWork: Promise<unknown> | undefined
  const createAgentSettings = agentSettingsModule.createAgentSettings
  const createSubagentSettings = subagentSettingsModule.createSubagentSettings
  const createDesktopPlugins = pluginsModule.createDesktopPlugins
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(agentSettingsModule, "createAgentSettings").mockImplementation((...args) => ({
    ...createAgentSettings(...args), sync: async () => { throw new Error("fixture policy refresh failure") },
  }))
  vi.spyOn(subagentSettingsModule, "createSubagentSettings").mockImplementation((...args) => {
    const settings = createSubagentSettings(...args)
    return { ...settings, state: () => {
      policyWork = held.then(async () => {
        const result = await settings.state() // acquires the real settings.provider.lock
        policyFinished = true
        return result
      })
      return policyWork as ReturnType<typeof settings.state>
    } }
  })
  vi.spyOn(pluginsModule, "createDesktopPlugins").mockImplementation((path) => {
    const plugins = createDesktopPlugins(path)
    return { ...plugins, close: async () => { await plugins.close(); pluginsClosed() } }
  })
  const host = await createDesktopHost({ workspace, sessionDir: join(root, "sessions"), settingsPath, onWrite: () => {} })
  let closed = false
  const closing = host.close().then(() => { closed = true })
  try {
    await reachedPluginClose
    // Finish the host's post-plugin microtasks. The remaining owner is the
    // explicitly held policy refresh, rather than a timer or an arbitrary wait.
    await new Promise<void>((done) => setImmediate(done))
    expect(closed).toBe(false)
    expect(policyFinished).toBe(false)
    release()
    await closing
    expect(policyFinished).toBe(true)
    expect(warn).toHaveBeenCalled()
  } finally {
    release()
    await policyWork
    await closing
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})
