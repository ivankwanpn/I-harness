import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessClient, RpcNotification, ServerInfo } from "@i-harness/sdk"
import { createWorkspaceRuntimeManager } from "../src/main/sdk-runtime.ts"
import type { DesktopEvent } from "../src/shared/bridge.ts"
import type { WorkspaceEntry } from "../src/main/workspaces.ts"

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
}

function fakeClient(options: FakeClientOptions = {}) {
  const listeners = new Set<(notification: RpcNotification) => void>()
  const close = vi.fn(async () => {})
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "desktop/sandbox/state") return options.sandbox
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

  it("forwards only session/event and session/status notifications", async () => {
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

    expect(events).toEqual([
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "session/event", params: { seq: 0 } },
      { kind: "sdk/notification", workspaceId: "ws-notes", method: "session/status", params: { seq: 0 } },
    ])
    await manager.close()
  })
})
