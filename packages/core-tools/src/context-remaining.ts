import type { Session, BudgetRead } from "@i-harness/core-session"
import type { PluginContext } from "@i-harness/core-plugin"
import { activeTokens } from "@i-harness/token-meter"
import type { ToolRegistry } from "./index.ts"

// M27-R-A8 (codex get_context_remaining parity): the model can ask how much
// context it has left. `used` follows the M15 single projection rule — only
// deriveMessages(session) is ever seen by a model, so tokens are counted on
// that exact output (activeTokens). Registering is FAIL-CLOSED: without a
// contextWindow the tool is not in the catalog at all.

export interface ContextRemainingOptions {
  budgetRead?: () => BudgetRead
  /** Model context window (tokens; M15 provider-record knowledge). Absent →
   * NOT registered (fail-closed). */
  contextWindow?: number
  /** Live session to price. Absent → documented estimator: the empty history
   * (used = 0) until the caller attaches the session. */
  session?: Session
}

export function registerContextRemaining(_ctx: PluginContext, tools: ToolRegistry, opts: ContextRemainingOptions = {}): void {
  const window = opts.contextWindow
  if (!opts.budgetRead && (window === undefined || window <= 0)) return
  const session = opts.session
  tools.register({
    name: "get_context_remaining",
    description: "回報剩餘上下文預算（window/used/remaining/percentage）。",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    // Pure read (session pricing) — auto-allow under the approval policy.
    isReadOnly: true,
    execute: async () => {
      if (opts.budgetRead) {
        const state = opts.budgetRead()
        if (state.kind === "unavailable" || state.snapshot.admission === "unavailable" || state.snapshot.recoveryRequired) return { kind: "unavailable", reason: state.kind === "unavailable" ? state.reason : state.snapshot.reason, ...(state.kind === "ready" ? { window: state.snapshot.contextWindow, snapshot: state.snapshot } : {}) }
        const snapshot = state.snapshot
        return { kind: "ready", window: snapshot.contextWindow, used: snapshot.admissionInputTokens, remaining: snapshot.remainingInputBudget,
          percentage: snapshot.contextWindow ? Math.round(snapshot.admissionInputTokens / snapshot.contextWindow * 100) : undefined, snapshot }
      }
      const used = session === undefined ? 0 : activeTokens(session)
      const remaining = Math.max(0, window! - used)
      return {
        window,
        used,
        remaining,
        percentage: Math.round((used / window!) * 100),
      }
    },
  })
}
