import { validateDeliveryFrame } from '../conversation/delivery.ts'
import type { Session, SessionEvent } from '../events/types.ts'
import { createConversationIndex, createBootstrapConversationIndex, readConversationDeliveries, readConversationGenerations, conversationScopeKey, type ConversationValidationIndex } from '../conversation/validation.ts'
import { managedSessions, managedFactOwners, subscribers } from '../events/state.ts'
import { captureLegacyFact, freezeJsonData } from './capture.ts'
import type { SessionView } from './types.ts'
import { prepareSessionEvent } from '../events/intake.ts'
import { createManagedIntakeIndex } from './intake-index.ts'
const originalIndexes = new WeakMap<SessionView, ConversationValidationIndex>()
const originalSourceSessions = new WeakMap<SessionView, string | undefined>()
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
  const intake=createManagedIntakeIndex()
  intake.stage(events,false).commit()
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
  return {
    view,
    bindOwner(owner: object) {
      if (managedFactOwners.has(view)) throw new Error('Managed view already has a fact owner')
      managedFactOwners.set(view, owner)
    },
    stage(suffix: SessionEvent[]) {
      const prepared: SessionEvent[] = []
      for (const event of suffix) prepared.push(freezeJsonData(prepareSessionEvent(view, event, event.seq!, prepared)) as SessionEvent)
      const inputs=intake.stage(prepared)
      validateDeliveryFrame(prepared, view.formatVersion)
      const staged = index.stage(prepared)
      let installed = false
      return { events: prepared, install() {
        if (installed) return
        // stage is non-mutating. Both operations below are synchronous and use
        // only owned data; observers are explicitly outside this capability.
        staged.commit()
        for (const event of prepared) events.push(event)
        inputs.commit()
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
/** Explicit complete compatibility array over an already-owned index. It never
 * reconstructs validation or supplies authority to a different producer. */
export function createManagedIndexedView(source:readonly import('./types.ts').SessionEventView[],formatVersion:number,header:SessionView['header'],index:ConversationValidationIndex,owner:object,sessionId:string){
  if(source.length!==index.eventCount)throw TypeError('Complete original compatibility history required')
  const events=[...source] as SessionEvent[],deny=():never=>{throw TypeError('Managed Session is readonly')}
  const facade=new Proxy(events,{set:deny,deleteProperty:deny,defineProperty:deny,setPrototypeOf:deny,preventExtensions:deny})
  const view:SessionView=Object.freeze({formatVersion,events:facade,...header?{header}:{}})
  managedSessions.add(view);managedFactOwners.set(view,owner);originalIndexes.set(view,index);originalSourceSessions.set(view,sessionId)
  return {view,append(suffix:readonly import('./types.ts').SessionEventView[]){
    const first=suffix[0]?.seq;if(first===undefined)return
    if(events.length>first){if(suffix.some(event=>events[event.seq!]!==event))throw TypeError('Original compatibility suffix changed');return}
    if(events.length!==first||index.eventCount!==first+suffix.length)throw TypeError('Original compatibility suffix mismatch')
    for(const event of suffix)events.push(event as SessionEvent)
  },observe(suffix:readonly SessionEvent[],report:(error:unknown)=>void){
    const failed=()=>{try{Promise.resolve(report(Object.assign(Error('Managed fact observer failed'),{code:'FACT_OBSERVER_FAILED'}))).catch(()=>{})}catch{}}
    for(const event of suffix)for(const observer of [...(subscribers.get(view)??[])])try{Promise.resolve(observer(event)).catch(failed)}catch{failed()}
  }}
}
export { restoreManagedExecutionState,isManagedExecutionOwner } from './execution-state.ts'
export { readAcknowledgedExecutionMembers,retainAcknowledgedExecutionMembers } from './execution-members.ts'
