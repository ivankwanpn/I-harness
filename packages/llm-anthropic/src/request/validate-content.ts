import { validationCollector } from '@i-harness/llm-seam'
type Checks = ReturnType<typeof validationCollector>
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const name = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v)
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0
function extras(value: Record<string, unknown>, fields: readonly string[], check: Checks) {
  if (Object.keys(value).some(key => !fields.includes(key))) check.gap('extension-unchecked')
}
export function validateAnthropicCache(value: unknown, check: Checks): void {
  if (value === undefined) return
  if (!record(value) || value.type !== 'ephemeral' || value.ttl !== undefined && !['5m', '1h'].includes(value.ttl as string)) check.issue('shape', 'request')
  else extras(value, ['type', 'ttl'], check)
}
function media(block: Record<string, unknown>, check: Checks) {
  const source = block.source
  if (!record(source)) { check.issue('shape', 'media'); return }
  if (source.type === 'base64') {
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(source.media_type as string) || !id(source.data)) check.issue('shape', 'media')
    extras(source, ['type', 'media_type', 'data'], check)
  } else if (source.type === 'url') {
    if (!id(source.url)) check.issue('shape', 'media')
    check.gap('remote-input-unavailable')
  } else check.gap('extension-unchecked')
}
function simple(block: unknown, check: Checks): void {
  if (!record(block) || !id(block.type)) { check.issue('shape', 'messages'); return }
  validateAnthropicCache(block.cache_control, check)
  if (block.type === 'text') {
    if (typeof block.text !== 'string') check.issue('shape', 'messages')
    extras(block, ['type', 'text', 'cache_control', 'citations'], check)
  } else if (block.type === 'image') {
    media(block, check); extras(block, ['type', 'source', 'cache_control'], check)
  } else check.gap('extension-unchecked')
}
/** Messages has next-user-message closure and result-before-prose rules. This
 * state is independent of historical provenance and tool registry membership. */
export function validateAnthropicMessages(value: unknown, check: Checks): void {
  if (!Array.isArray(value)) { check.issue('shape', 'messages'); return }
  if (!value.length) check.gap('protocol-contract-unavailable')
  const pending = new Set<string>()
  for (const message of value) {
    if (!record(message) || !['user', 'assistant'].includes(message.role as string)) { check.issue('shape', 'messages'); continue }
    extras(message, ['role', 'content'], check)
    if (pending.size && message.role !== 'user') check.issue('tool-group', 'messages', 'message-order')
    if (typeof message.content === 'string') {
      if (pending.size) check.issue('tool-group', 'messages', 'message-order')
      continue
    }
    if (!Array.isArray(message.content) || !message.content.length) { check.issue('shape', 'messages'); continue }
    let ordinary = false
    const ids = new Set<string>()
    for (const block of message.content) {
      if (!record(block) || !id(block.type)) { check.issue('shape', 'messages'); continue }
      validateAnthropicCache(block.cache_control, check)
      if (block.type === 'tool_result') {
        if (message.role !== 'user' || ordinary || !id(block.tool_use_id) || !pending.delete(block.tool_use_id)) check.issue('tool-id', 'messages', 'message-order')
        if (block.is_error !== undefined && typeof block.is_error !== 'boolean') check.issue('shape', 'messages')
        if (block.content !== undefined && typeof block.content !== 'string') {
          if (!Array.isArray(block.content)) check.issue('shape', 'messages')
          else for (const part of block.content) simple(part, check)
        }
        extras(block, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control'], check)
        continue
      }
      ordinary = true
      if (pending.size && message.role === 'user') check.issue('tool-group', 'messages', 'message-order')
      if (block.type === 'tool_use') {
        if (message.role !== 'assistant' || !id(block.id) || ids.has(block.id)) check.issue('tool-id', 'messages', 'message-order')
        else { ids.add(block.id); pending.add(block.id) }
        if (!name(block.name) || !record(block.input)) check.issue('shape', 'messages')
        extras(block, ['type', 'id', 'name', 'input', 'cache_control'], check)
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        check.native()
        if (message.role !== 'assistant' || (block.type === 'thinking' ? typeof block.thinking !== 'string' || !id(block.signature) : !id(block.data))) check.issue('native-replay', 'native', 'native-replay')
        extras(block, block.type === 'thinking' ? ['type', 'thinking', 'signature'] : ['type', 'data'], check)
      } else if (block.type === 'server_tool_use' || block.type.endsWith('_tool_result')) {
        check.gap('native-contract-unavailable'); check.issue('unsupported-parameter', 'native', 'unsupported-parameter')
      } else simple(block, check)
    }
    if (message.role === 'user' && pending.size) check.issue('tool-group', 'messages', 'message-order')
  }
  if (pending.size) check.issue('tool-group', 'messages', 'message-order')
}
export function validateAnthropicTools(value: unknown, check: Checks): void {
  if (value === undefined) return
  if (!Array.isArray(value)) { check.issue('shape', 'tools'); return }
  for (const tool of value) {
    if (!record(tool) || !name(tool.name)) { check.issue('shape', 'tools'); continue }
    validateAnthropicCache(tool.cache_control, check)
    if (tool.strict !== undefined && typeof tool.strict !== 'boolean') check.issue('shape', 'tools')
    if (tool.type !== undefined && tool.type !== 'custom') { check.gap('extension-unchecked'); continue }
    if (!record(tool.input_schema) || tool.description !== undefined && typeof tool.description !== 'string') check.issue('shape', 'tools')
    extras(tool, ['name', 'description', 'input_schema', 'cache_control', 'type', 'strict'], check)
  }
}
