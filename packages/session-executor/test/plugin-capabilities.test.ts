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

it('retains the original role installed before a fallible registration callback', async () => {
  const roles = createRoleRegistry(), original = new Error('Original registration callback failed')
  let fail = true
  roles.onChanged(() => { if (fail) { fail = false; throw original } })
  const managed = createPluginCapabilities({ skillDirs: [], handles: [], roles, mcpResults: new Map(), roleResults: new Map(), mount: async () => { throw new Error('No MCP') }, warn() {} })
  await expect(managed.update({ pluginAgents: [{ name: 'partial', description: 'p', systemPrompt: 'p', tools: [] }] })).rejects.toBe(original)
  expect(roles.get('partial')).toBeDefined()
  await managed.dispose()
  expect(roles.get('partial')).toBeUndefined()
})

it('role-only retirement joins admitted updates, closes new updates and keeps original MCP until full disposal', async () => {
  const roles = createRoleRegistry(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), unmount = vi.fn(async () => {})
  const managed = createPluginCapabilities({ skillDirs: [], handles: [], roles, mcpResults: new Map(), roleResults: new Map(),
    async mount() { entered.resolve(); await gate.promise; return { serverName: 'held', catalogDirty: () => false, refreshCatalog: async () => {}, unmount } }, warn() {} })
  const update = managed.update({ pluginMcp: [{ transport: 'stdio', serverName: 'held', command: 'fixture', args: [] }], pluginAgents: [{ name: 'original', description: 'p', systemPrompt: 'captured', tools: [] }] })
  await entered.promise
  let retired = false
  const retiring = managed.retireRoles().then(() => { retired = true })
  await expect(managed.update({})).rejects.toThrow('disposed')
  expect(retired).toBe(false); expect(roles.get('original')).toBeUndefined(); expect(unmount).not.toHaveBeenCalled()
  gate.resolve(); await update; await retiring
  expect(roles.get('original')).toBeUndefined(); expect(unmount).not.toHaveBeenCalled()
  await managed.dispose(); await managed.dispose(); expect(unmount).toHaveBeenCalledTimes(1)
})

it('retirement leaves a foreign replacement untouched and keeps captured original role state', async () => {
  const roles = createRoleRegistry(), managed = createPluginCapabilities({ skillDirs: [], handles: [], roles, mcpResults: new Map(), roleResults: new Map(), mount: async () => { throw new Error('No MCP') }, warn() {} })
  await managed.update({ pluginAgents: [{ name: 'shared-name', description: 'p', systemPrompt: 'original captured role', tools: [] }] })
  const captured = roles.get('shared-name')!, replacement = { ...captured, systemPrompt: 'user replacement' }
  roles.remove('shared-name'); roles.register(replacement)
  await managed.retireRoles(); await managed.dispose()
  expect(roles.get('shared-name')).toBe(replacement); expect(captured.systemPrompt).toBe('original captured role')
})

it.each([undefined, false])('full MCP disposal remains independent of original role cleanup failure (%j)', async cause => {
  const original = createRoleRegistry(), unmount = vi.fn(async () => {})
  let refuse = true, removals = 0
  const roles = { ...original, register(role: import('@i-harness/subagent').SubagentRole, retain?: (cleanup: import('@i-harness/subagent').RoleCleanup) => void) {
    original.register(role, retain ? cleanup => retain(() => { removals++; if (refuse) throw cause; return cleanup() }) : undefined)
  } }
  const managed = createPluginCapabilities({ skillDirs: [], handles: [], roles, mcpResults: new Map(), roleResults: new Map(),
    mount: async () => ({ serverName: 'original', catalogDirty: () => false, refreshCatalog: async () => {}, unmount }), warn() {} })
  await managed.update({ pluginMcp: [{ transport: 'stdio', serverName: 'original', command: 'fixture', args: [] }], pluginAgents: [{ name: 'original', description: 'p', systemPrompt: 'p', tools: [] }] })
  await expect(managed.retireRoles()).rejects.toBe(cause); expect(unmount).not.toHaveBeenCalled()
  await expect(managed.dispose()).rejects.toBe(cause); expect(unmount).toHaveBeenCalledTimes(1)
  expect(original.get('original')).toBeDefined(); refuse = false
  await managed.dispose(); expect(original.get('original')).toBeUndefined(); expect(unmount).toHaveBeenCalledTimes(1); expect(removals).toBe(3)
})

it('an after-effect role listener failure retains original retry state without repeating removal', async () => {
  const roles = createRoleRegistry(), managed = createPluginCapabilities({ skillDirs: [], handles: [], roles, mcpResults: new Map(), roleResults: new Map(), mount: async () => { throw new Error('No MCP') }, warn() {} })
  await managed.update({ pluginAgents: [{ name: 'original', description: 'p', systemPrompt: 'p', tools: [] }] })
  let removals = 0, concurrent: Promise<void> | undefined
  roles.onChanged(() => { removals++; concurrent = managed.retireRoles(); throw undefined })
  await expect(managed.retireRoles()).rejects.toBeUndefined()
  await expect(concurrent).rejects.toBeUndefined()
  expect(roles.get('original')).toBeUndefined()
  await managed.dispose(); expect(removals).toBe(1)
})

it('original registration cleanup cannot remove a foreign re-registration of the same role object', async () => {
  const roles = createRoleRegistry(), managed = createPluginCapabilities({ skillDirs: [], handles: [], roles, mcpResults: new Map(), roleResults: new Map(), mount: async () => { throw new Error('No MCP') }, warn() {} })
  await managed.update({ pluginAgents: [{ name: 'same-object', description: 'p', systemPrompt: 'p', tools: [] }] })
  const original = roles.get('same-object')!
  roles.remove('same-object'); roles.register(original)
  await managed.dispose()
  expect(roles.get('same-object')).toBe(original)
})
