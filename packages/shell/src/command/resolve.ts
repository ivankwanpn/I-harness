import { existsSync } from "node:fs"
import type { ResolvedShell, ResolvedAgentShell } from "../types.ts"
import { resolveBashExe, resolvePwshExe } from "../discovery/windows.ts"
import { shellCommandEnvironment } from "../discovery/environment.ts"

/** Immutable trusted Linux binding. Paths for file tools remain Windows paths. */
export function resolveWslAgentShell(options: { distribution: string; networkAccess: boolean; workspaceDependencies: boolean; runtimePath?: readonly string[] }, workspacePath?: string): ResolvedAgentShell {
  const captured = Object.freeze({ ...options, ...(options.runtimePath ? { runtimePath: Object.freeze([...options.runtimePath]) } : {}) })
  return Object.freeze({ id: `wsl:${captured.distribution}`, label: `Linux Bash (WSL2 ${captured.distribution})`, command: "/bin/bash", dialect: "posix",
    executionTarget: "wsl", env: Object.freeze({ PATH: [...(captured.runtimePath ?? []), "/usr/bin", "/bin"].join(":"), LANG: "C" }),
    executionContext: JSON.stringify(captured), ...(workspacePath ? { workspacePath } : {}) })
}
export function capturedShell(shell: ResolvedAgentShell): ResolvedAgentShell {
  return Object.freeze({ ...shell, ...(shell.env === undefined ? {} : { env: Object.freeze({ ...shell.env }) }) })
}
export function boundShellEnvironment(shell: ResolvedAgentShell) {
  return shell.executionTarget === "wsl" ? { executionTarget: "wsl" as const, env: { ...(shell.env ?? { PATH: "/usr/bin:/bin", LANG: "C" }) } }
    : shellCommandEnvironment(shell.command)
}
export function shellFlags(shell: ResolvedAgentShell): string[] {
  return shell.dialect === "powershell" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
    : shell.dialect === "cmd" ? ["/d", "/s", "/c"] : shell.executionTarget === "wsl" ? ["--noprofile", "--norc", "-c"] : ["-c"]
}

export function agentShellPrompt(shell: ResolvedAgentShell): string {
  if (shell.executionTarget === "wsl") return `Agent Shell: ${shell.label} (${shell.command}). Use POSIX syntax and Linux paths. ${shell.workspacePath ? `Linux workspace: ${shell.workspacePath}. ` : "The Windows workspace is mapped by WSL at launch. "}File tools continue to use Windows workspace paths. Captured WSL options: ${shell.executionContext}. Background jobs are root-bound: descendants are cleaned up when the root command exits. The pwsh and native terminal tools run on the Windows host with their own sandbox capabilities. Settings changes apply to new assemblies.`
  const syntax = shell.dialect === "powershell" ? "PowerShell syntax (cmdlets, $variables, backtick escaping)"
    : shell.dialect === "cmd" ? "Windows CMD syntax (%VARIABLES%, caret escaping)"
      : "POSIX shell syntax"
  return `Agent Shell: ${shell.label} (${shell.command}). Use the shell tool for command execution with ${syntax}. ` +
    "The bash and pwsh tools remain explicit alternatives for their own dialects. New commands read the current preference; a command already prepared or running retains its executable."
}

// Windows: prefer installed Git Bash, then another native Bash, else pwsh.
// `System32/bash.exe` and `WindowsApps/bash.exe` launch WSL; they do not obey
// the native cwd and `pwd -W` contract of this tool. Return the chosen absolute
// executable so spawning cannot silently resolve the earlier launcher again.
export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): ResolvedShell {
  if (platform === "win32") {
    const bashExe = resolveBashExe(env, platform, exists)
    if (bashExe) return { name: "bash", argv: [bashExe, "-c"] }
    return { name: "pwsh", argv: [resolvePwshExe(env, platform, exists), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] }
  }
  return { name: "bash", argv: ["bash", "-c"] }
}
