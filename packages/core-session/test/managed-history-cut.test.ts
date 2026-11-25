import {expect,it} from 'vitest'
import {createManagedSessionState,createManagedIndexedView,captureManagedHistoryCut,assertManagedHistoryCut} from '../src/managed/view.ts'
import {createConversationIndex} from '../src/conversation/validation.ts'
import {projectConversation} from '../src/conversation/project.ts'
import {readConversationState} from '../src/conversation/state.ts'
import {readManagedConversationAuditAdvance,readManagedConversationFrontier,readManagedConversationObservationFrontier} from '../src/restoration-internal.ts'
import {CURRENT_FORMAT_VERSION,type Session,type SessionEvent} from '../src/events/types.ts'

it('the original immutable factory retains an append-tolerant nominal cut without source replay',()=>{
  const input:Session={formatVersion:14,events:[{type:'turn/start',seq:0},{type:'user/message',text:'original',seq:1},{type:'turn/end',seq:2}]}
  const state=createManagedSessionState(input,{sessionId:'source'}),owner={}
  state.bindOwner(owner)
  const cut=captureManagedHistoryCut(state.view,owner,'source')
  expect(()=>assertManagedHistoryCut({...cut},state.view,owner,'source')).toThrow()
  expect(()=>assertManagedHistoryCut(cut,state.view,{},'source')).toThrow()
  expect(()=>assertManagedHistoryCut(cut,state.view,owner,'foreign')).toThrow()
  const replacement=createManagedSessionState(input,{sessionId:'source'});replacement.bindOwner(owner)
  expect(()=>assertManagedHistoryCut(cut,replacement.view,owner,'source')).toThrow()
  expect(()=>captureManagedHistoryCut({...state.view},owner,'source')).toThrow()
  ;(input.events[1] as {text:string}).text='changed external source'
  expect(state.view.events[1]).toMatchObject({text:'original'})
  expect(()=>{(state.view.events[1] as {text:string}).text='changed frozen fact'}).toThrow()
  expect(()=>{(state.view.events as unknown[])[1]={}}).toThrow()
  const suffix:Session['events']=[{type:'turn/start',seq:3}]
  state.stage(suffix).install();suffix[0]={type:'turn/end',seq:3}
  expect(state.view.events[3]?.type).toBe('turn/start')
  assertManagedHistoryCut(cut,state.view,owner,'source')
  expect(()=>state.bindOwner({})).toThrow()
  assertManagedHistoryCut(cut,state.view,owner,'source')
})

it('never installs a replaced pushed deleted or retained-alias stage row',()=>{
  const state=createManagedSessionState({formatVersion:14,events:[]} as Session,{sessionId:'source'}),owner={}
  state.bindOwner(owner)
  const cut=captureManagedHistoryCut(state.view,owner,'source')
  const input:Session['events']=[{type:'turn/start',seq:0}]
  const staged=state.stage(input),exposed=staged.events as Session['events']
  expect(()=>Object.defineProperty(staged,'events',{value:[{type:'user/message',text:'rebound array',seq:0}]})).toThrow()
  expect(()=>{exposed[0]={type:'user/message',text:'unvalidated',seq:0}}).toThrow()
  expect(()=>exposed.push({type:'turn/end',seq:1})).toThrow()
  expect(()=>{delete exposed[0]}).toThrow()
  expect(()=>{(exposed[0] as {type:string}).type='turn/end'}).toThrow()
  input[0]={type:'user/message',text:'retained input alias',seq:0}
  staged.install();staged.install()
  expect(state.view.events).toEqual([{type:'turn/start',seq:0}])
  assertManagedHistoryCut(cut,state.view,owner,'source')
})

it('reads only the bound original immutable view frontier at the installed revision', () => {
  const source: Session = {formatVersion:14,events:[{type:'turn/start',seq:0}]}
  const state = createManagedSessionState(source,{sessionId:'source'}), owner = {}
  expect(readManagedConversationFrontier(state.view,'source')).toBeUndefined()
  state.bindOwner(owner)

  expect(readManagedConversationFrontier(state.view,'source')).toBe(1)
  expect(readManagedConversationFrontier(state.view,'other')).toBeUndefined()
  expect(readManagedConversationFrontier(Object.freeze({...state.view}),'source')).toBeUndefined()
  expect(readManagedConversationFrontier(source,'source')).toBeUndefined()
  source.events[0] = {type:'assistant/message',seq:0,text:'same-length replacement'}
  expect(readManagedConversationFrontier(source,'source')).toBeUndefined()

  const compatibility = createManagedIndexedView(state.view.events,14,state.view.header,
    createConversationIndex(state.view.events),owner,'source')
  expect(readManagedConversationFrontier(compatibility.view,'source')).toBeUndefined()
  expect(readManagedConversationAuditAdvance(compatibility.view,'source',0)).toBeUndefined()

  const staged = state.stage([{type:'turn/end',seq:1}])
  expect(readManagedConversationFrontier(state.view,'source')).toBe(1)
  staged.install()
  expect(readManagedConversationFrontier(state.view,'source')).toBe(2)
})

const digest = 'a'.repeat(64)
function budget(seq: number, ownerSessionId = 'source'): SessionEvent {
  return { type: 'context/budget', version: 2, seq, snapshot: {
    version: 2, ownerSessionId, modelId: 'model', protocol: 'custom', bindingFingerprint: digest, bindingRevision: 0, projectionRevision: 0,
    neutralFingerprint: digest, identityCoverage: 'partial', purpose: 'main', estimate: { kind: 'unknown', reason: 'unconfigured' },
    disposition: 'compatibility', dimensions: [{ dimension: 'context', state: 'unchecked' }], pressure: { kind: 'unavailable', reason: 'unconfigured' },
    components: { kind: 'estimated', source: 'projected-heuristic', user: 2, assistant: 0, tool: 0, system: 3, schema: 0, reasoning: 0 },
    output: { capSupport: 'unknown', minimumCap: 1 }, recoveryRequired: false, fullByProvider: false, freshness: 'current',
    requestContext: { version: 1, semanticRevision: digest, protectionRevision: digest, branchId: digest, contextEpoch: digest, surfaceRevision: digest },
  } }
}

it('advances only the raw archive for original bind, budget and reservation bookkeeping', () => {
  const generation = { version: 1, ownerSessionId: 'source', actionId: 'generation', trustedAt: 100 } as const
  const state = createManagedSessionState({ formatVersion: CURRENT_FORMAT_VERSION, events: [
    { type: 'user/message', seq: 0, text: 'original request',
      provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } },
    { ...generation, type: 'context/action', seq: 1, op: 'open', purpose: 'main',
      origin: { kind: 'input', seq: 0 }, startedAt: 100, expiresAt: 3_600_100 },
  ] }, { sessionId: 'source' })
  state.bindOwner({})
  const projected = projectConversation(state.view, { ownerSessionId: 'source' })
  const before = readConversationState(state.view, projected)
  if (before.kind !== 'available') throw new Error('Expected original conversation state')
  const next = state.stage([
    { ...generation, type: 'context/action', seq: 2, op: 'bind', executionDomain: 'physical',
      retry: { mode: 'normal', maxRetries: 5 }, limits: { total: 20, main: 6, recovery: 6, summary: 8 } },
    budget(3),
    { ...generation, type: 'context/attempt', seq: 4, op: 'reserve', attemptId: 'attempt', ordinal: 1, lane: 'main',
      cause: 'initial', incarnation: 'owner-1', semanticId: digest, payloadId: digest, payloadKind: 'http-json-body' },
  ])
  expect(readManagedConversationAuditAdvance(state.view, 'source', 2)).toBeUndefined()
  next.install()
  const advance = readManagedConversationAuditAdvance(state.view, 'source', 2)
  expect(advance).toEqual({ eventCount: 5, lastSeq: 4 })
  expect(readManagedConversationObservationFrontier(state.view, 'source')).toBe(5)
  const encode = TextEncoder.prototype.encode
  try {
    TextEncoder.prototype.encode = new Proxy<typeof encode>(encode, { apply: Reflect.apply })
    expect(readManagedConversationFrontier(state.view, 'source')).toBe(5)
    expect(readManagedConversationObservationFrontier(state.view, 'source')).toBeUndefined()
    expect(readManagedConversationAuditAdvance(state.view, 'source', 2)).toBeUndefined()
  } finally { TextEncoder.prototype.encode = encode }
  expect(readManagedConversationAuditAdvance(state.view, 'source', 1)).toBeUndefined()
  expect(readManagedConversationAuditAdvance(state.view, 'different-source', 2)).toBeUndefined()
  for (const frontier of [-1, 1.5, 5, 6]) expect(readManagedConversationAuditAdvance(state.view, 'source', frontier)).toBeUndefined()

  const afterProjection = projectConversation(state.view, { ownerSessionId: 'source' })
  expect(afterProjection.items).toEqual(projected.items)
  expect(afterProjection.current).toEqual(projected.current)
  expect(readConversationState(state.view, afterProjection)).toEqual({ kind: 'available', state: { ...before.state, archive: advance } })

  state.stage([{ ...generation, type: 'context/attempt', seq: 5, op: 'settle', attemptId: 'attempt', disposition: 'unsent' }]).install()
  expect(readManagedConversationAuditAdvance(state.view, 'source', 5)).toBeUndefined()
  state.stage([budget(6, 'different-source')]).install()
  expect(readManagedConversationAuditAdvance(state.view, 'source', 6)).toBeUndefined()
})

it('declines an ordinal-shaped append when the original prefix has a colliding sequence', () => {
  const state = createManagedSessionState({ formatVersion: CURRENT_FORMAT_VERSION, events: [
    { type: 'user/message', seq: 1, text: 'legacy address' },
  ] }, { sessionId: 'source' })
  state.bindOwner({})
  state.stage([budget(1)]).install()
  expect(readManagedConversationFrontier(state.view, 'source')).toBe(2)
  expect(readManagedConversationObservationFrontier(state.view, 'source')).toBeUndefined()
  expect(readManagedConversationAuditAdvance(state.view, 'source', 1)).toBeUndefined()
})
