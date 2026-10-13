import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolDecision } from "../types.ts"

const DECISION_KINDS = new Set(["allow", "deny", "ask"])

// Strictness ranking for decision merging: deny > ask > allow. A stricter
// decision always wins so an ancestor deny can never be downgraded by a nearer
// allow (monotonic, matching the guard layer's union-of-ancestors semantics).
const DECISION_STRICTNESS: Record<ToolDecision["kind"], number> = { allow: 0, ask: 1, deny: 2 }

// Decision merge is single-candidate: resolveDecision returns the NEAREST
// ancestor decision, and the propagation model allows at most one producer
// per emit (once a nearer policy seeds, the payload reaching farther
// ancestors is the decision object, which policies refuse to re-classify).
// A resolveStrictestDecision walk is therefore a no-op today; revisit only if
// multi-producer decisions become possible.

// Validate an arbitrary value against the same closed-vocabulary rules as the
// pre-execute waterfall handler (audit F03-1): a non-object is malformed
// (HARD error, never allow); an object without `kind` contributes no decision;
// an object whose `kind` is outside the vocabulary is malformed. Returns the
// stricter of the local decision and the (validated) candidate.
export function mergeDecision(local: ToolDecision, candidate: unknown): ToolDecision {
  if (candidate === undefined) return local
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error(`malformed pre-execute decision: ${JSON.stringify(candidate)}`)
  }
  const d = candidate as ToolDecision
  if (!("kind" in d)) return local
  if (!DECISION_KINDS.has(d.kind)) {
    throw new Error(`malformed pre-execute decision: ${JSON.stringify(candidate)}`)
  }
  return DECISION_STRICTNESS[d.kind] > DECISION_STRICTNESS[local.kind] ? d : local
}

export function isDecision(value: unknown): value is ToolDecision {
  return typeof value === "object" && value !== null && "kind" in value && DECISION_KINDS.has((value as ToolDecision).kind)
}

export function installPreExecuteDecision(ctx: PluginContext): void {
  // Per-dispatch pre-execute decision (M13): the handler RETURNS the validated
  // candidate as the waterfall chain value (read by `prepare` from emit's
  // return) instead of writing a shared closure slot — a shared slot races
  // under concurrent prepares. The handler is still registered ONCE at
  // construction so dispatches reuse it (no transient handler churn).
  //
  // CRITICAL — return `undefined` (not `{ kind: "allow" }`) when no decision
  // was produced: emitFn propagates `resolvedPayload` parent-ward, and a
  // parent scope's guard-approval classifies the ToolCall payload. Returning a
  // decision object here would make the parent see a decision instead of the
  // call and skip classification (fail-open for ancestor approval). Returning
  // undefined falls back to the chain payload (the call) — the pre-M13
  // semantics. `prepare` normalizes the undefined case to allow.
  ctx.waterfall("tools/pre-execute", async (payload, next) => {
    const chainValue = await next(payload)
    // Closed-vocabulary rules (audit F03-1):
    //   - undefined                → no decision (allow)
    //   - object WITHOUT a `kind`  → raw ToolCall passthrough → no decision
    //   - object WITH a `kind`     → must be in DECISION_KINDS else HARD error
    //   - any non-object value     → malformed decision, HARD error (never allow)
    if (chainValue === undefined) return undefined
    if (typeof chainValue !== "object" || chainValue === null) {
      throw new Error(`malformed pre-execute decision: ${JSON.stringify(chainValue)}`)
    }
    const candidate = chainValue as ToolDecision
    if (!("kind" in candidate)) return undefined
    if (!DECISION_KINDS.has(candidate.kind)) {
      throw new Error(`malformed pre-execute decision: ${JSON.stringify(chainValue)}`)
    }
    return candidate
  })

}
