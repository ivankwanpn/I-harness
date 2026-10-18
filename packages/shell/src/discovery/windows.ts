import { existsSync, realpathSync } from "node:fs"
import { win32 } from "node:path"
import { spawnSync } from "node:child_process"
import { environmentValue } from "./environment.ts"

function onWindowsPath(name: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  for (const entry of environmentValue(env, "PATH")?.split(";") ?? []) {
    const directory = entry.trim().replace(/^"|"$/g, "")
    if (!directory || name === "bash.exe" && ["system32", "windowsapps"].includes(win32.basename(directory).toLowerCase())) continue
    const candidate = win32.join(directory, name)
    try { if (exists(candidate)) return candidate } catch { /* continue past inaccessible PATH entries */ }
  }
  return undefined
}

function probePowerShellAlias(path: string): boolean {
  // App Execution Aliases may be launchable while Node's existsSync is false.
  // Probe only the known pwsh alias, never arbitrary executables from the model.
  const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true })
  return result.status === 0 && /^PowerShell 7(?:\.|\s|$)/.test(result.stdout.trim())
}

export function powerShellExecutableAvailable(path: string, exists: (path: string) => boolean = existsSync, probe = exists === existsSync ? probePowerShellAlias : () => false, canonicalize: (path: string) => string = exists === existsSync ? realpathSync.native : path => path): boolean {
  try {
    // Native execution must resolve the executable's identity before launch.
    // An unreadable Store alias can never be launched by our native backend.
    // Reject it before the synchronous availability probe, which otherwise
    // launches PowerShell on every prompt and shell discovery boundary.
    return !!canonicalize(path) && (exists(path) || /[\\/]Microsoft[\\/]WindowsApps[\\/]pwsh\.exe$/i.test(path) && probe(path))
  } catch { return false }
}

/** M59: is `bash` resolvable on this host? The bash TOOL must never silently
 * run another shell — but a bare spawn-fail (exitCode -1, EMPTY stdout AND
 * stderr) left the model flailing across bash / pwsh / terminal_open on a
 * Windows box without Git Bash. The tool now answers legibly instead. */
export function resolveBashExe(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (platform !== "win32") return "bash"
  const git = onWindowsPath("git.exe", env, exists)
  const candidates = [
    win32.join(environmentValue(env, "ProgramFiles") ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    win32.join(environmentValue(env, "ProgramFiles(x86)") ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    ...(git ? [win32.resolve(win32.dirname(git), "..", "bin", "bash.exe"), win32.resolve(win32.dirname(git), "..", "..", "bin", "bash.exe")] : []),
  ]
  return candidates.find(exists) ?? onWindowsPath("bash.exe", env, exists) ?? onWindowsPath("bash", env, exists)
}

export function bashAvailable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return resolveBashExe(env, platform, exists) !== undefined
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
  exists: (path: string) => boolean = existsSync,
  probe: (path: string) => boolean = exists === existsSync ? probePowerShellAlias : () => false,
  canonicalize: (path: string) => string = exists === existsSync ? realpathSync.native : path => path,
): string {
  if (platform !== "win32") return "pwsh"
  const onPath = onWindowsPath("pwsh.exe", env, (path) => powerShellExecutableAvailable(path, exists, probe, canonicalize))
  if (onPath) return onPath
  const installed = win32.join(environmentValue(env, "ProgramFiles") ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe")
  if (powerShellExecutableAvailable(installed, exists, probe, canonicalize)) return installed
  const root = environmentValue(env, "SystemRoot") ?? environmentValue(env, "windir") ?? "C:\\Windows"
  const windowsPowerShell = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  return powerShellExecutableAvailable(windowsPowerShell, exists, probe, canonicalize) ? windowsPowerShell : "powershell"
}
