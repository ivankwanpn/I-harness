import { expect, it, vi } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { createContext } from "@i-harness/core-plugin"

const state = vi.hoisted(() => ({ registry: undefined as import("@i-harness/hooks").HookRegistry | undefined, creates: 0 }))
vi.mock("@i-harness/hooks", async load => {
  const original = await load<typeof import("@i-harness/hooks")>()
  return { ...original, async createExecutionHookRegistry(...args: Parameters<typeof original.createExecutionHookRegistry>) {
    const registry = await original.createExecutionHookRegistry(...args); state.registry = registry; state.creates++; return registry
  } }
})
import { createOwnedPluginMount } from "../src/owned-plugin-mount.ts"

it("retries the original hook registry's unmount after its first failure", async () => {
  state.registry = undefined; state.creates = 0
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "real-dispose-"))
  try {
    const script = join(root, "hook.cjs"), path = join(root, "native.json"), body = "// never approved\n", primary = new Error("startup report failed"), cleanup = new Error("unmount failed")
    await writeFile(script, body)
    await writeFile(path, JSON.stringify({ version: 1, handlers: [{ id: "start", event: "session/start", type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256: createHash("sha256").update(body).digest("hex") } }] }))
    const ctx = createContext(), unmount = ctx.unmount.bind(ctx); let calls = 0
    ctx.unmount = async name => { if (++calls === 1) throw cleanup; await unmount(name) }
    const mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "startup", configDir: root, workspace: root, report: () => { throw primary } })
    const inputs = { skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [path], commandDescriptors: [] }
    let caught: unknown; try { await mount.update(inputs) } catch (error) { caught = error }
    expect((caught as AggregateError).errors).toEqual([primary, cleanup])
    const registry = state.registry!
    expect(registry.handlers()).toHaveLength(1)
    await mount.close()
    expect(calls).toBe(2)
    expect(registry.handlers()).toEqual([])
    expect(state.creates).toBe(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
