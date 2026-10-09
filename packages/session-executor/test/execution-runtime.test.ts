import { expect, it, vi } from "vitest"
import { resolve } from "node:path"
import { createExecService } from "@i-harness/exec"
import { createExecutionLease, type AuthorityState, type TransportExecutionBackend, type RootExit } from "@i-harness/sandbox"
const injected = vi.hoisted(() => ({ backend: undefined as unknown as TransportExecutionBackend, releases: 0, options: [] as any[], specs: [] as any[] }))
vi.mock("@i-harness/sandbox-local", () => ({ createLocalExecutionBackends: (options: any) => { injected.options.push(options); return { select: (_policy: any, _transport: any, spec: any) => { injected.specs.push(spec); return injected.backend }, async dispose() { injected.releases++ } } }, readWindowsQualification: async () => undefined }))
import { createAssemblyExecutionRuntime } from "../src/execution-runtime.ts"

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const turn = () => new Promise(resolve => setTimeout(resolve, 0))

it("captures WSL options for the assembly and forwards the trusted target spec", async () => {
  const options = { distribution: "Ubuntu", networkAccess: false, workspaceDependencies: true }
  const runtime = createAssemblyExecutionRuntime({ owner: { sessionId: "main" }, windowsSandboxBackend: "wsl", wslExecution: options,
    authority: () => ({ kind: "unbound", revision: "1", workspaceRoot: process.cwd() }), standing: () => ({ mode: "workspace-write", generation: "1" }) })
  options.distribution = "changed"; options.networkAccess = true
  expect(injected.options.at(-1)).toMatchObject({ windowsSelection: "wsl", wslExecution: { distribution: "Ubuntu", networkAccess: false } })
  const spec = { executionTarget: "wsl" } as any
  runtime.execution.selectBackend(runtime.execution.resolvePolicy({ sessionId: "main" }, undefined), "pipe", spec)
  expect(injected.specs.at(-1)).toBe(spec)
  await runtime.execution.dispose!()
})

it.each(["pending", "failed"] as const)("keeps filesystem admission fenced when older compatible reconciliation succeeds while newer narrowing is %s", async phase => {
  const a = resolve("a"), b = resolve("b")
  let authority: AuthorityState = { kind: "bound", revision: "1", primaryRoot: a, roots: [a, b], references: [] }
  const owner = { sessionId: "main" }
  const runtime = createAssemblyExecutionRuntime({ owner, authority: () => authority, standing: () => ({ mode: "workspace-write", generation: authority.revision }) })
  const admitted = runtime.execution.resolvePolicy(owner, undefined)
  const older = gate<void>(), narrowing = gate<void>()
  const reconcile = vi.spyOn(runtime.execution.supervisor!, "reconcile")
    .mockImplementationOnce((_owner, validate) => { validate(admitted, { phase: "active" }); return older.promise })
    .mockImplementationOnce((_owner, validate) => {
      expect(() => validate(admitted, { phase: "active" })).toThrow(/narrowed/)
      return narrowing.promise.then(() => { throw new Error("controlled incomplete cleanup") })
    })
    .mockResolvedValueOnce(undefined)
  const first = runtime.reconcile()
  authority = { kind: "bound", revision: "2", primaryRoot: a, roots: [a], references: [] }
  const second = runtime.reconcile().then(() => undefined, error => error)
  let entered = false
  const write = () => runtime.trackWrite(() => {}, async () => { entered = true })
  if (phase === "pending") {
    older.resolve(); await first
    expect(write).toThrow(/admission blocked/)
  }
  narrowing.resolve()
  expect(await second).toMatchObject({ message: "controlled incomplete cleanup" })
  if (phase === "failed") { older.resolve(); await first }
  expect(write).toThrow(/admission blocked/)
  const grant = runtime.bindPolicy({ mode: "workspace-write", workspaceRoot: a })
  expect(() => runtime.validateGrant(grant.authoritySnapshot!, "workspace-write")).toThrow(/admission blocked/)
  expect(entered).toBe(false)
  await runtime.reconcile()
  await write()
  expect(entered).toBe(true)
  expect(reconcile).toHaveBeenCalledTimes(3)
  await runtime.execution.dispose!()
})

it.each(["unavailable", "disposed"] as const)("does not let reconciliation success reopen a %s owner", async state => {
  let available = true
  const runtime = createAssemblyExecutionRuntime({ owner: { sessionId: "main" }, ownerAvailable: () => available,
    authority: () => ({ kind: "unbound", revision: "1", workspaceRoot: process.cwd() }), standing: () => ({ mode: "workspace-write", generation: "1" }) })
  const pending = gate<void>()
  vi.spyOn(runtime.execution.supervisor!, "reconcile").mockReturnValueOnce(pending.promise)
  const reconciliation = runtime.reconcile()
  if (state === "disposed") await runtime.execution.dispose!()
  else available = false
  pending.resolve(); await reconciliation
  let entered = false
  const write = () => runtime.trackWrite(() => {}, async () => { entered = true })
  expect(write).toThrow(/blocked|disposed|unavailable/)
  expect(entered).toBe(false)
  if (state === "unavailable") {
    available = true
    expect(write).toThrow(/admission blocked/)
    await runtime.reconcile()
    await write()
    expect(entered).toBe(true)
    await runtime.execution.dispose!()
  }
})

it("keeps filesystem admission fenced until older pending reconciliation settles after current success", async () => {
  const owner = { sessionId: "main" }
  const runtime = createAssemblyExecutionRuntime({ owner, authority: () => ({ kind: "unbound", revision: "1", workspaceRoot: process.cwd() }), standing: () => ({ mode: "workspace-write", generation: "1" }) })
  const older = gate<void>(), current = gate<void>()
  vi.spyOn(runtime.execution.supervisor!, "reconcile").mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise)
  const first = runtime.reconcile(), second = runtime.reconcile()
  current.resolve(); await second
  let entered = false
  const write = () => runtime.trackWrite(() => {}, async () => { entered = true })
  expect(write).toThrow(/admission blocked/)
  expect(entered).toBe(false)
  older.resolve(); await first
  await write()
  expect(entered).toBe(true)
  await runtime.execution.dispose!()
})

it("selects the explicit Windows profile once and binds automatic promotion to its frozen policy", () => {
  vi.stubEnv("IH_WINDOWS_SANDBOX", "psec")
  try {
    const options = { owner: { sessionId: "main" }, authority: () => ({ kind: "unbound" as const, revision: "1", workspaceRoot: process.cwd() }), standing: () => ({ mode: "workspace-write" as const, generation: "1" }) }
    const native = createAssemblyExecutionRuntime(options)
    vi.stubEnv("IH_WINDOWS_SANDBOX", "invalid")
    const policy = native.execution.resolvePolicy(options.owner, undefined)
    expect(Object.isFrozen(policy)).toBe(true)
    expect(native.execution.autoPromotionLifetime!(policy)).toBe("retain-tree")
    expect(() => createAssemblyExecutionRuntime(options)).toThrow(/IH_WINDOWS_SANDBOX/)
    const legacy = createAssemblyExecutionRuntime({ ...options, windowsSandboxBackend: "legacy" })
    expect(legacy.execution.autoPromotionLifetime!(policy)).toBe(process.platform === "win32" ? "complete-tree" : "retain-tree")
    const full = legacy.execution.resolvePolicy(options.owner, { mode: "danger-full-access", workspaceRoot: process.cwd() })
    expect(legacy.execution.autoPromotionLifetime!(full)).toBe("retain-tree")
  } finally { vi.unstubAllEnvs() }
})

it.each(["prepare", "late-commit"] as const)("keeps captured base grant strict across deferred %s and waits for cleanup", async phase => {
  const paused = gate<void>(), entered = gate<void>(), cleanup = gate<void>(), root = gate<RootExit>()
  let rollbacks = 0, cancels = 0
  injected.backend = {
    async probe() { return { id: "controlled", availability: "available", assurance: "unverified", features: { writeIsolation: true, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) {
      if (phase === "prepare") { entered.resolve(); await paused.promise }
      return { policy,
        async rollback() { rollbacks++; await cleanup.promise },
        async commit(validate) {
          validate()
          if (phase === "late-commit") { entered.resolve(); await paused.promise }
          const lease = createExecutionLease({ receipt: { executionId: "controlled-1", backendId: "controlled", owner: spec.owner, policyFingerprint: policy.fingerprint, assurance: "unverified" },
            rootExited: root.promise, waitTreeEmpty: () => cleanup.promise, async settleIo() {}, async releaseResources() {},
            async terminate() { cancels++; root.resolve({ exitCode: 1 }); await cleanup.promise } })
          return { ...lease, pid: 42, io: { output: (async function* () {})(), async write() {}, async endInput() {} } }
        },
      }
    },
  }
  let generation = "1"
  const runtime = createAssemblyExecutionRuntime({ owner: { sessionId: "main" }, authority: () => ({ kind: "unbound", revision: "1", workspaceRoot: process.cwd() }),
    standing: () => ({ mode: "workspace-write", generation }) })
  const exec = createExecService({ execution: runtime.execution })
  // Granted full access must still capture the original workspace-write base generation.
  const launch = exec.run({ argv: ["controlled"], sandbox: { mode: "danger-full-access", workspaceRoot: process.cwd() } }).then(() => "accepted", () => "rejected")
  await entered.promise
  generation = "2"
  let acknowledged = false
  const reconcile = runtime.reconcile().then(() => { acknowledged = true })
  paused.resolve(); await turn()
  expect(acknowledged).toBe(false)
  cleanup.resolve()
  expect(await launch).toBe("rejected")
  await reconcile
  expect(phase === "prepare" ? rollbacks : cancels).toBeGreaterThan(0)
  await exec.dispose()
})

it("invalidates strict admission snapshots after a generation change", () => {
  let state: AuthorityState = { kind: "bound", revision: "1", primaryRoot: resolve("a"), roots: [resolve("a")], references: [] }
  let generation = "1"
  const runtime = createAssemblyExecutionRuntime({ owner: { sessionId: "main" }, authority: () => state, standing: () => ({ mode: "workspace-write", generation }) })
  const policy = runtime.execution.resolvePolicy({ sessionId: "main" }, undefined)
  state = { ...state, revision: "2", roots: [resolve("a"), resolve("b")] }
  generation = "2"
  expect(() => runtime.execution.validateAuthority(policy)).toThrow(/generation/)
})

it("does not refresh the base generation while a per-call approval awaits", () => {
  let generation = "1"
  const runtime = createAssemblyExecutionRuntime({ owner: { sessionId: "main" }, authority: () => ({ kind: "unbound", revision: "project-1", workspaceRoot: process.cwd() }),
    standing: () => ({ mode: "workspace-write", generation }) })
  const base = runtime.bindPolicy({ mode: "workspace-write", workspaceRoot: process.cwd() })
  generation = "2"
  const granted = { ...base, mode: "danger-full-access" as const }
  expect(() => runtime.execution.resolvePolicy({ sessionId: "main" }, granted)).toThrow(/base grant generation changed/)
})

it("rejects incomplete role cleanup, preserves a compatible owner, and explicitly retries without reopening the revoked caller", async () => {
  let next = 0, failed = false, roleA = true
  const cancelled: string[] = []
  injected.backend = {
    async probe() { return { id: "controlled", availability: "available", assurance: "unverified", features: { writeIsolation: true, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) {
      return { policy, async rollback() {}, async commit(validate) {
        validate()
        const root = gate<RootExit>(), done = gate<import("@i-harness/sandbox").ExecutionSettlement>()
        const cancel = async () => {
          cancelled.push(spec.owner.sessionId)
          if (spec.owner.sessionId === "a" && !failed) { failed = true; return { kind: "incomplete" as const, phase: "tree" as const, detail: "controlled cleanup failure" } }
          const result = { kind: "settled" as const, root: { exitCode: 1 }, treeEmpty: true as const, ioSettled: true as const, resourcesReleased: true as const }
          root.resolve(result.root); done.resolve(result); return result
        }
        return { receipt: { executionId: `controlled-${++next}`, backendId: "controlled", owner: spec.owner, policyFingerprint: policy.fingerprint, assurance: "unverified" as const },
          pid: next, rootExited: root.promise, settled: done.promise, cancel, release: cancel,
          io: { output: (async function* () { await done.promise })(), async write() {}, async endInput() {} } }
      } }
    },
  }
  const runtime = createAssemblyExecutionRuntime({ owner: { sessionId: "main" }, authority: () => ({ kind: "unbound", revision: "1", workspaceRoot: process.cwd() }), standing: () => ({ mode: "workspace-write", generation: "1" }) })
  const exec = createExecService({ execution: runtime.execution })
  await runtime.withCaller({ sessionId: "a", parentSessionId: "main" }, () => roleA, () => exec.runBackground({ argv: ["controlled"] }))
  const b = await runtime.withCaller({ sessionId: "b", parentSessionId: "main" }, () => true, () => exec.runBackground({ argv: ["controlled"] }))
  roleA = false
  await expect(runtime.reconcile()).rejects.toThrow(/cleanup failure/)
  expect(cancelled).toEqual(["a"])
  expect(exec.getOutput(b.jobId).status).toBe("running")
  expect(() => runtime.withCaller({ sessionId: "a", parentSessionId: "main" }, () => roleA, () => exec.runBackground({ argv: ["controlled"] }))).toThrow(/unavailable/)
  await runtime.reconcile()
  expect(cancelled).toEqual(["a", "a"])
  expect(exec.getOutput(b.jobId).status).toBe("running")
  await exec.dispose()
})
