import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessClient, RpcNotification, ServerInfo } from "@i-harness/sdk"
import { createWorkspaceRuntimeManager } from "../src/main/sdk-runtime.ts"
import type { DesktopEvent } from "../src/shared/bridge.ts"
import type { WorkspaceEntry } from "../src/main/workspaces.ts"
import type { DesktopProjectContext } from "../src/main/project-runtime.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ih-desktop-runtime-"))
  roots.push(root)
  return root
}

interface FakeClientOptions {
  info?: Partial<ServerInfo>
  sandbox?: unknown
  dashboard?: unknown
  pending?: unknown
  failDashboard?: boolean
  failPending?: boolean
}

function fakeClient(options: FakeClientOptions = {}) {
  const listeners = new Set<(notification: RpcNotification) => void>()
  const close = vi.fn(async () => {})
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === "desktop/sandbox/state") return options.sandbox
    if (method === "session/dashboard") {
      if (options.failDashboard) throw new Error("dashboard offline")
      return options.dashboard ?? { sessions: [] }
    }
    if (method === "desktop/interaction/pending") {
      if (options.failPending) throw new Error("pending offline")
      return options.pending ?? []
    }
    throw new Error(`unexpected request: ${method}`)
  })
  const initialize = vi.fn(async (): Promise<ServerInfo> => ({
    name: "test-host",
    version: "0.1.0",
    protocolVersion: 3,
    capabilities: { session: ["prompt"], "session-list": ["1"] },
    ...options.info,
  }))
  return {
    client: {
      initialize,
      request,
      onNotification: (listener: (notification: RpcNotification) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      close,
    } as unknown as HarnessClient,
    close,
    initialize,
    request,
    listeners,
  }
}

function workspace(id = "ws-1", path = "C:/workspace"): WorkspaceEntry {
  return { id, path, label: id }
}

describe("Desktop SDK runtime manager", () => {
  it("single-flights concurrent gets and shuts each child down exactly once", async () => {
    const root = tempRoot()
    const host = fakeClient()
    let exited: (() => void) | undefined
    const launch = vi.fn(() => ({
      client: host.client,
      exited: new Promise<void>((resolve) => { exited = resolve }),
    }))
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(root, "sessions"), launch })

    const [first, second] = await Promise.all([manager.get(workspace()), manager.get(workspace())])

    expect(launch).toHaveBeenCalledTimes(1)
    expect(host.initialize).toHaveBeenCalledTimes(1)
    expect(first.client).toBe(second.client)
    expect(first.info.protocolVersion).toBe(3)
    expect(first.sandbox).toBeUndefined()

    await manager.close()
    await manager.close()
    expect(host.close).toHaveBeenCalledTimes(1)
    exited?.()
  })

  it("requests the sandbox claim only when the host advertises the capability", async () => {
    const root = tempRoot()
    const host = fakeClient({
      info: { capabilities: { session: ["prompt"], "desktop-sandbox": ["1"] } },
      sandbox: { mode: "read-only", source: "settings", wired: true },
    })
    const manager = createWorkspaceRuntimeManager({
      sessionsRoot: join(root, "sessions"),
      launch: () => ({ client: host.client, exited: new Promise(() => {}) }),
    })

    const runtime = await manager.get(workspace())

    expect(host.request).toHaveBeenCalledWith("desktop/sandbox/state", {})
    expect(runtime.sandbox).toEqual({ mode: "read-only", source: "settings", wired: true })
    await manager.close()
  })

  it("rejects a non-v3 host and a bogus sandbox claim, closing each child", async () => {
    const root = tempRoot()
    const old = fakeClient({ info: { protocolVersion: 2 } })
    const oldManager = createWorkspaceRuntimeManager({
      sessionsRoot: join(root, "sessions-old"),
      launch: () => ({ client: old.client, exited: new Promise(() => {}) }),
    })
    await expect(oldManager.get(workspace())).rejects.toThrow(/protocol/i)
    expect(old.close).toHaveBeenCalledTimes(1)
    await oldManager.close()

    const bogus = fakeClient({
      info: { capabilities: { "desktop-sandbox": ["1"] } },
      sandbox: { mode: "workspace-write", source: "settings", wired: false },
    })
    const bogusManager = createWorkspaceRuntimeManager({
      sessionsRoot: join(root, "sessions-bogus"),
      launch: () => ({ client: bogus.client, exited: new Promise(() => {}) }),
    })
    await expect(bogusManager.get(workspace())).rejects.toThrow(/sandbox/i)
    expect(bogus.close).toHaveBeenCalledTimes(1)
    await bogusManager.close()
  })

  it("emits sdk/disconnected on child exit and restarts on the next get", async () => {
    const root = tempRoot()
    const hosts = [fakeClient(), fakeClient()]
    const exits: Array<() => void> = []
    let call = 0
    const launch = vi.fn(() => {
      const host = hosts[call++]!
      return {
        client: host.client,
        exited: new Promise<void>((resolve) => { exits.push(resolve) }),
      }
    })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(root, "sessions"), launch })
    const events: DesktopEvent[] = []
    const off = manager.onEvent((event) => events.push(event))

    const first = await manager.get(workspace("ws-exit"))
    exits[0]!()
    await new Promise((resolve) => setImmediate(resolve))

    expect(events).toEqual([
      { kind: "sdk/disconnected", workspaceId: "ws-exit", message: expect.stringContaining("exited") },
    ])
    const second = await manager.get(workspace("ws-exit"))
    expect(launch).toHaveBeenCalledTimes(2)
    expect(second.client).not.toBe(first.client)

    off()
    await manager.close()
  })

  it("forwards session and desktop-interaction notifications only", async () => {
    const root = tempRoot()
    const host = fakeClient()
    const manager = createWorkspaceRuntimeManager({
      sessionsRoot: join(root, "sessions"),
      launch: () => ({ client: host.client, exited: new Promise(() => {}) }),
    })
    const events: DesktopEvent[] = []
    manager.onEvent((event) => events.push(event))
    await manager.get(workspace("ws-notes"))

    const notify = (method: string): void => {
      for (const listener of [...host.listeners]) listener({ jsonrpc: "2.0", method, params: { seq: 0 } } as RpcNotification)
    }
    notify("session/event")
    notify("session/status")
    notify("session/queue")
    notify("desktop/interaction/request")
    notify("desktop/interaction/closed")

    expect(events).toEqual([
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "session/event", params: { seq: 0 } },
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "session/status", params: { seq: 0 } },
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "desktop/interaction/request", params: { seq: 0 } },
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "desktop/interaction/closed", params: { seq: 0 } },
    ])
    await manager.close()
  })
})

describe("project scope publication", () => {
  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    return { promise, resolve }
  }

  it("fences a starting gateway until it has the latest folders after a concurrent save", async () => {
    const host = fakeClient({ info: { capabilities: { "desktop-project-scope": ["1"] } } })
    const entered = deferred()
    const release = deferred()
    let scopes: DesktopProjectContext[] = [{ id: "p", name: "Project", roots: ["D:/a", "D:/removed"] }]
    let authority: DesktopProjectContext[] = []
    let first = true
    host.request.mockImplementation(async (method, params) => {
      if (method !== "desktop/project/sync") throw new Error(`unexpected request: ${method}`)
      if (first) { first = false; entered.resolve(); await release.promise }
      authority = (params as { projects: DesktopProjectContext[] }).projects
      return {}
    })
    const manager = createWorkspaceRuntimeManager({
      sessionsRoot: join(tempRoot(), "sessions"), projectContexts: async () => scopes,
      launch: () => ({ client: host.client, exited: new Promise(() => {}) }),
    })
    const starting = manager.get(workspace())
    await entered.promise
    scopes = [{ id: "p", name: "Project", roots: ["D:/a"] }]
    const refresh = manager.refreshProjectContexts?.()
    release.resolve()
    await starting
    // A workflow awaiting get() must never observe the revoked root, even
    // before the save's publication promise completes.
    expect(authority).toEqual(scopes)
    await refresh
    expect(authority).toEqual(scopes)
    await manager.close()
  })

  it("invalidates an owned starting child and never publishes it as ready", async () => {
    const first = fakeClient()
    const next = fakeClient()
    const entered = deferred()
    const release = deferred()
    first.initialize.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return { name: "old", version: "1", protocolVersion: 3, capabilities: {} }
    })
    let launches = 0
    const manager = createWorkspaceRuntimeManager({
      sessionsRoot: join(tempRoot(), "sessions"),
      launch: () => ({ client: launches++ === 0 ? first.client : next.client, exited: new Promise(() => {}) }),
    })
    const starting = manager.get(workspace())
    const outcome = starting.then(() => "published", () => "invalidated")
    await entered.promise
    const invalidating = manager.invalidate!(workspace().id)
    release.resolve()
    await invalidating
    expect(await outcome).toBe("invalidated")
    expect(manager.peek!(workspace().id)).toBeUndefined()
    expect(first.close).toHaveBeenCalledTimes(1)
    expect((await manager.get(workspace())).client).toBe(next.client)
    await manager.close()
  })

  it("serializes folder publications and closes a ready gateway when publication fails", async () => {
    const host = fakeClient({ info: { capabilities: { "desktop-project-scope": ["1"] } } })
    let scopes: DesktopProjectContext[] = [{ id: "p", name: "P", roots: ["D:/a", "D:/b"] }]
    let authority: DesktopProjectContext[] = []
    const entered = deferred()
    const release = deferred()
    let hold = false
    let fail = false
    host.request.mockImplementation(async (_method, params) => {
      if (hold) { hold = false; entered.resolve(); await release.promise }
      if (fail) throw new Error("scope rejected")
      authority = (params as { projects: DesktopProjectContext[] }).projects
      return {}
    })
    const launch = vi.fn(() => ({ client: host.client, exited: new Promise<void>(() => {}) }))
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), projectContexts: async () => scopes, launch })
    await manager.get(workspace())
    hold = true
    const first = manager.refreshProjectContexts!()
    await entered.promise
    scopes = [{ id: "p", name: "P", roots: [] }]
    const latest = manager.refreshProjectContexts!()
    release.resolve()
    await Promise.all([first, latest])
    expect(authority).toEqual(scopes)
    expect(launch).toHaveBeenCalledTimes(1)
    fail = true
    await expect(manager.refreshProjectContexts!()).rejects.toThrow("Project scope update failed")
    expect(manager.peek!(workspace().id)).toBeUndefined()
    expect(host.close).toHaveBeenCalledTimes(1)
    await manager.close()
  })

  it("drains a held startup during shutdown and rejects future gets", async () => {
    const host = fakeClient({ info: { capabilities: { "desktop-project-scope": ["1"] } } })
    const entered = deferred()
    const release = deferred()
    host.request.mockImplementation(async () => { entered.resolve(); await release.promise; return {} })
    const manager = createWorkspaceRuntimeManager({
      sessionsRoot: join(tempRoot(), "sessions"), projectContexts: async () => [],
      launch: () => ({ client: host.client, exited: new Promise(() => {}) }),
    })
    const startup = manager.get(workspace()).then(() => "published", () => "closed")
    await entered.promise
    let done = false
    const closing = manager.close().then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    release.resolve()
    await closing
    expect(await startup).toBe("closed")
    expect(host.close).toHaveBeenCalledTimes(1)
    await expect(manager.get(workspace())).rejects.toThrow("closed")
  })
})

const workCapabilities = { "session-dashboard": ["1"], "desktop-interaction": ["1"] }

describe("Desktop close-time active work", () => {
  it("returns false before any SDK runtime has started", async () => {
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => { throw new Error("should not launch") } })
    expect(await manager.hasActiveWork()).toBe(false)
    await manager.close()
  })

  it("keeps a process during an in-flight SDK startup", async () => {
    const host = fakeClient({ info: { capabilities: workCapabilities } })
    let release!: (value: ServerInfo) => void
    host.initialize.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => ({ client: host.client, exited: new Promise(() => {}) }) })
    const starting = manager.get(workspace())
    expect(await manager.hasActiveWork()).toBe(true)
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    release({ name: "test-host", version: "0.1.0", protocolVersion: 3, capabilities: workCapabilities })
    await starting
    await manager.close()
  })

  it.each([
    { running: true }, { queued: 1 }, { tasks: 1 },
  ])("keeps a host with active dashboard state %j", async (activity) => {
    const host = fakeClient({ info: { capabilities: workCapabilities }, dashboard: { sessions: [{ id: "s", live: true, ...activity }] } })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => ({ client: host.client, exited: new Promise(() => {}) }) })
    await manager.get(workspace())
    expect(await manager.hasActiveWork()).toBe(true)
    await manager.close()
  })

  it("keeps a host waiting for an approval even when dashboard is idle", async () => {
    const host = fakeClient({ info: { capabilities: workCapabilities }, dashboard: { sessions: [{ id: "s", live: true, running: false }] }, pending: [{ requestId: "p", sessionId: "s" }] })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => ({ client: host.client, exited: new Promise(() => {}) }) })
    await manager.get(workspace())
    expect(await manager.hasActiveWork()).toBe(true)
    expect(host.request).toHaveBeenCalledWith("desktop/interaction/pending", {}, 2_500)
    await manager.close()
  })

  it("allows an idle host to exit only after both authoritative reads succeed", async () => {
    const host = fakeClient({ info: { capabilities: workCapabilities }, dashboard: { sessions: [{ id: "s", live: true, running: false }] } })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => ({ client: host.client, exited: new Promise(() => {}) }) })
    await manager.get(workspace())
    expect(await manager.hasActiveWork()).toBe(false)
    expect(host.request).toHaveBeenCalledWith("session/dashboard", {}, 2_500)
    expect(host.request).toHaveBeenCalledWith("desktop/interaction/pending", {}, 2_500)
    await manager.close()
  })

  it("does not report idle if another workspace starts during the SDK reads", async () => {
    let release!: (value: unknown) => void
    const first = fakeClient({ info: { capabilities: workCapabilities }, dashboard: new Promise((resolve) => { release = resolve }) })
    const second = fakeClient({ info: { capabilities: workCapabilities } })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: (entry) => ({ client: entry.id === "a" ? first.client : second.client, exited: new Promise(() => {}) }) })
    await manager.get(workspace("a"))
    const closing = manager.hasActiveWork()
    await vi.waitFor(() => expect(first.request).toHaveBeenCalledWith("session/dashboard", {}, 2_500))
    const starting = manager.get(workspace("b"))
    release({ sessions: [] })
    expect(await closing).toBe(true)
    await starting
    await manager.close()
  })

  it("does not report idle when SDK activity arrives during close-time reads", async () => {
    let release!: (value: unknown) => void
    const host = fakeClient({ info: { capabilities: workCapabilities }, dashboard: new Promise((resolve) => { release = resolve }) })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => ({ client: host.client, exited: new Promise(() => {}) }) })
    await manager.get(workspace())
    const closing = manager.hasActiveWork()
    await vi.waitFor(() => expect(host.request).toHaveBeenCalledWith("session/dashboard", {}, 2_500))
    for (const listener of host.listeners) listener({ jsonrpc: "2.0", method: "session/status", params: { sessionId: "s", status: "queued" } })
    release({ sessions: [{ id: "s", live: true, running: false }] })
    expect(await closing).toBe(true)
    await manager.close()
  })

  it.each([
    { info: { capabilities: { "session-dashboard": ["1"] } } },
    { dashboard: { sessions: [], listingUnavailable: true } },
    { dashboard: { sessions: "bad" } },
    { dashboard: { sessions: [{ id: "s" }] } },
    { dashboard: { sessions: [{ id: "s", live: true }] } },
    { dashboard: { sessions: [{ id: "s", live: "yes" }] } },
    { failDashboard: true },
    { failPending: true },
  ])("retains the host when close-time activity is unknown: %j", async (options) => {
    const host = fakeClient({ info: { capabilities: workCapabilities }, ...options })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => ({ client: host.client, exited: new Promise(() => {}) }) })
    await manager.get(workspace())
    expect(await manager.hasActiveWork()).toBe(true)
    await manager.close()
  })
})
