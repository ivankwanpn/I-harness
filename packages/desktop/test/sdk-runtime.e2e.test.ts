import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkspaceRuntimeManager } from "../src/main/sdk-runtime.ts"
import type { WorkspaceEntry } from "../src/main/workspaces.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("Desktop SDK runtime against the real local gateway", () => {
  it("routes overlapping session and RPC IDs through one process and recovers its workspaces after exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "ih-desktop-shared-e2e-"))
    roots.push(root)
    const workspaces = ["one", "two"].map(id => ({ id, label: id, path: join(root, id) }))
    for (const ws of workspaces) {
      mkdirSync(ws.path)
      writeFileSync(join(ws.path, "marker.txt"), ws.id)
    }
    const config = join(root, "config")
    mkdirSync(config)
    writeFileSync(join(config, "settings.json"), JSON.stringify({ sandboxMode: "read-only", autoTitle: false }))
    const previous = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = config
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(root, "sessions") })
    try {
      const [a, b] = await Promise.all(workspaces.map(ws => manager.get(ws)))
      if (!a?.hostPid || !b) throw Error("Missing shared host")
      expect(a.hostPid).toBe(b.hostPid)
      const created = await Promise.all([a, b].map(ws => ws.client.request("session/create", { clientToken: "shared-token-123" }) as Promise<{ sessionId: string }>))
      const id = created[0]!.sessionId
      expect(created[1]!.sessionId).toBe(id)
      await Promise.all([a, b].map((ws, index) => ws.client.request("desktop/session/manage", { action: "rename", sessionId: id, title: workspaces[index]!.label })))
      for (const [index, ws] of [a, b].entries()) {
        expect((await ws.client.listSessions()).sessions).toMatchObject([{ id, title: workspaces[index]!.label }])
        expect(await ws.client.request("desktop/review/file", { path: "marker.txt" })).toMatchObject({ text: workspaces[index]!.id })
      }
      await manager.invalidate!(workspaces[0]!.id)
      expect(await b.client.request("ping")).toEqual({ ok: true })
      expect((await manager.get(workspaces[0]!)).hostPid).toBe(b.hostPid)
      // Kill only the process allocated by this isolated test manager.
      process.kill(a.hostPid, "SIGKILL")
      await vi.waitFor(() => {
        for (const ws of workspaces) {
          const next = manager.peek!(ws.id)
          expect(next?.hostPid).toBeTruthy()
          expect(next!.hostPid).not.toBe(a.hostPid)
        }
      }, { timeout: 45_000, interval: 100 })
      const reopened = await Promise.all(workspaces.map(ws => manager.get(ws)))
      expect(reopened[0]!.hostPid).toBe(reopened[1]!.hostPid)
      for (const [index, ws] of reopened.entries()) {
        expect((await ws.client.listSessions()).sessions).toMatchObject([{ id, title: workspaces[index]!.label }])
      }
    } finally {
      await manager.close()
      if (previous === undefined) delete process.env.IH_CONFIG_DIR
      else process.env.IH_CONFIG_DIR = previous
    }
  }, 90_000)

  it("initializes the approved host, reports the wired sandbox and closes the child", async () => {
    const root = mkdtempSync(join(tmpdir(), "ih-desktop-runtime-e2e-"))
    roots.push(root)
    const workspaceDir = join(root, "workspace")
    const configDir = join(root, "config")
    mkdirSync(workspaceDir)
    mkdirSync(configDir)
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ sandboxMode: "read-only" }), "utf8")

    const previousConfig = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = configDir
    const manager = createWorkspaceRuntimeManager({ sessionsRoot: join(root, "sessions") })
    const workspace: WorkspaceEntry = { id: "ws-e2e", path: workspaceDir, label: "workspace" }
    try {
      const runtime = await manager.get(workspace)

      expect(runtime.info.protocolVersion).toBe(3)
      expect(runtime.info.capabilities["session-list"]).toEqual(["1"])
      expect(runtime.sandbox).toEqual({ mode: "read-only", source: "settings", wired: true })
      expect(await runtime.client.listSessions()).toEqual({ sessions: [] })
      const created = await runtime.client.request("session/create", {}) as { sessionId: string }
      const head = await runtime.client.history(created.sessionId, { afterSeq: Number.MAX_SAFE_INTEGER, limit: 1 })
      expect(head.events).toEqual([])
      expect(head.nextSeq).toBe(0)
    } finally {
      await manager.close()
      if (previousConfig === undefined) delete process.env.IH_CONFIG_DIR
      else process.env.IH_CONFIG_DIR = previousConfig
    }
  }, 30_000)
})
