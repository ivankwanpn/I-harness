import { afterEach, describe, expect, it, vi } from "vitest"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessClient, RpcNotification, ServerInfo } from "@i-harness/sdk"
import { createWorkspaceRuntimeManager } from "../src/main/sdk-runtime.ts"
import { createSharedDesktopHost } from "../src/main/shared-desktop-host.ts"
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

function activityFixture() {
  const root = tempRoot(), sessionsRoot = join(root, "sessions")
  const entry = join(root, "gateway", "cli", "src")
  mkdirSync(sessionsRoot)
  mkdirSync(entry, { recursive: true })
  writeFileSync(join(entry, "package.json"), '{"type":"module"}')
  copyFileSync(new URL("./helpers/activity-host.mjs", import.meta.url), join(entry, "cli.js"))
  return { root, sessionsRoot, workspace: (id: string) => ({ id, label: id, path: root }) }
}

it("uses one shared-host probe per decision, requires complete results, and retains profile-owned work", async () => {
  const f = activityFixture(), manager = createWorkspaceRuntimeManager({ sessionsRoot: f.sessionsRoot, resourcesPath: f.root })
  const events: DesktopEvent[] = []
  const unsubscribe = manager.onEvent(event => events.push(event))
  try {
    const [a, b] = await Promise.all([manager.get(f.workspace("a")), manager.get(f.workspace("b"))])
    expect(a.hostPid).toBe(b.hostPid)
    expect(await manager.hasActiveWork()).toBe(false)
    expect(await a.client.request("stats")).toMatchObject({ probes: 1, inner: 0 })
    for (const value of ["missing", "duplicate", "foreign", "unknown"]) {
      await b.client.request("mode", { value })
      expect(await manager.hasActiveWork()).toBe(true)
    }
    await b.client.request("mode", { value: "idle" })
    await a.client.request("login", { active: true })
    expect(await manager.hasActiveWork()).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(await manager.evictIdle!(1)).toBe(2)
    expect(events.filter(event => event.kind === "sdk/idle")).toEqual(expect.arrayContaining([
      { kind: "sdk/idle", method: "sdk/idle", workspaceId: "a", runtimeGeneration: a.generation },
      { kind: "sdk/idle", method: "sdk/idle", workspaceId: "b", runtimeGeneration: b.generation },
    ]))
    expect(events.some(event => event.kind === "sdk/disconnected")).toBe(false)
    expect(await manager.hasActiveWork()).toBe(true)
    const reopened = await manager.get(f.workspace("a"))
    expect(reopened.generation).toBe((a.generation ?? 0) + 1)
    expect(reopened.hostPid).toBe(a.hostPid)
    await reopened.client.request("login", { active: false })
    expect(await manager.hasActiveWork()).toBe(false)
    expect(await reopened.client.request("stats")).toMatchObject({ inner: 0 })
  } finally { unsubscribe(); await manager.close() }
})

it.each(["idle sweep", "dismissed window"])("retries an idle owner's failed release via %s", async trigger => {
  const f = activityFixture(), manager = createWorkspaceRuntimeManager({ sessionsRoot: f.sessionsRoot, resourcesPath: f.root })
  try {
    const runtime = await manager.get(f.workspace("retiring"))
    await runtime.client.request("mode", { value: "fail-close-once" })
    await new Promise(resolve => setTimeout(resolve, 5))
    await expect(manager.evictIdle!(1)).rejects.toThrow("retry cleanup")
    expect(manager.peek!("retiring")).toBeUndefined()
    if (trigger === "idle sweep") expect(await manager.evictIdle!(1)).toBe(1)
    await vi.waitFor(async () => expect(await manager.hasActiveWork()).toBe(false))
    expect(await (await manager.get(f.workspace("retiring"))).client.request("ping")).toEqual({ ok: true })
  } finally { await manager.close() }
})

it("uses SDK activity when an older shared host does not advertise process reports", async () => {
  const f = activityFixture(), manager = createWorkspaceRuntimeManager({ sessionsRoot: f.sessionsRoot, resourcesPath: f.root })
  try {
    const runtime = await manager.get(f.workspace("legacy"))
    expect(await manager.hasActiveWork()).toBe(false)
    expect(await runtime.client.request("stats")).toMatchObject({ probes: 0, inner: 1 })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(await manager.evictIdle!(1)).toBe(1)
  } finally { await manager.close() }
})

it("cannot apply a suspended activity result to a reopened channel of the same name", async () => {
  const f = activityFixture(), host = createSharedDesktopHost(f.sessionsRoot, f.root)
  const a = await host.launch(f.workspace("a")), b = await host.launch(f.workspace("b"))
  try {
    await Promise.all([a.ready, b.ready])
    await a.client.request("mode", { value: "hold" })
    const inspecting = host.inspectActivity(["a", "b"])
    await vi.waitFor(async () => expect(await b.client.request("stats")).toMatchObject({ held: true }))
    await a.client.close()
    const replacement = await host.launch(f.workspace("a"))
    await replacement.ready
    await b.client.request("release")
    expect((await inspecting).idle).toEqual(new Set(["b"]))
    await replacement.client.close()
  } finally { await b.client.close(); await host.close() }
})

it("launches the bundled CLI through a junction using its original entry path", async () => {
  const root = tempRoot()
  const resources = join(root, "resources")
  const linkedResources = join(root, "linked-resources")
  const entryDir = join(resources, "gateway", "cli", "src")
  mkdirSync(entryDir, { recursive: true })
  writeFileSync(join(entryDir, "package.json"), JSON.stringify({ type: "module" }))
  writeFileSync(join(entryDir, "cli.js"), `
    import { createInterface } from "node:readline";
    import { pathToFileURL } from "node:url";
    if (pathToFileURL(process.argv[1]).href === import.meta.url) {
      const lines = createInterface({input: process.stdin});
      let retry = true;
      lines.on("line", line => {
        const frame=JSON.parse(line), {workspaceId}=frame;
        const send=value=>process.stdout.write(JSON.stringify(value)+"\\n");
        if(frame.type==="shutdown"){lines.close();process.stdin.pause();return}
        if(frame.type==="open"){send({type:"opened",workspaceId});return}
        if(frame.type==="close"){
          if(workspaceId==="retry" && retry){retry=false;send({type:"error",operation:"close",workspaceId,message:"cleanup still pending"});return}
          send({type:"closed",workspaceId});return
        }
        const {id, method} = JSON.parse(frame.line);
        if(method==="fail-channel"){
          send({type:"error",workspaceId,operation:"data",message:"Failed workspace RPC"});
          send({type:"data",workspaceId,line:JSON.stringify({jsonrpc:"2.0",id,result:{obsolete:true}})});
          return;
        }
        const result = method === "initialize"
          ? {name: "joined-entry", version: "1.0.0", protocolVersion: 3, capabilities: {}}
          : {ok: true};
        if (id !== undefined) send({type:"data",workspaceId,line:JSON.stringify({jsonrpc: "2.0", id, result})});
      });
    }
  `)
  symlinkSync(resources, linkedResources, process.platform === "win32" ? "junction" : "dir")
  const shared = createSharedDesktopHost(root, linkedResources)
  const launch = await shared.launch({ id: "linked", label: "linked", path: root })
  try {
    await launch.ready
    expect(await launch.client.initialize()).toMatchObject({ name: "joined-entry", protocolVersion: 3 })
    const retry = await shared.launch({ id: "retry", label: "retry", path: root })
    await retry.ready
    expect(retry.hostPid).toBe(launch.hostPid)
    await expect(retry.client.close()).rejects.toThrow("cleanup still pending")
    await expect(launch.client.request("ping")).resolves.toEqual({ok:true})
    await retry.client.close()
    await retry.exited
    const broken = await shared.launch({ id: "broken", label: "broken", path: root })
    await broken.ready
    await expect(broken.client.request("fail-channel")).rejects.toThrow()
    await broken.client.close()
    await broken.exited
    expect(await launch.client.request("ping")).toEqual({ok:true})
  } finally {
    await launch.client.close()
    await launch.exited
    await shared.close()
  }
})

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
  const exit = Promise.withResolvers<void>()
  const close = vi.fn(async () => { exit.resolve() })
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
    exited: exit.promise,
    exit: exit.resolve,
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
    const launch = vi.fn(() => host)
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
  })

  it("requests the sandbox claim only when the host advertises the capability", async () => {
    const root = tempRoot()
    const host = fakeClient({
      info: { capabilities: { session: ["prompt"], "desktop-sandbox": ["1"] } },
      sandbox: { mode: "read-only", source: "settings", wired: true },
    })
    const manager = createWorkspaceRuntimeManager({
      sessionsRoot: join(root, "sessions"),
      launch: () => host,
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
      launch: () => old,
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
      launch: () => bogus,
    })
    await expect(bogusManager.get(workspace())).rejects.toThrow(/sandbox/i)
    expect(bogus.close).toHaveBeenCalledTimes(1)
    await bogusManager.close()
  })

  it("emits sdk/disconnected on child exit and restarts on the next get", async () => {
    const root = tempRoot()
    const hosts = [fakeClient(), fakeClient()]
    let call = 0
    const launch = vi.fn(() => hosts[call++]!)
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(root, "sessions"), launch })
    const events: DesktopEvent[] = []
    const off = manager.onEvent((event) => events.push(event))

    const first = await manager.get(workspace("ws-exit"))
    hosts[0]!.exit()
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter(event=>event.kind==='sdk/ready')).toEqual([{kind:'sdk/ready',method:'sdk/ready',workspaceId:'ws-exit',runtimeGeneration:0}])
    expect(events.filter(event=>event.kind!=='sdk/ready')).toEqual([
      { kind: "sdk/disconnected", workspaceId: "ws-exit", message: expect.stringContaining("exited"), close: { generation: 0, reason: "subprocess-exited" } },
    ])
    const second = await manager.recover!(workspace("ws-exit"))
    expect(launch).toHaveBeenCalledTimes(2)
    expect(second.client).not.toBe(first.client)
    expect(events.filter(event => event.kind === "sdk/ready").map(event => event.runtimeGeneration)).toEqual([0, 1])

    off()
    await manager.close()
  })

  it("snapshots only the live reply belonging to the opened workspace and session", async () => {
    const hosts = [fakeClient(), fakeClient()]
    let next = 0
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => hosts[next++]! })
    const emit = (index: number, event: object) => {
      for (const listener of hosts[index]!.listeners) listener({ jsonrpc: "2.0", method: "session/event", params: { sessionId: "same", event } })
    }
    const chunk = (offset: number, text: string) => ({ type: "assistant/chunk", stepStartSeq: 3, text, offset })
    try {
      const a = await manager.get(workspace("a"))
      const b = await manager.get(workspace("b"))
      emit(0, chunk(0, "one")); emit(1, chunk(0, "other")); emit(0, chunk(3, " two"))
      expect(a.assistantPreview!("same")?.text).toBe("one two")
      expect(b.assistantPreview!("same")?.text).toBe("other")
      emit(0, { type: "assistant/message", text: "one two", seq: 4 })
      expect(a.assistantPreview!("same")).toBeUndefined()
      expect(b.assistantPreview!("same")?.text).toBe("other")
    } finally { await manager.close() }
  })

  it("fences context diagnostic delivery by the actual runtime generation", async () => {
    const hosts = [fakeClient(), fakeClient()]
    let nextHost = 0
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => hosts[nextHost++]! })
    const events: DesktopEvent[] = []
    manager.onEvent(event => events.push(event))
    const notify = (index: number) => { for (const listener of hosts[index]!.listeners) listener({ jsonrpc: "2.0", method: "desktop/context/diagnostic", params: { sessionId: "owned" } } as RpcNotification) }
    try {
      await manager.get(workspace("generation"))
      notify(0)
      await manager.invalidate!("generation")
      notify(0)
      await manager.get(workspace("generation"))
      notify(0); notify(1)
      expect(events.filter(event => event.kind === "sdk/notification")).toEqual([
        { kind: "sdk/notification", workspaceId: "generation", method: "desktop/context/diagnostic", params: { sessionId: "owned", runtimeGeneration: 0 } },
        { kind: "sdk/notification", workspaceId: "generation", method: "desktop/context/diagnostic", params: { sessionId: "owned", runtimeGeneration: 1 } },
      ])
    } finally { await manager.close() }
  })
  it("forwards declared session, interaction and usage diagnostic notifications", async () => {
    const root = tempRoot()
    const host = fakeClient()
    const manager = createWorkspaceRuntimeManager({
      sessionsRoot: join(root, "sessions"),
      launch: () => host,
    })
    const events: DesktopEvent[] = []
    manager.onEvent((event) => events.push(event))
    await manager.get(workspace("ws-notes"))

    const notify = (method: string): void => {
      for (const listener of [...host.listeners]) listener({ jsonrpc: "2.0", method, params: { seq: 0 } } as RpcNotification)
    }
    notify("session/event")
    notify("session/status")
    notify("session/execution-state")
    notify("session/queue")
    notify("desktop/interaction/request")
    notify("desktop/interaction/closed")
    notify("desktop/usage/recording-warning")
    notify("desktop/context/diagnostic")
    notify("desktop/session/subagents/changed")

    expect(events.filter(event=>event.kind==='sdk/ready')).toEqual([{kind:'sdk/ready',method:'sdk/ready',workspaceId:'ws-notes',runtimeGeneration:0}])
    expect(events.filter(event=>event.kind!=='sdk/ready')).toEqual([
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "session/event", params: { seq: 0 } },
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "session/status", params: { seq: 0 } },
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "session/execution-state", params: { seq: 0 } },
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "desktop/interaction/request", params: { seq: 0 } },
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "desktop/interaction/closed", params: { seq: 0 } },
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "desktop/usage/recording-warning", params: { seq: 0 } },
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "desktop/context/diagnostic", params: { seq: 0, runtimeGeneration: 0 } },
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "desktop/session/subagents/changed", params: { seq: 0 } },
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
      launch: () => host,
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
      launch: () => launches++ === 0 ? first : next,
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
    const launch = vi.fn(() => host)
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
      launch: () => host,
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
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => host })
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
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => host })
    await manager.get(workspace())
    expect(await manager.hasActiveWork()).toBe(true)
    await manager.close()
  })

  it("keeps a host waiting for an approval even when dashboard is idle", async () => {
    const host = fakeClient({ info: { capabilities: workCapabilities }, dashboard: { sessions: [{ id: "s", live: true, running: false }] }, pending: [{ requestId: "p", sessionId: "s" }] })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => host })
    await manager.get(workspace())
    expect(await manager.hasActiveWork()).toBe(true)
    expect(host.request).toHaveBeenCalledWith("desktop/interaction/pending", {}, 2_500)
    await manager.close()
  })

  it("allows an idle host to exit only after both authoritative reads succeed", async () => {
    const host = fakeClient({ info: { capabilities: workCapabilities }, dashboard: { sessions: [{ id: "s", live: true, running: false }] } })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => host })
    await manager.get(workspace())
    expect(await manager.hasActiveWork()).toBe(false)
    expect(host.request).toHaveBeenCalledWith("session/dashboard", {}, 2_500)
    expect(host.request).toHaveBeenCalledWith("desktop/interaction/pending", {}, 2_500)
    await manager.close()
  })

  it.each(["idle", "busy", "unknown", "access-during-recheck"] as const)("rechecks an idle close after a concurrent runtime lookup: %s", async outcome => {
    const first = Promise.withResolvers<unknown>(), second = Promise.withResolvers<unknown>()
    const host = fakeClient({ info: { capabilities: { "desktop-runtime-activity": ["1"] } } })
    host.request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => host })
    try {
      await manager.get(workspace())
      const closing = manager.hasActiveWork()
      await manager.get(workspace()) // a passive post-turn read obtained the existing client
      first.resolve({ active: false })
      await vi.waitFor(() => expect(host.request).toHaveBeenCalledTimes(2))
      if (outcome === "access-during-recheck") await manager.get(workspace())
      if (outcome === "unknown") second.reject(new Error("gateway unavailable"))
      else second.resolve({ active: outcome === "busy" })
      expect(await closing).toBe(outcome !== "idle")
      expect(host.request).toHaveBeenCalledTimes(2)
    } finally { first.resolve({ active: false }); second.resolve({ active: false }); await manager.close() }
  })

  it.each([
    [{ active: false }, false],
    [{ active: true }, true],
    [{}, true],
    [{ active: "idle" }, true],
  ] as const)("uses the gateway activity probe for close and eviction: %j", async (response, keep) => {
    const host = fakeClient({ info: { capabilities: { "desktop-runtime-activity": ["1"] } } })
    host.request.mockImplementation(async method => {
      if (method !== "desktop/runtime/activity") throw Error("Unexpected history or interaction query")
      return response
    })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => host })
    try {
      await manager.get(workspace())
      await new Promise(resolve => setTimeout(resolve, 5))
      expect(await manager.hasActiveWork()).toBe(keep)
      expect(await manager.evictIdle!(1)).toBe(keep ? 0 : 1)
      expect(host.request.mock.calls).toEqual(Array(2).fill(["desktop/runtime/activity", {}, 2_500]))
    } finally { await manager.close() }
  })

  it("does not report idle if another workspace starts during the SDK reads", async () => {
    let release!: (value: unknown) => void
    const first = fakeClient({ info: { capabilities: workCapabilities }, dashboard: new Promise((resolve) => { release = resolve }) })
    const second = fakeClient({ info: { capabilities: workCapabilities } })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: (entry) => entry.id === "a" ? first : second })
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
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => host })
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
    { dashboard: { sessions: [{ id: "s", live: false, queued: -1 }] } },
    { dashboard: { sessions: [{ id: "s", live: false, running: "unknown" }] } },
    { failDashboard: true },
    { failPending: true },
  ])("retains the host when close-time activity is unknown: %j", async (options) => {
    const host = fakeClient({ info: { capabilities: workCapabilities }, ...options })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => host })
    await manager.get(workspace())
    try {
      expect(await manager.hasActiveWork()).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 5))
      expect(await manager.evictIdle!(1)).toBe(0)
    } finally { await manager.close() }
  })

  it("can retire an idle workspace while another workspace streams", async () => {
    const checking = Promise.withResolvers<unknown>()
    const idle = fakeClient({ info: { capabilities: workCapabilities }, dashboard: checking.promise })
    const busy = fakeClient({ info: { capabilities: workCapabilities }, dashboard: { active: true, sessions: [] } })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: ws => ws.id === "idle" ? idle : busy })
    try {
      await Promise.all([manager.get(workspace("idle")), manager.get(workspace("busy"))])
      await new Promise(resolve => setTimeout(resolve, 5))
      const sweep = manager.evictIdle!(1)
      await vi.waitFor(() => expect(idle.request).toHaveBeenCalledWith("session/dashboard", {}, 2_500))
      for (const listener of busy.listeners) listener({ jsonrpc: "2.0", method: "session/event", params: { sessionId: "b", event: { type: "assistant/chunk", text: "reply" } } })
      checking.resolve({ sessions: [] })
      expect(await sweep).toBe(1)
      expect(idle.close).toHaveBeenCalledOnce()
      expect(busy.close).not.toHaveBeenCalled()
    } finally { checking.resolve({ sessions: [] }); await manager.close() }
  })

  it("avoids duplicate idle inspections and observes a same-timestamp use of the inspected workspace", async () => {
    vi.useFakeTimers()
    const checked = Promise.withResolvers<unknown>()
    const host = fakeClient({ info: { capabilities: workCapabilities }, dashboard: checked.promise })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => host })
    try {
      await manager.get(workspace())
      // Keep the clock fixed so a request cannot be distinguished by comparing timestamps.
      vi.setSystemTime(Date.now() + 1_000)
      const first = manager.evictIdle!(1)
      await expect(manager.evictIdle!(1)).resolves.toBe(0)
      // Simulate the system clock returning to its previous reading.
      vi.setSystemTime(Date.now() - 1_000)
      await manager.get(workspace())
      checked.resolve({ sessions: [] })
      expect(await first).toBe(0)
      expect(host.close).not.toHaveBeenCalled()
      expect(host.request.mock.calls.filter(([method]) => method === "session/dashboard")).toHaveLength(1)
    } finally { checked.resolve({ sessions: [] }); await manager.close(); vi.useRealTimers() }
  })

  it("gives a restarted child its own health budget and withdraws an unhealthy connection until OS exit", async () => {
    vi.useFakeTimers()
    const first = fakeClient(), second = fakeClient()
    second.close.mockResolvedValue(undefined)
    const launch = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch })
    try {
      await manager.get(workspace())
      await vi.advanceTimersByTimeAsync(20_000)
      expect(first.request).toHaveBeenCalledWith("ping", {}, 10_000)
      first.exit()
      await vi.advanceTimersByTimeAsync(600)
      const replacement = await manager.get(workspace())
      await vi.advanceTimersByTimeAsync(20_000)
      expect(manager.peek!(workspace().id)).toBe(replacement)
      expect(second.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(second.close).toHaveBeenCalledOnce()
      expect(manager.peek!(workspace().id)).toBeUndefined()
      await expect(manager.get(workspace())).rejects.toThrow(/recovery/)
      expect(launch).toHaveBeenCalledTimes(2)
    } finally { second.exit(); await manager.close(); vi.useRealTimers() }
  })

  it("retains a host when activity arrives during idle inspection", async () => {
    let release!: (value: unknown) => void
    const host = fakeClient({ info: { capabilities: workCapabilities }, dashboard: new Promise(resolve => { release = resolve }) })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => host })
    await manager.get(workspace())
    await new Promise(resolve => setTimeout(resolve, 5))
    const eviction = manager.evictIdle!(1)
    await vi.waitFor(() => expect(host.request).toHaveBeenCalledWith("session/dashboard", {}, 2_500))
    for (const listener of host.listeners) listener({ jsonrpc: "2.0", method: "session/status", params: { sessionId: "s", status: "queued" } })
    release({ sessions: [] })
    expect(await eviction).toBe(0)
    await manager.close()
  })

  it("retains idle lanes with owned schedules or background cleanup", async () => {
    const host = fakeClient({ info: { capabilities: workCapabilities }, dashboard: { sessions: [{ id: 's', live: true, running: false, active: true }] } })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), 'sessions'), launch: () => host })
    await manager.get(workspace())
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(await manager.hasActiveWork()).toBe(true)
    expect(await manager.evictIdle!(1)).toBe(0)
    await manager.close()
  })

  it("bounds restarts even when every child initializes successfully", async () => {
    vi.useFakeTimers()
    const exits: Array<() => void> = []
    const launch = vi.fn(() => {
      const host = fakeClient()
      exits.push(host.exit)
      return host
    })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), 'sessions'), launch })
    try {
      await manager.get(workspace())
      for (let index = 0; index < 4; index++) {
        if (index > 0) await manager.get(workspace())
        exits[index]!()
        for (let flush = 0; flush < 10; flush++) await Promise.resolve()
        await expect(manager.get(workspace())).rejects.toThrow(/recovery/)
        await vi.advanceTimersByTimeAsync(2_000)
      }
      expect(launch).toHaveBeenCalledTimes(4)
      await expect(manager.get(workspace())).rejects.toThrow(/limit/)
      await manager.get(workspace('unrelated'))
      expect(launch).toHaveBeenCalledTimes(5)
      await manager.recover!(workspace())
      expect(launch).toHaveBeenCalledTimes(6)
    } finally { await manager.close(); vi.useRealTimers() }
  })

  it('bounds initialization failures across repeated automatic gets and permits explicit recovery', async () => {
    vi.useFakeTimers()
    const launch = vi.fn(() => {
      const host = fakeClient()
      host.client.initialize = vi.fn(async () => { throw Error('fixture startup failed') })
      return host
    })
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), 'sessions'), launch })
    try {
      await expect(manager.get(workspace())).rejects.toThrow('startup failed')
      for (let attempt = 1; attempt < 4; attempt++) {
        await expect(manager.get(workspace())).rejects.toThrow('recovery')
        await vi.advanceTimersByTimeAsync(2_000)
        await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(attempt + 1))
        await vi.waitFor(async () => { await expect(manager.get(workspace())).rejects.toThrow(/startup failed|recovery/) })
      }
      await expect(manager.get(workspace())).rejects.toThrow('limit')
      expect(launch).toHaveBeenCalledTimes(4)
      await expect(manager.recover!(workspace())).rejects.toThrow('startup failed')
      expect(launch).toHaveBeenCalledTimes(5)
    } finally { await manager.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers() }
  })

  it('explicit recovery waits for the original process exit before launching its replacement', async () => {
    const first = fakeClient(), second = fakeClient()
    first.close.mockResolvedValue(undefined)
    const launch = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch })
    try {
      const original = await manager.get(workspace())
      const recovery = manager.recover!(workspace())
      await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce())
      expect(launch).toHaveBeenCalledTimes(1)
      first.exit()
      const recovered = await recovery
      expect(recovered.client).not.toBe(original.client)
      expect(launch).toHaveBeenCalledTimes(2)
    } finally { first.exit(); await manager.close() }
  })

  it("joins Quit calls while an idle eviction still owns its original process", async () => {
    const host = fakeClient({ info: { capabilities: workCapabilities } })
    host.close.mockResolvedValue(undefined)
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch: () => host })
    let eviction: Promise<number> | undefined
    try {
      await manager.get(workspace())
      await new Promise(resolve => setTimeout(resolve, 5))
      eviction = manager.evictIdle!(1)
      await vi.waitFor(() => expect(host.close).toHaveBeenCalledOnce())
      expect(manager.peek!(workspace().id)).toBeUndefined()

      const closing = manager.close()
      expect(manager.close()).toBe(closing)
      const observed = await Promise.race([
        closing.then(() => "completed"),
        new Promise(resolve => setImmediate(() => resolve("waiting"))),
      ])
      expect(observed).toBe("waiting")
      await expect(manager.get(workspace())).rejects.toThrow("runtime manager is closed")
      host.exit()
      expect(await eviction).toBe(1)
      await closing
      expect(host.close).toHaveBeenCalledOnce()
    } finally {
      host.exit()
      await eviction
      await manager.close()
    }
  })

  it("retains an unconfirmed process after failed shutdown and completes Quit once it exits", async () => {
    const host = fakeClient()
    host.close.mockRejectedValue(new Error("original process termination failed"))
    const launch = vi.fn(() => host)
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch })
    try {
      await manager.get(workspace())
      await expect(manager.recover!(workspace())).rejects.toThrow("original process termination failed")
      await expect(manager.get(workspace())).rejects.toThrow("original process termination failed")
      expect(launch).toHaveBeenCalledTimes(1)
      await expect(manager.close()).rejects.toThrow("Gateway shutdown incomplete")
      host.exit()
      await manager.close()
      expect(host.close).toHaveBeenCalledOnce()
    } finally {
      host.exit()
      await manager.close()
    }
  })

  it("recovers a crashed process even when disconnected event delivery throws", async () => {
    vi.useFakeTimers()
    const first = fakeClient(), replacement = fakeClient()
    const launch = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(replacement)
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(tempRoot(), "sessions"), launch })
    manager.onEvent(event => {
      if (event.kind === "sdk/disconnected" && event.close?.reason === "subprocess-exited") throw new Error("window closed")
    })
    try {
      await manager.get(workspace())
      first.exit()
      await vi.advanceTimersByTimeAsync(600)
      expect((await manager.get(workspace())).client).toBe(replacement.client)
      expect(launch).toHaveBeenCalledTimes(2)
    } finally { await manager.close(); vi.useRealTimers() }
  })

  it("includes a structured fatal notification in the exit diagnostic", async () => {
    const host = fakeClient()
    const manager = createWorkspaceRuntimeManager({
      sessionsRoot: join(tempRoot(), "sessions"),
      launch: () => host,
    })
    const events: DesktopEvent[] = []
    manager.onEvent((event) => events.push(event))
    await manager.get(workspace("ws-fatal"))
    for (const listener of host.listeners) listener({ jsonrpc: "2.0", method: "desktop/gateway/fatal", params: { message: "boom", diagnostic: "boom-stack" } })
    host.exit()
    await new Promise((resolve) => setImmediate(resolve))
    const disconnected = events.find((event) => event.kind === "sdk/disconnected")
    expect(disconnected !== undefined && "message" in disconnected ? disconnected.message : "").toContain("boom-stack")
    await manager.close()
  })
})
