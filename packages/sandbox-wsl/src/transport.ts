import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createExecutionLease, type ExecutionOutput, type TransportExecutionHandle, type ExecutionReceipt, type RootExit } from "@i-harness/sandbox"
import { FrameDecoder, WorkerProtocol, decodeBase64, MAX_LINE_BYTES, MAX_CHUNK_BYTES, type HostType, type WorkerFrame } from "./protocol.ts"
import { decodeLauncherText } from "./admission.ts"

export const WSL_EXE = "C:\\Windows\\System32\\wsl.exe"
const OUTPUT_LIMIT = 1024 * 1024
const DIAGNOSTIC_LIMIT = 16 * 1024
const CONTROL_TIMEOUT_MS = 10_000

// This code is constant. Source and request material arrive only over the bounded pipe.
export const BOOTSTRAP = `import sys,os,json,base64,hashlib
try:
 line=bytearray()
 while len(line)<=262144:
  c=os.read(0,1)
  if not c: break
  line.extend(c)
  if c==b'\\n': break
 if len(line)>262144 or not line.endswith(b'\\n'): raise ValueError()
 f=json.loads(line)
 if set(f)!={'v','nonce','source','sha256'} or f['v']!=1: raise ValueError()
 if not isinstance(f['nonce'],str) or len(f['nonce'])!=64: raise ValueError()
 source=base64.b64decode(f['source'],validate=True)
 if hashlib.sha256(source).hexdigest()!=f['sha256']: raise ValueError()
 code=compile(source,'<captured-wsl-worker>','exec')
except BaseException:
 sys.stderr.write('WSL worker bootstrap rejected\\n');sys.exit(120)
exec(code,{'IH_WSL_NONCE':f['nonce'],'IH_WSL_SHA256':f['sha256'],'__name__':'__main__'})`

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_yes, no) => {
      timer = setTimeout(() => no(new Error(`WSL ${label} timed out; guest cleanup unconfirmed`)), CONTROL_TIMEOUT_MS)
    })])
  } finally { clearTimeout(timer) }
}

/** A single consumer queue bounds retained payload even before a consumer starts. */
export class OutputBuffer {
  private frames: ExecutionOutput[] = []
  private bytes = 0
  private ended = false
  private abandoned = false
  private discarded = 0
  private consumer = false
  private wake?: () => void
  readonly output: AsyncIterable<ExecutionOutput>
  constructor(private readonly limit: number, private readonly overflow: () => void) {
    const self = this
    this.output = { async *[Symbol.asyncIterator]() {
      if (self.consumer) throw new Error("WSL output permits one consumer")
      self.consumer = true
      try {
        while (true) {
          const frame = self.frames.shift()
          if (frame) { self.bytes -= frame.data.byteLength; yield frame; continue }
          if (self.ended) return
          await new Promise<void>(resolve => { self.wake = resolve })
        }
      } finally {
        if (!self.ended || self.frames.length) self.abandon()
      }
    } }
  }
  private abandon(): void {
    if (this.abandoned) return
    this.abandoned = true
    this.discarded += this.bytes; this.bytes = 0; this.frames = []
    this.overflow(); this.wake?.(); this.wake = undefined
  }
  push(frame: ExecutionOutput): void {
    if (this.abandoned) { this.discarded += frame.data.byteLength; return }
    if (this.bytes + frame.data.byteLength > this.limit || this.frames.length >= 1024) {
      this.discarded += frame.data.byteLength; this.abandon(); return
    }
    this.frames.push(frame); this.bytes += frame.data.byteLength
    this.wake?.(); this.wake = undefined
  }
  finish(): void { this.ended = true; this.wake?.(); this.wake = undefined }
  diagnostics() { return { outputAbandoned: this.abandoned, discardedOutputBytes: this.discarded } }
}

/** One real WSL launcher owns one trusted guest worker and at most one workload. */
export class WorkerClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly decoder = new FrameDecoder()
  private readonly protocol: WorkerProtocol
  private readonly hello = deferred<void>()
  private readonly probeReply = deferred<Extract<WorkerFrame, { type: "probe" }>>()
  private readonly prepared = deferred<string>()
  private readonly started = deferred<number>()
  private readonly root = deferred<RootExit>()
  private readonly acknowledged = deferred<void>()
  private readonly closed = deferred<void>()
  private readonly interrupted = deferred<never>()
  private readonly transportFailed = deferred<never>()
  private readonly output: OutputBuffer
  private diagnostic = Buffer.alloc(0)
  private diagnosticsDiscarded = 0
  private failure?: Error
  private hasClosed = false
  private hasAcknowledged = false
  private refused = false
  private shutdownAttempt?: Promise<void>
  private shutdownSent = false
  private rootDrainTimer?: ReturnType<typeof setTimeout>
  private inputEnded = false
  private inputBytes = 0
  private inputChain: Promise<void> = Promise.resolve()
  private readonly bootstrapWritten: Promise<void>

  constructor(distribution: string, private readonly nonce: string, bootstrapLine: string, digest: string) {
    this.protocol = new WorkerProtocol(nonce, digest)
    this.output = new OutputBuffer(OUTPUT_LIMIT, () => {
      if (!this.hasAcknowledged && !this.hasClosed) void this.send("cancel").catch(cause => this.fail(cause))
    })
    this.child = spawn(WSL_EXE, ["--distribution", distribution, "--exec", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C",
      "/usr/bin/python3", "-I", "-B", "-u", "-c", BOOTSTRAP], { windowsHide: true, stdio: "pipe", shell: false })
    this.child.on("error", () => this.fail(new Error("WSL launcher failed to start")))
    this.child.stdin.on("error", () => this.fail(new Error("WSL worker input pipe failed")))
    this.child.stdout.on("error", () => this.fail(new Error("WSL worker output pipe failed")))
    this.child.stderr.on("error", () => this.fail(new Error("WSL launcher diagnostic pipe failed")))
    this.child.stderr.on("data", (data: Buffer) => {
      const keep = Math.min(data.length, DIAGNOSTIC_LIMIT - this.diagnostic.length)
      if (keep) this.diagnostic = Buffer.concat([this.diagnostic, data.subarray(0, keep)])
      this.diagnosticsDiscarded += data.length - keep
    })
    this.child.stdout.on("data", (data: Buffer) => {
      if (this.failure) return
      try { for (const value of this.decoder.feed(data)) this.receive(this.protocol.receive(value)) }
      catch (cause) { this.fail(cause) }
    })
    this.child.stdout.on("end", () => { try { this.decoder.end() } catch (cause) { this.fail(cause) } })
    this.child.on("close", (code, signal) => {
      this.hasClosed = true
      clearTimeout(this.rootDrainTimer)
      if (!this.failure && (code !== 0 || signal)) this.fail(new Error("WSL worker closed unsuccessfully"))
      if (!this.failure && this.protocol.phase !== "probed" && this.protocol.phase !== "ready" && !this.hasAcknowledged)
        this.fail(new Error("WSL worker closed without guest settlement acknowledgement"))
      this.output.finish()
      if (this.failure) this.closed.reject(this.failure)
      else this.closed.resolve()
      if (!this.hasAcknowledged) this.acknowledged.reject(this.failure ?? new Error("WSL guest settlement not acknowledged"))
      this.hello.reject(this.failure ?? new Error("WSL worker closed before hello"))
      this.prepared.reject(this.failure ?? new Error("WSL preparation interrupted"))
      this.started.reject(this.failure ?? new Error("WSL commit interrupted"))
      this.probeReply.reject(this.failure ?? new Error("WSL probe interrupted"))
    })
    this.bootstrapWritten = this.writeControl(bootstrapLine, "bootstrap")
    void this.bootstrapWritten.catch(() => {})
  }

  private fail(cause: unknown): void {
    if (this.failure) return
    this.failure = cause instanceof Error ? cause : new Error("WSL worker transport failed")
    clearTimeout(this.rootDrainTimer)
    for (const item of [this.hello, this.probeReply, this.prepared, this.started, this.root, this.acknowledged, this.interrupted, this.transportFailed]) item.reject(this.failure)
    // EOF is the worker's trusted cancellation path. Launcher death never confirms the guest tree empty.
    this.child.stdin.end()
    // end() may wait behind the blocked native write that caused failure; destroy closes the pipe now.
    this.child.stdin.destroy()
    // A failed callback or response deadline must drain even when no public operation is waiting to stop.
    // Defer entry so a synchronous native callback cannot reenter an unreserved shutdown attempt.
    void Promise.resolve().then(() => this.shutdown()).catch(() => {})
  }
  private receive(frame: WorkerFrame): void {
    switch (frame.type) {
      case "hello": this.hello.resolve(); break
      case "probe": this.probeReply.resolve(frame); break
      case "prepared": this.prepared.resolve(frame.policyFingerprint); break
      case "started": this.started.resolve(frame.pid); break
      case "output": this.output.push({ channel: frame.channel, data: decodeBase64(frame.data) }); break
      case "root":
        this.root.resolve({ exitCode: frame.exitCode, ...(frame.signal ? { signal: frame.signal } : {}) })
        this.rootDrainTimer = setTimeout(() => this.fail(new Error("WSL root exited without timely guest settlement acknowledgement")), CONTROL_TIMEOUT_MS)
        break
      case "settled":
        clearTimeout(this.rootDrainTimer)
        this.hasAcknowledged = true; this.acknowledged.resolve()
        void this.shutdown().catch(() => {})
        break
      case "refused": {
        // Only a trusted prelaunch refusal can reject admission while retaining a clean teardown path.
        this.refused = true
        const refusal = new Error(`WSL worker refused request: ${frame.detail}`)
        this.prepared.reject(refusal); this.started.reject(refusal); this.root.reject(refusal); this.interrupted.reject(refusal)
        this.child.stdin.end()
        break
      }
      case "error": this.fail(new Error(`WSL worker rejected request: ${frame.detail}`)); break
    }
  }
  send(type: HostType, fields: Record<string, unknown> = {}): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.hasClosed) return Promise.reject(new Error("WSL worker already closed"))
    const line = JSON.stringify({ ...fields, v: 1, nonce: this.nonce, type }) + "\n"
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return Promise.reject(new Error("WSL host frame exceeds line limit"))
    try { this.protocol.send(type) } catch (cause) { return Promise.reject(cause) }
    return this.writeControl(line, type)
  }
  private writeControl(line: string, label: string): Promise<void> {
    const written = new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, error => {
        if (error) reject(new Error(`WSL ${label} write failed`))
        else resolve()
      })
    })
    return bounded(Promise.race([written, this.transportFailed.promise]), `${label} write`).catch(cause => {
      this.fail(cause)
      throw cause
    })
  }
  async ready(): Promise<void> { await this.bootstrapWritten; await bounded(this.hello.promise, "worker startup") }
  completion(): Promise<void> { return this.closed.promise }
  async probe(): Promise<Extract<WorkerFrame, { type: "probe" }>> {
    await this.send("probe"); return bounded(this.probeReply.promise, "probe")
  }
  async prepare(spec: unknown, policy: unknown): Promise<string> {
    await this.send("prepare", { spec, policy })
    return bounded(Promise.race([this.prepared.promise, this.interrupted.promise]), "preparation")
  }
  interrupt(): void { this.interrupted.reject(new Error("WSL execution admission aborted")) }
  async commit(receipt: ExecutionReceipt, validateAuthority: () => void): Promise<TransportExecutionHandle> {
    // No await can separate this trusted authority fence from the remote commit write.
    validateAuthority()
    const committed = this.send("commit")
    await committed
    const pid = await bounded(this.started.promise, "commit")
    const lease = createExecutionLease({ receipt, rootExited: this.root.promise,
      waitTreeEmpty: async () => { await this.acknowledged.promise; await this.waitClosed(); if (this.failure) throw this.failure },
      settleIo: async () => { await this.waitClosed(); if (this.failure) throw this.failure },
      releaseResources: async () => { await this.waitClosed() },
      terminate: async () => { await this.shutdown() },
    })
    return Object.freeze({ receipt: lease.receipt, pid, rootExited: lease.rootExited,
      get settled() { return lease.settled }, cancel: lease.cancel, release: lease.release,
      runner: Object.freeze({ enforcement: "partial" as const, denialSignatures: Object.freeze(["Permission denied", "Operation not permitted", "Read-only file system"]), runnerFailureRules: Object.freeze([]) }),
      io: { output: this.output.output, diagnostics: () => this.output.diagnostics(),
        write: (data: Uint8Array) => this.writeInput(data), endInput: () => this.endInput() },
    })
  }
  private writeInput(data: Uint8Array): Promise<void> {
    if (this.inputEnded || this.inputBytes + data.byteLength > OUTPUT_LIMIT) return Promise.reject(new Error("WSL stdin closed or pending input exceeds limit"))
    const captured = Buffer.from(data)
    this.inputBytes += captured.length
    const next = this.inputChain.then(async () => {
      for (let offset = 0; offset < captured.length; offset += MAX_CHUNK_BYTES)
        await this.send("input", { data: captured.subarray(offset, offset + MAX_CHUNK_BYTES).toString("base64") })
    }).finally(() => { this.inputBytes -= captured.length })
    this.inputChain = next.catch(() => {})
    return next
  }
  private endInput(): Promise<void> {
    if (this.inputEnded) return this.inputChain
    this.inputEnded = true
    const next = this.inputChain.then(() => this.send("endInput"))
    this.inputChain = next.catch(() => {})
    return next
  }
  private async waitClosed(): Promise<void> {
    try { await bounded(this.closed.promise, "launcher closure") }
    catch (cause) {
      if (!this.hasClosed) {
        this.fail(cause); this.child.kill()
        try { await bounded(this.closed.promise, "forced launcher closure") } catch {}
      }
      throw cause
    }
  }
  shutdown(): Promise<void> {
    this.shutdownAttempt ??= this.stop()
    return this.shutdownAttempt
  }
  private async stop(): Promise<void> {
    this.interrupt()
    let failure: unknown
    const requiresAck = ["preparing", "prepared", "committing", "running", "root", "refused", "settled"].includes(this.protocol.phase)
    try {
      if (!this.hasClosed && !this.shutdownSent && !this.failure && !this.refused) {
        this.shutdownSent = true
        await this.send("shutdown")
        this.child.stdin.end()
      }
      if (requiresAck) await bounded(this.acknowledged.promise, "guest shutdown")
    } catch (cause) { failure = cause; this.fail(cause) }
    try { await this.waitClosed() } catch (cause) { failure ??= cause }
    if (failure) throw failure
    if (this.failure) throw this.failure
  }
  diagnostics() {
    return { launcherStderr: decodeLauncherText(this.diagnostic), discardedLauncherStderrBytes: this.diagnosticsDiscarded, ...this.output.diagnostics() }
  }
}
