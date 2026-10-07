import { resolve } from "node:path"
import { expect, expectTypeOf, it } from "vitest"
import { launchExecution } from "@i-harness/exec"
import { createExecutionLease } from "@i-harness/sandbox"
import { assertExecutionAuthority, compileExecutionPolicy } from "@i-harness/sandbox-policy"
import type {
  AuthorityState, BackendProbe, BackendRequirements, CompiledSandboxPolicy,
  ExecutionBackend, ExecutionHandle, ExecutionReceipt, ExecutionSettlement,
  ExecutionTransport, PreparedExecution, ProcessSpec, RootExit,
} from "@i-harness/sandbox"

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0))

// Only the process boundary is fake. Policy compilation, negotiation, admission
// and resource ownership all use their exported production implementations.
function fixture(transport: ExecutionTransport = "pipe") {
  const events: string[] = []
  const primaryRoot = resolve("contract-primary")
  const secondaryRoot = resolve("contract-secondary")
  let authority: AuthorityState = {
    kind: "bound", revision: "revision-1", primaryRoot,
    roots: [primaryRoot, secondaryRoot], references: [resolve("contract-reference")],
  }
  const owner = Object.freeze({ sessionId: "consumer", parentSessionId: "parent" })
  const policy = compileExecutionPolicy({ mode: "workspace-write", owner, authority })
  const spec: ProcessSpec = Object.freeze({
    argv: Object.freeze(["fake-workload", "an exact argument"]), cwd: primaryRoot,
    env: Object.freeze({ CONTRACT: "unchanged" }), owner, transport,
    lifetime: "retain-tree", argumentEncoding: "crt",
    ...(transport === "pty" ? { pty: Object.freeze({ cols: 80, rows: 24 }) } : {}),
  })
  const requirements: BackendRequirements = {
    writeIsolation: true, readIsolation: false, denyPaths: false,
    transport, lifetime: "retain-tree", minimumAssurance: "unverified",
  }
  const probe: BackendProbe = {
    id: "fake-boundary", availability: "available", assurance: "unverified",
    features: {
      writeIsolation: true, readIsolation: false, denyPaths: false,
      pipes: true, pty: true, retainedTree: true,
    },
  }
  const root = deferred<RootExit>()
  const tree = deferred<void>()
  const io = deferred<void>()
  const resources = deferred<void>()
  const receipt: ExecutionReceipt = {
    executionId: "execution-1", backendId: "fake-boundary",
    policyFingerprint: policy.fingerprint, owner, assurance: "unverified",
  }
  let handle: ExecutionHandle | undefined
  const prepared: PreparedExecution = {
    policy,
    async commit(validateAuthority) {
      events.push("commit")
      validateAuthority()
      events.push("workload")
      handle = createExecutionLease({
        receipt, rootExited: root.promise,
        waitTreeEmpty: () => { events.push("tree"); return tree.promise },
        settleIo: () => { events.push("io"); return io.promise },
        releaseResources: () => { events.push("release"); return resources.promise },
        terminate: async reason => { events.push(`terminate:${reason}`) },
      })
      return handle
    },
    async rollback() { events.push("rollback") },
  }
  const controller = new AbortController()
  const backend: ExecutionBackend = {
    async probe() { events.push("probe"); return probe },
    async prepare(actualSpec, actualPolicy, signal) {
      events.push("prepare")
      expect(actualSpec).toBe(spec)
      expect(actualPolicy).toBe(policy)
      expect(signal).toBe(controller.signal)
      return prepared
    },
  }
  const input = {
    backend, spec, policy, requirements, signal: controller.signal,
    validateAuthority(actualPolicy: CompiledSandboxPolicy) {
      events.push("authority")
      expect(actualPolicy).toBe(policy)
      assertExecutionAuthority(actualPolicy, compileExecutionPolicy({ mode: "workspace-write", owner, authority }))
    },
  }
  return {
    input, backend, prepared, controller, probe, events, root, tree, io, resources,
    get handle() { return handle },
    setAuthority(next: AuthorityState) { authority = next },
    changedRevision() { authority = { ...authority, revision: "revision-2" } },
    removeSecondaryRoot() { authority = { kind: "bound", revision: "revision-1", primaryRoot, roots: [primaryRoot], references: [resolve("contract-reference")] } },
  }
}

it.each(["pipe", "pty"] as const)("admits %s through public contracts and returns the exact owned handle", async transport => {
  const f = fixture(transport)
  expectTypeOf<typeof launchExecution>().returns.toEqualTypeOf<Promise<ExecutionHandle>>()
  expectTypeOf(f.input.spec.transport).toEqualTypeOf<ExecutionTransport>()
  expectTypeOf<ExecutionReceipt["policyFingerprint"]>().toEqualTypeOf<string>()
  const handle = await launchExecution(f.input)
  expect(handle).toBe(f.handle)
  expect(handle.receipt).toEqual({
    executionId: "execution-1", backendId: "fake-boundary",
    policyFingerprint: f.input.policy.fingerprint,
    owner: { sessionId: "consumer", parentSessionId: "parent" }, assurance: "unverified",
  })
  expect(f.events.slice(0, 7)).toEqual(["authority", "probe", "prepare", "authority", "commit", "authority", "workload"])
  expect(Object.isFrozen(f.input.policy)).toBe(true)
  expect(Object.isFrozen(f.input.spec)).toBe(true)
  f.root.resolve({ exitCode: 0 }); f.tree.resolve(); f.io.resolve(); f.resources.resolve()
  expect((await handle.settled).kind).toBe("settled")
})

it("pre-abort refuses before authority, probe or preparation", async () => {
  const f = fixture()
  f.controller.abort("caller cancelled")
  await expect(launchExecution(f.input)).rejects.toMatchObject({ name: "AbortError" })
  expect(f.events).toEqual([])
})

it("revoked authority refuses before probe or preparation", async () => {
  const f = fixture()
  f.setAuthority({ kind: "revoked", revision: "revision-2", reason: "removed project" })
  await expect(launchExecution(f.input)).rejects.toThrow(/authority revoked/)
  expect(f.events).toEqual(["authority"])
})

it.each(["availability", "writeIsolation", "pty", "retainedTree", "assurance"] as const)("capability refusal for %s never prepares", async missing => {
  const f = fixture("pty")
  if (missing === "availability") f.probe.availability = "unavailable"
  else if (missing === "assurance") f.input.requirements.minimumAssurance = "verified"
  else f.probe.features = { ...f.probe.features, [missing]: false }
  const labels = { availability: "availability", writeIsolation: "write-isolation", pty: "pty", retainedTree: "retained-tree", assurance: "assurance" }
  await expect(launchExecution(f.input)).rejects.toMatchObject({ name: "ExecutionAdmissionError", missing: [labels[missing]] })
  expect(f.events).toEqual(["authority", "probe"])
})

it("abort during probe refuses before preparation", async () => {
  const f = fixture()
  f.backend.probe = async () => { f.events.push("probe"); f.controller.abort(); return f.probe }
  await expect(launchExecution(f.input)).rejects.toMatchObject({ name: "AbortError" })
  expect(f.events).toEqual(["authority", "probe"])
})

it.each(["revision", "removed root", "revoked", "abort"])("%s during asynchronous preparation rolls back without commit", async change => {
  const f = fixture()
  const preparation = deferred<PreparedExecution>()
  f.backend.prepare = () => { f.events.push("prepare"); return preparation.promise }
  const launched = launchExecution(f.input)
  const failure = expect(launched).rejects.toThrow(change === "abort" ? /aborted/ : /authority/i)
  await turn()
  if (change === "revision") f.changedRevision()
  else if (change === "removed root") f.removeSecondaryRoot()
  else if (change === "revoked") f.setAuthority({ kind: "revoked", revision: "revision-1", reason: "removed project" })
  else f.controller.abort()
  preparation.resolve(f.prepared)
  await failure
  expect(f.events).toEqual(change === "abort"
    ? ["authority", "probe", "prepare", "rollback"]
    : ["authority", "probe", "prepare", "authority", "rollback"])
})

it.each(["authority", "abort"])("commit fence rechecks %s before the fake workload", async change => {
  const f = fixture()
  f.prepared.commit = async validate => {
    f.events.push("commit")
    await turn()
    if (change === "authority") f.changedRevision()
    else f.controller.abort()
    validate()
    f.events.push("workload")
    throw new Error("unreachable workload")
  }
  await expect(launchExecution(f.input)).rejects.toThrow(change === "abort" ? /aborted/ : /authority/i)
  expect(f.events).not.toContain("workload")
  expect(f.events.at(-1)).toBe("rollback")
})

it.each(["probe", "prepare"] as const)("%s failure preserves its cause without assuming unreturned resources", async phase => {
  const f = fixture()
  const cause = new Error(`${phase} failed`)
  if (phase === "probe") f.backend.probe = async () => { throw cause }
  else f.backend.prepare = async () => { throw cause }
  await expect(launchExecution(f.input)).rejects.toBe(cause)
  expect(f.events).not.toContain("rollback")
  expect(f.events).not.toContain("commit")
})

it("commit failure waits for the owned preparation rollback before rejection", async () => {
  const f = fixture()
  const cause = new Error("commit failed")
  const cleanup = deferred<void>()
  f.prepared.commit = async () => { f.events.push("commit"); throw cause }
  f.prepared.rollback = () => { f.events.push("rollback"); return cleanup.promise }
  let rejected = false
  const failure = launchExecution(f.input).catch(error => { rejected = true; throw error })
  const assertion = expect(failure).rejects.toBe(cause)
  await turn()
  expect(f.events.at(-1)).toBe("rollback")
  expect(rejected).toBe(false)
  cleanup.resolve()
  await assertion
})

it.each(["commit", "authority", "abort"])("%s refusal and rollback failure preserve both original causes", async phase => {
  const f = fixture()
  const cause = new Error("original failure")
  const rollback = new Error("rollback failed")
  let prepared = false
  if (phase === "authority") f.input.validateAuthority = () => { if (prepared) throw cause }
  if (phase === "commit") f.prepared.commit = async () => { throw cause }
  else f.backend.prepare = async () => {
    if (phase === "authority") prepared = true
    else f.controller.abort()
    return f.prepared
  }
  f.prepared.rollback = async () => { f.events.push("rollback"); throw rollback }
  const failure = await launchExecution(f.input).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  const errors = (failure as AggregateError).errors as unknown[]
  expect(errors).toHaveLength(2)
  if (phase === "abort") expect(errors[0]).toMatchObject({ name: "AbortError" })
  else expect(errors[0]).toBe(cause)
  expect(errors[1]).toBe(rollback)
  expect(f.events.filter(event => event === "rollback")).toHaveLength(1)
})

it("presentation promotion retains one handle and cancellation awaits tree, I/O and resources", async () => {
  const f = fixture()
  const handle = await launchExecution(f.input)
  const foreground = { handle, presentation: "foreground" }
  const background = { ...foreground, presentation: "background" }
  expect(background.handle).toBe(handle)
  let cancellation: ExecutionSettlement | undefined
  const cancelled = background.handle.cancel("cancelled")
  void cancelled.then(value => { cancellation = value })
  f.root.resolve({ exitCode: 9 })
  await turn()
  expect(await handle.rootExited).toEqual({ exitCode: 9 })
  expect(cancellation).toBeUndefined()
  expect(f.events).toContain("terminate:cancelled")
  expect(f.events).not.toContain("io")
  f.tree.resolve()
  await turn()
  expect(f.events.at(-1)).toBe("io")
  expect(cancellation).toBeUndefined()
  f.io.resolve()
  await turn()
  expect(f.events.at(-1)).toBe("release")
  expect(cancellation).toBeUndefined()
  f.resources.resolve()
  expect(await cancelled).toEqual({
    kind: "settled", root: { exitCode: 9 },
    treeEmpty: true, ioSettled: true, resourcesReleased: true,
  })
  expect(f.events.filter(event => event === "workload")).toHaveLength(1)
  expect(f.events.filter(event => event === "release")).toHaveLength(1)
})
