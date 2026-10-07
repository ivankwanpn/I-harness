import { existsSync, readFileSync } from "node:fs"
import { powerShellExecutableAvailable } from "@i-harness/shell"
import { AGENT_SHELL_CHOICES, type SettingsAgentShell } from "@i-harness/settings"
import { shellProfiles, type ShellEnvironment } from "./terminal-shells.ts"
import { withDesktopSettings } from "./settings-file.ts"

export interface AgentShellOption {
  id: SettingsAgentShell
  label: string
  command: string
  dialect: "posix" | "powershell" | "cmd"
}
export interface AgentShellSettingsState {
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

/** Uses the PTY's executable discovery, with a separate durable Agent preference.
 * Resolution reads the saved choice at each command boundary. No startup
 * snapshot can silently replace a selected executable that was removed. */
export function createAgentShellSettings(path: string, environment: Partial<ShellEnvironment> = {}) {
  const env: ShellEnvironment = { env: environment.env ?? process.env, platform: environment.platform ?? process.platform, exists: environment.exists ?? existsSync }
  function options(): AgentShellOption[] {
    const available = shellProfiles(env).flatMap((profile) => {
      const kind = dialect(profile.command)
      const available = kind === "powershell" ? powerShellExecutableAvailable(profile.command, env.exists) : env.exists(profile.command)
      return kind && available ? [{ id: choice(profile.id), label: profile.label, command: profile.command, dialect: kind }] : []
    })
    if (env.platform !== "win32") return available
    const automatic = available.find((option) => option.id === "auto")
    // Native Job creation cannot execute WindowsApps aliases. Preserve explicit
    // choices, but bind auto to a regular native executable before command capture.
    const native = available.find((option) => option.id === "pwsh" && !/[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(option.command))
      ?? available.find((option) => option.id === "powershell")
      ?? available.find((option) => option.id === "cmd")
    return available.flatMap((option) => option.id !== "auto" ? [option]
      : native ? [{ ...native, id: "auto" as const, label: automatic!.label }] : [])
  }
  function selected(): SettingsAgentShell {
    let document: unknown
    try { document = JSON.parse(readFileSync(path, "utf8")) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "auto"; throw new Error("Cannot read Agent shell settings") }
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Invalid Agent shell settings")
    return choice((document as Record<string, unknown>).agentShell ?? "auto")
  }
  function resolveChoice(shell: SettingsAgentShell, available: AgentShellOption[]): AgentShellOption {
    const result = available.find((option) => option.id === shell)
    if (!result) throw new Error(`Agent Shell '${shell}' is unavailable on this host. Choose an installed shell in settings.`)
    return result
  }
  function snapshot(shell: SettingsAgentShell): AgentShellSettingsState {
    const available = options()
    try { return { selected: shell, options: available, resolved: resolveChoice(shell, available) } }
    catch (error) { return { selected: shell, options: available, error: error instanceof Error ? error.message : String(error) } }
  }
  return {
    state: () => withDesktopSettings(path, async () => snapshot(selected())),
    resolve: (): AgentShellOption & { validate(): void } => {
      const resolved = resolveChoice(selected(), options())
      return { ...resolved, validate() {
        if (!(resolved.dialect === "powershell" ? powerShellExecutableAvailable(resolved.command, env.exists) : env.exists(resolved.command))) throw new Error(`Agent Shell '${resolved.id}' is unavailable on this host. Choose an installed shell in settings.`)
      } }
    },
    async configure(value: unknown): Promise<AgentShellSettingsState> {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Agent shell settings command")
      const command = value as Record<string, unknown>
      if (Object.keys(command).some((key) => key !== "shell")) throw new Error("Unknown Agent shell setting")
      const shell = choice(command.shell)
      return withDesktopSettings(path, async (store) => {
        resolveChoice(shell, options())
        await store.set({ agentShell: shell })
        return snapshot(shell)
      })
    },
  }
}
