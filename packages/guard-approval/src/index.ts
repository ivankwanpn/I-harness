import { isAbsolute, relative, resolve } from "node:path"
import type { PluginContext } from "@i-harness/core-plugin"
import type { Tool, ToolCall, ToolDecision, ToolRegistry } from "@i-harness/core-tools"
import { classifyDanger } from "./danger-class.ts"

export interface ApprovalConfig {
  workspace: string
  dangerousCommands?: string[]
  dangerousFlags?: string[]
  askForNonReadOnly?: boolean
  // M22: 分類器判 ask 即達 deny-with-reason（headless 安全姿態）
  approvalPolicy?: "ask" | "never"
}

// 匯出供測試與呼叫端重用/檢視（分類器對清單做 case-insensitive 比對）。
export const DEFAULT_DANGEROUS_COMMANDS = [
  "rm",
  "Remove-Item",
  "del",
  "rd",
  "erase",
  "shred",
  "wipe",
  "taskkill",
]
export const DEFAULT_DANGEROUS_FLAGS = ["-rf", "-Recurse", "-Force"]

const SHELL_TOOLS = new Set(["bash", "pwsh"])
const WRITE_TOOLS = new Set(["write"])

// M22: 'never' policy — an ask-decision (danger classifier or whitelist) is
// promoted to deny-with-reason instead of consulting the approval answerer
// (headless posture: no interactive prompt can ever approve execution).
function applyNever(decision: ToolDecision | undefined, approvalPolicy: "ask" | "never" | undefined): ToolDecision | undefined {
  if (approvalPolicy !== "never" || decision === undefined || decision.kind !== "ask") return decision
  return { kind: "deny", reason: `approval policy is 'never'; ${decision.reason}` }
}

function isInsideWorkspace(workspace: string, p: string): boolean {
  const abs = p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p) ? resolve(p) : resolve(workspace, p)
  const rel = relative(workspace, abs)
  // rel === "" ⇒ the target IS the workspace root. Anything absolute
  // (cross-drive / UNC on Windows, root-relative on POSIX) or `..`-prefixed
  // is outside — fail closed.
  return rel === "" || (!isAbsolute(rel) && !rel.startsWith(".."))
}

// Computes the three-layer approval decision for a pre-execute payload.
// Returns `{ kind: "ask", reason }` when approval is required, otherwise
// undefined (no decision ⇒ allow). Shared by the plain-listener seed and the
// waterfall handler so both always agree.
function decide(
  payload: unknown,
  registry: ToolRegistry,
  workspace: string,
  dangerousCommands: string[],
  dangerousFlags: string[],
  askForNonReadOnly: boolean,
): ToolDecision | undefined {
  // Single-producer property: at most one policy seeds a decision per emit,
  // and the seeded value is the chain payload that reaches every waterfall
  // handler. A payload that is already a decision object ({ kind: ... }) must
  // pass through unchanged — it is the previous producer's decision, not a
  // ToolCall to classify. Without this, re-parsing it as a ToolCall would
  // silently drop the decision and fail open.
  const asDecision = payload as { kind?: unknown }
  if (asDecision && typeof asDecision.kind === "string") return undefined

  const call = payload as Partial<ToolCall>
  if (typeof call !== "object" || call === null || typeof call.name !== "string") return undefined

  const name = call.name
  const tool = registry.get(name) as (Tool & { getArgv?(args: unknown): string[] }) | undefined

  // Layer 1: readOnly tools need no approval.
  // Config can also opt out of asking for non-readOnly tools wholesale.
  if (!tool?.isReadOnly && askForNonReadOnly) {
    if (!tool) {
      // Unknown to this registry ⇒ metadata unavailable ⇒ fail closed.
      return { kind: "ask", reason: `tool '${name}' is not registered; approval required` }
    }
    if (SHELL_TOOLS.has(name)) {
      // Layer 3: dangerous shell command, classified on parsed argv via the
      // tool's getArgv (advisory input) + the danger-class classifier —
      // metachar-denying, OS-level/escape escalation to "extreme" (M22).
      const command = (call.args as { command?: string } | undefined)?.command ?? ""
      const argv = tool.getArgv?.(call.args) ?? command.split(/\s+/).filter((s) => s.length > 0)
      const danger = classifyDanger(argv, workspace, dangerousCommands, dangerousFlags)
      if (danger !== "none") {
        const reason = danger === "extreme"
          ? `EXTREME DESTRUCTIVE command: ${argv.join(" ")} — approval requires explicit confirmation`
          : `dangerous command requires approval: ${argv.join(" ") || command}`
        return { kind: "ask", reason }
      }
    } else if (WRITE_TOOLS.has(name)) {
      // Layer 2: directory whitelist — write inside workspace allows,
      // outside (or unspecified) asks.
      const pathArg = (call.args as { path?: string } | undefined)?.path
      if (pathArg === undefined) {
        return { kind: "ask", reason: "write target path not specified; approval required" }
      }
      if (!isInsideWorkspace(workspace, pathArg)) {
        return { kind: "ask", reason: `write target outside workspace requires approval: ${pathArg}` }
      }
    } else {
      // Layer 1 fallback: any other non-readOnly tool requires approval.
      return { kind: "ask", reason: `tool '${name}' requires approval` }
    }
  }
  return undefined
}

// Mounts a tools/pre-execute decision handler implementing the three-layer
// approval policy. The waterfall handler returns `{ kind: "ask", ... }` to
// request approval and calls `next(payload)` either way (core-plugin
// waterfalls throw if next() is skipped). When no decision applies it returns
// the chain value, which the registry treats as no-decision (allow).
//
// Cross-scope visibility (Task 10 mechanism B): a waterfall-only handler is
// invisible to `ctx.resolveDecision` (emitFn records a scope decision only
// when a PLAIN listener seeded the chain), so a child scope's registry — which
// reads only its own waterfall chain's return — would fail OPEN on a
// parent-mounted policy. The policy therefore ALSO seeds via a plain listener:
// its decision is recorded in this scope's per-emit decisions map, which
// core-tools' `execute` consults after emit to gate dispatches from any
// descendant scope's registry.
export function createApprovalPolicy(
  ctx: PluginContext,
  registry: ToolRegistry,
  config: ApprovalConfig,
): void {
  const workspace = config.workspace
  const dangerousCommands = config.dangerousCommands ?? DEFAULT_DANGEROUS_COMMANDS
  const dangerousFlags = config.dangerousFlags ?? DEFAULT_DANGEROUS_FLAGS
  const askForNonReadOnly = config.askForNonReadOnly ?? true

  ctx.on("tools/pre-execute", (payload) =>
    applyNever(
      decide(payload, registry, workspace, dangerousCommands, dangerousFlags, askForNonReadOnly),
      config.approvalPolicy,
    ),
  )

  ctx.waterfall("tools/pre-execute", async (payload, next) => {
    const decision = applyNever(
      decide(payload, registry, workspace, dangerousCommands, dangerousFlags, askForNonReadOnly),
      config.approvalPolicy,
    )
    // Always release the chain; veto by returning our decision object.
    const chainValue = await next(payload)
    return decision ?? chainValue
  })
}
