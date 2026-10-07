import { mkdtempSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { launchExecution, createExecutionSupervisor } from "@i-harness/exec"
import type { CompiledSandboxPolicy, ProcessSpec } from "@i-harness/sandbox"
import { createWindowsPsecBackend, createWindowsUnrestrictedBackend } from "../src/index.ts"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const helper = resolve(repo, "packages/sandbox-windows-psec/artifacts/win32-x64/i-harness-windows-helper.exe")
const manifestPath = resolve(repo, "packages/sandbox-windows-psec/artifacts/win32-x64/manifest.json")

function fixture(engine: "psec" | "unrestricted", omitLocalAppData = false, command = "basic") {
  const root = mkdtempSync(resolve(repo, ".tmp", "sandbox-redesign-driver-"))
  const owner = Object.freeze({ sessionId: `driver-${Math.random()}` })
  const mode = engine === "psec" ? "workspace-write" : "danger-full-access"
  const policy: CompiledSandboxPolicy = Object.freeze({
    mode, owner, authorityRevision: "driver-1", authorityKind: "bound", primaryRoot: root,
    readable: "caller", authorityRoots: Object.freeze([root]), writeRoots: Object.freeze(engine === "psec" ? [root] : []),
    referenceRoots: Object.freeze([]), fingerprint: "driver-smoke-fingerprint",
  })
  const env: Record<string, string> = {
    SystemRoot: process.env.SystemRoot!, SystemDrive: process.env.SystemDrive!, windir: process.env.SystemRoot!,
    USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
    SANDBOX_MARKER: "driver-proof", EMPTY_VALUE: "",
  }
  if (omitLocalAppData) delete env.LOCALAPPDATA
  const spec: ProcessSpec = Object.freeze({ argv: Object.freeze([helper, "--self-child", command]), cwd: root,
    env: Object.freeze(env), owner, transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" })
  const backend = engine === "psec" ? createWindowsPsecBackend({ manifestPath }) : createWindowsUnrestrictedBackend({ manifestPath })
  const requirements = { writeIsolation: engine === "psec", readIsolation: false, denyPaths: false,
    transport: "pipe" as const, lifetime: "complete-tree" as const, minimumAssurance: "unverified" as const }
  return { root, spec, policy, backend, requirements }
}

describe.skipIf(process.platform !== "win32")("real Windows helper through public execution", () => {
  it.each(["unrestricted", "psec"] as const)("%s launch returns real PID, output, and confirmed settlement", async engine => {
    const f = fixture(engine)
    const handle = await launchExecution({ backend: f.backend, spec: f.spec, policy: f.policy,
      requirements: f.requirements, validateAuthority: actual => expect(actual).toBe(f.policy) })
    expect(handle.pid).toBeGreaterThan(0)
    const output: string[] = []
    const drain = (async () => { for await (const frame of handle.io.output) output.push(`${frame.channel}:${Buffer.from(frame.data).toString()}`) })()
    expect(await handle.rootExited).toEqual({ exitCode: 17 })
    expect(await handle.settled).toMatchObject({ kind: "settled", treeEmpty: true, ioSettled: true, resourcesReleased: true })
    await drain
    expect(output.join(" ")).toContain("driver-proof")
    expect(output.join(" ")).toContain("self-child-stderr")
    expect(handle.io.diagnostics?.()).toEqual({ outputAbandoned: false, discardedOutputBytes: 0 })
    expect(handle.receipt.assurance).toBe(engine === "psec" ? "experimental" : "unverified")
  }, 30000)

  it("supervisor preserves one owned unrestricted execution", async () => {
    const f = fixture("unrestricted")
    const supervisor = createExecutionSupervisor()
    const execution = await supervisor.launch({ backend: f.backend, spec: f.spec, policy: f.policy,
      requirements: f.requirements, validateAuthority: actual => expect(actual).toBe(f.policy) })
    expect(execution.handle.pid).toBeGreaterThan(0)
    for await (const _frame of execution.handle.io.output) { /* drain */ }
    expect((await execution.handle.settled).kind).toBe("settled")
    await supervisor.dispose()
  }, 30000)

  it("missing LOCALAPPDATA preserves native PSEC error 203 and rolls back", async () => {
    const f = fixture("psec", true)
    await expect(launchExecution({ backend: f.backend, spec: f.spec, policy: f.policy,
      requirements: f.requirements, validateAuthority: () => {} })).rejects.toThrow(/203/)
  }, 30000)

  it("writes bytes and ends input through the owned pipe", async () => {
    const f = fixture("unrestricted", false, "echo")
    const handle = await launchExecution({ backend: f.backend, spec: f.spec, policy: f.policy,
      requirements: f.requirements, validateAuthority: () => {} })
    const chunks: Buffer[] = []
    const drain = (async () => { for await (const frame of handle.io.output) if (frame.channel === "stdout") chunks.push(Buffer.from(frame.data)) })()
    await handle.io.write(Buffer.from("driver-input"))
    await handle.io.endInput()
    expect((await handle.settled).kind).toBe("settled")
    await drain
    expect(Buffer.concat(chunks).toString()).toBe("driver-input")
  }, 30000)

  it("cancels a flood without an attached output iterator and reports loss", async () => {
    const f = fixture("unrestricted", false, "flood")
    const handle = await launchExecution({ backend: f.backend, spec: f.spec, policy: f.policy,
      requirements: f.requirements, validateAuthority: () => {} })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect((await handle.cancel("cancelled")).kind).toBe("settled")
    expect(handle.io.diagnostics?.().outputAbandoned).toBe(true)
    expect(handle.io.diagnostics?.().discardedOutputBytes).toBeGreaterThan(0)
  }, 30000)

  it("active release terminates a flood without an attached iterator", async () => {
    const f = fixture("unrestricted", false, "flood")
    const handle = await launchExecution({ backend: f.backend, spec: f.spec, policy: f.policy,
      requirements: f.requirements, validateAuthority: () => {} })
    await new Promise(resolve => setTimeout(resolve, 100))
    const released = await Promise.race([
      handle.release(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("active release stalled")), 3000)),
    ])
    expect(released.kind).toBe("settled")
  }, 10000)

  it("rejects PSEC PTY and unrestricted mandatory reference locks before launch", async () => {
    const psec = fixture("psec")
    await expect(psec.backend.prepare({ ...psec.spec, transport: "pty", pty: { cols: 80, rows: 24 } }, psec.policy))
      .rejects.toThrow(/unsupported-transport/)
    const unrestricted = fixture("unrestricted")
    await expect(unrestricted.backend.prepare(unrestricted.spec, { ...unrestricted.policy, referenceRoots: [unrestricted.root] }))
      .rejects.toThrow(/cannot enforce mandatory/)
  })

  it("authority change immediately before commit rolls back without workload", async () => {
    const f = fixture("unrestricted")
    const prepared = await f.backend.prepare(f.spec, f.policy)
    await expect(prepared.commit(() => { throw new Error("authority-revoked") })).rejects.toThrow(/authority-revoked/)
    await prepared.rollback()
    await prepared.rollback()
    await expect(prepared.commit(() => {})).rejects.toThrow(/rollback|commit/i)
  }, 30000)

  it("duplicate commit cannot launch another workload", async () => {
    const f = fixture("unrestricted")
    const prepared = await f.backend.prepare(f.spec, f.policy)
    const handle = await prepared.commit(() => {})
    await expect(prepared.commit(() => {})).rejects.toThrow(/duplicate commit/)
    for await (const _frame of handle.io.output) { /* drain */ }
    expect((await handle.settled).kind).toBe("settled")
  }, 30000)

  it("rejects mutation of prepared policy identity before commit", async () => {
    const f = fixture("unrestricted")
    const policy = { ...f.policy, owner: { ...f.policy.owner } }
    const prepared = await f.backend.prepare(f.spec, policy)
    policy.fingerprint = "changed-after-ready"
    await expect(prepared.commit(() => {})).rejects.toThrow(/policy.*changed/i)
    await prepared.rollback()
  }, 30000)

  it("aborted preparation cannot commit and retains rollback ownership", async () => {
    const f = fixture("unrestricted")
    const controller = new AbortController()
    const prepared = await f.backend.prepare(f.spec, f.policy, controller.signal)
    controller.abort("owner closed")
    await expect(prepared.commit(() => {})).rejects.toThrow(/aborted/)
    await prepared.rollback()
    await prepared.rollback()
  }, 30000)
})
