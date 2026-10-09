import { fileURLToPath } from "node:url"
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CompiledSandboxPolicy, ProcessSpec } from "@i-harness/sandbox"
import { createWslExecutionBackend } from "../src/index.ts"
import { compileExecutionPolicy } from "../../sandbox-policy/src/index.ts"

const distribution = process.env.IH_WSL_TEST_DISTRIBUTION
const root = fileURLToPath(new URL("../../../", import.meta.url))
const policy: CompiledSandboxPolicy = { mode: "read-only", owner: { sessionId: "controller-integration" }, authorityRevision: "integration",
  authorityKind: "bound", primaryRoot: root, readable: "caller", authorityRoots: [root], writeRoots: [], referenceRoots: [], fingerprint: "controller-integration-ro" }
const spec = (argv: string[]): ProcessSpec => ({ argv, cwd: root, env: { PATH: "/usr/bin:/bin", LANG: "C" }, owner: policy.owner,
  transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" })
function ownedFixture() {
  const parent = join(root, ".tmp")
  mkdirSync(parent, { recursive: true })
  const fixture = mkdtempSync(join(parent, "wsl-product-engine-controller-"))
  const work = join(fixture, "workspace"), reference = join(fixture, "reference")
  mkdirSync(work); mkdirSync(reference)
  const compiled = compileExecutionPolicy({ mode: "workspace-write", owner: policy.owner,
    authority: { kind: "bound", revision: "fixture", primaryRoot: work, roots: [work], references: [reference] } })
  return { fixture, work, reference, compiled }
}

describe.skipIf(!distribution)("explicit real WSL controller integration", () => {
  it("accepts compiled Windows policy casing with the caller's original cwd spelling", async () => {
    const backend = createWslExecutionBackend({ distribution: distribution! })
    const compiled = compileExecutionPolicy({ mode: "read-only", owner: policy.owner,
      authority: { kind: "bound", revision: "compiled", primaryRoot: root, roots: [root], references: [fileURLToPath(new URL("../../sandbox/", import.meta.url))] } })
    try {
      const request = spec(["/usr/bin/bash", "-c", "printf COMPILED_POLICY_OK"])
      request.env = { ...request.env, HOME: "/tmp" }
      const handle = await (await backend.prepare(request, compiled)).commit(() => {})
      const output = []
      for await (const value of handle.io.output) output.push(value.data)
      expect(Buffer.concat(output).toString()).toBe("COMPILED_POLICY_OK")
      expect(await handle.settled).toMatchObject({ kind: "settled", root: { exitCode: 0 } })
    } finally { await backend.dispose() }
  }, 30_000)

  it("rejects changed root identity and permits acknowledged rollback/disposal", async () => {
    const backend = createWslExecutionBackend({ distribution: distribution! })
    const { work, compiled } = ownedFixture()
    try {
      const prepared = await backend.prepare({ ...spec(["/usr/bin/true"]), cwd: work }, compiled)
      renameSync(work, work + "-old"); mkdirSync(work)
      await expect(prepared.commit(() => {})).rejects.toThrow(/(?:directory identity|writable inventory) changed|ambiguous directory identity/)
      await prepared.rollback()
    } finally { await backend.dispose() }
  }, 30_000)

  it("rejects writable hardlink alias admission and drains the refused owner", async () => {
    const backend = createWslExecutionBackend({ distribution: distribution! })
    const { work, reference, compiled } = ownedFixture()
    const sentinel = join(reference, "protected.txt")
    writeFileSync(sentinel, "REFERENCE_KEPT")
    linkSync(sentinel, join(work, "alias.txt"))
    try {
      await expect(backend.prepare({ ...spec(["/usr/bin/true"]), cwd: work }, compiled)).rejects.toThrow("writable hardlink refused")
      expect(readFileSync(sentinel, "utf8")).toBe("REFERENCE_KEPT")
    } finally { await backend.dispose() }
  }, 30_000)

  it("runs Bash pipeline and nested Linux process and waits for complete ownership release", async () => {
    const backend = createWslExecutionBackend({ distribution: distribution! })
    try {
      expect((await backend.probe()).availability).toBe("available")
      const request = spec(["/usr/bin/bash", "-c", "printf abc | /usr/bin/tr a-z A-Z; /usr/bin/bash -c 'printf nested >&2'"])
      const preparation = backend.prepare(request, policy)
      request.argv = ["/usr/bin/false"]
      const prepared = await preparation
      const handle = await prepared.commit(() => {})
      const stdout: Uint8Array[] = [], stderr: Uint8Array[] = []
      for await (const value of handle.io.output) (value.channel === "stdout" ? stdout : stderr).push(value.data)
      expect(Buffer.concat(stdout).toString()).toBe("ABC")
      expect(Buffer.concat(stderr).toString()).toBe("nested")
      expect(await handle.settled).toMatchObject({ kind: "settled", root: { exitCode: 0 }, treeEmpty: true, ioSettled: true, resourcesReleased: true })
      expect(backend.diagnostics().every(value => value.discardedLauncherStderrBytes === 0)).toBe(true)
    } finally { await backend.dispose() }
  }, 30_000)

  it("round-trips binary stdin across chunks without confusing control-looking output", async () => {
    const backend = createWslExecutionBackend({ distribution: distribution! })
    try {
      const handle = await (await backend.prepare(spec(["/usr/bin/cat"]), policy)).commit(() => {})
      const data = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from('{"v":1,"type":"settled"}\n'), Buffer.alloc(80_000, 129)])
      await handle.io.write(data)
      await handle.io.endInput()
      const output = []
      for await (const value of handle.io.output) output.push(value.data)
      expect(Buffer.concat(output)).toEqual(data)
      expect(await handle.settled).toMatchObject({ kind: "settled", root: { exitCode: 0 } })
    } finally { await backend.dispose() }
  }, 30_000)

  it("settles actual guest cancellation with the worker's Linux signal status", async () => {
    const backend = createWslExecutionBackend({ distribution: distribution! })
    try {
      const handle = await (await backend.prepare(spec(["/usr/bin/bash", "-c", "sleep 30"]), policy)).commit(() => {})
      expect(await handle.cancel("cancelled")).toMatchObject({ kind: "settled", root: { exitCode: null, signal: "KILL" }, treeEmpty: true })
    } finally { await backend.dispose() }
  }, 30_000)
})
