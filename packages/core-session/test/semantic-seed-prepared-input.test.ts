import { expect, it, vi } from 'vitest'
import { append, createSession, createNondurableFactOwner, exportConversationSeed, projectConversation } from '../src/index.ts'
import { installRestoredManagedConversation, readRestoredConversation, restoreManagedConversation } from '../src/managed/restored-view.ts'
import type { SessionEventView } from '../src/managed/types.ts'

const plans = vi.hoisted(() => ({ count: 0 }))
vi.mock('../src/conversation/history/replacements.ts', async load => {
  const original = await load<typeof import('../src/conversation/history/replacements.ts')>()
  return { ...original, projectHistory(...args: Parameters<typeof original.projectHistory>) {
    plans.count++
    return original.projectHistory(...args)
  } }
})

async function prepared(images = false, textFirst = false) {
  const session = createSession(), action = createNondurableFactOwner(session).beginAction()
  const image = {mediaType:'image/png' as const,dataBase64:'AQID'}
  const provenance = {kind:'human' as const,authority:'request' as const,scope:'turn' as const,producer:'session.prompt'}
  const outcomes = [await action.facts.inputs.admit({type:'agent/input/admitted',version:1,inputId:'raw',text:'/raw',delivery:'queue',intent:'user',preparationPolicy:'human-host',provenance,...(images?{images:[image]}:{})})]
  outcomes.push(await action.captureGeneration([{type:'context/action',version:1,op:'open',ownerSessionId:'document',actionId:'generation',purpose:'main',origin:{kind:'input',seq:0},startedAt:100,expiresAt:3600100,trustedAt:100}],()=>true).admit())
  const envelope = {type:'agent/input/preparation' as const,version:1 as const,preparationId:'prepare',actionId:'generation',actionSeq:1,admissionSeq:0,inputId:'raw'}
  outcomes.push(await action.captureInputPreparation({...envelope,op:'started',startedAt:100},()=>true).admit())
  const source = action.registerSettlementSource(async()=>{})
  const observation = textFirst ? {text:'expanded observation',producer:'host-preparation' as const} : {producer:'host-preparation' as const,text:'expanded observation'}
  const result = {...envelope,op:'completed' as const,observations:[observation]}
  try {
    outcomes.push(await source.inputPreparation.capture(result).admit())
    outcomes.push(await action.facts.inputs.start({type:'agent/input/promoted',version:1,inputId:'raw'}, {type:'user/message',text:'/raw',input:{inputId:'raw',intent:'user'},provenance,...(images?{imageInputId:'raw'}:{})}, {...result,seq:3}))
  } finally {await source.close();action.finish()}
  expect(outcomes.every(outcome=>outcome.kind==='memory-committed')).toBe(true)
  // Detach the genuine committed history to mutate source descriptors; some
  // owner-captured nested observations are deliberately frozen in live state.
  const detached = structuredClone(session)
  const raw = detached.events.find(event=>event.type==='user/message' && event.inputPreparation && !('rawMessageSeq' in event.inputPreparation))!
  const derived = detached.events.find(event=>event.type==='user/message' && event.inputPreparation && 'rawMessageSeq' in event.inputPreparation)!
  const admission = detached.events[0]!, completed = detached.events[3]!
  if(raw.type!=='user/message'||derived.type!=='user/message'||admission.type!=='agent/input/admitted'||completed.type!=='agent/input/preparation'||completed.op!=='completed') throw Error('Genuine preparation required')
  return {session:detached,raw,derived,admission,observation:completed.observations[0]!,image}
}
const all = (session: ReturnType<typeof createSession>) => exportConversationSeed(session,{kind:'anonymous'},{kind:'all'})

async function restoredPreparation() {
  const fixture = await prepared(true), owner = {};
  const { session } = fixture;
  let current = true, restoring = true;
  const candidate = await restoreManagedConversation({
    formatVersion: session.formatVersion,
    prefix: { eventCount: session.events.length, bodyBytes: 0, prefixDigest: 'fixture' },
    assertCurrent() { if (!current) throw new Error('Lost archive ownership'); },
    async consume(accept) { await accept(session.events); },
    async readEvent(index) {
      if (!restoring) throw new Error('Preparation should use the held batch reader');
      return session.events[index]!;
    },
    async settle() {}, async close() {}, appendCommitted() { throw new Error('Unexpected append'); },
  }, owner, 'document');
  restoring = false;
  return { ...fixture, installed: installRestoredManagedConversation(candidate, owner), invalidate() { current = false; } };
}

it('hydrates selected message, preparation and admission bodies with one held archive read', async () => {
  const { installed, raw, derived, admission, session } = await restoredPreparation();
  const reads: number[][] = [];
  try {
    const lease = await installed.prepare(undefined, async ordinals => {
      reads.push([...ordinals]);
      return ordinals.map(ordinal => session.events[ordinal]!);
    });
    try {
      expect(reads).toHaveLength(1);
      expect(reads[0]).toEqual(expect.arrayContaining([raw.seq, derived.seq, admission.seq, raw.inputPreparation!.resultSeq]));
      expect(readRestoredConversation(lease, { ownerSessionId: 'document' }).projection)
        .toEqual(projectConversation(session, { ownerSessionId: 'document' }));
    } finally { await lease.settle(); }
  } finally { await installed.close(); }
});

it('reuses the exact hydrated preparation without sharing settled leases or returned turn extents', async () => {
  const { installed, raw, session } = await restoredPreparation();
  const options = { ownerSessionId: 'document' };
  const neverRead = async () => { throw Error('Unexpected archive read at the same revision'); };
  try {
    const first = await installed.prepare(undefined, async ordinals => ordinals.map(ordinal => session.events[ordinal]!));
    const second = await installed.prepare(undefined, neverRead);
    const expected = projectConversation(session, options);
    const hydratedPlans = plans.count;
    const firstRender = readRestoredConversation(first, options).projection;
    const extent = firstRender.items[0]!.extent;
    expect(extent).toEqual(expected.items[0]!.extent);
    if (extent?.kind !== 'framed') throw Error('Original framed turn required');
    Object.assign(extent, { first: 9999 });
    expect(readRestoredConversation(second, options).projection).toEqual(expected);
    expect(first.preparedEvent(raw.seq!)).toBe(second.preparedEvent(raw.seq!));
    expect(() => readRestoredConversation(first, { ...options, capturePayload(value) {
      void first.settle();
      return value;
    } })).toThrow('CONVERSATION_PREPARATION_EXPIRED');
    expect(() => first.preparedEvent(raw.seq!)).toThrow('CONVERSATION_PREPARATION_EXPIRED');
    expect(readRestoredConversation(second, options).projection).toEqual(expected);
    await second.settle();
    const reopened = await installed.prepare(undefined, neverRead);
    expect(readRestoredConversation(reopened, options).projection).toEqual(expected);
    expect(plans.count).toBe(hydratedPlans);
    await reopened.settle();
  } finally { await installed.close(); }
});

it.each(['message result', 'preparation admission', 'ownership'] as const)('rejects a held batch with changed %s', async conflict => {
  const { installed, raw, session, invalidate } = await restoredPreparation();
  let reads = 0;
  try {
    await expect(installed.prepare(undefined, async ordinals => {
      reads++;
      if (conflict === 'ownership') invalidate();
      return ordinals.map((ordinal): SessionEventView => {
        const event = session.events[ordinal]!;
        if (conflict === 'message result' && event.type === 'user/message' && event.seq === raw.seq) {
          return { ...event, inputPreparation: { ...event.inputPreparation!, resultSeq: 0 } };
        }
        if (conflict === 'preparation admission' && event.type === 'agent/input/preparation' && event.op === 'completed') {
          return { ...event, admissionSeq: 1 };
        }
        return event;
      });
    })).rejects.toThrow(conflict === 'ownership' ? 'Lost archive ownership' : 'CONVERSATION_RESTORATION_DEPENDENCY_MISMATCH');
    expect(reads).toBe(1);
  } finally { if (conflict !== 'ownership') await installed.close(); }
});

it.each(['raw','derived','admission','observation'] as const)('refuses selected prepared %s text getters without executing them',async slot=>{
  const fixture=await prepared(),target=fixture[slot],text=target.text
  expect(all(fixture.session).kind).toBe('seed')
  let reads=0
  Object.defineProperty(target,'text',{enumerable:true,get(){reads++;return text}})
  expect(all(fixture.session)).toEqual({kind:'refused',reason:'invalid-seed'})
  expect(reads).toBe(0)
})
it.each(['raw','derived','admission','observation'] as const)('retains selected prepared %s plain-data equality checks',async slot=>{
  const fixture=await prepared()
  Object.defineProperty(fixture[slot],'text',{value:'mismatched text',enumerable:true})
  expect(all(fixture.session)).toEqual({kind:'refused',reason:'invalid-seed'})
  expect(()=>projectConversation(fixture.session)).toThrow()
})
it('exports a fully consumed prepared component without reading discarded text or observation bodies',async()=>{
  const fixture=await prepared()
  append(fixture.session,{type:'compaction/summary',text:'prepared summary',shadowedSeqs:[fixture.raw.seq!,fixture.derived.seq!]})
  let reads=0
  for(const target of [fixture.raw,fixture.derived,fixture.admission,fixture.observation]) Object.defineProperty(target,'text',{enumerable:true,get(){reads++;return 'discarded text'}})
  const exported=all(fixture.session)
  expect(exported.kind).toBe('seed');expect(reads).toBe(0)
  if(exported.kind!=='seed')throw Error('seed required')
  expect(exported.seed.groups.flatMap(group=>group.items.flatMap(item=>item.messages.map(message=>message.content)))).toEqual(['prepared summary'])
  // Public/full preparation validation still rejects malformed observations.
  expect(()=>projectConversation(fixture.session)).toThrow();expect(reads).toBe(0)
})
it('captures prepared admission text and images as distinct slots while preserving provenance',async()=>{
  const fixture=await prepared(true),exported=all(fixture.session)
  expect(exported.kind).toBe('seed')
  if(exported.kind!=='seed')throw Error('seed required')
  const items=exported.seed.groups.flatMap(group=>group.items)
  expect(items[0]!.messages[0]!.content).toEqual([{type:'text',text:'/raw'},{type:'image',image:fixture.image}])
  expect(items[0]!.sourceProvenance[0]).toMatchObject({kind:'human',authority:'request',producer:'session.prompt'})
  expect(items[1]!.messages[0]!.content).toContain('expanded observation')
})
it('preserves the existing exact observation key order through full admission and selected text checking',async()=>{
  const fixture=await prepared(false,true),exported=all(fixture.session)
  expect(exported.kind).toBe('seed')
  if(exported.kind!=='seed')throw Error('seed required')
  expect(exported.seed.groups.flatMap(group=>group.items.flatMap(item=>item.messages.map(message=>message.content)))[1]).toContain('{"text":"expanded observation","producer":"host-preparation"}')
})
