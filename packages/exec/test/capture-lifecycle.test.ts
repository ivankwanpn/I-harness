import { fstatSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { expect, it, vi } from "vitest"
import { createExecutionLease, type ExecutionOutput, type TransportExecutionBackend } from "@i-harness/sandbox"
import { compileExecutionPolicy } from "@i-harness/sandbox-policy"
import { createExecService } from "../src/service.ts"
import { retainedOutputReader } from "../src/retained-output.ts"
import { createExecutionSupervisor } from "../src/execution-supervisor.ts"

const opened = vi.hoisted(() => [] as number[])
const closeFailure = vi.hoisted(() => ({ cause: undefined as Error | undefined, descriptors: [] as number[] }))
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>()
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => { const fd = fs.openSync(...args); opened.push(fd); return fd },
    closeSync: (fd: number) => { fs.closeSync(fd); closeFailure.descriptors.push(fd); if (closeFailure.cause) throw closeFailure.cause } }
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function fixture(options: { output: AsyncIterable<ExecutionOutput>; inputError?: unknown; incomplete?: boolean; heldCancel?: boolean; spill?: boolean }) {
  const root = deferred<{ exitCode: number }>(), cancelled = deferred<void>(), releaseCancel = deferred<void>()
  const drained = deferred<void>()
  let commits = 0, releases = 0
  const backend: TransportExecutionBackend = {
    async probe() { return { id: "capture-fixture", availability: "available", assurance: "unverified", features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) { return { policy, rollback: async () => {}, async commit(validate) {
      validate(); commits++
      const lease = createExecutionLease({ receipt: { executionId: "capture-1", backendId: "capture-fixture", policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: "unverified" },
        rootExited: root.promise, waitTreeEmpty: async () => { await root.promise; if (options.incomplete) throw new Error("tree incomplete") },
        settleIo: () => drained.promise, releaseResources: async () => { releases++ }, terminate: async () => {
          cancelled.resolve(); if (options.heldCancel) await releaseCancel.promise; root.resolve({ exitCode: 0 })
        } })
      return { pid: 43211, receipt: lease.receipt, rootExited: lease.rootExited, get settled() { return lease.settled }, cancel: lease.cancel, release: lease.release,
        io: { output: (async function* () { try { yield* options.output } finally { drained.resolve() } })(),
          write: async () => { if (options.inputError) throw options.inputError }, endInput: async () => {} } }
    } } },
  }
  const spillRoot = mkdtempSync(join(tmpdir(), "sandbox-redesign-capture-"))
  const exec = createExecService({ spill: options.spill ? { maxOutputBytes: 16, maxSpillBytes: 1024, spillRoot } : undefined,
    execution: { defaultOwner: { sessionId: "capture-owner" }, selectBackend: () => backend,
      resolvePolicy: owner => compileExecutionPolicy({ mode: "danger-full-access", owner, authority: { kind: "unbound", revision: "capture-test", workspaceRoot: resolve(".") } }), validateAuthority: () => {} } })
  return { exec, root, cancelled, releaseCancel, spillRoot, counts: () => ({ commits, releases }) }
}
it("keeps one bounded collector and all spill bytes before and across promotion", async () => {
  const more = deferred<void>(), finish = deferred<void>()
  const f = fixture({ spill: true, output: (async function* () {
    yield { channel: "stdout", data: Buffer.from("a".repeat(64)) }
    await more.promise
    yield { channel: "stdout", data: Buffer.from("b".repeat(64)) }
    await finish.promise
  })() })
  const promoted = await f.exec.run({ argv: ["fixture"] }, { backgroundAfterMs: 20 })
  expect(promoted).toHaveProperty("jobId")
  if (!("jobId" in promoted)) throw new Error("not promoted")
  try {
    const before = f.exec.getOutput(promoted.jobId)
    expect(Buffer.byteLength(before.stdout)).toBeLessThanOrEqual(16)
    expect(readFileSync(join(f.spillRoot, readdirSync(f.spillRoot)[0]!), "utf8")).toBe("a".repeat(64))
    more.resolve()
    await vi.waitFor(() => expect(f.exec.getOutput(promoted.jobId).stdout).toBe("b".repeat(16)))
    finish.resolve(); f.root.resolve({ exitCode: 0 })
    await vi.waitFor(() => expect(f.exec.getOutput(promoted.jobId).status).toBe("completed"))
    expect(f.counts()).toEqual({ commits: 1, releases: 1 })
    expect(readFileSync(join(f.spillRoot, readdirSync(f.spillRoot)[0]!), "utf8")).toBe("a".repeat(64) + "b".repeat(64))
    expect(f.exec.getOutput(promoted.jobId).stdout).toBe("b".repeat(16))
    const final = f.exec.getOutput(promoted.jobId)
    expect(final.stdoutSpillPath).toBe(before.stdoutSpillPath)
    expect(final.truncated).toEqual({ stdout: true, stderr: false })
    expect(await retainedOutputReader(final)!({ maxBytes: 1024, signal: new AbortController().signal })).toMatchObject({
      complete: true, text: "stdout:\n" + "a".repeat(64) + "b".repeat(64) + "\nstderr:\n",
    })
  } finally { more.resolve(); finish.resolve(); f.root.resolve({ exitCode: 0 }); await f.exec.dispose() }
})
it("preserves execution and both independent close failures while closing both descriptors", async () => {
  const primary = new Error("output primary"), cleanup = new Error("close cleanup")
  const f = fixture({ spill: true, output: (async function* () {
    yield { channel: "stdout", data: Buffer.alloc(64, 97) }
    yield { channel: "stderr", data: Buffer.alloc(64, 98) }
    throw primary
  })() })
  const start = opened.length
  closeFailure.cause = cleanup
  try {
    const result = await f.exec.run({ argv: ["fixture"] }).catch(error => error)
    expect(result).toBeInstanceOf(AggregateError)
    expect(result.errors).toEqual([primary, cleanup, cleanup])
    expect(opened.slice(start)).toHaveLength(2)
    for (const fd of opened.slice(start)) {
      expect(closeFailure.descriptors).toContain(fd)
      expect(() => fstatSync(fd)).toThrow(/EBADF/)
    }
  } finally { closeFailure.cause = undefined; await f.exec.dispose() }
})
it.each([undefined, { opaque: "observer" }, new Error("observer")])("joins cancellation and rejects the exact observer throw %s", async cause => {
  const f = fixture({ heldCancel: true, output: (async function* () { yield { channel: "stdout", data: Buffer.from("callback") } })() })
  let done = false
  const outcome = f.exec.run({ argv: ["fixture"] }, { stream: { maxBytes: 100, onStdout() { throw cause } } }).then(
    value => ({ ok: true as const, value }), error => ({ ok: false as const, error }),
  ).finally(() => { done = true })
  await f.cancelled.promise
  expect(done).toBe(false); expect(f.counts().releases).toBe(0)
  f.releaseCancel.resolve()
  const result = await outcome
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toBe(cause)
  expect(f.counts().releases).toBe(1)
  await f.exec.dispose()
})
it("closes the output iterator on frame-processing failure before native IO settlement", async () => {
  let closed = false
  const f = fixture({ output: (async function* () {
    try { yield { channel: "pty", data: Buffer.from("invalid pipe frame") } }
    finally { closed = true }
  })() })
  await expect(f.exec.run({ argv: ["fixture"] })).rejects.toThrow("Pipe backend returned a PTY output frame")
  expect(closed).toBe(true)
  expect(f.counts().releases).toBe(1)
  await f.exec.dispose()
})
it.each(["incomplete", "output", "input"])("closes real spill descriptors when %s fails after output", async failure => {
  const outputError = new Error("output failure"), inputError = new Error("input failure")
  const pushed = deferred<void>()
  const f = fixture({ spill: true, incomplete: failure === "incomplete", inputError: failure === "input" ? inputError : undefined,
    output: (async function* () {
      yield { channel: "stdout", data: Buffer.from("x".repeat(64)) }
      yield { channel: "stderr", data: Buffer.from("y".repeat(64)) }
      pushed.resolve()
      if (failure === "output") throw outputError
    })() })
  const start = opened.length
  const outcome = f.exec.run({ argv: ["fixture"], input: "input" }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
  await pushed.promise; f.root.resolve({ exitCode: 0 })
  const result = await outcome
  expect(result.ok).toBe(false)
  if (!result.ok) {
    if (failure === "incomplete") expect(String(result.error)).toContain("tree incomplete")
    else expect(result.error).toBe(failure === "output" ? outputError : inputError)
  }
  const descriptors = opened.slice(start)
  expect(descriptors).toHaveLength(2)
  for (const fd of descriptors) expect(() => fstatSync(fd)).toThrow(/EBADF/)
  await f.exec.dispose().catch(() => {})
})

it.each(["incomplete", "opaque rejection", "queued iterator return", "opaque rejection and close failures"])("stops capture and closes spills before native EOF after %s, retaining the owner for retry", async mode => {
  const supervisor = createExecutionSupervisor()
  const nativeEof = deferred<void>(), pushed = deferred<void>()
  const failed = deferred<import("@i-harness/sandbox").ExecutionSettlement>()
  const incomplete = { kind: "incomplete" as const, phase: "tree" as const, detail: "tree still owned" }
  const cancellationError = { opaque: "cancel failure" }
  const collectorError = new Error("collector close failure")
  let cancelCalls = 0, returnCalls = 0, reads = 0, nativeClosed = false, recovered = false
  const backend: TransportExecutionBackend = {
    async probe() { return { id: "open-capture", availability: "available", assurance: "unverified", features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) { return { policy, rollback: async () => {}, async commit(validate) {
      validate()
      const receipt = { executionId: "open-capture-1", backendId: "open-capture", policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: "unverified" as const }
      const cancel = async () => {
        cancelCalls++
        if (!recovered) { if (mode.startsWith("opaque rejection")) throw cancellationError; return incomplete }
        await nativeEof.promise
        return { kind: "settled" as const, root: { exitCode: 0 }, treeEmpty: true as const, ioSettled: true as const, resourcesReleased: true as const }
      }
      const output: AsyncIterable<ExecutionOutput> = { [Symbol.asyncIterator]() { return {
          async next() {
            reads++
            if (reads <= 2) return { done: false as const, value: { channel: reads === 1 ? "stdout" as const : "stderr" as const, data: Buffer.alloc(64, 120) } }
            pushed.resolve()
            await nativeEof.promise
            return { done: true as const, value: undefined }
          },
          async return() { returnCalls++; return { done: true as const, value: undefined } },
        } } }
      return { pid: 43212, receipt, rootExited: Promise.resolve({ exitCode: 0 }), settled: failed.promise, cancel, release: cancel,
        io: { output: mode === "queued iterator return" ? (async function* () { yield* output })() : output,
          write: async () => {}, endInput: async () => {} } }
    } } },
  }
  const spillRoot = mkdtempSync(join(tmpdir(), "sandbox-redesign-open-capture-"))
  const exec = createExecService({ spill: { maxOutputBytes: 16, spillRoot }, execution: {
    supervisor, defaultOwner: { sessionId: "open-owner" }, selectBackend: () => backend,
    resolvePolicy: owner => compileExecutionPolicy({ mode: "danger-full-access", owner, authority: { kind: "unbound", revision: "open", workspaceRoot: resolve(".") } }), validateAuthority: () => {},
  } })
  const start = opened.length
  const outcome = exec.run({ argv: ["fixture"] }).then(value => ({ kind: "success", value }), error => ({ kind: "failure", error }))
  try {
    await pushed.promise
    if (mode.endsWith("close failures")) closeFailure.cause = collectorError
    if (mode.startsWith("opaque rejection")) failed.reject(undefined)
    else failed.resolve(incomplete)
    const result = await Promise.race([outcome, new Promise<{ kind: "pending" }>(resolve => setTimeout(() => resolve({ kind: "pending" }), 150))])
    expect(result.kind).toBe("failure")
    expect(cancelCalls).toBe(1)
    expect(returnCalls).toBe(mode === "queued iterator return" ? 0 : 1)
    expect(nativeClosed).toBe(false)
    expect(supervisor.list()).toHaveLength(1)
    const descriptors = opened.slice(start)
    expect(descriptors).toHaveLength(2)
    for (const fd of descriptors) expect(() => fstatSync(fd)).toThrow(/EBADF/)
    if (result.kind === "failure" && "error" in result) {
      if (mode.startsWith("opaque rejection")) expect(result.error.errors).toEqual(mode.endsWith("close failures")
        ? [undefined, collectorError, collectorError, cancellationError] : [undefined, cancellationError])
      else expect(String(result.error)).toContain("tree still owned")
    }
    recovered = true
    const retry = supervisor.cancel(supervisor.list()[0]!.id, "cancelled")
    expect(supervisor.list()).toHaveLength(1)
    nativeClosed = true; nativeEof.resolve()
    expect(await retry).toMatchObject({ kind: "settled", treeEmpty: true, ioSettled: true, resourcesReleased: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(reads).toBe(3)
    expect(supervisor.list()).toHaveLength(0)
  } finally { closeFailure.cause = undefined; recovered = true; nativeEof.resolve(); await outcome; await exec.dispose() }
})
