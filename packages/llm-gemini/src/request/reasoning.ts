import type { ReasoningEffort } from "@i-harness/llm-seam"

// One data: line's payloads (anthropic/llm-openai-compatible shape).
/**
 * M32 gemini translation table with generation rules — ONLY these two:
 * - gemini-3 (and unknown generations default to the current thinkingLevel
 *   wire) → `thinkingConfig:{thinkingLevel}`: off→minimal, low/medium/high
 *   verbatim, xhigh/max use the highest supported level.
 * - gemini-2.5 → `thinkingConfig:{thinkingBudget}`: off 0 / low 4096 /
 *   medium 8192 / high 16384; upper levels stay within each model's budget range.
 * Unset effort → undefined (don't send — provider default).
 */
export function translateReasoning(model: string, effort: ReasoningEffort | undefined):
  | { thinkingConfig: { thinkingLevel: string } }
  | { thinkingConfig: { thinkingBudget: number } }
  | undefined {
  if (effort === undefined) return undefined
  if (effort === "off" && (model.includes("gemini-2.5-pro") || /gemini-3(?:\.\d+)?-pro/.test(model))) throw new Error(`${model} cannot disable thinking`)
  if (model.includes("gemini-2.5")) {
    const cap = model.includes("pro") ? 32768 : 24576
    const thinkingBudget = effort === "off" ? 0 : effort === "low" ? 4096 : effort === "medium" ? 8192 : effort === "high" ? 16384 : effort === "xhigh" ? Math.min(24576, cap) : cap
    return { thinkingConfig: { thinkingBudget } }
  }
  const pro = /gemini-3(?:\.\d+)?-pro/.test(model)
  return { thinkingConfig: { thinkingLevel: effort === "xhigh" || effort === "max" || (pro && effort === "medium") ? "high" : effort === "off" ? pro ? "low" : "minimal" : effort } }
}
