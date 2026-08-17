import { isAbsolute, relative, resolve } from "node:path"
import type { PluginContext } from "@i-harness/core-plugin"
import type { Tool, ToolCall, ToolDecision, ToolRegistry } from "@i-harness/core-tools"

export interface ApprovalConfig {
  workspace: string
  dangerousCommands?: string[]
  dangerousFlags?: string[]
  askForNonReadOnly?: boolean
}

const DEFAULT_DANGEROUS_COMMANDS = [
  "rm",
  "Remove-Item",
  "del",
  "rd",
  "erase",
  "shred",
  "wipe",
  "taskkill",
]
const DEFAULT_DANGEROUS_FLAGS = ["-rf", "-Recurse", "-Force"]

// Shell metacharacter sequences that carry control flow the argv parser
// cannot faithfully represent (Task 3 review: getArgv is ADVISORY, not
// authoritative — `; rm -rf /` parses to argv[0] === ";"). Presence anywhere
// in any token ⇒ the raw command string needs human approval.
const METACHAR_SEQUENCES = [";", "&&", "|", "$(", "`"]

const SHELL_TOOLS = new Set(["bash", "pwsh"])
const WRITE_TOOLS = new Set(["write"])

function basename(token: string): string {
  return token.split(/[\\/]/).pop() ?? ""
}

function hasMetachar(token: string): boolean {
  return METACHAR_SEQUENCES.some((m) => token.includes(m))
}

function isDangerousArgv(
  argv: string[],
  dangerousCommands: string[],
  dangerousFlags: string[],
): boolean {
  // deny-on-metachar: a metachar token anywhere ⇒ approval required, even if
  // every parsed basename looks harmless.
  if (argv.some(hasMetachar)) return true
  // Scan EVERY token's basename, not just argv[0], so `; rm -rf /` cannot
  // slip through when the parser lands argv[0] on the separator.
  if (argv.some((a) => dangerousCommands.includes(basename(a)))) return true
  if (argv.some((a) => dangerousFlags.includes(a))) return true
  return false
}

function isInsideWorkspace(workspace: string, p: string): boolean {
  const abs = p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p) ? resolve(p) : resolve(workspace, p)
  const rel = relative(workspace, abs)
  // rel === "" ⇒ the target IS the workspace root. Anything absolute
  // (cross-drive / UNC on Windows, root-relative on POSIX) or `..`-prefixed
  // is outside — fail closed.
  return rel === "" || (!isAbsolute(rel) && !rel.startsWith(".."))
}

// Mounts a tools/pre-execute decision handler implementing the three-layer
// approval policy. The handler returns `{ kind: "ask", ... }` to request
// approval and calls `next(payload)` either way (core-plugin waterfalls throw
// if next() is skipped). When no decision applies it returns the chain value,
// which the registry treats as no-decision (allow).
export function createApprovalPolicy(
  ctx: PluginContext,
  registry: ToolRegistry,
  config: ApprovalConfig,
): void {
  const workspace = config.workspace
  const dangerousCommands = config.dangerousCommands ?? DEFAULT_DANGEROUS_COMMANDS
  const dangerousFlags = config.dangerousFlags ?? DEFAULT_DANGEROUS_FLAGS
  const askForNonReadOnly = config.askForNonReadOnly ?? true

  ctx.waterfall("tools/pre-execute", async (payload, next) => {
    const call = payload as Partial<ToolCall>
    let decision: ToolDecision | undefined

    if (typeof call === "object" && call !== null && typeof call.name === "string") {
      const name = call.name
      const tool = registry.get(name) as (Tool & { getArgv?(args: unknown): string[] }) | undefined

      // Layer 1: readOnly tools need no approval.
      // Config can also opt out of asking for non-readOnly tools wholesale.
      if (!tool?.isReadOnly && askForNonReadOnly) {
        if (!tool) {
          // Unknown to this registry ⇒ metadata unavailable ⇒ fail closed.
          decision = { kind: "ask", reason: `tool '${name}' is not registered; approval required` }
        } else if (SHELL_TOOLS.has(name)) {
          // Layer 3: dangerous shell command, classified on parsed argv via
          // the tool's getArgv (advisory input, metachar-denying on top).
          const command = (call.args as { command?: string } | undefined)?.command ?? ""
          const argv = tool.getArgv?.(call.args) ?? command.split(/\s+/).filter((s) => s.length > 0)
          if (isDangerousArgv(argv, dangerousCommands, dangerousFlags)) {
            decision = { kind: "ask", reason: `dangerous command requires approval: ${argv.join(" ") || command}` }
          }
        } else if (WRITE_TOOLS.has(name)) {
          // Layer 2: directory whitelist — write inside workspace allows,
          // outside (or unspecified) asks.
          const pathArg = (call.args as { path?: string } | undefined)?.path
          if (pathArg === undefined) {
            decision = { kind: "ask", reason: "write target path not specified; approval required" }
          } else if (!isInsideWorkspace(workspace, pathArg)) {
            decision = { kind: "ask", reason: `write target outside workspace requires approval: ${pathArg}` }
          }
        } else {
          // Layer 1 fallback: any other non-readOnly tool requires approval.
          decision = { kind: "ask", reason: `tool '${name}' requires approval` }
        }
      }
    }

    // Always release the chain; veto by returning our decision object.
    const chainValue = await next(payload)
    return decision ?? chainValue
  })
}
