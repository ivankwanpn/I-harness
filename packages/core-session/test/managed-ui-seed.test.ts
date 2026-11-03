import {expect,it} from 'vitest'
import {restoreManagedConversation,installRestoredManagedConversation} from '../src/restoration-internal.ts'
import {literalSeed} from './fixtures/format11-seed.ts'
import {literalSession} from './fixtures/semantic-observation.ts'

it('does not count semantic seed messages as physical UI messages or turns',async()=>{
 const seed=structuredClone(literalSeed),exchange=seed.groups[0]!.items[1]!
 if(exchange.kind!=='exchange')throw Error('Seed exchange required')
 const digest='f'.repeat(64),ref={version:1 as const,id:`ctxv1_${digest}`,revision:digest,codec:'json-utf8-v1' as const,encodedBytes:10,contentDigest:digest,completeness:'complete' as const}
 exchange.results=[{kind:'envelope',message:1,source:[{origin:0,seq:4,part:'result'}],media:[],execution:{outcome:'succeeded',dispatch:'dispatched'},sourceRetention:{kind:'artifact',artifact:0}}]
 seed.artifacts=[{ref,origins:[{origin:0,seq:4,part:'result'}],uses:[{kind:'result'}]}]
 const session=literalSession(seed),owner={};let active=true
 const candidate=await restoreManagedConversation({formatVersion:session.formatVersion,header:session.header,prefix:{eventCount:session.events.length,bodyBytes:0,prefixDigest:'fixture'},assertCurrent(){if(!active)throw Error('retired')},async consume(accept){await accept(session.events)},async readEvent(i){return session.events[i]!},async settle(){},async close(){active=false},appendCommitted(){throw Error('no writes')}},owner,'owner')
 const original=installRestoredManagedConversation(candidate,owner)
 try{expect(original.uiScalars()).toEqual({hasConversationMessages:false,turnCount:0,todosRevision:0});expect(original.hasVisibleResultRef({kind:'legacy',id:'foreign'})).toBe(false);expect(original.hasVisibleResultRef({kind:'managed',ref})).toBe(true);expect(original.hasVisibleResultRef({kind:'managed',ref:{...ref,revision:'a'.repeat(64)}})).toBe(false)}finally{await original.close()}
})
