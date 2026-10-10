import { afterEach, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createHookRegistry, HookConfigError, loadHooksConfig } from "../src/index.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const claudeHooks = {
  hooks: { SessionStart: [{ matcher: "startup|clear|compact", hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start', shell: "bash", async: false }] }] },
}
async function config(body: unknown, raw = false) {
  const root = await mkdtemp(join(tmpdir(), "ih-hook-format-")); roots.push(root)
  const path = join(root, "hooks.json")
  await writeFile(path, raw ? String(body) : JSON.stringify(body))
  return { root, path }
}

it("rejects Claude plugin hooks with a typed format diagnostic before evaluating trust", async () => {
  const { root, path } = await config(claudeHooks)
  let approvalReads = 0
  const error = await loadHooksConfig(path, root, { isApproved() { ++approvalReads; return true } }).catch(error => error)
  expect(error).toBeInstanceOf(HookConfigError)
  expect(error).toMatchObject({ name: "HookUnsupportedFormatError", format: "claude-plugin" })
  expect(approvalReads).toBe(0)
  await expect(createHookRegistry(createContext(), { configPath: path })).rejects.toMatchObject({ name: "HookUnsupportedFormatError", format: "claude-plugin" })
})

it("continues accepting an empty native v1 configuration", async () => {
  const { root, path } = await config({ version: 1, handlers: [] })
  expect(await loadHooksConfig(path, root)).toEqual([])
})

it.each([
  ["invalid JSON", "{", true],
  ["missing native version", { handlers: [] }, false],
  ["version 2 with a foreign hooks key", { version: 2, handlers: [], ...claudeHooks }, false],
  ["mixed native fields with missing version", { handlers: [], ...claudeHooks }, false],
  ["mixed native fields with an invalid handler array", { version: 1, handlers: "invalid", ...claudeHooks }, false],
  ["foreign hooks array", { hooks: [] }, false],
  ["foreign group with the wrong type", { hooks: { SessionStart: "invalid" } }, false],
  ["native handler without trust", { version: 1, handlers: [{ id: "invalid", event: "session/start", type: "command", command: { cmd: "node" } }] }, false],
] as const)("keeps %s as a native configuration error", async (_name, body, raw) => {
  const { root, path } = await config(body, raw)
  await expect(loadHooksConfig(path, root)).rejects.toMatchObject({ name: "HookConfigError", code: "hook-config-invalid" })
})
