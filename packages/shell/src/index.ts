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
    return { name: "pwsh", argv: [resolvePwshExe(), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] }
  }
  return { name: "bash", argv: ["bash", "-c"] }
}

/**
 * M59: the PowerShell executable the `pwsh` tool spawns.
 *
 * PowerShell 7 (`pwsh`) when it is on PATH; otherwise Windows PowerShell 5.1
 * — `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, which ships
 * with every supported Windows. Hardcoding `pwsh` made the tool spawn-fail
 * (exitCode -1, EMPTY stdout AND stderr) on machines without PS7 — the model
 * saw a silent failure and flailed across pwd / Get-Location / terminal_open.
 * Both editions accept the same -NoLogo -NoProfile -NonInteractive -Command.
 *
 * The env/platform parameters exist for tests (both are read once, defaulting
 * to the process values).
 */
export function resolvePwshExe(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return "pwsh"
  const onPath = (exe: string): boolean =>
    env.PATH?.split(";").some((p) => {
      if (!p) return false
      try {
        return existsSync(join(p, exe))
      } catch {
        return false
      }
    }) ?? false
  if (onPath("pwsh.exe")) return "pwsh"
  const root = env.SystemRoot ?? env.windir ?? "C:\\Windows"
  const windowsPowerShell = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  return existsSync(windowsPowerShell) ? windowsPowerShell : "powershell"
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
  // D1 (m55): the working directory for every shell execution — the assembly
  // workspace. Absent → no cwd field, so exec keeps its own contract (the
  // child inherits the parent process cwd).
  cwd?: string
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
  // label: per-tool spill 檔前綴（bash → "bash-stdout"、pwsh → "pwsh-stdout"）。
  // M21 A/B bridge：exec 層若啟用 spill，超限輸出已落檔且 `stdout` 只回 tail。
  // 此處的 retainer 只看到 tail（通常 ≤ 預算）→ 自身判 truncated:false；若不
  // 橋接 exec 的截斷狀態，A+B 同開會「静默截斷、無 notice」。因此輸入型別吃進
  // exec 的 stdoutSpillPath/truncated：任一標記視同截斷；有 exec spill 檔時
  // notice 直接指向該檔（完整原文已在），絕不再重複寫一份 shell spill。
  async function retainedRunResult(
    result: {
      stdout: string
      stderr: string
      exitCode: number
      stdoutSpillPath?: string
      truncated?: { stdout: boolean; stderr: boolean }
    },
    label: string,
  ) {
    if (retention === null) return { stdout: result.stdout, exitCode: result.exitCode } // 現有 shape 不變
    const so = createTextRetainer({ maxBytes: deps.retention!.maxBytes ?? 64_000, mode: deps.retention!.mode })
    const se = createTextRetainer({ maxBytes: deps.retention!.maxBytes ?? 64_000, mode: deps.retention!.mode })
    so.push(result.stdout)
    se.push(result.stderr)
    const rs = so.finish()
    const re = se.finish()
    // 截斷判定＝exec 層（spill 落檔或明確標記）與 retainer 層取聯集。
    const execTruncated = result.truncated?.stdout === true || result.stdoutSpillPath !== undefined
    const truncated = execTruncated || rs.truncated || re.truncated
    let stdout = rs.text
    // Spill 檔優先用 exec 既有的（完整原文）；否則僅在 retainer 自身截斷 stdout
    // 且有設定 store 時寫一份。只在「真省略」時加 notice——僅 stderr 截斷時
    // stdout 原樣（未被省略），spill/notice 反而會把未截斷的 stdout 加上
    // "(Omitted 0 bytes…)"。
    const spillPathForNotice =
      result.stdoutSpillPath ??
      (rs.truncated && spillStore ? await spillStore.saveText(result.stdout, label) : undefined)
    if (spillPathForNotice !== undefined && (rs.truncated || execTruncated)) {
      // exec tail-only 時完整省略位元組數未知（exec 只回 tail）→ 以 0 標記並指向
      // 完整 spill 檔；retainer 自身截斷則回報精確省略數。
      const omittedForNotice = rs.truncated ? rs.omittedBytes : execTruncated ? 0 : 0
      stdout = rs.text + "\n" + spillNotice(omittedForNotice, spillPathForNotice)
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
        const { jobId } = deps.exec.runBackground({ argv, ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}), ...(deps.sandboxPolicy ? { sandbox: deps.sandboxPolicy } : {}) })
        return { job_id: jobId }
      }
      const result = await deps.exec.run({ argv, abortSignal: exec.abortSignal, ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}), ...(deps.sandboxPolicy ? { sandbox: deps.sandboxPolicy } : {}) })
      return retainedRunResult(result, "bash-stdout")
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
      const argv = [resolvePwshExe(), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", args.command]
      if (args.background === true) {
        const { jobId } = deps.exec.runBackground({ argv, ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}), ...(deps.sandboxPolicy ? { sandbox: deps.sandboxPolicy } : {}) })
        return { job_id: jobId }
      }
      const result = await deps.exec.run({ argv, abortSignal: exec.abortSignal, ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}), ...(deps.sandboxPolicy ? { sandbox: deps.sandboxPolicy } : {}) })
      return retainedRunResult(result, "pwsh-stdout")
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
    /** D1 (m55): assembly workspace — the default cwd for bash/pwsh. */
    cwd?: string
  },
): void {
  registerExec(ctx, { sandbox: opts?.sandbox })
  const exec = ctx.services.get<ExecService>("exec/service")
  for (const tool of createShellTools({ exec, timeoutMs: opts?.timeoutMs, retention: opts?.retention, sandboxPolicy: opts?.sandboxPolicy, ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}) })) registry.register(tool)
}
