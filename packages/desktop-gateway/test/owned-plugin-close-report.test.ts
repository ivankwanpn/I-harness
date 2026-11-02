import { expect, it, vi } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createRoleRegistry } from "@i-harness/subagent"
import { createOwnedPluginCatalog } from "../../session-executor/src/owned-plugin-catalog.ts"
const state = vi.hoisted(() => ({ registries: [] as import("@i-harness/hooks").HookRegistry[], disposals: 0 }))
vi.mock("@i-harness/hooks", async load => {
  const original = await load<typeof import("@i-harness/hooks")>()
  return { ...original, async createExecutionHookRegistry(...args: Parameters<typeof original.createExecutionHookRegistry>) {
    const registry = await original.createExecutionHookRegistry(...args), dispose = registry.dispose.bind(registry)
    registry.dispose = async () => { state.disposals++; await dispose() }
    state.registries.push(registry); return registry
  } }
})
import { createOwnedPluginMount } from "../src/owned-plugin-mount.ts"

it("disposes the original registry even when reporting its end failure throws false", async () => {
  state.registries = []; state.disposals = 0
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "plugin-end-report-"))
  try {
    const script = join(root, "hook.cjs"), path = join(root, "native.json"), second = join(root, "second.json"), body = "// never approved\n"
    await writeFile(script, body)
    await writeFile(path, JSON.stringify({ version: 1, handlers: [{ id: "end", event: "session/end", type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256: createHash("sha256").update(body).digest("hex") } }] }))
    await writeFile(second, JSON.stringify({ version: 1, handlers: [] }))
    let failReport = false
    const ctx = createContext(), tools = createToolRegistry(ctx), unmount = ctx.unmount.bind(ctx); let unmounts = 0
    ctx.unmount = async name => { if (++unmounts === 1) throw false; await unmount(name) }
    const catalog = createOwnedPluginCatalog({ ctx, tools, roles: createRoleRegistry(), workspace: root, globalSkillDir: root, report: () => {} })
    const mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "startup", configDir: root, workspace: root, report: () => { if (failReport) throw false }, catalog })
    await mount.update({ skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [path, second], commandDescriptors: [{ name: "greet", body: "hello" }] })
    expect(state.registries).toHaveLength(2)
    expect(state.registries[0]?.handlers()).toHaveLength(1)
    const commandRegistry = ctx.services.get<Map<string, unknown>>("commands/registry"), originalDelete = commandRegistry.delete.bind(commandRegistry); let deletes = 0
    commandRegistry.delete = name => { if (++deletes === 1) throw false; return originalDelete(name) }
    failReport = true
    let failure: unknown; try { await mount.close() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([false, false, false, false])
    expect(state.registries[0]?.handlers()).toHaveLength(1)
    expect(state.disposals).toBe(2)
    expect(tools.get("skill_get")).toBeUndefined()
    failReport = false
    await mount.close()
    expect(commandRegistry.has("greet")).toBe(false)
    expect(state.registries.every(registry => registry.handlers().length === 0)).toBe(true)
    expect(state.disposals).toBe(3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("continues withdrawing independent commands when one original disposer fails", async () => {
  const ctx = createContext(), mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "startup", configDir: process.cwd(), workspace: process.cwd(), report: () => {} })
  const base = { skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [] }
  await mount.update({ ...base, commandDescriptors: [{ name: "first", body: "one" }, { name: "second", body: "two" }] })
  const registry = ctx.services.get<Map<string, unknown>>("commands/registry"), originalDelete = registry.delete.bind(registry); let calls = 0
  registry.delete = name => { if (++calls === 1) throw false; return originalDelete(name) }
  await expect(mount.update({ ...base, commandDescriptors: [] })).rejects.toBe(false)
  expect(registry.has("first")).toBe(true)
  expect(registry.has("second")).toBe(false)
  await mount.update({ ...base, commandDescriptors: [] })
  expect(registry.size).toBe(0)
  await mount.close()
})
