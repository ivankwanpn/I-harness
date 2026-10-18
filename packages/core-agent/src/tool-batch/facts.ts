import { createNondurableFactOwner, isNondurableSession, type SessionView } from '@i-harness/core-session'
import type { ExecuteToolCallsOptions } from './types.ts'

export function resolveBatchFacts(session: SessionView, options: ExecuteToolCallsOptions): ExecuteToolCallsOptions {
  const checkpoint = options.flush ? { flush: () => options.flush!() } : {}
  if (options.facts && options.registerFactSource) return { ...options, ...checkpoint }
  if (!isNondurableSession(session)) throw Object.assign(new Error('Managed tools require owned producer ports'), { code: 'FACT_OWNER_UNSUPPORTED' })
  // This explicit standalone batch already owns its received calls, including
  // before-dispatch cancellation facts. Establish that result source first,
  // then connect the original signal before any optional preparation/effect.
  const action = createNondurableFactOwner(session).beginAction()
  let registered = false
  const registerFactSource: NonNullable<ExecuteToolCallsOptions['registerFactSource']> = drain => {
    if (registered) throw new Error('Standalone batch source is already registered')
    registered = true
    const stop = () => action.stop()
    const source = action.registerSettlementSource(async () => {
      try { await drain() }
      finally {
        options.signal?.removeEventListener('abort', stop)
        action.finish()
      }
    })
    if (options.signal?.aborted) stop()
    else options.signal?.addEventListener('abort', stop, { once: true })
    return source
  }
  return { ...options, ...checkpoint, facts: action.facts.tools, registerFactSource, assertFactOpen: action.assertOpen }
}
