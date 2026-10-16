import type { ReasoningEffort } from "@i-harness/llm-seam"

/**
 * M32 generation rule (cc-custom style, adapter-internal): model names
 * carrying a 4.x minor ≥ 6 (e.g. claude-sonnet-4-6, claude-opus-4-7/-4-8,
 * also the -4.6 dotted style, and anything later) use the ADAPTIVE thinking
 * protocol; every older generation uses the legacy budget protocol.
 */
const ADAPTIVE_THINKING_RE = /claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4[-.](?:6|7|8|9|[1-9][0-9]+)|[5-9](?:[-.]|$))/

/** Legacy budgets are numeric; the UI's upper effort levels map to larger budgets. */
function legacyBudgetTokens(effort: "low" | "medium" | "high" | "xhigh" | "max"): number {
  return effort === "low" ? 2048 : effort === "medium" ? 8192 : effort === "high" ? 16384 : effort === "xhigh" ? 32768 : 65536
}

/**
 * M32 anthropic translation table with generation rules:
 * - 4.6+ → `thinking:{type:"adaptive"}` + `output_config:{effort}` (effort
 *   verbatim — xhigh/max included, the provider rejects what it cannot do).
 * - legacy → numeric `thinking:{type:"enabled", budget_tokens:N}`; effort is
 *   never sent to legacy (its translation is a token budget).
 * - "off" → return undefined: NO thinking block in either generation.
 * - unset → undefined (don't send — provider default).
 */
export function translateReasoning(model: string, effort: ReasoningEffort | undefined):
  | { thinking: { type: "adaptive" }; output_config: { effort: string } }
  | { thinking: { type: "enabled"; budget_tokens: number } }
  | undefined {
  if (effort === undefined || effort === "off") return undefined
  if (ADAPTIVE_THINKING_RE.test(model)) {
    return { thinking: { type: "adaptive" }, output_config: { effort } }
  }
  return { thinking: { type: "enabled", budget_tokens: legacyBudgetTokens(effort) } }
}
