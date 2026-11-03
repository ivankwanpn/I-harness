import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import type { ClaudeRuntimeService } from "../src/claude-runtime.ts"
import { createHookRegistry, sha256File } from "../src/index.ts"

const projection = vi.hoisted(() => ({ dispose: vi.fn(async () => {}) }))
vi.mock("../src/claude-transcript.ts", () => ({ createClaudeTranscriptProjection: () => projection }))
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  projection.dispose.mockReset()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(removeStop: () => void, trace: string[]) {
  const root = await mkdtemp(join(tmpdir(), "ih-hooks-lifetime-"))
  roots.push(root)
  const script = join(root, "hook.cjs"), configPath = join(root, "hooks.json")
  await writeFile(script, "console.log('{}')")
  const sha256 = await sha256File(script)
  await writeFile(configPath, JSON.stringify({ version: 1, handlers: [{ id: "notice", event: "notification", type: "command",
    command: { cmd: process.execPath, args: [script] }, trust: { script, sha256 } }] }))
  const ctx = createContext()
  const runtime: ClaudeRuntimeService = {
    registerStop() { trace.push("runtime stop"); return removeStop },
    async beforeStop() { return undefined },
    queueContext() {}, drainContext() { return [] },
  }
  ctx.services.register("hooks/claude-runtime", runtime)
  const mount = ctx.mount.bind(ctx)
  vi.spyOn(ctx, "mount").mockImplementation(plugin => { trace.push("plugin mount"); mount(plugin) })
  const registry = await createHookRegistry(ctx, { configPath, configDir: root,
    approvals: { isApproved: () => true, approve() {}, revoke() {}, list: () => [] } })
  return { ctx, registry }
}

it("registers runtime stop before plugin mount and disposes loaded handlers after unmount, before projection", async () => {
  const trace: string[] = []
  const { ctx, registry } = await fixture(() => { trace.push("remove stop") }, trace)
  const unmount = ctx.unmount.bind(ctx)
  vi.spyOn(ctx, "unmount").mockImplementation(async name => {
    trace.push("unmount")
    expect(registry.handlers()).toHaveLength(1)
    await expect(registry.refreshTrust({ isApproved: () => true })).rejects.toThrow("disposed")
    await expect(registry.beginSession("after-dispose")).resolves.toBeUndefined()
    await unmount(name)
  })
  projection.dispose.mockImplementation(async () => {
    trace.push("projection dispose")
    expect(registry.handlers()).toEqual([])
  })
  await registry.dispose()
  await registry.dispose()
  expect(trace).toEqual(["runtime stop", "plugin mount", "remove stop", "unmount", "projection dispose"])
})

it("retains the original partial disposal after unmount fails and makes subsequent dispose a no-op", async () => {
  const trace: string[] = []
  const failure = new Error("unmount failed")
  const { ctx, registry } = await fixture(() => { trace.push("remove stop") }, trace)
  vi.spyOn(ctx, "unmount").mockRejectedValue(failure)
  await expect(registry.dispose()).rejects.toBe(failure)
  expect(registry.handlers()).toHaveLength(1)
  expect(registry.context()).toBe("")
  expect(projection.dispose).not.toHaveBeenCalled()
  await expect(registry.refreshTrust({ isApproved: () => true })).rejects.toThrow("disposed")
  await registry.dispose()
  expect(ctx.unmount).toHaveBeenCalledTimes(1)
  expect(trace).toEqual(["runtime stop", "plugin mount", "remove stop"])
})

it("stops disposal at a failing runtime stop remover, preserving the disposed mark and loaded snapshot", async () => {
  const trace: string[] = []
  const failure = new Error("stop removal failed")
  const { ctx, registry } = await fixture(() => { throw failure }, trace)
  vi.spyOn(ctx, "unmount")
  await expect(registry.dispose()).rejects.toBe(failure)
  expect(registry.handlers()).toHaveLength(1)
  expect(ctx.unmount).not.toHaveBeenCalled()
  expect(projection.dispose).not.toHaveBeenCalled()
  await expect(registry.refreshTrust({ isApproved: () => true })).rejects.toThrow("disposed")
  await registry.dispose()
  expect(ctx.unmount).not.toHaveBeenCalled()
})
