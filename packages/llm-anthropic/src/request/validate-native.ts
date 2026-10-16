import { createHash } from 'node:crypto'
import { encodeSdkCommandData } from '@i-harness/token-meter'
import { canReplayContinuation, replayBlockOrder, type LLMMessage, type ProviderContinuation, validationCollector } from '@i-harness/llm-seam'
import type { AnthropicConfig } from '../types.ts'
import { anthropicCapabilities, hasInterleavedBeta } from './capabilities.ts'
import { describeCachedBody, type CacheEvidence } from './cache-evidence.ts'
import { ongoingAnthropicToolTurn } from './logical-turn.ts'
type Witness = NonNullable<Extract<ProviderContinuation, { kind: 'anthropic' }>['producerWitness']>
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function digest(domain: string, value: unknown): string { return createHash('sha256').update(`i-harness:${domain}\0`).update(encodeSdkCommandData(value)).digest('hex') }
/** Only selected, final wire facts. Neither capability knowledge nor unrelated
 * output configuration/header/auth data participates in identity. */
export function anthropicWitness(body: Record<string, unknown>, config: AnthropicConfig): Witness {
  const thinking = record(body.thinking) ? body.thinking : undefined
  const type = thinking?.type
  const mode = body.thinking === undefined ? 'absent' : type === 'enabled' ? 'manual' : ['disabled', 'adaptive', 'between_tools'].includes(type as string) ? type as 'disabled' | 'adaptive' | 'between_tools' : 'unknown'
  const cap = anthropicCapabilities(config), beta = hasInterleavedBeta(config.headers)
  return Object.freeze({ version: 1, thinkingConfigId: digest('messages-thinking-v1', Object.hasOwn(body, 'thinking') ? ['present', body.thinking] : ['absent']), effortConfigId: digest('messages-effort-v1', record(body.output_config) && Object.hasOwn(body.output_config, 'effort') ? ['present', body.output_config.effort] : ['absent']), interleavedBeta: beta, mode, ...(mode === 'manual' && Number.isSafeInteger(thinking?.budget_tokens) && (thinking!.budget_tokens as number) > 0 ? { budgetTokens: thinking!.budget_tokens as number } : {}), interleaving: cap ? cap.manualInterleaving && beta ? 'enabled' : 'disabled' : 'unknown' })
}
/** Observe mapper preservation/degradation and compare producer wire facts only
 * inside the ongoing tool turn. Completed earlier turns may change mode. */
export function validateAnthropicNative(body: Record<string, unknown>, config: AnthropicConfig, source: readonly LLMMessage[], cache: CacheEvidence, check: ReturnType<typeof validationCollector>): void {
  const final = describeCachedBody(body, cache).semantic
  if (!Array.isArray(final.messages)) return
  const assistants = source.filter((message): message is Extract<LLMMessage, { role: 'assistant' }> => message.role === 'assistant')
  let ordinal = 0, preserved = false, unverified = false, incompatible = false
  const current = anthropicWitness(body, config)
  const turn = ongoingAnthropicToolTurn(final.messages)
  for (const [wireIndex, wire] of final.messages.entries()) {
    if (!record(wire) || wire.role !== 'assistant') continue
    const original = assistants[ordinal++]
    if (!original?.thinkingBlocks?.length) continue
    const continuation = original.providerContinuation?.kind === 'anthropic' ? original.providerContinuation : undefined
    const blocks = Array.isArray(wire.content) ? wire.content.filter(block => record(block) && ['thinking', 'redacted_thinking'].includes(block.type as string)) : []
    const retained = encodeSdkCommandData(blocks) === encodeSdkCommandData(original.thinkingBlocks)
    if (!retained) {
      // Portable visible text/calls already exists; opaque-only removal cannot
      // be represented as a successful portable projection.
      if (!original.content && !original.toolCalls?.length) { check.issue('native-replay', 'native', 'native-replay'); incompatible = true }
      else unverified = true
      continue
    }
    if (continuation && !canReplayContinuation(continuation, config)) { check.issue('native-replay', 'native', 'native-replay'); incompatible = true; continue }
    const tools = (original.toolCalls ?? []).map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args }))
    const ordered = replayBlockOrder<unknown>(continuation?.contentOrder, original.content, original.thinkingBlocks, tools, text => ({ type: 'text', text }))
    const expected = ordered ?? [...original.thinkingBlocks, ...(original.content.trim() ? [{ type: 'text', text: original.content }] : []), ...tools]
    if (encodeSdkCommandData(wire.content) !== encodeSdkCommandData(expected)) { check.issue('native-replay', 'native', 'native-replay'); incompatible = true; continue }
    const witness = continuation?.producerWitness
    if (!witness) { unverified = true; continue }
    preserved = true
    if (turn?.assistantIndices.has(wireIndex)) {
      const cap = anthropicCapabilities(config)
      const changedMode = witness.thinkingConfigId !== current.thinkingConfigId
      const effectiveBetaChanged = cap?.manualInterleaving === true && current.mode === 'manual' && witness.interleavedBeta !== current.interleavedBeta
      if (changedMode || effectiveBetaChanged) { check.issue('native-replay', 'native', 'native-replay'); incompatible = true }
      if (witness.effortConfigId !== current.effortConfigId) unverified = true
    }
  }
  if (incompatible) check.native('incompatible')
  else if (unverified) check.native()
  else if (preserved) check.native('preserved')
}
