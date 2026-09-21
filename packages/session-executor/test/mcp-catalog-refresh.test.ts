// M6-D3 (plan §Task 3): the catalogue's rebuild boundary is `agent/pre-step`.
//
// What this file pins, with NO mock of the mcp-client: a REAL stdio mount (a
// hand-rolled MCP server — the SDK is not a dependency of this package) whose
// server announces `notifications/tools/list_changed`, and the assembly's
// boundary handler. The observation point is the SERVER's request log: it
// answers "was the catalogue drained at this boundary?" in the only place where
// that is a fact rather than a spy's claim — the wire. A clean boundary must
// produce no `tools/list`; a boundary after the announcement must produce
// exactly one, and the registry (read through the AgentDeps the assembly hands
// `createAgent`) must then hold the NEW list and not the old one.
//
// The second case is the failure path: a rebuild that cannot read a page must
// report, not abort the turn (the `schedule-driver` precedent, assembly.ts:850:
// a step-boundary hook is on the turn's critical path, so it never throws), and
// the catalogue that stays in the registry is the PREVIOUS one — a failed drain
// leaves the tools it could not replace alone.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execPath } from "node:process"
import { describe, expect, it, vi } from "vitest"
import { createMockClient } from "@i-harness/llm-mock"
import type { AgentDeps } from "@i-harness/core-agent"
import { createSessionAssembly, type SessionAssembly } from "../src/assembly.ts"

// The assembly builds ONE tool registry and hands it to `createAgent`; capturing
// that deps object is how a test sees what the mounts registered (the same seam
// assembly.test.ts uses for its MCP-config cases). Pass-through: the real agent
// still runs.
const agentDeps = vi.hoisted(() => ({ calls: [] as AgentDeps[] }))
vi.mock("@i-harness/core-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@i-harness/core-agent")>()
  return {
    ...actual,
    createAgent: (ctx: Parameters<typeof actual.createAgent>[0], deps: Parameters<typeof actual.createAgent>[1]) => {
      agentDeps.calls.push(deps)
      return actual.createAgent(ctx, deps)
    },
  }
})

// A minimal MCP server speaking newline-delimited JSON-RPC 2.0 over stdio.
// argv[2] = the request log this test reads; argv[3] = the mode:
//   "ok"                — advertises tools.listChanged, serves the catalogue
//   "fail-after-swap"   — same, but tools/list errors once the list has swapped
//   "no-listChanged"    — advertises `capabilities.tools = {}` (NO listChanged)
//                         yet still sends the notification: the server half of
//                         the "is the low-level handler capability-gated?" case.
const STUB = `
import { appendFileSync } from "node:fs"

const logPath = process.argv[2]
const mode = process.argv[3] ?? "ok"
const log = (line) => appendFileSync(logPath, line + "\\n")
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")

let swapped = false
let buffer = ""

const tools = () => [
  { name: "swap", description: "swap the catalogue", inputSchema: { type: "object", properties: {} } },
  {
    name: swapped ? "after" : "before",
    description: swapped ? "listed after the swap" : "listed before the swap",
    inputSchema: { type: "object", properties: {} },
  },
]

function dispatch(message) {
  if (message.method === undefined) return
  log(message.method)
  if (message.id === undefined) return // a client notification (initialized)
  if (message.method === "initialize") {
    const capabilities = { tools: mode === "no-listChanged" ? {} : { listChanged: true } }
    // Logged so a test can prove WHICH handshake the server actually offered —
    // a mode typo must not let the capability case pass for the wrong reason.
    log("capabilities:" + JSON.stringify(capabilities))
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities,
      serverInfo: { name: "cat-stub", version: "0.1.0" },
    } })
    return
  }
  if (message.method === "tools/list") {
    if (swapped && mode === "fail-after-swap") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "catalogue exploded" } })
      return
    }
    send({ jsonrpc: "2.0", id: message.id, result: { tools: tools() } })
    return
  }
  if (message.method === "tools/call") {
    if (message.params?.name === "swap") {
      swapped = true
      log("notified")
      // The announcement goes out BEFORE this call's response, so the client
      // holds the notification by the time the tool result resolves.
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
    }
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } })
    return
  }
  if (message.method === "resources/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { resources: [] } })
    return
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found: " + message.method } })
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8")
  for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, i)
    buffer = buffer.slice(i + 1)
    if (line.trim().length > 0) dispatch(JSON.parse(line))
  }
})
`

interface Fixture {
  assembly: SessionAssembly
  registry: NonNullable<AgentDeps["tools"]>
  /** Every request line the server received, in order. */
  log: () => string[]
  listCalls: () => number
  boundary: () => Promise<void>
}

async function mountCatalogueServer(mode = "ok"): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "mcp-cat-"))
  const logPath = join(dir, "requests.log")
  const script = join(dir, "cat-stub.mjs")
  writeFileSync(script, STUB, "utf8")

  const assembly = await createSessionAssembly({
    workspace: process.cwd(),
    sessionId: "mcp-catalog",
    model: createMockClient([{ role: "assistant", text: "ok" }]),
    mcp: [{ transport: "stdio", serverName: "cat", command: execPath, args: [script, logPath, mode] }],
  })
  const registry = agentDeps.calls.at(-1)!.tools
  const log = (): string[] =>
    readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0)
  return {
    assembly,
    registry,
    log,
    listCalls: () => log().filter((line) => line === "tools/list").length,
    boundary: async () => { await assembly.ctx.emit("agent/pre-step", { task: "boundary", session: assembly.session }) },
  }
}

/** The SDK dispatches a notification on its own microtask, and the step
 *  boundary is the flag's ONLY consumer — so the test drives boundaries until
 *  the rebuild reaches the wire, then asserts exactly. Bounded: a rebuild that
 *  never happens leaves the count short and the caller's `expect` fails. */
async function boundaryUntil(f: Fixture, count: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (f.listCalls() < count && Date.now() < deadline) {
    await f.boundary()
    if (f.listCalls() < count) await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("the MCP catalogue rebuilds at the agent/pre-step boundary (M6-D3)", () => {
  it("drains again only when the server announced list_changed, and the registry then holds the new list", async () => {
    const f = await mountCatalogueServer()
    try {
      expect(f.registry.get("mcp__cat__before")).toBeDefined()
      expect(f.registry.get("mcp__cat__swap")).toBeDefined()
      expect(f.listCalls()).toBe(1) // the mount's own drain

      // A boundary with a CLEAN catalogue must not touch the wire.
      await f.boundary()
      expect(f.listCalls()).toBe(1)
      expect(f.registry.get("mcp__cat__after")).toBeUndefined()

      // The server swaps its list and announces it: still no eager refetch.
      await f.registry.get("mcp__cat__swap")!.execute({}, {})
      expect(f.listCalls()).toBe(1)
      expect(f.registry.get("mcp__cat__after")).toBeUndefined()

      // The next boundary rebuilds in place: one more drain, and the registry
      // reflects the NEW list — the old name is gone with it.
      await boundaryUntil(f, 2)
      expect(f.listCalls()).toBe(2)
      expect(f.registry.get("mcp__cat__after")).toBeDefined()
      expect(f.registry.get("mcp__cat__before")).toBeUndefined()
      expect(f.log().filter((line) => line === "notified").length).toBe(1)

      // Clean again: further boundaries do not re-drain (the flag was cleared).
      await f.boundary()
      expect(f.listCalls()).toBe(2)
    } finally {
      await f.assembly.dispose()
    }
  }, 30_000)

  it("a rebuild that cannot read a page reports, keeps the previous catalogue, and retries at the next boundary", async () => {
    const f = await mountCatalogueServer("fail-after-swap")
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message: string) => { warnings.push(String(message)) }
    try {
      await f.registry.get("mcp__cat__swap")!.execute({}, {})

      // The boundary MUST resolve: a background catalogue refresh is not on the
      // turn's critical path (the schedule driver's tick() is the precedent).
      await boundaryUntil(f, 2)
      expect(f.listCalls()).toBeGreaterThanOrEqual(2)
      expect(warnings.some((w) => w.includes("catalogue refresh failed"))).toBe(true)

      // The failed drain read no page, so nothing was swapped: the catalogue
      // still has every tool the previous generation registered.
      expect(f.registry.get("mcp__cat__before")).toBeDefined()
      expect(f.registry.get("mcp__cat__swap")).toBeDefined()

      // The flag survived the failure — the next boundary tries again.
      const before = f.listCalls()
      await f.boundary()
      expect(f.listCalls()).toBe(before + 1)
    } finally {
      console.warn = originalWarn
      await f.assembly.dispose()
    }
  }, 30_000)

  it("rebuilds on a server that never advertises tools.listChanged (the low-level registration is not capability-gated)", async () => {
    // The plan chose `client.setNotificationHandler` over `ClientOptions.listChanged`
    // partly BECAUSE the high-level path is gated on the server declaring the
    // capability (client/index.js's `_setupListChangedHandlers`). This case is that
    // premise measured: the server advertises `capabilities.tools = {}` — no
    // listChanged — and announces anyway. If the premise is false, the flag never
    // goes dirty, the boundary never drains, and `after` never appears.
    const f = await mountCatalogueServer("no-listChanged")
    try {
      // The handshake this case rests on, measured rather than assumed.
      expect(f.log()).toContain('capabilities:{"tools":{}}')
      expect(f.registry.get("mcp__cat__before")).toBeDefined()
      await f.registry.get("mcp__cat__swap")!.execute({}, {})
      await boundaryUntil(f, 2)
      expect(f.listCalls()).toBe(2)
      expect(f.registry.get("mcp__cat__after")).toBeDefined()
      expect(f.registry.get("mcp__cat__before")).toBeUndefined()
    } finally {
      await f.assembly.dispose()
    }
  }, 30_000)
})
