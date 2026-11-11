import { randomUUID } from 'node:crypto'
import { committedFactSeqs, isNondurableSession, type FactOwner, type ProducerFactOutcome, type GenerationOrigin } from '@i-harness/core-session'
import type { AgentGenerationAction } from '@i-harness/core-agent'
import type { ModelClient } from '@i-harness/llm-seam'
import type { SpawnOptions } from './types.ts'
import {committedTaskInitial} from './task-birth.ts'
import type { CapturedHostChildInput } from './host-birth.ts'

/** Internal constructor data from the original storage receipt, never tool args. */
export interface CommittedInitialChildInput {
  inputId: string
  outcome: ProducerFactOutcome
  start: { wall: number; monotonic: number }
}
export interface InitialChildInput {
  inputId: string; outcome: ProducerFactOutcome
  generation?: AgentGenerationAction
  delegatedOrigin?: Extract<GenerationOrigin, { kind: 'delegated-input' }>
  sharedGeneration?: object
  close(): Promise<void>
}
/** A newly committed child-local delegation owns its clock before resolution;
 * parent seed/provenance remains observation and grants no operational spend. */
export async function openInitialChildGeneration(opts: SpawnOptions, owner: FactOwner, sessionId: string | undefined, controller: AbortController, start: { wall: number; monotonic: number }, selected: () => ModelClient, hostInitial?: CommittedInitialChildInput, captured?: CapturedHostChildInput): Promise<InitialChildInput> {
  if (hostInitial && opts.childStart?.kind === 'committed-child-birth') throw Error('Mixed child birth constructors')
  const committed=opts.childStart?.kind==='committed-child-birth'?committedTaskInitial(opts.childStart.birth):hostInitial
  const inputId = committed?.inputId??randomUUID(), action = owner.beginAction(controller.signal)
  const text = captured ? captured.data.message : opts.message
  const parentSessionId = captured ? captured.data.parentSessionId : opts.childSessions?.parentSessionId
  const origin = captured ? captured.data.origin : opts.childSessions?.origin
  const shared = captured ? captured.sharedGeneration : opts.sharedGeneration
  const factory = captured ? captured.generationFactory : opts.generationFactoryFor
  const timeoutMs = captured ? captured.data.modelActionTimeoutMs : opts.modelActionTimeoutMs
  const maxAttempts = captured ? captured.data.modelActionMaxAttempts : opts.modelActionMaxAttempts
  let lifecycle: import('@i-harness/core-agent').AgentGenerationLifecycle | undefined, generation: AgentGenerationAction | undefined
  try {
    const outcome = committed?.outcome??await action.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId, text, delivery: 'queue', intent: 'user',
      provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'subagent.initial', ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } })
    const [seq] = committedFactSeqs(outcome)
    if(committed&&outcome.kind==='committed'){
      const token=Object.getOwnPropertyDescriptor(action,'owner')?.value as import('@i-harness/core-session').OwnerToken|undefined
      if(!token||token.sessionId!==outcome.receipt.owner.sessionId||token.incarnation!==outcome.receipt.owner.incarnation)throw Error('Original initial receipt owner mismatch')
    }
    if (isNondurableSession(owner.view)) { action.finish(); return { inputId, outcome, close: async () => {} } }
    if (origin === 'approval-review' && shared) {
      const sharedGeneration = shared.forChild(owner.view)
      action.finish()
      return { inputId, outcome, sharedGeneration, close: async () => {} }
    }
    if (!sessionId || !factory || origin === 'approval-review') throw Object.assign(new Error('Child generation ownership is unavailable'), { code: 'GENERATION_UNSUPPORTED' })
    lifecycle = factory.call(captured?.receiver ?? opts, owner, sessionId, selected)(action)
    const delegatedOrigin = { kind: 'delegated-input' as const, ref: 'admitted' as const, seq: seq!, inputId }
    generation = await lifecycle.open('main', delegatedOrigin, { signal: controller.signal, timeoutMs, maxAttempts, start })
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
