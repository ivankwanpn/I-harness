import { expect, it, vi } from "vitest"
import type { createWindowsUnrestrictedBackend } from "@i-harness/sandbox-windows-psec"

type Backend = ReturnType<typeof createWindowsUnrestrictedBackend>
type Handle = Awaited<ReturnType<Awaited<ReturnType<Backend["prepare"]>>["commit"]>>

const state = vi.hoisted(() => ({ backend: undefined as unknown }))
vi.mock("@i-harness/sandbox-windows-psec", () => ({ createWindowsUnrestrictedBackend: () => state.backend }))
import { runWindowsHook } from "../src/windows-process.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it.each(["reported", "unavailable"] as const)("requests owned release on an incomplete settlement with %s root status before waiting on I/O, and reports it only after cleanup acknowledgment", async rootStatus => {
  const releaseRequested = deferred<void>(), nativeReleased = deferred<void>()
  const rootObservation = deferred<{ exitCode: number }>()
  if (rootStatus === "reported") rootObservation.resolve({ exitCode: 0 })
  const incomplete = { kind: "incomplete" as const, phase: "io" as const, detail: "missing output-end frame" }
  // The output/input remain pending until explicit native release. A known
  // incomplete attempt does not itself confirm resource release or end I/O.
  const handle: Handle = {
    receipt: { executionId: "hook-io-failure", backendId: "windows-unrestricted", policyFingerprint: "test", owner: { sessionId: "test" }, assurance: "unverified" },
    pid: 1234, rootExited: rootObservation.promise, settled: Promise.resolve(incomplete),
    io: {
      output: (async function* () { await nativeReleased.promise; throw new Error("missing output-end frame") })(),
      write: async () => { await nativeReleased.promise; throw new Error("helper released before pending response") },
      endInput: async () => {}, signal: async () => {},
    },
    cancel: async () => incomplete,
    release: async () => { releaseRequested.resolve(); await nativeReleased.promise; return incomplete },
  }
  state.backend = { prepare: async () => ({ commit: async () => handle, rollback: async () => {} }),
    dispose: async () => { await nativeReleased.promise } }
  const result = runWindowsHook({ id: "incomplete-io", argv: [process.execPath], cwd: process.cwd(), env: {}, input: new Uint8Array([1]), timeoutMs: 3000, validate() {} })
    .then(value => value, error => error as Error)
  try {
    const requested = await Promise.race([releaseRequested.promise.then(() => "requested"), new Promise(resolve => setTimeout(() => resolve("stalled before release"), 100))])
    expect(requested).toBe("requested")
    const beforeAcknowledgment = await Promise.race([result.then(() => "finished"), new Promise(resolve => setTimeout(() => resolve("owned"), 20))])
    expect(beforeAcknowledgment).toBe("owned")
    nativeReleased.resolve()
    expect(await result).toMatchObject({ message: expect.stringContaining("cleanup incomplete: missing output-end frame") })
  } finally {
    rootObservation.resolve({ exitCode: 0 })
    nativeReleased.resolve()
    await result
  }
})
