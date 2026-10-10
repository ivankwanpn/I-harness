import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path"
import type { ClaudeHookDiagnostic, ClaudePluginHooksOptions, HookHandlerSpec, HookOutput } from "./types.ts"
import { HookConfigError, HookOutputError } from "./types.ts"

const MAX_PLUGIN_ENTRIES = 4096
const MAX_PLUGIN_BYTES = 64 * 1024 * 1024
const MAX_PLUGIN_DEPTH = 32

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)
}

/** Content grant covers the whole finite plugin bundle, not just its launcher. */
export async function sha256ClaudePluginTree(pluginRoot: string): Promise<string> {
  const root = resolve(pluginRoot), rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new HookConfigError("Claude hook plugin root must be a real directory")
  const realRoot = await realpath(root), hash = createHash("sha256").update("I-harness Claude plugin-tree-v1\0")
  let entries = 0, bytes = 0
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > MAX_PLUGIN_DEPTH) throw new HookConfigError("Claude hook plugin bundle exceeds the directory depth limit")
    for (const name of (await readdir(directory)).sort()) {
      // Git bookkeeping changes independently of executable plugin contents.
      if (name === ".git") continue
      if (++entries > MAX_PLUGIN_ENTRIES) throw new HookConfigError("Claude hook plugin bundle exceeds the file count limit")
      const file = join(directory, name), stat = await lstat(file)
      if (stat.isSymbolicLink() || !isInside(realRoot, await realpath(file))) throw new HookConfigError(`Claude hook plugin bundle contains a link or escaping path: ${file}`)
      if (stat.isDirectory()) { await visit(file, depth + 1); continue }
      if (!stat.isFile()) throw new HookConfigError(`Claude hook plugin bundle contains a non-file artifact: ${file}`)
      if (bytes + stat.size > MAX_PLUGIN_BYTES) throw new HookConfigError("Claude hook plugin bundle exceeds the byte limit")
      const content = await readFile(file)
      if ((bytes += content.byteLength) > MAX_PLUGIN_BYTES) throw new HookConfigError("Claude hook plugin bundle exceeds the byte limit")
      const path = relative(root, file).split(sep).join("/")
      hash.update(JSON.stringify([path, content.byteLength])).update("\0").update(content).update("\0")
    }
  }
  await visit(root, 0)
  return hash.digest("hex")
}

function object(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new HookConfigError(`${label} must be an object`)
  return raw as Record<string, unknown>
}

export async function adaptClaudePluginHooks(
  raw: Record<string, unknown>, configPath: string, configText: string,
  approvals: { isApproved(sha256: string): boolean } | undefined,
  options: ClaudePluginHooksOptions & { claudePluginRoot: string },
): Promise<Array<{ spec: HookHandlerSpec; valid: boolean; trustError?: string; unapproved?: boolean }>> {
  const pluginRoot = resolve(options.claudePluginRoot), config = resolve(configPath)
  if (!isInside(pluginRoot, config) || relative(pluginRoot, config).split(sep).includes(".git")) throw new HookConfigError("Claude hook config must be inside its mounted plugin root")
  const configStat = await lstat(config)
  if (!configStat.isFile() || configStat.isSymbolicLink()) throw new HookConfigError("Claude hook config must be a regular plugin file")
  const hooks = object(raw.hooks, "Claude hooks"), specs: HookHandlerSpec[] = [], diagnostics: ClaudeHookDiagnostic[] = []
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new HookConfigError(`Claude ${event} hooks must be an array`)
    for (const [groupIndex, groupRaw] of groups.entries()) {
      const group = object(groupRaw, `Claude ${event} matcher group`)
      if (group.matcher !== undefined && typeof group.matcher !== "string") throw new HookConfigError(`Claude ${event} matcher must be a string`)
      if (typeof group.matcher === "string") {
        try { new RegExp(group.matcher) } catch { throw new HookConfigError(`Claude ${event} matcher is not a valid regular expression`) }
      }
      if (!Array.isArray(group.hooks)) throw new HookConfigError(`Claude ${event} matcher group must have a hooks array`)
      for (const [handlerIndex, handlerRaw] of group.hooks.entries()) {
        const handler = object(handlerRaw, `Claude ${event} hook`), id = `claude:${event}:${groupIndex}:${handlerIndex}`
        if (typeof handler.type !== "string" || !handler.type) throw new HookConfigError(`Claude hook ${id} requires a type`)
        if (handler.type === "command" && (typeof handler.command !== "string" || !handler.command.trim())) throw new HookConfigError(`Claude hook ${id} requires a command string`)
        if (handler.async !== undefined && typeof handler.async !== "boolean") throw new HookConfigError(`Claude hook ${id}: async must be a boolean`)
        if (handler.timeout !== undefined && (typeof handler.timeout !== "number" || !Number.isFinite(handler.timeout) || handler.timeout <= 0)) throw new HookConfigError(`Claude hook ${id}: timeout must be positive seconds`)
        if (handler.shell !== undefined && typeof handler.shell !== "string") throw new HookConfigError(`Claude hook ${id}: shell must be a string`)
        if (handler.args !== undefined && (!Array.isArray(handler.args) || !handler.args.every(arg => typeof arg === "string"))) throw new HookConfigError(`Claude hook ${id}: args must be an array of strings`)
        if (handler.asyncRewake !== undefined && typeof handler.asyncRewake !== "boolean") throw new HookConfigError(`Claude hook ${id}: asyncRewake must be a boolean`)
        let unsupported: string | undefined
        if (event !== "SessionStart") unsupported = `Claude event ${event} is not supported; this adapter supports SessionStart commands`
        else if (handler.type !== "command") unsupported = `Claude ${handler.type} hooks are not supported; this adapter supports synchronous command hooks`
        else if (handler.async === true || handler.asyncRewake === true) unsupported = "Asynchronous Claude startup hooks are not supported"
        else if (handler.if !== undefined || group.if !== undefined) unsupported = "Conditional Claude startup hooks are not supported"
        else if (handler.args !== undefined) unsupported = "Claude exec-form args are not supported; this adapter preserves the shell command string"
        else if (handler.shell !== undefined && handler.shell !== "bash" && handler.shell !== "sh") unsupported = `Claude startup shell ${handler.shell} is not supported`
        if (unsupported) { diagnostics.push({ id, event, message: unsupported }); continue }
        const shell = handler.shell === "sh" ? "sh" : "bash"
        specs.push({
          id, event: "session/start", type: "command",
          command: { cmd: shell, args: shell === "bash" ? ["--noprofile", "--norc", "-c", handler.command as string] : ["-c", handler.command as string] },
          trust: { script: config, sha256: "" },
          timeoutMs: typeof handler.timeout === "number" ? Math.max(1, Math.floor(handler.timeout * 1000)) : 10000,
          claude: { pluginRoot, event: "SessionStart", shell, trustScope: "plugin-tree-v1", ...(group.matcher !== undefined ? { matcher: group.matcher as string } : {}) },
        })
      }
    }
  }
  const sha256 = await sha256ClaudePluginTree(pluginRoot)
  // Parsing and approval must describe the same config bytes included in the bundle.
  if (await readFile(config, "utf8") !== configText) throw new HookConfigError("Claude hook config changed during loading")
  for (const diagnostic of diagnostics) options.onUnsupported?.(diagnostic)
  return specs.map(spec => {
    spec.trust.sha256 = sha256
    const valid = approvals?.isApproved(sha256) === true
    return { spec, valid, ...(!valid ? { unapproved: true, trustError: `hook handler ${spec.id} is not approved by the user for this plugin bundle (sha256 ${sha256})` } : {}) }
  })
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).findLast(key => key.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}
function onWindowsPath(name: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  for (const entry of envValue(env, "PATH")?.split(";") ?? []) {
    const directory = entry.trim().replace(/^"|"$/g, "")
    if (!directory || ["system32", "windowsapps"].includes(win32.basename(directory).toLowerCase())) continue
    const candidate = win32.join(directory, name)
    try { if (exists(candidate)) return candidate } catch { /* next accessible entry */ }
  }
  return undefined
}

/** Pin the actual native executable; a bare Windows bash can launch WSL. */
export function resolveClaudeShell(shell: "bash" | "sh", env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string {
  if (platform !== "win32") {
    const candidates = [`/bin/${shell}`, `/usr/bin/${shell}`, ...(env.PATH?.split(":").filter(Boolean).map(path => join(path, shell)) ?? [])]
    const executable = candidates.find(exists)
    if (executable) return executable
  } else {
    const git = onWindowsPath("git.exe", env, exists)
    const candidates = [
      win32.join(envValue(env, "ProgramFiles") ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
      win32.join(envValue(env, "ProgramFiles(x86)") ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
      ...(git ? [win32.resolve(win32.dirname(git), "..", "bin", "bash.exe"), win32.resolve(win32.dirname(git), "..", "..", "bin", "bash.exe")] : []),
    ]
    // Mirrors the native shell discovery policy, with no PowerShell/WSL fallback.
    const executable = candidates.find(exists) ?? onWindowsPath("bash.exe", env, exists)
    if (executable) return executable
  }
  throw new HookConfigError(`Claude startup hooks require an available native ${platform === "win32" ? "Git Bash" : shell} shell`)
}

export function claudeShellEnvironment(spec: HookHandlerSpec, cwd: string, env: NodeJS.ProcessEnv, executable: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, CLAUDE_PLUGIN_ROOT: spec.claude!.pluginRoot.replaceAll("\\", "/"), CLAUDE_PROJECT_DIR: cwd.replaceAll("\\", "/") }
  // These indicators select other hosts in cross-harness plugin scripts.
  for (const key of Object.keys(result)) if (["cursor_plugin_root", "copilot_cli"].includes(key.toLowerCase())) delete result[key]
  if (process.platform === "win32") {
    const path = envValue(result, "PATH") ?? ""
    for (const key of Object.keys(result)) if (key.toLowerCase() === "path") delete result[key]
    result.PATH = `${dirname(executable)};${path}`
  }
  return result
}

/** Claude startup stdout is either context text or its typed JSON envelope. */
export function normalizeClaudeStartupOutput(stdout: string, handlerId: string): HookOutput {
  const text = stdout.trim()
  if (!text) return {}
  // Claude treats only a complete object-shaped stdout value as JSON.
  if (!text.startsWith("{") || !text.endsWith("}")) return { additionalContext: text }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new HookOutputError(`hook ${handlerId}: startup stdout is not valid JSON`) }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HookOutputError(`hook ${handlerId}: startup JSON output must be an object`)
  const raw = parsed as Record<string, unknown>, result: HookOutput = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === "additionalContext") {
      if (typeof value !== "string") throw new HookOutputError(`hook ${handlerId}: additionalContext must be a string`)
      result.additionalContext = value
    } else if (key === "hookSpecificOutput") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HookOutputError(`hook ${handlerId}: hookSpecificOutput must be an object`)
      const specific = value as Record<string, unknown>
      if (specific.hookEventName !== "SessionStart" || typeof specific.additionalContext !== "string" || Object.keys(specific).some(field => field !== "hookEventName" && field !== "additionalContext")) throw new HookOutputError(`hook ${handlerId}: hookSpecificOutput requires SessionStart and string additionalContext`)
      if (result.additionalContext !== undefined && result.additionalContext !== specific.additionalContext) throw new HookOutputError(`hook ${handlerId}: conflicting startup context fields`)
      result.additionalContext = specific.additionalContext
    } else if (key === "continue" || key === "suppressOutput") {
      if (typeof value !== "boolean") throw new HookOutputError(`hook ${handlerId}: ${key} must be a boolean`)
      if (key === "continue") result.continue = value
    } else if (key === "stopReason" || key === "systemMessage") {
      if (typeof value !== "string") throw new HookOutputError(`hook ${handlerId}: ${key} must be a string`)
      if (key === "stopReason") result.stopReason = value
    } else throw new HookOutputError(`hook ${handlerId}: unknown startup output field ${key}`)
  }
  if (typeof raw.additionalContext === "string" && typeof raw.hookSpecificOutput === "object" && raw.hookSpecificOutput !== null && raw.additionalContext !== (raw.hookSpecificOutput as Record<string, unknown>).additionalContext) throw new HookOutputError(`hook ${handlerId}: conflicting startup context fields`)
  return result
}
