/** ToolResultBlock's documented Claude3/4 status support and literal ID examples
 * checked 2026-10-16. Profile aliases and injected transports are unknown. */
const statusModels = new Set(['anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-sonnet-4-6', 'anthropic.claude-opus-4-6-v1', 'anthropic.claude-opus-4-7', 'anthropic.claude-opus-4-8'])
export function bedrockCapabilities(model: string, official: boolean) {
  // ToolResultBlock.status and ToolResultContentBlock.image have separate
  // documented restrictions to Nova/Claude3/4; these exact evidenced IDs
  // establish both facts. Generic user images remain declaration-controlled.
  const supported = official && statusModels.has(model) ? true : undefined
  return { status: supported, toolImage: supported, genericReasoningSignatureRequired: false as const }
}
