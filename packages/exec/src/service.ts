import { existsSync } from "node:fs"
import { isAbsolute, resolve, win32 } from "node:path"
import type {
  BackendRequirements, CompiledSandboxPolicy, ExecutionOwner, ExecutionSettlement,
  ProcessSpec, RootExit, StopReason,
} from "@i-harness/sandbox"
import { SandboxUnavailableError, classifyRunnerFailure, snapshotProcessSpec } from "@i-harness/sandbox"
import { createLocalExecutionBackends } from "@i-harness/sandbox-local"
import { assertExecutionAuthority, compileExecutionPolicy } from "@i-harness/sandbox-policy"
import { currentExecCaller } from "./caller-scope.ts"
import { ExecutionAdmissionError } from "./execution-admission.ts"
import { createExecutionSupervisor, type SupervisedExecution } from "./execution-supervisor.ts"
import { OutputCollector, type CollectResult } from "./spill.ts"
import { execOutputReader, registerRetainedOutput } from "./retained-output.ts"
import type {
  BackgroundJobStatus, BackgroundJobView, ExecCommand, ExecExecutionHost, ExecResult,
  ExecRunOptions, ExecService, ExecServiceOptions, ExecStreamRunOptions, ExecTransportRequest, PromotedRun,
} from "./index.ts"

type StreamMetadata = NonNullable<ExecResult["stream"]>
type Channel = "stdout" | "stderr"
type Capture = {
  readonly complete: Promise<ExecResult>
  readonly execution: SupervisedExecution
  output(): { stdout: CollectResult; stderr: CollectResult }
  diagnostics(): { outputAbandoned: boolean; discardedOutputBytes: number } | undefined
}
type Job = {
  id: string; capture: Capture; status: BackgroundJobStatus; owner: Readonly<ExecutionOwner>
  exitCode?: number; root?: RootExit; settlement?: ExecutionSettlement; failure?: string; cleanupDetail?: string
}

function boundEnvironment(input?: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const source = input === undefined ? process.env : input
  const environment: Record<string, string> = {}
  if (process.platform === "win32") {
    const keys = new Map<string, string>()
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue
      const previous = keys.get(key.toLowerCase())
      if (previous !== undefined) delete environment[previous]
      keys.set(key.toLowerCase(), key)
      environment[key] = value
    }
  } else for (const [key, value] of Object.entries(source)) if (value !== undefined) environment[key] = value
  return Object.freeze(environment)
}

function resolveExecutable(argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>): readonly string[] {
  if (process.platform !== "win32" || !argv[0] || isAbsolute(argv[0])) return argv
  const name = argv[0]
  const key = Object.keys(env).find(item => item.toLowerCase() === "path")
  const path = key === undefined ? "" : env[key]!
  const candidates = /[\\/]/.test(name) ? [resolve(cwd, name)]
    : path.split(";").filter(Boolean).map(directory => win32.resolve(directory.replace(/^"|"$/g, ""), name))
  const extensions = win32.extname(name) ? [""] : [".exe", ".com", ".cmd", ".bat"]
  for (const candidate of candidates) for (const extension of extensions) {
    const target = candidate + extension
    if (existsSync(target)) return [target, ...argv.slice(1)]
  }
  return argv
}

function validateInput(command: ExecCommand): void {
  if (command.input !== undefined && command.inputBytes !== undefined) throw new Error("input and inputBytes are mutually exclusive")
  if (command.inputBytes !== undefined && (!(command.inputBytes instanceof Uint8Array) || command.inputBytes.byteLength > 2 * 1024 * 1024)) {
    throw new Error("inputBytes must be bytes bounded to 2 MiB")
  }
}

function defaultHost(workspaceRoot: string, legacyArgvProvider = false, owner: Readonly<ExecutionOwner> = { sessionId: "standalone-exec" }): ExecExecutionHost {
  const backends = createLocalExecutionBackends({ windowsSelection: process.env.IH_WINDOWS_SANDBOX === "psec" ? "psec" : "legacy" })
  const authority = Object.freeze({ kind: "unbound" as const, revision: "standalone-workspace", workspaceRoot })
  return {
    defaultOwner: Object.freeze({ sessionId: owner.sessionId, ...(owner.parentSessionId === undefined ? {} : { parentSessionId: owner.parentSessionId }) }),
    selectBackend: (policy, transport) => {
      if (legacyArgvProvider && policy.mode !== "danger-full-access") {
        throw new Error("argv-only sandbox provider cannot own a supervised process; compose a transport backend")
      }
      return backends.select(policy, transport)
    },
    resolvePolicy: (owner, requested) => compileExecutionPolicy({ mode: requested?.mode ?? "danger-full-access", owner, authority }),
    validateAuthority: policy => assertExecutionAuthority(policy, compileExecutionPolicy({ mode: policy.mode, owner: policy.owner, authority })),
    dispose: () => backends.dispose(),
  }
}

function requirements(policy: CompiledSandboxPolicy, request: ExecTransportRequest): BackendRequirements {
  return Object.freeze({
    writeIsolation: policy.mode !== "danger-full-access", readIsolation: request.sandbox?.requireReadIsolation === true,
    denyPaths: policy.referenceRoots.length > 0, transport: request.transport, lifetime: request.lifetime,
    minimumAssurance: "unverified" as const,
  })
}

function clean(text: string): string { return text.replace(/\r\n/g, "\n") }
function unknownExit(root: RootExit): number { return root.exitCode ?? -1 }
function isEpipe(cause: unknown): boolean { return (cause as NodeJS.ErrnoException)?.code === "EPIPE" }

export function createExecService(options: ExecServiceOptions = {}): ExecService {
  const host = options.execution ?? defaultHost(resolve(options.workspaceRoot ?? process.cwd()), options.sandbox !== undefined, options.standaloneOwner)
  const supervisor = host.supervisor ?? createExecutionSupervisor()
  const jobs = new Map<string, Job>()
  let nextJob = 0
  let disposed = false

  function caller(): Readonly<ExecutionOwner> {
    const owner = currentExecCaller() ?? host.defaultOwner
    if (!owner?.sessionId) throw new Error("Execution caller scope is missing")
    return Object.freeze({ sessionId: owner.sessionId, ...(owner.parentSessionId === undefined ? {} : { parentSessionId: owner.parentSessionId }) })
  }
  function canAccess(owner: Readonly<ExecutionOwner>): boolean {
    const actual = caller()
    return actual.sessionId === owner.sessionId || host.canAccessOwner?.(actual, owner) === true
  }

  function launchTransport(request: ExecTransportRequest, automaticPromotion = false): Promise<SupervisedExecution> {
    try {
      if (disposed) throw new Error("Exec service disposed")
      const owner = caller()
      const policy = host.resolvePolicy(owner, request.sandbox)
      if (automaticPromotion && host.autoPromotionLifetime) request = { ...request, lifetime: host.autoPromotionLifetime(policy) }
      const cwd = resolve(request.cwd ?? options.workspaceRoot ?? process.cwd())
      const env = boundEnvironment(request.env)
      const spec: ProcessSpec = snapshotProcessSpec({
        argv: resolveExecutable(request.argv, cwd, env), cwd,
        env, owner, transport: request.transport,
        lifetime: request.lifetime, argumentEncoding: request.argumentEncoding,
        ...(request.pty === undefined ? {} : { pty: request.pty }),
      })
      let backend: ReturnType<ExecExecutionHost["selectBackend"]>
      try { backend = host.selectBackend(policy, spec.transport) }
      catch (cause) {
        if (policy.mode !== "danger-full-access") throw new SandboxUnavailableError(policy.mode, cause instanceof Error ? cause.message : String(cause))
        throw cause
      }
      return supervisor.launch({ backend, spec, policy, requirements: requirements(policy, request),
        validateAuthority: current => host.validateAuthority(current), signal: request.abortSignal }).catch(cause => {
          if (policy.mode !== "danger-full-access" && cause instanceof ExecutionAdmissionError) {
            throw new SandboxUnavailableError(policy.mode, cause.message)
          }
          throw cause
        })
    } catch (cause) { return Promise.reject(cause) }
  }

  function cancelExecution(id: string, reason: StopReason): Promise<ExecutionSettlement> {
    const execution = supervisor.list().find(entry => entry.id === id)
    if (!execution || !canAccess(execution.policy.owner)) return Promise.reject(new Error("Unknown execution for caller"))
    return supervisor.cancel(id, reason)
  }

  function makeCapture(command: ExecCommand, optionsForRun?: ExecStreamRunOptions, background = false, promotable = false): Promise<Capture> {
    validateInput(command)
    if (optionsForRun !== undefined) {
      const { maxBytes, onStdout } = optionsForRun.stream
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("stream maxBytes must be a positive safe integer")
      if (typeof onStdout !== "function") throw new Error("stream onStdout must be a function")
      if (optionsForRun.backgroundAfterMs !== undefined) throw new Error("stream cannot be combined with promotion")
    }
    const input = command.inputBytes === undefined ? command.input === undefined ? undefined : Buffer.from(command.input)
      : Buffer.from(command.inputBytes)
    const signal = new AbortController()
    let stop: StreamMetadata["stopReason"] | undefined
    const externalAbort = () => { stop ??= "aborted"; signal.abort("cancelled") }
    command.abortSignal?.addEventListener("abort", externalAbort, { once: true })
    if (command.abortSignal?.aborted) externalAbort()
    let timer: ReturnType<typeof setTimeout> | undefined
    const request: ExecTransportRequest = {
      argv: [...command.argv], cwd: command.cwd,
      ...(command.env === undefined ? {} : { env: { ...command.env } }),
      transport: "pipe", lifetime: background || promotable ? "retain-tree" : "complete-tree",
      argumentEncoding: command.windowsVerbatimArguments ? "cmd-verbatim" : "crt",
      sandbox: command.sandbox, abortSignal: signal.signal,
    }
    const launch = launchTransport(request, promotable && !background)
    return launch.then(execution => {
      if (command.timeoutMs !== undefined) timer = setTimeout(() => {
        stop ??= "timeout"; signal.abort("timeout")
      }, command.timeoutMs)
      const { handle } = execution
      const stream = optionsForRun?.stream
      const metadata: StreamMetadata | undefined = stream ? { bytesRead: { stdout: 0, stderr: 0 }, bytesAdmitted: { stdout: 0, stderr: 0 } } : undefined
      const collected = options.spill && !stream ? {
        stdout: new OutputCollector({ maxBytes: options.spill.maxOutputBytes ?? 64_000, maxSpillBytes: options.spill.maxSpillBytes, spillRoot: options.spill.spillRoot, label: "stdout" }),
        stderr: new OutputCollector({ maxBytes: options.spill.maxOutputBytes ?? 64_000, maxSpillBytes: options.spill.maxSpillBytes, spillRoot: options.spill.spillRoot, label: "stderr" }),
      } : undefined
      const raw: Record<Channel, Buffer[]> = { stdout: [], stderr: [] }
      let finalized = false
      const finalizeOutput = (): unknown[] => {
        if (finalized) return []
        finalized = true
        const failures: unknown[] = []
        if (collected) for (const collector of [collected.stdout, collected.stderr]) {
          try { collector.finalize() } catch (cause) { failures.push(cause) }
        }
        return failures
      }
      let observerFailure: unknown
      let observerFailed = false
      let discardedAfterStop = 0
      let cancellation: Promise<ExecutionSettlement> | undefined
      let captureStopped = false
      const captureWaiters = new Set<() => void>()
      const stopCapture = () => {
        captureStopped = true
        for (const stop of captureWaiters) stop()
        captureWaiters.clear()
      }
      // Remove the stop subscription after every completed frame/write. Racing
      // each frame against one unresolved promise would retain every old waiter.
      const waitForCapture = <T>(pending: Promise<T>): Promise<T | undefined> => new Promise((resolve, reject) => {
        const stopped = () => resolve(undefined)
        if (captureStopped) stopped()
        else captureWaiters.add(stopped)
        void pending.then(value => { captureWaiters.delete(stopped); resolve(value) }, cause => { captureWaiters.delete(stopped); reject(cause) })
      })
      const iterator = handle.io.output[Symbol.asyncIterator]()
      const askStop = (reason: NonNullable<StreamMetadata["stopReason"]>) => {
        if (stop !== undefined) return
        stop = reason
        metadata && (metadata.stopReason = reason)
        cancellation = supervisor.cancel(execution.id, reason === "output-limit" ? "output-limit" : "cancelled")
        void cancellation.catch(() => {})
      }
      const consume = (async () => {
        while (!captureStopped) {
          const next = iterator.next()
          const item = await waitForCapture(next)
          if (item === undefined) {
            // A pending native read is still owned by the retained handle. Do
            // not request another frame or treat presentation stop as native EOF.
            break
          }
          if (item.done) break
          const frame = item.value
          if (frame.channel !== "stdout" && frame.channel !== "stderr") throw new Error("Pipe backend returned a PTY output frame")
          const channel: Channel = frame.channel
          const bytes = Buffer.from(frame.data)
          if (metadata) {
            metadata.bytesRead[channel] += bytes.length
            if (stop !== undefined) { discardedAfterStop += bytes.length; continue }
            const remaining = stream!.maxBytes - metadata.bytesAdmitted.stdout - metadata.bytesAdmitted.stderr
            const length = Math.min(remaining, bytes.length)
            if (length > 0) {
              const accepted = Buffer.from(bytes.subarray(0, length))
              metadata.bytesAdmitted[channel] += length
              if (channel === "stderr") raw.stderr.push(accepted)
              else try { if (stream!.onStdout(accepted) === "stop") askStop("consumer") }
                catch (cause) { observerFailed = true; observerFailure = cause; askStop("consumer") }
            }
            discardedAfterStop += bytes.length - length
            if (length < bytes.length || metadata.bytesAdmitted.stdout + metadata.bytesAdmitted.stderr === stream!.maxBytes) askStop("output-limit")
          } else {
            if (!collected) raw[channel].push(bytes)
            collected?.[channel].push(bytes)
          }
        }
      })().catch(async cause => {
        askStop("consumer")
        // Preserve for-await's iterator-close behavior for processing failures.
        // Settlement failure already requested return without awaiting native EOF.
        if (!captureStopped && iterator.return) {
          try { await iterator.return() }
          catch (cleanup) { throw new AggregateError([cause, cleanup], "Output consumption and iterator cleanup failed") }
        }
        throw cause
      })
      void consume.catch(() => {})
      const writeInput = (async () => {
        try {
          if (input?.length) for (let offset = 0; offset < input.length; offset += 16_384) {
            if (captureStopped) return
            await waitForCapture(handle.io.write(input.subarray(offset, Math.min(input.length, offset + 16_384))))
          }
          if (captureStopped) return
          await handle.io.endInput()
        } catch (cause) {
          if (!isEpipe(cause)) {
            cancellation = supervisor.cancel(execution.id, "cancelled")
            void cancellation.catch(() => {})
            throw cause
          }
        }
      })()
      void writeInput.catch(() => {})
      const output = () => ({
        stdout: collected?.stdout.snapshot() ?? { text: Buffer.concat(raw.stdout).toString("utf8"), truncated: false, spillPath: undefined, lossy: false },
        stderr: collected?.stderr.snapshot() ?? { text: Buffer.concat(raw.stderr).toString("utf8"), truncated: false, spillPath: undefined, lossy: false },
      })
      const complete = (async (): Promise<ExecResult> => {
        let failed = false
        let primary: unknown
        try {
          // Failed native settlement must stop presentation even if the native
          // channel stays open. The supervisor retains that handle for retries.
          const iteratorFailures: unknown[] = []
          const stopFailedCapture = () => {
            stopCapture()
            cancellation ??= supervisor.cancel(execution.id, "cancelled")
            void cancellation.catch(() => {})
            if (iterator.return) {
              // Async generators queue return behind next. Request closure and
              // observe it, but do not make capture depend on native EOF again.
              try { void Promise.resolve(iterator.return()).catch(cause => { iteratorFailures.push(cause) }) }
              catch (cause) { iteratorFailures.push(cause) }
            }
          }
          const settlement = handle.settled.then(result => {
            if (result.kind !== "settled") stopFailedCapture()
            return result
          }, cause => { stopFailedCapture(); throw cause })
          const outcomes = await Promise.allSettled([
            waitForCapture(handle.rootExited), settlement,
            consume, waitForCapture(writeInput),
          ] as const)
          const failures: unknown[] = observerFailed ? [observerFailure] : []
          for (const outcome of outcomes) if (outcome.status === "rejected" && !failures.includes(outcome.reason)) failures.push(outcome.reason)
          if (outcomes[1].status === "fulfilled" && outcomes[1].value.kind !== "settled") {
            failures.push(new Error(`Execution settlement incomplete: ${outcomes[1].value.detail}`))
          }
          // Spill ownership ends with stopped presentation, even if an ongoing
          // native cancellation still needs time to report its cleanup result.
          if (captureStopped) failures.push(...finalizeOutput())
          if (cancellation) try {
            const cancelled = await cancellation
            const initial = outcomes[1]
            if (cancelled.kind === "incomplete" && !(initial.status === "fulfilled" && initial.value.kind === "incomplete"
              && initial.value.phase === cancelled.phase && initial.value.detail === cancelled.detail)) {
              failures.push(new Error(`Execution cancellation incomplete: ${cancelled.detail}`))
            }
          } catch (cause) { if (!failures.includes(cause)) failures.push(cause) }
          for (const cause of iteratorFailures) if (!failures.includes(cause)) failures.push(cause)
          if (failures.length === 1) throw failures[0]
          if (failures.length > 1) throw new AggregateError(failures, "Execution and cleanup failed")
          const root = (outcomes[0] as PromiseFulfilledResult<RootExit>).value
          const { stdout: sOut, stderr: sErr } = output()
          const driverDiagnostics = handle.io.diagnostics?.()
          const discardedOutputBytes = discardedAfterStop + (driverDiagnostics?.discardedOutputBytes ?? 0)
          const result: ExecResult = {
            stdout: metadata ? "" : clean(sOut.text), stderr: clean(sErr.text), exitCode: unknownExit(root), timedOut: stop === "timeout",
            ...(metadata ? { stream: { ...metadata, ...(stop === undefined ? {} : { stopReason: stop }) } } : {}),
            ...(sOut.truncated || sErr.truncated ? { stdoutSpillPath: sOut.spillPath, stderrSpillPath: sErr.spillPath,
              truncated: { stdout: sOut.truncated, stderr: sErr.truncated } } : {}),
            ...(discardedOutputBytes || driverDiagnostics?.outputAbandoned ? { outputDiagnostics: {
              outputAbandoned: driverDiagnostics?.outputAbandoned ?? false, discardedOutputBytes,
            } } : {}),
          }
          if (!metadata) registerRetainedOutput(result, execOutputReader([sOut, sErr]))
          const runner = handle.runner
          if (stop !== "timeout" && result.exitCode !== 0 && runner?.runnerFailureRules.length && execution.policy.mode !== "danger-full-access") {
            const failure = classifyRunnerFailure({ exitCode: result.exitCode, stderr: { text: result.stderr } }, runner.runnerFailureRules)
            if (failure) throw new SandboxUnavailableError(execution.policy.mode, failure.detail, "command-not-run")
          }
          return result
        } catch (cause) {
          failed = true
          primary = cause
          throw cause
        } finally {
          if (timer !== undefined) clearTimeout(timer)
          command.abortSignal?.removeEventListener("abort", externalAbort)
          const cleanup = finalizeOutput()
          if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, "Execution output cleanup failed")
        }
      })()
      void complete.catch(() => {})
      return { execution, complete, output,
        diagnostics: () => handle.io.diagnostics?.() }
    }, cause => {
      if (timer !== undefined) clearTimeout(timer)
      command.abortSignal?.removeEventListener("abort", externalAbort)
      throw cause
    })
  }

  function view(job: Job): BackgroundJobView {
    const { stdout, stderr } = job.capture.output()
    const result: BackgroundJobView = {
      id: job.id, status: job.status, stdout: clean(stdout.text), stderr: clean(job.failure ?? stderr.text),
      ...(stdout.truncated || stderr.truncated ? { stdoutSpillPath: stdout.spillPath, stderrSpillPath: stderr.spillPath,
        truncated: { stdout: stdout.truncated, stderr: stderr.truncated } } : {}),
      owner: job.owner.sessionId, ...(job.owner.parentSessionId === undefined ? {} : { parentSessionId: job.owner.parentSessionId }),
      receipt: job.capture.execution.handle.receipt,
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
      ...(job.root === undefined ? {} : { root: job.root }),
      ...(job.settlement === undefined ? {} : { settlement: job.settlement }),
      ...(job.cleanupDetail === undefined ? {} : { cleanupDetail: job.cleanupDetail }),
      ...(job.capture.diagnostics() === undefined ? {} : { outputDiagnostics: job.capture.diagnostics() }),
    }
    registerRetainedOutput(result, execOutputReader([stdout, stderr]))
    return result
  }

  function registerJob(capture: Capture): string {
    const id = `bash-${++nextJob}`
    const job: Job = { id, capture, status: "running", owner: capture.execution.policy.owner }
    jobs.set(id, job)
    void capture.execution.handle.rootExited.then(root => { job.root = root }, cause => { job.failure = String(cause) })
    void capture.execution.handle.settled.then(settlement => {
      job.settlement = settlement
      if (settlement.kind === "incomplete") {
        job.status = "running"
        job.cleanupDetail = `${settlement.phase}: ${settlement.detail}`
      }
    }, cause => { job.status = "running"; job.cleanupDetail = String(cause) })
    void capture.complete.then(result => {
      job.exitCode = result.exitCode
      job.failure = undefined
      job.cleanupDetail = undefined
      job.status = result.timedOut ? "killed" : result.exitCode === 0 ? "completed" : "error"
    }, cause => {
      if (job.settlement?.kind === "incomplete" || job.cleanupDetail !== undefined) {
        job.status = "running"
        if (job.settlement?.kind === "incomplete") job.cleanupDetail = `${job.settlement.phase}: ${job.settlement.detail}`
      } else {
        job.failure = cause instanceof Error ? cause.message : String(cause)
        job.status = "error"
      }
    })
    return id
  }

  async function settledAfterRetirement(job: Job): Promise<boolean> {
    if (job.settlement?.kind === "settled") {
      job.cleanupDetail = undefined
      return true
    }
    // The supervisor removes entries only after the driver's full settlement.
    // Its observer can retire the entry before this job-view observer runs.
    if (supervisor.list().some(entry => entry.id === job.capture.execution.id)) return false
    const settlement = await job.capture.execution.handle.settled
    job.settlement = settlement
    if (settlement.kind !== "settled") {
      job.cleanupDetail = `${settlement.phase}: ${settlement.detail}`
      throw new Error("Execution owner retired an incomplete settlement")
    }
    job.cleanupDetail = undefined
    return true
  }

  async function run(command: ExecCommand, runOptions?: ExecRunOptions | ExecStreamRunOptions): Promise<ExecResult | PromotedRun> {
    validateInput(command)
    if (runOptions && "stream" in runOptions && runOptions.backgroundAfterMs !== undefined) throw new Error("stream cannot be combined with promotion")
    if (runOptions && "stream" in runOptions) {
      if (!Number.isSafeInteger(runOptions.stream.maxBytes) || runOptions.stream.maxBytes <= 0) throw new Error("stream maxBytes must be a positive safe integer")
      if (typeof runOptions.stream.onStdout !== "function") throw new Error("stream onStdout must be a function")
    }
    if (command.abortSignal?.aborted) {
      const metadata = runOptions && "stream" in runOptions
        ? { stream: { bytesRead: { stdout: 0, stderr: 0 }, bytesAdmitted: { stdout: 0, stderr: 0 }, stopReason: "aborted" as const } } : {}
      return { stdout: "", stderr: "", exitCode: -1, timedOut: false, ...metadata }
    }
    const streaming = runOptions && "stream" in runOptions ? runOptions : undefined
    const threshold = runOptions && "backgroundAfterMs" in runOptions ? runOptions.backgroundAfterMs : undefined
    const capture = await makeCapture(command, streaming, false, threshold !== undefined)
    if (threshold === undefined) return capture.complete
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const promoted = new Promise<PromotedRun>(resolve => {
      timer = setTimeout(() => resolve({ jobId: registerJob(capture), promoted: true, ranForegroundMs: Date.now() - started }), threshold)
    })
    return Promise.race([capture.complete, promoted]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
  }

  return {
    run: run as ExecService["run"],
    async runBackground(command) { const capture = await makeCapture(command, undefined, true); return { jobId: registerJob(capture) } },
    getOutput(jobId) {
      const job = jobs.get(jobId)
      if (!job || !canAccess(job.owner)) throw new Error(`unknown job: ${jobId}`)
      return view(job)
    },
    listJobs() {
      return [...jobs.values()].filter(job => canAccess(job.owner)).map(view)
    },
    async killJob(jobId) {
      const job = jobs.get(jobId)
      if (!job || !canAccess(job.owner)) throw new Error(`unknown job: ${jobId}`)
      if (await settledAfterRetirement(job)) return "already-finished"
      if (job.status !== "running" && job.settlement?.kind !== "incomplete") return "already-finished"
      let settlement: ExecutionSettlement
      try { settlement = await supervisor.cancel(job.capture.execution.id, "cancelled") }
      catch (cause) {
        if (await settledAfterRetirement(job)) return "already-finished"
        job.status = "running"
        job.cleanupDetail = cause instanceof Error ? cause.message : String(cause)
        throw cause
      }
      job.settlement = settlement
      if (settlement.kind !== "settled") {
        job.status = "running"
        job.cleanupDetail = `${settlement.phase}: ${settlement.detail}`
        throw new Error(`Execution cancellation incomplete: ${settlement.detail}`)
      }
      await job.capture.complete.catch(() => {})
      job.root = settlement.root
      job.exitCode = settlement.root.exitCode ?? -1
      job.failure = undefined
      job.cleanupDetail = undefined
      job.status = "killed"
      return "cancellation-requested"
    },
    launchTransport, cancelExecution,
    async dispose() { disposed = true; await supervisor.dispose(); await host.dispose?.() },
  }
}
