import type { Session } from "@i-harness/core-session"
import type { PluginContext } from "@i-harness/core-plugin"
import { activeTokens } from "@i-harness/token-meter"
import type { ToolRegistry } from "./index.ts"

// M27-R-A8 (codex get_context_remaining parity): the model can ask how much
// context it has left. `used` follows the M15 single projection rule — only
// deriveMessages(session) is ever seen by a model, so tokens are counted on
// that exact output (activeTokens). Registering is FAIL-CLOSED: without a
// contextWindow the tool is not in the catalog at all.

export interface ContextRemainingOptions {
  /** Model context window (tokens; M15 provider-record knowledge). Absent →
   * NOT registered (fail-closed). */
  contextWindow?: number
  /** Live session to price. Absent → documented estimator: the empty history
   * (used = 0) until the caller attaches the session. */
  session?: Session
}

export function registerContextRemaining(_ctx: PluginContext, tools: ToolRegistry, opts: ContextRemainingOptions = {}): void {
  const window = opts.contextWindow
  if (window === undefined || window <= 0) return // fail-closed: no window knowledge → 不註冊
  const session = opts.session
  tools.register({
    name: "get_context_remaining",
    description: "回報剩餘上下文預算（window/used/remaining/percentage）。",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    execute: async () => {
      const used = session === undefined ? 0 : activeTokens(session)
      const remaining = Math.max(0, window - used)
      return {
        window,
        used,
        remaining,
        percentage: Math.round((used / window) * 100),
      }
    },
  })
}
