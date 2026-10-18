import { requestFields } from './fields.ts'
import type { PreparedTextOutput } from '@i-harness/llm-seam'
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const extras = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).some(k => !keys.includes(k))
/** Observe the SDK command; raw options live inside additional fields. */
export function observeTextOutput(body: unknown): PreparedTextOutput {
  if (!record(body)) return { status: 'unknown', reason: 'unsupported-output-options' }
  const additional = body.additionalModelRequestFields, tools = body.toolConfig, choice = record(tools) ? tools.toolChoice : undefined
  const output = record(additional) ? additional.output_config : undefined
  if (record(output) && record(output.format) && output.format.type === 'json_schema') return { status: 'blocked', reason: 'structured-output' }
  if (record(choice) && (choice.any !== undefined || choice.tool !== undefined)) return { status: 'blocked', reason: 'forced-tool' }
  let unknown = extras(body, requestFields)
  if (choice !== undefined && (!record(choice) || !record(choice.auto) || extras(choice, ['auto']) || extras(choice.auto, []))) unknown = true
  if (record(tools) && extras(tools, ['tools', 'toolChoice'])) unknown = true
  if (record(body.inferenceConfig) && extras(body.inferenceConfig, ['maxTokens', 'temperature', 'topP', 'stopSequences'])) unknown = true
  if (additional !== undefined) {
    if (!record(additional) || extras(additional, ['thinking', 'output_config', 'reasoningConfig'])) unknown = true
    else {
      const thinking = additional.thinking, nova = additional.reasoningConfig
      if (output !== undefined && (!record(output) || extras(output, ['effort']) || output.effort != null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(output.effort as string))) unknown = true
      if (thinking !== undefined && (!record(thinking) || !['enabled', 'disabled', 'adaptive'].includes(thinking.type as string) || extras(thinking, ['type', ...(thinking.type === 'enabled' ? ['budget_tokens'] : [])]))) unknown = true
      if (nova !== undefined && (!record(nova) || nova.type !== 'enabled' || !['low', 'medium', 'high'].includes(nova.maxReasoningEffort as string) || extras(nova, ['type', 'maxReasoningEffort']))) unknown = true
    }
  }
  return unknown ? { status: 'unknown', reason: 'unsupported-output-options' } : { status: 'allowed', reason: 'ordinary-text' }
}
