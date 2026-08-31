import type { GuardianVerdict } from "@i-harness/core-tools"

export const GUARDIAN_BREAKER_WINDOW = 10
export const GUARDIAN_BREAKER_DENY_LIMIT = 3

export interface GuardianBreakerState {
  formatVersion: 1
  /** Sliding window of review outcomes, newest last. */
  window: ("deny" | "allow")[]
}

// R-A9 circuit breaker (codex GuardianRejectionCircuitBreaker, re-implemented):
// count deny verdicts in the last 10 reviews — >= 3 ⇒ open ⇒ all further
// reviews deny WITHOUT an LLM call. Only MODEL verdicts are recorded here:
// timeouts/parse failures deny fail-closed but are not "model disagreement"
// and do not trip the breaker.
export class GuardianBreaker {
  private window: ("deny" | "allow")[] = []

  constructor(restored?: GuardianBreakerState) {
    if (restored && isGuardianBreakerState(restored)) this.window = [...restored.window]
  }

  check(): "closed" | "open" {
    const denials = this.window.filter((w) => w === "deny").length
    return denials >= GUARDIAN_BREAKER_DENY_LIMIT ? "open" : "closed"
  }

  record(outcome: GuardianVerdict["outcome"]): void {
    const kind: "deny" | "allow" = outcome === "deny" ? "deny" : "allow"
    this.window.push(kind)
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
    && v.window.every((w) => w === "deny" || w === "allow")
}
