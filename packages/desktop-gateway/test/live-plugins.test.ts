import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { createSessionService } from "@i-harness/session-executor"
import { listCommands } from "@i-harness/interaction"
import { createDesktopPlugins } from "../src/plugins.ts"
import { pluginExtensions, expandPluginPrompt } from "../src/plugin-mount.ts"
import { writeStdioStubServer } from "../../mcp-client/test/stdio-stub.ts"

it("live-mounts the same MCP plugin into two independent existing agents", async () => {
  let enabled = false
  const args = [writeStdioStubServer()]
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", extensionsFor: async (id) => pluginExtensions({ skillDirs: [], commandDescriptors: [], agentDescriptors: [], hookConfigs: [], mcpServerConfigs: enabled ? { "plugin:shared:echo": { command: process.execPath, args } } : {} }, process.cwd(), id, () => {}) })
  try {
    const first = await service.assemblyFor("a"); const second = await service.assemblyFor("b")
    enabled = true; await service.refreshExtensions()
    expect(first.pluginMcpResults.get("plugin:shared:echo")).toBe(true)
    expect(second.pluginMcpResults.get("plugin:shared:echo")).toBe(true)
    enabled = false; await service.refreshExtensions()
    expect(first.pluginMcpResults.size).toBe(0); expect(second.pluginMcpResults.size).toBe(0)
    expect(await service.assemblyFor("a")).toBe(first)
  } finally { await service.close() }
})

it("withdraws a command while a model turn remains in flight on the same agent", async () => {
  let release!: () => void; let entered!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  let enabled = true
  const service = createSessionService({ workspace: process.cwd(), model: { async *stream() { entered(); await waiting; yield { type: "text/chunk" as const, text: "done" }; yield { type: "end" as const } } },
    extensionsFor: async (id) => pluginExtensions({ skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [], commandDescriptors: enabled ? [{ name: "hello", body: "expanded" }] : [] }, process.cwd(), id, () => {}), transformPrompt: expandPluginPrompt })
  let turn: Promise<void> | undefined
  try {
    const original = await service.assemblyFor("s")
    turn = service.submit("s", "/hello", new AbortController().signal)
    await started
    enabled = false
    await service.refreshExtensions()
    expect(service.queueState("s").running).toBe(true)
    expect(await service.assemblyFor("s")).toBe(original)
    expect(listCommands(original.ctx)).toEqual([])
  } finally { release(); await turn; await service.close() }
})

it("observes enablement changes made through another registry host", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-live-cross-host-"))
  const writer = createDesktopPlugins(join(root, "plugins")); const reader = createDesktopPlugins(join(root, "plugins"))
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", extensionsFor: async (id) => pluginExtensions(await reader.inputs(), root, id, () => {}) })
  const stop = reader.bindRefresh(() => service.refreshExtensions())
  try {
    const original = await service.assemblyFor("s")
    await writer.mutate({ action: "source/add", source: fileURLToPath(new URL("../../plugin-registry/test/fixtures/marketplace-a", import.meta.url)) })
    await writer.mutate({ action: "install", id: "Marketplace A__hello" })
    await writer.mutate({ action: "enable", id: "Marketplace A__hello" })
    await vi.waitFor(() => expect(listCommands(original.ctx).map((row) => row.name)).toContain("hello"), { timeout: 5000 })
    await writer.mutate({ action: "disable", id: "Marketplace A__hello" })
    await vi.waitFor(() => expect(listCommands(original.ctx)).toEqual([]), { timeout: 5000 })
    expect(await service.assemblyFor("s")).toBe(original)
  } finally { await stop(); await service.close(); await reader.close(); await writer.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})

it("enables and disables commands on the same existing agent without replacing history", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-live-plugins-"))
  const plugins = createDesktopPlugins(join(root, "plugins"))
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", mockScript: [{ role: "assistant", text: "done" }],
    extensionsFor: async (id) => pluginExtensions(await plugins.inputs(), root, id, () => {}), transformPrompt: expandPluginPrompt })
  const stop = plugins.bindRefresh(() => service.refreshExtensions())
  try {
    const original = await service.assemblyFor("s")
    expect(listCommands(original.ctx)).toEqual([])
    await plugins.mutate({ action: "source/add", source: fileURLToPath(new URL("../../plugin-registry/test/fixtures/marketplace-a", import.meta.url)) })
    await plugins.mutate({ action: "install", id: "Marketplace A__hello" })
    await plugins.mutate({ action: "enable", id: "Marketplace A__hello" })
    expect(await service.assemblyFor("s")).toBe(original)
    expect(listCommands(original.ctx).map((row) => row.name)).toContain("hello")
    await service.submit("s", "/hello test", new AbortController().signal)
    const history = [...original.session.events]
    await plugins.mutate({ action: "disable", id: "Marketplace A__hello" })
    expect(await service.assemblyFor("s")).toBe(original)
    expect(listCommands(original.ctx)).toEqual([])
    expect(original.session.events).toEqual(history)
    await expect(service.submit("s", "/hello test", new AbortController().signal)).rejects.toThrow("unknown command")
    await plugins.mutate({ action: "enable", id: "Marketplace A__hello" })
    expect(listCommands(original.ctx).filter((row) => row.name === "hello")).toHaveLength(1)
  } finally { await stop(); await service.close(); await plugins.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})
