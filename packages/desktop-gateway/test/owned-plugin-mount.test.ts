import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { listCommands, runCommand } from "@i-harness/interaction"
import { createOwnedPluginMount } from "../src/owned-plugin-mount.ts"

it("refreshes prompt commands on the original context and removes them on close", async () => {
  const ctx = createContext()
  const mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "startup", configDir: process.cwd(), workspace: process.cwd(), report: () => {} })
  const inputs = { skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [], commandDescriptors: [{ name: "greet", body: "hello $ARGUMENTS" }] }
  await mount.update(inputs)
  expect(await runCommand(ctx, "greet", "there")).toEqual({ kind: "prompt", text: "hello there" })
  await mount.update({ ...inputs, commandDescriptors: [{ name: "greet", body: "goodbye $ARGUMENTS" }] })
  expect(await runCommand(ctx, "greet", "there")).toEqual({ kind: "prompt", text: "goodbye there" })
  await mount.close()
  expect(listCommands(ctx)).toEqual([])
})

it("mounts and refreshes the original owned hook registry, and revokes authority on close", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "host-hooks-"))
  try {
    const path = join(root, "hooks.json")
    await writeFile(path, JSON.stringify({ version: 1, handlers: [] }))
    const ctx = createContext()
    const mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "resume", configDir: root, workspace: root, report: () => {} })
    const inputs = { skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [path], commandDescriptors: [] }
    await mount.update(inputs)
    expect(mount.hookAuthority([path])).toHaveLength(1)
    await mount.update(inputs)
    expect(mount.hookAuthority([path])).toHaveLength(1)
    await writeFile(path, JSON.stringify({ version: 1, handlers: [], changed: true }))
    expect(mount.hookAuthority([path])).toBeUndefined()
    await mount.close()
    expect(mount.hookAuthority([path])).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("executes trusted native startup and end handlers through the owned registry", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises")
  const { createHash } = await import("node:crypto")
  const { join } = await import("node:path")
  const { createHookTrustStore, resolveHookTrustPath } = await import("@i-harness/hooks")
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "host-lifecycle-"))
  try {
    const path = join(root, "native.json"), script = join(root, "hook.cjs"), log = join(root, "events.txt")
    const body = `require('fs').appendFileSync(${JSON.stringify(log)}, 'called\\n')`
    await writeFile(script, body)
    const sha256 = createHash("sha256").update(body).digest("hex")
    await writeFile(path, JSON.stringify({ version: 1, handlers: ["session/start", "session/end"].map(event => ({ id: event, event, type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256 } })) }))
    createHookTrustStore(resolveHookTrustPath(root)).approve({ sha256, script, handlerId: "fixture" })
    const mount = createOwnedPluginMount({ ctx: createContext(), sessionId: "s", startSource: "resume", configDir: root, workspace: root, report: () => {} })
    await mount.update({ skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [path], commandDescriptors: [] })
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1)
    await mount.close()
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("rejects an installed physical plugin hook configuration before mounting commands", async () => {
  const { join } = await import("node:path")
  const ctx = createContext(), root = process.cwd()
  const mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "startup", configDir: root, workspace: root, report: () => {} })
  await expect(mount.update({ skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [join(root, "plugins", "x", "hooks", "hooks.json")], commandDescriptors: [{ name: "greet", body: "hello" }] })).rejects.toThrow(/complete compatibility/)
  expect(listCommands(ctx)).toEqual([])
  await mount.close()
})

it("expands the current prompt catalog once and refuses action commands", async () => {
  const { registerCommand } = await import("@i-harness/interaction")
  const ctx = createContext(), mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "startup", configDir: process.cwd(), workspace: process.cwd(), report: () => {} })
  await mount.update({ skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [], commandDescriptors: [{ name: "greet", body: "hello $ARGUMENTS" }] })
  expect(await mount.expand("/greet there")).toBe("hello there")
  expect(await mount.expand("ordinary")).toBe("ordinary")
  registerCommand(ctx, { name: "action", async execute() { return "reply" } })
  await expect(mount.expand("/action")).rejects.toThrow(/Only prompt commands/)
  await mount.close()
})

it("updates the original plugin capability owner and retires its role and skill roots", async () => {
  const { createRoleRegistry } = await import("@i-harness/subagent")
  const { createToolRegistry } = await import("@i-harness/core-tools")
  const { createOwnedPluginCatalog } = await import("../../session-executor/src/owned-plugin-catalog.ts")
  const roles = createRoleRegistry(), ctx = createContext()
  const catalog = createOwnedPluginCatalog({ ctx, tools: createToolRegistry(ctx), roles, workspace: process.cwd(), globalSkillDir: process.cwd(), report: () => {} })
  const mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "startup", configDir: process.cwd(), workspace: process.cwd(), report: () => {}, catalog })
  await mount.update({ skillDirs: ["plugin-root"], mcpServerConfigs: {}, agentDescriptors: [{ name: "helper", description: "help", systemPrompt: "help", tools: ["Read"] }], hookConfigs: [], commandDescriptors: [] })
  expect(catalog.roleResults.get("helper")).toBe(true)
  expect(roles.get("helper")?.tools).toEqual(["read"])
  await mount.update({ skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [], commandDescriptors: [] })
  expect(roles.get("helper")).toBeUndefined()
  await mount.close()
})

it("retains failed original capability cleanup for a later close retry", async () => {
  const { createRoleRegistry } = await import("@i-harness/subagent")
  const { createToolRegistry } = await import("@i-harness/core-tools")
  const { createOwnedPluginCatalog } = await import("../../session-executor/src/owned-plugin-catalog.ts")
  const original = createRoleRegistry(); let fail = true
  const roles = { ...original, register(role: Parameters<typeof original.register>[0], retain?: Parameters<typeof original.register>[1]) {
    original.register(role, cleanup => retain?.(async () => { if (fail) throw new Error("held cleanup"); await cleanup() }))
  } }
  const ctx = createContext()
  const catalog = createOwnedPluginCatalog({ ctx, tools: createToolRegistry(ctx), roles, workspace: process.cwd(), globalSkillDir: process.cwd(), report: () => {} })
  const mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "startup", configDir: process.cwd(), workspace: process.cwd(), report: () => {}, catalog })
  await mount.update({ skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [{ name: "helper", description: "help", systemPrompt: "help" }], hookConfigs: [], commandDescriptors: [] })
  await expect(mount.close()).rejects.toThrow(/held cleanup/)
  expect(original.get("helper")).toBeDefined()
  fail = false
  await mount.close()
  expect(original.get("helper")).toBeUndefined()
})

it("reports an initial failed MCP mount and rejects a later strict refresh", async () => {
  const { createToolRegistry } = await import("@i-harness/core-tools")
  const { createRoleRegistry } = await import("@i-harness/subagent")
  const { createOwnedPluginCatalog } = await import("../../session-executor/src/owned-plugin-catalog.ts")
  const ctx = createContext(), reports: string[][] = []
  const catalog = createOwnedPluginCatalog({ ctx, tools: createToolRegistry(ctx), roles: createRoleRegistry(), workspace: process.cwd(), globalSkillDir: process.cwd(), report: () => {}, mcpDeps: { connect: async () => { throw new Error("fixture unavailable") } } })
  const mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "startup", configDir: process.cwd(), workspace: process.cwd(), report: rows => reports.push(rows), catalog })
  const inputs = { skillDirs: [], mcpServerConfigs: { bad: { command: "fixture", args: [] } }, agentDescriptors: [], hookConfigs: [], commandDescriptors: [] }
  await mount.update(inputs)
  expect(catalog.mcpResults.get("bad")).toBe(false)
  expect(reports.flat().some(row => row.includes("failed to mount"))).toBe(true)
  await expect(mount.update(inputs)).rejects.toThrow(/Plugin capability update failed/)
  await mount.close()
})

it("does not run an old native end hook when its grant was revoked before refresh", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises")
  const { createHash } = await import("node:crypto")
  const { join } = await import("node:path")
  const { createHookTrustStore, resolveHookTrustPath } = await import("@i-harness/hooks")
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "host-revoke-"))
  try {
    const path = join(root, "native.json"), script = join(root, "hook.cjs"), log = join(root, "events.txt")
    const body = `require('fs').appendFileSync(${JSON.stringify(log)}, 'called\\n')`
    await writeFile(script, body)
    const sha256 = createHash("sha256").update(body).digest("hex")
    const config = JSON.stringify({ version: 1, handlers: ["session/start", "session/end"].map(event => ({ id: event, event, type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256 } })) })
    await writeFile(path, config)
    const trust = createHookTrustStore(resolveHookTrustPath(root)); trust.approve({ sha256, script, handlerId: "fixture" })
    const mount = createOwnedPluginMount({ ctx: createContext(), sessionId: "s", startSource: "startup", configDir: root, workspace: root, report: () => {} })
    const inputs = { skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [path], commandDescriptors: [] }
    await mount.update(inputs)
    trust.revoke(sha256)
    await writeFile(path, config + "\n")
    await mount.update(inputs)
    await mount.close()
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("retains an in-flight native startup registry until close can end and dispose it", async () => {
  const { mkdtemp, writeFile, readFile, access, rm } = await import("node:fs/promises")
  const { createHash } = await import("node:crypto")
  const { join } = await import("node:path")
  const { createHookTrustStore, resolveHookTrustPath } = await import("@i-harness/hooks")
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "host-held-"))
  try {
    const path = join(root, "native.json"), script = join(root, "hook.cjs"), log = join(root, "events.txt"), release = join(root, "release")
    const body = `const f=require('fs');f.appendFileSync(${JSON.stringify(log)},'called\\n');const t=setInterval(()=>{if(f.existsSync(${JSON.stringify(release)})){clearInterval(t)}},10)`
    await writeFile(script, body)
    const sha256 = createHash("sha256").update(body).digest("hex")
    await writeFile(path, JSON.stringify({ version: 1, handlers: ["session/start", "session/end"].map(event => ({ id: event, event, type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256 } })) }))
    createHookTrustStore(resolveHookTrustPath(root)).approve({ sha256, script, handlerId: "fixture" })
    const mount = createOwnedPluginMount({ ctx: createContext(), sessionId: "s", startSource: "startup", configDir: root, workspace: root, report: () => {} })
    const updating = mount.update({ skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [path], commandDescriptors: [] })
    for (let i = 0; i < 200; i++) { try { await access(log); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) } }
    await access(log)
    const closing = mount.close(); let finished = false; void closing.then(() => { finished = true })
    await new Promise(resolve => setImmediate(resolve)); expect(finished).toBe(false)
    await writeFile(release, "go")
    await updating; await closing
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(2)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 15000)
