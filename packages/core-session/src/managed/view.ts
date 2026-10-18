import type { Session, SessionEvent } from '../events/types.ts'
import { createConversationIndex } from '../conversation/validation.ts'
import { managedSessions, managedFactOwners, subscribers } from '../events/state.ts'
import { captureLegacyFact, freezeJsonData } from './capture.ts'
import type { SessionView } from './types.ts'
import { prepareSessionEvent } from '../events/intake.ts'

/** Composition capability, never attached to the public readonly Session. The
 * private array and structural index are installed together without yielding. */
export function createManagedSessionState(source: Session, scope?: { sessionId: string }) {
  const captured = captureLegacyFact(source)
  if (captured.kind !== 'captured') throw new TypeError('FACT_CAPTURE_FAILED')
  const events: SessionEvent[] = [...captured.value.events] as SessionEvent[]
  const index = createConversationIndex(events, position => events[position], source.formatVersion, { ...source.header, ...scope })
  const pendingInputs = new Set<string>()
  for (const event of events) {
    if (event.type === 'agent/input/admitted') pendingInputs.add(event.inputId)
    if (event.type === 'agent/input/promoted' || event.type === 'agent/input/cancelled') pendingInputs.delete(event.inputId)
  }
  const deny = (): never => { throw new TypeError('Managed Session is readonly') }
  const facade = new Proxy(events, {
    set: deny, deleteProperty: deny, defineProperty: deny, setPrototypeOf: deny, preventExtensions: deny,
  })
  const view: SessionView = Object.freeze({
    formatVersion: source.formatVersion, events: facade,
    ...(captured.value.header ? { header: captured.value.header } : {}),
  })
  managedSessions.add(view)
  return {
    view,
    bindOwner(owner: object) {
      if (managedFactOwners.has(view)) throw new Error('Managed view already has a fact owner')
      managedFactOwners.set(view, owner)
    },
    stage(suffix: SessionEvent[]) {
      const prepared: SessionEvent[] = []
      for (const event of suffix) prepared.push(freezeJsonData(prepareSessionEvent(view, event, event.seq!, prepared)) as SessionEvent)
      const changed = new Map<string, boolean>()
      for (const event of prepared) {
        if (event.type !== 'agent/input/admitted' && event.type !== 'agent/input/promoted' && event.type !== 'agent/input/cancelled') continue
        const pending = changed.get(event.inputId) ?? pendingInputs.has(event.inputId)
        if (event.type === 'agent/input/admitted') {
          if (pending || !event.inputId || typeof event.text !== 'string' || !event.text || !['queue', 'steer'].includes(event.delivery) || !['user', 'system'].includes(event.intent)) throw new TypeError('Invalid or duplicate input admission')
          changed.set(event.inputId, true)
        } else {
          if (!pending) throw new TypeError('Input is not pending')
          changed.set(event.inputId, false)
        }
      }
      const staged = index.stage(prepared)
      let installed = false
      return { events: prepared, install() {
        if (installed) return
        // stage is non-mutating. Both operations below are synchronous and use
        // only owned data; observers are explicitly outside this capability.
        staged.commit()
        for (const event of prepared) events.push(event)
        for (const [id, pending] of changed) { if (pending) pendingInputs.add(id); else pendingInputs.delete(id) }
        installed = true
      } }
    },
    observe(suffix: readonly SessionEvent[], report: (error: unknown) => void) {
      const observers = subscribers.get(view)
      if (!observers) return
      const failed = () => {
        try { Promise.resolve(report(Object.assign(new Error('Managed fact observer failed'), { code: 'FACT_OBSERVER_FAILED' }))).catch(() => {}) }
        catch { /* A diagnostic sink cannot change an already committed fact. */ }
      }
      for (const event of suffix) for (const observer of [...observers]) {
        try { Promise.resolve(observer(event)).catch(failed) } catch { failed() }
      }
    },
  }
}
export function isManagedFactOwner(view: SessionView, owner: object): boolean { return managedFactOwners.get(view) === owner }
