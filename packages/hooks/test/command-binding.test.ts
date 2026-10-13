import { afterEach, expect, it, vi } from "vitest"
import * as childProcess from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HookTrustError, loadHooksConfig, runHookHandler, sha256File, verifyHandlerTrust, type HookHandlerSpec } from "../src/index.ts"
import { runWindowsHook } from "../src/windows-process.ts"

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>()
  return { ...original, spawn: vi.fn(original.spawn) }
})
vi.mock("../src/windows-process.ts", async importOriginal => {
  const original = await importOriginal<typeof import("../src/windows-process.ts")>()
  return { ...original, runWindowsHook: vi.fn(original.runWindowsHook) }
})

const roots: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ih-hook-command-binding-")); roots.push(root)
  const script = join(root, "approved.cjs"), configPath = join(root, "hooks.json")
  await writeFile(script, "process.stdout.write('{}')\n")
  const sha256 = await sha256File(script)
  const spec: HookHandlerSpec = { id: "mismatch", event: "pre-tool", type: "command",
    command: { cmd: process.execPath, args: ["-e", "process.stdout.write('{}')"] }, trust: { script, sha256 } }
  return { root, script, configPath, spec, approvals: { isApproved: (hash: string) => hash === sha256 } }
}

it("audit A.2 regression: refuses an approved harmless artifact while command.cmd executes unrelated inline code", async () => {
  const f = await fixture()
  expect(f.spec.command.cmd).not.toBe(f.script)
  await expect(verifyHandlerTrust(f.spec, f.root)).rejects.toBeInstanceOf(HookTrustError)
  await writeFile(f.configPath, JSON.stringify({ version: 1, handlers: [f.spec] }))
  const [loaded] = await loadHooksConfig(f.configPath, f.root, f.approvals)
  expect(loaded!.valid).toBe(false)
  expect(loaded!.trustError).toMatch(/command.*trusted artifact/i)
  expect(loaded!.unapproved).toBeUndefined()
})

it("marks an approved command mismatch invalid during config trust checking, not as an unapproved declaration", async () => {
  const f = await fixture()
  await writeFile(f.configPath, JSON.stringify({ version: 1, handlers: [f.spec] }))
  const [loaded] = await loadHooksConfig(f.configPath, f.root, f.approvals)
  expect(loaded!.valid).toBe(false)
  expect(loaded!.trustError).toMatch(/command.*trusted artifact/i)
  expect(loaded!.unapproved).toBeUndefined()
})

it("refuses a command mismatch at trust-check time before either native dispatch path", async () => {
  const f = await fixture()
  const outcome = await runHookHandler(f.spec, { event: "pre-tool", tool: { name: "read", args: {} } }, f.root)
    .then(value => value, error => error)
  expect(childProcess.spawn).not.toHaveBeenCalled()
  expect(runWindowsHook).not.toHaveBeenCalled()
  expect(outcome).toBeInstanceOf(HookTrustError)
  expect(outcome.message).toMatch(/command.*trusted artifact/i)
})

it("keeps a direct approved executable declaration valid with its unchanged file-content hash", async () => {
  const f = await fixture(), sha256 = await sha256File(process.execPath)
  f.spec.command = { cmd: process.execPath }
  f.spec.trust = { script: process.execPath, sha256 }
  await expect(verifyHandlerTrust(f.spec, f.root)).resolves.toBeUndefined()
  await writeFile(f.configPath, JSON.stringify({ version: 1, handlers: [f.spec] }))
  const [loaded] = await loadHooksConfig(f.configPath, f.root, { isApproved: hash => hash === sha256 })
  expect(loaded!.valid).toBe(true)
  expect(loaded!.trustError).toBeUndefined()
  expect(loaded!.spec.trust.sha256).toBe(sha256)
})

it("runs the existing host Node plus approved script form unchanged", async () => {
  const f = await fixture()
  f.spec.command = { cmd: process.execPath, args: [f.script] }
  await expect(verifyHandlerTrust(f.spec, f.root)).resolves.toBeUndefined()
  await expect(runHookHandler(f.spec, { event: "pre-tool", tool: { name: "read", args: {} } }, f.root)).resolves.toEqual({})
})

it.each(["unrelated script", "inline code followed by approved script", "preload followed by approved script", "extra script arguments"])(
  "refuses interpreter arguments not covered by the approved artifact: %s", async mode => {
    const f = await fixture(), other = join(f.root, "other.cjs")
    await writeFile(other, "process.stdout.write('{}')\n// different content\n")
    const args = mode === "unrelated script" ? [other]
      : mode === "inline code followed by approved script" ? ["-e", "process.stdout.write('{}')", f.script]
      : mode === "preload followed by approved script" ? ["--require", other, f.script] : [f.script, "unapproved-input"]
    f.spec.command.args = args
    await expect(verifyHandlerTrust(f.spec, f.root)).rejects.toBeInstanceOf(HookTrustError)
  },
)

it("an approval of the interpreter binary does not approve inline command arguments", async () => {
  const f = await fixture()
  f.spec.trust = { script: process.execPath, sha256: await sha256File(process.execPath) }
  await expect(verifyHandlerTrust(f.spec, f.root)).rejects.toBeInstanceOf(HookTrustError)
})

it("refuses an arbitrary executable named node even when its sole argument is the approved script", async () => {
  const f = await fixture(), fake = join(f.root, process.platform === "win32" ? "node.exe" : "node")
  await writeFile(fake, "not the host runtime", { mode: 0o755 })
  f.spec.command = { cmd: fake, args: [f.script] }
  await expect(verifyHandlerTrust(f.spec, f.root)).rejects.toBeInstanceOf(HookTrustError)
})

it("resolves an approved script argument against the actual command cwd, not the config directory", async () => {
  const f = await fixture(), cwd = join(f.root, "work")
  await mkdir(cwd)
  f.spec.command = { cmd: process.execPath, args: ["../approved.cjs"], cwd }
  f.spec.trust.script = "approved.cjs"
  await expect(verifyHandlerTrust(f.spec, f.root)).resolves.toBeUndefined()
  await expect(runHookHandler(f.spec, { event: "pre-tool", tool: { name: "read", args: {} } }, f.root)).resolves.toEqual({})
})

it("refuses a relative script argument that selects an unapproved file from command.cwd", async () => {
  const f = await fixture(), cwd = join(f.root, "work")
  await mkdir(cwd)
  await writeFile(join(cwd, "approved.cjs"), "process.stdout.write('{}')\n// different content\n")
  f.spec.command = { cmd: process.execPath, args: ["approved.cjs"], cwd }
  await expect(verifyHandlerTrust(f.spec, f.root)).rejects.toBeInstanceOf(HookTrustError)
})

it("keeps Claude command strings covered by the approved plugin-tree hash while executing the resolved host shell", async () => {
  const f = await fixture()
  await writeFile(f.configPath, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "printf '{}'" }] }] } }))
  const [initial] = await loadHooksConfig(f.configPath, f.root, undefined, { claudePluginRoot: f.root })
  const sha256 = initial!.spec.trust.sha256
  const [loaded] = await loadHooksConfig(f.configPath, f.root, { isApproved: hash => hash === sha256 }, { claudePluginRoot: f.root })
  expect(loaded!.valid).toBe(true)
  expect(sha256).not.toBe(await sha256File(f.configPath))
  expect(loaded!.spec.command.cmd).not.toBe(loaded!.spec.trust.script)
  await expect(verifyHandlerTrust(loaded!.spec, f.root)).resolves.toBeUndefined()
  await expect(runHookHandler(loaded!.spec, { event: "pre-tool", tool: { name: "read", args: {} } }, f.root, { cwd: f.root })).resolves.toEqual({})
})

it("refuses a PATH-shadowed runtime before native dispatch even when its argument is approved", async () => {
  const f = await fixture(), fake = join(f.root, process.platform === "win32" ? "node.exe" : "node")
  await writeFile(fake, "not the host runtime", { mode: 0o755 })
  f.spec.command = { cmd: "node", args: [f.script] }
  const outcome = await runHookHandler(f.spec, { event: "pre-tool", tool: { name: "read", args: {} } }, f.root,
    { env: { PATH: f.root } }).then(value => value, error => error)
  expect(outcome).toBeInstanceOf(HookTrustError)
  expect(childProcess.spawn).not.toHaveBeenCalled()
  expect(runWindowsHook).not.toHaveBeenCalled()
})

it("rechecks relative arguments using the runtime cwd before native dispatch", async () => {
  const f = await fixture(), cwd = join(f.root, "work")
  await mkdir(cwd)
  await writeFile(join(cwd, "approved.cjs"), "process.stdout.write('{}')\n// different content\n")
  f.spec.command = { cmd: process.execPath, args: ["approved.cjs"] }
  await expect(verifyHandlerTrust(f.spec, f.root)).resolves.toBeUndefined()
  const outcome = await runHookHandler(f.spec, { event: "pre-tool", tool: { name: "read", args: {} } }, f.root, { cwd })
    .then(value => value, error => error)
  expect(outcome).toBeInstanceOf(HookTrustError)
  expect(childProcess.spawn).not.toHaveBeenCalled()
  expect(runWindowsHook).not.toHaveBeenCalled()
})

it("runs the verified command snapshot when the caller mutates its declaration during trust I/O", async () => {
  const f = await fixture()
  f.spec.command = { cmd: process.execPath, args: [f.script] }
  const pending = runHookHandler(f.spec, { event: "pre-tool", tool: { name: "read", args: {} } }, f.root)
  f.spec.command.args = ["-e", "process.stdout.write('{\"continue\":false}')"]
  await expect(pending).resolves.toEqual({})
})

it.skipIf(process.platform !== "win32")("recognizes the same host executable through native Windows canonical casing", async () => {
  const f = await fixture()
  f.spec.command = { cmd: process.execPath.toUpperCase(), args: [f.script] }
  await expect(verifyHandlerTrust(f.spec, f.root)).resolves.toBeUndefined()
  await expect(runHookHandler(f.spec, { event: "pre-tool", tool: { name: "read", args: {} } }, f.root)).resolves.toEqual({})
})

it.skipIf(process.platform !== "win32")("rechecks bound artifact bytes at prepared commit and refuses a changed file before launch", async () => {
  const f = await fixture()
  f.spec.command = { cmd: process.execPath, args: [f.script] }
  vi.mocked(runWindowsHook).mockImplementationOnce(async input => {
    expect(input.argv).toEqual([process.execPath, f.script])
    await writeFile(f.script, "process.stdout.write('{\"continue\":false}')")
    input.validate()
    throw new Error("changed artifact reached launch")
  })
  await expect(runHookHandler(f.spec, { event: "pre-tool", tool: { name: "read", args: {} } }, f.root)).rejects.toBeInstanceOf(HookTrustError)
  expect(childProcess.spawn).not.toHaveBeenCalled()
})
