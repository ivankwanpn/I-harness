import { expect, it } from 'vitest'
import { createConversationValidationScan, inspectConversationValidationScan } from '../src/conversation/validation.ts'
import { createConversationValidationIndex } from '../src/index.ts'
import type { SessionEvent } from '../src/events/types.ts'
it('scans original complete validation and selection without retaining the source array',async()=>{
 const events:SessionEvent[]=[{type:'turn/start',seq:0},{type:'user/message',text:'task',seq:1},{type:'step/start',seq:2},{type:'assistant/message',text:'old',seq:3},{type:'step/end',seq:4},{type:'turn/end',seq:5}]
 const full=createConversationValidationIndex(events,{formatVersion:14});const scan=createConversationValidationScan({formatVersion:14,readEvent:async ordinal=>events[ordinal]!})
 for(const event of events)await scan.push([event]);const candidate=scan.finish()
 expect(inspectConversationValidationScan(candidate)).toEqual({eventCount:events.length,history:full.history(),resultFacts:full.resultFacts()})
 expect(()=>inspectConversationValidationScan({})).toThrow();expect(()=>scan.finish()).toThrow()
})
it('does not accept an incomplete semantic birth merely because the scan can advance',async()=>{
 const scan=createConversationValidationScan({formatVersion:14,readEvent:async()=>{throw Error('unexpected hydration')}})
 await expect(scan.push([{type:'conversation/semantics',version:1,mode:'accepted-exchange-v1',seq:0},{type:'tool/dispatch',callId:'unaccepted',seq:1}])).rejects.toThrow()
 expect(()=>scan.finish()).toThrow()
})

import { createSession, createNondurableFactOwner } from '../src/index.ts'
async function preparedFixture(){
 const source=createSession(),action=createNondurableFactOwner(source).beginAction();
 await action.facts.inputs.admit({type:'agent/input/admitted',version:1,inputId:'raw',text:'/raw',delivery:'queue',intent:'user',preparationPolicy:'human-host',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})
 await action.captureGeneration([{type:'context/action',version:1,op:'open',ownerSessionId:'document',actionId:'generation',purpose:'main',origin:{kind:'input',seq:0},startedAt:100,expiresAt:3600100,trustedAt:100}],()=>true).admit()
 const envelope={type:'agent/input/preparation' as const,version:1 as const,preparationId:'prepare',actionId:'generation',actionSeq:1,admissionSeq:0,inputId:'raw'}
 await action.captureInputPreparation({...envelope,op:'started',startedAt:100},()=>true).admit()
 const settlement=action.registerSettlementSource(async()=>{}),result={...envelope,op:'completed' as const,observations:[{producer:'host-preparation' as const,text:'expanded observation'}]}
 await settlement.inputPreparation.capture(result).admit()
 await action.facts.inputs.start({type:'agent/input/promoted',version:1,inputId:'raw'},{type:'user/message',text:'/raw',input:{inputId:'raw',intent:'user'},provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}},{...result,seq:3})
 await settlement.close();action.finish();return source
}
it('defers original atomic preparation end constraints until whole scan finish and hydrates exact earlier bodies',async()=>{
 const source=await preparedFixture(),reads:number[]=[];const full=createConversationValidationIndex(source.events,{formatVersion:source.formatVersion});
 const scan=createConversationValidationScan({formatVersion:source.formatVersion,readEvent:async ordinal=>{reads.push(ordinal);return source.events[ordinal]!}})
 for(const event of source.events)await scan.push([event]);expect(inspectConversationValidationScan(scan.finish()).history).toEqual(full.history());expect(reads).toContain(0);expect(reads).toContain(3)
})
it('does not defer or skip exact prepared text equality across physical units',async()=>{
 const source=await preparedFixture(),scan=createConversationValidationScan({formatVersion:source.formatVersion,readEvent:async ordinal=>source.events[ordinal]!})
 const changed=source.events.map(event=>event.type==='user/message'?{...event,text:'different'}:event)
 await expect((async()=>{for(const event of changed)await scan.push([event]);scan.finish()})()).rejects.toThrow('prepared input text mismatch')
})
it('refuses unfinished preparation linkage at the original finish boundary',async()=>{
 const source=await preparedFixture();const events=source.events.slice(0,-1);const scan=createConversationValidationScan({formatVersion:source.formatVersion,readEvent:async ordinal=>events[ordinal]!})
 for(const event of events)await scan.push([event]);expect(()=>scan.finish()).toThrow('prepared input requires atomic promotion linkage')
})
