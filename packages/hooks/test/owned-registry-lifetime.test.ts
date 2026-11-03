import { expect, it, vi } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createExecutionHookRegistry } from "../src/registry.ts"

const projection = vi.hoisted(() => ({ dispose: vi.fn(async () => {}) }))
vi.mock("../src/claude-transcript.ts", () => ({ createClaudeTranscriptProjection: () => projection }))

it.each([undefined, false] as const)("owned registry retains original unmount cleanup across falsey failure %j", async failure => {
  projection.dispose.mockReset(); projection.dispose.mockResolvedValue(undefined)
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "hook-owner-dispose-"))
  try {
    const path = join(root, "hooks.json"); await writeFile(path, JSON.stringify({ version: 1, handlers: [] }))
    const ctx = createContext(), registry = await createExecutionHookRegistry(ctx, { configPath: path, configDir: root })
    const unmount = ctx.unmount.bind(ctx); let calls = 0
    vi.spyOn(ctx, "unmount").mockImplementation(async name => { if (++calls === 1) throw failure; await unmount(name) })
    await expect(registry.dispose()).rejects.toBe(failure)
    await expect(registry.refreshTrust({ isApproved: () => true })).rejects.toThrow(/disposed/)
    await registry.dispose(); await registry.dispose()
    expect(calls).toBe(2); expect(projection.dispose).toHaveBeenCalledTimes(1)
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) }
})

it("owned registry joins concurrent disposal and retries only the failed projection", async () => {
  projection.dispose.mockReset()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let attempts = 0
  projection.dispose.mockImplementation(async () => { attempts++; if (attempts === 1) { entered.resolve(); await release.promise; throw false } })
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "hook-owner-projection-"))
  try {
    const path = join(root, "hooks.json"); await writeFile(path, JSON.stringify({ version: 1, handlers: [] }))
    const ctx = createContext(), registry = await createExecutionHookRegistry(ctx, { configPath: path, configDir: root })
    const unmount = vi.spyOn(ctx, "unmount")
    const first = registry.dispose(); const second = registry.dispose(); expect(second).toBe(first)
    await entered.promise; release.resolve()
    await expect(first).rejects.toBe(false)
    await registry.dispose()
    expect(unmount).toHaveBeenCalledTimes(1); expect(attempts).toBe(2)
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) }
})
