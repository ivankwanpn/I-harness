import { validateDeliveryFrame } from '../conversation/delivery.ts'
import type { Session, SessionEvent } from '../events/types.ts'
import { createConversationIndex, createBootstrapConversationIndex, readConversationDeliveries, readConversationGenerations, conversationScopeKey, type ConversationValidationIndex } from '../conversation/validation.ts'
import { managedSessions, managedFactOwners, subscribers } from '../events/state.ts'
import { captureLegacyFact, freezeJsonData } from './capture.ts'
import type { SessionView } from './types.ts'
import { prepareSessionEvent } from '../events/intake.ts'
const originalIndexes = new WeakMap<SessionView, ConversationValidationIndex>()
const originalSourceSessions = new WeakMap<SessionView, string | undefined>()
// Only managedSessionState enrolls: its initial copy and every appended row
// are immutable. Other view factories must qualify their own invariants.
const immutableFactories = new WeakMap<SessionView, {index:ConversationValidationIndex;assertFrontier(count:number):void}>()
export interface ManagedHistoryCut {readonly kind:'original-managed-history-cut'}
const historyCuts = new WeakMap<ManagedHistoryCut,{view:SessionView;owner:object;sessionId:string;factory:NonNullable<ReturnType<typeof immutableFactories.get>>;count:number}>()
export function captureManagedHistoryCut(view:SessionView,owner:object,sessionId:string):ManagedHistoryCut {
  const factory=immutableFactories.get(view)
  if(!factory||managedFactOwners.get(view)!==owner||originalSourceSessions.get(view)!==sessionId||originalIndexes.get(view)!==factory.index)throw TypeError('Original immutable history source required')
  const count=factory.index.eventCount;factory.assertFrontier(count)
  const cut=Object.freeze({kind:'original-managed-history-cut' as const})
  historyCuts.set(cut,{view,owner,sessionId,factory,count});return cut
}
/** Passive prefix identity only. Original caller admission remains separate. */
export function assertManagedHistoryCut(cut:ManagedHistoryCut,view:SessionView,owner:object,sessionId:string):void {
  const original=historyCuts.get(cut)
  if(!original||original.view!==view||original.owner!==owner||original.sessionId!==sessionId||immutableFactories.get(view)!==original.factory||originalIndexes.get(view)!==original.factory.index||managedFactOwners.get(view)!==owner||originalSourceSessions.get(view)!==sessionId)throw TypeError('Original immutable history cut required')
  original.factory.assertFrontier(original.count)
}
/** Exact containing document identity; a caller label cannot choose a source. */
export function isManagedResultSource(view: SessionView, owner: object, sessionId: string): boolean {
  return managedFactOwners.get(view) === owner && originalSourceSessions.get(view) === sessionId
}
/** Existing owned structural index, shared by held semantic/result selection. */
export function readOwnedSelectionMetadata(view: SessionView) {
  const index = originalIndexes.get(view)
  const seed = view.header?.semanticSeed
  // Staging metadata is not a completed selected-result source. Fall back to
  // the strict source reader, which refuses until completion/initial exists.
  if (seed?.version === 3 && index && index.eventCount < seed.seedLength + 1 + (seed.initialInputId === undefined ? 0 : 1)) return undefined
  return index && { facts: index.resultFacts(), history: index.history() }
}
/** Only immutable views constructed here have an original committed read link.
 * Mutable memory sessions deliberately use a strict observation replay instead. */
export function readOwnedDeliveryState(view: SessionView) {
  const index = originalIndexes.get(view)
  return index && readConversationDeliveries(index)
}
/** Exact immutable factory view and original scope only. Unbound/mutable or
 * mismatched observations retain the public strict replay path. */
export function readOwnedGenerationActions(view: SessionView, scope: import('../conversation/generation.ts').GenerationHistoryScope) {
  const index = originalIndexes.get(view)
  return index && index.generationScope === conversationScopeKey(scope) ? readConversationGenerations(index) : undefined
}

/** Composition capability, never attached to the public readonly Session. The
 * private array and structural index are installed together without yielding. */
export function createManagedSessionState(source: Session, scope?: { sessionId: string }) {
  return managedSessionState(source, scope, createConversationIndex)
}
export function createBootstrapManagedSessionState(source: Session, scope?: { sessionId: string }) {
  return managedSessionState(source, scope, createBootstrapConversationIndex)
}
function managedSessionState(source: Session, scope: { sessionId: string } | undefined, createIndex: typeof createBootstrapConversationIndex) {
  const captured = captureLegacyFact(source)
  if (captured.kind !== 'captured') throw new TypeError('FACT_CAPTURE_FAILED')
  const events: SessionEvent[] = [...captured.value.events] as SessionEvent[]
  const index = createIndex(events, position => events[position], source.formatVersion, { ...source.header, ...scope })
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
  originalIndexes.set(view, index)
  originalSourceSessions.set(view, scope?.sessionId)
  immutableFactories.set(view,{index,assertFrontier(count){
    // The private array has no replacement path, only frozen-row append.
    // Index and array publication are one synchronous original installation.
    if(events.length<count||index.eventCount!==events.length)throw TypeError('Original immutable history frontier unavailable')
  }})
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
      validateDeliveryFrame(prepared, view.formatVersion)
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
