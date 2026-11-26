import { existsSync } from "node:fs"
import { basename, posix, win32 } from "node:path"
import { resolvePwshExe } from "@i-harness/shell"

export type ShellProfile = { id: string; label: string; command: string; args: string[] }
export type ShellEnvironment = { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; exists: (path: string) => boolean }
export const AUTO_SHELL_LABEL = "自動選擇"
const posixShells = ["bash", "zsh", "sh"]

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const name = Object.keys(env).find((entry) => entry.toLowerCase() === key.toLowerCase())
  return name ? env[name] : undefined
}

function onPath(name: string, options: ShellEnvironment): string | undefined {
  for (const entry of envValue(options.env, "PATH")?.split(options.platform === "win32" ? win32.delimiter : posix.delimiter) ?? []) {
    const directory = entry.trim().replace(/^"|"$/g, "")
    if (!directory) continue
    if (name.toLowerCase() === "bash.exe" && ["system32", "windowsapps"].includes(basename(directory).toLowerCase())) continue
    const candidate = options.platform === "win32" ? win32.join(directory, name) : posix.join(directory, name)
    try { if (options.exists(candidate)) return candidate } catch { /* malformed or inaccessible PATH entry */ }
  }
  return undefined
}

function posixShellProfile(options: ShellEnvironment, id: string): ShellProfile | undefined {
  if (id === "auto") {
    const defaultShell = envValue(options.env, "SHELL")
    const fallback = defaultShell && posix.isAbsolute(defaultShell) && options.exists(defaultShell) ? defaultShell : "/bin/sh"
    return { id, label: AUTO_SHELL_LABEL, command: fallback, args: ["-i"] }
  }
  if (!posixShells.includes(id)) return undefined
  const command = onPath(id, options)
  return command ? { id, label: id, command, args: ["-i"] } : undefined
}

function windowsRoot(options: ShellEnvironment): string {
  return envValue(options.env, "SystemRoot") ?? "C:\\Windows"
}

export function windowsCommandPath(options: ShellEnvironment): string {
  return envValue(options.env, "ComSpec") ?? win32.join(windowsRoot(options), "System32", "cmd.exe")
}

function windowsGitBash(options: ShellEnvironment): string | undefined {
  const installed = [
    win32.join(envValue(options.env, "ProgramFiles") ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    win32.join(envValue(options.env, "ProgramFiles(x86)") ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
  ].find(options.exists)
  if (installed) return installed
  const gitExe = onPath("git.exe", options)
  if (!gitExe) return undefined
  return [
    win32.resolve(win32.dirname(gitExe), "..", "bin", "bash.exe"),
    win32.resolve(win32.dirname(gitExe), "..", "..", "bin", "bash.exe"),
  ].find(options.exists)
}

function windowsShellProfile(options: ShellEnvironment, id: string, gitBash = () => windowsGitBash(options)): ShellProfile | undefined {
  switch (id) {
    case "git-bash": {
      const command = gitBash()
      return command ? { id, label: "Git Bash", command, args: ["-i"] } : undefined
    }
    case "bash": {
      const command = onPath("bash.exe", options)
      return command && command.toLowerCase() !== gitBash()?.toLowerCase() ? { id, label: "Bash (PATH)", command, args: ["-i"] } : undefined
    }
    case "pwsh": {
      const command = resolvePwshExe(options.env, options.platform, options.exists)
      return win32.basename(command).toLowerCase() === "pwsh.exe" ? { id, label: "PowerShell 7", command, args: ["-NoLogo", "-NoProfile"] } : undefined
    }
    case "powershell": {
      const command = win32.join(windowsRoot(options), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      return options.exists(command) ? { id, label: "Windows PowerShell", command, args: ["-NoLogo", "-NoProfile"] } : undefined
    }
    case "cmd": {
      const command = windowsCommandPath(options)
      return command && options.exists(command) ? { id, label: "CMD", command, args: [] } : undefined
    }
    default: return undefined
  }
}

/** Resolve one explicit profile, or the POSIX default, using the live host. */
export function shellProfile(options: ShellEnvironment, id: string): ShellProfile | undefined {
  return options.platform === "win32" ? windowsShellProfile(options, id) : posixShellProfile(options, id)
}

export function shellProfiles(options: ShellEnvironment): ShellProfile[] {
  if (options.platform !== "win32") {
    return ["auto", ...posixShells].map(id => posixShellProfile(options, id)).filter(profile => profile !== undefined)
  }
  const pwsh = windowsShellProfile(options, "pwsh")
  const gitBash = windowsShellProfile(options, "git-bash")
  const bash = windowsShellProfile(options, "bash", () => gitBash?.command)
  const cmd = windowsShellProfile(options, "cmd")
  const powershell = windowsShellProfile(options, "powershell")
  const profiles = [gitBash, bash, pwsh, powershell, cmd].filter(profile => profile !== undefined)
  const defaultProfile = gitBash ?? cmd ?? pwsh ?? powershell ?? bash
  return defaultProfile ? [{ ...defaultProfile, id: "auto", label: AUTO_SHELL_LABEL }, ...profiles] : []
}

export function listDesktopTerminalShellOptions(environment: Partial<ShellEnvironment> = {}) {
  const options: ShellEnvironment = { env: environment.env ?? process.env, platform: environment.platform ?? process.platform, exists: environment.exists ?? existsSync }
  return shellProfiles(options).map(({ id, label, command }) => ({ id, label, command }))
}
