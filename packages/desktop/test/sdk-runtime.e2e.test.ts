import { afterEach, describe, expect, it } from "vitest"
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
    } finally {
      await manager.close()
      if (previousConfig === undefined) delete process.env.IH_CONFIG_DIR
      else process.env.IH_CONFIG_DIR = previousConfig
    }
  }, 30_000)
})
