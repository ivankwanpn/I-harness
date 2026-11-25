import { types } from 'node:util'
import { validateDeliveryFrame } from '../conversation/delivery.ts'
import { CURRENT_FORMAT_VERSION, type Session, type SessionEvent } from '../events/types.ts'
import { createConversationIndex, createBootstrapConversationIndex, readConversationDeliveries, readConversationGenerations, conversationScopeKey, type ConversationValidationIndex } from '../conversation/validation.ts'
import { managedSessions, managedFactOwners, subscribers } from '../events/state.ts'
import { captureLegacyFact, freezeJsonData } from './capture.ts'
import type { SessionView } from './types.ts'
import { prepareSessionEvent } from '../events/intake.ts'
import { createManagedIntakeIndex } from './intake-index.ts'
const originalIndexes = new WeakMap<SessionView, ConversationValidationIndex>()
const originalSourceSessions = new WeakMap<SessionView, string | undefined>()
// Only managedSessionState enrolls: its initial copy and every appended row
// are immutable. Other view factories must qualify their own invariants.
const immutableFactories = new WeakMap<SessionView, {index:ConversationValidationIndex;assertFrontier(count:number):void;hasContiguousSeq():boolean;hasProjectionProof():boolean}>()
const { parse: originalParse, stringify: originalStringify } = JSON
const originalObjectPrototype = Object.prototype, originalArrayPrototype = Array.prototype

function originalProjectionEnvironment() {
  return Object.getOwnPropertyDescriptor(JSON, 'parse')?.value === originalParse
    && Object.getOwnPropertyDescriptor(JSON, 'stringify')?.value === originalStringify
    && Object.getPrototypeOf(originalObjectPrototype) === null
    && Object.getPrototypeOf(originalArrayPrototype) === originalObjectPrototype
    && !Object.hasOwn(originalObjectPrototype, 'toJSON') && !Object.hasOwn(originalArrayPrototype, 'toJSON')
}

function ordinaryProjectionHeader(header: SessionView['header']) {
  return header?.semanticSeed === undefined && header?.parentSession === undefined && header?.seedLength === undefined
    && header?.forkPublication === undefined && header?.origin !== 'fork'
}

/** Direct staging also supports legacy payloads. A frozen caller-owned parent
 * alone cannot prove its descendants are frozen data for a later observation. */
function isImmutableProjectionData(value: unknown): boolean {
  const pending = [value], seen = new Set<object>()
  while (pending.length) {
    const node = pending.pop()
    if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number' && Number.isFinite(node)) continue
    if (typeof node !== 'object' || types.isProxy(node) || !Object.isFrozen(node)) return false
    if (seen.has(node)) return false
    seen.add(node)
    const prototype = Object.getPrototypeOf(node)
    if (Array.isArray(node) ? prototype !== originalArrayPrototype : prototype !== originalObjectPrototype && prototype !== null) return false
    const fields = Object.getOwnPropertyDescriptors(node)
    for (const key of Reflect.ownKeys(fields)) {
      if (typeof key !== 'string') return false
      const field = fields[key]!
      if (!('value' in field)) return false
      pending.push(field.value)
    }
  }
  return true
}

function immutableFactoryFor(view: SessionView, sessionId: string) {
  const factory = immutableFactories.get(view)
  if (factory && managedFactOwners.has(view) && originalSourceSessions.get(view) === sessionId && originalIndexes.get(view) === factory.index) return factory
}

/** Exact installed frontier for this view and session. Passive data identity
 * only. Callers still verify current work admission independently. */
export function readManagedConversationFrontier(view: SessionView, sessionId: string): number | undefined {
  const factory = immutableFactoryFor(view, sessionId)
  if (!factory) return undefined
  const count = factory.index.eventCount
  factory.assertFrontier(count)
  return count
}

/** Advance archive coordinates only across installed bookkeeping facts.
 * Original admission, recovery and request-surface checks remain live. */
export function readManagedConversationAuditAdvance(view: SessionView, ownerSessionId: string, fromFrontier: number): {
  eventCount: number; lastSeq?: number
} | undefined {
  if (!Number.isSafeInteger(fromFrontier) || fromFrontier < 0) return undefined
  const factory = immutableFactoryFor(view, ownerSessionId)
  if (!factory || view.formatVersion !== CURRENT_FORMAT_VERSION || !factory.hasContiguousSeq()) return undefined
  const eventCount = factory.index.eventCount
  if (eventCount <= fromFrontier) return undefined
  factory.assertFrontier(eventCount)
  for (let ordinal = fromFrontier; ordinal < eventCount; ordinal++) {
    const event = view.events[ordinal]
    if (!event || event.seq !== ordinal) return undefined
    if (event.type === 'context/budget' && event.version === 2 && event.snapshot.ownerSessionId === ownerSessionId) continue
    if (event.type === 'context/action' && event.version === 1 && event.op === 'bind' && event.ownerSessionId === ownerSessionId) continue
    if (event.type === 'context/attempt' && event.version === 1 && event.op === 'reserve' && event.ownerSessionId === ownerSessionId) continue
    return undefined
  }
  if (immutableFactoryFor(view, ownerSessionId) !== factory || factory.index.eventCount !== eventCount) return undefined
  factory.assertFrontier(eventCount)
  return Object.freeze({ eventCount, lastSeq: eventCount - 1 })
}

/** Read only the original ordinary factory's logical history at its installed
 * frontier. The caller renders through the same view and rechecks before use. */
export function readManagedProjectionHistory(view: SessionView, ownerSessionId: string) {
  const factory = immutableFactoryFor(view, ownerSessionId)
  if (!factory?.hasProjectionProof() || !factory.hasContiguousSeq() || !originalProjectionEnvironment()) return undefined
  const count = factory.index.eventCount
  const assertCurrent = () => {
    if (immutableFactoryFor(view, ownerSessionId) !== factory || factory.index.eventCount !== count
        || !factory.hasProjectionProof() || !originalProjectionEnvironment()) throw new TypeError('Original managed projection changed')
    factory.assertFrontier(count)
  }
  assertCurrent()
  const history = factory.index.history()
  assertCurrent()
  return { history, assertCurrent }
}

export interface ManagedHistoryCut {readonly kind:'original-managed-history-cut'}
const historyCuts = new WeakMap<ManagedHistoryCut,{view:SessionView;owner:object;sessionId:string;factory:NonNullable<ReturnType<typeof immutableFactories.get>>;count:number}>()
export function captureManagedHistoryCut(view:SessionView,owner:object,sessionId:string):ManagedHistoryCut {
  const factory=immutableFactoryFor(view,sessionId)
  if(!factory||managedFactOwners.get(view)!==owner)throw TypeError('Original immutable history source required')
  const count=factory.index.eventCount;factory.assertFrontier(count)
  const cut=Object.freeze({kind:'original-managed-history-cut' as const})
  historyCuts.set(cut,{view,owner,sessionId,factory,count});return cut
}
/** Passive prefix identity only. Original caller admission remains separate. */
export function assertManagedHistoryCut(cut:ManagedHistoryCut,view:SessionView,owner:object,sessionId:string):void {
  const original=historyCuts.get(cut)
  if(!original||original.view!==view||original.owner!==owner||original.sessionId!==sessionId||immutableFactoryFor(view,sessionId)!==original.factory||managedFactOwners.get(view)!==owner)throw TypeError('Original immutable history cut required')
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
  // A repeated sequence could change the addressability of an earlier fact.
  let contiguousSeq = events.every((event, ordinal) => event.seq === ordinal)
  const formatVersion = source.formatVersion, indexHeader = { ...source.header, ...scope }
  let projectionProof = createIndex === createConversationIndex && formatVersion === CURRENT_FORMAT_VERSION
    && ordinaryProjectionHeader(indexHeader) && ordinaryProjectionHeader(captured.value.header)
    && (!captured.value.header || !Object.hasOwn(captured.value.header, 'sessionId'))
    && originalProjectionEnvironment() && isImmutableProjectionData(captured.value)
  const index = createIndex(events, position => events[position], formatVersion, indexHeader)
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
  const sessionId = scope?.sessionId
  projectionProof &&= view.formatVersion === formatVersion && typeof sessionId === 'string'
    && indexHeader.sessionId === sessionId && originalProjectionEnvironment()
  managedSessions.add(view)
  originalIndexes.set(view, index)
  originalSourceSessions.set(view, sessionId)
  immutableFactories.set(view,{index,hasContiguousSeq:()=>contiguousSeq,hasProjectionProof:()=>projectionProof,assertFrontier(count){
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
      const inputs=intake.stage(prepared)
      validateDeliveryFrame(prepared, view.formatVersion)
      const suffixProof = projectionProof && originalProjectionEnvironment() && prepared.every(isImmutableProjectionData)
      const staged = index.stage(prepared)
      const verifiedSuffix = suffixProof && originalProjectionEnvironment()
      // Keep the validated installation array private and immutable. Exposing
      // it allowed a caller to substitute a row after index validation.
      Object.freeze(prepared)
      const exposed = Object.freeze([...prepared])
      let installed = false
      return Object.freeze({ events: exposed, install() {
        if (installed) return
        // stage is non-mutating. Both operations below are synchronous and use
        // only owned data; observers are explicitly outside this capability.
        staged.commit()
        for (const event of prepared) {
          contiguousSeq &&= event.seq === events.length
          events.push(event)
        }
        inputs.commit()
        projectionProof &&= verifiedSuffix
        installed = true
      } })
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
