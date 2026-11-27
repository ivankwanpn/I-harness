import {afterEach,expect,it,vi} from 'vitest'
import {ProjectionCounter} from '@i-harness/token-meter'
import {createGenerationControl,createPreparedHttpPayload,prepareModelRequest,preparedModelClient,type LLMRequest,type LLMStreamEvent} from '../src/index.ts'
import {registerOriginalPassiveClient,registerOriginalPassiveReservation,withOriginalPassiveClientAttribution,type PassiveProducerRecord} from '../src/prepared/passive-observation.ts'
afterEach(()=>vi.unstubAllGlobals())

const attribution = { providerId: 'p', modelId: 'm', workspace: 'w', billing: 'api' } as const

function prepareHttpFixture(request: LLMRequest, events: LLMStreamEvent[], prompt?: string) {
  return createPreparedHttpPayload({
    body: { cap: 10, ...(prompt === undefined ? {} : { prompt }) }, request,
    describe(body) {
      const counter = new ProjectionCounter('projected-pricing-v2')
      counter.structured('otherInput', body)
      return { input: counter.finish({ protocol: 'test', modelId: 'm' }, body, body), packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } }
    },
    output: body => ({ capSupport: 'supported', effectiveCap: body.cap, minimumCap: 1, source: 'request' }),
    cap: (body, cap) => ({ ...body, cap: cap ?? 10 }),
    transport: { label: 'fixture', prepare: () => ({ url: 'https://passive.invalid', init: {}, state: undefined }), async *read() { yield* events } },
  })
}

async function fixture(events:LLMStreamEvent[],options:{settleError?:unknown;rejectIssue?:boolean;rejectGate?:boolean;observerThrows?:boolean}={}){
 const records:PassiveProducerRecord[]=[],trace:string[]=[];let sends=0
 vi.stubGlobal('fetch',async()=>{sends++;trace.push('fetch');return new Response('ok')})
 const request={systemPrompt:'',messages:[],tools:[]}
 const client=preparedModelClient(async()=>prepareHttpFixture(request,events))
 registerOriginalPassiveClient(client,attribution)
 const prepared=await prepareModelRequest(client,request)
 const generation=createGenerationControl({signal:new AbortController().signal,async reserve(candidate){
  const reservation={issue(){trace.push('issue');if(options.rejectIssue)throw Error('issue')},async settle(){trace.push('settle');if('settleError' in options)throw options.settleError}}
  registerOriginalPassiveReservation(reservation,{ownerSessionId:'s',actionId:'a',attemptId:'t',ordinal:1,lane:'main',cause:'initial',incarnation:'i',rebind:0,...candidate},{capture(record){records.push(record);trace.push(record.kind);if(options.observerThrows)throw null},unavailable(){trace.push('gap')}})
  return reservation
 }})
 const run=async()=>{for await(const _ of prepared.stream({generation,...options.rejectGate?{validateBeforeTransport(){throw Error('gate')}}:{}})){}}
 return {records,trace,run,sends:()=>sends,prepared,generation}
}
it('captures actual payload usage/end before original settlement throws, preserving original falsey error',async()=>{
 const f=await fixture([{type:'usage',usage:{inputTokens:8}},{type:'usage',usage:{outputTokens:3}},{type:'end'}],{settleError:null})
 await expect(f.run()).rejects.toBeNull();expect(f.sends()).toBe(1)
 expect(f.trace.slice(0,3)).toEqual(['issue','handoff','fetch'])
 const usage=f.records.filter(r=>r.kind==='usage');expect(usage).toHaveLength(3)
 expect(usage.map(r=>r.snapshotOrdinal)).toEqual([1,2,3]);expect(usage[0]!.usage).toEqual({inputTokens:8});expect(usage[1]!.usage).toEqual({outputTokens:3});expect(usage[2]).toMatchObject({usage:{},terminalCoverage:'complete'})
 expect(f.trace.indexOf('settle')).toBeGreaterThan(f.trace.lastIndexOf('usage'))
})
it.each(['rejectIssue','rejectGate'] as const)('records zero handoffs when original %s refuses',async key=>{
 const f=await fixture([{type:'end'}],{[key]:true});await expect(f.run()).rejects.toThrow();expect(f.sends()).toBe(0);expect(f.records.filter(r=>r.kind==='handoff')).toHaveLength(0)
})
it('keeps EOF unknown and observer errors never add transport or alter settled result',async()=>{
 const f=await fixture([{type:'usage',usage:{inputTokens:0}}],{observerThrows:true});await f.run();expect(f.sends()).toBe(1)
 expect(f.records.at(-1)).toMatchObject({kind:'usage',terminalCoverage:'unknown',usage:{}})
})
it('an unused cap derivative emits nothing and consumed derivative binds its actual payload',async()=>{
 const f=await fixture([{type:'end'}]);f.prepared.withOutputCap(4);expect(f.records).toEqual([])
 const consumed=f.prepared.withOutputCap(5);for await(const _ of consumed.stream({generation:f.generation})){}
 expect(f.sends()).toBe(1);const handoff=f.records.find(r=>r.kind==='handoff');expect(handoff?.kind==='handoff'&&handoff.confirmation.payloadId).toBe(consumed.measurement.payloadIdentity?.id)
})
it('captures partial Stop measurements on original iterator return before falsey settlement refusal',async()=>{
 const f=await fixture([{type:'usage',usage:{inputTokens:8}},{type:'end'}],{settleError:false})
 const iterator=f.prepared.stream({generation:f.generation})[Symbol.asyncIterator]();expect((await iterator.next()).value).toMatchObject({type:'usage'})
 await expect(iterator.return!()).rejects.toBe(false)
 expect(f.sends()).toBe(1);expect(f.records.at(-1)).toMatchObject({kind:'usage',usage:{},terminalCoverage:'unknown'})
 expect(f.trace.indexOf('settle')).toBeGreaterThan(f.trace.lastIndexOf('usage'))
})
it('captures provider error-event usage/partial coverage before original error settlement rejects',async()=>{
 const f=await fixture([{type:'usage',usage:{inputTokens:8,outputTokens:3}},{type:'error',error:Object.assign(Error('provider failure'),{code:'PROVIDER'})}],{settleError:0})
 await expect(f.run()).rejects.toBe(0);expect(f.sends()).toBe(1)
 expect(f.records.filter(row=>row.kind==='usage').map(row=>({usage:row.usage,coverage:row.terminalCoverage}))).toEqual([{usage:{inputTokens:8,outputTokens:3},coverage:'partial'},{usage:{},coverage:'partial'}])
 expect(f.trace.indexOf('settle')).toBeGreaterThan(f.trace.lastIndexOf('usage'))
})

it('captures one detached request and keeps original attribution for the consumed derivative', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const scope = { sessionId: 's', turnId: 'turn-original' }
  const requestIssue = vi.fn(), streamIssue = vi.fn()
  const request = {
    systemPrompt: 'Original prompt', messages: [], tools: [], sessionId: 's', requestScope: scope,
    onTransportIssue: requestIssue, 'passive-copy-marker': 'neutral-request',
  } satisfies LLMRequest & { 'passive-copy-marker': string }
  const physical = preparedModelClient(async captured => {
    captured.sessionId = 'different inner session'
    captured.requestScope = { sessionId: 'different scope', turnId: 'different turn' }
    entered.resolve()
    await release.promise
    return prepareHttpFixture(captured, [{ type: 'end' }], captured.systemPrompt)
  })
  const start = vi.fn(() => ({ event() {}, finish() {} }))
  const capture = vi.fn((metadata: Readonly<Pick<LLMRequest, 'sessionId' | 'requestScope'>>) => ({ projectId: `project-${metadata.sessionId}`, start }))
  const client = withOriginalPassiveClientAttribution(physical, attribution, undefined, capture)
  const nativeDefine = Object.defineProperty
  let copies = 0
  const counter = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, descriptor) => {
    if (key === 'passive-copy-marker') copies++
    return nativeDefine(target, key, descriptor)
  })
  const prepared = await (async () => {
    try {
      const pending = prepareModelRequest(client, request)
      await entered.promise
      request.systemPrompt = 'Changed after prepare'
      request.sessionId = 'different caller session'
      request.requestScope = { sessionId: 'different caller scope', turnId: 'different caller turn' }
      release.resolve()
      return await pending
    } finally { counter.mockRestore(); release.resolve() }
  })()
  expect(copies).toBe(1)
  expect(capture).toHaveBeenCalledTimes(1)
  expect(capture).toHaveBeenCalledWith({ sessionId: 's', requestScope: scope })
  expect(capture.mock.calls[0]![0].requestScope).toBe(scope)

  const bodies: unknown[] = [], rows: PassiveProducerRecord[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response('ok') })
  const generation = createGenerationControl({ signal: new AbortController().signal, async reserve(candidate) {
    const reservation = { issue() {}, async settle() {} }
    registerOriginalPassiveReservation(reservation, { ownerSessionId: 's', actionId: 'a', attemptId: 't', ordinal: 1, lane: 'main', cause: 'initial', incarnation: 'i', rebind: 0, ...candidate }, { capture(row) { rows.push(row) }, unavailable() {} })
    return reservation
  } })
  prepared.withOutputCap(4)
  expect(start).not.toHaveBeenCalled()
  expect(rows).toEqual([])
  const derivative = prepared.withOutputCap(5)
  for await (const _ of derivative.stream({ generation, onTransportIssue: streamIssue })) { /* Drain the genuine prepared terminal. */ }
  expect(bodies).toEqual([{ cap: 5, prompt: 'Original prompt' }])
  expect(start).toHaveBeenCalledTimes(1)
  expect(start).toHaveBeenCalledWith(derivative.measurement)
  expect(requestIssue).toHaveBeenCalledTimes(1)
  expect(streamIssue).toHaveBeenCalledTimes(1)
  expect(rows.find(row => row.kind === 'handoff')).toMatchObject({
    attribution: { ...attribution, projectId: 'project-s' }, confirmation: { payloadId: derivative.measurement.payloadIdentity?.id },
  })
})

it('leaves passive attribution dormant when the original signal aborts a held preparation', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const controller = new AbortController(), capture = vi.fn(() => ({ start: () => ({ event() {}, finish() {} }) }))
  const physical = preparedModelClient(async request => {
    entered.resolve()
    await release.promise
    return prepareHttpFixture(request, [{ type: 'end' }])
  })
  const client = withOriginalPassiveClientAttribution(physical, attribution, undefined, capture)
  const pending = prepareModelRequest(client, { systemPrompt: '', messages: [], tools: [], signal: controller.signal })
  await entered.promise
  controller.abort()
  release.resolve()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(capture).not.toHaveBeenCalled()
})
