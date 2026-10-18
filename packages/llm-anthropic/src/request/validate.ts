import { known } from './fields.ts'
import { validationCollector, type FinalValidator } from '@i-harness/llm-seam'
import type { AnthropicConfig } from '../types.ts'
import { anthropicCapabilities, hasInterleavedBeta } from './capabilities.ts'
import { validateAnthropicMessages, validateAnthropicTools, validateAnthropicCache } from './validate-content.ts'
import { validateAnthropicNative } from './validate-native.ts'
import type { LLMMessage } from '@i-harness/llm-seam'
import type { CacheEvidence } from './cache-evidence.ts'
import { ongoingAnthropicToolTurn } from './logical-turn.ts'
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Pure final HTTP grammar, after raw precedence/cache edits and cap lowering. */
export function anthropicValidator(config: AnthropicConfig, source: readonly LLMMessage[] = [], cache?: CacheEvidence): FinalValidator<unknown> {
  return body => {
    const check = validationCollector('anthropic-messages')
    if (!record(body)) { check.issue('shape', 'request'); return check.finish() }
    if (typeof body.model !== 'string' || !body.model.length) check.issue('shape', 'model')
    else if (body.model !== config.model) check.issue('binding', 'model', 'binding')
    if (body.stream !== true) check.issue('parameter-type', 'request')
    if (!Number.isSafeInteger(body.max_tokens) || (body.max_tokens as number) < 1) check.issue('output-range', 'generation', 'output-limit')
    if (Object.keys(body).some(key => !known.has(key))) check.gap('extension-unchecked')
    // Direct Messages says "32 MB" without resolving exact byte units. The
    // measured HTTP packet remains available; no invented cutoff is applied.
    check.gap('limit-unverified')
    validateAnthropicMessages(body.messages, check)
    validateAnthropicTools(body.tools, check)
    validateAnthropicCache(body.cache_control, check)
    if (Array.isArray(body.system)) for (const block of body.system) if (record(block)) validateAnthropicCache(block.cache_control, check)
    if (body.metadata !== undefined) {
      if (!record(body.metadata) || body.metadata.user_id != null && (typeof body.metadata.user_id !== 'string' || [...body.metadata.user_id].length > 512)) check.issue('parameter-type', 'request')
      else if (Object.keys(body.metadata).some(key => key !== 'user_id')) check.gap('extension-unchecked')
    }
    if (body.system !== undefined && typeof body.system !== 'string' && (!Array.isArray(body.system) || body.system.some(block => !record(block) || block.type !== 'text' || typeof block.text !== 'string'))) check.issue('shape', 'input')
    for (const key of ['temperature', 'top_p', 'top_k']) if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || (body[key] as number) < 0 || key !== 'top_k' && (body[key] as number) > 1)) check.issue('parameter-type', 'generation')
    if (body.stop_sequences !== undefined && (!Array.isArray(body.stop_sequences) || !body.stop_sequences.every(v => typeof v === 'string'))) check.issue('parameter-type', 'generation')
    if (body.service_tier !== undefined && !['auto', 'standard_only'].includes(body.service_tier as string)) check.issue('parameter-type', 'request')
    const cap = anthropicCapabilities(config)
    if (!cap) check.gap('protocol-contract-unavailable')
    const thinking = body.thinking, output = body.output_config
    if (output !== undefined && !record(output)) check.issue('parameter-type', 'generation')
    const effort = record(output) ? output.effort : undefined
    // Messages explicitly permits null here; it remains a tagged present/null
    // producer identity, distinct from an omitted default. Other fields keep
    // their own null contracts. API reference checked 2026-10-16.
    if (effort != null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort as string)) check.issue('parameter-type', 'generation')
    if (record(output) && Object.keys(output).some(key => key !== 'effort')) check.gap('extension-unchecked')
    const choice = body.tool_choice
    if (choice !== undefined && (!record(choice) || !['auto', 'none', 'any', 'tool'].includes(choice.type as string) || choice.type === 'tool' && typeof choice.name !== 'string')) check.issue('shape', 'tools')
    if (record(choice)) {
      if (choice.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== 'boolean') check.issue('parameter-type', 'tools')
      if (Object.keys(choice).some(key => !['type', 'name', 'disable_parallel_tool_use'].includes(key))) check.gap('extension-unchecked')
    }
    if (thinking !== undefined) {
      if (!record(thinking) || typeof thinking.type !== 'string') check.issue('parameter-type', 'generation')
      else {
        const mode = thinking.type
        if (!['enabled', 'disabled', 'adaptive', 'between_tools'].includes(mode)) check.gap('extension-unchecked')
        if (cap && !cap.modes.includes(mode)) check.issue('parameter-conflict', 'generation')
        if (['adaptive', 'between_tools'].includes(mode) && thinking.budget_tokens !== undefined) check.issue('parameter-conflict', 'generation')
        if (Object.keys(thinking).some(key => !['type', ...(mode === 'enabled' ? ['budget_tokens'] : [])].includes(key))) {
          if (mode === 'between_tools') check.issue('parameter-conflict', 'generation')
          else check.gap('extension-unchecked')
        }
        if (mode === 'enabled') {
          const budget = thinking.budget_tokens
          if (!Number.isSafeInteger(budget) || (budget as number) < 1024) check.issue('parameter-type', 'generation')
          const interleaved = cap?.manualInterleaving === true && hasInterleavedBeta(config.headers)
          if (cap && !interleaved && typeof budget === 'number' && typeof body.max_tokens === 'number' && budget >= body.max_tokens) check.issue('parameter-conflict', 'generation')
          if (cap) {
            const turn = ongoingAnthropicToolTurn(body.messages)
            if (turn && !['thinking', 'redacted_thinking'].includes(turn.firstBlock?.type as string)) {
              check.issue('native-replay', 'native', 'native-replay'); check.native('incompatible')
            }
          }
        }
        if ((mode === 'between_tools' || mode === 'disabled' && cap?.limitedDisabled) && effort != null && !['low', 'medium', 'high'].includes(effort as string)) check.issue('parameter-conflict', 'generation')
        const forced = record(choice) && ['any', 'tool'].includes(choice.type as string)
        if (forced && cap && (mode === 'enabled' || mode === 'adaptive' && cap.forcedAdaptive === false)) check.issue('parameter-conflict', 'tools')
      }
    }
    if (cache) validateAnthropicNative(body, config, source, cache, check)
    return check.finish()
  }
}
