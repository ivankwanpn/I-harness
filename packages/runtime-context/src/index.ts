import type { PluginContext } from '@i-harness/core-plugin'
import type { SessionView as Session, RuntimeContextFactSource, RuntimeContextRecordV1, CapturedActionFact, ProducerFactOutcome } from '@i-harness/core-session'
import { committedFactSeqs, createNondurableFactOwner, isNondurableSession, projectCurrentContext, runtimeContextDigest, renderRuntimeContext, validRuntimeContextRecord } from '@i-harness/core-session'

export const RUNTIME_CONTEXT_SOURCE_PLUGIN = 'i-harness/runtime-context'
export const RUNTIME_CONTEXT_CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'
export interface ContextSection { name: string; text: string }
export interface RuntimeContextService {
  registerSection(name: string, getter: () => string): () => void
  render(signal?: AbortSignal): Promise<void>
  currentText(): string
  close(): Promise<void>
}

/** The source retains one original capture until its real disposition is known.
 * Complete observations enter the existing owner in invocation order. */
export function createRuntimeContext(session: Session, source?: RuntimeContextFactSource): RuntimeContextService {
  const sections = new Map<string, () => string>()
  let accepting = true, closed = false
  type Publication = { capture: CapturedActionFact<ProducerFactOutcome>; action: ReturnType<RuntimeContextFactSource> }
  const uncertain = new Set<Publication>()
  const flights = new Set<Promise<void>>()
  let reconciliation: Promise<void> | undefined
  let adjacent: { digest: string; signal?: AbortSignal; action: ReturnType<RuntimeContextFactSource>; work: Promise<void> } | undefined
  const memory = !source && isNondurableSession(session) ? createNondurableFactOwner(session) : undefined
  const captureSections = (): RuntimeContextRecordV1 => {
    const snapshot: ContextSection[] = []
    for (const [name, getter] of sections) {
      const text = getter().trim()
      if (text) snapshot.push({ name, text })
    }
    const record: RuntimeContextRecordV1 = { type: 'runtime/context', version: 1, sections: snapshot }
    if (!validRuntimeContextRecord(record)) throw new TypeError('Invalid runtime context sections')
    return record
  }
  async function reconcileOriginals() {
    for (const original of uncertain) {
      const outcome = await original.capture.reconcile()
      if (outcome.kind === 'absent' || outcome.kind === 'not-issued') {
        uncertain.delete(original); original.action.finish()
      }
      committedFactSeqs(outcome)
      uncertain.delete(original); original.action.finish()
    }
  }
  function reconcile(): Promise<void> {
    return reconciliation ??= reconcileOriginals().finally(() => { reconciliation = undefined })
  }
  function publish(record: RuntimeContextRecordV1, signal?: AbortSignal): Promise<void> {
    const latest = projectCurrentContext(session)
    if (!flights.size && latest?.semanticDigest === runtimeContextDigest(record.sections)) return Promise.resolve()
    const digest = runtimeContextDigest(record.sections)
    const action = source ? source(signal) : adjacent && adjacent.signal === signal ? adjacent.action : memory?.beginAction(signal)
    if (!action) throw Object.assign(new Error('Managed runtime context requires its owned source'), { code: 'FACT_OWNER_UNSUPPORTED' })
    if (adjacent?.digest === digest && adjacent.signal === signal && adjacent.action === action) return adjacent.work
    const capture = action.captureRuntimeContext(record, () => !closed)
    const publication = { action, capture }
    const work = capture.admit().then(outcome => {
      if (outcome.kind === 'not-issued' || outcome.kind === 'absent') action.finish()
      else {
        try { committedFactSeqs(outcome) }
        catch (error) { uncertain.add(publication); throw error }
        action.finish()
      }
      committedFactSeqs(outcome)
    }, error => { uncertain.add(publication); throw error })
    adjacent = { digest, signal, action, work }
    const settled = () => { if (adjacent?.work === work) adjacent = undefined }
    void work.then(settled, settled)
    return work
  }
  return {
    registerSection(name, getter) {
      if (!accepting) throw new Error('Runtime context closed')
      if (!validRuntimeContextRecord({ type: 'runtime/context', version: 1, sections: [{ name, text: '' }] })) throw new TypeError('Invalid runtime context section name')
      if (sections.has(name)) throw new Error('duplicate runtime-context section: ' + name)
      sections.set(name, getter)
      return () => { if (sections.get(name) === getter) sections.delete(name) }
    },
    currentText: () => renderRuntimeContext(captureSections().sections),
    render(signal) {
      if (!accepting) return Promise.reject(new Error('Runtime context closed'))
      const record = captureSections()
      // Capture/admit synchronously under the original source and signal.
      // An uncertain previous publication must first resolve its SAME capture.
      let work: Promise<void>
      try { work = uncertain.size ? reconcile().then(() => publish(record, signal)) : publish(record, signal) }
      catch (error) { work = Promise.reject(error) }
      flights.add(work)
      const settled = () => { flights.delete(work) }
      void work.then(settled, settled)
      return work
    },
    async close() {
      accepting = false
      await Promise.allSettled([...flights])
      await reconcile()
      closed = true
    },
  }
}

export function installRuntimeContext(ctx: PluginContext, session: Session, source?: RuntimeContextFactSource): RuntimeContextService {
  const service = createRuntimeContext(session, source)
  ctx.on('agent/pre-step', async input => {
    const event = input as { session?: Session; signal?: AbortSignal }
    if (event.session !== session) return
    await service.render(event.signal)
  })
  return service
}
