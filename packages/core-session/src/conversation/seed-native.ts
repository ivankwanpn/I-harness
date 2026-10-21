import type { LLMMessage, ProviderBlockOrderEntry } from '../projection/types.ts'
import { seedFields, seedId, seedInvalid, seedCount } from './seed-codec.ts'

const text = (value: unknown) => typeof value === 'string'
function order(entries: readonly ProviderBlockOrderEntry[] | undefined): void {
  if (entries === undefined) return
  if (!Array.isArray(entries)) seedInvalid()
  for (const entry of entries) {
    seedFields(entry, entry.kind === 'text' ? ['kind', 'text'] : ['kind', 'index'], entry.kind === 'text' ? ['phase', 'thoughtSignature'] : [])
    if (entry.kind === 'text' ? !text(entry.text) || entry.phase !== undefined && entry.phase !== null && !text(entry.phase) || entry.thoughtSignature !== undefined && !text(entry.thoughtSignature)
      : !['reasoning', 'tool'].includes(entry.kind) || !seedCount(entry.index)) seedInvalid()
  }
}
/** Closed typed native observations; vendor reasoning records remain opaque
 * JSON data, never execution witnesses or current-provider authority. */
export function validateSeedNative(message: Extract<LLMMessage, { role: 'assistant' }>): void {
  if (message.thinkingBlocks !== undefined) {
    if (!Array.isArray(message.thinkingBlocks)) seedInvalid()
    for (const block of message.thinkingBlocks) {
      seedFields(block, block.type === 'thinking' ? ['type', 'thinking', 'signature'] : ['type', 'data'])
      if (block.type === 'thinking' ? !text(block.thinking) || !text(block.signature) : block.type !== 'redacted_thinking' || !text(block.data)) seedInvalid()
    }
  }
  const native = message.providerContinuation
  if (native === undefined) return
  const optional = ['model', 'providerId']
  if (native.kind === 'anthropic') {
    seedFields(native, ['kind', 'model'], ['providerId', 'contentOrder', 'prefixFingerprint', 'toolBindings', 'producerWitness'])
    if (!seedId(native.model) || native.prefixFingerprint !== undefined && !text(native.prefixFingerprint)) seedInvalid()
    order(native.contentOrder)
    if (native.toolBindings !== undefined) {
      if (!Array.isArray(native.toolBindings)) seedInvalid()
      for (const binding of native.toolBindings) { seedFields(binding, ['name', 'inputJson'], ['id']); if (!seedId(binding.name) || !text(binding.inputJson) || binding.id !== undefined && !seedId(binding.id)) seedInvalid() }
    }
  } else if (native.kind === 'openai-compatible') {
    seedFields(native, ['kind', 'reasoningContent'], optional)
    if (!text(native.reasoningContent)) seedInvalid()
  } else if (native.kind === 'openai-responses') {
    seedFields(native, ['kind', 'reasoningItems'], [...optional, 'outputOrder'])
    if (!Array.isArray(native.reasoningItems) || native.reasoningItems.some(item => !item || typeof item !== 'object' || Array.isArray(item))) seedInvalid()
    order(native.outputOrder)
  } else if (native.kind === 'gemini') {
    seedFields(native, ['kind', 'callSignatures'], [...optional, 'thoughtParts', 'textSignature', 'emptyTextSignatures', 'partOrder', 'callBindings'])
    if (!Array.isArray(native.callSignatures) || native.callSignatures.some(signature => signature !== null && !text(signature))
      || native.textSignature !== undefined && !text(native.textSignature) || native.emptyTextSignatures !== undefined && (!Array.isArray(native.emptyTextSignatures) || native.emptyTextSignatures.some(signature => !text(signature)))) seedInvalid()
    if (native.thoughtParts !== undefined) {
      if (!Array.isArray(native.thoughtParts)) seedInvalid()
      for (const part of native.thoughtParts) { seedFields(part, ['text'], ['thoughtSignature']); if (!text(part.text) || part.thoughtSignature !== undefined && !text(part.thoughtSignature)) seedInvalid() }
    }
    if (native.callBindings !== undefined) {
      if (!Array.isArray(native.callBindings)) seedInvalid()
      for (const binding of native.callBindings) { seedFields(binding, ['name', 'argsJson'], ['id']); if (!seedId(binding.name) || !text(binding.argsJson) || binding.id !== undefined && !seedId(binding.id)) seedInvalid() }
    }
    order(native.partOrder)
  } else if (native.kind === 'bedrock') {
    seedFields(native, ['kind', 'reasoningBlocks'], [...optional, 'contentOrder', 'producerWitness'])
    if (!Array.isArray(native.reasoningBlocks)) seedInvalid()
    for (const block of native.reasoningBlocks) {
      if ('reasoningText' in block) { seedFields(block, ['reasoningText']); seedFields(block.reasoningText, ['text'], ['signature']); if (!text(block.reasoningText.text) || block.reasoningText.signature !== undefined && !text(block.reasoningText.signature)) seedInvalid() }
      else { seedFields(block, ['redactedContentBase64']); if (!text(block.redactedContentBase64)) seedInvalid() }
    }
    order(native.contentOrder)
  } else seedInvalid()
  if (native.model !== undefined && !seedId(native.model) || native.providerId !== undefined && !seedId(native.providerId)) seedInvalid()
}
