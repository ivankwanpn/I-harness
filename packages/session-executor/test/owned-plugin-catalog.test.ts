import { expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createRoleRegistry } from "@i-harness/subagent"
import { createOwnedPluginCatalog } from "../src/owned-plugin-catalog.ts"

it("registers original skill tools and renders the live plugin skill section on the same registry", async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "catalog-"))
  try {
    const skillRoot = join(root, "plugins"), skill = join(skillRoot, "helper")
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, "SKILL.md"), "---\nname: helper\ndescription: useful helper\n---\nUse this helper.\n")
    const ctx = createContext(), tools = createToolRegistry(ctx), roles = createRoleRegistry()
    const catalog = createOwnedPluginCatalog({ ctx, tools, roles, workspace: root, globalSkillDir: join(root, "global"), report: () => {} })
    await catalog.capabilities.update({ skills: { extraDirs: [skillRoot] } })
    expect(tools.get("skill_get")).toBeDefined()
    expect(catalog.skillsSection()).toContain("helper")
    expect(catalog.skillsRegistry.list().map(row => row.name)).toContain("helper")
    await catalog.close()
    expect(tools.get("skill_get")).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("refreshes a real MCP generation at the owned pre-step boundary and unmounts its tools", async () => {
  const { captureExecutionHookChannel } = await import("@i-harness/core-plugin")
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "catalog-mcp-"))
  try {
    const script = join(root, "server.cjs")
    await writeFile(script, `const rl=require('readline').createInterface({input:process.stdin});let count=0;const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');rl.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result;if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:'1'}};else if(q.method==='tools/list'){count++;result={tools:[{name:count===1?'before':'after',description:'fixture',inputSchema:{type:'object'}}]};if(count===1)setTimeout(()=>send({jsonrpc:'2.0',method:'notifications/tools/list_changed'}),100)}else if(q.method==='ping')result={};else{send({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'unknown'}});return}send({jsonrpc:'2.0',id:q.id,result})})`)
    const ctx = createContext(), tools = createToolRegistry(ctx)
    const catalog = createOwnedPluginCatalog({ ctx, tools, roles: createRoleRegistry(), workspace: root, globalSkillDir: root, report: () => {} })
    try {
      await catalog.capabilities.update({ pluginMcp: [{ transport: "stdio", serverName: "fixture", command: process.execPath, args: [script] }] })
      expect(tools.get("mcp__fixture__before")).toBeDefined()
      await new Promise(resolve => setTimeout(resolve, 250))
      await captureExecutionHookChannel(ctx).emit("agent/pre-step", {})
      expect(tools.get("mcp__fixture__before")).toBeUndefined()
      expect(tools.get("mcp__fixture__after")).toBeDefined()
    } finally { await catalog.close() }
    expect(tools.get("mcp__fixture__after")).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
}, 15000)

it("mounts and closes the original LSP owner on the same tool registry", async () => {
  const { createFakeLspServer } = await import("../../lsp/test/fake-server.ts")
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "catalog-lsp-"))
  try {
    const ctx = createContext(), tools = createToolRegistry(ctx), server = createFakeLspServer({ initialize: { capabilities: { hoverProvider: true } }, shutdown: null })
    const catalog = createOwnedPluginCatalog({ ctx, tools, roles: createRoleRegistry(), workspace: root, globalSkillDir: root, report: () => {} })
    await catalog.mountLsp({ serverName: "owned", command: "fixture", args: [], languages: [".ts"], shutdownTimeoutMs: 200, killGraceMs: 200 }, { spawner: server.spawner })
    expect(tools.get("lsp")).toBeDefined()
    await catalog.close()
    expect(tools.get("lsp")).toBeUndefined()
    expect(server.server.methods.indexOf("shutdown")).toBeLessThan(server.server.methods.indexOf("exit"))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("joins a held MCP refresh before closing the original generation", async () => {
  const { captureExecutionHookChannel } = await import("@i-harness/core-plugin")
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let changed: (() => void) | undefined, calls = 0, transportClosed = false
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const catalog = createOwnedPluginCatalog({ ctx, tools, roles: createRoleRegistry(), workspace: process.cwd(), globalSkillDir: process.cwd(), report: () => {}, mcpDeps: { async connect(_config, opts) {
    changed = opts?.onToolsChanged
    return { async listTools() { if (++calls > 1) { entered.resolve(); await release.promise } return { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }, async callTool() { return { content: [] } }, async listResources() { return [] }, async readResource() { return {} }, async close() { transportClosed = true } }
  } } })
  await catalog.capabilities.update({ pluginMcp: [{ transport: "stdio", serverName: "held", command: "fixture", args: [] }] })
  changed!()
  const step = captureExecutionHookChannel(ctx).emit("agent/pre-step", {})
  await entered.promise
  const closing = catalog.close()
  let finished = false
  void closing.then(() => { finished = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(finished).toBe(false)
  expect(transportClosed).toBe(false)
  release.resolve()
  await step
  await closing
  expect(transportClosed).toBe(true)
})

it("joins a held LSP initialization before disposing its captured handle", async () => {
  const { createFakeLspServer } = await import("../../lsp/test/fake-server.ts")
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const server = createFakeLspServer({ initialize: async () => { entered.resolve(); await release.promise; return { capabilities: {} } }, shutdown: null })
  const catalog = createOwnedPluginCatalog({ ctx, tools, roles: createRoleRegistry(), workspace: process.cwd(), globalSkillDir: process.cwd(), report: () => {} })
  const mounting = catalog.mountLsp({ serverName: "held", command: "fixture", args: [], languages: [".ts"], shutdownTimeoutMs: 200, killGraceMs: 200 }, { spawner: server.spawner })
  await entered.promise
  const closing = catalog.close()
  let finished = false; void closing.then(() => { finished = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(finished).toBe(false)
  release.resolve()
  await mounting; await closing
  expect(tools.get("lsp")).toBeUndefined()
  expect(server.server.methods).toContain("shutdown")
})

it("fails before mounting a partial skill catalog when a tool name is already owned", () => {
  const ctx = createContext(), tools = createToolRegistry(ctx)
  tools.register({ name: "skill_get", description: "existing", inputSchema: { type: "object" }, execute: async () => "owned" })
  expect(() => createOwnedPluginCatalog({ ctx, tools, roles: createRoleRegistry(), workspace: process.cwd(), globalSkillDir: process.cwd(), report: () => {} })).toThrow(/skill_get/)
  expect(tools.get("skill_search")).toBeUndefined()
  expect(tools.get("skill_get")?.description).toBe("existing")
})
