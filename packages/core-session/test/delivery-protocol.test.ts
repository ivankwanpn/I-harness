import { validateDeliveryFrame } from '../src/conversation/delivery.ts';
import { expect, it } from 'vitest';
import { validateConversationEventShape } from '../src/events/conversation.ts';
it('rejects new required delivery facts under format12 and closed-data mutations', () => {
  const close = { type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop', reason: 'user-stop', seq: 0 } as const;
  expect(() => validateConversationEventShape(close, 12)).toThrow();
  expect(() => validateConversationEventShape(close, 13)).not.toThrow();
  for (const mutation of [{ ...close, extra: true }, { ...close, fenceId: undefined }, { ...close, reason: 'other' }])
    expect(() => validateConversationEventShape(mutation as never, 13)).toThrow();
});
it('rejects source pairs split over physical frames', () => {
  const start = { type: 'subagent/start', version: 1, taskId: 'task-1', parentSessionId: 'parent', agentPath: 'a', role: 'r', description: 'd', seq: 3 } as const;
  const binding = { type: 'agent/delivery-source', version: 1, kind: 'subagent', recipientSessionId: 'parent', generationId: 'g', sourceNamespace: 'ns', sourceId: 'task-1', callSeq: 1, startSeq: 3, seq: 4 } as const;
  expect(() => validateDeliveryFrame([start, binding], 13)).not.toThrow();
  expect(() => validateDeliveryFrame([binding], 13)).toThrow();
  expect(() => validateDeliveryFrame([start, binding], 12)).toThrow();
});
it('rejects a forged delivery producer without its physical receipt', () => {
  const admitted = { type: 'agent/input/admitted', version: 1, inputId: 'fake', text: 'text', delivery: 'steer', intent: 'system', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'session.delivery.subagent' }, seq: 1 } as const;
  expect(() => validateDeliveryFrame([admitted], 13)).toThrow();
});
it('rejects hidden, accessor, symbol and undefined delivery fields without executing hooks', async () => {
  const { captureFactGroup } = await import('../src/managed/groups.ts');
  const close = { type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop', reason: 'user-stop' } as const;
  let reads = 0;
  const accessor = Object.defineProperty({ ...close }, 'reason', { enumerable: true, get() { reads++; return 'user-stop'; } });
  const hidden = Object.defineProperty({ ...close }, 'extra', { value: 1 });
  for (const event of [accessor, hidden, { ...close, seq: undefined }, { ...close, [Symbol('extra')]: true }])
    expect(captureFactGroup({ kind: 'delivery-generation', event } as never).kind).toBe('not-issued');
  const binding = Object.defineProperty({ recipientSessionId: 'parent', generationId: 'g', sourceNamespace: 'ns', sourceId: 'task-1', callSeq: 1 }, 'hidden', { value: true });
  expect(captureFactGroup({ kind: 'subagent-delivery-start', start: { type: 'subagent/start', version: 1, taskId: 'task-1', agentPath: 'a', role: 'r', description: 'd', parentSessionId: 'parent' }, binding }).kind).toBe('not-issued');
  expect(reads).toBe(0);
});
it('refuses delivery authority as inherited seed while preserving ordinary context export', async () => {
  const { createSession, createNondurableFactOwner, captureFactGroup, resolveFactGroup, exportConversationSeed, readDeliveries } = await import('../src/index.ts');
  const event = { type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'f', reason: 'rewind', seq: 0 } as const;
  const capture = captureFactGroup({ kind: 'seed-import', events: [event] });
  if (capture.kind !== 'captured')
    throw Error('seed setup');
  expect(() => resolveFactGroup(capture.group, createSession(), 0)).toThrow(/authority/);
  const memory = createSession(), owner = createNondurableFactOwner(memory), received = owner.registerReceivedInputSource(async () => { });
  expect(await received.captureDeliveryClose({ ...event, seq: undefined }).admit()).toMatchObject({ kind: 'not-issued' });
  const closed = await received.captureDeliveryClose({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'actual', reason: 'rewind' }).admit();
  expect(closed).toMatchObject({ kind: 'memory-committed', durability: 'nondurable' });
  expect(readDeliveries(memory).activeGeneration()).toBeUndefined();
  const exported = exportConversationSeed(memory, { kind: 'session', sessionId: 'parent' }, { kind: 'all' });
  expect(exported.kind).toBe('seed');
  expect(JSON.stringify(exported)).not.toContain('agent/delivery-generation');
});
it('uses a domain-separated typed tuple for the canonical id',async()=>{
 const {deliveryInputId}=await import('../src/events/delivery.ts')
 expect(deliveryInputId({recipientSessionId:'parent',sourceNamespace:'registry',sourceId:'task-1',resultRevision:'original-revision',kind:'subagent'})).toBe('delivery-b24de151161856ca392d0098301ef8778f0ee8967849c03cac92005a5035be64')
})

it('stages bounded ordinary suffixes without copying or scanning committed map/set prefixes', async () => {
  const { createDeliveryIndex } = await import('../src/conversation/delivery.ts')
  const slots = [
    { target: Map.prototype, key: Symbol.iterator, kind: 'map' }, { target: Map.prototype, key: 'entries', kind: 'map' }, { target: Map.prototype, key: 'values', kind: 'map' },
    { target: Set.prototype, key: Symbol.iterator, kind: 'set' }, { target: Set.prototype, key: 'values', kind: 'set' },
  ].map(slot => ({ ...slot, descriptor: Object.getOwnPropertyDescriptor(slot.target, slot.key)! }))
  let mapEntries = 0, setEntries = 0
  const rows: { events:number; input:string; stageMapEntries:number[]; stageSetEntries:number[]; mapEntries:number; setEntries:number }[] = []
  try {
    for (const slot of slots) Object.defineProperty(slot.target, slot.key, { ...slot.descriptor, value: function* (this: object) {
      for (const item of slot.descriptor.value.call(this)) { if (slot.kind === 'map') mapEntries++; else setEntries++; yield item }
    } })
    for (const events of [32,64]) for (const input of ['message','admission']) {
      const index = createDeliveryIndex({ sessionId:'ordinary' }), beginMap = mapEntries, beginSet = setEntries, stageMapEntries:number[] = [], stageSetEntries:number[] = []
      for (let seq=0;seq<events;seq++) {
        const beforeMap=mapEntries,beforeSet=setEntries,stage=index.stage()
        stageMapEntries.push(mapEntries-beforeMap);stageSetEntries.push(setEntries-beforeSet)
        stage.advance(input==='message'?{type:'user/message',text:'ordinary',seq}:{type:'agent/input/admitted',version:1,inputId:'human-'+seq,text:'ordinary',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'},seq})
        stage.validate();stage.commit()
      }
      rows.push({events,input,stageMapEntries,stageSetEntries,mapEntries:mapEntries-beginMap,setEntries:setEntries-beginSet})
    }
    for (const events of [32,64]) {
      const index=createDeliveryIndex({sessionId:'parent'}),prefix=index.stage()
      for(let seq=0;seq<events;seq++)prefix.advance({type:'agent/input/admitted',version:1,inputId:'human-'+seq,text:'ordinary',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'},seq})
      prefix.advance({type:'agent/delivery-generation',version:1,op:'open',recipientSessionId:'parent',generationId:'g',originInputSeq:0,seq:events})
      prefix.advance({type:'tool/call',name:'spawn_agent',callId:'spawn',args:{},seq:events+1})
      prefix.advance({type:'tool/dispatch',callId:'spawn',eventSeq:events+1,seq:events+2});prefix.validate();prefix.commit()
      const beginMap=mapEntries,beginSet=setEntries,stage=index.stage(),stageMapEntries=[mapEntries-beginMap],stageSetEntries=[setEntries-beginSet]
      stage.advance({type:'subagent/start',version:1,taskId:'task',parentSessionId:'parent',role:'worker',agentPath:'a',description:'work',seq:events+3})
      stage.advance({type:'agent/delivery-source',version:1,kind:'subagent',recipientSessionId:'parent',generationId:'g',sourceNamespace:'registry',sourceId:'task',callSeq:events+1,startSeq:events+3,seq:events+4});stage.validate();stage.commit()
      rows.push({events,input:'binding',stageMapEntries,stageSetEntries,mapEntries:mapEntries-beginMap,setEntries:setEntries-beginSet})
    }
  } finally { for (const slot of slots) Object.defineProperty(slot.target,slot.key,slot.descriptor) }
  expect(slots.every(slot=>Object.getOwnPropertyDescriptor(slot.target,slot.key)?.value===slot.descriptor.value)).toBe(true)
  console.log(JSON.stringify({control:'bounded delivery delta entry counts',rows}))
  for (const row of rows) {
    expect(row.stageMapEntries).toEqual(Array(row.input==='binding'?1:row.events).fill(0));expect(row.stageSetEntries).toEqual(Array(row.input==='binding'?1:row.events).fill(0))
    expect(row.mapEntries).toBeLessThanOrEqual(row.input==='binding'?2:row.events*2);expect(row.setEntries).toBe(0)
  }
})

it.each(['matching','wrong-id','wrong-address','before-call','future-dispatch','other-call-same-id','valid-then-mismatch','mismatch-then-valid'] as const)('checks original dispatch scalar address/id/order for %s',async mode=>{
  const {createDeliveryIndex}=await import('../src/conversation/delivery.ts')
  const stage=createDeliveryIndex({sessionId:'parent'}).stage()
  stage.advance({type:'agent/input/admitted',version:1,inputId:'human',text:'launch',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'},seq:0})
  stage.advance({type:'agent/delivery-generation',version:1,op:'open',recipientSessionId:'parent',generationId:'g',originInputSeq:0,seq:1})
  let callSeq=2,startSeq=4
  if(mode==='before-call') {stage.advance({type:'tool/dispatch',callId:'spawn',eventSeq:3,seq:2});callSeq=3}
  stage.advance({type:'tool/call',name:'spawn_agent',callId:'spawn',args:{},seq:callSeq})
  if(mode!=='before-call')stage.advance({type:'tool/dispatch',callId:mode==='wrong-id'||mode==='mismatch-then-valid'?'other':'spawn',eventSeq:mode==='wrong-address'?0:2,seq:mode==='future-dispatch'?6:3})
  if(mode==='other-call-same-id'){callSeq=4;stage.advance({type:'tool/call',name:'spawn_agent',callId:'spawn',args:{},seq:4});startSeq=5}
  if(mode==='valid-then-mismatch'||mode==='mismatch-then-valid'){stage.advance({type:'tool/dispatch',callId:mode==='valid-then-mismatch'?'other':'spawn',eventSeq:2,seq:4});startSeq=5}
  stage.advance({type:'subagent/start',version:1,taskId:'task',parentSessionId:'parent',role:'worker',agentPath:'a',description:'work',seq:startSeq})
  const bind=()=>stage.advance({type:'agent/delivery-source',version:1,kind:'subagent',recipientSessionId:'parent',generationId:'g',sourceNamespace:'registry',sourceId:'task',callSeq,startSeq,seq:startSeq+1})
  if(['matching','valid-then-mismatch','mismatch-then-valid'].includes(mode)){expect(bind).not.toThrow();stage.validate();stage.commit()}
  else expect(bind).toThrow(/uncertified delivery source/)
})
