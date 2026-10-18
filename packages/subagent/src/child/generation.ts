import { randomUUID } from 'node:crypto'
import { committedFactSeqs, isNondurableSession, type FactOwner, type ProducerFactOutcome, type GenerationOrigin } from '@i-harness/core-session'
import type { AgentGenerationAction } from '@i-harness/core-agent'
import type { ModelClient } from '@i-harness/llm-seam'
import type { SpawnOptions } from './types.ts'

export interface InitialChildInput {
  inputId: string; outcome: ProducerFactOutcome
  generation?: AgentGenerationAction
  delegatedOrigin?: Extract<GenerationOrigin, { kind: 'delegated-input' }>
  sharedGeneration?: object
  close(): Promise<void>
}
/** A newly committed child-local delegation owns its clock before resolution;
 * parent seed/provenance remains observation and grants no operational spend. */
export async function openInitialChildGeneration(opts: SpawnOptions, owner: FactOwner, sessionId: string | undefined, controller: AbortController, start: { wall: number; monotonic: number }, selected: () => ModelClient): Promise<InitialChildInput> {
  const inputId = randomUUID(), action = owner.beginAction(controller.signal)
  let lifecycle: import('@i-harness/core-agent').AgentGenerationLifecycle | undefined, generation: AgentGenerationAction | undefined
  try {
    const outcome = await action.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId, text: opts.message, delivery: 'queue', intent: 'user',
      provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'subagent.initial', ...(opts.childSessions?.parentSessionId ? { originSessionId: opts.childSessions.parentSessionId } : {}) } })
    const [seq] = committedFactSeqs(outcome)
    if (isNondurableSession(owner.view)) { action.finish(); return { inputId, outcome, close: async () => {} } }
    if (opts.childSessions?.origin === 'approval-review' && opts.sharedGeneration) {
      const sharedGeneration = opts.sharedGeneration.forChild(owner.view)
      action.finish()
      return { inputId, outcome, sharedGeneration, close: async () => {} }
    }
    if (!sessionId || !opts.generationFactoryFor || opts.childSessions?.origin === 'approval-review') throw Object.assign(new Error('Child generation ownership is unavailable'), { code: 'GENERATION_UNSUPPORTED' })
    lifecycle = opts.generationFactoryFor(owner, sessionId, selected)(action)
    const delegatedOrigin = { kind: 'delegated-input' as const, ref: 'admitted' as const, seq: seq!, inputId }
    generation = await lifecycle.open('main', delegatedOrigin, { signal: controller.signal, timeoutMs: opts.modelActionTimeoutMs, maxAttempts: opts.modelActionMaxAttempts, start })
    const owned = generation, source = lifecycle
    return { inputId, outcome, generation, delegatedOrigin, async close() {
      try { await owned.close(controller.signal.aborted ? 'stopped' : 'failed') }
      finally { try { await source.drain() } finally { action.finish() } }
    } }
  } catch (error) {
    try { await generation?.close(controller.signal.aborted ? 'stopped' : 'failed') }
    finally { try { await lifecycle?.drain() } finally { action.finish() } }
    throw error
  }
}
