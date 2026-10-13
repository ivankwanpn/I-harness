import type { ReasoningEffort } from "@i-harness/llm-seam"
import type { BedrockReasoningFields } from "../types.ts"

/**
 * M32 generation rule: claude 4.x minor ≥ 6 (e.g. claude-sonnet-4-6 /
 * claude-opus-4-7+, also -4.6 style and anything later) uses the adaptive
 * protocol; every older generation uses the legacy budget protocol.
 */
const ADAPTIVE_CLAUDE_RE = /claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4[-.](?:6|7|8|9|[1-9][0-9]+)|[5-9](?:[-.]|$))/

/** Converse expects a number in the legacy budget slot. */
function legacyBudgetTokens(effort: "low" | "medium" | "high" | "xhigh" | "max"): number {
  return effort === "low" ? 2048 : effort === "medium" ? 8192 : effort === "high" ? 16384 : effort === "xhigh" ? 32768 : 65536
}

/**
 * M32 bedrock translation table with generation rules:
 * - Claude 4.6+ → `thinking:{type:"adaptive"}` plus
 *   `output_config:{effort}` in additionalModelRequestFields.
 * - Claude ≤4.5 → `thinking:{type:"enabled",budget_tokens:N}`.
 * - Amazon Nova → `reasoningConfig:{type:"enabled",maxReasoningEffort}`
 *   with the three levels Nova accepts.
 * - Unknown families reject an explicit effort locally.
 * - "off" → undefined (do not include any thinking fields).
 */
export function translateReasoning(model: string, effort: ReasoningEffort | undefined): BedrockReasoningFields | undefined {
  if (effort === undefined || effort === "off") return undefined
  if (/claude/i.test(model)) {
    if (ADAPTIVE_CLAUDE_RE.test(model)) {
      return { thinking: { type: "adaptive" }, output_config: { effort } }
    }
    return { thinking: { type: "enabled", budget_tokens: legacyBudgetTokens(effort) } }
  }
  if (/nova/i.test(model)) {
    return { reasoningConfig: { type: "enabled", maxReasoningEffort: effort === "low" || effort === "medium" ? effort : "high" } }
  }
  throw new Error(`Bedrock model does not have a known reasoning wire: ${model}`)
}
