import { expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createSessionService } from "@i-harness/session-executor"
import * as settingsModule from "@i-harness/settings"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createDesktopMcp } from "../src/mcp-settings.ts"
import { pluginExtensions } from "../src/plugin-mount.ts"
import { createDesktopHost, type DesktopHost } from "../src/host.ts"
import { createConfigurationHost, createDesktopProfileServices } from "../src/configuration-host.ts"
import { writeStdioStubServer } from "../../mcp-client/test/stdio-stub.ts"

it("enables and disables a direct MCP server on the same existing Agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-direct-mcp-"))
  const mcp = createDesktopMcp(join(root, "mcp-servers.json"))
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", extensionsFor: async (id) => pluginExtensions({ skillDirs: [], hookConfigs: [], commandDescriptors: [], agentDescriptors: [], mcpServerConfigs: {} }, root, id, () => {}, await mcp.active()) })
  mcp.bindRefresh(() => service.refreshExtensions())
  try {
    const assembly = await service.assemblyFor("s")
    await mcp.mutate({ action: "save", revision: 0, config: { serverName: "direct", transport: "stdio", command: process.execPath, args: [writeStdioStubServer()] } })
    expect(assembly.pluginMcpResults.has("direct")).toBe(false)
    await mcp.mutate({ action: "enable", name: "direct" })
    expect(assembly.pluginMcpResults.get("direct")).toBe(true)
    await mcp.mutate({ action: "disable", name: "direct" })
    expect(assembly.pluginMcpResults.has("direct")).toBe(false)
    expect(await service.assemblyFor("s")).toBe(assembly)
  } finally { await service.close(); await mcp.close(); await rm(root, { recursive: true, force: true }) }
})

it("serializes profile application, retries a saved revision and ignores duplicate file notifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-mcp-publish-"))
  const mcp = createDesktopMcp(join(root, "mcp-servers.json"))
  const retryEntered = Promise.withResolvers<void>(), releaseRetry = Promise.withResolvers<void>()
  const name = "optional"
  let reject = true, holdRetry = false
  const a: boolean[] = [], b: boolean[] = []
  const snapshot = async () => (await mcp.state()).servers.find(row => row.config.serverName === name)!.enabled
  try {
    await mcp.mutate({ action: "save", revision: 0, config: { serverName: name, transport: "stdio", command: "node", args: [] } })
    mcp.bindRefresh(async () => { a.push(await snapshot()) })
    const off = mcp.bindRefresh(async () => {
      b.push(await snapshot())
      if (reject) throw Error("one live owner could not apply")
      if (holdRetry) { retryEntered.resolve(); await releaseRetry.promise }
    })
    expect(await mcp.mutate({ action: "enable", name })).toMatchObject({ servers: [{ enabled: true }], applyError: expect.stringContaining("live application failed") })
    reject = false; holdRetry = true
    const retry = mcp.refresh()
    await retryEntered.promise
    const disable = mcp.mutate({ action: "disable", name })
    expect(await snapshot()).toBe(true)
    holdRetry = false; releaseRetry.resolve()
    expect(await retry).toMatchObject({ servers: [{ enabled: true }] })
    const saved = await disable
    expect(saved.servers[0]?.enabled).toBe(false)
    expect(saved.applyError).toBeUndefined()
    await mcp.observeChange()
    expect(a).toEqual([true, true, false])
    expect(b).toEqual(a)
    off()
    await mcp.refresh()
    expect(a).toEqual([true, true, false, false])
    expect(b).toEqual([true, true, false])
  } finally {
    releaseRetry.resolve()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

it("applies the saved MCP revision to both live workspace hosts before acknowledging", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-profile-mcp-"))
  const settingsPath = join(root, "settings.json"), credentialsPath = join(root, "credentials.json")
  const mcpPath = join(root, "mcp-servers.json"), startsPath = join(root, "stdio-starts.jsonl")
  const a = join(root, "a"), b = join(root, "b")
  await Promise.all([mkdir(a), mkdir(b), writeFile(settingsPath, JSON.stringify({ autoTitle: false, sessionStore: "jsonl", compaction: { auto: false },
    llm: { defaultModel: { provider: "fixture", model: "local" }, providers: {
      fixture: { protocol: "openai-responses", baseURL: "http://127.0.0.1:1", apiKeyEnv: "IH_MCP_FIXTURE", models: [{ id: "local" }] },
    } } })), writeFile(credentialsPath, JSON.stringify({ refs: { IH_MCP_FIXTURE: "synthetic-only" } }))])
  const script = join(root, "mcp.mjs"), stub = writeStdioStubServer()
  await writeFile(script, `import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(startsPath)}, JSON.stringify({ pid: process.pid, cwd: process.cwd() })+'\\n');
    await import(${JSON.stringify(pathToFileURL(stub).href)});`)
  const profile = createDesktopProfileServices(settingsPath, credentialsPath)
  const watchSettings = settingsModule.watchSettings
  // A successful RPC must apply even if the native MCP file notification is
  // delayed. All other source changes keep their real watcher.
  const watch = vi.spyOn(settingsModule, "watchSettings").mockImplementation((paths, onChange, options) =>
    watchSettings(paths, path => { if (path !== mcpPath) return onChange(path) }, options))
  const cleanups: DesktopHost[] = []
  const failIfModelRuns = vi.fn(async function* () { throw Error("Fixture does not invoke a provider") })
  async function connect(open: (write: (message: RpcMessage) => void) => Promise<DesktopHost>) {
    const frames: RpcMessage[] = []
    const host = await open(message => frames.push(message))
    cleanups.push(host)
    let id = 0
    const request = async (method: string, params: unknown = {}) => {
      const next = ++id
      await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id: next, method, params }))
      const reply = frames.find(frame => "id" in frame && frame.id === next)
      if (!isRpcSuccess(reply)) throw Error(JSON.stringify(reply))
      return reply.result
    }
    return { host, request, init: await request("initialize") }
  }
  const started = async () => (await readFile(startsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { pid: number; cwd: string })
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error } }
  try {
    const config = await connect(write => createConfigurationHost(profile, write))
    expect(config.init).toMatchObject({ capabilities: { "desktop-mcp": ["1"] } })
    expect(await config.request("desktop/mcp/state")).toEqual({ servers: [] })
    await config.request("desktop/mcp/mutate", { action: "save", revision: 0, config: {
      serverName: "optional", transport: "stdio", command: process.execPath, args: [script], failOnStartupError: false,
    } })
    await config.request("desktop/mcp/mutate", { action: "enable", name: "optional" })
    await expect(readFile(startsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    const hosts = []
    for (const workspace of [a, b]) {
      const live = await connect(onWrite => createDesktopHost({ workspace, sessionDir: join(workspace, "sessions"), profile, onWrite, buildProviderClient: () => ({ stream: failIfModelRuns }) }))
      const created = await live.request("session/create") as { sessionId: string }
      expect(await live.request("session/warm", { sessionId: created.sessionId })).toEqual({ ready: false, deferred: true })
      // A real user operation establishes this workspace's execution owner.
      const reminder = await live.request("desktop/schedule/create", { sessionId: created.sessionId, command: {
        prompt: "MCP configuration fixture", after_seconds: 3600,
      } }) as { id: string }
      await live.request("desktop/schedule/delete", { sessionId: created.sessionId, id: reminder.id })
      expect(await live.request("session/warm", { sessionId: created.sessionId })).toEqual({ ready: true })
      hosts.push(live)
    }
    const running = await started()
    expect(running.map(row => row.cwd.toLowerCase())).toEqual([a.toLowerCase(), b.toLowerCase()])
    expect(running.map(row => alive(row.pid))).toEqual([true, true])
    expect(await config.request("desktop/mcp/state")).toMatchObject({ servers: [{ enabled: true }] })
    expect(await started()).toEqual(running)
    // The existing scoped Gateway route remains usable and fans out once.
    const disabled = await hosts[0]!.request("desktop/mcp/mutate", { action: "disable", name: "optional" })
    expect(disabled).toMatchObject({ servers: [{ enabled: false }] })
    expect(disabled).not.toHaveProperty("applyError")
    expect(running.map(row => alive(row.pid))).toEqual([false, false])
    expect(await started()).toEqual(running)
    await hosts[1]!.host.close()
    await config.request("desktop/mcp/mutate", { action: "enable", name: "optional" })
    const after = await started()
    expect(after.map(row => row.cwd.toLowerCase())).toEqual([a.toLowerCase(), b.toLowerCase(), a.toLowerCase()])
    expect(failIfModelRuns).not.toHaveBeenCalled()
  } finally {
    watch.mockRestore()
    await Promise.all(cleanups.map(host => host.close()))
    await profile.close()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
