import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import type { SessionService } from "@i-harness/session-executor"
import type { AgentShellSettingsState } from "./agent-shell.ts"
import { resourceId } from "./execution.ts"

export interface ExecutableDiagnostic { name: string; command?: string; status: "unconfigured" | "not-installed" | "unavailable" | "available" | "untested"; version?: string; error?: string }
export interface EnvironmentDiagnosticsView {
  live: boolean; sessionId?: string; effectiveMode?: "off" | "mixed" | "only"
  tools: { name: string; exposure: "direct" | "deferred" | "hidden"; modelVisible: boolean }[]
  roles: { name: string; allowlist: string[] }[]
  shell?: AgentShellSettingsState; executables: ExecutableDiagnostic[]
}
export type DiagnosticsRequest = { kind: "desktop/environment/diagnostics"; workspaceId: string; sessionId?: string; probe?: boolean }

function executable(command: string): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined
  const names = process.platform === "win32" ? [`${command}.exe`, command] : [command]
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path")
  for (const directory of (pathKey ? process.env[pathKey] ?? "" : "").split(delimiter)) {
    if (!directory) continue
    for (const name of names) { const path = join(directory.replace(/^"|"$/g, ""), name); if (existsSync(path)) return path }
  }
  return undefined
}

/** Fixed host diagnostics only; never interpolates input into a shell command. */
export async function probeExecutable(name: string, command?: string, args: string[] = ["--version"]): Promise<ExecutableDiagnostic> {
  if (!command) return { name, status: "unconfigured" }
  const path = executable(command)
  if (!path) return { name, command, status: "not-installed" }
  return new Promise(resolve => {
    const child = spawn(path, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let output = "", overflow = false, settled = false
    const done = (status: ExecutableDiagnostic["status"], error?: string) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      resolve({ name, command: path, status, ...(status === "available" ? { version: output.trim().slice(0, 2048) } : {}), ...(error ? { error: error.slice(0, 2048) } : {}) })
    }
    const timer = setTimeout(() => { child.kill(); done("unavailable", "Version probe timed out") }, 2500)
    const collect = (chunk: Buffer) => {
      if (overflow) return
      output += chunk.toString("utf8")
      if (output.length > 8192) { overflow = true; child.kill(); done("unavailable", "Version probe output exceeded limit") }
    }
    child.stdout.on("data", collect); child.stderr.on("data", collect)
    child.on("error", error => done("unavailable", error.message))
    child.on("close", code => done(code === 0 && output.trim() ? "available" : "unavailable", code === 0 && output.trim() ? undefined : `Version probe exited ${code}: ${output.trim()}`))
  })
}

export function createDesktopDiagnostics(service: Pick<SessionService, "liveAssembly">, options: { shell: { state(): Promise<AgentShellSettingsState> } }) {
  return {
    async read(sessionId?: string, probe = false): Promise<EnvironmentDiagnosticsView> {
      if (typeof probe !== "boolean") throw new Error("Invalid executable probe flag")
      if (sessionId) resourceId(sessionId)
      const assembly = sessionId ? service.liveAssembly(sessionId) : undefined
      const state = assembly?.executionState?.()
      const model = new Set(state?.modelTools ?? [])
      const catalog = assembly?.tools.genToolCatalog() ?? []
      const tools = catalog.map(tool => ({ name: tool.name, exposure: tool.exposure, modelVisible: model.has(tool.name) }))
      // Deferred entries that have not been promoted belong to the declared
      // catalogue too. Discovery does not promote or execute those tools.
      const known = new Set(tools.map(tool => tool.name))
      for (const tool of assembly?.tools.deferredSearchIndex() ?? []) if (!known.has(tool.name)) tools.push({ name: tool.name, exposure: "deferred", modelVisible: model.has(tool.name) })
      const shell = await options.shell.state()
      const shellArgs = shell.resolved?.dialect === "cmd" ? ["/d", "/c", "ver"]
        : shell.resolved?.dialect === "powershell" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"] : ["--version"]
      const specs = [{ name: "Agent Shell", command: shell.resolved?.command, args: shellArgs }, { name: "Node.js", command: process.execPath, args: ["--version"] }, { name: "Git", command: "git", args: ["--version"] }, { name: "ripgrep", command: "rg", args: ["--version"] }]
      const executables = probe ? await Promise.all(specs.map(spec => spec.name === "Agent Shell" && shell.executionTarget === "wsl"
        ? Promise.resolve({ name: spec.name, command: spec.command, status: "untested" as const, error: "Use WSL diagnostics to inspect the Linux executable." }) : probeExecutable(spec.name, spec.command, spec.args)))
        : specs.map(spec => ({ name: spec.name, command: spec.command, status: spec.command ? "untested" as const : "unconfigured" as const }))
      if (!shell.resolved && shell.error) executables[0] = { name: "Agent Shell", status: "unavailable", error: shell.error }
      return { live: Boolean(assembly), ...(sessionId ? { sessionId } : {}), ...(state ? { effectiveMode: state.codeMode } : {}), tools,
        roles: (assembly?.subagentState().roles ?? []).map(role => ({ name: role.name, allowlist: role.tools.slice() })), shell, executables }
    },
  }
}
