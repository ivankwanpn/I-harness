import type { ReasoningEffort } from "@i-harness/llm-seam"

/**
 * M32 openai-family translation table (Responses | Chat | DeepSeek — ONE
 * table, zero generation special-casing): the effort is passed through
 * verbatim and "off" maps to "none" (top-level Chat `reasoning_effort`).
 * DeepSeek uses the SAME table — its server maps medium→high itself.
 * Unset effort → undefined (don't send).
 */
export function translateReasoning(_model: string, effort: ReasoningEffort | undefined): { reasoning_effort: string } | undefined {
  if (effort === undefined) return undefined
  return { reasoning_effort: effort === "off" ? "none" : effort }
}
