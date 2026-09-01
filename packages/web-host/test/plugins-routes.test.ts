import { describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  InstallError,
  MarketplaceFetchError,
  PluginArtifactError,
  PluginConflictError,
  PluginNotFoundError,
  SourceConflictError,
  SourceNotFoundError,
} from "@i-harness/plugin-registry"
import { createWebHost, type WebHost, type WebHostOptions } from "../src/host.ts"
import type { PluginRegistryFace, PluginRuntimeView, PluginsCatalogView } from "../src/types.ts"

// M27-H-1: branch plugins.spec.ts route cases ported to the current fixture
// shape (no `workspacePath` option; the plugin seam needs no coordinator).
async function withHost(
  run: (base: string, host: WebHost) => Promise<void>,
  options: Partial<Omit<WebHostOptions, "port">> = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-plugins-"))
  const host = createWebHost({ port: 0, ...options })
  const { port } = await host.listen()
  try {
    await run(`http://127.0.0.1:${port}`, host)
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/** Every seam method is a mock; overrides replace individual methods. */
function fakeSeam(overrides: Partial<PluginRegistryFace> = {}): PluginRegistryFace {
  return {
    catalog: vi.fn(async (): Promise<PluginsCatalogView> => ({ sources: [], plugins: [] })),
    runtime: vi.fn((): PluginRuntimeView[] => []),
    addSource: vi.fn(async (_source: string): Promise<void> => {}),
    refreshSource: vi.fn(async (_name: string): Promise<void> => {}),
    removeSource: vi.fn(async (_name: string): Promise<void> => {}),
    install: vi.fn(async (_id: string): Promise<void> => {}),
    uninstall: vi.fn(async (_id: string): Promise<void> => {}),
    enable: vi.fn(async (_id: string): Promise<void> => {}),
    disable: vi.fn(async (_id: string): Promise<void> => {}),
    ...overrides,
  }
}

const demoView: PluginRuntimeView = {
  id: "mkt__demo",
  enabled: true,
  overall: "ready",
  capabilities: { skills: "ready", commands: "ready", mcp: "unsupported", executable: "unsupported" },
  commandStatuses: { hello: "ready" },
}

describe("plugins seam HTTP routes (task 6, ported)", () => {
  it("seam absent → every /api/plugins route answers 404 (optional-seam semantics)", async () => {
    await withHost(async (base) => {
      const expectations: Array<[string, string, string | undefined]> = [
        ["GET", "/api/plugins/catalog", undefined],
        ["GET", "/api/plugins/runtime", undefined],
        ["POST", "/api/plugins/source", JSON.stringify({ source: "http://localhost/x" })],
        ["POST", "/api/plugins/source/local/refresh", undefined],
        ["DELETE", "/api/plugins/source/local", undefined],
        ["POST", "/api/plugins/mkt__demo/install", undefined],
        ["POST", "/api/plugins/mkt__demo/uninstall", undefined],
        ["POST", "/api/plugins/mkt__demo/enable", undefined],
        ["POST", "/api/plugins/mkt__demo/disable", undefined],
      ]
      for (const [method, path, body] of expectations) {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body !== undefined ? { body } : {}),
        })
        expect(res.status, `${method} ${path}`).toBe(404)
      }
    })
  })

  it("GET /api/plugins/catalog answers the seam's { sources, plugins } view verbatim", async () => {
    const catalog: PluginsCatalogView = {
      sources: [{ name: "local", source: "D:/marketplace", lastUpdated: 12345 }],
      plugins: [{
        id: "mkt__demo", marketplace: "local", name: "demo", description: "demo plugin",
        source: "D:/marketplace", installed: true, enabled: true,
        capabilities: { skills: true, commands: true, mcp: false, executable: false },
        conflicts: [{ name: "hello", reason: "already registered by the host" }],
      }],
    }
    const seam = fakeSeam({ catalog: vi.fn(async () => catalog) })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/plugins/catalog`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(catalog)
    }, { pluginRegistry: seam })
    expect(seam.catalog).toHaveBeenCalledTimes(1)
  })

  it("GET /api/plugins/runtime answers { plugins } from the seam's runtime views verbatim", async () => {
    const seam = fakeSeam({ runtime: vi.fn(() => [demoView]) })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/plugins/runtime`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ plugins: [demoView] })
    }, { pluginRegistry: seam })
    expect(seam.runtime).toHaveBeenCalledTimes(1)
  })

  it("POST /api/plugins/source validates `source` (400 + plugin-source-invalid), then calls addSource", async () => {
    const seam = fakeSeam()
    await withHost(async (base) => {
      const badJson = await fetch(`${base}/api/plugins/source`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
      })
      expect(badJson.status).toBe(400)
      expect(((await badJson.json()) as { code: string }).code).toBe("plugin-source-invalid")
      const arrayBody = await fetch(`${base}/api/plugins/source`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "[]",
      })
      expect(arrayBody.status).toBe(400)
      for (const body of [{}, { source: "" }, { source: "   " }, { source: 42 }]) {
        const res = await fetch(`${base}/api/plugins/source`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        })
        expect(res.status, JSON.stringify(body)).toBe(400)
        expect(((await res.json()) as { code: string }).code).toBe("plugin-source-invalid")
      }
      expect(seam.addSource).not.toHaveBeenCalled()
      const ok = await fetch(`${base}/api/plugins/source`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "https://example.com/marketplace.json" }),
      })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({})
      expect(seam.addSource).toHaveBeenCalledWith("https://example.com/marketplace.json")
    }, { pluginRegistry: seam })
  })

  it("source failures map: MarketplaceFetchError → 400 with its code, SourceConflictError → 409", async () => {
    const unreachable = fakeSeam({
      addSource: vi.fn(async () => { throw new MarketplaceFetchError("git remote refused", "source-unreachable") }),
    })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/plugins/source`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://example.com/marketplace.json" }),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: "source-unreachable" })
    }, { pluginRegistry: unreachable })

    const invalid = fakeSeam({
      addSource: vi.fn(async () => { throw new MarketplaceFetchError("bad manifest JSON", "manifest-invalid") }),
    })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/plugins/source`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://example.com/marketplace.json" }),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: "manifest-invalid" })
    }, { pluginRegistry: invalid })

    const conflict = fakeSeam({
      addSource: vi.fn(async () => { throw new SourceConflictError("marketplace \"x\" already registered") }),
    })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/plugins/source`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://example.com/marketplace.json" }),
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: "source-name-conflict" })
    }, { pluginRegistry: conflict })
  })

  it("refresh + remove: 200 on success, 404 SourceNotFoundError, percent-encoded names decoded", async () => {
    const seam = fakeSeam({
      refreshSource: vi.fn(async (name: string) => {
        if (name === "ghost") throw new SourceNotFoundError(`source not found: ${name}`)
      }),
      removeSource: vi.fn(async (name: string) => {
        if (name === "ghost") throw new SourceNotFoundError(`source not found: ${name}`)
      }),
    })
    await withHost(async (base) => {
      const ok = await fetch(`${base}/api/plugins/source/my%20local/refresh`, { method: "POST" })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({})
      expect(seam.refreshSource).toHaveBeenCalledWith("my local")
      const gone = await fetch(`${base}/api/plugins/source/ghost/refresh`, { method: "POST" })
      expect(gone.status).toBe(404)
      expect(await gone.json()).toMatchObject({ code: "source-not-found" })
      const removed = await fetch(`${base}/api/plugins/source/my%20local`, { method: "DELETE" })
      expect(removed.status).toBe(200)
      expect(seam.removeSource).toHaveBeenCalledWith("my local")
      const missing = await fetch(`${base}/api/plugins/source/ghost`, { method: "DELETE" })
      expect(missing.status).toBe(404)
    }, { pluginRegistry: seam })
  })

  it("install/uninstall/enable/disable route to the seam with the decoded id", async () => {
    const seam = fakeSeam()
    await withHost(async (base) => {
      const actions: Array<[string, string]> = [
        ["install", "mkt__demo"],
        ["uninstall", "mkt__demo"],
        ["enable", "mkt__demo"],
        ["disable", "mkt__demo"],
      ]
      for (const [action, id] of actions) {
        const res = await fetch(`${base}/api/plugins/${encodeURIComponent(id)}/${action}`, { method: "POST" })
        expect(res.status, action).toBe(200)
        expect(await res.json()).toEqual({})
      }
      expect(seam.install).toHaveBeenCalledWith("mkt__demo")
      expect(seam.uninstall).toHaveBeenCalledWith("mkt__demo")
      expect(seam.enable).toHaveBeenCalledWith("mkt__demo")
      expect(seam.disable).toHaveBeenCalledWith("mkt__demo")
      expect((await fetch(`${base}/api/plugins/mkt__demo/retrofit`, { method: "POST" })).status).toBe(404)
    }, { pluginRegistry: seam })
  })

  it("plugin failures map: PluginNotFoundError → 404, PluginArtifactError → 400, PluginConflictError → 409", async () => {
    const notFound = fakeSeam({
      install: vi.fn(async () => { throw new PluginNotFoundError("plugin \"x\" is not listed") }),
    })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/plugins/x/install`, { method: "POST" })
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ code: "plugin-not-found" })
    }, { pluginRegistry: notFound })

    const artifact = fakeSeam({
      enable: vi.fn(async () => { throw new PluginArtifactError(`plugin "x" is not installed`) }),
    })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/plugins/x/enable`, { method: "POST" })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: "plugin-artifact" })
    }, { pluginRegistry: artifact })

    const conflict = fakeSeam({
      enable: vi.fn(async () => { throw new PluginConflictError(["hello"]) }),
    })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/plugins/x/enable`, { method: "POST" })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: "plugin-conflict" })
    }, { pluginRegistry: conflict })
  })

  it("InstallError maps by its own code: plugin-invalid → 400, install-failed → 500", async () => {
    const invalid = fakeSeam({
      uninstall: vi.fn(async () => { throw new InstallError("malformed plugin id", "plugin-invalid") }),
    })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/plugins/bad%20id/uninstall`, { method: "POST" })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: "plugin-invalid" })
    }, { pluginRegistry: invalid })

    const failed = fakeSeam({
      uninstall: vi.fn(async () => { throw new InstallError("disk error", "install-failed") }),
    })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/plugins/x/uninstall`, { method: "POST" })
      expect(res.status).toBe(500)
    }, { pluginRegistry: failed })
  })
})
