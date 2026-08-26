// Lifecycle tests for mountLspClient: the mount registers the lsp +
// lsp_diagnostics tools once the server finishes its initialize handshake;
// unmount unregisters both and disposes the instance (shutdown→exit); the
// serverName reservation is released on failed mounts AND unmounts, so a name
// can be re-mounted after either; unmount is idempotent. The fake LSP server
// is injected through deps.spawner — no real subprocess is spawned.
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import {
  mountLspClient,
  resolveFileInWorkspace,
  validateLspConfig,
  type LspServerConfig,
} from "../src/index.ts"
import { createFakeLspServer } from "./fake-server.ts"

const CAPS = { definitionProvider: true, referencesProvider: true, hoverProvider: true }

function config(overrides?: Partial<LspServerConfig>): LspServerConfig {
  return {
    serverName: "ts",
    command: "fake-lsp",
    args: ["--stdio"],
    cwd: ".",
    languages: [".ts"],
    shutdownTimeoutMs: 200,
    killGraceMs: 200,
    ...overrides,
  }
}

describe("mountLspClient lifecycle", () => {
  it("mount registers lsp + lsp_diagnostics; unmount unregisters both and disposes the instance (shutdown→exit)", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const server = createFakeLspServer({ initialize: { capabilities: CAPS }, shutdown: null })
    const handle = await mountLspClient(ctx, tools, config(), { spawner: server.spawner })
    expect(tools.get("lsp")).toBeDefined()
    expect(tools.get("lsp_diagnostics")).toBeDefined()
    await handle.unmount()
    expect(tools.get("lsp")).toBeUndefined()
    expect(tools.get("lsp_diagnostics")).toBeUndefined()
    // dispose ran: the bounded teardown sent shutdown BEFORE exit.
    const methods = server.server.methods
    const shutdownIdx = methods.indexOf("shutdown")
    const exitIdx = methods.indexOf("exit")
    expect(shutdownIdx).toBeGreaterThanOrEqual(0)
    expect(exitIdx).toBeGreaterThan(shutdownIdx)
  })

  it("throws on a duplicate live serverName", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const first = await mountLspClient(ctx, tools, config(), {
      spawner: createFakeLspServer({ initialize: { capabilities: CAPS }, shutdown: null }).spawner,
    })
    await expect(
      mountLspClient(ctx, tools, config(), {
        spawner: createFakeLspServer({ initialize: { capabilities: CAPS }, shutdown: null }).spawner,
      }),
    ).rejects.toThrow(/serverName|reserved|duplicate/)
    await first.unmount()
  })

  it("a throwing spawner fails the mount, releases the reservation and leaves no tools", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    await expect(
      mountLspClient(ctx, tools, config({ serverName: "spawn-boom" }), {
        spawner: () => {
          throw new Error("spawn exploded")
        },
      }),
    ).rejects.toThrow(/spawn exploded/)
    expect(tools.get("lsp")).toBeUndefined()
    // The reservation was released — a retry with a working server succeeds.
    const retry = await mountLspClient(ctx, tools, config({ serverName: "spawn-boom" }), {
      spawner: createFakeLspServer({ initialize: { capabilities: CAPS }, shutdown: null }).spawner,
    })
    await retry.unmount()
  })

  it("an initialize failure fails the mount, releases the reservation and disposes the instance", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const failing = createFakeLspServer({
      initialize: () => {
        throw new Error("init failed")
      },
      shutdown: null,
    })
    await expect(
      mountLspClient(ctx, tools, config({ serverName: "init-boom" }), { spawner: failing.spawner }),
    ).rejects.toThrow(/init failed/)
    expect(tools.get("lsp")).toBeUndefined()
    expect(failing.server.methods).toContain("exit") // the failed mount disposed the instance
    const retry = await mountLspClient(ctx, tools, config({ serverName: "init-boom" }), {
      spawner: createFakeLspServer({ initialize: { capabilities: CAPS }, shutdown: null }).spawner,
    })
    await retry.unmount()
  })

  it("unmount is idempotent: a second unmount no-ops (dispose ran exactly once)", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const server = createFakeLspServer({ initialize: { capabilities: CAPS }, shutdown: null })
    const handle = await mountLspClient(ctx, tools, config(), { spawner: server.spawner })
    await handle.unmount()
    await expect(handle.unmount()).resolves.toBeUndefined()
    expect(server.server.methods.filter((m) => m === "shutdown")).toHaveLength(1)
    expect(tools.get("lsp")).toBeUndefined()
  })

  it("unmount releases the reservation so the same serverName can be mounted again", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const first = await mountLspClient(ctx, tools, config({ serverName: "recycle" }), {
      spawner: createFakeLspServer({ initialize: { capabilities: CAPS }, shutdown: null }).spawner,
    })
    await first.unmount()
    const second = await mountLspClient(ctx, tools, config({ serverName: "recycle" }), {
      spawner: createFakeLspServer({ initialize: { capabilities: CAPS }, shutdown: null }).spawner,
    })
    await second.unmount()
  })
})

describe("validateLspConfig", () => {
  it("accepts a valid config and rejects bad serverName/command/languages/bounds", () => {
    expect(() => validateLspConfig(config())).not.toThrow()
    expect(() => validateLspConfig(config({ serverName: "bad name!" }))).toThrow(/serverName/)
    expect(() => validateLspConfig(config({ serverName: "x".repeat(33) }))).toThrow(/serverName/)
    expect(() => validateLspConfig(config({ command: "" }))).toThrow(/command/)
    expect(() => validateLspConfig(config({ languages: [] }))).toThrow(/languages/)
    expect(() => validateLspConfig(config({ maxMessageBytes: 0 }))).toThrow(/maxMessageBytes/)
    expect(() => validateLspConfig(config({ maxStderrBytes: -1 }))).toThrow(/maxStderrBytes/)
    expect(() => validateLspConfig(config({ killGraceMs: 1.5 }))).toThrow(/killGraceMs/)
    expect(() => validateLspConfig(config({ shutdownTimeoutMs: 0 }))).toThrow(/shutdownTimeoutMs/)
  })
})

describe("resolveFileInWorkspace", () => {
  it("passes absolute paths through unchanged and resolves relative paths against the workspace root", () => {
    const root = join(tmpdir(), "i-harness-ws")
    const abs = join(tmpdir(), "elsewhere", "a.ts")
    expect(resolveFileInWorkspace(root, abs)).toBe(abs)
    expect(resolveFileInWorkspace(root, "a.ts")).toBe(resolve(root, "a.ts"))
    expect(resolveFileInWorkspace(root, "src/inner/b.ts")).toBe(resolve(root, "src/inner/b.ts"))
  })
})
