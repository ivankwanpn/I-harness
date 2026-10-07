import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { sep } from "node:path"
import { promisify } from "node:util"
import { createExecutionLease } from "@i-harness/sandbox"
import type {
  BackendProbe, CompiledSandboxPolicy, ExecutionOutput, PreparedTransportExecution,
  ProcessSpec, RootExit, StopReason, TransportExecutionBackend, TransportExecutionHandle,
} from "@i-harness/sandbox"
import { verifyHelper, type HelperOptions } from "./integrity.ts"
import { FrameDecoder, StatusDecoder, type NativeError, type Status } from "./protocol.ts"

export interface WindowsExecutionOptions extends HelperOptions {
  /** Trusted host configuration, detached when the backend is created. */
  denyPaths?: readonly string[]
  /** Trusted legacy adapter only; hidden-console requires unrestricted pipe. */
  consoleMode?: "no-window" | "hidden-console"
}
type Engine = "psec" | "unrestricted"
const execFileAsync = promisify(execFile)
const backendId = (engine: Engine) => `windows-${engine}`
const maxBufferedOutput = 1024 * 1024

function fail(message: string): never { throw new Error(`Windows helper: ${message}`) }
function nativeDetail(error: NativeError): string {
  const causes = error.cleanup?.map(nativeDetail).join("; ")
  return `${error.code} at ${error.api}${error.nativeCode === null ? "" : ` (${error.nativeCode})`}: ${error.detail}`
    + (causes ? `; cleanup: ${causes}` : "")
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
function absoluteLocal(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) && !path.includes("\0") && !path.includes(":", 2)
}
async function canonical(path: string): Promise<string> {
  if (!absoluteLocal(path)) fail("path must be an absolute local drive path")
  return realpath(path)
}
function inside(path: string, root: string): boolean {
  const a = path.toLowerCase(), b = root.toLowerCase().replace(/[\\/]+$/, "")
  return a === b || a.startsWith(b + sep)
}
function copyOwner(owner: { sessionId: string; parentSessionId?: string }) {
  return owner.parentSessionId === undefined ? { sessionId: owner.sessionId }
    : { sessionId: owner.sessionId, parentSessionId: owner.parentSessionId }
}
async function preparePayload(
  engine: Engine, spec: ProcessSpec, policy: CompiledSandboxPolicy,
  options: Readonly<WindowsExecutionOptions>, helperPath: string, helperSha256: string,
) {
  if (engine === "psec" && policy.mode === "danger-full-access"
    || engine === "unrestricted" && policy.mode !== "danger-full-access") fail("policy mode unsupported by selected engine")
  if (engine === "psec" && spec.transport === "pty") fail("unsupported-transport: PSEC PTY is unqualified")
  if (options.consoleMode === "hidden-console" && (engine !== "unrestricted" || spec.transport !== "pipe")) {
    fail("hidden-console requires unrestricted pipe")
  }
  if (engine === "unrestricted" && (policy.referenceRoots.length || options.denyPaths?.length)) {
    fail("unrestricted cannot enforce mandatory reference or deny locks")
  }
  if (spec.owner.sessionId !== policy.owner.sessionId || spec.owner.parentSessionId !== policy.owner.parentSessionId) fail("owner mismatch")
  if (!spec.argv.length || spec.argv.some(value => typeof value !== "string" || value.includes("\0"))) fail("invalid argv")
  if (spec.transport === "pty" && (!spec.pty || !Number.isInteger(spec.pty.cols) || !Number.isInteger(spec.pty.rows)
    || spec.pty.cols < 1 || spec.pty.cols > 1000 || spec.pty.rows < 1 || spec.pty.rows > 1000)) fail("invalid PTY size")
  if (spec.argv.some((value, index) => index === 0 && !absoluteLocal(value))) fail("executable path must be absolute")
  const [executable, cwd, primaryRoot, ...roots] = await Promise.all([
    canonical(spec.argv[0]!), canonical(spec.cwd), canonical(policy.primaryRoot),
    ...[...policy.authorityRoots, ...policy.writeRoots, ...policy.referenceRoots, ...(options.denyPaths ?? [])].map(canonical),
  ])
  const authorityRoots = roots.slice(0, policy.authorityRoots.length)
  const writeRoots = roots.slice(authorityRoots.length, authorityRoots.length + policy.writeRoots.length)
  const referenceRoots = roots.slice(authorityRoots.length + writeRoots.length, authorityRoots.length + writeRoots.length + policy.referenceRoots.length)
  const denyPaths = roots.slice(authorityRoots.length + writeRoots.length + referenceRoots.length)
  const readOnlyPaths = engine === "psec"
    ? [...new Set(await Promise.all([helperPath, executable, process.execPath].map(canonical)))] : []
  if (engine === "unrestricted" && (readOnlyPaths.length || referenceRoots.length || denyPaths.length)) fail("unrestricted cannot enforce mandatory locks")
  if (Object.entries(spec.env).some(([key, value]) => !key || key.includes("=") || key.includes("\0") || value.includes("\0"))) fail("invalid environment")
  const environmentKeys = Object.keys(spec.env).map(key => key.toLowerCase())
  if (new Set(environmentKeys).size !== environmentKeys.length) fail("duplicate environment key")
  if (denyPaths.some(root => inside(executable, root) || inside(cwd, root))) fail("executable or cwd denied")
  if (writeRoots.some(root => !authorityRoots.some(authority => inside(root, authority)))) fail("write root outside authority")
  return {
    version: 1, type: "prepare", engine,
    consoleMode: options.consoleMode ?? "no-window",
    spec: {
      argv: [executable, ...spec.argv.slice(1)], cwd, env: { ...spec.env }, owner: copyOwner(spec.owner),
      transport: spec.transport, lifetime: spec.lifetime, argumentEncoding: spec.argumentEncoding,
      ...(spec.pty ? { pty: { ...spec.pty } } : {}),
    },
    policy: {
      mode: policy.mode, owner: copyOwner(policy.owner), authorityRevision: policy.authorityRevision,
      authorityKind: policy.authorityKind, primaryRoot, readable: policy.readable,
      authorityRoots, writeRoots, referenceRoots, fingerprint: policy.fingerprint,
    },
    protection: { readOnlyPaths, denyPaths, helperSha256 },
  }
}

class Session {
  readonly child: ChildProcessWithoutNullStreams
  readonly status = new StatusDecoder()
  readonly frames = new FrameDecoder()
  readonly root = deferred<RootExit>()
  readonly tree = deferred<void>()
  readonly io = deferred<void>()
  private readonly pending = new Map<string, ReturnType<typeof deferred<Status>>>()
  private nextId = 0
  private failed?: Error
  private commitId?: string
  private releaseComplete = false
  private releaseFlight?: Promise<void>
  private ioStatus?: Status
  private binaryEof = false
  private outputQueue: ExecutionOutput[] = []
  private outputBytes = 0
  private consumerAttached = false
  private outputWaiter?: () => void
  private outputDone = false
  private discard = false
  private localDiscarded = 0
  private nativeDiscarded = 0
  private nativeAbandoned = false
  readonly output: AsyncIterable<ExecutionOutput>

  constructor(helperPath: string) {
    this.child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { for (const status of this.status.push(chunk)) this.receive(status) } catch (error) { this.fatal(error) }
    })
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (!this.nativeAbandoned) {
        try { for (const frame of this.frames.push(chunk)) this.enqueue(frame) } catch (error) { this.fatal(error) }
      }
      this.maybeSettleIo()
    })
    this.child.stderr.on("end", () => { this.binaryEof = true; this.maybeSettleIo() })
    this.child.on("error", error => this.fatal(error))
    this.child.on("exit", (code, signal) => this.fatal(new Error(`helper exited before confirmed cleanup (${code ?? signal})`)))
    this.output = { [Symbol.asyncIterator]: () => {
      if (this.consumerAttached) fail("output supports one consumer")
      this.consumerAttached = true
      return {
        next: async (): Promise<IteratorResult<ExecutionOutput>> => {
          while (!this.outputQueue.length && !this.outputDone && !this.failed) {
            await new Promise<void>(resolve => { this.outputWaiter = resolve })
          }
          const frame = this.outputQueue.shift()
          if (frame) {
            this.outputBytes -= frame.data.length
            if (this.outputBytes < maxBufferedOutput / 2) this.child.stderr.resume()
            return { done: false, value: frame }
          }
          if (this.failed) throw this.failed
          return { done: true, value: undefined }
        },
      }
    } }
  }
  diagnostics() { return { outputAbandoned: this.nativeAbandoned || this.localDiscarded > 0, discardedOutputBytes: this.nativeDiscarded + this.localDiscarded } }
  private wake() { const waiter = this.outputWaiter; this.outputWaiter = undefined; waiter?.() }
  private enqueue(frame: ExecutionOutput) {
    if (this.discard) { this.localDiscarded += frame.data.length; return }
    this.outputQueue.push(frame)
    this.outputBytes += frame.data.length
    this.wake()
    if (this.outputBytes >= maxBufferedOutput) this.child.stderr.pause()
  }
  private allowDiscard() {
    if (this.discard) return
    this.discard = true
    this.localDiscarded += this.outputBytes
    this.outputBytes = 0
    this.outputQueue = []
    this.child.stderr.resume()
    this.wake()
  }
  private fatal(cause: unknown) {
    if (this.failed || this.releaseComplete) return
    this.failed = cause instanceof Error ? cause : new Error(String(cause))
    for (const item of this.pending.values()) item.reject(this.failed)
    this.pending.clear()
    this.root.reject(this.failed)
    this.tree.reject(this.failed)
    this.io.reject(this.failed)
    this.child.stdin.end()
    this.child.stderr.resume()
    this.wake()
  }
  private receive(status: Status) {
    if (status.type === "root-exit") {
      if (status.id !== this.commitId) fail("root-exit ID mismatch")
      const error = status.observationError as NativeError | null
      this.root.resolve({ exitCode: typeof status.exitCode === "number" ? status.exitCode : null,
        ...(error ? { observationError: nativeDetail(error) } : {}) })
      return
    }
    if (status.type === "tree-empty") {
      if (status.id !== this.commitId || status.activeProcesses !== 0) fail("invalid tree-empty")
      this.tree.resolve(); return
    }
    if (status.type === "io-settled") {
      if (status.id !== this.commitId || typeof status.outputAbandoned !== "boolean"
        || !Number.isSafeInteger(status.discardedBytes) || Number(status.discardedBytes) < 0
        || !Array.isArray(status.errors)) fail("invalid io-settled")
      this.ioStatus = status
      this.nativeAbandoned = status.outputAbandoned
      this.nativeDiscarded = Number(status.discardedBytes)
      this.maybeSettleIo(); return
    }
    if (status.id === "protocol" || status.id === "helper") {
      this.fatal(new Error(status.type === "error" ? nativeDetail(status.error as NativeError) : "helper fatal status")); return
    }
    const waiter = this.pending.get(status.id)
    if (!waiter) fail(`unexpected helper response ${status.id}`)
    this.pending.delete(status.id)
    if (status.type === "error") waiter.reject(new Error(nativeDetail(status.error as NativeError)))
    else waiter.resolve(status)
  }
  private maybeSettleIo() {
    if (!this.ioStatus) return
    const abandoned = this.ioStatus.outputAbandoned === true
    if (!abandoned && this.binaryEof && !this.frames.outputEnded) { this.io.reject(new Error("missing output-end frame")); return }
    if (!abandoned && !this.frames.outputEnded) return
    if (abandoned && !this.binaryEof) return
    try { this.frames.finish(abandoned) }
    catch (error) { this.io.reject(error as Error); return }
    const errors = this.ioStatus.errors as NativeError[]
    if (errors.length) this.io.reject(new Error(errors.map(nativeDetail).join("; ")))
    else this.io.resolve()
    this.outputDone = true
    this.wake()
  }
  async send(type: string, fields: Record<string, unknown> = {}): Promise<Status> {
    if (this.failed) throw this.failed
    const id = `r${++this.nextId}`
    if (this.nextId > 65536) fail("helper request limit exceeded")
    if (type === "commit") this.commitId = id
    const bytes = Buffer.from(JSON.stringify({ version: 1, id, type, ...fields }) + "\n")
    if (bytes.length > 262144) fail("helper command too long")
    const response = deferred<Status>()
    this.pending.set(id, response)
    try {
      await new Promise<void>((done, reject) => this.child.stdin.write(bytes, error => error ? reject(error) : done()))
    } catch (cause) { this.pending.delete(id); this.fatal(cause); throw cause }
    return response.promise
  }
  async expect(type: string, fields: Record<string, unknown>, response: string): Promise<Status> {
    const status = await this.send(type, fields)
    if (status.type !== response) fail(`expected ${response}, got ${status.type}`)
    return status
  }
  async cancel(reason: StopReason): Promise<void> {
    this.allowDiscard()
    await this.expect("cancel", { reason }, "ack")
  }
  async release(): Promise<void> {
    if (this.releaseComplete) return
    if (this.releaseFlight) return this.releaseFlight
    const flight = this.performRelease()
    this.releaseFlight = flight
    try { await flight } finally { this.releaseFlight = undefined }
  }
  private async performRelease(): Promise<void> {
    if (!this.ioStatus || (!this.frames.outputEnded && !this.nativeAbandoned)) this.allowDiscard()
    const status = await this.expect("release", {}, "released")
    if (status.resourcesReleased !== true) {
      const errors = status.errors as NativeError[] | undefined
      throw new Error(`native release incomplete${errors?.length ? `: ${errors.map(nativeDetail).join("; ")}` : ""}`)
    }
    this.releaseComplete = true
    this.child.stdin.end()
  }
  ioObject(spec: ProcessSpec) {
    return {
      output: this.output,
      diagnostics: () => this.diagnostics(),
      write: async (data: Uint8Array) => {
        if (data.length > 16384) fail("input exceeds 16384 bytes")
        await this.expect("input", { data: Array.from(data) }, "ack")
      },
      endInput: async () => { await this.expect("end-input", {}, "ack") },
      ...(spec.transport === "pty" ? { resize: async (cols: number, rows: number) => {
        await this.expect("resize", { cols, rows }, "ack")
      } } : {}),
      signal: async (signal: "INT" | "TERM" | "KILL") => {
        if (signal === "TERM" || signal === "KILL") this.allowDiscard()
        await this.expect("signal", { signal }, "ack")
      },
    }
  }
}

function createBackend(engine: Engine, source: WindowsExecutionOptions = {}): TransportExecutionBackend {
  const options = Object.freeze({
    helperPath: source.helperPath, manifestPath: source.manifestPath,
    denyPaths: Object.freeze([...(source.denyPaths ?? [])]), consoleMode: source.consoleMode,
  })
  return {
    async probe(): Promise<BackendProbe> {
      try {
        const helper = await verifyHelper(options)
        const { stdout } = await execFileAsync(helper.helperPath, ["--probe"], { timeout: 10000, maxBuffer: 65536, windowsHide: true })
        const probe = JSON.parse(stdout) as Record<string, any>
        if (probe.version !== 1 || probe.helperVersion !== "0.1.0" || probe.target !== "x86_64-pc-windows-msvc"
          || probe.assurance !== "experimental" || !probe.engines?.[engine]) fail("invalid probe response")
        const e = probe.engines[engine]
        return { id: backendId(engine), availability: e.available ? "available" : "unavailable",
          assurance: engine === "psec" ? "experimental" : "unverified",
          features: { writeIsolation: Boolean(e.writeIsolation), readIsolation: Boolean(e.readIsolation),
            denyPaths: Boolean(e.denyPaths), pipes: Boolean(e.pipes), pty: engine === "psec" ? false : Boolean(e.pty),
            retainedTree: Boolean(e.retainedTree) }, detail: probe.error ? nativeDetail(probe.error as NativeError) : undefined }
      } catch (cause) {
        return { id: backendId(engine), availability: "unavailable", assurance: "unverified",
          features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: false, pty: false, retainedTree: false },
          detail: cause instanceof Error ? cause.message : String(cause) }
      }
    },
    async prepare(spec, policy, signal): Promise<PreparedTransportExecution> {
      if (signal?.aborted) fail("preparation aborted")
      const helper = await verifyHelper(options)
      const payload = await preparePayload(engine, spec, policy, options, helper.helperPath, helper.sha256)
      const fingerprint = payload.policy.fingerprint
      const preparedOwner = payload.policy.owner
      const policySnapshot = JSON.stringify(policy)
      if (signal?.aborted) fail("preparation aborted")
      const session = new Session(helper.helperPath)
      let committed = false
      let rolledBack = false
      try {
        const ready = await session.expect("prepare", payload, "ready")
        if (ready.policyFingerprint !== fingerprint || ready.helperSha256 !== helper.sha256
          || typeof ready.effectivePolicyDigest !== "string" || !/^[0-9a-f]{64}$/.test(ready.effectivePolicyDigest)) {
          fail("ready policy fingerprint, helper hash or digest mismatch")
        }
        const digest = ready.effectivePolicyDigest
        return {
          policy,
          async commit(validateAuthority) {
            if (committed) fail("duplicate commit")
            if (rolledBack) fail("commit after rollback")
            if (signal?.aborted) fail("commit aborted")
            if (JSON.stringify(policy) !== policySnapshot) fail("prepared policy identity changed")
            validateAuthority()
            if (signal?.aborted) fail("commit aborted")
            if (JSON.stringify(policy) !== policySnapshot) fail("prepared policy identity changed")
            committed = true
            const started = await session.expect("commit", { effectivePolicyDigest: digest }, "started")
            if (!Number.isInteger(started.pid) || Number(started.pid) < 1) fail("invalid started PID")
            const lease = createExecutionLease({
              receipt: { executionId: randomUUID(), backendId: backendId(engine), policyFingerprint: fingerprint,
                owner: copyOwner(preparedOwner), assurance: engine === "psec" ? "experimental" : "unverified" },
              rootExited: session.root.promise,
              waitTreeEmpty: () => session.tree.promise,
              settleIo: () => session.io.promise,
              releaseResources: () => session.release(),
              terminate: reason => session.cancel(reason),
            })
            return Object.freeze({ ...lease, pid: Number(started.pid), io: session.ioObject(spec),
              async release() {
                try { await session.release() }
                catch (cause) { return { kind: "incomplete" as const, phase: "release" as const,
                  detail: cause instanceof Error ? cause.message : String(cause) } }
                return lease.release()
              },
            }) as TransportExecutionHandle
          },
          rollback: () => { rolledBack = true; return session.release() },
        }
      } catch (cause) {
        try { await session.release() }
        catch (cleanup) { throw new AggregateError([cause, cleanup], "Native preparation failed and rollback failed", { cause }) }
        throw cause
      }
    },
  }
}

export function createWindowsPsecBackend(options?: WindowsExecutionOptions): TransportExecutionBackend {
  return createBackend("psec", options)
}
export function createWindowsUnrestrictedBackend(options?: WindowsExecutionOptions): TransportExecutionBackend {
  return createBackend("unrestricted", options)
}
