import { spawn, type ChildProcess } from "node:child_process"
import type { PluginContext } from "@i-harness/core-plugin"
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxPolicy, SandboxProvider } from "@i-harness/sandbox"
import { assertSandboxCapable, SandboxUnavailableError, classifyRunnerFailure } from "@i-harness/sandbox"
import { OutputCollector } from "./spill.ts"
export { launchExecution } from "./execution-admission.ts"
import { execOutputReader, registerRetainedOutput } from './retained-output.ts'
export { registerRetainedOutput, retainedOutputReader } from './retained-output.ts'

export interface ExecCommand {
  argv: string[]
  /** CMD /s /c needs its command string preserved rather than C-runtime quoting. */
  windowsVerbatimArguments?: boolean
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  input?: string
  /** Byte-preserving stdin for fixed bounded helpers; at most 2 MiB, including
   * deterministic UTF8 derived from at most 1 MiB of Latin1 file bytes.
   * Mutually exclusive with the legacy string input. */
  inputBytes?: Uint8Array
  abortSignal?: AbortSignal // NEW: external cancel → kill the process tree
  sandbox?: SandboxExecutionPolicy // M16: command-carried policy
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  // M21 A-tier spill: present only on runs where something was actually
  // truncated. `stdout`/`stderr` keep tail semantics — they are always the
  // in-memory tail or full output; the complete content lives in the spill file.
  stdoutSpillPath?: string
  stderrSpillPath?: string
  truncated?: { stdout: boolean; stderr: boolean }
  stream?: {
    bytesRead: { stdout: number; stderr: number }
    bytesAdmitted: { stdout: number; stderr: number }
    stopReason?: "consumer" | "output-limit" | "aborted" | "timeout"
  }
}

export interface ExecStreamRunOptions {
  stream: { maxBytes: number; onStdout(chunk: Buffer): void | "stop" }
  backgroundAfterMs?: never
}

// M21 A-tier spill knobs (memory-tail threshold + optional disk-spill cap).
export interface ExecSpillOptions {
  maxOutputBytes?: number // default 64_000
  maxSpillBytes?: number
  spillRoot?: string
}

// W10: the second `run` overload's options. Deliberately NOT exported — every
// caller passes an object literal (`run(cmd, { backgroundAfterMs: n })`), and
// the only reader that needs the shape NAMED is the overload set itself.
interface ExecRunOptions {
  /** Hand the command back as a background job (still running, its output
   * still accumulating) if it has not finished within this many ms, instead of
   * waiting for it. A caller must supply a value WELL UNDER the deadline it
   * imposes on the same command (the shell's `timeoutMs` → guard-timeout →
   * exec's process-tree kill): at or above the deadline this never fires,
   * because the command is killed first — the exact death W10 exists to avoid.
   * Absent → the run is an ordinary foreground wait. */
  backgroundAfterMs?: number
}

/** W10: the OTHER way a promotion-capable `run` can end — the command outlived
 * `backgroundAfterMs` and was handed back as a job instead of a result.
 *
 * Why a union and not an `ExecResult` with a flag: this is not a finished
 * command. There is no exit code, and the output is not final — a caller that
 * saw an ordinary result shape here would read a still-running command as a
 * completed one. `promoted: true` is the discriminator and it is never
 * something the caller asked for in so many words; it is what the harness did
 * to a call the caller made in the foreground. */
export interface PromotedRun {
  /** The job record — already live in this service's registry at the moment of
   * the hand-back, so `getOutput` / `listJobs` (and the model-facing
   * `job_output` / `job_list`) find it. Same id space as `runBackground`. */
  jobId: string
  /** Always true. Not a peer of `background: true` on the tool surface: the
   * model did not choose this, the harness did. */
  promoted: true
  /** How long the command ran in the foreground before the hand-back (≥ the
   * threshold, modulo timer scheduling). */
  ranForegroundMs: number
}

// Deps for createExecService/registerExec. Both optional; adding `spill`
// switches foreground run() capture over to OutputCollector spilling.
export interface ExecServiceOptions {
  sandbox?: SandboxProvider
  spill?: ExecSpillOptions
}

const DEFAULT_MAX_OUTPUT_BYTES = 64_000

export type BackgroundJobStatus = "running" | "completed" | "killed" | "error"
export interface BackgroundJobView {
  id: string
  status: BackgroundJobStatus
  stdout: string
  stderr: string
  exitCode?: number
  // M49 Task 12 review: run-level attribution — the session id (or owner key)
  // that STARTED this job through a session's tool surface. Additive/optional:
  // non-session starters (panels, CLI one-shots without a session) leave it
  // undefined, and the per-session task projection attributes rows by it.
  owner?: string
}

interface SpawnHandle {
  child: ChildProcess
  kill(): void
  // Same members as ExecResult (spill fields attach conditionally at resolve
  // time) — structurally assignable to ExecResult so run() can return h.done.
  done: Promise<ExecResult>
  // W10: the text captured SO FAR. A foreground promotion seeds the job record
  // with it (see registerJob): the output the command produced BEFORE the
  // hand-back is the job's output too, not something the model loses. With
  // spill configured this is the collector's in-memory tail — the exact text
  // the foreground result would have carried for that phase.
  text(): { stdout: string; stderr: string }
}

// M16 final-review (I3): the result of confine() is kept on the handle so the
// done path can translate a runner failure (bwrap exec-refusal, exit 125 with
// "bwrap: failed to ...") into SandboxUnavailableError instead of surfacing it
// as an ordinary command failure. `mode` is the narrowed ConfinedSandboxMode
// (confined is only ever produced for confined policies).
interface ResolvedSpawn {
  confined?: ConfinedArgv
  mode?: import("@i-harness/sandbox").ConfinedSandboxMode
}

// Kill the entire process tree of `child`. Shared by the timeout timer, the
// returned kill(), and the external abort listener — one implementation, three
// call sites. Windows uses taskkill /T /F; elsewhere we signal the process
// group (-pid) and fall back to a direct child SIGKILL.
function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return Promise.resolve()
  if (process.platform === "win32") {
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`
    return new Promise((resolve) => {
      const k = spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      k.on("error", () => { try { child.kill() } catch { /* already closed */ } })
      k.on("close", () => resolve())
    })
  } else {
    try { process.kill(-child.pid!, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch { /* ignore */ } }
  }
  return Promise.resolve()
}

function validateInput(cmd: ExecCommand): void {
  if (cmd.input !== undefined && cmd.inputBytes !== undefined) throw new Error("input and inputBytes are mutually exclusive")
  if (cmd.inputBytes !== undefined && (!(cmd.inputBytes instanceof Uint8Array) || cmd.inputBytes.byteLength > 2 * 1024 * 1024)) throw new Error("inputBytes must be bytes bounded to 2 MiB")
}

// The seam types SandboxPolicy as confined-only (mode ≠ danger-full-access),
// while ExecCommand.sandbox is the request-side SandboxExecutionPolicy (which
// may be danger-full-access, resolved by the policy owner in Task 3). A runtime
// type predicate is the sound way to narrow it to the provider contract.
function isConfinedPolicy(sandbox: SandboxExecutionPolicy): sandbox is SandboxPolicy {
  return sandbox.mode !== "danger-full-access"
}

// M16: confine at spawn. No policy → passthrough; danger-full-access →
// passthrough; confined policy but no provider → fail closed (throw). This is
// a deliberate sandbox boundary: a command with a confined policy must never
// run unconfined just because a backend is missing.
// M16 final-review (I3): keep the ConfinedArgv (denialSignatures,
// runnerFailureRules, enforcement) so the spawn/done path can translate a
// runner failure into SandboxUnavailableError (legible + spec-conformant)
// instead of an ordinary command failure.
function resolveArgv(cmd: ExecCommand, sandboxProvider?: SandboxProvider): ResolvedSpawn {
  if (cmd.sandbox === undefined) return {}
  const sandbox = cmd.sandbox
  if (!isConfinedPolicy(sandbox)) return {} // passthrough
  if (sandboxProvider === undefined) {
    // Names the MOUNT, not the constructor: `createExecService` is module-private
    // as of 2026-09-18, so pointing a reader at it would send them somewhere they
    // cannot go. The mirror in packages/shell/test/sandbox-refusal.test.ts:44 is
    // a fake that reproduces this string and moves with it.
    throw new SandboxUnavailableError(sandbox.mode, "no sandbox provider composed (registerExec(ctx, { sandbox }))")
  }
  // M22 enforcement gate: a policy that demands read isolation must never run
  // on a backend that does not (or cannot) declare it — refuse to run, fail closed.
  assertSandboxCapable(sandbox, sandboxProvider)
  const confined = sandboxProvider.confine(cmd.argv, sandbox)
  return { confined, mode: sandbox.mode }
}

function spawnChild(cmd: ExecCommand, sandboxProvider?: SandboxProvider, spill?: ExecSpillOptions): SpawnHandle {
  validateInput(cmd)
  const { confined, mode } = resolveArgv(cmd, sandboxProvider)
  const argv = confined?.argv ?? cmd.argv
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: cmd.cwd,
    env: { ...process.env, ...cmd.env },
    stdio: ["pipe", "pipe", "pipe"],
    // A sandbox wrapper owns its own argv contract. CMD's verbatim request
    // must never change how a replacement runner's arguments are quoted.
    windowsVerbatimArguments: cmd.windowsVerbatimArguments === true && argv[0] === cmd.argv[0],
  })
  let stdout = ""
  let stderr = ""
  // M21 A-tier spill: when configured, capture through OutputCollector (memory
  // tail + complete-stream disk spill). Otherwise keep plain string accumulation
  // — byte-identical to the pre-spill behavior.
  const maxOut = spill?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const stdoutCollector = spill ? new OutputCollector({ maxBytes: maxOut, maxSpillBytes: spill.maxSpillBytes, spillRoot:spill.spillRoot, label: "stdout" }) : undefined
  const stderrCollector = spill ? new OutputCollector({ maxBytes: maxOut, maxSpillBytes: spill.maxSpillBytes, spillRoot:spill.spillRoot, label: "stderr" }) : undefined
  let timedOut = false
  let settled = false
  let resolveDone!: (v: ExecResult) => void
  let rejectDone!: (err: Error) => void
  const done = new Promise<ExecResult>((res, rej) => { resolveDone = res; rejectDone = rej })

  const timer = cmd.timeoutMs !== undefined ? setTimeout(() => {
    timedOut = true
    killTree(child)
  }, cmd.timeoutMs) : null

  // External cancel: kill the process tree when the signal fires. If it was
  // already aborted before spawn, kill immediately. An abort is NOT a timeout
  // — timedOut stays false so callers see the real (killed) exitCode.
  const abortListener = () => killTree(child)
  if (cmd.abortSignal) {
    if (cmd.abortSignal.aborted) abortListener()
    else cmd.abortSignal.addEventListener("abort", abortListener, { once: true })
  }

  child.stdout?.on("data", (d: Buffer) => { if (stdoutCollector) stdoutCollector.push(d); else stdout += d.toString("utf-8") })
  child.stderr?.on("data", (d: Buffer) => { if (stderrCollector) stderrCollector.push(d); else stderr += d.toString("utf-8") })
  child.stdin?.on("error", () => { /* A command may close stdin early. */ })
  if (cmd.input !== undefined) child.stdin?.write(cmd.input)
  if (cmd.inputBytes !== undefined) child.stdin?.write(cmd.inputBytes)
  child.stdin?.end()

  function doneFn(code: number) {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    // Leak hygiene: drop the abort listener once the process settles before
    // the abort ever fires (the `once` flag already handles the fired case).
    cmd.abortSignal?.removeEventListener("abort", abortListener)
    // M21 A-tier spill: collect retained text (+ complete-stream spill files)
    // once the process settles. Without collectors this falls back to the exact
    // pre-spill accumulation path (byte-identical).
    const sOut = stdoutCollector ? stdoutCollector.finalize() : { text: stdout, spillPath: undefined, truncated: false, lossy: false }
    const sErr = stderrCollector ? stderrCollector.finalize() : { text: stderr, spillPath: undefined, truncated: false, lossy: false }
    const cleanOut = sOut.text.replace(/\r\n/g, "\n")
    const cleanErr = sErr.text.replace(/\r\n/g, "\n")
    // M16 final-review (I3): a runner failure (e.g. bwrap exit 125 with
    // "bwrap: failed to ..." — user namespaces blocked) is NOT an ordinary
    // command failure: the sandbox runner itself could not start. Translate it
    // into SandboxUnavailableError (spec-conformant, legible) so consumers see
    // "sandbox unavailable" instead of a confusing nonzero exit. The child
    // exited with the runner's code but the denial-signature scanner never ran
    // (the command body itself never executed).
    // If spill was enabled, already-written spill files stay behind as orphans
    // on this reject path — accepted by Task 6's design note.
    if (!timedOut && code !== 0 && confined && mode !== undefined && confined.runnerFailureRules.length > 0) {
      const failure = classifyRunnerFailure(
        { exitCode: code, stderr: { text: cleanErr } },
        confined.runnerFailureRules,
      )
      if (failure) {
        rejectDone(new SandboxUnavailableError(mode, failure.detail, "command-not-run"))
        return
      }
    }
    const result: ExecResult = {
      stdout: cleanOut,
      stderr: cleanErr,
      exitCode: code,
      timedOut,
      // Spill fields only surface when something actually overflowed — an
      // under-limit run with spill configured reports nothing extra.
      ...(sOut.truncated || sErr.truncated ? {
        stdoutSpillPath: sOut.spillPath,
        stderrSpillPath: sErr.spillPath,
        truncated: { stdout: sOut.truncated, stderr: sErr.truncated },
      } : {}),
    }
    registerRetainedOutput(result, execOutputReader([sOut,sErr]))
    resolveDone(result)
  }
  child.on("close", (code) => doneFn(code ?? -1))
  child.on("error", () => doneFn(-1))

  return {
    child,
    kill() { killTree(child) },
    done,
    text() {
      // W10: with spill the retained text lives in the collectors; without it,
      // in the plain accumulators `doneFn` finalizes. Either way this is the
      // RAW text: the job record it seeds holds the raw concatenation too, and
      // `jobView` normalizes over the WHOLE string on read — the one rule
      // `doneFn` applies to a foreground run. Normalizing here, or chunk by
      // chunk in the taps, is the F2 leak: a CRLF split across two `data`
      // events is in neither chunk, so it stays `"\r\n"` in the job view while
      // the foreground result folds it.
      return stdoutCollector !== undefined && stderrCollector !== undefined
        ? { stdout: stdoutCollector.peek(), stderr: stderrCollector.peek() }
        : { stdout, stderr }
    },
  }
}

/** Opt-in foreground path: admit raw bytes before parsing or retaining them.
 * Stopping drains/discards pipes and awaits both child close and tree cleanup. */
async function runStream(cmd: ExecCommand, options: ExecStreamRunOptions, sandboxProvider?: SandboxProvider): Promise<ExecResult> {
  validateInput(cmd)
  const { maxBytes, onStdout } = options.stream
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("stream maxBytes must be a positive safe integer")
  if (typeof onStdout !== "function") throw new Error("stream onStdout must be a function")
  if (options.backgroundAfterMs !== undefined) throw new Error("stream cannot be combined with promotion")
  const { confined, mode } = resolveArgv(cmd, sandboxProvider)
  const metadata: NonNullable<ExecResult["stream"]> = { bytesRead: { stdout: 0, stderr: 0 }, bytesAdmitted: { stdout: 0, stderr: 0 } }
  if (cmd.abortSignal?.aborted) return { stdout: "", stderr: "", exitCode: -1, timedOut: false, stream: { ...metadata, stopReason: "aborted" } }
  const argv = confined?.argv ?? cmd.argv
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: cmd.cwd, env: { ...process.env, ...cmd.env }, stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32", windowsHide: true,
    windowsVerbatimArguments: cmd.windowsVerbatimArguments === true && argv[0] === cmd.argv[0],
  })
  const stderr: Buffer[] = []
  let observerError: unknown
  let failedObserver = false
  let cleanup: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (reason: NonNullable<ExecResult["stream"]>["stopReason"]) => {
    if (metadata.stopReason !== undefined) return
    metadata.stopReason = reason
    if (timer !== undefined) clearTimeout(timer)
    cleanup = killTree(child)
  }
  const abort = () => stop("aborted")
  if (cmd.timeoutMs !== undefined) timer = setTimeout(() => stop("timeout"), cmd.timeoutMs)
  cmd.abortSignal?.addEventListener("abort", abort, { once: true })
  const admit = (kind: "stdout" | "stderr", chunk: Buffer) => {
    metadata.bytesRead[kind] += chunk.byteLength
    if (metadata.stopReason !== undefined) return
    const remaining = maxBytes - metadata.bytesAdmitted.stdout - metadata.bytesAdmitted.stderr
    const length = Math.min(remaining, chunk.byteLength)
    if (length > 0) {
      const bytes = Buffer.from(chunk.subarray(0, length))
      metadata.bytesAdmitted[kind] += length
      if (kind === "stderr") stderr.push(bytes)
      else {
        try { if (onStdout(bytes) === "stop") stop("consumer") }
        catch (error) { observerError = error; failedObserver = true; stop("consumer") }
      }
    }
    if (length < chunk.byteLength || metadata.bytesAdmitted.stdout + metadata.bytesAdmitted.stderr === maxBytes) stop("output-limit")
  }
  child.stdout?.on("data", (b: Buffer) => admit("stdout", b))
  child.stderr?.on("data", (b: Buffer) => admit("stderr", b))
  child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && !failedObserver) { observerError = error; failedObserver = true; stop("consumer") }
  })
  child.stdin?.end(cmd.inputBytes ?? cmd.input)
  // Spawn errors also emit close. Wait for close because exit alone leaves pipes live.
  child.on("error", () => { /* close supplies the failed exit below */ })
  const code = await new Promise<number>((resolve) => child.once("close", (exitCode) => resolve(exitCode ?? -1)))
  if (timer !== undefined) clearTimeout(timer)
  cmd.abortSignal?.removeEventListener("abort", abort)
  await cleanup
  if (failedObserver) throw observerError
  const cleanErr = Buffer.concat(stderr).toString("utf8").replace(/\r\n/g, "\n")
  if (metadata.stopReason !== "timeout" && code !== 0 && confined && mode !== undefined) {
    const failure = classifyRunnerFailure({ exitCode: code, stderr: { text: cleanErr } }, confined.runnerFailureRules)
    if (failure) throw new SandboxUnavailableError(mode, failure.detail, "command-not-run")
  }
  return { stdout: "", stderr: cleanErr, exitCode: code, timedOut: metadata.stopReason === "timeout", stream: metadata }
}

export interface ExecService {
  /** Foreground run: spawn once, wait for the command, return its result. */
  run(cmd: ExecCommand): Promise<ExecResult>
  run(cmd: ExecCommand, opts: ExecStreamRunOptions): Promise<ExecResult>
  /** W10 promotion overload: ONE spawn that can go either way. With
   * `backgroundAfterMs` set, a command still running at the threshold is
   * REGISTERED as a background job — it keeps running, its output keeps
   * accumulating, and `getOutput`/`killJob` reach it — and this call resolves
   * with `PromotedRun` instead of waiting. A command that finishes first
   * resolves with the ordinary `ExecResult`, exactly as the overload above.
   *
   * The two overloads are the whole point: every existing caller keeps the
   * non-promoting contract unmodified, so promotion is a thing a caller OPTS
   * INTO and can never happen to a call that did not ask. */
  run(cmd: ExecCommand, opts: ExecRunOptions): Promise<ExecResult | PromotedRun>
  runBackground(cmd: ExecCommand): { jobId: string }
  getOutput(jobId: string): BackgroundJobView
  listJobs(): BackgroundJobView[]
  killJob(jobId: string): "cancellation-requested" | "already-finished"
}

// NOT exported (2026-09-18): the production path is `registerExec`, and every
// other caller was a test. Making it private is what forces tests through the
// mount they would meet in production — `registerExec` returns the service so
// that costs a rename rather than a rewrite.
function createExecService(deps?: ExecServiceOptions): ExecService {
  let bashCounter = 0
  const jobs = new Map<string, BackgroundJobView & { handle: SpawnHandle }>()
  const provider = deps?.sandbox
  // The one place a job record becomes a view. CRLF normalization happens HERE,
  // over the whole accumulated text, because that is what the foreground path
  // does (`doneFn` replaces over the full string): a pair split across two
  // `data` events folds in both views, and neither can disagree about a stream
  // the model reads through `job_output`. `owner` is not copied, as before —
  // the per-session projection reads it from its own registry.
  const jobView = (job: BackgroundJobView & { handle: SpawnHandle }): BackgroundJobView => ({
    id: job.id,
    status: job.status,
    stdout: job.stdout.replace(/\r\n/g, "\n"),
    stderr: job.stderr.replace(/\r\n/g, "\n"),
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
  })
  // M21 A-tier spill is foreground-only: run() spills via OutputCollector while
  // runBackground keeps plain stream-observable accumulation into job.stdout.
  // A PROMOTED run is the one case where a job was spawned WITH spill (its
  // foreground phase may still finish under the threshold and must then return
  // today's spill-aware result). Its job view stays stream-observable like any
  // other job — see registerJob for what happens to `done`'s tail there.
  const spill = deps?.spill

  // W10: ONE registration path for the two ways a job can start — an explicit
  // `runBackground` and a foreground promotion. The record is seeded with the
  // text the handle has ALREADY captured, so a promoted job's view does not
  // begin at the moment of the hand-back with the first N ms of output missing.
  // (For a fresh `runBackground` handle the seed is empty: no data can have
  // arrived between the spawn in the same tick and this line.) With spill
  // configured the seed is the collector's memory TAIL — the same text the
  // foreground phase itself would have reported in memory, with the complete
  // stream in that phase's spill file.
  //
  // The record holds the RAW text and `jobView` normalizes on read, ON PURPOSE:
  // a CRLF can be SPLIT across two `data` events ("A\r" now, "\nB" later), and
  // normalizing chunk by chunk cannot fold a pair that is in neither chunk —
  // measured, the job view leaked `"A\r\nB"` where the foreground result had
  // `"A\nB"` (test/exec.test.ts, "split across two chunks"). Whole-string
  // normalization is exactly what `doneFn` does to a foreground run, so the two
  // views of the same stream agree.
  function registerJob(handle: SpawnHandle): string {
    bashCounter += 1
    const jobId = `bash-${bashCounter}`
    const seed = handle.text()
    const job: BackgroundJobView & { handle: SpawnHandle } = {
      id: jobId,
      status: "running",
      stdout: seed.stdout,
      stderr: seed.stderr,
      handle,
    }
    jobs.set(jobId, job)
    handle.child.stdout?.on("data", (d: Buffer) => { job.stdout += d.toString("utf-8") })
    handle.child.stderr?.on("data", (d: Buffer) => { job.stderr += d.toString("utf-8") })
    handle.done.then(
      ({ exitCode, timedOut }) => {
        const j = jobs.get(jobId)
        if (!j || j.status !== "running") return
        // ONLY the outcome lands here. The taps above are the job's text, and
        // they are the COMPLETE stream by construction; `done`'s stdout/stderr
        // are the memory TAIL when the spawn carried spill, so writing them
        // back would silently DROP bytes a promoted job had already
        // accumulated. (`done` holds the whole-string-normalized text, but not
        // the whole text — the taps have to stay the source, with the same
        // normalization applied by jobView.)
        j.exitCode = exitCode
        j.status = timedOut ? "killed" : exitCode === 0 ? "completed" : "error"
      },
      // M16 final-review (I3): a runner-failure rejection (SandboxUnavailableError)
      // must land as an errored job, not an unhandled rejection.
      (err: Error) => {
        const j = jobs.get(jobId)
        if (!j || j.status !== "running") return
        j.stderr = err.message
        j.status = "error"
      },
    )
    return jobId
  }

  // W10: the promotion overload's body. `handle.done` and the threshold timer
  // race; whichever lands first decides the shape the caller gets, and the
  // spawn is the SAME one either way — nothing is re-run and nothing is thrown
  // away. A rejected `done` (SandboxUnavailableError) still rejects this call,
  // exactly as it does on the plain overload.
  //
  // `async` is load-bearing, and it is the one contract the overloads MUST keep
  // identical: `spawnChild` can throw SYNCHRONOUSLY (a confined policy with no
  // backend, M22's capability gate), and every existing caller meets that as a
  // rejected promise — `await expect(exec.run(...)).rejects`. A plain function
  // returning `handle.done` would let the same failure escape synchronously
  // instead, i.e. change `run`'s contract for callers that never opted in.
  function runImpl(cmd: ExecCommand): Promise<ExecResult>
  function runImpl(cmd: ExecCommand, opts: ExecStreamRunOptions): Promise<ExecResult>
  function runImpl(cmd: ExecCommand, opts: ExecRunOptions): Promise<ExecResult | PromotedRun>
  async function runImpl(cmd: ExecCommand, opts?: ExecRunOptions | ExecStreamRunOptions): Promise<ExecResult | PromotedRun> {
    if (opts !== undefined && "stream" in opts) return runStream(cmd, opts, provider)
    const handle = spawnChild(cmd, provider, spill)
    const backgroundAfterMs = opts?.backgroundAfterMs
    // Return the promise directly — mapping out four fields would drop the
    // optional M21 spill fields (stdoutSpillPath/stderrSpillPath/truncated).
    if (backgroundAfterMs === undefined) return handle.done
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const promoted = new Promise<PromotedRun>((resolve) => {
      timer = setTimeout(() => {
        resolve({ jobId: registerJob(handle), promoted: true, ranForegroundMs: Date.now() - started })
      }, backgroundAfterMs)
    })
    // `finally`, not a success path: a foreground that finished under the
    // threshold (or a rejection) must not leave the promotion timer pending.
    return Promise.race([handle.done, promoted]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  return {
    run: runImpl,
    runBackground(cmd: ExecCommand): { jobId: string } {
      // No spill for background jobs (M21 scope: foreground run only) —
      // background semantics stay stream-observable via job.stdout/stderr.
      return { jobId: registerJob(spawnChild(cmd, provider)) }
    },
    getOutput(jobId: string): BackgroundJobView {
      const job = jobs.get(jobId)
      if (!job) throw new Error(`unknown job: ${jobId}`)
      return jobView(job)
    },
    listJobs(): BackgroundJobView[] {
      return [...jobs.values()].map(jobView)
    },
    killJob(jobId: string): "cancellation-requested" | "already-finished" {
      const job = jobs.get(jobId)
      if (!job) throw new Error(`unknown job: ${jobId}`)
      if (job.status !== "running") return "already-finished"
      job.handle.kill()
      job.status = "killed"
      return "cancellation-requested"
    },
  }
}

/** Mount the exec service and RETURN it.
 *
 * The return is what lets `createExecService` stop being exported: its only
 * non-production callers were tests, and a test that wants an isolated service
 * can now go through the mount it would meet in production rather than around
 * it. Returning void forced every one of them to reach past the seam. */
export function registerExec(ctx: PluginContext, deps?: ExecServiceOptions): ExecService {
  const service = createExecService(deps)
  ctx.services.register("exec/service", service)
  return service
}
