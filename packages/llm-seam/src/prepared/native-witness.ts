import { validNativeProducerWitness } from '@i-harness/core-session'
import type { LLMMessage } from '../index.ts'
import { validationCollector } from './validation.ts'
import { finalValidationError } from './rejection.ts'
/** Route-explicit native ingress, before snapshot/lowering can erase own-field
 * or prototype defects. This validates metadata, not the replay contract. */
export function assertNativeProducerWitnesses(messages: readonly LLMMessage[], route: 'anthropic-messages' | 'gemini' | 'bedrock'): void {
  const kind = route === 'anthropic-messages' ? 'anthropic' : route
  for (const message of messages) {
    if (message.role !== 'assistant' || message.providerContinuation?.kind !== kind) continue
    if (validNativeProducerWitness(message.providerContinuation, message.content)) continue
    const check = validationCollector(route)
    check.issue('native-replay', 'native', 'native-replay'); check.native('incompatible')
    const rejected = check.finish()
    if (rejected.kind === 'rejected') throw finalValidationError(rejected.reason, rejected.report)
  }
}
