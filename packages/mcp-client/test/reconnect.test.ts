import { describe, expect, it, vi } from "vitest"
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
  /** Every `listTools` call AS THE GENERATION RECEIVED IT: the cursor and the
   *  opts the supervisor's proxy forwarded (M6-D2/D3's forwarding assertion). */
  listToolCalls: Array<{ cursor?: string; opts?: { timeout?: number; maxTotalTimeout?: number } }>
  /** M6-D3: the handler the mount registered through `deps.connect`'s opts — the
   *  stand-in for the SDK's `notifications/tools/list_changed` arriving. */
  onToolsChanged?: (() => void) | undefined
  /** Replace the tool list (what a live server does BEFORE it notifies). */
  setTools(names: string[]): void
  /** Fire the registered tools/list_changed handler. */
  notifyToolsChanged(): void
  /** Simulate the underlying transport dying on its own (fires onDisconnect). */
  die(): void
}

function makeFakeGen(id: string, toolNames: string[]): FakeGen {
  const listeners: Array<() => void> = []
  let names = [...toolNames]
  const gen: FakeGen = {
    id,
    callCount: 0,
    closed: false,
    listToolCalls: [],
    setTools(next) {
      names = [...next]
    },
    notifyToolsChanged() {
      gen.onToolsChanged?.()
    },
    die() {
      for (const cb of [...listeners]) cb()
    },
    async listTools(cursor, opts) {
      gen.listToolCalls.push({ ...(cursor !== undefined ? { cursor } : {}), ...(opts !== undefined ? { opts } : {}) })
      return { tools: names.map((name) => ({ name, description: `${id}:${name}`, inputSchema: {} })) }
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

// Bug 1 regression fake: listTools hangs in flight until die() is called,
// mirroring the real interleaving where the transport dies with a request
// pending — the SDK fires onclose (synchronous generationDown → failCycle)
// BEFORE the rejected-request continuation runs. die() reproduces that exact
// ordering: listeners first, then the listTools rejection. listCalls lets the
// test wait until the resync fetch is genuinely in flight.
function makeMidResyncDeathGen(id: string, toolNames: string[]): FakeGen & { listCalls: number } {
  const gen = makeFakeGen(id, toolNames) as FakeGen & { listCalls: number }
  gen.listCalls = 0
  let rejectPending: ((err: unknown) => void) | undefined
  gen.listTools = () => {
    gen.listCalls += 1
    return new Promise((_resolve, reject) => {
      rejectPending = reject
    })
  }
  const dieOwn = gen.die.bind(gen)
  gen.die = () => {
    dieOwn() // synchronous generationDown → failCycle (retry scheduled)
    rejectPending?.(new Error(`${id}: transport died with a request in flight`))
    rejectPending = undefined
  }
  return gen
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

  it("mid-resync death: failCycle runs exactly once (no double retry, no duplicate events)", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: McpServerConfig = {
      transport: "stdio",
      serverName: "rr",
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
        // Generation 2 (the first retry) dies while its listTools — the resync
        // fetch of attempt(n) — is in flight; that is the attempt-level race
        // (start() has no failCycle path). Other generations are ordinary.
        const gen =
          connectCount === 2
            ? makeMidResyncDeathGen(`gen${connectCount}`, ["echo"])
            : makeFakeGen(`gen${connectCount}`, ["echo"])
        gens.push(gen)
        return gen
      },
      onStatus: (ev) => events.push(ev),
    })
    expect(connectCount).toBe(1)
    expect(tools.get("mcp__rr__echo")).toBeDefined()

    // Clean death of generation 1 → reconnecting → attempt(1) spawns gen2.
    gens[0]!.die()
    await waitFor(() => connectCount === 2)

    // Wait until gen2's resync fetch is genuinely in flight, then kill it:
    // onclose fires (synchronous generationDown → failCycle #1, retry
    // scheduled) BEFORE the rejected listTools continuation reaches attempt's
    // catch — which must NOT run failCycle a second time.
    await waitFor(() => (gens[1] as FakeGen & { listCalls: number }).listCalls === 1)
    gens[1]!.die()

    await waitFor(() => events.filter((e) => e.state === "ready").length >= 2)
    // Settle: a buggy duplicate retry arms a second timer that fires attempt(n+1)
    // again within milliseconds of the first — let it surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50))
    // The bug double-ran failCycle: 3× "reconnecting", attempt(n+1) armed twice
    // → 4 connects and an orphaned live generation. Fixed: one cycle per death.
    expect(events.filter((e) => e.state === "ready").length).toBe(2)
    expect(events.filter((e) => e.state === "reconnecting").length).toBe(2)
    expect(connectCount).toBe(3)
    // Dead generation closed via the ownership path; the retry generation
    // serves the public tool name.
    expect(gens[1]!.closed).toBe(true)
    await expect(tools.get("mcp__rr__echo")!.execute({}, exec)).resolves.toBeDefined()
    expect(gens[2]!.callCount).toBe(1)

    await handle.unmount()
    expect(gens[2]!.closed).toBe(true)
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

// M6-D3: `tools/list_changed` → dirty flag → in-place rebuild. A server that
// announces the notification MARKS its catalogue stale (no eager refetch — the
// spec forbids rebuilding inside the event callback) and the catalogue is rebuilt
// in place on the CURRENT generation when the consumer (session-executor's
// assembly) reaches its step boundary. The forwarding case pins the D2 opts the
// supervisor's proxy used to drop on the floor.
describe("mcp catalogue refresh (list_changed → dirty → rebuild)", () => {
  // Each case uses its OWN serverName: the module-level reservation is released
  // by unmount, so a case that fails before unmounting must not poison the next.

  /** Mount one fake, handing it the onToolsChanged callback the supervisor
   *  passes through `deps.connect` — the stand-in for the SDK's handler. */
  async function mountFake(gens: FakeGen[], serverName: string, extra: Partial<Extract<McpServerConfig, { transport: "stdio" }>> = {}) {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: Extract<McpServerConfig, { transport: "stdio" }> = { transport: "stdio", serverName, command: "x", args: [], toolCallTimeoutMs: 1_234, ...extra }
    const handle = await mountMcpClient({} as never, tools, config, {
      connect: async (_c, opts) => {
        const gen = makeFakeGen(`gen${gens.length + 1}`, ["echo"])
        gen.onToolsChanged = opts?.onToolsChanged
        gens.push(gen)
        return gen
      },
    })
    return { tools, handle }
  }

  it("list_changed marks the catalogue dirty; the boundary rebuild applies the new list and clears it", async () => {
    const gens: FakeGen[] = []
    const { tools, handle } = await mountFake(gens, "cat1")
    expect(handle.catalogDirty()).toBe(false)
    expect(tools.get("mcp__cat1__echo")).toBeDefined()

    // The server swaps its list, then announces it. NO eager refetch: the
    // notification must not trigger a drain, and the registry must not change
    // until a boundary consumes the flag.
    gens[0]!.setTools(["echo", "fresh"])
    gens[0]!.notifyToolsChanged()
    expect(handle.catalogDirty()).toBe(true)
    expect(gens[0]!.listToolCalls.length).toBe(1) // the mount's own drain
    expect(tools.get("mcp__cat1__fresh")).toBeUndefined()

    // The boundary: exactly the call the assembly's agent/pre-step handler makes.
    await handle.refreshCatalog()
    expect(handle.catalogDirty()).toBe(false)
    expect(gens[0]!.listToolCalls.length).toBe(2) // re-drained, in place
    expect(tools.get("mcp__cat1__fresh")).toBeDefined()
    expect(tools.get("mcp__cat1__echo")).toBeDefined()
    // The rebuilt catalogue routes to the same single generation (no reconnect).
    await expect(tools.get("mcp__cat1__fresh")!.execute({}, exec)).resolves.toBeDefined()
    expect(gens[0]!.callCount).toBe(1)

    await handle.unmount()
  })

  it("forwards the drain's per-page opts through the proxy to the generation", async () => {
    const gens: FakeGen[] = []
    const { handle } = await mountFake(gens, "cat2")
    const first = gens[0]!.listToolCalls[0]
    // bridge.ts sends min(remaining, toolCallTimeoutMs) per page; the cap binds
    // (the 60s drain deadline is not near), so the value is exact — and it can
    // only be here at all if the proxy forwarded the second argument.
    expect(first?.opts?.timeout).toBe(1_234)
    // The page's remaining-total stays the drain's business: strictly larger.
    expect(first?.opts?.maxTotalTimeout).toBeGreaterThan(1_234)
    await handle.unmount()
  })

  it("generation death clears the flag, and a boundary during the outage fails fast", async () => {
    const gens: FakeGen[] = []
    const { handle } = await mountFake(gens, "cat3", {
      reconnect: { enabled: true, initialDelayMs: 60_000, maxDelayMs: 60_000, maxRetries: 5 },
    })
    gens[0]!.setTools(["echo", "fresh"])
    gens[0]!.notifyToolsChanged()
    expect(handle.catalogDirty()).toBe(true)

    // The flag dies with its generation: the reconnect path drains a fresh
    // catalogue anyway, so stale dirtiness would be meaningless (plan §0.3).
    gens[0]!.die()
    await waitFor(() => handle.catalogDirty() === false)
    // No generation is live: the same fail-fast error a tool call gets, not a
    // hang on a dead transport and not a silent no-op.
    await expect(handle.refreshCatalog()).rejects.toThrowError(McpServerUnavailableError)

    await handle.unmount() // clears the pending retry timer
  })

  it("a list_changed that lands mid-rebuild leaves the catalogue dirty", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const gen = makeFakeGen("gen1", ["echo"])
    let release: (() => void) | undefined
    let defer = false
    const drain = gen.listTools.bind(gen)
    gen.listTools = async (cursor, opts) => {
      if (defer) {
        defer = false
        await new Promise<void>((resolve) => { release = resolve })
      }
      return drain(cursor, opts)
    }
    const handle = await mountMcpClient({} as never, tools, {
      transport: "stdio", serverName: "cat4", command: "x", args: [], toolCallTimeoutMs: 1_234,
    }, {
      connect: async (_c, opts) => { gen.onToolsChanged = opts?.onToolsChanged; return gen },
    })
    expect(handle.catalogDirty()).toBe(false)

    defer = true
    gen.notifyToolsChanged()
    const rebuilding = handle.refreshCatalog()
    await waitFor(() => release !== undefined) // the drain is genuinely in flight

    // A SECOND change lands while those pages are being read: what the rebuild
    // is about to install is already stale, so the flag must survive it —
    // otherwise this change is lost until some later, unrelated notification.
    gen.setTools(["echo", "later"])
    gen.notifyToolsChanged()
    release!()
    await rebuilding

    expect(handle.catalogDirty()).toBe(true)
    await handle.refreshCatalog()
    expect(handle.catalogDirty()).toBe(false)
    expect(tools.get("mcp__cat4__later")).toBeDefined()

    await handle.unmount()
  })

  // Final review #1: the rebuild sits ON the turn's critical path — the boundary
  // awaits it — so a drain that FAILS must not be retried at every boundary:
  // a server that announces list_changed and then stalls would cost one drain
  // timeout per step, unbounded. The flag still stays dirty (it cannot lie about
  // the catalogue); it is the RETRY that is throttled, by a window the failure
  // itself derives.
  it("a failed rebuild is throttled: ONE drain per window, then the boundary tries again", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const gen = makeFakeGen("gen1", ["echo"])
    const drain = gen.listTools.bind(gen)
    let failing = false
    // Every drain ATTEMPT is counted here, before the throw: the fake's own
    // `listToolCalls` log would only see the attempts that got as far as a page.
    let attempts = 0
    gen.listTools = async (cursor, opts) => {
      attempts += 1
      if (failing) throw new Error("drain refused")
      return drain(cursor, opts)
    }
    // The window IS one full drain's budget (catalogTimeoutMs), so a small one
    // keeps this test's clock small — the value is the config's, not a knob.
    const handle = await mountMcpClient({} as never, tools, {
      transport: "stdio", serverName: "cat6", command: "x", args: [], catalogTimeoutMs: 150,
    }, {
      connect: async (_c, opts) => { gen.onToolsChanged = opts?.onToolsChanged; return gen },
    })
    expect(attempts).toBe(1) // the mount's own drain

    failing = true
    gen.setTools(["echo", "grown"])
    gen.notifyToolsChanged()
    // Attempt 1: a genuine failure — reported (the promise rejects), and the
    // flag STAYS dirty so a later boundary rebuilds.
    await expect(handle.refreshCatalog()).rejects.toThrow(/drain refused/)
    expect(attempts).toBe(2)
    expect(handle.catalogDirty()).toBe(true)

    // Boundaries 2 and 3 land inside the window: no drain attempt, no drain
    // timeout paid. (Pre-fix each tick was another overlapping attempt — the
    // unbounded per-step cost this throttles.)
    const tick = async (): Promise<void> => {
      if (!handle.catalogDirty()) return
      try {
        await handle.refreshCatalog()
      } catch {
        /* reported by the assembly's warn; the attempt count is the measurement */
      }
    }
    await tick()
    await tick()
    expect(attempts).toBe(2) // exactly ONE attempt in the window
    expect(handle.catalogDirty()).toBe(true) // still dirty: the flag never lies

    // Past the window the same boundary tries again...
    await new Promise((resolve) => setTimeout(resolve, 200))
    await tick()
    expect(attempts).toBe(3)
    expect(handle.catalogDirty()).toBe(true)

    // ...and once the server recovers, the next window's boundary heals the
    // catalogue: the throttle delays retries, it does not wedge them.
    failing = false
    await new Promise((resolve) => setTimeout(resolve, 200))
    await tick()
    expect(attempts).toBe(4)
    expect(handle.catalogDirty()).toBe(false)
    expect(tools.get("mcp__cat6__grown")).toBeDefined()

    await handle.unmount()
  })

  // Final review #2: the single-flight above covers refresh-vs-refresh only.
  // `attempt` (and `start`) drain the catalogue themselves right after
  // adoptGeneration, and while that drain is in flight the state is still
  // "reconnecting": a list_changed landing then, plus a live turn's boundary,
  // used to start a SECOND overlapping syncTools over the same
  // previous-disposers map — the exact collision the single-flight comment
  // documents (duplicate registration → rollback → an empty disposers map →
  // silent catalogue loss).
  it("a list_changed during the reconnect path's own drain starts no second drain", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const gens: FakeGen[] = []
    const events: McpServerStatusEvent[] = []
    let release: (() => void) | undefined
    let held = false
    const handle = await mountMcpClient({} as never, tools, {
      transport: "stdio", serverName: "cat7", command: "x", args: [],
      reconnect: { enabled: true, initialDelayMs: 5, maxDelayMs: 50, maxRetries: 3 },
    }, {
      connect: async (_c, opts) => {
        const gen = makeFakeGen(`gen${gens.length + 1}`, ["echo"])
        gen.onToolsChanged = opts?.onToolsChanged
        if (gens.length === 1) {
          // Generation 2's initial drain (attempt's resync) is HELD open, so
          // the announcement lands while that drain is genuinely in flight.
          const inner = gen.listTools.bind(gen)
          gen.listTools = async (cursor, pageOpts) => {
            if (!held) {
              held = true
              await new Promise<void>((resolve) => { release = resolve })
            }
            return inner(cursor, pageOpts)
          }
        }
        gens.push(gen)
        return gen
      },
      onStatus: (ev) => events.push(ev),
    })
    expect(gens[0]!.listToolCalls.length).toBe(1) // gen1's mount drain

    gens[0]!.die()
    await waitFor(() => release !== undefined) // gen2's drain is in flight
    // The premise: the mount is NOT ready while that drain runs (nothing in
    // the mount handle exposes the state, so the status stream is the witness).
    expect(events[events.length - 1]!.state).toBe("reconnecting")

    gens[1]!.setTools(["echo", "grown"])
    gens[1]!.notifyToolsChanged() // arrives DURING that drain
    expect(handle.catalogDirty()).toBe(true)

    // The boundary. It must NOT drain: the in-flight drain is the rebuild, and
    // a second one would run syncTools over the same previous-disposers map.
    await handle.refreshCatalog()
    expect(gens[1]!.listToolCalls.length).toBe(0) // the held drain has not even recorded a page

    release!()
    await waitFor(() => events.filter((e) => e.state === "ready").length === 2)
    expect(gens[1]!.listToolCalls.length).toBe(1) // exactly the reconnect path's one drain
    expect(handle.catalogDirty()).toBe(true) // the mid-drain announcement survived it

    // The first boundary after `ready` is where the rebuild happens.
    await handle.refreshCatalog()
    expect(gens[1]!.listToolCalls.length).toBe(2)
    expect(handle.catalogDirty()).toBe(false)
    expect(tools.get("mcp__cat7__grown")).toBeDefined()

    await handle.unmount()
  })

  // Final review (minor): a rebuild whose Phase-2 swap hits a registry conflict
  // is rolled back to ZERO tools by bridge.ts (:144-154 returns an empty map
  // rather than throwing, so an ordinary client keeps working). Reading that
  // empty map as "the announcement is consumed" cleared the flag over a
  // catalogue that is now MISSING its tools — no retry, silent loss.
  it("a refresh whose swap rolls back to zero stays dirty (the catalogue is missing, not empty)", async () => {
    const gens: FakeGen[] = []
    const { tools, handle } = await mountFake(gens, "cat8")
    expect(tools.get("mcp__cat8__echo")).toBeDefined()
    // A sticky foreign squat on a name the NEW list carries: the next swap
    // disposes this server's tools, registers `echo` again, then throws on
    // `fresh` — the conflict path, not the genuinely-empty-list path.
    tools.register({
      name: "mcp__cat8__fresh",
      description: "foreign",
      inputSchema: {},
      async execute() {
        return []
      },
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      gens[0]!.setTools(["echo", "fresh"])
      gens[0]!.notifyToolsChanged()
      await handle.refreshCatalog()
      // The rollback really happened: the squatter survives, this server's own
      // tools were zeroed.
      expect(tools.get("mcp__cat8__fresh")?.description).toBe("foreign")
      expect(tools.get("mcp__cat8__echo")).toBeUndefined()
      // ...so the announcement is NOT consumed — the next boundary retries
      // (and, with no catalogue left to swap, that retry fails closed: the
      // conflict is REPORTED rather than silently served as an empty list).
      expect(handle.catalogDirty()).toBe(true)
      await expect(handle.refreshCatalog()).rejects.toThrow(/duplicate tool registration/)
    } finally {
      warnSpy.mockRestore()
    }
    await handle.unmount()
  })

  it("concurrent refreshes share ONE drain (two boundaries can be in flight at once)", async () => {
    // The listener lives on an ancestor scope and a DETACHED child turn reaches
    // it, so a teammate's step and the lead's next step can both ask for a
    // rebuild while one drain is already running. Two overlapping drains keep
    // the same previous-disposers map: the loser disposes what the winner just
    // registered (duplicate → rollback → an EMPTY map, a silently missing tool).
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const gen = makeFakeGen("gen1", ["echo"])
    let starts = 0
    let release: (() => void) | undefined
    const drain = gen.listTools.bind(gen)
    gen.listTools = async (cursor, opts) => {
      starts += 1
      // The mount's drain (start 1) runs free; the rebuild (start 2) is held
      // open so the second caller arrives while it is genuinely in flight.
      if (starts === 2) await new Promise<void>((resolve) => { release = resolve })
      return drain(cursor, opts)
    }
    const handle = await mountMcpClient({} as never, tools, {
      transport: "stdio", serverName: "cat5", command: "x", args: [], toolCallTimeoutMs: 1_234,
    }, {
      connect: async (_c, opts) => { gen.onToolsChanged = opts?.onToolsChanged; return gen },
    })

    gen.setTools(["echo", "grown"]) // the GROWN list this task exists for
    gen.notifyToolsChanged()
    const first = handle.refreshCatalog()
    const second = handle.refreshCatalog()
    await waitFor(() => release !== undefined)

    // One rebuild started, not two: the second caller is sharing the first's
    // promise. (Absent single-flight this is 3 — and the loser's drain would
    // race the winner's registration.)
    expect(starts).toBe(2)
    release!()
    await Promise.all([first, second])

    expect(starts).toBe(2)
    expect(gen.listToolCalls.length).toBe(2) // the mount's drain + ONE rebuild
    expect(handle.catalogDirty()).toBe(false)
    expect(tools.get("mcp__cat5__grown")).toBeDefined()

    await handle.unmount()
  })
})
