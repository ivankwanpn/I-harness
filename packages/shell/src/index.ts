import { existsSync } from "node:fs"
import { join } from "node:path"
import type { PluginContext } from "@i-harness/core-plugin"
import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { ExecService } from "@i-harness/exec"
import { registerExec } from "@i-harness/exec"
import { createTextRetainer, createSpillStore, spillNotice, type RetentionMode, type SpillStore, type SpillStoreOptions } from "@i-harness/output-retention"

export interface ResolvedShell {
  name: "bash" | "pwsh"
  argv: string[] // shell executable + mode flag(s)
}

// Windows: prefer bash if it exists on PATH, else pwsh (user decision).
// Detection is a synchronous PATH scan (bash.exe / bash). POSIX: bash.
export function resolveShell(): ResolvedShell {
  if (process.platform === "win32") {
    const bashOnPath =
      process.env.PATH?.split(";").some((p) => {
        if (!p) return false
        try {
          return existsSync(join(p, "bash.exe")) || existsSync(join(p, "bash"))
        } catch {
          return false
        }
      }) ?? false
    if (bashOnPath) return { name: "bash", argv: ["bash", "-c"] }
    return { name: "pwsh", argv: ["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] }
  }
  return { name: "bash", argv: ["bash", "-c"] }
}

// Minimal shell-quote parser: splits on whitespace, honors single/double
// quotes, and honors backslash escapes outside quotes and inside double
// quotes (F03-2 bypass shapes like `r\m`, `'r''m'`, `r""m`).
export function getArgv(command: string): string[] {
  const args: string[] = []
  let current = ""
  let inArg = false
  let quote: "'" | '"' | null = null
  let i = 0
  while (i < command.length) {
    const ch = command[i]!
    if (quote === null) {
      if (ch === "'" || ch === '"') {
        quote = ch
        inArg = true
        i++
        continue
      }
      if (ch === "\\") {
        current += command[i + 1] ?? ""
        inArg = true
        i += 2
        continue
      }
      if (ch === " " || ch === "\t" || ch === "\n") {
        if (inArg) {
          args.push(current)
          current = ""
          inArg = false
        }
        i++
        continue
      }
      current += ch
      inArg = true
      i++
    } else if (ch === quote) {
      quote = null
      i++
    } else if (ch === "\\" && quote === '"') {
      current += command[i + 1] ?? ""
      i += 2
    } else {
      current += ch
      i++
    }
  }
  if (inArg) args.push(current)
  return args
}

export interface ShellRetentionOptions {
  maxBytes?: number // default 64_000
  mode?: RetentionMode
  // M21 B 層：truncated 時把完整輸出寫 spill + 併 notice（additive——不設=同前）
  spill?: SpillStoreOptions
}

export interface ShellToolDeps {
  exec: ExecService
  timeoutMs?: number // declared on bash/pwsh tools; drives guard-timeout
  retention?: ShellRetentionOptions
  // M16 final-review (C1): when set, every bash/pwsh execution carries this
  // policy so exec confines at spawn. Absent → no sandbox field (passthrough,
  // pre-M16 behavior).
  sandboxPolicy?: import("@i-harness/sandbox").SandboxExecutionPolicy
}

export function createShellTools(deps: ShellToolDeps): Tool[] {
  // Retention is OPT-IN: without `deps.retention` the tools behave exactly as
  // before. The resolved retainer here is only the "configured" flag — the
  // per-run helper builds FRESH retainers because they are one-accumulation
  // stateful objects (never reused across calls).
  const retention = deps.retention
    ? createTextRetainer({ maxBytes: deps.retention.maxBytes ?? 64_000, mode: deps.retention.mode })
    : null
  // spillStore 一次建、跨呼叫重用（寫檔無狀態；root 固定）
  const spillStore: SpillStore | undefined = deps.retention?.spill ? createSpillStore(deps.retention.spill) : undefined

  // Apply retention at the tool-return layer only: exec keeps the full stream.
  // The `truncated` marker is present ONLY when something was omitted.
  async function retainedRunResult(result: { stdout: string; stderr: string; exitCode: number }) {
    if (retention === null) return { stdout: result.stdout, exitCode: result.exitCode } // 現有 shape 不變
    const so = createTextRetainer({ maxBytes: deps.retention!.maxBytes ?? 64_000, mode: deps.retention!.mode })
    const se = createTextRetainer({ maxBytes: deps.retention!.maxBytes ?? 64_000, mode: deps.retention!.mode })
    so.push(result.stdout)
    se.push(result.stderr)
    const rs = so.finish()
    const re = se.finish()
    const truncated = rs.truncated || re.truncated
    let stdout = rs.text
    if (truncated && spillStore) {
      // 完整內容 = result.stdout（retain 前）——spill 檔保留全量
      const spillPath = await spillStore.saveText(result.stdout, "bash-stdout")
      stdout = rs.text + "\n" + spillNotice(rs.omittedBytes, spillPath)
    }
    return {
      stdout,
      stderr: re.text,
      exitCode: result.exitCode,
      ...(truncated ? { truncated: { stdoutBytes: rs.omittedBytes, stderrBytes: re.omittedBytes } } : {}),
    }
  }
  // execute: `return retainedRunResult(result)`——async fn 回 promise 自動展平（既有呼叫面不變）

  const bash: Tool<{ command: string; background?: boolean }, { stdout?: string; exitCode?: number; job_id?: string }> = {
    name: "bash",
    description: "run a bash command (background: true returns a job id instead of waiting)",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, background: { type: "boolean" } },
      required: ["command"],
    },
    timeoutMs: deps.timeoutMs,
    getArgv: (args: { command: string }) => getArgv(args.command),
    // Hardcoded bash argv: a tool NAMED bash must run bash, never the platform
    // default shell (resolveShell can return pwsh on Windows without bash).
    // If bash is absent, exec.run exits -1 (fail-loud) rather than silently
    // executing PowerShell.
    execute: async (args: { command: string; background?: boolean }, exec: ToolExec) => {
      const argv = ["bash", "-c", args.command]
      if (args.background === true) {
        const { jobId } = deps.exec.runBackground({ argv, ...(deps.sandboxPolicy ? { sandbox: deps.sandboxPolicy } : {}) })
        return { job_id: jobId }
      }
      const result = await deps.exec.run({ argv, abortSignal: exec.abortSignal, ...(deps.sandboxPolicy ? { sandbox: deps.sandboxPolicy } : {}) })
      return retainedRunResult(result)
    },
  }
  const pwsh: Tool<{ command: string; background?: boolean }, { stdout?: string; exitCode?: number; job_id?: string }> = {
    name: "pwsh",
    description: "run a PowerShell command (background: true returns a job id instead of waiting)",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, background: { type: "boolean" } },
      required: ["command"],
    },
    timeoutMs: deps.timeoutMs,
    getArgv: (args: { command: string }) => getArgv(args.command),
    execute: async (args: { command: string; background?: boolean }, exec: ToolExec) => {
      const argv = ["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", args.command]
      if (args.background === true) {
        const { jobId } = deps.exec.runBackground({ argv, ...(deps.sandboxPolicy ? { sandbox: deps.sandboxPolicy } : {}) })
        return { job_id: jobId }
      }
      const result = await deps.exec.run({ argv, abortSignal: exec.abortSignal, ...(deps.sandboxPolicy ? { sandbox: deps.sandboxPolicy } : {}) })
      return retainedRunResult(result)
    },
  }
  return [bash, pwsh]
}

export function registerShell(
  ctx: PluginContext,
  registry: { register(t: Tool): void },
  opts?: {
    timeoutMs?: number
    retention?: ShellRetentionOptions
    sandbox?: import("@i-harness/sandbox").SandboxProvider
    sandboxPolicy?: import("@i-harness/sandbox").SandboxExecutionPolicy
  },
): void {
  registerExec(ctx, { sandbox: opts?.sandbox })
  const exec = ctx.services.get<ExecService>("exec/service")
  for (const tool of createShellTools({ exec, timeoutMs: opts?.timeoutMs, retention: opts?.retention, sandboxPolicy: opts?.sandboxPolicy })) registry.register(tool)
}
