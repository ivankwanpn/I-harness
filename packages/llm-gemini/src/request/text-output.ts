import { requestFields, generationFields } from './fields.ts'
import type { PreparedTextOutput } from '@i-harness/llm-seam'
import { field, record, protocolKeys } from './protojson.ts'
export function observeTextOutput(body: unknown): PreparedTextOutput {
  if (!record(body)) return { status: 'unknown', reason: 'unsupported-output-options' }
  const generation = field(body, 'generationConfig'), tool = field(body, 'toolConfig')
  const calling = field(tool, 'functionCallingConfig'), mode = field(calling, 'mode')
  const mime = field(generation, 'responseMimeType')
  if (['application/json', 'text/x.enum'].includes(mime as string) || field(generation, 'responseSchema') !== undefined || field(generation, 'responseJsonSchema') !== undefined) return { status: 'blocked', reason: 'structured-output' }
  if (mode === 'ANY' || mode === 2) return { status: 'blocked', reason: 'forced-tool' }
  let unknown = !protocolKeys(body, requestFields)
  if (generation !== undefined && (!record(generation) || !protocolKeys(generation, generationFields))) unknown = true
  if (mime !== undefined && !['', 'text/plain'].includes(mime as string)) unknown = true
  const thinking = field(generation, 'thinkingConfig')
  if (thinking !== undefined && (!record(thinking) || !protocolKeys(thinking, ['thinkingBudget', 'thinkingLevel', 'includeThoughts']))) unknown = true
  const level = field(thinking, 'thinkingLevel')
  if (level !== undefined && !['THINKING_LEVEL_UNSPECIFIED', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'minimal', 'low', 'medium', 'high'].includes(level as string)) unknown = true
  if (tool !== undefined && (!record(tool) || !protocolKeys(tool, ['functionCallingConfig']))) unknown = true
  if (calling !== undefined && (!record(calling) || !protocolKeys(calling, ['mode', 'allowedFunctionNames']))) unknown = true
  if (mode !== undefined && !['MODE_UNSPECIFIED', 'AUTO', 'NONE', 'VALIDATED', 0, 1, 3, 4].includes(mode as string | number)) unknown = true
  return unknown ? { status: 'unknown', reason: 'unsupported-output-options' } : { status: 'allowed', reason: 'ordinary-text' }
}
