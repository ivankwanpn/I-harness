/** Scoped, read-only protocol interpretation. Never visit Struct/schema/args.
 * https://protobuf.dev/programming-guides/json/ (2026-10-16): null is unset,
 * both JSON/proto names and exact numeric-string int32 forms are accepted. */
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const aliases: Record<string, string> = {
  systemInstruction: 'system_instruction', generationConfig: 'generation_config', cachedContent: 'cached_content',
  maxOutputTokens: 'max_output_tokens', thinkingConfig: 'thinking_config', thinkingBudget: 'thinking_budget', thinkingLevel: 'thinking_level', includeThoughts: 'include_thoughts',
  inlineData: 'inline_data', fileData: 'file_data', functionCall: 'function_call', functionResponse: 'function_response', thoughtSignature: 'thought_signature',
  mimeType: 'mime_type', fileUri: 'file_uri', functionDeclarations: 'function_declarations', toolConfig: 'tool_config', functionCallingConfig: 'function_calling_config',
  willContinue: 'will_continue', continuationToken: 'continuation_token',
  parametersJsonSchema: 'parameters_json_schema', responseJsonSchema: 'response_json_schema', allowedFunctionNames: 'allowed_function_names',
  toolCall: 'tool_call', toolResponse: 'tool_response', displayName: 'display_name',
}
export function field(value: unknown, key: string): unknown {
  if (!record(value)) return undefined
  const alias = aliases[key]
  const direct = Object.hasOwn(value, key), alternate = alias !== undefined && Object.hasOwn(value, alias)
  if (direct && alternate) throw new TypeError('Ambiguous protocol aliases')
  const result = direct ? value[key] : alternate ? value[alias] : undefined
  return result === null ? undefined : result
}
export function protocolKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).every(key => names.some(name => key === name || key === aliases[name]))
}
/** Decimal/exponent numeric strings are legal; exact conversion uses BigInt,
 * rejecting truncation/rounding before a cap can become a known scalar fact. */
export function int32(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new TypeError('Invalid int32')
    return value
  }
  if (typeof value !== 'string' || value.length > 128) throw new TypeError('Invalid int32')
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value)
  if (!match) throw new TypeError('Invalid int32')
  const fraction = match[3] ?? '', exponent = Number(match[4] ?? 0) - fraction.length
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) throw new TypeError('Invalid int32')
  let exact = BigInt((match[1] || '') + match[2] + fraction)
  if (exponent >= 0) exact *= 10n ** BigInt(exponent)
  else { const divisor = 10n ** BigInt(-exponent); if (exact % divisor) throw new TypeError('Invalid int32'); exact /= divisor }
  if (exact < -2147483648n || exact > 2147483647n) throw new TypeError('Invalid int32')
  return Number(exact)
}
