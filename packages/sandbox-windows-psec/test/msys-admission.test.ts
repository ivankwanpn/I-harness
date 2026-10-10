import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, resolve, win32 } from "node:path"
import type { ProcessSpec } from "@i-harness/sandbox"
import { compileExecutionPolicy } from "@i-harness/sandbox-policy"
import { createWindowsUnrestrictedBackend } from "../src/index.ts"
const git = win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git")
const realBash = win32.join(git, "usr", "bin", "bash.exe")
const suite = describe.skipIf(process.platform !== "win32" || !existsSync(realBash))
const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex")
async function fixture() {
  const build = resolve(import.meta.dirname, "../../../build"), root = await mkdtemp(join(build, "msys-admission-"))
  const bin = join(root, "usr", "bin"), shimDir = join(root, "bin"), etc = join(root, "etc")
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(shimDir), mkdir(etc)])
  const executable = join(bin, "bash.exe"), runtime = join(bin, "msys-2.0.dll"), original = join(shimDir, "bash.exe"), configuration = join(etc, "git-bash.config")
  await Promise.all([copyFile(realBash, executable), copyFile(win32.join(git, "usr", "bin", "msys-2.0.dll"), runtime), copyFile(win32.join(git, "bin", "bash.exe"), original)])
  const owner = { sessionId: "msys-admission" }, policy = compileExecutionPolicy({ mode: "danger-full-access", owner,
    authority: { kind: "unbound", revision: "test", workspaceRoot: root } })
  const spec: ProcessSpec = { argv: [executable, "--noprofile", "--norc", "-i"], cwd: root, env: {}, owner,
    transport: "pty", lifetime: "retain-tree", argumentEncoding: "crt", pty: { cols: 100, rows: 24 },
    msysPty: { executable: { path: executable, sha256: await digest(executable) }, runtime: { path: runtime, sha256: await digest(runtime) },
      resolution: { kind: "git-bash-shim", original: { path: original, sha256: await digest(original) }, configuration: { path: configuration, sha256: null } } } }
  const backend = createWindowsUnrestrictedBackend()
  return { root, executable, runtime, original, configuration, spec, policy, backend, async close() {
    await backend.dispose()
    if (!root.startsWith(build + win32.sep)) throw new Error("fixture cleanup escaped owned build path")
    await rm(root, { recursive: true, force: true })
  } }
}
suite("native MSYS admission observations", () => {
  it.each(["runtime", "executable", "original"] as const)("refuses changed %s bytes captured by the resolver", async field => {
    const f = await fixture()
    try { await writeFile(f[field], "changed owned fixture"); await expect(f.backend.prepare(f.spec, f.policy)).rejects.toThrow(/artifact content changed/) }
    finally { await f.close() }
  }, 10_000)
  it("refuses absent configuration creation at prepare and immediately before commit", async () => {
    const f = await fixture()
    try {
      await writeFile(f.configuration, "MSYS=changed\n")
      await expect(f.backend.prepare(f.spec, f.policy)).rejects.toThrow(/configuration created/)
      await rm(f.configuration)
      const prepared = await f.backend.prepare(f.spec, f.policy)
      try {
        // Kernel locks refuse actual executable/runtime/shim replacement while
        // prepared, rather than relying on a cached pathname or hash.
        for (const path of [f.runtime, f.executable, f.original]) await expect(writeFile(path, "changed")).rejects.toThrow()
        await writeFile(f.configuration, "MSYS=created after prepare\n")
        await expect(prepared.commit(() => {})).rejects.toThrow(/configuration created/)
      } finally { await prepared.rollback() }
    } finally { await f.close() }
  }, 10_000)
  it("pins present configuration bytes and refuses a changed observation", async () => {
    const f = await fixture()
    try {
      await writeFile(f.configuration, "MSYS=winsymlinks:native\n")
      const observed = await digest(f.configuration)
      const spec = { ...f.spec, msysPty: { ...f.spec.msysPty!, resolution: { ...f.spec.msysPty!.resolution!, configuration: { path: f.configuration, sha256: observed } } } }
      const prepared = await f.backend.prepare(spec, f.policy)
      try { await expect(writeFile(f.configuration, "changed")).rejects.toThrow() } finally { await prepared.rollback() }
      await writeFile(f.configuration, "changed")
      await expect(f.backend.prepare(spec, f.policy)).rejects.toThrow(/artifact content changed/)
    } finally { await f.close() }
  }, 10_000)
})
