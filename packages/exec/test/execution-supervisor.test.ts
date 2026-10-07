import { resolve } from "node:path"
import { expect, it } from "vitest"
import * as exec from "@i-harness/exec"
import { createExecutionLease } from "@i-harness/sandbox"
import { compileExecutionPolicy } from "@i-harness/sandbox-policy"
import type {
  BackendProbe, BackendRequirements, CompiledSandboxPolicy,
  PreparedTransportExecution, ProcessSpec, RootExit, TransportExecutionBackend,
  TransportExecutionHandle,
} from "@i-harness/sandbox"

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0))

// Only native process operations are replaced. Admission, policy snapshots and
// lease cleanup use the public production packages.
function fixture(id = "run-1", sessionId = "owner", transport: "pipe" | "pty" = "pipe") {
  const events: string[] = []
  const root = deferred<RootExit>()
  const tree = deferred<void>()
  const io = deferred<void>()
  const resources = deferred<void>()
  const preparation = deferred<void>()
  const commit = deferred<void>()
  const rollback = deferred<void>()
  let holdPrepare = false
  let holdCommit = false
  let holdRollback = false
  let fenceBeforeWait = false
  let treeFailures = 0
  let rollbackFailures = 0
  let valid = true
  let handle: TransportExecutionHandle | undefined
  let actualSpec: ProcessSpec | undefined
  let actualSignal: AbortSignal | undefined
  const owner = { sessionId, parentSessionId: "parent" }
  const policy = compileExecutionPolicy({
    mode: "workspace-write", owner,
    authority: { kind: "unbound", revision: "r1", workspaceRoot: resolve("supervisor-workspace") },
  })
  const spec = {
    argv: ["workload", "exact argument"], cwd: resolve("supervisor-workspace"),
    env: { EXACT: "original" }, owner: { ...owner }, transport,
    lifetime: "retain-tree" as const, argumentEncoding: "cmd-verbatim" as const,
    ...(transport === "pty" ? { pty: { cols: 80, rows: 24 } } : {}),
  }
  const requirements: BackendRequirements = {
    writeIsolation: true, readIsolation: false, denyPaths: false,
    transport, lifetime: "retain-tree", minimumAssurance: "unverified",
  }
  const probe: BackendProbe = {
    id: "fake", availability: "available", assurance: "unverified",
    features: { writeIsolation: true, readIsolation: false, denyPaths: false, pipes: true, pty: true, retainedTree: true },
  }
  const receipt = { executionId: id, backendId: "fake", policyFingerprint: policy.fingerprint, owner: { ...owner }, assurance: "unverified" as const }
  const prepared: PreparedTransportExecution = {
    policy,
    async commit(validate) {
      events.push("commit")
      if (fenceBeforeWait) validate()
      if (holdCommit) await commit.promise
      if (!fenceBeforeWait) validate()
      events.push("workload")
      const lease = createExecutionLease({
        receipt, rootExited: root.promise,
        waitTreeEmpty: () => {
          events.push("tree")
          if (treeFailures-- > 0) return Promise.reject(new Error("tree unknown"))
          return tree.promise
        },
        settleIo: () => { events.push("io"); return io.promise },
        releaseResources: () => { events.push("release"); return resources.promise },
        terminate: async reason => { events.push(`terminate:${reason}`) },
      })
      handle = Object.freeze({
        receipt: lease.receipt, rootExited: lease.rootExited,
        get settled() { return lease.settled }, cancel: lease.cancel, release: lease.release,
        pid: 1234,
        io: { output: (async function* () {})(), async write() {}, async endInput() {} },
      })
      return handle
    },
    async rollback() {
      events.push("rollback")
      if (holdRollback) await rollback.promise
      if (rollbackFailures-- > 0) throw new Error("rollback failed")
    },
  }
  const backend: TransportExecutionBackend = {
    async probe() { events.push("probe"); return probe },
    async prepare(received, receivedPolicy, signal) {
      events.push("prepare")
      actualSpec = received; actualSignal = signal
      expect(receivedPolicy).toBe(policy)
      if (holdPrepare) await preparation.promise
      return prepared
    },
  }
  const controller = new AbortController()
  const input = {
    backend, spec, policy, requirements, signal: controller.signal,
    validateAuthority(received: CompiledSandboxPolicy) {
      expect(received).toBe(policy)
      if (!valid) throw new Error("authority revoked")
    },
  }
  return {
    input, events, root, tree, io, resources, preparation, commit, rollback, receipt, prepared, controller,
    get handle() { return handle }, get actualSpec() { return actualSpec }, get signal() { return actualSignal },
    holdPreparation() { holdPrepare = true }, holdCommit(late = false) { holdCommit = true; fenceBeforeWait = late },
    holdRollback() { holdRollback = true }, failTree() { treeFailures++ }, failRollback() { rollbackFailures++ },
    revoke() { valid = false },
    finish() { root.resolve({ exitCode: 0 }); tree.resolve(); io.resolve(); resources.resolve() },
  }
}

const supervisor = () => exec.createExecutionSupervisor()

it("detaches and freezes exact launch fields before asynchronous preparation", async () => {
  const s = supervisor()
  const f = fixture("snapshot", "owner", "pty")
  f.holdPreparation()
  const launched = s.launch(f.input)
  await turn()
  f.input.spec.argv[1] = "mutated"
  f.input.spec.env.EXACT = "mutated"
  f.input.spec.owner.sessionId = "other"
  f.input.spec.owner.parentSessionId = "other-parent"
  f.input.spec.pty!.cols = 2
  f.input.spec.pty!.rows = 3
  f.input.spec.cwd = resolve("other-root")
  Object.assign(f.input.spec, { transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" })
  f.preparation.resolve()
  const execution = await launched
  expect(f.actualSpec).toEqual({
    argv: ["workload", "exact argument"], cwd: resolve("supervisor-workspace"), env: { EXACT: "original" },
    owner: { sessionId: "owner", parentSessionId: "parent" }, transport: "pty", lifetime: "retain-tree",
    argumentEncoding: "cmd-verbatim", pty: { cols: 80, rows: 24 },
  })
  for (const value of [f.actualSpec, f.actualSpec!.argv, f.actualSpec!.env, f.actualSpec!.owner, f.actualSpec!.pty]) expect(Object.isFrozen(value)).toBe(true)
  expect(execution.handle).toBe(f.handle)
  f.finish(); await s.dispose()
})

it.each(["sessionId", "parentSessionId"] as const)("refuses mismatched spec %s before probing", async field => {
  const s = supervisor(); const f = fixture()
  f.input.spec.owner[field] = "wrong"
  await expect(s.launch(f.input)).rejects.toThrow(/owner|lineage/)
  expect(f.events).toEqual([])
  await s.dispose()
})

it("owns pipe and PTY through promotion, root exit, and complete settlement", async () => {
  const s = supervisor(); const pipe = fixture("pipe"); const pty = fixture("pty", "owner", "pty")
  const a = await s.launch(pipe.input); const b = await s.launch(pty.input)
  const background = { ...a }
  expect(background.handle).toBe(pipe.handle)
  expect(s.list().map(entry => entry.handle)).toEqual([pipe.handle, pty.handle])
  pipe.root.resolve({ exitCode: 7 }); await turn()
  expect(s.list()).toHaveLength(2)
  pipe.tree.resolve(); pipe.io.resolve(); pipe.resources.resolve()
  await a.handle.settled; await turn()
  expect(s.list()).toEqual([b])
  pty.finish(); await s.dispose()
  expect(s.list()).toEqual([])
  expect(pipe.events.filter(event => event === "workload")).toHaveLength(1)
})

it("registers preparation before the first await so immediate close prevents a workload", async () => {
  const s = supervisor(); const f = fixture()
  f.holdPreparation(); f.holdRollback()
  const launched = s.launch(f.input)
  const rejection = expect(launched).rejects.toThrow(/aborted|closed/)
  const closed = s.closeOwner("owner")
  f.preparation.resolve()
  f.rollback.resolve(); await rejection; await closed
  expect(f.events).not.toContain("workload")
  await expect(s.launch(f.input)).rejects.toThrow(/closed/)
})

it("reconcile during prepare aborts and waits for rollback without a workload", async () => {
  const s = supervisor(); const f = fixture()
  f.holdPreparation(); f.holdRollback()
  const launched = s.launch(f.input); const rejection = expect(launched).rejects.toThrow(/aborted|revoked/)
  await turn()
  const reconciled = s.reconcile("owner", () => { throw new Error("new revocation") })
  let acknowledged = false; void reconciled.then(() => { acknowledged = true })
  expect(f.signal?.aborted).toBe(true)
  f.preparation.resolve(); await turn()
  expect(f.events).toContain("rollback"); expect(acknowledged).toBe(false)
  expect(f.events).not.toContain("workload")
  f.rollback.resolve(); await rejection; await reconciled
  const next = fixture("next"); const execution = await s.launch(next.input)
  expect(execution.handle).toBe(next.handle)
  next.finish(); await s.dispose()
})

it("reconcile replaces the validator of a compatible pending preparation", async () => {
  const s = supervisor(); const f = fixture()
  f.holdPreparation()
  const launched = s.launch(f.input); await turn()
  f.revoke()
  let checks = 0
  await s.reconcile("owner", () => { checks++ })
  f.preparation.resolve()
  const entry = await launched
  expect(entry.handle).toBe(f.handle)
  expect(checks).toBeGreaterThanOrEqual(3)
  f.finish(); await s.dispose()
})

it("revocation during a pending commit prevents its final workload fence", async () => {
  const s = supervisor(); const f = fixture()
  f.holdCommit()
  const launched = s.launch(f.input); const failure = expect(launched).rejects.toThrow(/aborted|revoked/)
  await turn(); expect(f.events).toContain("commit")
  const reconciled = s.reconcile("owner", () => { throw new Error("revoked") })
  f.commit.resolve(); await failure; await reconciled
  expect(f.events).not.toContain("workload")
  expect(f.events).toContain("rollback")
  await s.dispose()
})

it("close owns a late successful commit and awaits tree, I/O and resources", async () => {
  const s = supervisor(); const f = fixture()
  f.holdCommit(true)
  const launched = s.launch(f.input); const failure = expect(launched).rejects.toThrow(/closed|aborted/)
  await turn()
  const closed = s.closeOwner("owner")
  expect(s.closeOwner("owner")).toBe(closed)
  let acknowledged = false; void closed.then(() => { acknowledged = true })
  f.commit.resolve(); await turn()
  expect(s.list()[0]?.handle).toBe(f.handle)
  expect(f.events).toContain("terminate:shutdown")
  f.root.resolve({ exitCode: 9 }); await turn(); expect(acknowledged).toBe(false)
  f.tree.resolve(); await turn(); expect(f.events.at(-1)).toBe("io"); expect(acknowledged).toBe(false)
  f.io.resolve(); await turn(); expect(f.events.at(-1)).toBe("release"); expect(acknowledged).toBe(false)
  f.resources.resolve(); await failure; await closed
  expect(s.list()).toEqual([])
})

it("reconcile drains invalid handles while compatible and unrelated owners continue", async () => {
  const s = supervisor(); const bad = fixture("bad"); const good = fixture("good"); const other = fixture("other", "unrelated")
  await s.launch(bad.input); const retained = await s.launch(good.input); await s.launch(other.input)
  const reconciled = s.reconcile("owner", policy => { if (policy === bad.input.policy) throw new Error("revoked") })
  let acknowledged = false; void reconciled.then(() => { acknowledged = true })
  await turn(); expect(acknowledged).toBe(false)
  expect(bad.events).toContain("terminate:authority-revoked")
  expect(good.events).not.toContain("terminate:authority-revoked")
  const another = fixture("another", "unrelated"); await s.launch(another.input)
  bad.finish(); await reconciled
  expect(s.list()).toContain(retained)
  good.finish(); other.finish(); another.finish(); await s.dispose()
})

it("caller cancellation keeps its reason and retains historical incomplete settlement until retry", async () => {
  const s = supervisor(); const f = fixture(); f.failTree()
  const execution = await s.launch(f.input)
  const historical = execution.handle.settled
  expect((await historical).kind).toBe("incomplete")
  expect(s.list()).toEqual([execution])
  const cancelled = s.cancel(execution.id, "output-limit")
  f.finish(); expect((await cancelled).kind).toBe("settled")
  expect((await historical).kind).toBe("incomplete")
  expect(f.events).toContain("terminate:output-limit")
  expect(s.list()).toEqual([])
})

it("linked caller abort cancels an active handle and preserves a recognized stop reason", async () => {
  const s = supervisor(); const f = fixture(); const execution = await s.launch(f.input)
  f.controller.abort("timeout"); await turn()
  expect(f.events).toContain("terminate:timeout")
  f.finish(); await execution.handle.settled; await turn()
  expect(s.list()).toEqual([])
})

it.each(["backendId", "policyFingerprint", "owner", "lineage"] as const)("mismatched receipt %s is owned and drained before launch rejects", async field => {
  const s = supervisor(); const f = fixture()
  if (field === "owner") f.receipt.owner.sessionId = "forged"
  else if (field === "lineage") f.receipt.owner.parentSessionId = "forged"
  else f.receipt[field] = "forged"
  const launched = s.launch(f.input); const failure = expect(launched).rejects.toThrow(/receipt/)
  await turn()
  expect(s.list()[0]?.handle).toBe(f.handle)
  expect(f.events).toContain("terminate:cancelled")
  f.finish(); await failure
  expect(s.list()).toEqual([])
})

it("duplicate execution IDs cannot replace a previously owned handle", async () => {
  const s = supervisor(); const first = fixture("duplicate"); const second = fixture("duplicate")
  const original = await s.launch(first.input)
  const launched = s.launch(second.input); const failure = expect(launched).rejects.toThrow(/duplicate/)
  await turn()
  expect(s.list().map(entry => entry.handle)).toEqual([first.handle, second.handle])
  expect(second.events).toContain("terminate:cancelled")
  second.finish(); await failure
  expect(s.list()).toEqual([original])
  first.finish(); await s.dispose()
})

it("failed close retains ownership, blocks admissions and shares a later cleanup retry", async () => {
  const s = supervisor(); const f = fixture(); f.failTree()
  const execution = await s.launch(f.input)
  await execution.handle.settled
  f.failTree()
  const closed = s.closeOwner("owner")
  expect(s.closeOwner("owner")).toBe(closed)
  await expect(closed).rejects.toThrow(/tree unknown/)
  expect(s.list()).toEqual([execution])
  await expect(s.launch(fixture("blocked").input)).rejects.toThrow(/closed/)
  const retry = s.closeOwner("owner")
  expect(retry).not.toBe(closed); expect(s.closeOwner("owner")).toBe(retry)
  f.finish(); await retry
  expect(s.list()).toEqual([])
  await expect(s.launch(fixture("still-blocked").input)).rejects.toThrow(/closed/)
})

it("failed rollback remains owned until close retry confirms cleanup", async () => {
  const s = supervisor(); const f = fixture(); f.holdPreparation(); f.failRollback()
  const launched = s.launch(f.input); const failure = expect(launched).rejects.toThrow(/rollback failed/)
  await turn(); const closed = s.closeOwner("owner")
  const closeFailure = expect(closed).rejects.toThrow(/rollback failed/)
  f.preparation.resolve(); await failure; await closeFailure
  await expect(s.launch(fixture("blocked").input)).rejects.toThrow(/closed/)
  await s.closeOwner("owner")
  expect(f.events.filter(event => event === "rollback")).toHaveLength(2)
  expect(f.events).not.toContain("workload")
})

it("failed reconcile stays blocked until successful retry and cannot reopen a closed owner", async () => {
  const s = supervisor(); const f = fixture(); f.failTree()
  const execution = await s.launch(f.input); await execution.handle.settled
  f.failTree()
  const invalid = () => { throw new Error("revoked") }
  await expect(s.reconcile("owner", invalid)).rejects.toThrow(/tree unknown/)
  await expect(s.launch(fixture("blocked").input)).rejects.toThrow(/blocked/)
  const retry = s.reconcile("owner", invalid)
  await expect(s.launch(fixture("retry-blocked").input)).rejects.toThrow(/blocked/)
  f.finish(); await retry
  const next = fixture("next"); await s.launch(next.input); next.finish()
  await s.closeOwner("owner")
  await expect(s.reconcile("owner", () => {})).resolves.toBeUndefined()
  await expect(s.launch(fixture("closed").input)).rejects.toThrow(/closed/)
})

it("dispose failure blocks all owners and retries retained lease ownership", async () => {
  const s = supervisor(); const f = fixture(); f.failTree()
  const execution = await s.launch(f.input); await execution.handle.settled
  f.failTree(); const disposed = s.dispose()
  expect(s.dispose()).toBe(disposed)
  await expect(disposed).rejects.toThrow(/tree unknown/)
  expect(s.list()).toEqual([execution])
  await expect(s.launch(fixture("new", "other").input)).rejects.toThrow(/disposed/)
  const retry = s.dispose(); expect(s.dispose()).toBe(retry)
  f.finish(); await retry
  expect(s.list()).toEqual([])
})

it("revocation owns a late committed handle until cancellation completely drains", async () => {
  const s = supervisor(); const f = fixture(); f.holdCommit(true)
  const launched = s.launch(f.input); const failure = expect(launched).rejects.toThrow(/aborted/)
  await turn()
  const reconciled = s.reconcile("owner", () => { throw new Error("project removed") })
  let acknowledged = false; void reconciled.then(() => { acknowledged = true })
  f.commit.resolve(); await turn()
  expect(s.list()[0]?.handle).toBe(f.handle)
  expect(f.events).toContain("terminate:authority-revoked")
  await expect(s.launch(fixture("blocked").input)).rejects.toThrow(/blocked/)
  f.root.resolve({ exitCode: null }); f.tree.resolve(); f.io.resolve(); await turn()
  expect(acknowledged).toBe(false)
  f.resources.resolve(); await failure; await reconciled
  expect(s.list()).toEqual([])
})

it("caller abort during commit preserves the actual abort cause after late handle cleanup", async () => {
  const s = supervisor(); const f = fixture(); f.holdCommit(true)
  const cause = new Error("caller stopped this exact request")
  const launched = s.launch(f.input)
  const failure = expect(launched).rejects.toMatchObject({ name: "AbortError", cause })
  await turn(); f.controller.abort(cause); f.commit.resolve(); await turn()
  expect(f.events).toContain("terminate:cancelled")
  expect(f.signal?.reason).toBe(cause)
  f.finish(); await failure
})

it("invalid receipt cleanup failure remains owned and disposal retries it", async () => {
  const s = supervisor(); const f = fixture(); f.receipt.backendId = "forged"; f.failTree()
  const launched = s.launch(f.input)
  const failure = await launched.catch((cause: unknown) => cause)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([
    expect.objectContaining({ message: expect.stringMatching(/receipt/) }),
    expect.objectContaining({ message: expect.stringMatching(/tree unknown/) }),
  ])
  expect(s.list()[0]?.handle).toBe(f.handle)
  f.finish(); await s.dispose()
  expect(s.list()).toEqual([])
})

it("disposal collects failures from every owner without releasing incomplete handles", async () => {
  const s = supervisor(); const a = fixture("a", "a"); const b = fixture("b", "b")
  a.failTree(); b.failTree()
  const first = await s.launch(a.input); const second = await s.launch(b.input)
  await Promise.all([first.handle.settled, second.handle.settled])
  a.failTree(); b.failTree()
  const failure = await s.dispose().catch((cause: unknown) => cause)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toHaveLength(2)
  expect(s.list().map(entry => entry.handle)).toEqual([a.handle, b.handle])
  expect(a.events).not.toContain("release"); expect(b.events).not.toContain("release")
  a.finish(); b.finish(); await s.dispose()
  expect(s.list()).toEqual([])
})

it("a preparation failure retains no unreturned resources and other owners remain usable", async () => {
  const s = supervisor(); const f = fixture()
  const cause = new Error("backend prepare failed")
  f.input.backend.prepare = async () => { throw cause }
  await expect(s.launch(f.input)).rejects.toBe(cause)
  await s.closeOwner("owner")
  const other = fixture("other", "other"); await s.launch(other.input)
  other.finish(); await s.dispose()
})

it.each(["transport", "lifetime"] as const)("refuses requirements that do not negotiate the actual spec %s before probe", async field => {
  const s = supervisor(); const f = fixture()
  if (field === "transport") f.input.requirements.transport = "pty"
  else f.input.requirements.lifetime = "complete-tree"
  await expect(s.launch(f.input)).rejects.toThrow(/requirements.*spec/)
  expect(f.events).toEqual([])
  await s.dispose()
})

it.each(["policy", "owner", "authorityRoots", "writeRoots", "referenceRoots"] as const)("refuses a mutable compiled %s before admission", async field => {
  const s = supervisor(); const f = fixture()
  const policy = f.input.policy
  const mutable = field === "policy" ? { ...policy }
    : Object.freeze({ ...policy, [field]: field === "owner" ? { ...policy.owner } : [...policy[field]] })
  f.input.backend.prepare = async () => f.prepared
  await expect(s.launch({ ...f.input, policy: mutable, validateAuthority() {} })).rejects.toThrow(/immutable/)
  expect(f.events).toEqual([])
  await s.dispose()
})

it("a caller validator that closes its owner at the native fence prevents the workload", async () => {
  const s = supervisor(); const f = fixture()
  let checks = 0
  let closed: Promise<void> | undefined
  f.input.validateAuthority = () => { if (++checks === 3) closed = s.closeOwner("owner") }
  const launched = s.launch(f.input)
  const outcome = launched.catch((cause: unknown) => cause)
  await turn()
  // Release any leaked fake workload so an assertion failure cannot hide an orphan.
  f.finish()
  const failure = await outcome
  await closed
  expect(f.events).not.toContain("workload")
  expect(failure).toBeInstanceOf(Error)
  expect(f.events).toContain("rollback")
})

it("immediately observes driver root and settlement rejection while retaining ownership", async () => {
  const s = supervisor(); const f = fixture()
  const unhandled: unknown[] = []
  const observe = (cause: unknown) => { unhandled.push(cause) }
  const commit = f.prepared.commit
  f.prepared.commit = async validate => {
    const handle = await commit(validate)
    return Object.freeze({
      ...handle, rootExited: Promise.reject(new Error("root observation lost")),
      settled: Promise.reject(new Error("driver settlement rejected")),
    })
  }
  process.on("unhandledRejection", observe)
  try {
    const execution = await s.launch(f.input)
    await turn(); await turn()
    expect(unhandled).toEqual([])
    expect(s.list()).toEqual([execution])
    f.finish(); await s.closeOwner("owner")
    expect(s.list()).toEqual([])
  } finally { process.off("unhandledRejection", observe) }
})

it("supervisor cancel returns the lease's current retry promise without replacing the handle", async () => {
  const s = supervisor(); const f = fixture(); f.failTree()
  const execution = await s.launch(f.input)
  const historical = execution.handle.settled
  await historical
  const retry = s.cancel(execution.id, "timeout")
  expect(retry).toBe(execution.handle.settled)
  expect(s.cancel(execution.id, "shutdown")).toBe(retry)
  expect(retry).not.toBe(historical)
  expect(s.list()[0]?.handle).toBe(f.handle)
  f.finish(); await retry
  expect((await historical).kind).toBe("incomplete")
  expect(f.events.filter(event => event.startsWith("terminate:"))).toEqual(["terminate:timeout"])
  expect(s.list()).toEqual([])
})
