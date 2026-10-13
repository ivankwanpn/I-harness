import { afterEach, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createHookRegistry, HookConfigError, type HookRegistryOptions } from "../src/index.ts"

// Hold only one real config read; all config parsing, trust and registry behavior
// still execute. This controls the caller's option replacement during loading.
const reads = vi.hoisted(() => ({ hold: undefined as undefined | {
  configPath: string; entered(): void; released: Promise<void>
} }))
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const hold = reads.hold
    if (hold && args[0] === hold.configPath) {
      reads.hold = undefined
      hold.entered()
      await hold.released
    }
    return actual.readFile(...args)
  } }
})

const roots: string[] = []
afterEach(async () => {
  reads.hold = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function root() {
  const path = await mkdtemp(join(tmpdir(), "ih-hooks-init-"))
  roots.push(path)
  return path
}
function approvals(granted: boolean) {
  return { isApproved: () => granted, approve() {}, revoke() {}, list: () => [] }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it("rejects an explicit missing config before reading the active approval store", async () => {
  const configDir = await root(), configPath = join(configDir, "missing.json")
  let approvalReads = 0
  const options: HookRegistryOptions = { configPath, configDir, get approvals(): HookRegistryOptions["approvals"] {
    ++approvalReads
    throw new Error("approvals getter must not run")
  } }
  await expect(createHookRegistry(createContext(), options)).rejects.toBeInstanceOf(HookConfigError)
  expect(approvalReads).toBe(0)
})

it("reads report and env before the load approval store, then reads active approvals after loading", async () => {
  const configDir = await root(), configPath = join(configDir, "hooks.json")
  await writeFile(configPath, JSON.stringify({ version: 1, handlers: [] }))
  const order: string[] = [], store = approvals(true)
  const options: HookRegistryOptions = { configPath, configDir,
    get report() { order.push("report"); return () => {} },
    get env() { order.push("env"); return {} },
    get approvals() { order.push("approvals"); return store },
  }
  const registry = await createHookRegistry(createContext(), options)
  try { expect(order).toEqual(["report", "env", "approvals", "approvals"]) }
  finally { await registry.dispose() }
})

it("uses the replacement active approval store after an initial config load was held", async () => {
  const plugin = await root(), configDir = join(plugin, "hooks"), configPath = join(configDir, "hooks.json")
  await mkdir(configDir)
  await writeFile(configPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "printf 'startup marker'" }] }] } }))
  const entered = deferred(), released = deferred(), errors: unknown[] = []
  reads.hold = { configPath, entered: entered.resolve, released: released.promise }
  const options: HookRegistryOptions = { configPath, configDir: plugin, claudePluginRoot: plugin,
    approvals: approvals(true), report: error => { errors.push(error) } }
  const pending = createHookRegistry(createContext(), options)
  let registry: Awaited<typeof pending> | undefined
  try {
    await entered.promise
    options.approvals = approvals(false)
    released.resolve()
    registry = await pending
    // The captured load store approved the real artifact; ongoing startup
    // authority must use the caller's replacement store and keep it inactive.
    expect(registry.handlers()[0]?.valid).toBe(true)
    await registry.beginSession("s")
    expect(registry.context()).toBe("")
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/not approved/)
  } finally {
    released.resolve()
    registry ??= await pending
    await registry.dispose()
  }
})
