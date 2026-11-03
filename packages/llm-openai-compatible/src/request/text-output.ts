import type { PreparedTextOutput } from '@i-harness/llm-seam'
import { known } from './fields.ts'
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const extras = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).some(k => !keys.includes(k))
/** Only final generation controls; schemas, cache data and input stay opaque. */
export function observeTextOutput(body: unknown): PreparedTextOutput {
  if (!record(body)) return { status: 'unknown', reason: 'unsupported-output-options' }
  const format = body.response_format, choice = body.tool_choice
  if (record(format) && ['json_object', 'json_schema'].includes(format.type as string)) return { status: 'blocked', reason: 'structured-output' }
  if (choice === 'required' || record(choice) && (['function', 'custom'].includes(choice.type as string)
    || choice.type === 'allowed_tools' && record(choice.allowed_tools) && choice.allowed_tools.mode === 'required')) return { status: 'blocked', reason: 'forced-tool' }
  let unknown = Object.keys(body).some(k => !known.has(k))
  if (format != null && (!record(format) || format.type !== 'text' || extras(format, ['type']))) unknown = true
  if (body.reasoning_effort != null && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning_effort as string)) unknown = true
  if (choice !== undefined && choice !== 'auto' && choice !== 'none') {
    const allowed = record(choice) && choice.type === 'allowed_tools' && record(choice.allowed_tools) ? choice.allowed_tools : undefined
    if (!allowed || allowed.mode !== 'auto' || extras(choice as Record<string, unknown>, ['type', 'allowed_tools']) || extras(allowed, ['mode', 'tools'])
      || !Array.isArray(allowed.tools) || allowed.tools.some(tool => !record(tool) || !['function', 'custom'].includes(tool.type as string)
        || extras(tool, ['type', tool.type as string]) || !record(tool[tool.type as string]) || extras(tool[tool.type as string] as Record<string, unknown>, ['name']))) unknown = true
  }
  if (record(body.stream_options) && extras(body.stream_options, ['include_usage', 'include_obfuscation'])) unknown = true
  return unknown ? { status: 'unknown', reason: 'unsupported-output-options' } : { status: 'allowed', reason: 'ordinary-text' }
}
