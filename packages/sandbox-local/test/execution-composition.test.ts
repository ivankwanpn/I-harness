import { describe, expect, it } from "vitest"
import type { BackendProbe, CompiledSandboxPolicy, TransportExecutionBackend } from "@i-harness/sandbox"
import { createLocalExecutionBackends } from "../src/index.ts"
import { createLegacyWindowsBackend } from "../src/index.ts"
import { createWindowsAclSandbox } from "@i-harness/sandbox-windows-acl"
import { compileExecutionPolicy } from "@i-harness/sandbox-policy"
import type { ProcessSpec, SandboxProvider, TransportExecutionHandle } from "@i-harness/sandbox"
import { mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const policy = (mode: "read-only" | "danger-full-access"): CompiledSandboxPolicy => ({
  mode, owner: { sessionId: "owner" }, authorityRevision: "r1", authorityKind: "unbound",
  primaryRoot: process.cwd(), authorityRoots: [process.cwd()], readable: "caller",
  writeRoots: [], referenceRoots: [], fingerprint: "fixture",
})
function backend(id: string, disposed: string[]): TransportExecutionBackend & { dispose(): Promise<void> } {
  return {
    async probe(): Promise<BackendProbe> { return { id, availability: "available", assurance: "unverified",
      features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare() { throw new Error(`${id} failed without fallback`) },
    async dispose() { disposed.push(id) },
  }
}

describe("local execution composition", () => {
  it("selects the explicit Windows confined engine once and does not retry another backend", async () => {
    const disposed: string[] = []
    const native = backend("native", disposed)
    const psec = backend("psec", disposed)
    const local = createLocalExecutionBackends({ platform: "win32", windowsSelection: "psec",
      windowsPsecBackend: psec, windowsUnrestrictedBackend: native })
    expect(local.select(policy("read-only"), "pipe")).toBe(psec)
    await expect(local.select(policy("read-only"), "pipe").prepare({} as never, policy("read-only"))).rejects.toThrow("psec failed")
    expect(local.select(policy("danger-full-access"), "pipe")).toBe(native)
    await local.dispose()
    expect(disposed).toEqual(["psec", "native"])
  })

  it("refuses an unavailable explicit legacy adapter and unsupported confined PTY", async () => {
    const local = createLocalExecutionBackends({ platform: "win32", windowsSelection: "legacy",
      windowsPsecBackend: backend("psec", []), windowsUnrestrictedBackend: backend("native", []) })
    expect(() => local.select(policy("read-only"), "pipe")).toThrow(/legacy/i)
    expect(() => local.select(policy("read-only"), "pty")).toThrow(/PTY/i)
    await local.dispose()
  })

  it.skipIf(process.platform !== "win32")("routes readonly legacy runner temp metadata beneath a trusted owned root", () => {
    const owned = mkdtempSync(join(resolve(process.cwd(), "../.."), ".tmp/sandbox-redesign-local-"))
    try {
      const provider = createWindowsAclSandbox({ writableDirs: [], mode: "read-only", privateTempRoot: owned })
      const wrapped = provider.confine([process.execPath, "-e", ""], { mode: "read-only", workspaceRoot: process.cwd() })
      expect(wrapped.argv[wrapped.argv.indexOf("--temp") + 1]).toBe(owned)
      provider.dispose()
    } finally { rmSync(owned, { recursive: true, force: true }) }
  })

  it("labels legacy receipt and retains the native Job handle and runner classification", async () => {
    const requested = compileExecutionPolicy({ mode: "read-only", owner: { sessionId: "owner" },
      authority: { kind: "unbound", revision: "r1", workspaceRoot: process.cwd() } })
    const spec: ProcessSpec = { argv: [process.execPath, "-e", "0"], cwd: process.cwd(), env: { MARKER: "exact" },
      owner: { sessionId: "owner" }, transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" }
    const settlement = { kind: "settled" as const, root: { exitCode: 0 }, treeEmpty: true as const,
      ioSettled: true as const, resourcesReleased: true as const }
    const nativeHandle: TransportExecutionHandle = {
      receipt: { executionId: "native-id", backendId: "windows-unrestricted", policyFingerprint: "wrapper",
        owner: { sessionId: "owner" }, assurance: "unverified" },
      pid: 42, io: { output: { async *[Symbol.asyncIterator]() {} }, async write() {}, async endInput() {} },
      rootExited: Promise.resolve({ exitCode: 0 }), settled: Promise.resolve(settlement),
      async cancel() { return settlement }, async release() { return settlement },
    }
    let nativeSpec: ProcessSpec | undefined
    const native: TransportExecutionBackend = {
      async probe() { return { id: "windows-unrestricted", availability: "available", assurance: "unverified",
        features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: true, retainedTree: true } } },
      async prepare(input) { nativeSpec = input; return { policy: requested,
        async commit(fence) { fence(); return nativeHandle }, async rollback() {} } },
    }
    const provider: SandboxProvider = { confine(argv) { return { argv: [process.execPath, "runner", ...argv],
      enforcement: "partial", denialSignatures: ["denied"], runnerFailureRules: [
        { allowedExitCodes: [127], fatalSignatures: ["runner failed"] },
      ] } } }
    const legacy = createLegacyWindowsBackend(provider, native)
    const prepared = await legacy.prepare(spec, requested)
    const handle = await prepared.commit(() => {})
    expect(nativeSpec?.env).toEqual({ MARKER: "exact" })
    expect(nativeSpec?.argv).toEqual([process.execPath, "runner", process.execPath, "-e", "0"])
    expect(handle.receipt).toEqual({ executionId: "native-id", backendId: "windows-acl-legacy",
      policyFingerprint: requested.fingerprint, owner: { sessionId: "owner" }, assurance: "unverified" })
    expect(handle.runner?.runnerFailureRules[0]?.allowedExitCodes).toEqual([127])
    expect(await handle.release()).toBe(settlement)
    expect(handle.pid).toBe(42)
  })

  it("refuses unsupported legacy lifetime and transport before touching the ACL provider", async () => {
    const requested = compileExecutionPolicy({ mode: "read-only", owner: { sessionId: "owner" },
      authority: { kind: "unbound", revision: "r1", workspaceRoot: process.cwd() } })
    let confined = 0
    const provider: SandboxProvider = { confine() { confined++; throw new Error("unexpected confinement") } }
    const legacy = createLegacyWindowsBackend(provider, backend("native", []))
    const spec: ProcessSpec = { argv: [process.execPath], cwd: process.cwd(), env: {}, owner: { sessionId: "owner" },
      transport: "pipe", lifetime: "retain-tree", argumentEncoding: "crt" }
    await expect(legacy.prepare(spec, requested)).rejects.toThrow(/retain/)
    await expect(legacy.prepare({ ...spec, transport: "pty", lifetime: "complete-tree", pty: { cols: 80, rows: 24 } }, requested))
      .rejects.toThrow(/PTY/)
    await expect(legacy.prepare({ ...spec, lifetime: "complete-tree", argumentEncoding: "cmd-verbatim" }, requested))
      .rejects.toThrow(/argument encoding/)
    expect(confined).toBe(0)
  })

  it("retries native teardown before revoking legacy adapter resources", async () => {
    const events: string[] = []
    let attempts = 0
    const native = backend("native", events)
    native.dispose = async () => { attempts++; events.push(`native-${attempts}`); if (attempts === 1) throw new Error("still owned") }
    const legacy = { ...backend("legacy", events), async dispose() { events.push("legacy") } }
    const local = createLocalExecutionBackends({ platform: "win32", windowsSelection: "legacy",
      windowsPsecBackend: backend("psec", events), windowsUnrestrictedBackend: native, windowsLegacyBackend: legacy })
    await expect(local.dispose()).rejects.toThrow(/teardown incomplete/)
    expect(events).not.toContain("legacy")
    await local.dispose()
    expect(events).toContain("legacy")
  })

  it("keeps a failed legacy delegate reachable through composition dispose retry", async () => {
    let calls = 0
    const legacy = { ...backend("legacy", []), async dispose() {
      calls++
      if (calls === 1) throw new Error("ACL grant release incomplete")
    } }
    const local = createLocalExecutionBackends({ platform: "win32", windowsSelection: "legacy",
      windowsPsecBackend: backend("psec", []), windowsUnrestrictedBackend: backend("native", []),
      windowsLegacyBackend: legacy })
    await expect(local.dispose()).rejects.toThrow(/ACL grant release incomplete/)
    await expect(local.dispose()).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })
})
