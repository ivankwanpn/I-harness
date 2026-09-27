import { existsSync } from "node:fs"
import { basename, posix, win32 } from "node:path"

export type ShellProfile = { id: string; label: string; command: string; args: string[] }
export type ShellEnvironment = { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; exists: (path: string) => boolean }

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

export function shellProfiles(options: ShellEnvironment): ShellProfile[] {
  if (options.platform !== "win32") {
    const defaultShell = envValue(options.env, "SHELL")
    const fallback = defaultShell && posix.isAbsolute(defaultShell) && options.exists(defaultShell) ? defaultShell : "/bin/sh"
    const profiles: ShellProfile[] = [{ id: "auto", label: "自動選擇", command: fallback, args: ["-i"] }]
    for (const name of ["bash", "zsh", "sh"]) {
      const command = onPath(name, options)
      if (command) profiles.push({ id: name, label: name, command, args: ["-i"] })
    }
    return profiles
  }
  const root = envValue(options.env, "SystemRoot") ?? "C:\\Windows"
  const powerShell = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const pwsh = onPath("pwsh.exe", options)
  const gitExe = onPath("git.exe", options)
  const gitBash = [
    win32.join(envValue(options.env, "ProgramFiles") ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    win32.join(envValue(options.env, "ProgramFiles(x86)") ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    ...(gitExe ? [
      win32.resolve(win32.dirname(gitExe), "..", "bin", "bash.exe"),
      win32.resolve(win32.dirname(gitExe), "..", "..", "bin", "bash.exe"),
    ] : []),
  ].find(options.exists)
  const pathBash = onPath("bash.exe", options)
  const cmdCandidate = envValue(options.env, "ComSpec") ?? win32.join(root, "System32", "cmd.exe")
  const cmd = options.exists(cmdCandidate) ? cmdCandidate : undefined
  const profiles: ShellProfile[] = []
  if (gitBash) profiles.push({ id: "git-bash", label: "Git Bash", command: gitBash, args: ["-i"] })
  if (pathBash && pathBash.toLowerCase() !== gitBash?.toLowerCase()) profiles.push({ id: "bash", label: "Bash (PATH)", command: pathBash, args: ["-i"] })
  if (pwsh) profiles.push({ id: "pwsh", label: "PowerShell 7", command: pwsh, args: ["-NoLogo", "-NoProfile"] })
  if (options.exists(powerShell)) profiles.push({ id: "powershell", label: "Windows PowerShell", command: powerShell, args: ["-NoLogo", "-NoProfile"] })
  if (cmd) profiles.push({ id: "cmd", label: "CMD", command: cmd, args: [] })
  const defaultProfile = profiles.find((profile) => profile.id === "git-bash")
    ?? profiles.find((profile) => profile.id === "cmd")
    ?? profiles.find((profile) => profile.id === "pwsh")
    ?? profiles.find((profile) => profile.id === "powershell")
    ?? profiles[0]
  return defaultProfile ? [{ ...defaultProfile, id: "auto", label: "自動選擇" }, ...profiles] : []
}

export function listDesktopTerminalShellOptions(environment: Partial<ShellEnvironment> = {}) {
  const options: ShellEnvironment = { env: environment.env ?? process.env, platform: environment.platform ?? process.platform, exists: environment.exists ?? existsSync }
  return shellProfiles(options).map(({ id, label, command }) => ({ id, label, command }))
}
