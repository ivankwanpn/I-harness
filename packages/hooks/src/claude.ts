import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { lstat, readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path"
import type { ClaudeHookDiagnostic, ClaudeHookEvent, ClaudePluginHooksOptions, ClaudeSessionSource, HookContext, HookEventName, HookHandlerSpec, HookOutput } from "./types.ts"
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
  return sha256ClaudePluginTreeSync(pluginRoot)
}

/** The same finite content grant, synchronously rechecked at prepared dispatch. */
export function sha256ClaudePluginTreeSync(pluginRoot: string): string {
  const root = resolve(pluginRoot), rootStat = lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new HookConfigError("Claude hook plugin root must be a real directory")
  const realRoot = realpathSync(root), hash = createHash("sha256").update("I-harness Claude plugin-tree-v1\0")
  let entries = 0, bytes = 0
  function visit(directory: string, depth: number): void {
    if (depth > MAX_PLUGIN_DEPTH) throw new HookConfigError("Claude hook plugin bundle exceeds the directory depth limit")
    for (const name of readdirSync(directory).sort()) {
      // Git bookkeeping changes independently of executable plugin contents.
      if (name === ".git") continue
      if (++entries > MAX_PLUGIN_ENTRIES) throw new HookConfigError("Claude hook plugin bundle exceeds the file count limit")
      const file = join(directory, name), stat = lstatSync(file)
      if (stat.isSymbolicLink() || !isInside(realRoot, realpathSync(file))) throw new HookConfigError(`Claude hook plugin bundle contains a link or escaping path: ${file}`)
      if (stat.isDirectory()) { visit(file, depth + 1); continue }
      if (!stat.isFile()) throw new HookConfigError(`Claude hook plugin bundle contains a non-file artifact: ${file}`)
      if (bytes + stat.size > MAX_PLUGIN_BYTES) throw new HookConfigError("Claude hook plugin bundle exceeds the byte limit")
      const content = readFileSync(file)
      if ((bytes += content.byteLength) > MAX_PLUGIN_BYTES) throw new HookConfigError("Claude hook plugin bundle exceeds the byte limit")
      const path = relative(root, file).split(sep).join("/")
      hash.update(JSON.stringify([path, content.byteLength])).update("\0").update(content).update("\0")
    }
  }
  visit(root, 0)
  return hash.digest("hex")
}

function object(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new HookConfigError(`${label} must be an object`)
  return raw as Record<string, unknown>
}

const CLAUDE_EVENTS: Record<ClaudeHookEvent, HookEventName> = {
  SessionStart: "session/start", SessionEnd: "session/end", UserPromptSubmit: "prompt/submit",
  PreToolUse: "pre-tool", PostToolUse: "post-tool", PermissionRequest: "permission",
  Stop: "stop", SubagentStop: "subagent/stop", Notification: "notification",
}

export function claudeToolName(name: string, dialect?: "posix" | "powershell" | "cmd"): string {
  if (name === "shell") return dialect === "posix" ? "Bash" : dialect === "powershell" ? "PowerShell" : name
  return ({ read: "Read", write: "Write", edit: "Edit", bash: "Bash", pwsh: "PowerShell", powershell: "PowerShell", glob: "Glob", grep: "Grep", web_fetch: "WebFetch", web_search: "WebSearch", spawn_agent: "Agent", ask_user_input: "AskUserQuestion" } as Record<string, string>)[name] ?? name
}

export function claudeToolInput(name: string, input: unknown, cwd: string): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input
  const args = structuredClone(input) as Record<string, unknown>
  if (["read", "write", "edit"].includes(name) && typeof args.path === "string") {
    args.file_path = isAbsolute(args.path) ? args.path : resolve(cwd, args.path)
    delete args.path
    if (name === "write" && typeof args.text === "string") { args.content = args.text; delete args.text }
  }
  if (name === "bash" || name === "powershell") {
    if (typeof args.timeout_ms === "number") { args.timeout = args.timeout_ms; delete args.timeout_ms }
  }
  return args
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
        if (group.matcher !== "*" && group.matcher !== "") {
          try { new RegExp(group.matcher) } catch { throw new HookConfigError(`Claude ${event} matcher is not a valid regular expression`) }
        }
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
        if (!Object.hasOwn(CLAUDE_EVENTS, event)) unsupported = `Claude event ${event} has no matching IH hook event`
        else if (handler.type !== "command") unsupported = `Claude ${handler.type} hooks are not supported; this adapter supports synchronous command hooks`
        else if (handler.async === true || handler.asyncRewake === true) unsupported = "Asynchronous Claude hooks and asyncRewake are not supported"
        else if (handler.if !== undefined || group.if !== undefined) unsupported = "Conditional Claude hooks are not supported"
        else if (handler.args !== undefined) unsupported = "Claude exec-form args are not supported; this adapter preserves the shell command string"
        else if (handler.shell !== undefined && handler.shell !== "bash" && handler.shell !== "sh") unsupported = `Claude shell ${handler.shell} is not supported`
        else if (handler.onFailure !== undefined && handler.onFailure !== "block") unsupported = "IH hook gates fail closed; non-blocking onFailure is not supported"
        if (unsupported) { diagnostics.push({ id, event, message: unsupported }); continue }
        const shell = handler.shell === "sh" ? "sh" : "bash"
        specs.push({
          id, event: CLAUDE_EVENTS[event as ClaudeHookEvent], type: "command",
          command: { cmd: shell, args: shell === "bash" ? ["--noprofile", "--norc", "-c", handler.command as string] : ["-c", handler.command as string] },
          trust: { script: config, sha256: "" },
          timeoutMs: typeof handler.timeout === "number" ? Math.max(1, Math.floor(handler.timeout * 1000)) : 10000,
          claude: { pluginRoot, event: event as ClaudeHookEvent, shell, trustScope: "plugin-tree-v1", ...(group.matcher !== undefined ? { matcher: group.matcher as string } : {}) },
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
  throw new HookConfigError(`Claude command hooks require an available native ${platform === "win32" ? "Git Bash" : shell} shell; install that prerequisite before approving this plugin`)
}

export function claudeShellEnvironment(spec: HookHandlerSpec, cwd: string, env: NodeJS.ProcessEnv, executable: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, CLAUDE_PLUGIN_ROOT: spec.claude!.pluginRoot.replaceAll("\\", "/"), CLAUDE_PROJECT_DIR: cwd.replaceAll("\\", "/"), PYTHONDONTWRITEBYTECODE: "1" }
  // These indicators select other hosts in cross-harness plugin scripts.
  for (const key of Object.keys(result)) if (["cursor_plugin_root", "copilot_cli"].includes(key.toLowerCase())) delete result[key]
  if (process.platform === "win32") {
    const path = envValue(result, "PATH") ?? ""
    for (const key of Object.keys(result)) if (key.toLowerCase() === "path") delete result[key]
    result.PATH = `${dirname(executable)};${path}`
  }
  return result
}

export interface ClaudeRuntimeInput {
  sessionId?: string
  transcriptPath?: string
  permissionMode?: string
  callId?: string
  toolOutput?: unknown
  source?: ClaudeSessionSource
  stopHookActive?: boolean
  finalText?: string
  notificationType?: string
  agentId?: string
  agentType?: string
  reason?: string
  dialect?: "posix" | "powershell" | "cmd"
}

export function claudeHookPayload(spec: HookHandlerSpec, context: HookContext, cwd: string, input: ClaudeRuntimeInput): Record<string, unknown> {
  const event = spec.claude!.event
  if (CLAUDE_EVENTS[event] !== context.event) throw new HookConfigError(`Claude hook ${spec.id} requires a ${event} context`)
  const payload: Record<string, unknown> = {
    session_id: ("sessionId" in context && context.sessionId) || input.sessionId || "",
    cwd, hook_event_name: event, permission_mode: input.permissionMode ?? "default",
    ...(input.transcriptPath ? { transcript_path: input.transcriptPath.replaceAll("\\", "/") } : {}),
  }
  if (context.event === "session/start") payload.source = input.source ?? "startup"
  else if (context.event === "session/end") payload.reason = input.reason ?? "other"
  else if (context.event === "prompt/submit") {
    payload.prompt = context.prompt
    // The official Hookify snapshot also reads this legacy spelling.
    payload.user_prompt = context.prompt
  }
  else if ("tool" in context) {
    payload.tool_name = claudeToolName(context.tool.name, input.dialect)
    payload.tool_input = claudeToolInput(context.tool.name, context.tool.args, cwd)
    if (input.callId !== undefined) payload.tool_use_id = input.callId
    if (context.event === "post-tool") payload.tool_response = input.toolOutput
    if (context.event === "permission") payload.permission_suggestions = []
  } else if (context.event === "stop" || context.event === "subagent/stop") {
    payload.stop_hook_active = input.stopHookActive ?? false
    payload.last_assistant_message = context.event === "stop" ? context.finalText : input.finalText ?? ""
    if (context.event === "subagent/stop") {
      payload.agent_id = input.agentId || payload.session_id
      if (input.agentType) payload.agent_type = input.agentType
      if (input.transcriptPath) payload.agent_transcript_path = payload.transcript_path
    }
  } else if (context.event === "notification") {
    payload.message = context.message
    payload.notification_type = input.notificationType ?? "ih_notification"
  }
  return payload
}

/** Normalize only the declared Claude protocol into IH's internal output. */
export function normalizeClaudeHookOutput(stdout: string, handlerId: string, event: ClaudeHookEvent): HookOutput {
  const text = stdout.trim()
  if (!text) return {}
  // Claude treats only a complete object-shaped stdout value as JSON.
  if (!text.startsWith("{") || !text.endsWith("}")) return event === "SessionStart" || event === "UserPromptSubmit" ? { additionalContext: text } : {}
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new HookOutputError(`hook ${handlerId}: ${event} stdout is not valid JSON`) }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HookOutputError(`hook ${handlerId}: ${event} JSON output must be an object`)
  const raw = parsed as Record<string, unknown>, result: HookOutput = {}
  const context: string[] = []
  const string = (key: string, value: unknown): string => {
    if (typeof value !== "string") throw new HookOutputError(`hook ${handlerId}: ${key} must be a string`)
    return value
  }
  const block = (reason: unknown): void => {
    const explanation = string("blocking reason", reason)
    if (!explanation.trim()) throw new HookOutputError(`hook ${handlerId}: blocking reason must not be empty`)
    if (event === "Stop" || event === "SubagentStop") result.continuation = explanation
    else if (event === "PostToolUse") context.push(explanation)
    else { result.block = true; result.reason = explanation }
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === "additionalContext" || key === "systemMessage") context.push(string(key, value))
    else if (key === "hookSpecificOutput") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HookOutputError(`hook ${handlerId}: hookSpecificOutput must be an object`)
      const specific = value as Record<string, unknown>
      if (specific.hookEventName !== event) throw new HookOutputError(`hook ${handlerId}: hookSpecificOutput requires ${event}`)
      for (const [field, entry] of Object.entries(specific)) {
        if (field === "hookEventName") continue
        if (field === "additionalContext") context.push(string(field, entry))
        else if (field === "permissionDecision" && (event === "PreToolUse" || event === "PostToolUse")) {
          if (entry !== "allow" && entry !== "deny" && entry !== "ask") throw new HookOutputError(`hook ${handlerId}: invalid permissionDecision`)
          if (event === "PostToolUse") {
            if (entry !== "allow") block(specific.permissionDecisionReason ?? "Post-tool hook feedback")
          } else { result.decision = entry; if (specific.permissionDecisionReason !== undefined) result.reason = string("permissionDecisionReason", specific.permissionDecisionReason) }
        } else if (field === "permissionDecisionReason" && (event === "PreToolUse" || event === "PostToolUse")) string(field, entry)
        else if (field === "decision" && event === "PermissionRequest") {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new HookOutputError(`hook ${handlerId}: permission decision must be an object`)
          const decision = entry as Record<string, unknown>
          if (decision.behavior !== "allow" && decision.behavior !== "deny") throw new HookOutputError(`hook ${handlerId}: invalid permission behavior`)
          if (Object.keys(decision).some(name => !["behavior", "message", "interrupt"].includes(name))) throw new HookOutputError(`hook ${handlerId}: permission mutations are not supported by IH`)
          if (decision.message !== undefined) result.reason = string("permission message", decision.message)
          if (decision.interrupt !== undefined && typeof decision.interrupt !== "boolean") throw new HookOutputError(`hook ${handlerId}: interrupt must be a boolean`)
          result.decision = decision.behavior
        } else throw new HookOutputError(`hook ${handlerId}: unsupported ${event} output field ${field}`)
      }
    } else if (key === "continue" || key === "suppressOutput") {
      if (typeof value !== "boolean") throw new HookOutputError(`hook ${handlerId}: ${key} must be a boolean`)
      if (key === "continue") result.continue = value
    } else if (key === "stopReason") result.stopReason = string(key, value)
    else if (key === "reason") string(key, value)
    else if (key === "decision") {
      if (value === "block") block(raw.reason)
      else if (value === "approve" && event === "PreToolUse") result.decision = "allow"
      else throw new HookOutputError(`hook ${handlerId}: unsupported ${event} decision`)
    } else throw new HookOutputError(`hook ${handlerId}: unsupported ${event} output field ${key}`)
  }
  const specific = raw.hookSpecificOutput as Record<string, unknown> | undefined
  if (typeof raw.additionalContext === "string" && typeof specific?.additionalContext === "string" && raw.additionalContext !== specific.additionalContext) throw new HookOutputError(`hook ${handlerId}: conflicting context fields`)
  const combined = [...new Set(context)].filter(Boolean).join("\n\n")
  if (combined) result.additionalContext = combined
  if ((event === "Stop" || event === "SubagentStop") && !result.continuation && combined) result.continuation = combined
  return result
}

export function normalizeClaudeStartupOutput(stdout: string, handlerId: string): HookOutput {
  return normalizeClaudeHookOutput(stdout, handlerId, "SessionStart")
}
