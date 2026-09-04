export const GUARDIAN_BREAKER_WINDOW = 10
export const GUARDIAN_BREAKER_DENY_LIMIT = 3

export interface GuardianBreakerState {
  formatVersion: 1
  /** Sliding window of review outcomes, newest last. The three fail-closed
   * kinds (deny/timeout/malformed) ALL count toward opening; allow only
   * ages the window. */
  window: ("deny" | "allow" | "timeout" | "malformed")[]
}

// R-A9 circuit breaker (codex GuardianRejectionCircuitBreaker, re-implemented;
// M40 A7 amended): count fail-closed verdicts in the last 10 reviews —
// MODEL denials (deny), review timeouts and malformed-output denials all trip
// the breaker at >= 3. A timeout/malformed denial is not "model disagreement"
// per se, but a guardian that cannot produce a verdict is exactly the failure
// mode the breaker exists for: reviews stop (fail-closed deny without an LLM
// call) instead of burning the budget on a stuck reviewer.
export class GuardianBreaker {
  private window: ("deny" | "allow" | "timeout" | "malformed")[] = []

  constructor(restored?: GuardianBreakerState) {
    if (restored && isGuardianBreakerState(restored)) this.window = [...restored.window]
  }

  check(): "closed" | "open" {
    const denials = this.window.filter((w) => w !== "allow").length
    return denials >= GUARDIAN_BREAKER_DENY_LIMIT ? "open" : "closed"
  }

  record(outcome: "deny" | "allow" | "timeout" | "malformed"): void {
    this.window.push(outcome)
    if (this.window.length > GUARDIAN_BREAKER_WINDOW) {
      this.window = this.window.slice(-GUARDIAN_BREAKER_WINDOW)
    }
  }

  snapshot(): GuardianBreakerState {
    return { formatVersion: 1, window: [...this.window] }
  }
}

export function isGuardianBreakerState(value: unknown): value is GuardianBreakerState {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return v.formatVersion === 1 && Array.isArray(v.window)
    && v.window.every((w) => w === "deny" || w === "allow" || w === "timeout" || w === "malformed")
}
