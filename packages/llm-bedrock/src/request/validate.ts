import { requestFields } from './fields.ts'
import { validationCollector, type FinalValidator } from '@i-harness/llm-seam'
import type { BedrockConfig } from '../types.ts'
import type { ConverseStreamCommandInput } from '@aws-sdk/client-bedrock-runtime'
import { bedrockCapabilities } from './capabilities.ts'
import { validateConverseMessages } from './validate-content.ts'
import { validateConverseNative } from './validate-native.ts'
import type { LLMMessage } from '@i-harness/llm-seam'
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export function bedrockValidator(config: BedrockConfig, official: boolean, source: readonly LLMMessage[] = []): FinalValidator<ConverseStreamCommandInput> {
  return input => {
    const body = input as unknown as Record<string, unknown>, check = validationCollector('bedrock')
    if (!record(body)) { check.issue('shape', 'request'); return check.finish() }
    if (typeof body.modelId !== 'string' || !body.modelId.length) check.issue('shape', 'model')
    else if (body.modelId !== config.model) check.issue('binding', 'model', 'binding')
    const capabilities = bedrockCapabilities(config.model, official)
    check.gap('limit-unverified')
    if (Object.keys(body).some(key => !requestFields.some(field => field === key))) check.gap('extension-unchecked')
    validateConverseMessages(body.messages, check, capabilities.status)
    if (body.system !== undefined && (!Array.isArray(body.system) || body.system.some(block => !record(block) || typeof block.text !== 'string'))) check.issue('shape', 'input')
    const inference = body.inferenceConfig
    if (inference !== undefined) {
      if (!record(inference)) check.issue('parameter-type', 'generation')
      else {
        if (inference.maxTokens !== undefined && (!Number.isSafeInteger(inference.maxTokens) || (inference.maxTokens as number) < 1)) check.issue('output-range', 'generation', 'output-limit')
        for (const key of ['temperature', 'topP']) if (inference[key] !== undefined && (typeof inference[key] !== 'number' || !Number.isFinite(inference[key]))) check.issue('parameter-type', 'generation')
        if (inference.stopSequences !== undefined && (!Array.isArray(inference.stopSequences) || !inference.stopSequences.every(v => typeof v === 'string'))) check.issue('parameter-type', 'generation')
      }
    }
    if (body.additionalModelRequestFields !== undefined) check.gap('extension-unchecked')
    const tools = body.toolConfig
    if (tools !== undefined) {
      if (!record(tools) || !Array.isArray(tools.tools)) check.issue('shape', 'tools')
      else {
        if (Object.keys(tools).some(key => !['tools', 'toolChoice'].includes(key))) check.gap('extension-unchecked')
        const choice = tools.toolChoice
        if (choice !== undefined) {
          if (!record(choice) || ['auto', 'any', 'tool'].filter(key => choice[key] !== undefined).length !== 1) check.issue('shape', 'tools')
          else if (choice.tool !== undefined && (!record(choice.tool) || typeof choice.tool.name !== 'string')) check.issue('shape', 'tools')
        }
        for (const tool of tools.tools) {
        if (!record(tool)) { check.issue('shape', 'tools'); continue }
        if (!record(tool.toolSpec)) { if (tool.toolSpec !== undefined) check.issue('shape', 'tools'); else check.gap('extension-unchecked'); continue }
        if (typeof tool.toolSpec.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.toolSpec.name) || !record(tool.toolSpec.inputSchema) || !Object.hasOwn(tool.toolSpec.inputSchema, 'json')) check.issue('shape', 'tools')
        }
      }
    }
    validateConverseNative(input, config, source, check)
    return check.finish()
  }
}
