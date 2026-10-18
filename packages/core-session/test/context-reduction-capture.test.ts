import { expect, it } from 'vitest'
import { captureFactGroup, createNondurableFactOwner, createSession, append, deriveMessages, subscribe } from '../src/index.ts'

it.each(['metadata', 'legacy-rewrite', 'wrong-event', 'extra-seq', 'missing-field', 'bad-reset', 'bad-prune', 'kind-getter', 'events-getter', 'proxy', 'null'] as const)('dedicated nondurable capture rejects %s without effects or accessor execution', async kind => {
  const session=createSession();append(session,{type:'user/message',text:'history'})
  const action=createNondurableFactOwner(session).beginAction(),seen:unknown[]=[]
  let getters=0,guards=0
  const reset={type:'compaction/reset',removedSeqs:[0]}
  const draft:unknown=kind==='metadata'?{kind:'metadata',event:{type:'plan/mode',mode:'on'}}
    :kind==='legacy-rewrite'?{kind:'legacy-compaction',events:[reset]}
    :kind==='wrong-event'?{kind:'context-reduction',events:[{type:'plan/mode',mode:'on'}]}
    :kind==='extra-seq'?{kind:'context-reduction',events:[{...reset,seq:1}]}
    :kind==='missing-field'?{kind:'context-reduction',events:[{type:'compaction/reset'}]}
    :kind==='bad-reset'?{kind:'context-reduction',events:[{type:'compaction/reset',removedSeqs:'invalid'}]}
    :kind==='bad-prune'?{kind:'context-reduction',events:[{type:'compaction/prune',version:1,pruned:[{callId:'c',head:'h',tail:'t',removedBytes:'invalid'}]}]}
    :kind==='kind-getter'?{get kind(){getters++;return 'metadata'},event:{type:'plan/mode',mode:'on'}}
    :kind==='events-getter'?{kind:'context-reduction',get events(){getters++;return [reset]}}
    :kind==='proxy'?new Proxy({kind:'metadata',event:{type:'plan/mode',mode:'on'}},{get(){getters++;throw Error('proxy read')}}):null
  const descriptors=draft&&Object.getOwnPropertyDescriptors(draft)
  const unsubscribe=subscribe(session,event=>seen.push(event))
  try {
    const capture=action.captureContextReduction!(draft as never,()=>{guards++;return true})
    expect(await capture.admit()).toEqual({kind:'not-issued',code:'FACT_INVALID_GROUP'})
    expect(await capture.reconcile()).toEqual({kind:'not-issued',code:'FACT_INVALID_GROUP'})
    expect(await capture.observe()).toEqual({kind:'not-issued',code:'FACT_INVALID_GROUP'})
    expect(getters).toBe(0);expect(guards).toBe(0);expect(seen).toEqual([])
    expect(session.events).toEqual([{type:'user/message',text:'history',seq:0}])
    if(draft)expect(Object.getOwnPropertyDescriptors(draft)).toEqual(descriptors)
    expect(await action.facts.metadata.admit({type:'plan/mode',mode:'on'})).toEqual({kind:'memory-committed',durability:'nondurable',seqs:[1]})
    action.stop()
    expect(await action.captureContextReduction!({kind:'context-reduction',events:[{type:'compaction/reset',removedSeqs:[0]}]},()=>true).admit()).toEqual({kind:'not-issued',code:'FACT_CANCELLED'})
  } finally {unsubscribe();action.finish()}
})

it('admits only closed rewrite records through the dedicated family', () => {
  expect(captureFactGroup({ kind: 'context-reduction', events: [{ type: 'compaction/reset', removedSeqs: [] }] })).toMatchObject({ kind: 'captured' })
  expect(captureFactGroup({ kind: 'context-reduction', events: [{ type: 'session/title', title: 'arbitrary' }] } as any)).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
  expect(captureFactGroup({ kind: 'metadata', event: { type: 'compaction/reset', removedSeqs: [] } } as any)).toMatchObject({ kind: 'not-issued' })
  expect(captureFactGroup({ kind:'context-reduction', events:[{type:'compaction/reset',removedSeqs:[], metadata:'arbitrary'}] } as any)).toMatchObject({kind:'not-issued',code:'FACT_INVALID_GROUP'})
})
it('installs a nondurable closed group atomically before observers run', async () => {
  const session = createSession(), action = createNondurableFactOwner(session).beginAction(), seen: number[] = []
  append(session, { type: 'user/message', text: 'history' })
  subscribe(session, () => { seen.push(session.events.length) })
  const result = await action.captureContextReduction!({ kind: 'context-reduction', events: [
    { type: 'compaction/prune', version: 1, pruned: [] }, { type: 'compaction/reset', removedSeqs: [0] },
  ] }, () => true).admit()
  expect(result).toEqual({ kind: 'memory-committed', durability: 'nondurable', seqs: [1, 2] })
  expect(seen).toEqual([3, 3])
})
it('does not allocate or install a stale nondurable rewrite and returns a closed disposition', async () => {
  const session = createSession(); append(session, { type: 'user/message', text: 'history' })
  const action = createNondurableFactOwner(session).beginAction()
  let current = true
  const capture = action.captureContextReduction!({ kind: 'context-reduction', events: [{ type: 'compaction/reset', removedSeqs: [0] }] }, () => current)
  current = false
  expect(await capture.admit()).toEqual({ kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' })
  expect(session.events).toHaveLength(1)
  expect(deriveMessages(session).map(message => message.content)).toEqual(['history'])
  current = true
  expect(await capture.admit()).toEqual({ kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' })
})
