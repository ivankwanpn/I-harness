import { validationCollector } from '@i-harness/llm-seam'
import { field, record, protocolKeys } from './protojson.ts'
type Checks = ReturnType<typeof validationCollector>
const name = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0
function extras(v: Record<string, unknown>, names: readonly string[], check: Checks) { if (!protocolKeys(v, names)) check.gap('extension-unchecked') }
const data = ['text', 'inlineData', 'fileData', 'functionCall', 'functionResponse', 'executableCode', 'codeExecutionResult', 'toolCall', 'toolResponse']
/** Generic Content/Part grammar; thought/signature are metadata, not data arms. */
export function validateGeminiContents(value: unknown, check: Checks, signatureRequired: boolean): void {
  if (!Array.isArray(value)) { check.issue('shape', 'messages'); return }
  if (!value.length) check.gap('protocol-contract-unavailable')
  const pending: { id?: string; name: string }[] = []
  const turnStart = value.findLastIndex(content => record(content) && (field(content, 'role') === 'user' || field(content, 'role') === undefined) && Array.isArray(content.parts) && content.parts.some((part: unknown) => record(part) && field(part, 'functionResponse') === undefined))
  for (const [index, content] of value.entries()) {
    if (!record(content) || field(content, 'role') !== undefined && !['user', 'model'].includes(field(content, 'role') as string) || !Array.isArray(content.parts) || !content.parts.length) { check.issue('shape', 'messages'); continue }
    extras(content, ['role', 'parts'], check)
    const model = content.role === 'model'
    if (model && pending.length) check.issue('tool-group', 'messages', 'message-order')
    let callIndex = 0
    for (const part of content.parts) {
      if (!record(part)) { check.issue('shape', 'messages'); continue }
      extras(part, [...data, 'thought', 'thoughtSignature', 'videoMetadata'], check)
      const alternatives = data.filter(key => field(part, key) !== undefined)
      if (alternatives.length !== 1) { check.issue('shape', 'messages'); continue }
      const kind = alternatives[0]!, item = field(part, kind)
      if (field(part, 'thought') !== undefined && typeof part.thought !== 'boolean') check.issue('shape', 'native')
      const signature = field(part, 'thoughtSignature')
      if (signature !== undefined) { check.native(); if (!text(signature)) check.issue('native-replay', 'native', 'native-replay') }
      if (kind === 'text') { if (typeof item !== 'string') check.issue('shape', 'messages') }
      else if (kind === 'inlineData' || kind === 'fileData') {
        if (!record(item) || (kind === 'inlineData' ? !text(field(item, 'mimeType')) : field(item, 'mimeType') !== undefined && typeof field(item, 'mimeType') !== 'string') || !text(field(item, kind === 'inlineData' ? 'data' : 'fileUri'))) check.issue('shape', 'media')
        if (kind === 'fileData') check.gap('remote-input-unavailable')
      } else if (kind === 'functionCall' || kind === 'functionResponse') {
        if (!record(item) || !name(item.name) || field(item, 'id') !== undefined && !text(item.id)) { check.issue('shape', 'messages'); continue }
        const isCall = kind === 'functionCall'
        extras(item, isCall ? ['id', 'name', 'args'] : ['id', 'name', 'response', 'willContinue', 'scheduling', 'parts'], check)
        if (isCall) {
          if (!model || field(item, 'args') !== undefined && !record(item.args)) check.issue('shape', 'messages')
          if (signatureRequired && index > turnStart && callIndex === 0 && signature === undefined) { check.issue('native-replay', 'native', 'native-replay'); check.gap('native-contract-unavailable') }
          callIndex++
          if (pending.some(call => item.id !== undefined ? call.id === item.id : call.id === undefined && call.name === item.name)) {
            if (item.id === undefined) { check.gap('native-contract-unavailable'); check.issue('unsupported-parameter', 'native', 'unsupported-parameter') }
            else check.issue('tool-id', 'messages', 'message-order')
          }
          pending.push({ ...(item.id !== undefined ? { id: item.id as string } : {}), name: item.name })
        } else {
          if (model || !record(item.response)) check.issue('shape', 'messages')
          const media = field(item, 'parts')
          if (media !== undefined) {
            if (!Array.isArray(media)) check.issue('shape', 'media')
            else for (const part of media) {
              const inline = field(part, 'inlineData')
              if (!record(part) || !record(inline) || !text(field(inline, 'mimeType')) || !text(inline.data)) check.issue('shape', 'media')
              else { extras(part, ['inlineData'], check); extras(inline, ['mimeType', 'data', 'displayName'], check) }
            }
          }
          const continuing = field(item, 'willContinue'), scheduling = field(item, 'scheduling')
          if (continuing !== undefined && typeof continuing !== 'boolean') check.issue('shape', 'messages')
          if (continuing === true || scheduling !== undefined && ![0, 'SCHEDULING_UNSPECIFIED'].includes(scheduling as string | number)) { check.gap('native-contract-unavailable'); check.issue('unsupported-parameter', 'native', 'unsupported-parameter') }
          const matches = pending.flatMap((call, n) => call.name === item.name && (call.id === undefined && item.id === undefined || call.id !== undefined && call.id === item.id) ? [n] : [])
          if (matches.length !== 1) check.issue('tool-id', 'messages', 'message-order')
          else pending.splice(matches[0]!, 1)
        }
      } else { check.gap('native-contract-unavailable'); check.issue('unsupported-parameter', 'native', 'unsupported-parameter') }
    }
  }
  if (pending.length) check.issue('tool-group', 'messages', 'message-order')
}
