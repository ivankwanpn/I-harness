import type { PluginContext } from "@i-harness/core-plugin"
import type { ApprovalGuardian, GuardianRequest, GuardianVerdict } from "@i-harness/core-tools"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { GuardianBreaker, isGuardianBreakerState } from "./breaker.ts"
import { runGuardianReview, type GuardianReviewDeps } from "./reviewer.ts"

export { runGuardianReview, ensureReviewerRole, renderGuardianMessage, renderRecentContext, BUNDLED_GUARDIAN_POLICY, GUARDIAN_REVIEW_TIMEOUT_MS, GUARDIAN_REVIEWER_ROLE_NAME } from "./reviewer.ts"
export type { GuardianReviewDeps } from "./reviewer.ts"

export interface GuardianConfig extends GuardianReviewDeps {
  /** A mounted reviewer can be enabled without rebuilding an active Agent. */
  enabled?: () => boolean
  /** A failed reviewer may defer to the human instead of denying the tool. */
  fallbackToHumanOnFailure?: boolean
  /** Durable breaker mirror (subagent state-doc pattern — coordinator documents). */
  breaker?: { coordinator: SessionCoordinator; sessionId: string }
}

// Doc-key prefix. The key becomes the JSONL doc filename verbatim, so it must
// be a valid Windows filename (no "/" — path separator — and no ":" — EINVAL).
const BREAKER_STATE_PREFIX = "guardian-"

const isGuardianVerdict = (value: unknown): value is GuardianVerdict => {
  const v = value as GuardianVerdict
  return typeof v === "object" && v !== null &&
    (v.outcome === "approve" || v.outcome === "allow" || v.outcome === "deny") &&
    typeof v.rationale === "string"
}

// R-A9 mount: registers the `approval/guardian` service consumed by core-tools'
// ask branch (Task 13). Fail-closed: open breaker / timeout / malformed output
// ⇒ deny; only `allow` falls through to the human answerer. The breaker mirror
// restores best-effort (an unreadable doc → fresh breaker — fresh = closed,
// which can only over-grant... no: fresh-closed means reviews run; the breaker
// only opens on model denials, so a lost doc merely forgets recent denials —
// admission of that risk is documented; the fail-closed path is the per-review
// deny outcome, not the breaker).
export async function registerGuardian(ctx: PluginContext, config: GuardianConfig): Promise<void> {
  let breaker: GuardianBreaker | undefined
  if (config.breaker) {
    const key = BREAKER_STATE_PREFIX + config.breaker.sessionId
    try {
      const restored = await config.breaker.coordinator.getDocument(key)
      breaker = new GuardianBreaker(isGuardianBreakerState(restored) ? restored : undefined)
    } catch {
      breaker = new GuardianBreaker()
    }
  }

  const review: ApprovalGuardian = async (request: GuardianRequest): Promise<GuardianVerdict> => {
    if (config.enabled?.() === false) return { outcome: "allow", rationale: "Delegated approval is disabled" }
    if (breaker?.check() === "open") {
      return config.fallbackToHumanOnFailure
        ? { outcome: "allow", rationale: "guardian circuit breaker open; ask the human" }
        : { outcome: "deny", rationale: "guardian circuit breaker open (3+ denials in the last 10 reviews)" }
    }
    let verdict: Awaited<ReturnType<typeof runGuardianReview>>
    try { verdict = await runGuardianReview(config, request) }
    catch (error) {
      if (config.fallbackToHumanOnFailure) return { outcome: "allow", rationale: `guardian could not start: ${error instanceof Error ? error.message : String(error)}; ask the human` }
      throw error
    }
    if (isGuardianVerdict(verdict) && breaker && config.breaker) {
      // M40 A7: timeout/malformed fail-closed denials COUNT in the breaker too
      // (the runner tags them via `cause`); model verdicts record the plain
      // deny/allow kind as before.
      breaker.record(
        verdict.cause === "timeout" ? "timeout"
          : verdict.cause === "malformed" || verdict.cause === "operational" ? "malformed"
          : verdict.outcome === "deny" ? "deny" : "allow",
      )
      const key = BREAKER_STATE_PREFIX + config.breaker.sessionId
      // fail-soft doc mirror: putDocument reports internally and never rejects
      void config.breaker.coordinator.putDocument(key, breaker.snapshot())
    }
    return config.fallbackToHumanOnFailure && verdict.outcome === "deny" && verdict.cause !== undefined
      ? { outcome: "allow", rationale: `guardian review ${verdict.cause}; ask the human` }
      : verdict
  }
  ctx.services.register("approval/guardian", review)
}
