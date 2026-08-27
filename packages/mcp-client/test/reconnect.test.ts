import { describe, expect, it } from "vitest"
import {
  McpServerUnavailableError,
  mountMcpClient,
  validateMcpConfig,
  type ConnectedMcpClient,
  type McpServerConfig,
  type McpServerStatusEvent,
} from "../src/index.ts"
import { createToolRegistry, type ToolExec } from "@i-harness/core-tools"
import { createContext } from "@i-harness/core-plugin"

// dsh reconnect blueprint (see THIRD_PARTY_NOTICES): inject fake generations
// through the deps.connect seam, simulate transport death via the fake's
// onDisconnect wiring, and observe the host status events.

interface FakeGen extends ConnectedMcpClient {
  readonly id: string
  callCount: number
  closed: boolean
  /** Simulate the underlying transport dying on its own (fires onDisconnect). */
  die(): void
}

function makeFakeGen(id: string, toolNames: string[]): FakeGen {
  const listeners: Array<() => void> = []
  const gen: FakeGen = {
    id,
    callCount: 0,
    closed: false,
    die() {
      for (const cb of [...listeners]) cb()
    },
    async listTools() {
      return { tools: toolNames.map((name) => ({ name, description: `${id}:${name}`, inputSchema: {} })) }
    },
    async callTool() {
      gen.callCount += 1
      return { content: [{ type: "text", text: `${id}:ok` }] }
    },
    async listResources() {
      return []
    },
    async readResource() {
      return {}
    },
    async close() {
      gen.closed = true
    },
    onDisconnect(cb) {
      listeners.push(cb)
    },
  }
  return gen
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const exec: ToolExec = {}

describe("mcp reconnect supervisor", () => {
  it("reconnects after disconnect (new generation, tools re-synced)", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: McpServerConfig = {
      transport: "stdio",
      serverName: "rc",
      command: "x",
      args: [],
      reconnect: { enabled: true, initialDelayMs: 5, maxDelayMs: 50, maxRetries: 3 },
    }
    const events: McpServerStatusEvent[] = []
    let connectCount = 0
    const gens: FakeGen[] = []
    const handle = await mountMcpClient({} as never, tools, config, {
      connect: async () => {
        connectCount += 1
        const gen = makeFakeGen(`gen${connectCount}`, ["echo"])
        gens.push(gen)
        return gen
      },
      onStatus: (ev) => events.push(ev),
    })
    expect(connectCount).toBe(1)
    expect(tools.get("mcp__rc__echo")).toBeDefined()

    // Generation 1's transport dies on its own.
    gens[0]!.die()

    await waitFor(() => connectCount === 2) // supervisor rebuilt a generation
    await waitFor(() => events.filter((e) => e.state === "ready").length === 2)
    const reconnecting = events.filter((e) => e.state === "reconnecting")
    expect(reconnecting.length).toBeGreaterThanOrEqual(1)
    expect(reconnecting[0]!.server).toBe("rc")

    // Tools re-synced: the same public name now routes to generation 2.
    await expect(tools.get("mcp__rc__echo")!.execute({}, exec)).resolves.toBeDefined()
    expect(gens[1]!.callCount).toBe(1)
    expect(gens[0]!.callCount).toBe(0)

    await handle.unmount()
    expect(gens[1]!.closed).toBe(true)
  })

  it("exceeds maxRetries → tools unregistered + lost event emitted", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: McpServerConfig = {
      transport: "stdio",
      serverName: "mx",
      command: "x",
      args: [],
      reconnect: { enabled: true, initialDelayMs: 5, maxDelayMs: 50, maxRetries: 1 },
    }
    const events: McpServerStatusEvent[] = []
    let connectCount = 0
    const gens: FakeGen[] = []
    const handle = await mountMcpClient({} as never, tools, config, {
      connect: async () => {
        connectCount += 1
        if (connectCount === 1) {
          const gen = makeFakeGen("gen1", ["echo"])
          gens.push(gen)
          return gen
        }
        throw new Error("refused")
      },
      onStatus: (ev) => events.push(ev),
    })
    expect(tools.get("mcp__mx__echo")).toBeDefined()

    gens[0]!.die() // first disconnect; the single retry is refused → lost

    await waitFor(() => events.some((e) => e.state === "lost"))
    const lost = events.find((e) => e.state === "lost")!
    expect(lost.server).toBe("mx")
    expect(lost.attempts).toBe(1)
    expect(lost.lastError).toContain("refused")
    // All of the server's tools are unregistered (mcp tools + resource tools).
    expect(tools.get("mcp__mx__echo")).toBeUndefined()
    expect(tools.get("list_mcp_resources__mx")).toBeUndefined()
    expect(tools.get("read_mcp_resource__mx")).toBeUndefined()

    await handle.unmount()
  })

  it("outage: tool call fails fast with McpServerUnavailableError", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: McpServerConfig = {
      transport: "stdio",
      serverName: "ot",
      command: "x",
      args: [],
      // Backoff so long the supervisor stays in "reconnecting" for the whole test.
      reconnect: { enabled: true, initialDelayMs: 60_000, maxDelayMs: 60_000, maxRetries: 5 },
    }
    const events: McpServerStatusEvent[] = []
    const gens: FakeGen[] = []
    const handle = await mountMcpClient({} as never, tools, config, {
      connect: async () => {
        const gen = makeFakeGen(`gen${gens.length + 1}`, ["echo"])
        gens.push(gen)
        return gen
      },
      onStatus: (ev) => events.push(ev),
    })
    expect(events.some((e) => e.state === "ready")).toBe(true)

    gens[0]!.die()
    await waitFor(() => events.some((e) => e.state === "reconnecting"))

    const tool = tools.get("mcp__ot__echo")!
    expect(tool).toBeDefined()
    const t0 = Date.now()
    await expect(tool.execute({}, exec)).rejects.toThrowError(McpServerUnavailableError)
    expect(Date.now() - t0).toBeLessThan(1_000) // fails fast — no hang, no silent drop

    await handle.unmount() // clears the pending retry timer
  })

  it("default: no reconnect config → one-shot mount, death is not retried", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: McpServerConfig = { transport: "stdio", serverName: "plain", command: "x", args: [] }
    const events: McpServerStatusEvent[] = []
    let connectCount = 0
    const gens: FakeGen[] = []
    const handle = await mountMcpClient({} as never, tools, config, {
      connect: async () => {
        connectCount += 1
        const gen = makeFakeGen(`gen${connectCount}`, ["echo"])
        gens.push(gen)
        return gen
      },
      onStatus: (ev) => events.push(ev),
    })
    gens[0]!.die()
    await new Promise((resolve) => setTimeout(resolve, 20))

    // No retry machinery: exactly one connect, tools stay, no reconnect events.
    expect(connectCount).toBe(1)
    expect(events.some((e) => e.state === "reconnecting" || e.state === "lost")).toBe(false)
    expect(tools.get("mcp__plain__echo")).toBeDefined()

    await handle.unmount()
  })

  it("validateMcpConfig fails loud on invalid reconnect config", () => {
    const base = { transport: "stdio" as const, serverName: "v", command: "x", args: [] as string[] }
    expect(() => validateMcpConfig({ ...base, reconnect: { enabled: true, initialDelayMs: 0 } })).toThrow(/initialDelayMs/)
    expect(() => validateMcpConfig({ ...base, reconnect: { enabled: true, maxDelayMs: -1 } })).toThrow(/maxDelayMs/)
    expect(() => validateMcpConfig({ ...base, reconnect: { enabled: true, maxRetries: 0 } })).toThrow(/maxRetries/)
    expect(() => validateMcpConfig({ ...base, reconnect: { enabled: true, maxRetries: 1.5 } })).toThrow(/maxRetries/)
    expect(() => validateMcpConfig({ ...base, reconnect: { enabled: "yes" as never } })).toThrow(/enabled/)
    expect(() => validateMcpConfig({ ...base, reconnect: { enabled: true, initialDelayMs: 5, maxDelayMs: 30_000, maxRetries: 2 } })).not.toThrow()
  })
})
