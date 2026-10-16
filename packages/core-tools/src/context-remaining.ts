import type { SessionView as Session, BudgetRead } from "@i-harness/core-session"
import { contextStateFromBudget } from "@i-harness/core-session"
import type { PluginContext } from "@i-harness/core-plugin"
import { activeTokens } from "@i-harness/token-meter"
import type { ToolRegistry } from "./index.ts"

// M27-R-A8 (codex get_context_remaining parity): the model can ask how much
// context it has left. Shipping assemblies supply their actual budget owner.
// Direct legacy embedders retain a marked neutral-only history estimate.

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
        const state = contextStateFromBudget(opts.budgetRead())
        const snapshot = state.snapshot
        const facts = snapshot ? { window: snapshot.contextWindow, source: snapshot.estimateSource, confidence: snapshot.confidence, coverage: snapshot.coverage,
          outputReserve: snapshot.outputReserve, capSupport: snapshot.capSupport, effectiveOutputCap: snapshot.effectiveOutputCap,
          recoveryRequired: snapshot.recoveryRequired, fullByProvider: snapshot.fullByProvider } : {}
        if (state.kind === "unavailable") return { ...state, ...facts }
        return { ...state, ...facts, window: state.contextWindow, used: state.estimatedTokens, remaining: snapshot?.remainingInputBudget,
          percentage: Math.round(state.estimatedTokens / state.contextWindow * 100) }
      }
      const used = session === undefined ? 0 : activeTokens(session)
      const remaining = Math.max(0, window! - used)
      return {
        source: "neutral-only", confidence: "estimated", coverage: "neutral-only",
        window,
        used,
        remaining,
        percentage: Math.round((used / window!) * 100),
      }
    },
  })
}
