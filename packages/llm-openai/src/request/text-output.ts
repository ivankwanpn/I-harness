import type { PreparedTextOutput } from '@i-harness/llm-seam'
import { publicFields } from './fields.ts'
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const extras = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).some(k => !keys.includes(k))
const namedTools = ['function', 'custom', 'file_search', 'web_search', 'web_search_preview', 'computer_use_preview', 'code_interpreter', 'image_generation', 'local_shell', 'shell', 'apply_patch', 'mcp']
/** Public and subscription callers supply their own already-lowered body. */
export function observeTextOutput(body: unknown): PreparedTextOutput {
  if (!record(body)) return { status: 'unknown', reason: 'unsupported-output-options' }
  const text = body.text, format = record(text) ? text.format : undefined, choice = body.tool_choice
  if (record(format) && ['json_object', 'json_schema'].includes(format.type as string)) return { status: 'blocked', reason: 'structured-output' }
  if (choice === 'required' || record(choice) && (namedTools.includes(choice.type as string) || choice.type === 'allowed_tools' && choice.mode === 'required')) return { status: 'blocked', reason: 'forced-tool' }
  let unknown = Object.keys(body).some(k => !publicFields.has(k))
  if (text != null && (!record(text) || extras(text, ['format', 'verbosity']))) unknown = true
  if (format !== undefined && (!record(format) || format.type !== 'text' || extras(format, ['type']))) unknown = true
  if (record(text) && text.verbosity !== undefined && !['low', 'medium', 'high'].includes(text.verbosity as string)) unknown = true
  if (body.reasoning != null) {
    const reasoning = body.reasoning
    if (!record(reasoning) || extras(reasoning, ['effort', 'summary', 'generate_summary'])) unknown = true
    else if (reasoning.effort != null && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoning.effort as string)
      || [reasoning.summary, reasoning.generate_summary].some(v => v != null && !['auto', 'concise', 'detailed'].includes(v as string))) unknown = true
  }
  if (choice !== undefined && choice !== 'auto' && choice !== 'none') {
    if (!record(choice) || choice.type !== 'allowed_tools' || choice.mode !== 'auto' || extras(choice, ['type', 'mode', 'tools'])
      || !Array.isArray(choice.tools) || choice.tools.some(tool => !record(tool) || !namedTools.includes(tool.type as string)
        || extras(tool, ['type', 'name', 'namespace', 'server_label']))) unknown = true
  }
  if (record(body.stream_options) && extras(body.stream_options, ['include_obfuscation'])) unknown = true
  return unknown ? { status: 'unknown', reason: 'unsupported-output-options' } : { status: 'allowed', reason: 'ordinary-text' }
}
