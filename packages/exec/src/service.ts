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
import { OutputCollector } from "./spill.ts"
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
  text(): { stdout: string; stderr: string }
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

function defaultHost(workspaceRoot: string, legacyArgvProvider = false): ExecExecutionHost {
  const backends = createLocalExecutionBackends({ windowsSelection: process.env.IH_WINDOWS_SANDBOX === "psec" ? "psec" : "legacy" })
  const authority = Object.freeze({ kind: "unbound" as const, revision: "standalone-workspace", workspaceRoot })
  return {
    defaultOwner: Object.freeze({ sessionId: "standalone-exec" }),
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
  const host = options.execution ?? defaultHost(resolve(options.workspaceRoot ?? process.cwd()), options.sandbox !== undefined)
  const supervisor = host.supervisor ?? createExecutionSupervisor()
  const jobs = new Map<string, Job>()
  let nextJob = 0
  let disposed = false

  function caller(): Readonly<ExecutionOwner> {
    const owner = currentExecCaller() ?? host.defaultOwner
    if (!owner?.sessionId) throw new Error("Execution caller scope is missing")
    return Object.freeze({ sessionId: owner.sessionId, ...(owner.parentSessionId === undefined ? {} : { parentSessionId: owner.parentSessionId }) })
  }

  function launchTransport(request: ExecTransportRequest): Promise<SupervisedExecution> {
    try {
      if (disposed) throw new Error("Exec service disposed")
      const owner = caller()
      const policy = host.resolvePolicy(owner, request.sandbox)
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
    if (!execution || execution.policy.owner.sessionId !== caller().sessionId) return Promise.reject(new Error("Unknown execution for caller"))
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
    const launch = launchTransport(request)
    return launch.then(execution => {
      if (command.timeoutMs !== undefined) timer = setTimeout(() => {
        stop ??= "timeout"; signal.abort("timeout")
      }, command.timeoutMs)
      const { handle } = execution
      const stream = optionsForRun?.stream
      const metadata: StreamMetadata | undefined = stream ? { bytesRead: { stdout: 0, stderr: 0 }, bytesAdmitted: { stdout: 0, stderr: 0 } } : undefined
      const collected = options.spill && !stream && !background ? {
        stdout: new OutputCollector({ maxBytes: options.spill.maxOutputBytes ?? 64_000, maxSpillBytes: options.spill.maxSpillBytes, spillRoot: options.spill.spillRoot, label: "stdout" }),
        stderr: new OutputCollector({ maxBytes: options.spill.maxOutputBytes ?? 64_000, maxSpillBytes: options.spill.maxSpillBytes, spillRoot: options.spill.spillRoot, label: "stderr" }),
      } : undefined
      const raw: Record<Channel, Buffer[]> = { stdout: [], stderr: [] }
      let observerFailure: unknown
      let discardedAfterStop = 0
      let cancellation: Promise<ExecutionSettlement> | undefined
      const askStop = (reason: NonNullable<StreamMetadata["stopReason"]>) => {
        if (stop !== undefined) return
        stop = reason
        metadata && (metadata.stopReason = reason)
        cancellation = supervisor.cancel(execution.id, reason === "output-limit" ? "output-limit" : "cancelled")
        void cancellation.catch(() => {})
      }
      const consume = (async () => {
        for await (const frame of handle.io.output) {
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
                catch (cause) { observerFailure = cause; askStop("consumer") }
            }
            discardedAfterStop += bytes.length - length
            if (length < bytes.length || metadata.bytesAdmitted.stdout + metadata.bytesAdmitted.stderr === stream!.maxBytes) askStop("output-limit")
          } else {
            if (!collected || promotable) raw[channel].push(bytes)
            collected?.[channel].push(bytes)
          }
        }
      })()
      const writeInput = (async () => {
        try {
          if (input?.length) for (let offset = 0; offset < input.length; offset += 16_384) {
            await handle.io.write(input.subarray(offset, Math.min(input.length, offset + 16_384)))
          }
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
      const complete = (async (): Promise<ExecResult> => {
        try {
          const root = await handle.rootExited
          const settlement = await handle.settled
          await consume
          await writeInput
          if (cancellation) await cancellation
          if (settlement.kind !== "settled") throw new Error(`Execution settlement incomplete: ${settlement.detail}`)
          if (observerFailure !== undefined) throw observerFailure
          const sOut = collected?.stdout.finalize() ?? { text: Buffer.concat(raw.stdout).toString("utf8"), truncated: false, spillPath: undefined, lossy: false }
          const sErr = collected?.stderr.finalize() ?? { text: Buffer.concat(raw.stderr).toString("utf8"), truncated: false, spillPath: undefined, lossy: false }
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
        } finally {
          if (timer !== undefined) clearTimeout(timer)
          command.abortSignal?.removeEventListener("abort", externalAbort)
        }
      })()
      void complete.catch(() => {})
      return { execution, complete, text: () => ({ stdout: Buffer.concat(raw.stdout).toString("utf8"), stderr: Buffer.concat(raw.stderr).toString("utf8") }),
        diagnostics: () => handle.io.diagnostics?.() }
    }, cause => {
      if (timer !== undefined) clearTimeout(timer)
      command.abortSignal?.removeEventListener("abort", externalAbort)
      throw cause
    })
  }

  function view(job: Job): BackgroundJobView {
    const text = job.capture.text()
    return {
      id: job.id, status: job.status, stdout: clean(text.stdout), stderr: clean(job.failure ?? text.stderr),
      owner: job.owner.sessionId, ...(job.owner.parentSessionId === undefined ? {} : { parentSessionId: job.owner.parentSessionId }),
      receipt: job.capture.execution.handle.receipt,
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
      ...(job.root === undefined ? {} : { root: job.root }),
      ...(job.settlement === undefined ? {} : { settlement: job.settlement }),
      ...(job.cleanupDetail === undefined ? {} : { cleanupDetail: job.cleanupDetail }),
      ...(job.capture.diagnostics() === undefined ? {} : { outputDiagnostics: job.capture.diagnostics() }),
    }
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
      if (!job || job.owner.sessionId !== caller().sessionId) throw new Error(`unknown job: ${jobId}`)
      return view(job)
    },
    listJobs() {
      const owner = caller().sessionId
      return [...jobs.values()].filter(job => job.owner.sessionId === owner).map(view)
    },
    async killJob(jobId) {
      const job = jobs.get(jobId)
      if (!job || job.owner.sessionId !== caller().sessionId) throw new Error(`unknown job: ${jobId}`)
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
