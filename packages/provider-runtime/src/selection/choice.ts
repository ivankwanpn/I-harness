import type { ReasoningEffort } from "@i-harness/llm-seam"
import type { ProviderProtocol } from "@i-harness/provider"
import { PROVIDER_PROTOCOLS, type SettingsProviderProtocol, type SettingsDefaultModel } from "@i-harness/settings"
import type { ModelResolutionState } from "../types.ts"

interface SelectedModel {
  providerId: string
  modelId: string
  /** Rides through from the session selection to `resolveModel`'s chain — a
   * selection's protocol is MORE specific than the model row's or the route's. */
  protocol?: SettingsProviderProtocol
  reasoningEffort?: string
}

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

/** Kept per effective wire protocol, even while the canonical choices happen
 * to match. Adapter translation and provider-level refusal remain authoritative. */
export const REASONING_EFFORTS_BY_PROTOCOL: Record<ProviderProtocol, readonly ReasoningEffort[]> = {
  "openai-responses": ["off", "low", "medium", "high", "xhigh", "max"],
  "openai-compatible": ["off", "low", "medium", "high", "xhigh", "max"],
  "anthropic-messages": ["off", "low", "medium", "high", "xhigh", "max"],
  gemini: ["off", "low", "medium", "high", "xhigh", "max"],
  bedrock: ["off", "low", "medium", "high", "xhigh", "max"],
}

/** The refusal names the SET, not a placeholder: `--protocol P` copied
 * verbatim fails with `unknown protocol "P"` — a second error before the fix.
 * Same correction as 5d0f2d89 ("P was the --provider placeholder"). */
export const PROTOCOL_CHOICES = `<one of: ${PROVIDER_PROTOCOLS.join(" | ")}>`

export function selectModel(
  input: {
    sessionSelection?: { provider: string; model: string; protocol?: SettingsProviderProtocol; reasoningEffort?: string }
    override?: string
  },
  defaultModel: SettingsDefaultModel,
): SelectedModel | { state: ModelResolutionState } {
  if (input.override !== undefined && input.override !== "") {
    const separator = input.override.indexOf(":")
    if (separator <= 0 || separator === input.override.length - 1) {
      return {
        state: {
          status: "invalid",
          reason: `Invalid model override "${input.override}"; expected provider:model`,
        },
      }
    }
    return {
      providerId: input.override.slice(0, separator),
      modelId: input.override.slice(separator + 1),
    }
  }

  if (input.sessionSelection !== undefined) {
    if (input.sessionSelection.provider === "" || input.sessionSelection.model === "") {
      return { state: { status: "invalid", reason: "Session model selection requires provider and model" } }
    }
    return {
      providerId: input.sessionSelection.provider,
      modelId: input.sessionSelection.model,
      ...(input.sessionSelection.protocol !== undefined ? { protocol: input.sessionSelection.protocol } : {}),
      ...(input.sessionSelection.reasoningEffort !== undefined
        ? { reasoningEffort: input.sessionSelection.reasoningEffort }
        : {}),
    }
  }

  if (defaultModel.provider === "" || defaultModel.model === "") {
    return { state: { status: "unconfigured", reason: "No model configured" } }
  }
  return {
    providerId: defaultModel.provider,
    modelId: defaultModel.model,
    ...(defaultModel.reasoningEffort !== undefined
      ? { reasoningEffort: defaultModel.reasoningEffort }
      : {}),
  }
}

export function invalidState(
  reason: string,
  providerId?: string,
  modelId?: string,
): ModelResolutionState {
  return {
    status: "invalid",
    reason,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
  }
}

export function normalizeReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  return value !== undefined && REASONING_EFFORTS.has(value as ReasoningEffort)
    ? value as ReasoningEffort
    : undefined
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
