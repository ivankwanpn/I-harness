/**
 * Mount-side conversion: the registry's own MCP config shape → the shape an
 * agent build mounts.
 *
 * WHY THIS IS A SEPARATE STEP. `MCP_CONFIG_SHAPE` (what a plugin's `.mcp.json`
 * parses into) and the consumer's `McpServerConfig` are not the same type, and
 * the differences are not accidental:
 *
 *   - the registry keys servers by the Record key (`plugin:<id>:<server>`), the
 *     consumer wants a `serverName` field;
 *   - the registry has no transport discriminant (it infers from the fields
 *     present), the consumer requires an explicit `transport` tag;
 *   - **and the registry's shape deliberately has NO place for the host-only
 *     controls** (`roots`, `blockedTools`, `directTools`, `auth`,
 *     `toolCallTimeoutMs`, `failOnStartupError`, `reconnect`). A plugin must not
 *     be able to set the tool allow/deny lists, the roots it may claim, or its
 *     own auth posture. That is a security boundary, not an omission.
 *
 * STRUCTURAL RETURN: no file under this package's `src/` imports
 * `@i-harness/mcp-client`. The dependency exists only as a devDependency, used
 * by the TEST tree to validate the keys these helpers compose against
 * mcp-client's real validators (see install.ts's mirroring note) — production
 * code stays free of the runtime dependency in that direction, which is what
 * matters here. A mismatch between `MountedMcpServer` and the consumer's type
 * therefore surfaces at the consumer's typecheck, which is where it belongs.
 *
 * See docs/superpowers/specs/2026-09-17-plugin-mount-design.md §2.2.
 */
import type { AgentDescriptor, MCP_CONFIG_SHAPE } from "./types.ts"

/** A subagent role as an agent build mounts it (structural — this package does
 * not import `@i-harness/subagent`; a mismatch surfaces at the consumer's
 * typecheck). */
export interface MountedSubagentRole {
  name: string
  description: string
  systemPrompt: string
  tools: string[]
}

/** One declared tool that resolved to nothing usable. Reported, never dropped
 * silently. `reason` distinguishes the two paths, which are different problems:
 * a form this repo does not implement at all, versus a real tool this host does
 * not permit a plugin agent to use. */
export interface UnresolvedTool {
  role: string
  tool: string
  reason: string
}

/** Why a declaration could not be honoured (see UnresolvedTool.reason). */
const SCOPED_FORM = "scoped argument form is not a tool name"
const NOT_ALLOWED = "not a tool this host permits a plugin agent to use"

/**
 * Claude Code's tool vocabulary → this repo's registered names, for the entries
 * a plain case-fold cannot reach. Everything else maps by normalizing BOTH
 * sides (lowercase, `-`/`_` dropped), which is what makes `Read` → `read`,
 * `TodoWrite` → `todo_write` and `WebFetch` → `webfetch` fall out for free.
 *
 * The omissions are the interesting part. `KillShell`, `BashOutput` and the
 * whole `Task*` family have shape-similar counterparts here (`process_kill`,
 * `job_output`, `get_task_output`, `stop_task`), and GUESSING one would grant a
 * tool the plugin did not ask for. The family goes mapped or unmapped as a
 * whole — a half-mapping is harder to notice than none. `NotebookRead` and
 * `Workflow` have no counterpart at all. All of them land in `unresolved`.
 */
const RENAMES: Record<string, string> = {
  ls: "list_dir",
  askuserquestion: "ask_user_input",
  agent: "spawn_agent",
}

/** Case- and separator-insensitive form, used on BOTH sides of a lookup. */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "")
}

/**
 * Convert a plugin's agent descriptors into mountable subagent roles.
 *
 * THE SECURITY DIRECTION IS STRUCTURAL. `allowedTools` is the host's permit
 * list, and it is the ONLY source of a tool name in the output: a declaration
 * can narrow it and can never widen it. That is also why there is no separate
 * "default tools" option — a second list would be a second path to a tool
 * outside the allowlist.
 *
 * `d.tools === undefined` means the file declared no `tools:` key at all, which
 * is Claude Code's "inherit" — and inheriting the permit list cannot exceed it.
 * `[]` means the plugin asked for no tools, and stays empty.
 *
 * `model` is deliberately NOT carried. A role naming a MODEL would be fine, but
 * `SubagentRole.model` also carries a `provider`, and the provider belongs to
 * the host — the same boundary that keeps `blockedTools`/`auth`/`roots` out of
 * the MCP conversion above.
 */
export function toSubagentRoles(
  descriptors: AgentDescriptor[],
  opts: { allowedTools: string[] },
): { roles: MountedSubagentRole[]; unresolved: UnresolvedTool[] } {
  const allowed = new Map(opts.allowedTools.map((t) => [normalizeToolName(t), t]))
  const roles: MountedSubagentRole[] = []
  const unresolved: UnresolvedTool[] = []
  for (const d of descriptors) {
    const tools: string[] = []
    if (d.tools === undefined) {
      tools.push(...opts.allowedTools)
    } else {
      for (const declared of d.tools) {
        // a scoped entry (`Agent(ns:name)`, `Bash(git:*)`) is a per-argument
        // constraint, not a tool name. This repo has no such concept, so passing
        // the raw string through as a name would grant nothing while LOOKING
        // like a grant.
        if (declared.includes("(")) {
          unresolved.push({ role: d.name, tool: declared, reason: SCOPED_FORM })
          continue
        }
        const mapped = RENAMES[normalizeToolName(declared)] ?? declared
        const target = allowed.get(normalizeToolName(mapped))
        if (target === undefined) {
          unresolved.push({ role: d.name, tool: declared, reason: NOT_ALLOWED })
          continue
        }
        if (!tools.includes(target)) tools.push(target)
      }
    }
    roles.push({ name: d.name, description: d.description, systemPrompt: d.systemPrompt, tools })
  }
  return { roles, unresolved }
}

/** A stdio MCP server as an agent build mounts it. */
export interface MountedStdioMcp {
  transport: "stdio"
  serverName: string
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
}

/** A streamable-http MCP server as an agent build mounts it. */
export interface MountedHttpMcp {
  transport: "streamable-http"
  serverName: string
  url: string
  headers?: Record<string, string>
}

export type MountedMcpServer = MountedStdioMcp | MountedHttpMcp

/** One entry that could not be converted. Reported, never dropped silently. */
export interface SkippedMcpServer {
  serverName: string
  reason: string
}

/**
 * Convert a plugin's MCP config map into mountable server configs.
 *
 * Each returned object is built FIELD BY FIELD from values the plugin declared.
 * That is what enforces the security boundary: a key the plugin smuggled in
 * (plugin JSON is not typed, so this is reachable) has no line that could copy
 * it, so it cannot reach the consumer.
 *
 * A malformed entry — one declaring neither a usable `url` nor a usable
 * `command` — is SKIPPED AND REPORTED rather than silently dropped or allowed to
 * fail the whole set. `url` wins when both are present, because it is the more
 * specific declaration.
 */
export function toMcpServerConfigs(configs: Record<string, MCP_CONFIG_SHAPE>): {
  configs: MountedMcpServer[]
  skipped: SkippedMcpServer[]
} {
  const out: MountedMcpServer[] = []
  const skipped: SkippedMcpServer[] = []
  for (const [serverName, shape] of Object.entries(configs)) {
    const url = shape.url?.trim()
    if (url !== undefined && url !== "") {
      out.push({
        transport: "streamable-http",
        serverName,
        url,
        ...(shape.headers !== undefined ? { headers: shape.headers } : {}),
      })
      continue
    }
    const command = shape.command?.trim()
    if (command !== undefined && command !== "") {
      out.push({
        transport: "stdio",
        serverName,
        command,
        args: shape.args ?? [],
        ...(shape.cwd !== undefined ? { cwd: shape.cwd } : {}),
        ...(shape.env !== undefined ? { env: shape.env } : {}),
      })
      continue
    }
    skipped.push({ serverName, reason: "entry declares neither a url nor a command" })
  }
  return { configs: out, skipped }
}
