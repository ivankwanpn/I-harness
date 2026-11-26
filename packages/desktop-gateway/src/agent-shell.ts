import { existsSync, readFileSync } from "node:fs"
import { powerShellExecutableAvailable, resolveWslAgentShell } from "@i-harness/shell"
import { AGENT_SHELL_CHOICES, type SettingsAgentShell } from "@i-harness/settings"
import { AUTO_SHELL_LABEL, shellProfile, shellProfiles, windowsCommandPath, type ShellEnvironment, type ShellProfile } from "./terminal-shells.ts"
import { withDesktopSettings } from "./settings-file.ts"

export interface AgentShellOption {
  id: SettingsAgentShell
  label: string
  command: string
  dialect: "posix" | "powershell" | "cmd"
  executionTarget?: "host" | "wsl"
  env?: Readonly<Record<string, string>>
  executionContext?: string
}
export interface AgentShellSettingsState {
  executionTarget?: "host" | "wsl"
  nativeSelected?: SettingsAgentShell
  selected: SettingsAgentShell
  options: AgentShellOption[]
  resolved?: AgentShellOption
  error?: string
}
function choice(value: unknown): SettingsAgentShell {
  if (typeof value !== "string" || !(AGENT_SHELL_CHOICES as readonly string[]).includes(value)) throw new Error("Invalid Agent shell choice")
  return value as SettingsAgentShell
}
function dialect(command: string): AgentShellOption["dialect"] | undefined {
  const name = command.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, "")
  if (name === "pwsh" || name === "powershell") return "powershell"
  if (name === "cmd") return "cmd"
  if (["bash", "zsh", "sh", "dash", "ksh"].includes(name ?? "")) return "posix"
  return undefined
}

function windowsNativeAuto(get: (shell: SettingsAgentShell) => AgentShellOption | undefined): AgentShellOption | undefined {
  // Native Job creation cannot execute WindowsApps aliases. Explicit choices
  // still use the same availability check as the settings list.
  const pwsh = get("pwsh")
  const native = pwsh && !/[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(pwsh.command) ? pwsh : get("powershell") ?? get("cmd")
  return native && { ...native, id: "auto", label: `${AUTO_SHELL_LABEL}（主機）` }
}

/** Uses the PTY's executable discovery, with a separate durable Agent preference.
 * Resolution reads the saved choice at each command boundary. No startup
 * snapshot can silently replace a selected executable that was removed. */
export function createAgentShellSettings(path: string, environment: Partial<ShellEnvironment> = {}) {
  const env: ShellEnvironment = { env: environment.env ?? process.env, platform: environment.platform ?? process.platform, exists: environment.exists ?? existsSync }
  const isAvailable = (command: string, kind: AgentShellOption["dialect"] | undefined) =>
    kind === "powershell" ? powerShellExecutableAvailable(command, env.exists) : env.exists(command)
  function hostOption(profile: ShellProfile | undefined): AgentShellOption | undefined {
    if (!profile) return undefined
    const kind = dialect(profile.command)
    const available = isAvailable(profile.command, kind)
    return kind && available ? { id: choice(profile.id), label: `${profile.label}（主機）`, command: profile.command, dialect: kind, executionTarget: "host" } : undefined
  }
  function options(): AgentShellOption[] {
    const available = shellProfiles(env).map(hostOption).filter(option => option !== undefined)
    if (env.platform !== "win32") return available
    const native = windowsNativeAuto(id => available.find(option => option.id === id))
    return available.flatMap((option) => option.id !== "auto" ? [option]
      : native ? [native] : [])
  }
  function selectedOption(shell: SettingsAgentShell): AgentShellOption | undefined {
    if (env.platform !== "win32" || shell !== "auto") return hostOption(shellProfile(env, shell))
    // With a custom ComSpec the Terminal Auto row can name an unsupported
    // executable. Keep the settings-list compatibility rule for that host.
    if (dialect(windowsCommandPath(env)) !== "cmd") return options().find(option => option.id === shell)
    return windowsNativeAuto(id => hostOption(shellProfile(env, id)))
  }
  function selected(): SettingsAgentShell {
    let document: unknown
    try { document = JSON.parse(readFileSync(path, "utf8")) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "auto"; throw new Error("Cannot read Agent shell settings") }
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Invalid Agent shell settings")
    return choice((document as Record<string, unknown>).agentShell ?? "auto")
  }
  const unavailable = (shell: SettingsAgentShell) => new Error(`Agent Shell '${shell}' is unavailable on this host. Choose an installed shell in settings.`)
  function requireOption(shell: SettingsAgentShell, result: AgentShellOption | undefined): AgentShellOption {
    if (!result) throw unavailable(shell)
    return result
  }
  function snapshot(shell: SettingsAgentShell): AgentShellSettingsState {
    const available = options()
    try { return { selected: shell, options: available, resolved: requireOption(shell, available.find(option => option.id === shell)) } }
    catch (error) { return { selected: shell, options: available, error: error instanceof Error ? error.message : String(error) } }
  }
  return {
    state: () => withDesktopSettings(path, async store => {
      const settings = store.get()
      if (settings.windowsSandboxBackend !== "wsl") return { ...snapshot(selected()), executionTarget: "host" as const }
      const binding: AgentShellOption = { ...resolveWslAgentShell(settings.wslExecution), id: "bash", label: `Linux Bash（WSL2 ${settings.wslExecution.distribution}）` }
      return { selected: "bash" as const, nativeSelected: selected(), executionTarget: "wsl" as const, options: [binding], resolved: binding }
    }),
    resolve: (): AgentShellOption & { validate(): void } => {
      const shell = selected()
      const resolved = requireOption(shell, selectedOption(shell))
      return { ...resolved, validate() {
        if (!isAvailable(resolved.command, resolved.dialect)) throw unavailable(resolved.id)
      } }
    },
    async configure(value: unknown): Promise<AgentShellSettingsState> {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Agent shell settings command")
      const command = value as Record<string, unknown>
      if (Object.keys(command).some((key) => key !== "shell")) throw new Error("Unknown Agent shell setting")
      const shell = choice(command.shell)
      return withDesktopSettings(path, async (store) => {
        if (store.get().windowsSandboxBackend === "wsl") throw new Error("WSL uses Linux Bash for new assemblies. Select a native backend to configure a host Agent Shell.")
        requireOption(shell, options().find(option => option.id === shell))
        await store.set({ agentShell: shell })
        return snapshot(shell)
      })
    },
  }
}
