import { expect, it, vi } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { createContext } from "@i-harness/core-plugin"

const state = vi.hoisted(() => ({ creates: 0, begins: 0, disposes: 0, failDispose: true, cleanup: undefined as unknown, registry: undefined as unknown, beginFailure: undefined as { value: unknown } | undefined }))
vi.mock("@i-harness/hooks", async load => {
  const original = await load<typeof import("@i-harness/hooks")>()
  return { ...original, async createExecutionHookRegistry(...args: Parameters<typeof original.createExecutionHookRegistry>) {
    const registry = await original.createExecutionHookRegistry(...args)
    state.creates++; state.registry = registry
    const begin = registry.beginSession.bind(registry), dispose = registry.dispose.bind(registry)
    registry.beginSession = async (...input) => { state.begins++; if (state.beginFailure) throw state.beginFailure.value; return begin(...input) }
    registry.dispose = async () => { state.disposes++; if (state.failDispose) throw state.cleanup; return dispose() }
    return registry
  } }
})
import { createOwnedPluginMount } from "../src/owned-plugin-mount.ts"

it.each([[undefined, false, "update"], [false, undefined, "update"], [undefined, false, "close"], [false, undefined, "close"]] as const)("retains the actual failed-start registry and ordered falsey failures (%j, %j, %s)", async (primary, failure, retryMode) => {
  state.creates = 0; state.begins = 0; state.disposes = 0; state.failDispose = true; state.cleanup = failure; state.registry = undefined; state.beginFailure = undefined
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "plugin-start-failure-"))
  try {
    const script = join(root, "hook.cjs"), path = join(root, "native.json"), body = "// never approved\n"
    await writeFile(script, body)
    await writeFile(path, JSON.stringify({ version: 1, handlers: [{ id: "start", event: "session/start", type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256: createHash("sha256").update(body).digest("hex") } }] }))
    const mount = createOwnedPluginMount({ ctx: createContext(), sessionId: "s", startSource: "startup", configDir: root, workspace: root, report: () => { throw primary } })
    const inputs = { skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [path], commandDescriptors: [] }
    let caught: unknown
    try { await mount.update(inputs) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([primary, failure])
    const original = state.registry
    expect(state.creates).toBe(1); expect(state.begins).toBe(1); expect(state.disposes).toBe(1)
    if (retryMode === "close") {
      await expect(mount.close()).rejects.toBe(failure)
      expect(state.registry).toBe(original); expect(state.creates).toBe(1); expect(state.begins).toBe(1); expect(state.disposes).toBe(2)
      state.failDispose = false
      await mount.close()
      expect(state.registry).toBe(original); expect(state.creates).toBe(1); expect(state.begins).toBe(1); expect(state.disposes).toBe(3)
      return
    }
    await expect(mount.update(inputs)).rejects.toBeInstanceOf(AggregateError)
    expect(state.registry).toBe(original); expect(state.creates).toBe(1); expect(state.begins).toBe(1); expect(state.disposes).toBe(2)
    state.failDispose = false
    let retry: unknown = Symbol("not-thrown")
    try { await mount.update(inputs) } catch (error) { retry = error }
    expect(retry).toBe(primary)
    expect(state.registry).toBe(original); expect(state.creates).toBe(1); expect(state.begins).toBe(1); expect(state.disposes).toBe(3)
    await mount.close()
    expect(state.disposes).toBe(3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("tombstones a successfully cleaned failed generation until its config changes", async () => {
  state.creates = 0; state.begins = 0; state.disposes = 0; state.failDispose = false; state.registry = undefined; state.beginFailure = undefined
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "plugin-tombstone-"))
  try {
    const script = join(root, "hook.cjs"), path = join(root, "native.json"), body = "// never approved\n", primary = new Error("startup report failed")
    await writeFile(script, body)
    await writeFile(path, JSON.stringify({ version: 1, handlers: [{ id: "start", event: "session/start", type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256: createHash("sha256").update(body).digest("hex") } }] }))
    let failReport = true
    const mount = createOwnedPluginMount({ ctx: createContext(), sessionId: "s", startSource: "startup", configDir: root, workspace: root, report: () => { if (failReport) throw primary } })
    const inputs = { skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [path], commandDescriptors: [] }
    await expect(mount.update(inputs)).rejects.toBe(primary)
    await expect(mount.update(inputs)).rejects.toBe(primary)
    expect(state.creates).toBe(1); expect(state.begins).toBe(1); expect(state.disposes).toBe(1)
    failReport = false; await writeFile(path, JSON.stringify({ version: 1, handlers: [] }))
    await mount.update(inputs)
    expect(state.creates).toBe(2); expect(state.begins).toBe(2)
    await mount.close(); expect(state.disposes).toBe(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("reports a failed startup after cleanup attempt while preserving all falsey causes", async () => {
  state.creates = 0; state.begins = 0; state.disposes = 0; state.failDispose = true; state.cleanup = false; state.registry = undefined; state.beginFailure = { value: undefined }
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "plugin-start-report-"))
  try {
    const path = join(root, "native.json"); await writeFile(path, JSON.stringify({ version: 1, handlers: [] }))
    let reports = 0, failReport = true
    const mount = createOwnedPluginMount({ ctx: createContext(), sessionId: "s", startSource: "startup", configDir: root, workspace: root, report: () => { reports++; if (failReport) throw false } })
    const inputs = { skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [path], commandDescriptors: [] }
    let failure: unknown; try { await mount.update(inputs) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([undefined, false, false])
    expect(reports).toBe(1); expect(state.creates).toBe(1); expect(state.begins).toBe(1); expect(state.disposes).toBe(1)
    state.failDispose = false; failReport = false; await mount.close()
    expect(state.disposes).toBe(2); expect(state.begins).toBe(1)
  } finally { state.beginFailure = undefined; await rm(root, { recursive: true, force: true }) }
})
