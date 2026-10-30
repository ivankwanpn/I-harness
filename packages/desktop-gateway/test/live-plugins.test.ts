import { createFsWatchService } from "@i-harness/fs-watch"
import { mkdtemp, mkdir, rm, writeFile, rename, readFile, stat, utimes } from "node:fs/promises"
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
import * as materialization from "../../plugin-registry/src/materialize.ts"
import * as installation from "../../plugin-registry/src/install.ts"

it.each([false, true])("joins an admitted mutation through its later held refresh (lease failure=%s)", async failLease => {
  const root = await mkdtemp(join(tmpdir(), "ih-plugin-mutation-close-"))
  const leaseFailure = new Error("mutation lease cleanup")
  const close = vi.fn(async () => { if (failLease && close.mock.calls.length === 1) throw leaseFailure })
  const acquire = vi.fn(() => ({ ready: Promise.resolve({ epoch: 1, revision: 0 }), subscribe: () => () => {}, close }))
  const sharedClose = vi.fn(async () => {})
  const plugins = createDesktopPlugins(root, { watch: { acquire, close: sharedClose } })
  await plugins.mutate({ action: "source/add", source: fileURLToPath(new URL("../../plugin-registry/test/fixtures/marketplace-a", import.meta.url)) })
  await plugins.mutate({ action: "install", id: "Marketplace A__hello" })
  let releaseMutation!: () => void, releaseRefresh!: () => void
  const materializing = new Promise<void>(resolve => { releaseMutation = resolve })
  const refreshing = new Promise<void>(resolve => { releaseRefresh = resolve })
  const original = materialization.materializePlugin
  let entered = false, refreshCalls = 0, refreshFinished = false
  const materialize = vi.spyOn(materialization, "materializePlugin").mockImplementation(async (...args) => { entered = true; await materializing; return original(...args) })
  const observer = plugins.bindRefresh(async () => { if (++refreshCalls === 2) { await refreshing; refreshFinished = true } })
  let mutation: Promise<unknown> | undefined, closing: Promise<unknown> | undefined
  try {
    await vi.waitFor(() => expect(refreshCalls).toBe(1))
    mutation = plugins.mutate({ action: "enable", id: "Marketplace A__hello" })
    await vi.waitFor(() => expect(entered).toBe(true))
    let done = false
    closing = plugins.close().then(() => undefined, error => error).finally(() => { done = true })
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(done).toBe(false)
    await expect(plugins.mutate({ action: "disable", id: "Marketplace A__hello" })).rejects.toThrow("closed")
    releaseMutation()
    await vi.waitFor(() => expect(refreshCalls).toBe(2))
    await new Promise(resolve => setImmediate(resolve))
    expect(done).toBe(false)
    expect(refreshFinished).toBe(false)
    releaseRefresh(); await mutation
    const outcome = await closing
    expect(refreshFinished).toBe(true)
    if (failLease) {
      const causes = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(causes) : [error]
      expect(causes(outcome)).toContain(leaseFailure)
    } else expect(outcome).toBeUndefined()
    await plugins.close(); await observer.close()
    expect(close).toHaveBeenCalledTimes(failLease ? 2 : 1)
    expect(acquire).toHaveBeenCalledTimes(1); expect(sharedClose).not.toHaveBeenCalled()
    expect(materialize).toHaveBeenCalledTimes(1); expect(refreshCalls).toBe(2)
  } finally {
    releaseMutation(); releaseRefresh(); await mutation; await closing
    materialize.mockRestore(); await plugins.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

it("blocks original input reads behind held materialization and installs only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-plugin-materialize-lock-"))
  const watch = createFsWatchService()
  const writer = createDesktopPlugins(root, { watch }), reader = createDesktopPlugins(root, { watch })
  const install = vi.spyOn(installation, "installPlugin")
  await writer.mutate({ action: "source/add", source: fileURLToPath(new URL("../../plugin-registry/test/fixtures/marketplace-a", import.meta.url)) })
  await writer.mutate({ action: "install", id: "Marketplace A__hello" })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const original = materialization.materializePlugin
  let entered = false
  const materialize = vi.spyOn(materialization, "materializePlugin").mockImplementation(async (...args) => { entered = true; await held; return original(...args) })
  let refreshes = 0, commands: string[] = []
  const observer = reader.bindRefresh(async () => { refreshes++; commands = (await reader.inputs()).commandDescriptors.map(row => row.name) })
  try {
    await vi.waitFor(() => expect(refreshes).toBe(1))
    const enabling = writer.mutate({ action: "enable", id: "Marketplace A__hello" })
    await vi.waitFor(() => expect(entered).toBe(true))
    let readDone = false
    const reading = reader.inputs().then(value => { readDone = true; return value })
    const before = refreshes
    const path = join(root, "state.json")
    await writeFile(path, await readFile(path))
    await vi.waitFor(() => expect(refreshes).toBeGreaterThan(before), { timeout: 5000 })
    expect(readDone).toBe(false)
    release(); await enabling
    expect((await reading).commandDescriptors.map(row => row.name)).toContain("hello")
    await vi.waitFor(() => expect(commands).toContain("hello"), { timeout: 5000 })
    expect(install).toHaveBeenCalledTimes(1); expect(materialize).toHaveBeenCalledTimes(1)
  } finally { release(); materialize.mockRestore(); install.mockRestore(); await observer.close(); await reader.close(); await writer.close(); await watch.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})

it("refuses plugin close from its active observer callback and permits manual recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-plugin-self-close-"))
  const watch = createFsWatchService(), plugins = createDesktopPlugins(root, { watch })
  let calls = 0
  const observer = plugins.bindRefresh(async () => {
    calls++
    await expect(plugins.close()).rejects.toThrow("observer callback")
    if (calls === 1) throw ""
  })
  try {
    await vi.waitFor(async () => expect((await plugins.state()).refreshError).toBe(""), { timeout: 5000 })
    // Manual callbacks execute outside the observer context, so swap the binding
    // only after fencing this observer, retaining the explicit refresh owner.
    observer.dispose(); await observer.close()
    const recovered = plugins.bindRefresh(async () => {})
    await plugins.refresh()
    expect((await plugins.state()).refreshError).toBeUndefined()
    await recovered.close()
  } finally { await plugins.close(); await watch.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})

it("joins manual refresh despite managed lease cleanup failure and retries the same lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-plugin-close-refresh-"))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const close = vi.fn(async () => { if (close.mock.calls.length === 1) throw new Error("lease cleanup") })
  const acquire = vi.fn(() => ({ ready: Promise.resolve({ epoch: 1, revision: 0 }), subscribe: () => () => {}, close }))
  const plugins = createDesktopPlugins(root, { watch: { acquire, close: vi.fn() } })
  let calls = 0
  const observer = plugins.bindRefresh(async () => { if (++calls === 2) await held })
  await vi.waitFor(() => expect(calls).toBe(1))
  const refreshing = plugins.refresh()
  await vi.waitFor(() => expect(calls).toBe(2))
  let done = false
  const closing = plugins.close().then(() => undefined, error => error).finally(() => { done = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(done).toBe(false)
  release(); await refreshing
  expect(await closing).toBeInstanceOf(AggregateError)
  await plugins.close(); await observer.close()
  expect(acquire).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(2)
  await rm(root, { recursive: true, force: true })
})

it("withdraws skills-only and command plugin resources from the same existing assembly on disable and uninstall", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-live-plugin-resources-"))
  await mkdir(join(root, "plugins"))
  await writeFile(join(root, "plugins", "state.json"), JSON.stringify({ version: 1, sources: [], plugins: [] }))
  const watch = createFsWatchService()
  const plugins = createDesktopPlugins(join(root, "plugins"), { watch })
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
  } finally { await stop.close(); await service.close(); await plugins.close(); await watch.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
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
  const watch = createFsWatchService()
  const writer = createDesktopPlugins(join(root, "plugins"), { watch }); const reader = createDesktopPlugins(join(root, "plugins"), { watch })
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
  } finally { await stop.close(); await service.close(); await reader.close(); await writer.close(); await watch.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})

it("enables and disables commands on the same existing agent without replacing history", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-live-plugins-"))
  const watch = createFsWatchService()
  const plugins = createDesktopPlugins(join(root, "plugins"), { watch })
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
  } finally { await stop.close(); await service.close(); await plugins.close(); await watch.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})


it("refreshes after atomic state replacement and recreation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-plugin-watch-replace-"))
  const directory = join(root, "plugins"), path = join(directory, "state.json")
  const state = JSON.stringify({ version: 1, sources: [], plugins: [] })
  await mkdir(directory)
  await writeFile(path, state)
  const watch = createFsWatchService()
  const plugins = createDesktopPlugins(directory, { watch })
  let calls = 0
  let missing = false
  const failures: unknown[] = []
  const observer = plugins.bindRefresh(async () => { calls++; missing = await readFile(path).then(() => false, () => true); try { await plugins.inputs() } catch (error) { failures.push(error); throw error } })
  try {
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 5000 })
    await plugins.refresh() // establish that the original document is readable
    expect(await readFile(path, "utf8")).toBe(state)
    const original = await stat(path)
    await writeFile(join(root, "plugins", "next.json"), state)
    await utimes(join(directory, "next.json"), original.atime, original.mtime)
    const before = calls
    await rename(join(root, "plugins", "next.json"), join(root, "plugins", "state.json"))
    await vi.waitFor(() => expect(calls).toBeGreaterThan(before), { timeout: 5000 })
    expect(await readFile(path, "utf8")).toBe(state)
    expect((await stat(path)).size).toBe(original.size)
    const after = calls
    await rm(join(root, "plugins", "state.json"))
    await vi.waitFor(() => expect(missing).toBe(true), { timeout: 5000 })
    await writeFile(join(root, "plugins", "state.json"), state)
    await vi.waitFor(() => { expect(calls).toBeGreaterThan(after); expect(missing).toBe(false) }, { timeout: 5000 })
    // Fixed ancestor routing must recover after the selected parent is replaced.
    await rename(directory, join(root, "retired"))
    await vi.waitFor(() => expect(missing).toBe(true), { timeout: 5000 })
    // The original lock owner may recreate its parent while reading defaults.
    await mkdir(directory, { recursive: true }); await writeFile(path, state)
    await vi.waitFor(() => expect(missing).toBe(false), { timeout: 5000 })
    await rm(path); await mkdir(path)
    await vi.waitFor(() => expect(failures.length).toBeGreaterThan(0), { timeout: 5000 })
    await expect(plugins.inputs()).rejects.toThrow()
    await rm(path, { recursive: true }); await writeFile(path, state)
    await vi.waitFor(async () => expect((await plugins.state()).refreshError).toBeUndefined(), { timeout: 5000 })
  } finally { await observer.close(); await plugins.close(); await watch.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})
