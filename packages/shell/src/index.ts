import { existsSync } from "node:fs"
import { join } from "node:path"
import type { PluginContext } from "@i-harness/core-plugin"
import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { ExecService } from "@i-harness/exec"
import { registerExec } from "@i-harness/exec"

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

export interface ShellToolDeps {
  exec: ExecService
}

export function createShellTools(deps: ShellToolDeps): Tool[] {
  const bash: Tool<{ command: string }, { stdout: string; exitCode: number }> = {
    name: "bash",
    description: "run a bash command",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    getArgv: (args: { command: string }) => getArgv(args.command),
    execute: async (args: { command: string }, _exec: ToolExec) => {
      const shell = resolveShell()
      const result = await deps.exec.run({ argv: [...shell.argv, args.command] })
      return { stdout: result.stdout, exitCode: result.exitCode }
    },
  }
  const pwsh: Tool<{ command: string }, { stdout: string; exitCode: number }> = {
    name: "pwsh",
    description: "run a PowerShell command",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    getArgv: (args: { command: string }) => getArgv(args.command),
    execute: async (args: { command: string }, _exec: ToolExec) => {
      const result = await deps.exec.run({
        argv: ["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", args.command],
      })
      return { stdout: result.stdout, exitCode: result.exitCode }
    },
  }
  return [bash, pwsh]
}

export function registerShell(ctx: PluginContext, registry: { register(t: Tool): void }): void {
  registerExec(ctx)
  const exec = ctx.services.get<ExecService>("exec/service")
  for (const tool of createShellTools({ exec })) registry.register(tool)
}
