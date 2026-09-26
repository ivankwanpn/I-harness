import { describe, expect, it, vi } from "vitest"
import type { HarnessClient } from "@i-harness/sdk"
import { dispatchDesktopRequest } from "../src/main/ipc.ts"
import type { WorkspaceEntry } from "../src/main/workspaces.ts"

function fixture() {
  const request = vi.fn(async (method: string) => {
    if (method === "desktop/review/changes") {
      return { kind: "ok", files: [{ path: "a.txt", status: "modified", canDiff: true, canPreview: true }], truncated: false }
    }
    if (method === "desktop/review/diff") return { kind: "text", text: "+a", truncated: false, bytes: 2 }
    if (method === "desktop/review/file") return { kind: "text", text: "hello", truncated: false, bytes: 5 }
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
  return { dependencies: { catalog, runtimes } as never, request }
}

describe("Desktop review IPC rows", () => {
  it("lists changes, then serves one diff or preview for an exact relative path", async () => {
    const f = fixture()

    await expect(dispatchDesktopRequest({ kind: "desktop/review/changes", workspaceId: "ws-1" }, f.dependencies))
      .resolves.toMatchObject({ kind: "ok" })
    expect(f.request).toHaveBeenCalledWith("desktop/review/changes", {})

    await expect(dispatchDesktopRequest({
      kind: "desktop/review/diff", workspaceId: "ws-1", path: "src/a.ts",
    }, f.dependencies)).resolves.toMatchObject({ kind: "text" })
    expect(f.request).toHaveBeenCalledWith("desktop/review/diff", { path: "src/a.ts" })

    await expect(dispatchDesktopRequest({
      kind: "desktop/review/file", workspaceId: "ws-1", path: "a.txt", maxBytes: 2048,
    }, f.dependencies)).resolves.toMatchObject({ kind: "text" })
    expect(f.request).toHaveBeenCalledWith("desktop/review/file", { path: "a.txt", maxBytes: 2048 })
  })

  it("rejects an empty path, a bad byte cap, and an unknown workspace before any call", async () => {
    const f = fixture()

    await expect(dispatchDesktopRequest({
      kind: "desktop/review/diff", workspaceId: "ws-1", path: "",
    }, f.dependencies)).rejects.toThrow(/path/i)
    await expect(dispatchDesktopRequest({
      kind: "desktop/review/diff", workspaceId: "ws-1", path: "a.txt", maxBytes: 0,
    }, f.dependencies)).rejects.toThrow(/maxBytes/i)
    await expect(dispatchDesktopRequest({
      kind: "desktop/review/file", workspaceId: "missing", path: "a.txt",
    }, f.dependencies)).rejects.toThrow(/unknown workspace/i)
    expect(f.request).not.toHaveBeenCalled()
  })
})
