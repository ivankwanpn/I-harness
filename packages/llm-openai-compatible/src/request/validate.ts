import { known } from './fields.ts'
import { validationCollector, type FinalValidator } from '@i-harness/llm-seam'
import type { OpenAICompatibleConfig } from '../types.ts'
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
type Checks = ReturnType<typeof validationCollector>

function extras(value: Record<string, unknown>, fields: readonly string[], check: Checks): void {
  if (Object.keys(value).some(key => !fields.includes(key))) check.gap('extension-unchecked')
}
function namedChoice(value: unknown, check: Checks): void {
  if (!record(value) || !text(value.type)) { check.issue('shape', 'tools'); return }
  if (value.type === 'function' || value.type === 'custom') {
    const field = value.type, target = value[field]
    extras(value, ['type', field], check)
    if (!record(target) || !text(target.name)) check.issue('shape', 'tools')
    else extras(target, ['name'], check)
  } else check.gap('extension-unchecked')
}
function toolChoice(value: unknown, check: Checks): void {
  if (value === undefined) return
  if (typeof value === 'string') {
    if (!['none', 'auto', 'required'].includes(value)) check.gap('extension-unchecked')
    return
  }
  if (!record(value)) { check.issue('parameter-type', 'tools'); return }
  if (value.type !== 'allowed_tools') { namedChoice(value, check); return }
  extras(value, ['type', 'allowed_tools'], check)
  const allowed = value.allowed_tools
  if (!record(allowed) || !text(allowed.mode) || !Array.isArray(allowed.tools)) { check.issue('shape', 'tools'); return }
  extras(allowed, ['mode', 'tools'], check)
  if (!['auto', 'required'].includes(allowed.mode)) check.gap('extension-unchecked')
  for (const tool of allowed.tools) {
    if (!record(tool)) check.issue('shape', 'tools')
    else if (tool.type === 'function' || tool.type === 'custom') namedChoice(tool, check)
    else check.gap('extension-unchecked')
  }
}
/** Check known generation envelopes without interpreting schemas or inventing
 * backend/model capability bounds. Undeclared alternatives stay partial. */
function parameters(body: Record<string, unknown>, check: Checks): void {
  toolChoice(body.tool_choice, check)
  for (const key of ['n', 'seed', 'top_logprobs']) if (body[key] != null && !Number.isSafeInteger(body[key])) check.issue('parameter-type', 'generation')
  if (body.logprobs != null && typeof body.logprobs !== 'boolean') check.issue('parameter-type', 'generation')
  for (const key of ['user', 'service_tier', 'reasoning_effort', 'prompt_cache_key', 'prompt_cache_retention']) if (body[key] != null && typeof body[key] !== 'string') check.issue('parameter-type', 'request')
  if (body.stop != null && typeof body.stop !== 'string' && (!Array.isArray(body.stop) || !body.stop.every(value => typeof value === 'string'))) check.issue('parameter-type', 'generation')
  if (body.logit_bias != null && (!record(body.logit_bias) || Object.values(body.logit_bias).some(value => typeof value !== 'number' || !Number.isFinite(value)))) check.issue('parameter-type', 'generation')
  if (record(body.stream_options)) {
    extras(body.stream_options, ['include_usage', 'include_obfuscation'], check)
    for (const key of ['include_usage', 'include_obfuscation']) if (body.stream_options[key] !== undefined && typeof body.stream_options[key] !== 'boolean') check.issue('parameter-type', 'request')
  }
  const format = body.response_format
  if (record(format)) {
    if (!text(format.type)) check.issue('shape', 'generation')
    else if (format.type === 'json_schema') {
      extras(format, ['type', 'json_schema'], check)
      const schema = format.json_schema
      if (!record(schema) || !text(schema.name)) check.issue('shape', 'generation')
      else {
        extras(schema, ['name', 'description', 'schema', 'strict'], check)
        if (schema.schema !== undefined && !record(schema.schema) || schema.description !== undefined && typeof schema.description !== 'string' || schema.strict != null && typeof schema.strict !== 'boolean') check.issue('shape', 'generation')
      }
    } else if (['text', 'json_object'].includes(format.type)) extras(format, ['type'], check)
    else check.gap('extension-unchecked')
  }
  if (body.prompt_cache_options != null) {
    if (!record(body.prompt_cache_options)) check.issue('parameter-type', 'request')
    else {
      extras(body.prompt_cache_options, ['mode', 'ttl'], check)
      for (const key of ['mode', 'ttl']) if (body.prompt_cache_options[key] !== undefined && typeof body.prompt_cache_options[key] !== 'string') check.issue('parameter-type', 'request')
    }
  }
}
function messageFields(message: Record<string, unknown>, check: Checks): void {
  if (message.name !== undefined && typeof message.name !== 'string') check.issue('shape', 'messages')
  if (message.audio !== undefined) {
    if (message.role !== 'assistant' || message.audio !== null && (!record(message.audio) || !text(message.audio.id))) check.issue('shape', 'messages')
    if (record(message.audio)) {
      extras(message.audio, ['id'], check)
      check.native(); check.gap('remote-input-unavailable')
    }
  }
}
export function chatValidator(config: Pick<OpenAICompatibleConfig, 'model' | 'maxTokensField'>): FinalValidator<unknown> {
  return body => {
    const check = validationCollector('openai-compatible')
    const extensions = (value: Record<string, unknown>, fields: readonly string[]) => extras(value, fields, check)
    if (!record(body)) { check.issue('shape', 'request'); return check.finish() }
    if (!text(body.model)) check.issue('shape', 'model')
    else if (body.model !== config.model) check.issue('binding', 'model', 'binding')
    if (Object.keys(body).some(key => !known.has(key))) check.gap('extension-unchecked')
    check.gap('limit-unverified')
    parameters(body, check)
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) check.issue('parameter-conflict', 'generation')
    for (const key of ['max_tokens', 'max_completion_tokens'] as const) if (body[key] != null && (!Number.isSafeInteger(body[key]) || (body[key] as number) < 1)) check.issue('output-range', 'generation', 'output-limit')
    for (const key of ['stream', 'parallel_tool_calls'] as const) if (body[key] != null && typeof body[key] !== 'boolean') check.issue('parameter-type', 'request')
    for (const key of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'] as const) if (body[key] != null && (typeof body[key] !== 'number' || !Number.isFinite(body[key]))) check.issue('parameter-type', 'generation')
    for (const key of ['stream_options', 'response_format'] as const) if (body[key] != null && !record(body[key])) check.issue('parameter-type', 'request')
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools)) check.issue('shape', 'tools')
      else for (const tool of body.tools) {
        if (!record(tool) || !text(tool.type)) { check.issue('shape', 'tools'); continue }
        extensions(tool, ['type', 'function'])
        if (tool.type !== 'function') { check.gap('extension-unchecked'); continue }
        if (!record(tool.function) || !text(tool.function.name) || tool.function.parameters !== undefined && !record(tool.function.parameters) || tool.function.description !== undefined && typeof tool.function.description !== 'string' || tool.function.strict != null && typeof tool.function.strict !== 'boolean') check.issue('shape', 'tools')
        else extensions(tool.function, ['name', 'description', 'parameters', 'strict'])
      }
    }
    if (!Array.isArray(body.messages)) { check.issue('shape', 'messages'); return check.finish() }
    const pending = new Set<string>(), ids = new Set<string>()
    let legacyPending: string | undefined
    for (const message of body.messages) {
      if (!record(message) || !['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(message.role as string)) { check.issue('shape', 'messages'); continue }
      extensions(message, ['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'reasoning_content', 'function_call', 'refusal', 'audio'])
      messageFields(message, check)
      if (pending.size && message.role !== 'tool') check.issue('tool-group', 'messages', 'message-order')
      if (legacyPending !== undefined && message.role !== 'function') check.issue('tool-group', 'messages', 'message-order')
      if (message.role === 'function') {
        check.gap('extension-unchecked')
        if (!text(message.name) || message.name !== legacyPending) check.issue('tool-group', 'messages', 'message-order')
        legacyPending = undefined
      }
      if (message.content === null || message.content === undefined) {
        if (message.role !== 'assistant' && !(message.role === 'function' && message.content === null)) check.issue('shape', 'messages')
      } else if (typeof message.content !== 'string') {
        if (!Array.isArray(message.content)) check.issue('shape', 'messages')
        else for (const part of message.content) {
          if (!record(part) || !text(part.type)) { check.issue('shape', 'messages'); continue }
          extensions(part, ['type', 'text', 'image_url', 'refusal'])
          if (part.type === 'image_url' && message.role !== 'user' || part.type === 'refusal' && message.role !== 'assistant') check.issue('shape', 'messages')
          if (part.type === 'text' && typeof part.text !== 'string' || part.type === 'image_url' && (!record(part.image_url) || !text(part.image_url.url))) check.issue('shape', 'messages')
          if (!['text', 'image_url', 'refusal'].includes(part.type)) check.gap('extension-unchecked')
          if (part.type === 'refusal' && typeof part.refusal !== 'string') check.issue('shape', 'messages')
        }
      }
      if (message.reasoning_content !== undefined) {
        check.native()
        if (typeof message.reasoning_content !== 'string') check.issue('native-replay', 'native', 'native-replay')
      }
      if (message.refusal !== undefined && message.refusal !== null && (message.role !== 'assistant' || typeof message.refusal !== 'string')) check.issue('shape', 'messages')
      if (message.tool_call_id !== undefined && message.role !== 'tool') check.issue('shape', 'messages')
      if (message.function_call != null) {
        check.gap('extension-unchecked')
        if (message.tool_calls !== undefined) check.issue('parameter-conflict', 'messages')
        const call = message.function_call
        if (message.role !== 'assistant' || !record(call) || !text(call.name) || typeof call.arguments !== 'string') check.issue('shape', 'messages')
        else {
          extensions(call, ['name', 'arguments'])
          try { JSON.parse(call.arguments) } catch { check.issue('shape', 'messages') }
          legacyPending = call.name
        }
      }
      if (message.role === 'tool') {
        if (!text(message.tool_call_id) || !pending.delete(message.tool_call_id)) check.issue('tool-id', 'messages', 'message-order')
      }
      if (message.tool_calls !== undefined) {
        if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) { check.issue('shape', 'messages'); continue }
        for (const call of message.tool_calls) {
          if (!record(call) || !text(call.id) || ids.has(call.id)) { check.issue('tool-id', 'messages', 'message-order'); continue }
          extensions(call, ['id', 'type', 'function'])
          ids.add(call.id); pending.add(call.id)
          if (call.type !== 'function' || !record(call.function) || !text(call.function.name) || typeof call.function.arguments !== 'string') check.issue('shape', 'messages')
          else { extensions(call.function, ['name', 'arguments']); try { JSON.parse(call.function.arguments) } catch { check.issue('shape', 'messages') } }
        }
      }
    }
    if (pending.size || legacyPending !== undefined) check.issue('tool-group', 'messages', 'message-order')
    return check.finish()
  }
}
