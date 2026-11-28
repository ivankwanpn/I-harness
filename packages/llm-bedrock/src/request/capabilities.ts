import type { ConverseStreamCommandInput } from '@aws-sdk/client-bedrock-runtime'

/** Documented vision models supporting both ToolResultBlock.status and tool images. */
const toolImageModels = new Set([
  'amazon.nova-lite-v1:0', 'amazon.nova-pro-v1:0', 'amazon.nova-premier-v1:0', 'amazon.nova-2-lite-v1:0',
  'anthropic.claude-3-7-sonnet-20250219-v1:0', 'anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-sonnet-4-6',
  'anthropic.claude-opus-4-6-v1', 'anthropic.claude-opus-4-7', 'anthropic.claude-opus-4-8',
])
export function bedrockCapabilities(model: string, official: boolean) {
  // ToolResultBlock.status and ToolResultContentBlock.image have separate
  // documented restrictions to Nova/Claude3/4; these exact evidenced IDs
  // establish both facts. Generic user images remain declaration-controlled.
  const toolImage = official && toolImageModels.has(model) ? true : undefined
  const status = toolImage || official && model === 'amazon.nova-micro-v1:0' ? true : undefined
  return { status, toolImage, genericReasoningSignatureRequired: false as const }
}
// AWS Bedrock's extended-thinking model table specifies these exact foundation
// model IDs. Inference-profile aliases and custom endpoints stay unqualified.
const extendedThinkingModels = new Set([
  'anthropic.claude-3-7-sonnet-20250219-v1:0', 'anthropic.claude-opus-4-20250514-v1:0',
  'anthropic.claude-sonnet-4-20250514-v1:0', 'anthropic.claude-opus-4-5-20251101-v1:0',
  'anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-sonnet-4-6', 'anthropic.claude-opus-4-6-v1',
])

export function bedrockThinkingBudget(body: ConverseStreamCommandInput, nativeEndpoint: boolean) {
  if (!nativeEndpoint || !body.modelId || !extendedThinkingModels.has(body.modelId)) return
  const fields = body.additionalModelRequestFields as { thinking?: {type?: string; budget_tokens?: unknown}; anthropic_beta?: unknown } | undefined
  if (fields?.thinking?.type !== 'enabled') return
  const interleaved = !body.modelId.includes('claude-3-7-') && !!body.toolConfig?.tools?.length &&
    Array.isArray(fields.anthropic_beta) && fields.anthropic_beta.includes('interleaved-thinking-2025-05-14')
  const tokens = fields.thinking.budget_tokens
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 1024 ||
    !interleaved && tokens === Number.MAX_SAFE_INTEGER) return { kind: 'invalid' as const }
  return { kind: 'known' as const, minimumCap: interleaved ? 1 : tokens + 1 }
}
