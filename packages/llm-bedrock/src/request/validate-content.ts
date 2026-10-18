import { validationCollector } from '@i-harness/llm-seam'
type Checks = ReturnType<typeof validationCollector>
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(v)
const name = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v)
function extras(value: Record<string, unknown>, keys: readonly string[], check: Checks) { if (Object.keys(value).some(key => !keys.includes(key))) check.gap('extension-unchecked') }
function image(value: unknown, check: Checks): void {
  if (!record(value) || !['png', 'jpeg', 'gif', 'webp'].includes(value.format as string) || !record(value.source)) { check.issue('shape', 'media'); return }
  const source = value.source
  if (source.bytes !== undefined) { if (!(source.bytes instanceof Uint8Array)) check.issue('shape', 'media') }
  else if (record(source.s3Location) && typeof source.s3Location.uri === 'string') check.gap('remote-input-unavailable')
  else check.issue('shape', 'media')
}
function reasoning(value: unknown, check: Checks): void {
  check.native()
  if (!record(value) || ['reasoningText', 'redactedContent'].filter(key => value[key] !== undefined).length !== 1) { check.issue('native-replay', 'native', 'native-replay'); return }
  extras(value, ['reasoningText', 'redactedContent'], check)
  if (value.reasoningText !== undefined) {
    const item = value.reasoningText
    if (!record(item) || typeof item.text !== 'string' || item.signature !== undefined && typeof item.signature !== 'string') check.issue('native-replay', 'native', 'native-replay')
    else extras(item, ['text', 'signature'], check)
  } else if (!(value.redactedContent instanceof Uint8Array)) check.issue('native-replay', 'native', 'native-replay')
}
function resultContent(value: unknown, check: Checks): { images: number; documents: number } {
  const counts = { images: 0, documents: 0 }
  if (!Array.isArray(value)) { check.issue('shape', 'messages'); return counts }
  for (const part of value) {
    if (!record(part) || Object.keys(part).length !== 1) { check.issue('shape', 'messages'); continue }
    if (part.text !== undefined) { if (typeof part.text !== 'string') check.issue('shape', 'messages') }
    else if (Object.hasOwn(part, 'json')) { /* Smithy Document accepts any JSON value. */ }
    else if (part.image !== undefined) { counts.images++; image(part.image, check) }
    else if (part.document !== undefined) { counts.documents++; check.gap('extension-unchecked') }
    else check.gap('extension-unchecked')
  }
  return counts
}
/** Converse closes ordinary groups before another assistant message. It does
 * not import Messages' immediate single-user-message or text ordering rule. */
export function validateConverseMessages(value: unknown, check: Checks, status?: boolean): void {
  if (value === undefined) { check.gap('protocol-contract-unavailable'); return }
  if (!Array.isArray(value)) { check.issue('shape', 'messages'); return }
  if (!value.length) check.gap('protocol-contract-unavailable')
  const pending = new Set<string>()
  for (const message of value) {
    if (!record(message) || !['user', 'assistant'].includes(message.role as string) || !Array.isArray(message.content) || !message.content.length) { check.issue('shape', 'messages'); continue }
    extras(message, ['role', 'content'], check)
    if (message.role === 'assistant' && pending.size) check.issue('tool-group', 'messages', 'message-order')
    let images = 0, documents = 0, topLevelDocuments = 0
    for (const part of message.content) {
      if (!record(part) || Object.keys(part).filter(key => part[key] !== undefined).length !== 1) { check.issue('shape', 'messages'); continue }
      if (part.text !== undefined) { if (typeof part.text !== 'string') check.issue('shape', 'messages') }
      else if (part.image !== undefined) { images++; image(part.image, check); if (message.role !== 'user') check.issue('shape', 'media') }
      else if (part.document !== undefined) { documents++; topLevelDocuments++; check.gap('extension-unchecked'); if (message.role !== 'user') check.issue('shape', 'media') }
      else if (part.reasoningContent !== undefined) {
        if (message.role !== 'assistant') check.issue('shape', 'messages')
        reasoning(part.reasoningContent, check)
      } else if (part.toolUse !== undefined) {
        const tool = part.toolUse
        if (!record(tool)) { check.issue('shape', 'messages'); continue }
        if (tool.type === 'server_tool_use') { check.gap('native-contract-unavailable'); check.issue('unsupported-parameter', 'native', 'unsupported-parameter'); continue }
        if (message.role !== 'assistant' || !id(tool.toolUseId) || pending.has(tool.toolUseId)) check.issue('tool-id', 'messages', 'message-order')
        else pending.add(tool.toolUseId)
        if (!name(tool.name) || !Object.hasOwn(tool, 'input') || tool.input === undefined) check.issue('shape', 'messages')
        extras(tool, ['toolUseId', 'name', 'input', 'type'], check)
      } else if (part.toolResult !== undefined) {
        const tool = part.toolResult
        if (!record(tool)) { check.issue('shape', 'messages'); continue }
        if (message.role !== 'user' || !id(tool.toolUseId) || !pending.delete(tool.toolUseId)) check.issue('tool-id', 'messages', 'message-order')
        if (tool.status !== undefined) {
          if (!['success', 'error'].includes(tool.status as string)) check.issue('shape', 'messages')
          if (!status) check.gap('protocol-contract-unavailable')
        }
        const nested = resultContent(tool.content, check)
        images += nested.images; documents += nested.documents
        extras(tool, ['toolUseId', 'content', 'status'], check)
      } else check.gap('extension-unchecked')
    }
    // https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Message.html
    // Counts have exact units; SDK byte estimates are never HTTP byte limits.
    if (images > 20 || documents > 5) check.issue('media-limit', 'media', 'media-limit')
    if (topLevelDocuments && !message.content.some(part => record(part) && typeof part.text === 'string' && part.text.length > 0)) check.issue('shape', 'media')
  }
  if (pending.size) check.issue('tool-group', 'messages', 'message-order')
}
