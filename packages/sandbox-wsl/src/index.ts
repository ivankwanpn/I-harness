import { execFile } from "node:child_process"
import { randomBytes, randomUUID, createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { BackendProbe, CompiledSandboxPolicy, PreparedTransportExecution, ProcessSpec, TransportExecutionBackend, TransportExecutionHandle } from "@i-harness/sandbox"
import { captureRequest, parseWslInventory, validDistribution } from "./admission.ts"
import { MAX_LINE_BYTES } from "./protocol.ts"
import { WorkerClient, WSL_EXE, deferred } from "./transport.ts"

const BACKEND_ID = "wsl2-bubblewrap-experimental"
const FEATURES = Object.freeze({ writeIsolation: true, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: false })
export interface WslDiagnostics {
  launcherStderr: string
  discardedLauncherStderrBytes: number
  outputAbandoned: boolean
  discardedOutputBytes: number
}
export interface WslExecutionBackend extends TransportExecutionBackend {
  dispose(): Promise<void>
  /** Bounded launcher diagnostics are separate from command stderr. */
  diagnostics(): readonly WslDiagnostics[]
}
interface Entry {
  client?: WorkerClient
  handle?: TransportExecutionHandle
  stopped: boolean
  completion: ReturnType<typeof deferred<void>>
}
async function verifyDistribution(distribution: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("Experimental WSL backend requires Windows")
  const inventory = await new Promise<Buffer>((resolve, reject) => {
    execFile(WSL_EXE, ["--list", "--verbose"], { encoding: "buffer", windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024 },
      (error, stdout) => { if (error) reject(new Error("WSL inventory unavailable")); else resolve(stdout) })
  })
  if (!parseWslInventory(inventory, distribution)) throw new Error("Requested exact WSL2 distribution is unavailable")
}

/** Explicit experimental construction; this package does not register a default backend. */
export function createWslExecutionBackend(options: { distribution: string }): WslExecutionBackend {
  const distribution = options.distribution
  if (!validDistribution(distribution)) throw new Error("Invalid WSL distribution name")
  // Capture exactly once. Only immutable strings derived from these owned bytes survive construction.
  const captured = readFileSync(new URL("../worker/runner.py", import.meta.url))
  const source = captured.toString("base64")
  const digest = createHash("sha256").update(captured).digest("hex")
  const envelope = (nonce: string) => JSON.stringify({ v: 1, nonce, source, sha256: digest }) + "\n"
  if (Buffer.byteLength(envelope("0".repeat(64))) > MAX_LINE_BYTES) throw new Error("Captured WSL worker exceeds bootstrap line limit")
  const entries = new Set<Entry>()
  const history: WslDiagnostics[] = []
  let disposed = false
  let disposing: Promise<void> | undefined

  function remember(entry: Entry): void {
    if (entry.client) {
      history.push(Object.freeze(entry.client.diagnostics()))
      if (history.length > 32) history.shift()
    }
  }
  function reserve(): Entry {
    if (disposed) throw new Error("WSL backend disposed")
    const entry: Entry = { stopped: false, completion: deferred<void>() }
    entries.add(entry)
    return entry
  }
  function check(entry: Entry): void {
    if (disposed) throw new Error("WSL backend disposed")
    if (entry.stopped) throw new Error("WSL execution admission aborted")
  }
  async function open(entry: Entry): Promise<WorkerClient> {
    await verifyDistribution(distribution)
    check(entry)
    const nonce = randomBytes(32).toString("hex")
    const client = new WorkerClient(distribution, nonce, envelope(nonce), digest)
    entry.client = client
    void client.completion().then(() => {
      remember(entry); entries.delete(entry); entry.completion.resolve()
    }, cause => { remember(entry); entry.completion.reject(cause) })
    await client.ready()
    check(entry)
    return client
  }
  async function stop(entry: Entry): Promise<void> {
    entry.stopped = true
    if (entry.client) await entry.client.shutdown()
    await entry.completion.promise
  }
  async function failedPreparation(entry: Entry, cause: unknown): Promise<never> {
    if (!entry.client) { entries.delete(entry); entry.completion.resolve(); throw cause }
    try { await stop(entry) }
    catch (cleanup) { throw new AggregateError([cause, cleanup], "WSL admission failed; cleanup incomplete") }
    throw cause
  }

  async function prepare(spec: ProcessSpec, policy: CompiledSandboxPolicy, signal?: AbortSignal): Promise<PreparedTransportExecution> {
    if (disposed) throw new Error("WSL backend disposed")
    const capturedRequest = captureRequest(spec, policy)
    if (signal?.aborted) throw new Error("WSL execution admission aborted")
    const entry = reserve()
    const onAbort = () => {
      entry.stopped = true
      entry.client?.interrupt()
      if (entry.client) void entry.client.shutdown().catch(() => {})
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    // Keep the abort listener through prepared and active ownership, until launcher closure.
    void entry.completion.promise.finally(() => signal?.removeEventListener("abort", onAbort)).catch(() => {})
    try {
      const client = await open(entry)
      const fingerprint = await client.prepare(capturedRequest.spec, capturedRequest.policy)
      check(entry)
      if (fingerprint !== capturedRequest.policy.fingerprint) throw new Error("WSL prepared policy fingerprint mismatch")
      let committed = false
      return Object.freeze({ policy: capturedRequest.policy,
        async commit(validateAuthority: () => void): Promise<TransportExecutionHandle> {
          if (committed) throw new Error("WSL preparation already committed")
          try {
            check(entry)
            const handle = await client.commit({ executionId: randomUUID(), backendId: BACKEND_ID,
              policyFingerprint: capturedRequest.policy.fingerprint, owner: capturedRequest.spec.owner, assurance: "experimental" }, () => {
              check(entry); validateAuthority(); check(entry)
            })
            committed = true; entry.handle = handle
            if (entry.stopped || disposed) { await handle.cancel("cancelled"); throw new Error("WSL execution admission aborted") }
            return handle
          } catch (cause) { return failedPreparation(entry, cause) }
        },
        async rollback(): Promise<void> { await stop(entry) },
      })
    } catch (cause) { return failedPreparation(entry, cause) }
  }
  async function probe(): Promise<BackendProbe> {
    const result = (availability: BackendProbe["availability"], detail: string): BackendProbe => ({ id: BACKEND_ID, availability, assurance: "experimental", features: FEATURES, detail })
    if (disposed) return result("unavailable", "WSL backend disposed")
    const entry = reserve()
    try {
      const client = await open(entry)
      const response = await client.probe()
      await stop(entry)
      return result(response.available ? "available" : "unavailable", response.detail)
    } catch (cause) {
      try { await failedPreparation(entry, cause) } catch {}
      return result("unavailable", "WSL runtime or security profile unavailable")
    }
  }
  async function dispose(): Promise<void> {
    disposed = true
    disposing ??= (async () => {
      const outcomes = await Promise.allSettled([...entries].map(entry => stop(entry)))
      const failures = outcomes.filter((value): value is PromiseRejectedResult => value.status === "rejected")
      if (failures.length) throw new AggregateError(failures.map(value => value.reason), "WSL backend disposal incomplete")
    })()
    return disposing
  }
  return Object.freeze({ probe, prepare, dispose,
    diagnostics: () => Object.freeze([...history, ...[...entries].filter(entry => entry.client).map(entry => Object.freeze(entry.client!.diagnostics()))]),
  })
}
