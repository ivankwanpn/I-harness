import { expect, it } from "vitest"
import { createExecutionLease } from "@i-harness/sandbox"
import type { ExecutionReceipt, ExecutionSettlement, RootExit, StopReason } from "@i-harness/sandbox"

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function fixture(overrides: Partial<{
  waitTreeEmpty(): Promise<void>
  settleIo(): Promise<void>
  releaseResources(): Promise<void>
  terminate(reason: StopReason): Promise<void>
}> = {}) {
  const root = deferred<RootExit>()
  const tree = deferred<void>()
  const io = deferred<void>()
  const resources = deferred<void>()
  const termination = deferred<void>()
  const events: string[] = []
  const receipt: ExecutionReceipt = {
    executionId: "execution-1", backendId: "fake", policyFingerprint: "policy-1",
    owner: { sessionId: "session-1", parentSessionId: "parent-1" }, assurance: "unverified",
  }
  const lease = createExecutionLease({
    receipt, rootExited: root.promise,
    waitTreeEmpty: () => { events.push("tree"); return overrides.waitTreeEmpty?.() ?? tree.promise },
    settleIo: () => { events.push("io"); return overrides.settleIo?.() ?? io.promise },
    releaseResources: () => { events.push("release"); return overrides.releaseResources?.() ?? resources.promise },
    terminate: reason => { events.push(`terminate:${reason}`); return overrides.terminate?.(reason) ?? termination.promise },
  })
  return { lease, root, tree, io, resources, termination, events, receipt }
}

function finish(f: ReturnType<typeof fixture>) {
  f.root.resolve({ exitCode: 0 })
  f.tree.resolve()
  f.io.resolve()
  f.resources.resolve()
}

it("root exit alone leaves settlement pending until tree, I/O and release finish in order", async () => {
  const f = fixture()
  let result: ExecutionSettlement | undefined
  void f.lease.settled.then(value => { result = value })
  f.root.resolve({ exitCode: 7, signal: "SIGTERM" })
  expect(await f.lease.rootExited).toEqual({ exitCode: 7, signal: "SIGTERM" })
  await turn()
  expect(result).toBeUndefined()
  expect(f.events).toEqual(["tree"])
  f.tree.resolve()
  await turn()
  expect(f.events).toEqual(["tree", "io"])
  expect(result).toBeUndefined()
  f.io.resolve()
  await turn()
  expect(f.events).toEqual(["tree", "io", "release"])
  expect(result).toBeUndefined()
  f.resources.resolve()
  expect(await f.lease.settled).toEqual({
    kind: "settled", root: { exitCode: 7, signal: "SIGTERM" },
    treeEmpty: true, ioSettled: true, resourcesReleased: true,
  })
})

it("concurrent cancel and release share one pending cleanup and first successful stop reason", async () => {
  const f = fixture()
  const original = f.lease.settled
  const cancelled = f.lease.cancel("timeout")
  expect(f.lease.cancel("shutdown")).toBe(cancelled)
  expect(f.lease.release()).toBe(cancelled)
  expect(cancelled).toBe(original)
  f.termination.resolve()
  finish(f)
  expect((await cancelled).kind).toBe("settled")
  expect(f.events).toEqual(["terminate:timeout", "tree", "io", "release"])
  expect(f.lease.cancel("cancelled")).toBe(cancelled)
  expect(f.lease.release()).toBe(cancelled)
  expect(f.events).toEqual(["terminate:timeout", "tree", "io", "release"])
})

it("release already waiting on the tree admits cancellation into its active attempt", async () => {
  const f = fixture()
  const release = f.lease.release()
  await turn()
  expect(f.lease.cancel("authority-revoked")).toBe(release)
  finish(f)
  await turn()
  expect(f.events).not.toContain("release")
  f.termination.resolve()
  expect((await release).kind).toBe("settled")
  expect(f.events).toEqual(["tree", "terminate:authority-revoked", "io", "release"])
})

it("a termination hook that reenters cancel still invokes termination only once", async () => {
  let kills = 0
  let joined: Promise<ExecutionSettlement> | undefined
  const f = fixture({ terminate: () => {
    if (++kills === 1) joined = f.lease.cancel("shutdown")
    return Promise.resolve()
  } })
  const cancelled = f.lease.cancel("timeout")
  finish(f)
  expect((await cancelled).kind).toBe("settled")
  expect(joined).toBe(cancelled)
  expect(f.events).toEqual(["terminate:timeout", "tree", "io", "release"])
})

it("a naturally settled lease never invokes termination", async () => {
  const f = fixture()
  finish(f)
  const settled = f.lease.settled
  expect((await settled).kind).toBe("settled")
  expect(f.lease.cancel("shutdown")).toBe(settled)
  expect(f.events).toEqual(["tree", "io", "release"])
})

it("cancel after tree emptiness during I/O shares cleanup without killing an empty tree", async () => {
  const f = fixture()
  f.root.resolve({ exitCode: 0 })
  f.tree.resolve()
  await turn()
  const attempt = f.lease.settled
  expect(f.lease.cancel("shutdown")).toBe(attempt)
  f.io.resolve()
  f.resources.resolve()
  expect((await attempt).kind).toBe("settled")
  expect(f.events).toEqual(["tree", "io", "release"])
})

it("tree failure retains resources and an explicit retry replaces only the current promise", async () => {
  let calls = 0
  const nextTree = deferred<void>()
  const f = fixture({ waitTreeEmpty: () => ++calls === 1 ? Promise.reject(new Error("tree unknown")) : nextTree.promise })
  f.root.resolve({ exitCode: 0 })
  const historical = f.lease.settled
  expect(await historical).toEqual({ kind: "incomplete", phase: "tree", detail: expect.stringContaining("tree unknown") })
  expect(f.events).toEqual(["tree"])
  expect(f.lease.settled).toBe(historical)
  const retry = f.lease.release()
  expect(retry).not.toBe(historical)
  expect(f.lease.settled).toBe(retry)
  expect(f.lease.release()).toBe(retry)
  nextTree.resolve()
  f.io.resolve()
  f.resources.resolve()
  expect((await retry).kind).toBe("settled")
  expect((await historical).kind).toBe("incomplete")
  expect(f.events).toEqual(["tree", "tree", "io", "release"])
})

it("I/O failure retains resources and retry reuses confirmed tree emptiness", async () => {
  let calls = 0
  const f = fixture({ settleIo: () => ++calls === 1 ? Promise.reject(new Error("drain failed")) : Promise.resolve() })
  finish(f)
  expect(await f.lease.settled).toEqual({ kind: "incomplete", phase: "io", detail: expect.stringContaining("drain failed") })
  expect(f.events).toEqual(["tree", "io"])
  expect((await f.lease.release()).kind).toBe("settled")
  expect(f.events).toEqual(["tree", "io", "io", "release"])
})

it("resource release failure is incomplete/release and retries only unconfirmed release", async () => {
  let calls = 0
  const f = fixture({ releaseResources: () => ++calls === 1 ? Promise.reject(new Error("close failed")) : Promise.resolve() })
  finish(f)
  expect(await f.lease.settled).toEqual({ kind: "incomplete", phase: "release", detail: expect.stringContaining("close failed") })
  expect((await f.lease.release()).kind).toBe("settled")
  expect(f.events).toEqual(["tree", "io", "release", "release"])
})

it("termination failure checks tree and I/O but reports its cause and retains resources", async () => {
  const f = fixture()
  const cancelled = f.lease.cancel("timeout")
  f.termination.reject(new Error("kill failed"))
  finish(f)
  expect(await cancelled).toEqual({ kind: "incomplete", phase: "tree", detail: expect.stringContaining("kill failed") })
  expect(f.events).toEqual(["terminate:timeout", "tree", "io"])
  const recovered = f.lease.release()
  expect(recovered).not.toBe(cancelled)
  expect((await recovered).kind).toBe("settled")
  expect(f.events).toEqual(["terminate:timeout", "tree", "io", "release"])
})

it("failed termination can be retried by cancel and concurrent callers share the retry", async () => {
  let kills = 0
  const retryKill = deferred<void>()
  const f = fixture({ terminate: () => ++kills === 1 ? Promise.reject(new Error("first kill failed")) : retryKill.promise })
  const first = f.lease.cancel("timeout")
  finish(f)
  expect((await first).kind).toBe("incomplete")
  const retry = f.lease.cancel("authority-revoked")
  expect(f.lease.cancel("shutdown")).toBe(retry)
  expect(f.lease.release()).toBe(retry)
  await turn()
  expect(f.events).not.toContain("release")
  retryKill.resolve()
  expect((await retry).kind).toBe("settled")
  expect(f.events).toEqual(["terminate:timeout", "tree", "io", "terminate:authority-revoked", "release"])
})

it("successful termination is not repeated after an incomplete tree observation", async () => {
  let treeCalls = 0
  const f = fixture({ waitTreeEmpty: () => ++treeCalls === 1 ? Promise.reject(new Error("tree uncertain")) : Promise.resolve() })
  const first = f.lease.cancel("output-limit")
  f.termination.resolve()
  finish(f)
  expect((await first).kind).toBe("incomplete")
  expect((await f.lease.cancel("shutdown")).kind).toBe("settled")
  expect(f.events).toEqual(["terminate:output-limit", "tree", "tree", "io", "release"])
})

it.each(["tree", "io", "release", "terminate"] as const)("synchronous %s hook failures become incomplete outcomes", async phase => {
  const fail = () => { throw new Error(`${phase} sync failure`) }
  const f = fixture({
    ...(phase === "tree" ? { waitTreeEmpty: fail } : {}),
    ...(phase === "io" ? { settleIo: fail } : {}),
    ...(phase === "release" ? { releaseResources: fail } : {}),
    ...(phase === "terminate" ? { terminate: fail } : {}),
  })
  const result = phase === "terminate" ? f.lease.cancel("cancelled") : f.lease.settled
  finish(f)
  expect(await result).toEqual({ kind: "incomplete", phase: phase === "terminate" ? "tree" : phase, detail: expect.stringContaining(`${phase} sync failure`) })
})

it("early rejected termination is handled while tree emptiness is still pending", async () => {
  const unhandled: unknown[] = []
  const observe = (cause: unknown) => { unhandled.push(cause) }
  process.on("unhandledRejection", observe)
  try {
    const f = fixture({ terminate: () => Promise.reject(new Error("early kill failure")) })
    const result = f.lease.cancel("timeout")
    await turn()
    await turn()
    expect(unhandled).toEqual([])
    expect(f.events).toEqual(["terminate:timeout", "tree"])
    finish(f)
    expect(await result).toEqual({ kind: "incomplete", phase: "tree", detail: expect.stringContaining("early kill failure") })
  } finally { process.off("unhandledRejection", observe) }
})

it("early root rejection is handled, reported, and never releases resources", async () => {
  const unhandled: unknown[] = []
  const observe = (cause: unknown) => { unhandled.push(cause) }
  process.on("unhandledRejection", observe)
  try {
    const f = fixture()
    f.root.reject(new Error("root status lost"))
    await turn()
    await turn()
    expect(unhandled).toEqual([])
    f.tree.resolve()
    f.io.resolve()
    f.resources.resolve()
    expect(await f.lease.settled).toEqual({ kind: "incomplete", phase: "tree", detail: expect.stringContaining("root status lost") })
    expect(f.events).toEqual(["tree", "io"])
    expect((await f.lease.release()).kind).toBe("incomplete")
    expect(f.events).not.toContain("release")
  } finally { process.off("unhandledRejection", observe) }
})

it("receipt and owner are copied and frozen so caller mutations cannot transfer ownership", async () => {
  const f = fixture()
  expect(f.lease.receipt).not.toBe(f.receipt)
  expect(f.lease.receipt.owner).not.toBe(f.receipt.owner)
  f.receipt.executionId = "forged"
  ;(f.receipt.owner as { sessionId: string }).sessionId = "other-session"
  expect(() => { f.lease.receipt.executionId = "forged" }).toThrow(TypeError)
  expect(() => { (f.lease.receipt.owner as { sessionId: string }).sessionId = "other-session" }).toThrow(TypeError)
  expect(f.lease.receipt).toEqual({
    executionId: "execution-1", backendId: "fake", policyFingerprint: "policy-1",
    owner: { sessionId: "session-1", parentSessionId: "parent-1" }, assurance: "unverified",
  })
  expect(() => { (f.lease as unknown as { settled: Promise<ExecutionSettlement> }).settled = Promise.resolve({ kind: "incomplete", phase: "tree", detail: "forged" }) }).toThrow(TypeError)
  finish(f)
  expect((await f.lease.settled).kind).toBe("settled")
})
