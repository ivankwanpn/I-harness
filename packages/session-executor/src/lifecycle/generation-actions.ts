import { randomUUID } from 'node:crypto'
import { isNondurableSession, readGenerationActions, type CapturedActionFact, type GenerationActionEvent, type GenerationEvent, type GenerationOrigin, type ManagedAction, type ProducerFactOutcome, type SessionView } from '@i-harness/core-session'
import { generationError } from '@i-harness/llm-seam'
import type { AgentGenerationLifecycle } from '@i-harness/core-agent'
import { generationClock } from './generation-clock.ts'
import { OwnedGenerationAction } from './generation-action.ts'

const sameOrigin = (a: GenerationOrigin, b: GenerationOrigin) => a.kind === b.kind && a.seq === b.seq
  && (a.kind === 'observation-input' ? a.inputId === (b.kind === 'observation-input' ? b.inputId : undefined) : true)
  && ('parentActionId' in a ? a.parentActionId : undefined) === ('parentActionId' in b ? b.parentActionId : undefined)
  && (a.kind === 'delegated-input' ? a.ref === (b.kind === 'delegated-input' ? b.ref : undefined)
    && (a.ref === 'admitted' ? a.inputId : a.messageId) === (b.kind === 'delegated-input' ? b.ref === 'admitted' ? b.inputId : b.messageId : undefined) : true)

/** One lifecycle per real F1 action. Durable facts alone determine allowance;
 * the only private spend information is live proof that a handoff was unsent. */
export function createGenerationLifecycle(view: SessionView, ownerSessionId: string, action: ManagedAction<ProducerFactOutcome>, localTest?: { enabled: boolean; selectedClient(): import('@i-harness/llm-seam').ModelClient | undefined }): AgentGenerationLifecycle {
  const descriptor = Object.getOwnPropertyDescriptor(action, 'owner'), owner = descriptor && 'value' in descriptor ? descriptor.value as import('@i-harness/core-session').OwnerToken : undefined
  if (!isNondurableSession(view) && (!owner || !Object.isFrozen(owner) || descriptor?.writable !== false || descriptor.configurable !== false || owner.sessionId !== ownerSessionId || typeof owner.incarnation !== 'string' || !owner.incarnation)) throw generationError('GENERATION_UNSUPPORTED')
  const incarnation = owner?.incarnation ?? randomUUID(), retained = new Set<CapturedActionFact<ProducerFactOutcome>>()
  const running = new Set<Promise<unknown>>()
  const source = action.registerSettlementSource(async () => {
    await Promise.allSettled([...running])
    for (const capture of [...retained]) {
      const outcome = await capture.observe()
      if (outcome.kind === 'committed' || outcome.kind === 'memory-committed') { retained.delete(capture); continue }
      if (outcome.kind === 'unknown' || outcome.kind === 'recovery-required' || outcome.kind === 'conflict') {
        const reconciled = await capture.reconcile()
        if (reconciled.kind === 'committed' || reconciled.kind === 'memory-committed') { retained.delete(capture); continue }
      }
      throw generationError('GENERATION_UNCERTAIN')
    }
  })
  const scope = { ...view.header, sessionId: ownerSessionId }
  const state = (id: string) => readGenerationActions(view.events, scope).find(value => value.opened.actionId === id)
  const own = <T>(operation: Promise<T>): Promise<T> => {
    running.add(operation)
    void operation.then(() => running.delete(operation), () => running.delete(operation))
    return operation
  }
  const receipt = async (capture: CapturedActionFact<ProducerFactOutcome>) => {
    retained.add(capture)
    const result = await own(capture.admit())
    if (result.kind === 'committed' || result.kind === 'memory-committed') { retained.delete(capture); return result }
    if (result.kind === 'not-issued') {
      retained.delete(capture)
      if (result.code === 'FACT_CANCELLED' || result.code === 'FACT_CLOSED') throw generationError('GENERATION_CLOSED')
      if (result.code === 'FACT_PRECONDITION_STALE') throw generationError('GENERATION_STALE')
    }
    throw generationError('GENERATION_UNCERTAIN')
  }
  const commit = (events: readonly GenerationEvent[], current: () => boolean = () => true) => receipt(action.captureGeneration(events, current))
  return { drain: () => source.close(), async open(purpose, origin, options = {}) {
    action.assertOpen()
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) throw generationError('GENERATION_CLOCK_INVALID')
    if (options.maxAttempts !== undefined && (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0)) throw new TypeError('Invalid generation attempt limit')
    let persisted = readGenerationActions(view.events, scope).find(value => value.opened.purpose === purpose && sameOrigin(value.opened.origin, origin))
    if (!persisted) {
      const startedAt = options.start?.wall ?? Date.now(), timeout = options.timeoutMs ?? (purpose === 'main' || purpose === 'manual' ? 3_600_000 : purpose === 'title' ? 30_000 : 90_000)
      if (!Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(startedAt + timeout)) throw generationError('GENERATION_CLOCK_INVALID')
      const event: GenerationActionEvent = { type: 'context/action', version: 1, op: 'open', ownerSessionId, actionId: randomUUID(), purpose, origin, startedAt, expiresAt: startedAt + timeout, trustedAt: startedAt }
      await commit([event])
      persisted = state(event.actionId)
    }
    if (!persisted || persisted.closed) throw generationError('GENERATION_CLOSED')
    if (options.timeoutMs !== undefined && !Number.isSafeInteger(persisted.opened.startedAt + options.timeoutMs)) throw generationError('GENERATION_CLOCK_INVALID')
    const expiresAt = Math.min(persisted.expiresAt, options.timeoutMs === undefined ? persisted.expiresAt : persisted.opened.startedAt + options.timeoutMs)
    const limits = persisted.limits && { ...persisted.limits, total: Math.min(persisted.limits.total, options.maxAttempts ?? persisted.limits.total) }
    if (expiresAt < persisted.expiresAt || limits && limits.total < persisted.limits!.total) {
      await commit([{ type: 'context/action', version: 1, op: 'constrain', ownerSessionId, actionId: persisted.opened.actionId, trustedAt: Math.max(Date.now(), persisted.trustedAt), expiresAt, ...(limits ? { limits } : {}) }])
      persisted = state(persisted.opened.actionId)!
    }
    const clock = generationClock(persisted.opened.startedAt, persisted.expiresAt, persisted.trustedAt, options.signal ? AbortSignal.any([action.signal, options.signal]) : action.signal, options.start)
    return new OwnedGenerationAction(persisted, clock, {
      view, ownerSessionId, incarnation, assertOpen: action.assertOpen, read: state,
      append: async (events, current) => { await commit(events, current) },
      settle: async event => { await receipt(source.generation.capture(event)) },
      phase: async (recovery, phase, current) => { await receipt(action.captureGenerationRecovery(recovery, phase, current)) },
    }, { maxAttempts: options.maxAttempts, localTest: options.selectedClient ? { enabled: localTest?.enabled === true, selectedClient: options.selectedClient } : localTest })

  } }
}
