import type { PreparedTextOutput } from '@i-harness/llm-seam'
import { known } from './fields.ts'
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const extras = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).some(k => !keys.includes(k))
export function observeTextOutput(body: unknown): PreparedTextOutput {
  if (!record(body)) return { status: 'unknown', reason: 'unsupported-output-options' }
  const output = body.output_config, choice = body.tool_choice, thinking = body.thinking
  if (record(output) && record(output.format) && output.format.type === 'json_schema') return { status: 'blocked', reason: 'structured-output' }
  if (record(choice) && ['any', 'tool'].includes(choice.type as string)) return { status: 'blocked', reason: 'forced-tool' }
  let unknown = Object.keys(body).some(k => !known.has(k))
  if (output !== undefined && (!record(output) || extras(output, ['effort']) || output.effort != null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(output.effort as string))) unknown = true
  if (thinking !== undefined && (!record(thinking) || !['enabled', 'disabled', 'adaptive', 'between_tools'].includes(thinking.type as string)
    || extras(thinking, ['type', ...(thinking.type === 'enabled' ? ['budget_tokens'] : [])]))) unknown = true
  if (choice !== undefined && (!record(choice) || !['auto', 'none'].includes(choice.type as string) || extras(choice, ['type', 'disable_parallel_tool_use']))) unknown = true
  return unknown ? { status: 'unknown', reason: 'unsupported-output-options' } : { status: 'allowed', reason: 'ordinary-text' }
}
