import type { BedrockRuntimeClient as BedrockRuntimeClientClass } from "@aws-sdk/client-bedrock-runtime"

export interface BedrockConfig {
  /** Required by the Converse API (`modelId` — an ARN or the model id). */
  model: string
  providerId?: string
  region?: string
  /** AWS credential-profile name (the SDK's credential chain resolves it). */
  profile?: string
  /** Extra model parameters → additionalModelRequestFields (Converse only
   * accepts maxTokens/temperature/topP/stopSequences in inferenceConfig). */
  options?: Record<string, unknown>
  // M14: mirrors ProviderProfile.inputModalities — when the route lacks
  // "image", images are projected out before wire mapping.
  inputModalities?: ("text" | "image")[]
}

/** The runtime-client face the adapter needs. A caller may inject a fake with
 * this shape (tests inject one — no network, no AWS credential chain). */
export type BedrockRuntimeFace = Pick<BedrockRuntimeClientClass, "send" | "destroy">

/** Wire fields for `additionalModelRequestFields` (the adapter's free-form
 * extra-parameters channel — Converse only accepts maxTokens/temperature/
 * topP/stopSequences in inferenceConfig). */
export interface BedrockReasoningFields {
  reasoningConfig?: { type: "enabled"; maxReasoningEffort: "low" | "medium" | "high" }
  thinking?: { type: "adaptive" } | { type: "enabled"; budget_tokens: number }
  output_config?: { effort: string }
}

