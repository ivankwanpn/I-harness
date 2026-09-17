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
 * STRUCTURAL RETURN: this package does not import `@i-harness/mcp-client`. A
 * mismatch between `MountedMcpServer` and the consumer's type surfaces at the
 * consumer's typecheck, which is where it belongs.
 *
 * See docs/superpowers/specs/2026-09-17-plugin-mount-design.md §2.2.
 */
import type { MCP_CONFIG_SHAPE } from "./types.ts"

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
