import { existsSync } from "node:fs"
import { basename, posix, win32 } from "node:path"
import { createTerminalService } from "@i-harness/terminal"

const owner = { sessionId: "desktop-user" }
type ShellProfile = { id: string; label: string; command: string; args: string[] }
type ShellEnvironment = { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; exists: (path: string) => boolean }

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

function shellProfiles(options: ShellEnvironment): ShellProfile[] {
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
  const defaultProfile = profiles.find((profile) => profile.id === "powershell") ?? profiles.find((profile) => profile.id === "pwsh") ?? profiles[0]
  return defaultProfile ? [{ ...defaultProfile, id: "auto", label: "自動選擇" }, ...profiles] : []
}
function integer(value: unknown, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid terminal dimension or cursor")
  return value
}
export function createDesktopTerminal(workspace: string, environment: Partial<ShellEnvironment> = {}) {
  const service = createTerminalService()
  const shellEnvironment: ShellEnvironment = { env: environment.env ?? process.env, platform: environment.platform ?? process.platform, exists: environment.exists ?? existsSync }
  let closed = false
  return {
    request(method: string, input: unknown) {
      if (closed) throw new Error("Terminal service is closed")
      const params = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
      if (method === "desktop/terminal/list") return service.list()
      if (method === "desktop/terminal/options") return shellProfiles(shellEnvironment).map(({ id, label }) => ({ id, label }))
      if (method === "desktop/terminal/open") {
        if (service.list().length >= 8) throw new Error("Close an existing terminal before opening another")
        const selected = params.shell === undefined ? "auto" : params.shell
        if (typeof selected !== "string") throw new Error("Invalid terminal shell")
        const profile = shellProfiles(shellEnvironment).find((entry) => entry.id === selected)
        if (!profile) throw new Error(`Terminal shell ${selected} is unavailable`)
        return service.open({ command: profile.command, args: profile.args, cwd: workspace, rawOutput: true, cols: integer(params.cols, 2, 500, 100), rows: integer(params.rows, 2, 500, 30) }, owner)
      }
      if (typeof params.id !== "string" || !params.id || params.id.length > 128) throw new Error("Invalid terminal id")
      switch (method) {
        case "desktop/terminal/read": return service.read(params.id, { ...owner, offset: integer(params.offset, 0, Number.MAX_SAFE_INTEGER, 0), maxBytes: 32768 })
        case "desktop/terminal/write":
          if (typeof params.data !== "string" || params.data.length > 32768) throw new Error("Terminal input too large")
          service.send(params.id, params.data, owner); return { ok: true }
        case "desktop/terminal/resize": return service.resize(params.id, integer(params.cols, 2, 500), integer(params.rows, 2, 500), owner)
        case "desktop/terminal/close": return service.close(params.id, owner)
        default: throw new Error("Unknown terminal operation")
      }
    },
    close() { closed = true; service.dispose() },
  }
}
