import { requestFields } from './fields.ts'
import { validationCollector, type FinalValidator } from '@i-harness/llm-seam'
import type { GeminiConfig } from '../types.ts'
import { field, record, protocolKeys, enumValue } from './protojson.ts'
import { validateGeminiGeneration } from './validate-generation.ts'
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
      if (!protocolKeys(body, requestFields)) check.gap('extension-unchecked')
      const cached = field(body, 'cachedContent'), labels = field(body, 'labels'), safety = field(body, 'safetySettings')
      if (cached !== undefined && typeof cached !== 'string') check.issue('shape', 'input')
      if (labels !== undefined) {
        if (!record(labels) || Object.values(labels).some(value => typeof value !== 'string')) check.issue('shape', 'request')
        check.gap('extension-unchecked')
      }
      if (safety !== undefined) {
        if (!Array.isArray(safety) || safety.some(value => !record(value))) check.issue('shape', 'request')
        check.gap('extension-unchecked')
      }
      if (field(body, 'continuationToken') !== undefined) { check.gap('native-contract-unavailable'); check.issue('unsupported-parameter', 'native', 'unsupported-parameter') }
      const cap = geminiCapabilities(config)
      if (!cap) check.gap('protocol-contract-unavailable')
      validateGeminiContents(field(body, 'contents'), check, cap?.signature === true)
      const system = field(body, 'systemInstruction')
      if (system !== undefined && (!record(system) || !Array.isArray(system.parts) || system.parts.some(part => !record(part) || typeof field(part, 'text') !== 'string'))) check.issue('shape', 'input')
      validateGeminiGeneration(field(body, 'generationConfig'), cap, check)
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
              const mode = enumValue(field(calling, 'mode'), ['MODE_UNSPECIFIED', 'AUTO', 'ANY', 'NONE', 'VALIDATED'])
              if (typeof mode === 'number' && ![0, 1, 2, 3, 4].includes(mode)) check.gap('extension-unchecked')
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
              const behavior = enumValue(field(declaration, 'behavior'), ['UNSPECIFIED', 'BLOCKING', 'NON_BLOCKING'])
              if (behavior === 'NON_BLOCKING' || behavior === 2) { check.gap('native-contract-unavailable'); check.issue('unsupported-parameter', 'native', 'unsupported-parameter') }
              else if (typeof behavior === 'number' && ![0, 1].includes(behavior)) check.gap('extension-unchecked')
              if (declaration.parameters != null && !record(declaration.parameters)) check.issue('shape', 'tools')
              if (field(declaration, 'response') !== undefined && !record(declaration.response) || field(declaration, 'description') !== undefined && typeof declaration.description !== 'string') check.issue('shape', 'tools')
              if (field(declaration, 'parameters') !== undefined || field(declaration, 'response') !== undefined) check.gap('extension-unchecked')
            }
          }
        }
      }
    } catch { check.issue('parameter-type', 'generation') }
    return check.finish()
  }
}
