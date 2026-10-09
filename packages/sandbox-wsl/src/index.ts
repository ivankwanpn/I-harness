import { execFile } from "node:child_process"
import { randomBytes, randomUUID, createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import type { BackendProbe, CompiledSandboxPolicy, PreparedTransportExecution, ProcessSpec, TransportExecutionBackend, TransportExecutionHandle } from "@i-harness/sandbox"
import { captureRequest, decodeWslInventory, validDistribution } from "./admission.ts"
import { MAX_LINE_BYTES } from "./protocol.ts"
import { WorkerClient, WSL_EXE, deferred } from "./transport.ts"

const BACKEND_ID = "wsl2-bubblewrap-experimental"
const FEATURES = Object.freeze({ writeIsolation: true, readIsolation: false, denyPaths: false, referenceProtection: true, pipes: true, pty: false, retainedTree: false })
export interface WslExecutionOptions {
  distribution: string
  networkAccess?: boolean
  /** Captured absolute Linux bin directories supplied by the trusted runtime manager. */
  runtimePath?: readonly string[]
}
export interface WslDiagnostics {
  launcherStderr: string
  discardedLauncherStderrBytes: number
  outputAbandoned: boolean
  discardedOutputBytes: number
  preparationStage?: "preparing" | "validating"
  inventoryEntries?: number
  inventoryDirectories?: number
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
  if (!(await listWslDistributions()).some(row => row.name === distribution && row.version === 2)) throw new Error("Requested exact WSL2 distribution is unavailable")
}
export interface WslDistribution { name: string; version: number; state: string }
export interface WslDependencyStatus { available: boolean; path?: string; detail?: string }
export interface WslRuntimeInfo {
  distribution: string
  available: boolean
  detail: string
  dependencies: Record<"python" | "bash" | "bubblewrap" | "node" | "npm" | "socat" | "git", WslDependencyStatus>
  paths: readonly { windows: string; linux: string }[]
}
export async function listWslDistributions(): Promise<WslDistribution[]> {
  if (process.platform !== "win32") throw new Error("WSL backend requires Windows")
  const inventory = await new Promise<Buffer>((resolve, reject) => {
    execFile(WSL_EXE, ["--list", "--verbose"], { encoding: "buffer", windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024 },
      (error, stdout) => { if (error) reject(new Error("WSL inventory unavailable")); else resolve(stdout) })
  })
  return decodeWslInventory(inventory)
}

// Diagnostics execute fixed Python without startup profiles or caller env. Only
// local path inputs are passed; versions/tools are not executed during discovery.
const INSPECT = `import base64,json,os,shutil,subprocess,sys
p=json.loads(base64.b64decode(sys.argv[1],validate=True))
tools={'python':'python3','bash':'/bin/bash','bubblewrap':'bwrap','node':'node','npm':'npm','socat':'socat','git':'git'}
d={}
for key,tool in tools.items():
 path=shutil.which(tool,path='/usr/bin:/bin');d[key]={'available':bool(path),**({'path':path} if path else {'detail':'Not present on the system runtime PATH'})}
paths=[]
for path in p:
 result=subprocess.run(['/usr/bin/wslpath','-u',path],env={'PATH':'/usr/bin:/bin','LANG':'C'},capture_output=True,check=True,timeout=5)
 mapped=result.stdout.decode().strip()
 if not mapped.startswith('/') or '\\0' in mapped: raise ValueError()
 paths.append({'windows':path,'linux':os.path.realpath(mapped)})
print(json.dumps({'dependencies':d,'paths':paths},separators=(',',':')))`
export async function inspectWslRuntime(distribution: string, paths: readonly string[] = []): Promise<WslRuntimeInfo> {
  if (!validDistribution(distribution)) throw new Error("Invalid WSL distribution name")
  const capturedPaths = [...paths]
  if (capturedPaths.length > 64 || capturedPaths.some(path => typeof path !== "string" || !/^[A-Za-z]:[\\/]/.test(path)
    || /[\x00-\x1f<>"|?*]/.test(path) || path.split(/[\\/]/).some(part => part === "." || part === ".."))) throw new Error("Invalid WSL diagnostic paths")
  const missing = (): WslRuntimeInfo["dependencies"] => Object.fromEntries(["python", "bash", "bubblewrap", "node", "npm", "socat", "git"].map(key => [key, { available: false, detail: "Runtime not inspected" }])) as WslRuntimeInfo["dependencies"]
  const result: WslRuntimeInfo = { distribution, available: false, detail: "Requested exact WSL2 distribution is unavailable", dependencies: missing(), paths: [] }
  try {
    await verifyDistribution(distribution)
    const payload = Buffer.from(JSON.stringify(capturedPaths)).toString("base64")
    const output = await new Promise<Buffer>((resolve, reject) => {
      execFile(WSL_EXE, ["--distribution", distribution, "--exec", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C", "/usr/bin/python3", "-I", "-B", "-c", INSPECT, payload],
        { encoding: "buffer", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
          if (error) reject(new Error("WSL Python runtime inspection unavailable; install system Python3, Bash and bubblewrap manually"))
          else resolve(stdout)
        })
    })
    const response = JSON.parse(output.toString("utf8")) as Pick<WslRuntimeInfo, "dependencies" | "paths">
    for (const key of Object.keys(result.dependencies) as (keyof WslRuntimeInfo["dependencies"])[]) {
      const value = response.dependencies?.[key]
      if (!value || typeof value.available !== "boolean" || (value.path !== undefined && (typeof value.path !== "string" || !value.path.startsWith("/")))) throw new Error("Invalid WSL runtime inspection")
      result.dependencies[key] = { available: value.available, ...(value.path ? { path: value.path } : {}), ...(value.detail ? { detail: value.detail } : {}) }
    }
    if (!Array.isArray(response.paths) || response.paths.length !== capturedPaths.length
      || response.paths.some((entry, i) => entry.windows !== capturedPaths[i] || typeof entry.linux !== "string" || !entry.linux.startsWith("/") || /[\x00-\x1f]/.test(entry.linux))) throw new Error("Invalid WSL path inspection")
    result.paths = response.paths
    const missingRequired = (["python", "bash", "bubblewrap"] as const).filter(key => !result.dependencies[key].available)
    if (missingRequired.length) {
      result.detail = `Missing required WSL runtime dependencies: ${missingRequired.join(", ")}; install them manually in the selected distribution`
      return result
    }
    const backend = createWslExecutionBackend({ distribution })
    try {
      const probe = await backend.probe()
      result.available = probe.availability === "available"
      result.detail = probe.detail ?? "WSL isolation inspection completed"
    } finally { await backend.dispose() }
  } catch (cause) { result.detail = cause instanceof Error ? cause.message : "WSL runtime inspection unavailable" }
  return result
}

function captureWorker(): Buffer {
  const source = new URL("../worker/runner.py", import.meta.url)
  const packaged = process.env.I_HARNESS_DIST === "1" || !existsSync(source)
  const worker = packaged ? new URL("./wsl-assets/runner.py", import.meta.url) : source
  const manifest = packaged ? new URL("./wsl-assets/manifest.json", import.meta.url) : new URL("../worker/manifest.json", import.meta.url)
  const bytes = readFileSync(worker)
  if (packaged || existsSync(manifest)) {
    try {
      const value = JSON.parse(readFileSync(manifest).toString("utf8")) as Record<string, unknown>
      if (Object.keys(value).sort().join(",") !== "protocol,schema,sha256,worker" || value.schema !== 1 || value.protocol !== 1 || value.worker !== "runner.py"
        || value.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error()
    } catch { throw new Error("WSL worker manifest is missing, incompatible or does not match the packaged worker") }
  }
  return bytes
}

/** Explicit experimental construction; this package does not register a default backend. */
export function createWslExecutionBackend(options: WslExecutionOptions): WslExecutionBackend {
  const distribution = options.distribution
  if (!validDistribution(distribution)) throw new Error("Invalid WSL distribution name")
  if (options.networkAccess !== undefined && typeof options.networkAccess !== "boolean") throw new Error("Invalid WSL network configuration")
  const runtimePath = Object.freeze([...(options.runtimePath ?? [])])
  if (runtimePath.length > 16 || runtimePath.some(path => typeof path !== "string" || !/^\/(?!\/)/.test(path) || /[:\x00-\x1f]/.test(path) || path.split("/").some(part => part === "." || part === ".."))) throw new Error("Invalid WSL runtime PATH")
  const configuration = Object.freeze({ networkAccess: options.networkAccess ?? false, runtimePath })
  // Capture exactly once. Only immutable strings derived from these owned bytes survive construction.
  const captured = captureWorker()
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
      const fingerprint = await client.prepare(capturedRequest.spec, capturedRequest.policy, configuration)
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
