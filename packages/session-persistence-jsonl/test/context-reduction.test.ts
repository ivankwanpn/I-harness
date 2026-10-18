import { expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlBackend } from '../src/index.ts'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { captureContextSnapshot, reductionGroups, reductionSourceCurrent, replacementProposal } from '../../context-engine/src/index.ts'
import { deriveMessages, type SessionEvent, type SessionView } from '@i-harness/core-session'

const seed: SessionEvent[] = [
  { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, text: 'H' },
  { type: 'step/start', seq: 2 }, { type: 'assistant/message', seq: 3, text: 'E1' }, { type: 'step/end', seq: 4 },
  { type: 'step/start', seq: 5 }, { type: 'assistant/message', seq: 6, text: 'tail' }, { type: 'step/end', seq: 7 },
]
function snapshot(session: SessionView) {
  const value = captureContextSnapshot(session, { ownerSessionId: 'owner', surface: { systemPrompt: '', tools: [] } })
  if (value.kind !== 'captured') throw Error('capture required')
  return value.snapshot
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ih-c3-fence-')), backend = createJsonlBackend(directory)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  await coordinator.append(id, seed)
  const document = await coordinator.openManagedDocument(id)
  return { directory, backend, coordinator, id, document }
}
it('runs a final source fence after backend awaits with no issued batch or visible rewrite', async () => {
  const f = await fixture(), action = f.document.beginAction(), source = snapshot(f.document.view)
  const groups = reductionGroups(source).filter(group => group.items.some(item => item.messages.some(message => message.content === 'E1')))
  let current = true, writes = 0
  const actual = f.backend.appendOwnedBatch!
  f.backend.appendOwnedBatch = async (...args) => { current = false; writes++; return actual(...args) }
  const prior = await readFile(join(f.directory, `${f.id}.jsonl`), 'utf8')
  const eventCount = f.document.view.events.length
  try {
    const capture = action.captureContextReduction!({ kind: 'context-reduction', events: [replacementProposal({ id: 'r', groups }, 'S', 'r')] }, () => current)
    expect(await capture.admit()).toEqual({ kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' })
    expect(writes).toBe(1); expect(f.document.view.events).toHaveLength(eventCount)
    expect(await readFile(join(f.directory, `${f.id}.jsonl`), 'utf8')).toBe(prior)
    expect(await capture.reconcile()).toEqual({ kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' })
    expect(writes).toBe(1)
  } finally { action.finish(); await f.coordinator.close() }
})
it.each(['feedback', 'metadata'] as const)('installs earlier %s before the guard and keeps captures out of ordinary coalescing', async kind => {
  const f = await fixture(), action = f.document.beginAction(), source = snapshot(f.document.view)
  const groups = reductionGroups(source).filter(group => group.items.some(item => item.messages.some(message => message.content === 'E1')))
  const frames: number[] = [], actual = f.backend.appendOwnedBatch!
  f.backend.appendOwnedBatch = async (...args) => { frames.push(args[3].key.count); return actual(...args) }
  try {
    const earlier = kind === 'metadata' ? action.facts.metadata.admit({ type: 'session/title', title: 'compatible',messageSeqs:[],source:'user' })
      : action.facts.agent.feedback({ type: 'user/message', text: 'new observed feedback', source: { kind: 'plugin', plugin: 'fixture' } })
    const capture = action.captureContextReduction!({ kind: 'context-reduction', events: [replacementProposal({ id: 'r', groups }, 'S', 'r')] }, () => {
      const now = snapshot(f.document.view)
      return reductionSourceCurrent(source, groups, now) && (kind === 'metadata' || source.coordinates.semanticRevision === now.coordinates.semanticRevision)
    })
    const rewrite = capture.admit(), later = action.facts.metadata.admit({ type: 'session/title', title: 'later',messageSeqs:[],source:'user' })
    expect((await earlier).kind).toBe('committed')
    expect(await rewrite).toMatchObject(kind === 'metadata' ? { kind: 'committed' } : { kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' })
    expect((await later).kind).toBe('committed')
    expect(frames).toEqual(kind === 'metadata' ? [1, 1, 1] : [1, 1])
    expect(deriveMessages(f.document.view).map(message => message.content)).toContain(kind === 'metadata' ? 'S' : 'E1')
    const cold = await f.backend.read(f.id)
    expect(deriveMessages({formatVersion:cold.version,events:cold.events}).map(message => message.content)).toEqual(deriveMessages(f.document.view).map(message => message.content))
  } finally { action.finish(); await f.coordinator.close() }
})
it('two captures from one action have distinct physical frames and the second sees the first installed',async()=>{
 const f=await fixture(),action=f.document.beginAction(),source=snapshot(f.document.view),groups=reductionGroups(source),frames:number[]=[]
 const actual=f.backend.appendOwnedBatch!;f.backend.appendOwnedBatch=async(...args)=>{frames.push(args[3].key.count);return actual(...args)}
 const selected=(label:string)=>groups.filter(group=>group.items.some(item=>item.messages.some(message=>message.content===label)))
 try{
  const first=action.captureContextReduction!({kind:'context-reduction',events:[replacementProposal({id:'first',groups:selected('E1')},'S1','first')]},()=>true)
  const second=action.captureContextReduction!({kind:'context-reduction',events:[replacementProposal({id:'second',groups:selected('tail')},'S2','second')]},()=>f.document.view.events.some(event=>event.type==='compaction/replacement'&&event.replacementId==='first'))
  const outcomes=await Promise.all([first.admit(),second.admit()])
  expect(outcomes.map(value=>value.kind)).toEqual(['committed','committed']);expect(frames).toEqual([1,1])
  if(outcomes[0]?.kind!=='committed'||outcomes[1]?.kind!=='committed')throw Error('receipts required')
  expect(outcomes[0].receipt.key.batchId).not.toBe(outcomes[1].receipt.key.batchId)
  expect(deriveMessages(f.document.view).map(message=>message.content)).toEqual(['H','S1','S2'])
 }finally{action.finish();await f.coordinator.close()}
})
it('the first guarded admission stays before subsequently queued semantic feedback', async () => {
  const f = await fixture(), action = f.document.beginAction(), source = snapshot(f.document.view)
  const groups = reductionGroups(source).filter(group => group.items.some(item => item.messages.some(message => message.content === 'E1')))
  const frames: string[][] = [], actual = f.backend.appendOwnedBatch!
  f.backend.appendOwnedBatch = async (...args) => {
    frames.push(JSON.parse(new TextDecoder().decode(args[3].bytes).trim()).events?.map((event: SessionEvent) => event.type) ?? [])
    return actual(...args)
  }
  try {
    const capture = action.captureContextReduction!({ kind: 'context-reduction', events: [replacementProposal({ id: 'first', groups }, 'S', 'first')] },
      () => snapshot(f.document.view).coordinates.semanticRevision === source.coordinates.semanticRevision)
    const rewrite = capture.admit()
    const later = action.facts.agent.feedback({ type: 'user/message', text: 'later observed suffix', source: { kind: 'plugin', plugin: 'fixture' } })
    expect(await rewrite).toMatchObject({ kind: 'committed' })
    expect(await later).toMatchObject({ kind: 'committed' })
    expect(f.document.view.events.slice(-2).map(event => event.type)).toEqual(['compaction/replacement', 'user/message'])
    expect(deriveMessages(f.document.view).map(message => message.content)).toEqual(['H', 'S', 'tail', 'later observed suffix'])
    expect(frames).toHaveLength(2)
  } finally { action.finish(); await f.coordinator.close() }
})
it('Stop after issue installs the known receipt while preventing all later optional work',async()=>{
 const f=await fixture(),action=f.document.beginAction(),source=snapshot(f.document.view),groups=reductionGroups(source).filter(group=>group.items.some(item=>item.messages.some(message=>message.content==='E1')))
 const actual=f.backend.appendOwnedBatch!;let writes=0
 f.backend.appendOwnedBatch=async(...args)=>{writes++;const outcome=await actual(...args);action.stop();return outcome}
 try{
  const capture=action.captureContextReduction!({kind:'context-reduction',events:[replacementProposal({id:'issued',groups},'S','issued')]},()=>true)
  expect(await capture.admit()).toMatchObject({kind:'committed'})
  expect(await capture.reconcile()).toMatchObject({kind:'committed'})
  expect(await action.facts.metadata.admit({type:'plan/mode',mode:'on'})).toEqual({kind:'not-issued',code:'FACT_CANCELLED'})
  expect(writes).toBe(1);expect(deriveMessages(f.document.view).map(message=>message.content)).toEqual(['H','S','tail'])
  expect('retryAbsent' in capture).toBe(false)
 }finally{action.finish();await f.coordinator.close()}
})
it('an issued uncertain rewrite reconciles exactly once after Stop without duplicate replacement allocation',async()=>{
 const f=await fixture(),action=f.document.beginAction(),source=snapshot(f.document.view),groups=reductionGroups(source).filter(group=>group.items.some(item=>item.messages.some(message=>message.content==='E1')))
 const actual=f.backend.appendOwnedBatch!;let writes=0
 f.backend.appendOwnedBatch=async(...args)=>{writes++;await actual(...args);action.stop();return{kind:'unknown',key:args[3].key}}
 try{
  const capture=action.captureContextReduction!({kind:'context-reduction',events:[replacementProposal({id:'uncertain',groups},'S','uncertain')]},()=>true)
  expect(await capture.admit()).toMatchObject({kind:'unknown'})
  expect(()=>f.document.assertReady()).toThrow()
  expect(await capture.reconcile()).toMatchObject({kind:'committed'})
  expect(await capture.admit()).toMatchObject({kind:'committed'})
  expect(f.document.view.events.filter(event=>event.type==='compaction/replacement')).toHaveLength(1);expect(writes).toBe(1)
 }finally{action.finish();await f.coordinator.close()}
})
