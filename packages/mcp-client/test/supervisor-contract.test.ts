import { describe, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import {
  createMcpSupervisor, McpServerUnavailableError,
  type ConnectedMcpClient, type McpConnectOptions, type McpServerConfig, type SupervisorDeps,
} from "../src/index.ts"

const config = (): McpServerConfig => ({ transport: "stdio", serverName: "contract", command: "x", args: [] })
const registry = () => createToolRegistry(createContext())
const generation = (): ConnectedMcpClient => ({
  async listTools() { return { tools: [] } },
  async callTool() { return { content: [] } },
  async listResources() { return [] },
  async readResource() { return {} },
  async close() {},
})

describe("supervisor extraction contracts", () => {
  it("keeps one proxy and forwards every argument with the current generation as receiver", async () => {
    vi.useFakeTimers()
    try {
      const first = generation()
      const second = generation()
      let down: (() => void) | undefined
      first.onDisconnect = (cb) => { down = cb }
      let connects = 0
      const supervisor = createMcpSupervisor({ ...config(), reconnect: { enabled: true, initialDelayMs: 1 } }, {
        tools: registry(), connect: async () => ++connects === 1 ? first : second,
      })
      const proxy = supervisor.client()
      await supervisor.start()
      down!()
      await vi.advanceTimersByTimeAsync(1)
      expect(supervisor.client()).toBe(proxy)
      const signal = new AbortController().signal
      const args = { value: 1 }
      const opts = { timeout: 7, maxTotalTimeout: 11 }
      const calls: Array<{ receiver: unknown; args: unknown[] }> = []
      second.listTools = async function (...args) { calls.push({ receiver: this, args }); return { tools: [] } }
      second.callTool = async function (...args) { calls.push({ receiver: this, args }); return { content: [] } }
      second.listResources = async function (...args) { calls.push({ receiver: this, args }); return [] }
      second.readResource = async function (...args) { calls.push({ receiver: this, args }); return {} }
      second.close = async function (...args) { calls.push({ receiver: this, args }) }
      await proxy.listTools("cursor", opts)
      await proxy.callTool("raw", args, signal)
      await proxy.listResources("filter", signal)
      await proxy.readResource("server", "uri", signal)
      await proxy.close()
      expect(calls.map((call) => call.receiver)).toEqual(Array(5).fill(second))
      expect(calls.map((call) => call.args)).toEqual([
        ["cursor", opts], ["raw", args, signal], ["filter", signal], ["server", "uri", signal], [],
      ])
      await supervisor.close()
    } finally { vi.useRealTimers() }
  })

  it("reads deps lazily and reads resource registration from the replacement registry after the drain", async () => {
    const firstTools = registry()
    const nextTools = registry()
    const reads: string[] = []
    let release: (() => void) | undefined
    const gen = generation()
    gen.listTools = async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { tools: [{ name: "echo", inputSchema: {} }] }
    }
    const deps: SupervisorDeps = {
      get tools() { reads.push("tools"); return firstTools },
      get connect() { reads.push("connect"); return async () => gen },
      get onStatus() { reads.push("status"); return undefined },
    }
    const supervisor = createMcpSupervisor(config(), deps)
    expect(reads).toEqual([])
    const started = supervisor.start()
    await Promise.resolve()
    expect(reads).toEqual(["status", "connect", "tools"])
    const status = vi.fn()
    Object.defineProperty(deps, "tools", { get: () => nextTools })
    Object.defineProperty(deps, "onStatus", { value: status })
    release!()
    await started
    expect(firstTools.get("mcp__contract__echo")).toBeDefined()
    expect(nextTools.get("list_mcp_resources__contract")).toBeDefined()
    expect(firstTools.get("list_mcp_resources__contract")).toBeUndefined()
    expect(status).toHaveBeenCalledWith({ server: "contract", state: "ready" })
    await supervisor.close()
    expect(firstTools.get("mcp__contract__echo")).toBeUndefined()
    expect(nextTools.get("list_mcp_resources__contract")).toBeUndefined()
  })

  it("closes a connection that resolves after close and keeps refresh rejection separate from tool unavailability", async () => {
    let resolve: ((gen: ConnectedMcpClient) => void) | undefined
    let options: McpConnectOptions | undefined
    const unavailable = vi.fn()
    const status = vi.fn()
    const supervisor = createMcpSupervisor(config(), {
      tools: registry(), onStatus: status, onToolUnavailable: unavailable,
      connect: (_config, opts) => { options = opts; return new Promise((done) => { resolve = done }) },
    })
    const starting = supervisor.start()
    await supervisor.close()
    await expect(supervisor.refreshCatalog()).rejects.toBeInstanceOf(McpServerUnavailableError)
    expect(unavailable).not.toHaveBeenCalled()
    await expect(supervisor.client().listTools()).rejects.toBeInstanceOf(McpServerUnavailableError)
    expect(unavailable).toHaveBeenCalledTimes(1)
    const gen = generation()
    gen.close = vi.fn(async () => { options?.onToolsChanged?.() })
    resolve!(gen)
    await expect(starting).rejects.toThrow("supervisor closed during startup")
    expect(gen.close).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenCalledTimes(1)
    // Existing callback lifetime: even after close, the shared marker remains callable.
    expect(supervisor.catalogDirty()).toBe(true)
  })
})
