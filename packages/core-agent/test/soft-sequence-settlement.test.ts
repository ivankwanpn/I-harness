import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createConversationValidationIndex, type SettlementFacts, type ProducerFactOutcome } from '@i-harness/core-session'
import { beginSoftSequence } from '../src/agent/context-reduction/sequence.ts'
import { createReductionPublication } from '../src/agent/context-reduction/publication.ts'
import { captureContextSnapshot } from '@i-harness/context-engine'

it.each(['committed', 'absent'] as const)('the original source settles an uncertain start after Stop without granting summary (%s)', async disposition => {
  const directory = await mkdtemp(join(tmpdir(), 'ih-soft-start-')), backend = createJsonlBackend(directory), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), action = document.beginAction(), sources: SettlementFacts<ProducerFactOutcome>[] = []
  const original = backend.appendOwnedBatch!, d = 'a'.repeat(64)
  let writes = 0
  backend.appendOwnedBatch = async (...args) => {
    if (++writes === 1) { if (disposition === 'committed') await original(...args); action.stop(); return { kind: 'unknown', key: args[3].key } }
    return original(...args)
  }
  try {
    await expect(beginSoftSequence({ session: document.view, captureSoftReduction: action.captureSoftReduction.bind(action), registerFactSource: drain => { const source = action.registerSettlementSource(drain); sources.push(source); return source } },
      { type: 'context/soft-reduction', version: 1, op: 'start', ownerSessionId: id, sequenceId: 'sequence', workKey: d, sourceKey: d, protectionKey: d, policyKey: d, acceptedExchanges: 0, humanTurns: 0 }, () => true)).rejects.toMatchObject({ code: expect.stringMatching(/^FACT_/) })
    expect(sources).toHaveLength(1)
    await sources[0]!.close()
    const state = createConversationValidationIndex(document.view.events, { formatVersion: document.view.formatVersion, header: document.view.header }).softReduction(id)
    expect(state).toMatchObject({ pending: false, failures: 0, breaker: 'closed' })
    expect(document.view.events.filter(event => event.type === 'context/soft-reduction')).toHaveLength(disposition === 'committed' ? 2 : 0)
    if (disposition === 'committed') expect(document.view.events.at(-1)).toMatchObject({ op: 'terminal', outcome: 'canceled', publication: 'none' })
    expect(document.view.events.some(event => event.type === 'context/attempt' || event.type === 'context/action')).toBe(false)
    expect(writes).toBe(disposition === 'committed' ? 2 : 1)
  } finally { action.finish(); await coordinator.close() }
})
it('publication absence after Stop settles the original start without a second optional write or a ready reset', async()=>{
 const root=await mkdtemp(join(tmpdir(),'ih-soft-publication-')),backend=createJsonlBackend(root),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}}),{id}=await coordinator.create(),document=await coordinator.openManagedDocument(id),action=document.beginAction(),sources:SettlementFacts<ProducerFactOutcome>[]=[]
 const registerFactSource=(drain:()=>Promise<void>)=>{const source=action.registerSettlementSource(drain);sources.push(source);return source},d='a'.repeat(64)
 const deps={session:document.view,captureSoftReduction:action.captureSoftReduction.bind(action),captureContextReduction:action.captureContextReduction!.bind(action),registerFactSource}
 try{
  const sequence=await beginSoftSequence(deps,{type:'context/soft-reduction',version:1,op:'start',ownerSessionId:id,sequenceId:'original',workKey:d,sourceKey:d,protectionKey:d,policyKey:d,acceptedExchanges:0,humanTurns:0},()=>true)
  const captured=captureContextSnapshot(document.view,{ownerSessionId:id,surface:{systemPrompt:'',tools:[]}});if(captured.kind!=='captured')throw Error('capture required')
  const publish=createReductionPublication(deps,()=>true,()=>({type:'context/soft-reduction',version:1,op:'terminal',ownerSessionId:id,sequenceId:'original',startSeq:{kind:'prior',seq:sequence.start.seq!,expectedType:'context/soft-reduction'},workKey:d,sourceKey:d,outcome:'target-ready',publication:'committed',consumedBeforeKey:d,consumedAfterKey:'b'.repeat(64)}),()=>sequence.settle('canceled'))
  const actual=backend.appendOwnedBatch!;let writes=0
  backend.appendOwnedBatch=async(...args)=>{if(++writes===1){action.stop();return{kind:'unknown',key:args[3].key}}return actual(...args)}
  expect(await publish(captured.snapshot,[],[{type:'compaction/prune',version:1,pruned:[]}],{})).toEqual({kind:'recovery-required'})
  await Promise.allSettled(sources.map(source=>source.close()))
  expect(await Promise.allSettled(sources.map(source=>source.close()))).toEqual(sources.map(()=>({status:'fulfilled',value:undefined})))
  const state=createConversationValidationIndex(document.view.events,{formatVersion:document.view.formatVersion,header:document.view.header}).softReduction(id)
  expect(state).toMatchObject({pending:false,failures:0});expect(state.consumed.has('b'.repeat(64))).toBe(false)
  expect(document.view.events.at(-1)).toMatchObject({type:'context/soft-reduction',op:'terminal',outcome:'canceled',publication:'none'})
  expect(document.view.events.some(event=>event.type==='compaction/prune')).toBe(false);expect(writes).toBe(2)
 }finally{action.finish();await coordinator.close()}
})
