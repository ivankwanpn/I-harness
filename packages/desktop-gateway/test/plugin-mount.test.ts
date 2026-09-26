import { expect, it, vi } from "vitest"
import { createSessionService } from "@i-harness/session-executor"
import { pluginExtensions, expandPluginPrompt } from "../src/plugin-mount.ts"
import { writeStdioStubServer } from "../../mcp-client/test/stdio-stub.ts"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
it("mounts a real plugin MCP server and role while reporting untrusted hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-plugin-mount-"))
  const hooks = join(root, "plugin", "hooks"); await mkdir(hooks, { recursive: true })
  const configPath = join(hooks, "hooks.json")
  await writeFile(configPath, JSON.stringify({ version: 1, handlers: [{ id: "untrusted", event: "pre-tool", type: "command", matcher: { tool: "read" }, command: { cmd: process.execPath, args: ["-e", "process.exit(1)"] }, trust: { script: "missing.js", sha256: "a".repeat(64) } }] }))
  const report = vi.fn()
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", extensionsFor: async (id) => pluginExtensions({
    skillDirs: [], commandDescriptors: [], hookConfigs: [configPath],
    mcpServerConfigs: { "plugin:fixture:echo": { command: process.execPath, args: [writeStdioStubServer()] } },
    agentDescriptors: [{ name: "plugin-reader", description: "Read-only fixture", systemPrompt: "Read the supplied material", tools: ["Read"] }],
  }, root, id, report) })
  try {
    const assembly = await service.assemblyFor("s")
    expect(assembly.pluginMcpResults.get("plugin:fixture:echo")).toBe(true)
    expect(assembly.pluginAgentResults.get("plugin-reader")).toBe(true)
    expect(report.mock.calls.flat(2).join(" ")).toContain("Hook")
  } finally { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})
it("expands an enabled plugin command into the durable model prompt", async () => {
  const report = vi.fn()
  const service = createSessionService({
    workspace: process.cwd(), modelPolicy: "test-mock", mockScript: [{ role: "assistant", text: "done" }],
    extensionsFor: async (id) => pluginExtensions({ skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [], commandDescriptors: [{ name: "hello", body: "Explain $ARGUMENTS" }] }, process.cwd(), id, report),
    transformPrompt: expandPluginPrompt,
  })
  try {
    await service.submit("s", "/hello this code", new AbortController().signal)
    expect(service.liveSession("s")?.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "user/message", text: "Explain this code" })]))
    expect(report).toHaveBeenCalledWith([])
  } finally { await service.close() }
})
