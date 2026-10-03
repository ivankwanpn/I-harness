import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessClient, ServerInfo } from "@i-harness/sdk"
import { dispatchDesktopRequest } from "../src/main/ipc.ts"
import { createWorkspaceRuntimeManager } from "../src/main/sdk-runtime.ts"
import type { DesktopEvent } from "../src/shared/bridge.ts"
import type { WorkspaceEntry } from "../src/main/workspaces.ts"

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ih-desktop-interaction-"))
  roots.push(root)
  return root
}

function fixture() {
  const pendingReply = { accepted: true as const }
  const request = vi.fn(async (method: string) => {
    if (method === "desktop/interaction/pending") return [{ requestId: "r1", sessionId: "s1", kind: "approval", payload: {}, openedAt: 1 }]
    if (method === "desktop/interaction/reply/trusted-human") return pendingReply
    throw new Error(`unexpected request ${method}`)
  })
  const client = { request } as unknown as HarnessClient
  const entry: WorkspaceEntry = { id: "ws-1", path: "C:/workspace", label: "workspace" }
  const catalog = {
    list: vi.fn(async () => [entry]),
    open: vi.fn(async () => entry),
    get: vi.fn((id: string) => id === entry.id ? entry : undefined),
  }
  const runtimes = {
    get: vi.fn(async () => ({
      client,
      info: { name: "test", version: "0.1.0", protocolVersion: 3, capabilities: {} },
      sandbox: { mode: "read-only", source: "settings", wired: true } as const,
    })),
    onEvent: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
  }
  return {
    dependencies: { catalog, runtimes } as never,
    request,
  }
}

describe("Desktop interaction IPC rows", () => {
  it("lists pending interactions for a known workspace", async () => {
    const f = fixture()
    await expect(dispatchDesktopRequest({
      kind: "desktop/interaction/pending", workspaceId: "ws-1", sessionId: "s1",
    }, f.dependencies)).resolves.toEqual([{ requestId: "r1", sessionId: "s1", kind: "approval", payload: {}, openedAt: 1 }])
    expect(f.request).toHaveBeenCalledWith("desktop/interaction/pending", { sessionId: "s1" })
  })

  it("replies with an exact decision and rejects malformed ones", async () => {
    const f = fixture()
    await expect(dispatchDesktopRequest({
      kind: "desktop/interaction/reply",
      workspaceId: "ws-1",
      requestId: "r1",
      sessionId: "s1",
      decision: { kind: "approval", approved: false },
    }, f.dependencies)).resolves.toEqual({ accepted: true })
    expect(f.request).toHaveBeenCalledWith("desktop/interaction/reply/trusted-human", {
      requestId: "r1",
      sessionId: "s1",
      decision: { kind: "approval", approved: false },
    })

    await expect(dispatchDesktopRequest({
      kind: "desktop/interaction/reply",
      workspaceId: "ws-1",
      requestId: "",
      sessionId: "s1",
      decision: { kind: "approval", approved: true },
    }, f.dependencies)).rejects.toThrow(/requestId/i)

    await expect(dispatchDesktopRequest({
      kind: "desktop/interaction/reply",
      workspaceId: "ws-1",
      requestId: "r1",
      sessionId: "s1",
      decision: { kind: "shrug" },
    }, f.dependencies)).rejects.toThrow(/decision/i)

    await expect(dispatchDesktopRequest({
      kind: "desktop/interaction/reply",
      workspaceId: "ws-1",
      requestId: "r1",
      sessionId: "s1",
      decision: { kind: "question", answer: 42 },
    }, f.dependencies)).rejects.toThrow(/answer/i)
  })
})

describe("Desktop runtime forwards interaction notifications", () => {
  it("emits desktop/interaction/request and /closed with the workspace id", async () => {
    const root = tempRoot()
    const listeners = new Set<(notification: { method: string; params?: unknown }) => void>()
    const client = {
      initialize: vi.fn(async (): Promise<ServerInfo> => ({
        name: "test", version: "0.1.0", protocolVersion: 3, capabilities: {},
      })),
      request: vi.fn(async () => undefined),
      onNotification: (listener: (notification: { method: string; params?: unknown }) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      close: vi.fn(async () => {}),
    } as unknown as HarnessClient
    const manager = createWorkspaceRuntimeManager({
      sessionsRoot: join(root, "sessions"),
      launch: () => ({ client, exited: new Promise(() => {}) }),
    })
    const events: DesktopEvent[] = []
    manager.onEvent((event) => events.push(event))
    await manager.get({ id: "ws-1", path: root, label: "root" })

    for (const listener of [...listeners]) {
      listener({ method: "desktop/interaction/request", params: { requestId: "r1" } })
      listener({ method: "desktop/interaction/closed", params: { requestId: "r1", reason: "reply" } })
      listener({ method: "desktop/unknown", params: {} })
    }

    expect(events).toEqual([
      { kind: "sdk/notification", workspaceId: "ws-1", method: "desktop/interaction/request", params: { requestId: "r1" } },
      { kind: "sdk/notification", workspaceId: "ws-1", method: "desktop/interaction/closed", params: { requestId: "r1", reason: "reply" } },
    ])
    await manager.close()
    for (const root2 of roots.splice(0)) rmSync(root2, { recursive: true, force: true })
  })
})
