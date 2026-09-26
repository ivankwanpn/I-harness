import { expect, it, vi } from "vitest"
import { createRoleRegistry } from "@i-harness/subagent"
import { createPluginCapabilities } from "../src/plugin-capabilities.ts"
it("reports a failed live MCP mount after applying independent roles", async () => {
  const roles = createRoleRegistry()
  const managed = createPluginCapabilities({ skillDirs: [], handles: [], roles, mcpResults: new Map(), roleResults: new Map(), mount: async () => { throw new Error("unavailable") }, warn() {} })
  await expect(managed.update({ pluginMcp: [{ transport: "stdio", serverName: "bad", command: "fixture", args: [] }], pluginAgents: [{ name: "still-valid", description: "valid", systemPrompt: "valid", tools: [] }] })).rejects.toThrow("Plugin capability update failed")
  expect(roles.get("still-valid")).toBeDefined()
  await managed.dispose()
})
it("changes only plugin-owned capabilities and leaves an unchanged MCP connection alive", async () => {
  const unmount = vi.fn(async () => {})
  const mount = vi.fn(async () => ({ serverName: "test", catalogDirty: () => false, refreshCatalog: async () => {}, unmount }))
  const roles = createRoleRegistry()
  roles.register({ name: "user", description: "owned", systemPrompt: "user", tools: [] })
  const dirs: string[] = []
  const managed = createPluginCapabilities({ skillDirs: dirs, handles: [], roles, mcpResults: new Map(), roleResults: new Map(), mount, warn() {} })
  const config = { transport: "stdio" as const, serverName: "test", command: "fixture", args: [] }
  const next = { skills: { extraDirs: ["plugin-skills"] }, pluginMcp: [config], pluginAgents: [{ name: "plugin", description: "p", systemPrompt: "p", tools: [] }] }
  await managed.update(next); await managed.update(next)
  expect(mount).toHaveBeenCalledTimes(1)
  expect(unmount).not.toHaveBeenCalled()
  expect(dirs).toEqual(["plugin-skills"])
  await managed.update({})
  expect(unmount).toHaveBeenCalledTimes(1)
  expect(dirs).toEqual([])
  expect(roles.get("plugin")).toBeUndefined()
  expect(roles.get("user")).toBeDefined()
  await managed.dispose()
})
