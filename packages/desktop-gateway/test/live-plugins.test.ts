import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { createSessionService } from "@i-harness/session-executor"
import { listCommands, runCommand } from "@i-harness/interaction"
import { createDesktopPlugins } from "../src/plugins.ts"
import { pluginExtensions, expandPluginPrompt } from "../src/plugin-mount.ts"
import { writeStdioStubServer } from "../../mcp-client/test/stdio-stub.ts"
import { writeSuggestionMarketplace } from "./resource-suggestions-fixture.ts"

it("withdraws skills-only and command plugin resources from the same existing assembly on disable and uninstall", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-live-plugin-resources-"))
  await mkdir(join(root, "plugins"))
  await writeFile(join(root, "plugins", "state.json"), JSON.stringify({ version: 1, sources: [], plugins: [] }))
  const plugins = createDesktopPlugins(join(root, "plugins"))
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock",
    extensionsFor: async id => pluginExtensions(await plugins.inputs(), root, id, () => {}) })
  const stop = plugins.bindRefresh(() => service.refreshExtensions())
  try {
    const original = await service.assemblyFor("existing")
    const marketplace = await writeSuggestionMarketplace(root)
    await plugins.mutate({ action: "source/add", source: marketplace.source })
    for (const id of [marketplace.skillsId, marketplace.commandsId]) {
      await plugins.mutate({ action: "install", id })
      await plugins.mutate({ action: "enable", id })
    }
    const skill = await original.tools.execute({ name: "skill_get", args: { name: "brainstorming" } })
    expect(JSON.stringify(skill.output)).toContain("private skill body brainstorming")
    expect(await runCommand(original.ctx, "review-changes", "example.ts")).toMatchObject({ kind: "prompt", text: "private command body example.ts" })
    const history = [...original.session.events]
    for (const id of [marketplace.skillsId, marketplace.commandsId]) await plugins.mutate({ action: "disable", id })
    expect(await service.assemblyFor("existing")).toBe(original)
    expect(original.session.events).toEqual(history)
    await expect(original.tools.execute({ name: "skill_get", args: { name: "brainstorming" } })).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" })
    await expect(runCommand(original.ctx, "review-changes", "example.ts")).rejects.toThrow("unknown command")
    for (const id of [marketplace.skillsId, marketplace.commandsId]) await plugins.mutate({ action: "enable", id })
    expect(JSON.stringify((await original.tools.execute({ name: "skill_get", args: { name: "brainstorming" } })).output)).toContain("private skill body brainstorming")
    expect(await runCommand(original.ctx, "review-changes", "restored.ts")).toMatchObject({ text: "private command body restored.ts" })
    for (const id of [marketplace.skillsId, marketplace.commandsId]) await plugins.mutate({ action: "uninstall", id })
    expect(await service.assemblyFor("existing")).toBe(original)
    expect(original.session.events).toEqual(history)
    await expect(original.tools.execute({ name: "skill_get", args: { name: "brainstorming" } })).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" })
    await expect(runCommand(original.ctx, "review-changes", "example.ts")).rejects.toThrow("unknown command")
    expect(listCommands(original.ctx)).toEqual([])
  } finally { await stop(); await service.close(); await plugins.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})

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
