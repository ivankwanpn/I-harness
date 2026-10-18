import { randomUUID } from 'node:crypto'
import { committedFactSeqs, isNondurableSession, readInbox, type ImageInput, type GenerationOrigin } from '@i-harness/core-session'
import { generationError } from '@i-harness/llm-seam'
import type { AgentConfig, AgentDeps, AgentInputOptions } from './types.ts'

/** Direct managed API callers use the same document/input owner. Literal API
 * inputs receive no host-command preparation authority from the file version. */
export async function openDirectInput(deps: AgentDeps & AgentConfig, input: { message: string; images?: ImageInput[]; inputId?: string; options?: AgentInputOptions; producer: string }, signal: AbortSignal | undefined, start: { wall: number; monotonic: number }) {
  if (isNondurableSession(deps.session) || input.options?.generation || deps.sharedBudget) return undefined
  if (!deps.generationLifecycle) throw generationError('GENERATION_UNSUPPORTED')
  signal?.throwIfAborted(); deps.assertFactOpen?.()
  const inputId = input.inputId ?? randomUUID()
  if (!input.inputId) committedFactSeqs(await deps.facts!.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId, text: input.message, delivery: 'queue', intent: 'user',
    provenance: input.options?.provenance ?? { kind: 'unknown', authority: 'unknown', scope: 'turn', producer: input.producer }, ...(input.images?.length ? { images: input.images } : {}) }))
  const admission = deps.session.events.findLast(event => event.type === 'agent/input/admitted' && event.inputId === inputId)
  if (admission?.type !== 'agent/input/admitted' || admission.text !== input.message || !readInbox(deps.session, deps.session.header?.seedLength ?? 0).isPending(inputId)) throw generationError('GENERATION_STALE')
  const origin: GenerationOrigin = admission.intent === 'system' ? { kind: 'observation-input', seq: admission.seq!, inputId }
    : admission.provenance?.kind === 'inherited' ? { kind: 'delegated-input', ref: 'admitted', seq: admission.seq!, inputId }
    : { kind: 'input', seq: admission.seq! }
  const generation = await deps.generationLifecycle.open('main', origin, { signal, start, timeoutMs: deps.modelActionTimeoutMs, maxAttempts: deps.modelActionMaxAttempts })
  deps.generationAction = generation
  return { inputId, generation }
}
