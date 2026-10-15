import { validationCollector, type FinalValidator } from '@i-harness/llm-seam'
import type { OpenAICompatibleConfig } from '../types.ts'
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const known = new Set(['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'n', 'stop', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'response_format', 'seed', 'user', 'service_tier', 'reasoning_effort', 'reasoning', 'thinking', 'enable_thinking', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options'])
export function chatValidator(config: Pick<OpenAICompatibleConfig, 'model' | 'maxTokensField'>): FinalValidator<unknown> {
  return body => {
    const check = validationCollector('openai-compatible')
    const extensions = (value: Record<string, unknown>, fields: readonly string[]) => { if (Object.keys(value).some(key => !fields.includes(key))) check.gap('extension-unchecked') }
    if (!record(body)) { check.issue('shape', 'request'); return check.finish() }
    if (!text(body.model)) check.issue('shape', 'model')
    else if (body.model !== config.model) check.issue('binding', 'model', 'binding')
    if (Object.keys(body).some(key => !known.has(key))) check.gap('extension-unchecked')
    check.gap('limit-unverified')
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) check.issue('parameter-conflict', 'generation')
    for (const key of ['max_tokens', 'max_completion_tokens'] as const) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || (body[key] as number) < 1)) check.issue('output-range', 'generation', 'output-limit')
    for (const key of ['stream', 'parallel_tool_calls'] as const) if (body[key] !== undefined && typeof body[key] !== 'boolean') check.issue('parameter-type', 'request')
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
      if (message.function_call !== undefined) {
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
