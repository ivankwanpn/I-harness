import type { SessionEvent } from '../events/types.ts'
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
function closed(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && required.every(key => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every(key => {
      if (typeof key !== 'string' || ![...required, ...optional].includes(key)) return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
    })
}
/** Data-only nested carrier gate shared by append, staged persistence and load.
 * Historical absence is preserved; no native/provider dependency enters here. */
export function validNativeProducerWitness(continuation: unknown, visibleText: string): boolean {
  if (!record(continuation)) return true
  if (!Object.hasOwn(continuation, 'producerWitness')) return !('producerWitness' in continuation)
  const property = Object.getOwnPropertyDescriptor(continuation, 'producerWitness')
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) return false
  try { checkWitness(continuation, property.value, visibleText); return true } catch { return false }
}
function checkWitness(continuation: Record<string, unknown>, value: unknown, visibleText: string): void {
  const fail: () => never = () => { throw new Error('invalid native producer witness') }
  const witness = value
  if (!record(witness)) fail()
  if (continuation.kind === 'anthropic') {
    if (!closed(witness, ['version', 'thinkingConfigId', 'effortConfigId', 'interleavedBeta', 'mode', 'interleaving'], ['budgetTokens'])
      || witness.version !== 1 || !digest(witness.thinkingConfigId) || !digest(witness.effortConfigId) || typeof witness.interleavedBeta !== 'boolean'
      || !['absent', 'disabled', 'manual', 'adaptive', 'between_tools', 'unknown'].includes(witness.mode as string)
      || !['enabled', 'disabled', 'unknown'].includes(witness.interleaving as string)
      || (witness.mode === 'manual' ? !Number.isSafeInteger(witness.budgetTokens) || (witness.budgetTokens as number) < 1 : Object.hasOwn(witness, 'budgetTokens'))) fail()
  } else if (continuation.kind === 'bedrock') {
    if (!closed(witness, ['version', 'messagesPrefixId', 'inputSurfaceId', 'callsId', 'callCount']) || witness.version !== 1
      || !digest(witness.messagesPrefixId) || !digest(witness.inputSurfaceId) || !digest(witness.callsId)
      || !Number.isSafeInteger(witness.callCount) || (witness.callCount as number) < 0
      || !Array.isArray(continuation.reasoningBlocks) || !Array.isArray(continuation.contentOrder)) fail()
    const reasoning = new Set<number>(), tools = new Set<number>()
    let text = ''
    for (const entry of continuation.contentOrder) {
      if (!record(entry)) fail()
      if (entry.kind === 'text' && typeof entry.text === 'string') text += entry.text
      else if (entry.kind === 'reasoning' || entry.kind === 'tool') {
        const seen = entry.kind === 'tool' ? tools : reasoning
        const maximum = entry.kind === 'tool' ? witness.callCount as number : continuation.reasoningBlocks.length
        if (!Number.isSafeInteger(entry.index) || (entry.index as number) < 0 || (entry.index as number) >= maximum || seen.has(entry.index as number)) fail()
        seen.add(entry.index as number)
      } else fail()
    }
    if (tools.size !== witness.callCount || reasoning.size !== continuation.reasoningBlocks.length || text !== visibleText) fail()
  } else fail()
  if (new TextEncoder().encode(JSON.stringify(witness)).byteLength > 512) fail()
}
export function validateNativeWitness(event: SessionEvent, formatVersion: number): void {
  if (event.type !== 'assistant/message') return
  const continuation: unknown = event.providerContinuation
  if (record(continuation) && 'producerWitness' in continuation && (formatVersion < 5 || !validNativeProducerWitness(continuation, event.text))) throw new Error('invalid native producer witness or session format')
}
