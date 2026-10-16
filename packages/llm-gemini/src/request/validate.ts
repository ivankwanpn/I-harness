import { validationCollector, type FinalValidator } from '@i-harness/llm-seam'
import type { GeminiConfig } from '../types.ts'
import { field, record, protocolKeys, int32 } from './protojson.ts'
import { geminiCapabilities } from './capabilities.ts'
import { validateGeminiContents } from './validate-content.ts'
import { validateGeminiNative } from './validate-native.ts'
import type { LLMMessage } from '@i-harness/llm-seam'
export function geminiValidator(config: GeminiConfig, mapped: readonly unknown[] = [], source: readonly LLMMessage[] = []): FinalValidator<unknown> {
  return body => {
    const check = validationCollector('gemini')
    if (!record(body)) { check.issue('shape', 'request'); return check.finish() }
    if (!config.model.length) check.issue('shape', 'model')
    check.gap('limit-unverified')
    try {
      if (field(body, 'model') !== undefined && body.model !== config.model) check.issue('binding', 'model', 'binding')
      if (!protocolKeys(body, ['contents', 'systemInstruction', 'tools', 'toolConfig', 'generationConfig', 'cachedContent', 'model', 'safetySettings', 'labels', 'continuationToken'])) check.gap('extension-unchecked')
      if (field(body, 'continuationToken') !== undefined) { check.gap('native-contract-unavailable'); check.issue('unsupported-parameter', 'native', 'unsupported-parameter') }
      const cap = geminiCapabilities(config)
      if (!cap) check.gap('protocol-contract-unavailable')
      validateGeminiContents(field(body, 'contents'), check, cap?.signature === true)
      const system = field(body, 'systemInstruction')
      if (system !== undefined && (!record(system) || !Array.isArray(system.parts) || system.parts.some(part => !record(part) || typeof field(part, 'text') !== 'string'))) check.issue('shape', 'input')
      const generation = field(body, 'generationConfig')
      if (generation !== undefined) {
        if (!record(generation)) check.issue('parameter-type', 'generation')
        else {
          if (!protocolKeys(generation, ['maxOutputTokens', 'thinkingConfig', 'temperature', 'topP', 'topK', 'candidateCount', 'stopSequences', 'responseMimeType', 'responseSchema', 'responseJsonSchema', 'seed', 'presencePenalty', 'frequencyPenalty'])) check.gap('extension-unchecked')
          const max = int32(field(generation, 'maxOutputTokens'))
          if (max !== undefined && max < 1) check.issue('output-range', 'generation', 'output-limit')
          const thinking = field(generation, 'thinkingConfig')
          if (thinking !== undefined) {
            if (!record(thinking)) check.issue('parameter-type', 'generation')
            else {
              if (!protocolKeys(thinking, ['thinkingBudget', 'thinkingLevel', 'includeThoughts'])) check.gap('extension-unchecked')
              const budget = int32(field(thinking, 'thinkingBudget')), level = field(thinking, 'thinkingLevel')
              if (budget !== undefined && budget < -1) check.issue('parameter-type', 'generation')
              if (level !== undefined && typeof level !== 'string') check.issue('parameter-type', 'generation')
              if (field(thinking, 'includeThoughts') !== undefined && typeof field(thinking, 'includeThoughts') !== 'boolean') check.issue('parameter-type', 'generation')
              if (cap?.minimal === false && (level === 'minimal' || level === 'MINIMAL') || cap?.exclusiveBudgetLevel && budget !== undefined && level !== undefined) check.issue('parameter-conflict', 'generation')
            }
          }
        }
      }
      validateGeminiNative(body, mapped, source, Object.hasOwn(config.options ?? {}, 'contents'), check)
      const tools = field(body, 'tools')
      const toolConfig = field(body, 'toolConfig')
      if (toolConfig !== undefined) {
        if (!record(toolConfig)) check.issue('shape', 'tools')
        else {
          if (!protocolKeys(toolConfig, ['functionCallingConfig'])) check.gap('extension-unchecked')
          const calling = field(toolConfig, 'functionCallingConfig')
          if (calling !== undefined) {
            if (!record(calling)) check.issue('shape', 'tools')
            else {
              if (!protocolKeys(calling, ['mode', 'allowedFunctionNames'])) check.gap('extension-unchecked')
              if (calling.mode != null && typeof calling.mode !== 'string' && !Number.isInteger(calling.mode)) check.issue('shape', 'tools')
              const allowed = field(calling, 'allowedFunctionNames')
              if (allowed !== undefined && (!Array.isArray(allowed) || !allowed.every(name => typeof name === 'string'))) check.issue('shape', 'tools')
            }
          }
        }
      }
      if (tools !== undefined) {
        if (!Array.isArray(tools)) check.issue('shape', 'tools')
        else for (const tool of tools) {
          if (!record(tool)) { check.issue('shape', 'tools'); continue }
          if (!protocolKeys(tool, ['functionDeclarations'])) check.gap('extension-unchecked')
          const declarations = field(tool, 'functionDeclarations')
          if (declarations !== undefined) {
            if (!Array.isArray(declarations)) check.issue('shape', 'tools')
            else for (const declaration of declarations) {
              if (!record(declaration) || typeof declaration.name !== 'string') { check.issue('shape', 'tools'); continue }
              if (!protocolKeys(declaration, ['name', 'description', 'parameters', 'parametersJsonSchema', 'response', 'responseJsonSchema', 'behavior'])) check.gap('extension-unchecked')
              if (field(declaration, 'parameters') !== undefined && field(declaration, 'parametersJsonSchema') !== undefined || field(declaration, 'response') !== undefined && field(declaration, 'responseJsonSchema') !== undefined) check.issue('parameter-conflict', 'tools')
              // content.proto Behavior: BLOCKING=1, NON_BLOCKING=2. Do not
              // mistake enum numbers for model-version/capability guesses.
              if (declaration.behavior === 'NON_BLOCKING' || declaration.behavior === 2) { check.gap('native-contract-unavailable'); check.issue('unsupported-parameter', 'native', 'unsupported-parameter') }
              if (declaration.parameters != null && !record(declaration.parameters)) check.issue('shape', 'tools')
            }
          }
        }
      }
    } catch { check.issue('parameter-type', 'generation') }
    return check.finish()
  }
}
