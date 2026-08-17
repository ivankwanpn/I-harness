import { spawn, type ChildProcess } from "node:child_process"
import type { PluginContext } from "@i-harness/core-plugin"

export interface ExecCommand {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  input?: string
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

function spawnChild(cmd: ExecCommand): SpawnHandle {
  const child = spawn(cmd.argv[0]!, cmd.argv.slice(1), {
    cwd: cmd.cwd,
    env: { ...process.env, ...cmd.env },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  let timedOut = false
  let settled = false
  let resolveDone!: (v: { exitCode: number; stdout: string; stderr: string; timedOut: boolean }) => void
  const done = new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((res) => { resolveDone = res })

  const timer = cmd.timeoutMs !== undefined ? setTimeout(async () => {
    timedOut = true
    if (process.platform === "win32") {
      await new Promise<void>((res) => {
        const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"])
        k.on("close", () => res())
        k.on("error", () => res())
      })
    } else {
      try { process.kill(-child.pid!, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch { /* ignore */ } }
    }
  }, cmd.timeoutMs) : null

  child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8") })
  child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8") })
  if (cmd.input !== undefined) child.stdin?.write(cmd.input)
  child.stdin?.end()

  function doneFn(code: number) {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    resolveDone({
      stdout: stdout.replace(/\r\n/g, "\n"),
      stderr: stderr.replace(/\r\n/g, "\n"),
      exitCode: code,
      timedOut,
    })
  }
  child.on("close", (code) => doneFn(code ?? -1))
  child.on("error", () => doneFn(-1))

  return {
    child,
    kill() {
      if (process.platform === "win32") {
        const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"])
        k.on("error", () => { /* ignore */ })
      } else {
        try { process.kill(-child.pid!, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch { /* ignore */ } }
      }
    },
    done,
  }
}

export interface ExecService {
  run(cmd: ExecCommand): Promise<ExecResult>
  runBackground(cmd: ExecCommand): { jobId: string }
  getOutput(jobId: string): BackgroundJobView
  killJob(jobId: string): "cancellation-requested" | "already-finished"
}

export function createExecService(): ExecService {
  let bashCounter = 0
  const jobs = new Map<string, BackgroundJobView & { handle: SpawnHandle }>()

  return {
    run(cmd: ExecCommand): Promise<ExecResult> {
      const h = spawnChild(cmd)
      return h.done.then(({ stdout, stderr, exitCode, timedOut }) => ({ stdout, stderr, exitCode, timedOut }))
    },
    runBackground(cmd: ExecCommand): { jobId: string } {
      bashCounter += 1
      const jobId = `bash-${bashCounter}`
      const handle = spawnChild(cmd)
      jobs.set(jobId, { id: jobId, status: "running", stdout: "", stderr: "", handle })
      handle.done.then(({ stdout, stderr, exitCode, timedOut }) => {
        const job = jobs.get(jobId)
        if (!job || job.status !== "running") return
        job.stdout = stdout
        job.stderr = stderr
        job.exitCode = exitCode
        job.status = timedOut ? "killed" : exitCode === 0 ? "completed" : "error"
      })
      return { jobId }
    },
    getOutput(jobId: string): BackgroundJobView {
      const job = jobs.get(jobId)
      if (!job) throw new Error(`unknown job: ${jobId}`)
      return { id: job.id, status: job.status, stdout: job.stdout, stderr: job.stderr, ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}) }
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

export function registerExec(ctx: PluginContext): void {
  ctx.services.register("exec/service", createExecService())
}
