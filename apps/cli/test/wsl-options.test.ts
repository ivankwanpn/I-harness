import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const calls = vi.hoisted(() => [] as { task: string; opts: any }[])
vi.mock("../src/run.ts", () => ({ runHeadless: async (task: string, opts: any) => { calls.push({ task, opts }); return { exitCode: 0, finalText: "" } } }))
import { main } from "../src/index.ts"
let directory: string
let saved: Record<string, string | undefined>
const names = ["IH_CONFIG_DIR", "IH_WINDOWS_SANDBOX", "IH_WSL_DISTRIBUTION", "IH_WSL_NETWORK", "IH_WSL_WORKSPACE_DEPENDENCIES"]
beforeEach(() => {
  mkdirSync(resolve(".tmp"), { recursive: true })
  directory = mkdtempSync(resolve(".tmp/wsl-product-integration-cli-"))
  saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  for (const name of names) delete process.env[name]
  process.env.IH_CONFIG_DIR = directory; calls.length = 0
})
afterEach(() => {
  for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name] }
  rmSync(directory, { recursive: true, force: true })
})
it("routes explicit WSL options without leaking flags into the task or writing settings", async () => {
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ windowsSandboxBackend: "wsl", wslExecution: { distribution: "Saved", networkAccess: false, workspaceDependencies: true } }))
  const saved = readFileSync(join(directory, "settings.json"))
  expect(await main(["node", "ih", "run", "hello", "--windows-sandbox", "wsl", "--wsl-distribution", "Ubuntu-24.04", "--wsl-network", "allow", "--wsl-workspace-dependencies", "false"])).toBe(0)
  expect(calls[0]).toMatchObject({ task: "hello", opts: { windowsSandboxBackend: "wsl", wslExecution: { distribution: "Ubuntu-24.04", networkAccess: true, workspaceDependencies: false } } })
  expect(readFileSync(join(directory, "settings.json"))).toEqual(saved)
})
it("captures saved WSL options and validates environment overrides", async () => {
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ windowsSandboxBackend: "wsl", wslExecution: { distribution: "Saved", networkAccess: false, workspaceDependencies: false } }))
  process.env.IH_WSL_DISTRIBUTION = "Ubuntu"; process.env.IH_WSL_NETWORK = "deny"
  expect(await main(["node", "ih", "run", "hello"])).toBe(0)
  expect(calls[0]!.opts.wslExecution).toEqual({ distribution: "Ubuntu", networkAccess: false, workspaceDependencies: false })
  process.env.IH_WSL_NETWORK = "maybe"
  expect(await main(["node", "ih", "run", "hello"])).toBe(1)
  expect(calls).toHaveLength(1)
})
it.each([["--wsl-network", "maybe"], ["--wsl-distribution", "--yes"], ["--wsl-workspace-dependencies", "on"]])("refuses malformed WSL flag %s %s", async (flag, value) => {
  expect(await main(["node", "ih", "run", "hello", flag, value])).toBe(1)
  expect(calls).toHaveLength(0)
})
it.each(["disabled", "cached", "indexed"])("captures saved web mode %s and an owned cache root into the run", async mode => {
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ webSearchMode: mode }))
  expect(await main(["node", "ih", "run", "hello"])).toBe(0)
  expect(calls[0]!.opts).toMatchObject({ webSearchMode: mode, webCacheRoot: join(directory, "web-cache") })
})
