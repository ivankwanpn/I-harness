import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { platform as hostPlatform } from "node:os"
import * as pty from "node-pty"
import { createExecutionLease, snapshotProcessSpec } from "@i-harness/sandbox"
import type {
  BackendProbe, ExecutionOutput, PreparedTransportExecution,
  ProcessSpec, RootExit, StopReason, TransportExecutionBackend, TransportExecutionHandle,
} from "@i-harness/sandbox"
import { BWRAP_DENIAL_SIGNATURES, BWRAP_RUNNER_FAILURE_RULES, bwrapProfileArgs, probeBwrap } from "./profiles.ts"

const MAX_OUTPUT = 1024 * 1024
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false
    throw cause
  }
}

class PosixSession {
  private readonly root = deferred<RootExit>()
  private readonly started = deferred<void>()
  private readonly closed = deferred<void>()
  private readonly outputClosed = deferred<void>()
  private readonly overflow = deferred<never>()
  private readonly stopDeadline = deferred<never>()
  private readonly queue: ExecutionOutput[] = []
  private queuedBytes = 0
  private discardedBytes = 0
  private abandoned = false
  private consumer = false
  private done = false
  private outputFailure?: Error
  private overflowFailure?: Error
  private stopTimer?: ReturnType<typeof setTimeout>
  private wake?: () => void
  private outputDone?: () => void
  private child?: ChildProcessWithoutNullStreams
  private terminal?: pty.IPty
  readonly pid: number
  readonly rootExited = this.root.promise
  readonly ready = this.started.promise
  readonly output: AsyncIterable<ExecutionOutput>

  constructor(readonly spec: ProcessSpec, argv: readonly string[], readonly onRelease: (session: PosixSession) => void) {
    if (spec.transport === "pipe") {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: spec.cwd, env: { ...spec.env },
        shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] })
      this.child = child
      this.pid = child.pid ?? 0
      child.on("spawn", () => this.started.resolve())
      child.on("error", error => {
        this.started.reject(error)
        this.root.reject(error); this.closed.reject(error); this.outputClosed.reject(error)
        this.outputFailure = error; this.done = true; this.notify()
      })
      child.on("exit", (exitCode, signal) => this.root.resolve({ exitCode, ...(signal ? { signal } : {}) }))
      child.on("close", () => this.closed.resolve())
      let remaining = 2
      const end = () => { if (--remaining === 0) this.finishOutput() }
      child.stdout.on("data", (chunk: Buffer) => this.enqueue({ channel: "stdout", data: chunk }, child.stdout))
      child.stderr.on("data", (chunk: Buffer) => this.enqueue({ channel: "stderr", data: chunk }, child.stderr))
      child.stdout.on("end", end); child.stderr.on("end", end)
    } else {
      const term = pty.spawn(argv[0]!, argv.slice(1), { name: spec.env.TERM!,
        cols: spec.pty!.cols, rows: spec.pty!.rows, cwd: spec.cwd, env: { ...spec.env }, encoding: null })
      this.terminal = term
      this.pid = term.pid
      this.started.resolve()
      term.onData(data => this.enqueue({ channel: "pty", data: Buffer.isBuffer(data) ? data : Buffer.from(data) }))
      term.onExit(({ exitCode, signal }) => {
        this.root.resolve({ exitCode, ...(signal ? { signal: String(signal) } : {}) })
        this.closed.resolve(); this.finishOutput()
      })
    }
    this.output = { [Symbol.asyncIterator]: () => {
      if (this.consumer) throw new Error("POSIX output supports one consumer")
      this.consumer = true
      return { next: async (): Promise<IteratorResult<ExecutionOutput>> => {
        while (!this.queue.length && !this.done) await new Promise<void>(resolve => { this.wake = resolve })
        const frame = this.queue.shift()
        if (frame) {
          this.queuedBytes -= frame.data.length
          if (this.queuedBytes < MAX_OUTPUT / 2) { this.child?.stdout.resume(); this.child?.stderr.resume() }
          if (this.done && !this.queue.length) this.outputDone?.()
          return { done: false, value: frame }
        }
        if (this.outputFailure) throw this.outputFailure
        return { done: true, value: undefined }
      } }
    } }
  }
  private notify() { const wake = this.wake; this.wake = undefined; wake?.() }
  private enqueue(frame: ExecutionOutput, stream?: NodeJS.ReadableStream) {
    if (this.abandoned) { this.discardedBytes += frame.data.length; return }
    if (this.terminal && this.queuedBytes + frame.data.length > MAX_OUTPUT) {
      this.abandon()
      void this.terminate("output-limit").catch(cause => {
        this.overflowFailure = cause instanceof Error ? cause : new Error(String(cause))
        this.overflow.reject(this.overflowFailure)
        this.notify()
      })
      return
    }
    this.queue.push(frame); this.queuedBytes += frame.data.length; this.notify()
    if (stream && this.queuedBytes >= MAX_OUTPUT) stream.pause()
  }
  private finishOutput() { this.done = true; this.outputClosed.resolve(); this.notify(); if (!this.queue.length) this.outputDone?.() }
  private abandon() {
    if (this.abandoned) return
    this.abandoned = true; this.discardedBytes += this.queuedBytes
    this.queuedBytes = 0; this.queue.length = 0
    this.child?.stdout.resume(); this.child?.stderr.resume(); this.notify(); this.outputDone?.()
  }
  diagnostics() { return { outputAbandoned: this.abandoned, discardedOutputBytes: this.discardedBytes } }
  async waitTreeEmpty(): Promise<void> {
    await Promise.race([this.rootExited, this.overflow.promise, this.stopDeadline.promise])
    if (this.pid < 1) throw new Error("POSIX process group ID unavailable")
    if (this.overflowFailure) throw this.overflowFailure
    while (groupAlive(this.pid)) {
      if (this.overflowFailure) throw this.overflowFailure
      await Promise.race([delay(25), this.stopDeadline.promise])
    }
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = undefined }
  }
  async settleIo(): Promise<void> {
    await this.outputClosed.promise
    if (this.queue.length && !this.abandoned) await new Promise<void>(resolve => { this.outputDone = resolve })
  }
  async releaseResources(): Promise<void> {
    await this.closed.promise
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = undefined }
    this.onRelease(this)
  }
  async terminate(_reason: StopReason): Promise<void> {
    this.abandon()
    if (this.pid < 1) throw new Error("POSIX process group ID unavailable")
    if (!this.stopTimer) this.stopTimer = setTimeout(() => this.stopDeadline.reject(new Error("POSIX process-group cleanup timed out")), 12000)
    try { process.kill(-this.pid, "SIGKILL") }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause }
  }
  io() {
    return {
      output: this.output, diagnostics: () => this.diagnostics(),
      write: async (data: Uint8Array) => {
        if (this.terminal) { this.terminal.write(Buffer.from(data)); return }
        await new Promise<void>((resolve, reject) => this.child!.stdin.write(data, error => error ? reject(error) : resolve()))
      },
      endInput: async () => { if (this.child) await new Promise<void>(resolve => this.child!.stdin.end(resolve)) },
      ...(this.terminal ? { resize: async (cols: number, rows: number) => { this.terminal!.resize(cols, rows) } } : {}),
      signal: async (signal: "INT" | "TERM" | "KILL") => {
        if (signal === "INT" && this.terminal) { this.terminal.write("\x03"); return }
        if (signal === "INT") process.kill(-this.pid, "SIGINT")
        else if (signal === "TERM") process.kill(-this.pid, "SIGTERM")
        else await this.terminate("cancelled")
      },
    }
  }
}

export interface PosixExecutionBackend extends TransportExecutionBackend { dispose(): Promise<void> }
export function createPosixExecutionBackend(): PosixExecutionBackend {
  const sessions = new Set<PosixSession>()
  let disposed = false
  return {
    async probe(): Promise<BackendProbe> {
      const supported = hostPlatform() === "linux" || hostPlatform() === "darwin"
      return { id: "posix-local", availability: !disposed && supported ? "available" : "unavailable",
        assurance: "unverified", features: { writeIsolation: hostPlatform() === "linux" && probeBwrap(),
          readIsolation: false, denyPaths: false, pipes: supported, pty: supported, retainedTree: supported },
        detail: supported ? "Process-group observation does not cover escaped daemon groups" : "POSIX driver unavailable on this host" }
    },
    async prepare(input, policy, signal): Promise<PreparedTransportExecution> {
      if (disposed) throw new Error("POSIX backend disposed")
      if (hostPlatform() !== "linux" && hostPlatform() !== "darwin") throw new Error("POSIX backend unavailable on this host")
      const spec = snapshotProcessSpec(input)
      if (spec.argumentEncoding !== "crt") throw new Error("POSIX backend does not support cmd-verbatim encoding")
      if (!spec.argv.length || !spec.argv[0]) throw new Error("empty POSIX argv")
      if (spec.owner.sessionId !== policy.owner.sessionId || spec.owner.parentSessionId !== policy.owner.parentSessionId) throw new Error("POSIX owner mismatch")
      if (policy.mode === "danger-full-access" && policy.referenceRoots.length) throw new Error("unrestricted POSIX cannot enforce reference locks")
      if (spec.transport === "pty") {
        if (!spec.pty || spec.pty.cols < 1 || spec.pty.rows < 1) throw new Error("invalid PTY size")
        // node-pty writes these two entries unconditionally; require the exact
        // values in the frozen caller env so it cannot add or overwrite them.
        if (spec.env.PWD !== spec.cwd || !spec.env.TERM) throw new Error("POSIX PTY requires explicit PWD=cwd and TERM in env")
      }
      if (policy.mode !== "danger-full-access" && hostPlatform() !== "linux") throw new Error("confined POSIX requires Linux bwrap")
      if (policy.mode !== "danger-full-access" && !probeBwrap()) throw new Error("bwrap unavailable")
      const argv = policy.mode === "danger-full-access" ? [...spec.argv] : ["bwrap",
        ...bwrapProfileArgs({ mode: policy.mode, workspaceRoot: policy.primaryRoot, workspaceRoots: policy.authorityRoots }),
        "--", ...spec.argv]
      const frozen = JSON.stringify(policy)
      if (signal?.aborted) throw new Error("POSIX preparation aborted")
      let committed = false
      let rolledBack = false
      return {
        policy,
        async commit(validateAuthority) {
          if (disposed || rolledBack || committed || signal?.aborted) throw new Error("POSIX commit unavailable")
          if (JSON.stringify(policy) !== frozen) throw new Error("POSIX policy changed after preparation")
          validateAuthority()
          committed = true
          const session = new PosixSession(spec, argv, owned => sessions.delete(owned))
          sessions.add(session)
          try { await session.ready }
          catch (cause) { sessions.delete(session); throw cause }
          try { validateAuthority() }
          catch (cause) {
            try {
              await session.terminate("authority-revoked")
              await session.waitTreeEmpty(); await session.settleIo(); await session.releaseResources()
            } catch (cleanup) { throw new AggregateError([cause, cleanup], "POSIX authority fence and cleanup failed") }
            throw cause
          }
          const lease = createExecutionLease({
            receipt: { executionId: randomUUID(), backendId: policy.mode === "danger-full-access" ? "posix-unrestricted" : "linux-bwrap",
              policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: "unverified" },
            rootExited: session.rootExited, waitTreeEmpty: () => session.waitTreeEmpty(), settleIo: () => session.settleIo(),
            releaseResources: () => session.releaseResources(), terminate: reason => session.terminate(reason),
          })
          const runner = policy.mode === "danger-full-access" ? undefined : Object.freeze({
            enforcement: "full" as const, denialSignatures: BWRAP_DENIAL_SIGNATURES,
            runnerFailureRules: BWRAP_RUNNER_FAILURE_RULES,
          })
          return Object.freeze({ receipt: lease.receipt, rootExited: lease.rootExited,
            get settled() { return lease.settled }, cancel: lease.cancel, release: lease.release,
            pid: session.pid, io: session.io(), ...(runner ? { runner } : {}),
          }) satisfies TransportExecutionHandle
        },
        async rollback() { rolledBack = true },
      }
    },
    async dispose() {
      disposed = true
      const outcomes = await Promise.allSettled([...sessions].map(session => session.terminate("shutdown")
        .then(() => session.waitTreeEmpty()).then(() => session.settleIo()).then(() => session.releaseResources())))
      const errors = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      if (errors.length) throw new AggregateError(errors.map(value => value.reason), "POSIX backend cleanup incomplete")
    },
  }
}
