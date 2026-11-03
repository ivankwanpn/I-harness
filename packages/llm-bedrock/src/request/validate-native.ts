import { createHash } from 'node:crypto'
import { encodeSdkCommandData } from '@i-harness/token-meter'
import { canReplayContinuation, replayBlockOrder, type LLMMessage, type ProviderContinuation, validationCollector } from '@i-harness/llm-seam'
import type { ConverseStreamCommandInput } from '@aws-sdk/client-bedrock-runtime'
import type { BedrockConfig } from '../types.ts'
type Witness = NonNullable<Extract<ProviderContinuation, { kind: 'bedrock' }>['producerWitness']>
export type ConverseInputWitness = Pick<Witness, 'messagesPrefixId' | 'inputSurfaceId'>
export type ConverseCall = { id?: string; name: string; args: unknown }
function digest(domain: string, value: unknown) { return createHash('sha256').update(`i-harness:${domain}\0`).update(encodeSdkCommandData(value)).digest('hex') }
export function converseInputWitness(body: ConverseStreamCommandInput): ConverseInputWitness {
  return Object.freeze({ messagesPrefixId: digest('converse-messages-prefix-v1', body.messages), inputSurfaceId: digest('converse-input-surface-v1', { system: Object.hasOwn(body, 'system') ? ['present', body.system] : ['absent'], tools: Object.hasOwn(body, 'toolConfig') ? ['present', body.toolConfig] : ['absent'] }) })
}
function callsId(calls: readonly ConverseCall[]): string {
  return digest('converse-calls-v1', calls.map(call => [Object.hasOwn(call, 'id') ? ['present', call.id] : ['absent'], call.name, digest('converse-call-args-v1', call.args)]))
}
export function completeConverseWitness(input: ConverseInputWitness, calls: readonly ConverseCall[]): Witness | undefined {
  const ids = new Set<string>()
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]
    if (!call || typeof call.id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(call.id) || !/^[a-zA-Z0-9_-]{1,64}$/.test(call.name) || ids.has(call.id)) return
    ids.add(call.id)
  }
  return Object.freeze({ version: 1, ...input, callsId: callsId(calls), callCount: calls.length })
}
/** Witnesses certify only compared local producer data, never account/native
 * authenticity. Signed-prefix changes and input-surface changes differ. */
export function validateConverseNative(body: ConverseStreamCommandInput, config: BedrockConfig, source: readonly LLMMessage[], check: ReturnType<typeof validationCollector>): void {
  const assistants = source.filter((message): message is Extract<LLMMessage, { role: 'assistant' }> => message.role === 'assistant')
  let ordinal = 0, preserved = false, unverified = false, incompatible = false
  for (const [index, wire] of (body.messages ?? []).entries()) {
    if (wire.role !== 'assistant') continue
    const original = assistants[ordinal++]
    const continuation = original?.providerContinuation?.kind === 'bedrock' ? original.providerContinuation : undefined
    if (!original || !continuation) continue
    const signed = continuation.reasoningBlocks.some(block => 'redactedContentBase64' in block || !!block.reasoningText.signature)
    if (!canReplayContinuation(continuation, config)) {
      if (!original.content && !original.toolCalls?.length) { check.issue('native-replay', 'native', 'native-replay'); incompatible = true }
      else unverified = true
      continue
    }
    const calls = original.toolCalls ?? []
    const ordered = replayBlockOrder<unknown>(continuation.contentOrder, original.content, continuation.reasoningBlocks, calls, text => ({ text }))
    if (signed && continuation.contentOrder && ordered === undefined) { check.issue('native-replay', 'native', 'native-replay'); incompatible = true; continue }
    const reasoning = continuation.reasoningBlocks.map(block => 'reasoningText' in block ? { reasoningContent: { reasoningText: block.reasoningText } } : { reasoningContent: { redactedContent: Buffer.from(block.redactedContentBase64, 'base64') } })
    const toolBlocks = calls.map(call => ({ toolUse: { toolUseId: call.id, name: call.name, input: call.args } }))
    const replay = replayBlockOrder<unknown>(continuation.contentOrder, original.content, reasoning, toolBlocks, text => ({ text }))
      ?? [...reasoning, ...(original.content.trim() ? [{ text: original.content }] : []), ...toolBlocks]
    if (encodeSdkCommandData(wire.content) !== encodeSdkCommandData(replay)) { check.issue('native-replay', 'native', 'native-replay'); incompatible = true; continue }
    const witness = continuation.producerWitness
    if (!witness) { unverified = true; continue }
    const current = converseInputWitness({ ...body, messages: body.messages!.slice(0, index) })
    const invalidCalls = witness.callCount !== calls.length || witness.callsId !== callsId(calls)
    if (invalidCalls || signed && witness.messagesPrefixId !== current.messagesPrefixId) { check.issue('native-replay', 'native', 'native-replay'); incompatible = true; continue }
    if (witness.inputSurfaceId !== current.inputSurfaceId) unverified = true
    else preserved = true
  }
  if (incompatible) check.native('incompatible')
  else if (unverified) check.native()
  else if (preserved) check.native('preserved')
}
