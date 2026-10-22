import { expect, it } from 'vitest'
import { append, createSession, createNondurableFactOwner, exportConversationSeed, projectConversation } from '../src/index.ts'

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
