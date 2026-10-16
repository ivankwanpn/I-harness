import type { ContextBindingMetadata } from "@i-harness/core-session"
import type { ModelLimits, GenerationPolicy } from "@i-harness/token-meter"
import type { ReasoningEffort } from "./index.ts"

export type RouteKind = "openai-responses" | "openai-responses-subscription" | "openai-compatible" | "anthropic-messages" | "gemini" | "bedrock"
export interface RouteBudgetCapability {
  readonly version: 1
  readonly route: RouteKind
  readonly evidenceId: string
  readonly outputParameter: "required" | "optional" | "unsupported" | "unknown"
  readonly packetKind: "http-json-body" | "sdk-command-estimate"
}
export interface ModelBudgetBinding {
  readonly version: 1
  readonly metadata: Readonly<ContextBindingMetadata>
  readonly limits: ModelLimits
  readonly generation: GenerationPolicy
  readonly capability: RouteBudgetCapability
  readonly reasoningEffort?: ReasoningEffort
}

/** This adapter's contract, not a backend probe or the final prepared output. */
export function describeRouteBudgetCapability(input: { protocol: Exclude<RouteKind, "openai-responses-subscription">; codexSubscription?: boolean }): RouteBudgetCapability {
  if (input.codexSubscription && input.protocol !== "openai-responses") throw new Error("Codex subscription requires Responses protocol")
  const route = input.codexSubscription ? "openai-responses-subscription" : input.protocol
  return { version: 1, route, evidenceId: `adapter-budget-v1:${route}`,
    outputParameter: input.codexSubscription ? "unsupported" : route === "anthropic-messages" ? "required" : "optional",
    packetKind: route === "bedrock" ? "sdk-command-estimate" : "http-json-body" }
}
