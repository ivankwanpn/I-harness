import { expect, it } from 'vitest'
import { checkpointOfLength } from './fixtures/checkpoint.ts'
import { createPreparedPayload, type ModelClient } from '@i-harness/llm-seam'
import { ProjectionCounter } from '@i-harness/token-meter'
import { summarizeFixture } from './fixtures/summary.ts'
import { createCompactionHarness } from './fixtures/engine.ts'
import { append, createSession } from '@i-harness/core-session'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
function model(corrupt: boolean | 'conflicting-end' = false): ModelClient {
  return { async *stream() { throw Error('unprepared') }, async prepare(request) {
    return createPreparedPayload({ request, textOutput: () => ({ status: 'allowed', reason: 'ordinary-text' }), body: { messages: request.messages }, describe(body) { const c = new ProjectionCounter('projected-pricing-v2'); c.structured('otherInput', body); return { input: c.finish({ protocol: 'fixture', modelId: 'm' }, body, {}), packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } } }, output: () => ({ capSupport: 'supported', effectiveCap: 64, minimumCap: 1, source: 'request' }), cap: b => b,
      async *execute(_b, _s, _c, execution) { execution.confirm(); yield { type: 'text/chunk', text: checkpointOfLength(500) }; yield { type: 'end', ...(corrupt === 'conflicting-end' ? { refused: true } : {}) }; if (corrupt === 'conflicting-end') yield { type: 'end' }; else if (corrupt) yield { type: 'text/chunk', text: 'corrupt after completion' } },
    })
  } }
}
it('records only an ephemeral piece observation after complete quality checks', async () => {
  const observations: any[] = []
  const result = await summarizeFixture(model(), 'recorded input', 128, undefined, undefined, 1, undefined, undefined, { maxOutputTokens: 64, onPieceAccepted: (o: any) => observations.push(o) } as any)
  expect(result.text).toBe(checkpointOfLength(500))
  expect(observations).toHaveLength(1)
  expect(observations[0]).toMatchObject({ kind: 'summary-piece-accepted', purpose: 'summary', origin: 'piece', receipt: { candidateId: expect.any(String), sendId: expect.any(String) } })
  expect(JSON.stringify(observations)).not.toMatch(/exchange-accepted|acceptedSeq|anchorId/)
})
it('keeps accepted piece observation while an actual issued managed frame remains uncertain', async () => {
  const root=await mkdtemp(join(tmpdir(),'ih-c3-piece-')),backend=createJsonlBackend(root),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}})
  const {id}=await coordinator.create(),session=createSession();append(session,{type:'user/message',text:'recorded completed work '.repeat(100)})
  await coordinator.append(id,session.events);const document=await coordinator.openManagedDocument(id),observations:unknown[]=[]
  const actual=backend.appendOwnedBatch!;backend.appendOwnedBatch=async(...args)=>{await actual(...args);return{kind:'unknown',key:args[3].key}}
  try{
    const result=await createCompactionHarness({model:model(),factOwner:document,config:{contextWindow:100000,prune:false,summaryMaxOutputTokens:64},telemetry:{emit(e){if(e.type==='provider/context'&&e.data.operation==='summary-piece-accepted')observations.push(e.data)},close(){}}}).compact(document.view)
    expect(result).toMatchObject({compacted:false,outcome:'blocked',publication:'recovery-required'})
    expect(observations).toHaveLength(1)
    expect(document.view.events.some(e=>e.type==='model/exchange-accepted'||e.type==='context/usage'||e.type==='compaction/replacement')).toBe(false)
    expect(()=>document.assertReady()).toThrow(expect.objectContaining({code:'FACT_RECOVERY_REQUIRED'}))
  }finally{await coordinator.close()}
})
it('does not accept post-end corruption as a complete piece', async () => {
  const accepted: unknown[] = []
  await expect(summarizeFixture(model(true), 'input', 128, undefined, undefined, 1, undefined, undefined, { maxOutputTokens: 64, onPieceAccepted: (o: unknown) => accepted.push(o) } as any)).rejects.toThrow(/completion/)
  expect(accepted).toEqual([])
})
it('cannot clear an earlier refused completion with a contradictory clean end', async () => {
  const accepted: unknown[] = []
  await expect(summarizeFixture(model('conflicting-end'), 'input', 128, undefined, undefined, 1, undefined, undefined, { maxOutputTokens: 64, onPieceAccepted: o => accepted.push(o) })).rejects.toThrow(/completion/)
  expect(accepted).toEqual([])
})
