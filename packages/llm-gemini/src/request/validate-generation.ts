import { validationCollector } from '@i-harness/llm-seam'
import { field, record, protocolKeys, int32, float32, enumValue } from './protojson.ts'
import { geminiCapabilities } from './capabilities.ts'
type Checks = ReturnType<typeof validationCollector>
/** Known GenerateContent fields only. Schema interiors remain explicitly
 * unverified, never a second JSON-schema owner. Types/temperature/stop count:
 * generative_service.proto + ai.google.dev/api/generate-content, 2026-10-16. */
export function validateGeminiGeneration(value: unknown, capability: ReturnType<typeof geminiCapabilities>, check: Checks): void {
  if (value === undefined) return
  if (!record(value)) { check.issue('parameter-type', 'generation'); return }
  if (!protocolKeys(value, ['maxOutputTokens', 'thinkingConfig', 'temperature', 'topP', 'topK', 'candidateCount', 'stopSequences', 'responseMimeType', 'responseSchema', 'responseJsonSchema', 'seed', 'presencePenalty', 'frequencyPenalty'])) check.gap('extension-unchecked')
  const max = int32(field(value, 'maxOutputTokens'))
  if (max !== undefined && max < 1) check.issue('output-range', 'generation', 'output-limit')
  for (const key of ['candidateCount', 'topK', 'seed']) int32(field(value, key))
  for (const key of ['temperature', 'topP', 'presencePenalty', 'frequencyPenalty']) {
    const number = float32(field(value, key))
    if (number !== undefined && !Number.isFinite(number)) {
      // ProtoJSON permits special floats; only temperature has a proven
      // finite bound here. Do not invent provider/model penalty ceilings.
      if (key === 'temperature') check.issue('parameter-type', 'generation')
      else check.gap('protocol-contract-unavailable')
    }
    if (key === 'temperature' && number !== undefined && (number < 0 || number > 2)) check.issue('parameter-type', 'generation')
  }
  const stops = field(value, 'stopSequences'), mime = field(value, 'responseMimeType')
  if (stops !== undefined && (!Array.isArray(stops) || stops.length > 5 || !stops.every(item => typeof item === 'string'))) check.issue('parameter-type', 'generation')
  if (mime !== undefined && typeof mime !== 'string') check.issue('parameter-type', 'generation')
  else if (mime !== undefined && !['', 'text/plain', 'application/json', 'text/x.enum'].includes(mime as string)) check.gap('extension-unchecked')
  const schema = field(value, 'responseSchema'), jsonSchema = field(value, 'responseJsonSchema')
  if (schema !== undefined && !record(schema)) check.issue('parameter-type', 'generation')
  if (schema !== undefined && jsonSchema !== undefined) check.issue('parameter-conflict', 'generation')
  if (schema !== undefined || jsonSchema !== undefined) {
    check.gap('extension-unchecked')
    // Google's controlled_generation.py demonstrates STRING enums with
    // text/x.enum. REST's JSON-only schema prose is not exhaustive. Reject
    // the proven plain/default MIME conflict, not every other output mode;
    // schema details and future MIME compatibility stay explicitly partial.
    if (mime === undefined || mime === '' || mime === 'text/plain') check.issue('parameter-conflict', 'generation')
  }
  const thinking = field(value, 'thinkingConfig')
  if (thinking === undefined) return
  if (!record(thinking)) { check.issue('parameter-type', 'generation'); return }
  if (!protocolKeys(thinking, ['thinkingBudget', 'thinkingLevel', 'includeThoughts'])) check.gap('extension-unchecked')
  const budget = int32(field(thinking, 'thinkingBudget'))
  const level = enumValue(field(thinking, 'thinkingLevel'), ['THINKING_LEVEL_UNSPECIFIED', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'minimal', 'low', 'medium', 'high'])
  if (typeof level === 'number') check.gap('extension-unchecked')
  if (budget !== undefined && budget < -1) check.issue('parameter-type', 'generation')
  if (field(thinking, 'includeThoughts') !== undefined && typeof field(thinking, 'includeThoughts') !== 'boolean') check.issue('parameter-type', 'generation')
  if (capability?.minimal === false && (level === 'minimal' || level === 'MINIMAL') || capability?.exclusiveBudgetLevel && budget !== undefined && typeof level === 'string') check.issue('parameter-conflict', 'generation')
}
