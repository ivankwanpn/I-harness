import { spawn } from "node:child_process"
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

export interface ExecService {
  run(cmd: ExecCommand): Promise<ExecResult>
}

export function createExecService(): ExecService {
  return {
    run(cmd: ExecCommand): Promise<ExecResult> {
      return new Promise((resolve) => {
        const child = spawn(cmd.argv[0]!, cmd.argv.slice(1), {
          cwd: cmd.cwd,
          env: { ...process.env, ...cmd.env },
          stdio: ["pipe", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        let timedOut = false
        let settled = false

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

        function done(code: number) {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          // normalize line endings
          resolve({ stdout: stdout.replace(/\r\n/g, "\n"), stderr: stderr.replace(/\r\n/g, "\n"), exitCode: code, timedOut })
        }

        child.on("close", (code) => done(code ?? -1))
        child.on("error", () => done(-1))
      })
    },
  }
}

export function registerExec(ctx: PluginContext): void {
  ctx.services.register("exec/service", createExecService())
}
