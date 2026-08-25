import { spawn, type ChildProcess } from "node:child_process"
import type { PluginContext } from "@i-harness/core-plugin"
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxPolicy, SandboxProvider } from "@i-harness/sandbox"
import { SandboxUnavailableError, classifyRunnerFailure } from "@i-harness/sandbox"

export interface ExecCommand {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  input?: string
  abortSignal?: AbortSignal // NEW: external cancel → kill the process tree
  sandbox?: SandboxExecutionPolicy // M16: command-carried policy
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export type BackgroundJobStatus = "running" | "completed" | "killed" | "error"
export interface BackgroundJobView {
  id: string
  status: BackgroundJobStatus
  stdout: string
  stderr: string
  exitCode?: number
}

interface SpawnHandle {
  child: ChildProcess
  kill(): void
  done: Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>
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
function killTree(child: ChildProcess): void {
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"])
    k.on("error", () => { /* ignore */ })
  } else {
    try { process.kill(-child.pid!, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch { /* ignore */ } }
  }
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
    throw new SandboxUnavailableError(sandbox.mode, "no sandbox provider composed (createExecService({ sandbox }))")
  }
  const confined = sandboxProvider.confine(cmd.argv, sandbox)
  return { confined, mode: sandbox.mode }
}

function spawnChild(cmd: ExecCommand, sandboxProvider?: SandboxProvider): SpawnHandle {
  const { confined, mode } = resolveArgv(cmd, sandboxProvider)
  const argv = confined?.argv ?? cmd.argv
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: cmd.cwd,
    env: { ...process.env, ...cmd.env },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  let timedOut = false
  let settled = false
  let resolveDone!: (v: { exitCode: number; stdout: string; stderr: string; timedOut: boolean }) => void
  let rejectDone!: (err: Error) => void
  const done = new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((res, rej) => { resolveDone = res; rejectDone = rej })

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

  child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8") })
  child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8") })
  if (cmd.input !== undefined) child.stdin?.write(cmd.input)
  child.stdin?.end()

  function doneFn(code: number) {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    // Leak hygiene: drop the abort listener once the process settles before
    // the abort ever fires (the `once` flag already handles the fired case).
    cmd.abortSignal?.removeEventListener("abort", abortListener)
    const cleanStderr = stderr.replace(/\r\n/g, "\n")
    // M16 final-review (I3): a runner failure (e.g. bwrap exit 125 with
    // "bwrap: failed to ..." — user namespaces blocked) is NOT an ordinary
    // command failure: the sandbox runner itself could not start. Translate it
    // into SandboxUnavailableError (spec-conformant, legible) so consumers see
    // "sandbox unavailable" instead of a confusing nonzero exit. The child
    // exited with the runner's code but the denial-signature scanner never ran
    // (the command body itself never executed).
    if (!timedOut && code !== 0 && confined && mode !== undefined && confined.runnerFailureRules.length > 0) {
      const failure = classifyRunnerFailure(
        { exitCode: code, stderr: { text: cleanStderr } },
        confined.runnerFailureRules,
      )
      if (failure) {
        rejectDone(new SandboxUnavailableError(mode, failure.detail))
        return
      }
    }
    resolveDone({
      stdout: stdout.replace(/\r\n/g, "\n"),
      stderr: cleanStderr,
      exitCode: code,
      timedOut,
    })
  }
  child.on("close", (code) => doneFn(code ?? -1))
  child.on("error", () => doneFn(-1))

  return {
    child,
    kill() { killTree(child) },
    done,
  }
}

export interface ExecService {
  run(cmd: ExecCommand): Promise<ExecResult>
  runBackground(cmd: ExecCommand): { jobId: string }
  getOutput(jobId: string): BackgroundJobView
  listJobs(): BackgroundJobView[]
  killJob(jobId: string): "cancellation-requested" | "already-finished"
}

export function createExecService(deps?: { sandbox?: SandboxProvider }): ExecService {
  let bashCounter = 0
  const jobs = new Map<string, BackgroundJobView & { handle: SpawnHandle }>()
  const provider = deps?.sandbox

  return {
    async run(cmd: ExecCommand): Promise<ExecResult> {
      const h = spawnChild(cmd, provider)
      return h.done.then(({ stdout, stderr, exitCode, timedOut }) => ({ stdout, stderr, exitCode, timedOut }))
    },
    runBackground(cmd: ExecCommand): { jobId: string } {
      bashCounter += 1
      const jobId = `bash-${bashCounter}`
      const handle = spawnChild(cmd, provider)
      const job: BackgroundJobView & { handle: SpawnHandle } = { id: jobId, status: "running", stdout: "", stderr: "", handle }
      jobs.set(jobId, job)
      handle.child.stdout?.on("data", (d: Buffer) => { job.stdout += d.toString("utf-8").replace(/\r\n/g, "\n") })
      handle.child.stderr?.on("data", (d: Buffer) => { job.stderr += d.toString("utf-8").replace(/\r\n/g, "\n") })
      handle.done.then(
        ({ stdout, stderr, exitCode, timedOut }) => {
          const j = jobs.get(jobId)
          if (!j || j.status !== "running") return
          j.stdout = stdout
          j.stderr = stderr
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
      return { jobId }
    },
    getOutput(jobId: string): BackgroundJobView {
      const job = jobs.get(jobId)
      if (!job) throw new Error(`unknown job: ${jobId}`)
      return { id: job.id, status: job.status, stdout: job.stdout, stderr: job.stderr, ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}) }
    },
    listJobs(): BackgroundJobView[] {
      return [...jobs.values()].map((j) => ({ id: j.id, status: j.status, stdout: j.stdout, stderr: j.stderr, ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}) }))
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

export function registerExec(ctx: PluginContext, deps?: { sandbox?: SandboxProvider }): void {
  ctx.services.register("exec/service", createExecService(deps))
}
