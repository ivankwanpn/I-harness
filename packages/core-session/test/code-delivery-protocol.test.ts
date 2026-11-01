import { expect, it } from 'vitest'
import { validDeliveryEvent, deliveryMinimumFormat, deliveryInputId } from '../src/events/delivery.ts'
import { validateConversationEventShape } from '../src/events/conversation.ts'
import { readDeliveries } from '../src/conversation/delivery.ts'
import { encodeFactBatch, readFactJournal, legacyPrefixDigest } from '../src/serialization/fact-journal.ts'
import { managedResultRefs } from '../src/results/projection.ts'

it('admits only closed Code delivery source and unavailable terminal in physical 14',()=>{
 const source={type:'agent/delivery-source',version:1,kind:'code',sourceNamespace:'code',recipientSessionId:'parent',generationId:'g',sourceId:'outer',callSeq:2,cellId:'cell',delivery:'tool'}
 const end={type:'code/end',version:1,sourceSeq:4,cellId:'cell',execution:{dispatch:'dispatched',outcome:'failed'},result:{kind:'unavailable',reason:'quota'}}
 expect(validDeliveryEvent(source)).toBe(true);expect(deliveryMinimumFormat(source as never)).toBe(14)
 expect(validDeliveryEvent(end)).toBe(true);expect(deliveryMinimumFormat(end as never)).toBe(14)
 expect(validDeliveryEvent({...source,delivery:'parent'})).toBe(false)
 expect(validDeliveryEvent({...end,output:{}})).toBe(false)
 expect(validDeliveryEvent({...end,extra:true})).toBe(false)
})

const hash='a'.repeat(64)
const receipt={owner:{sessionId:'parent',incarnation:'original'},key:{batchId:'batch',firstSeq:5,count:1,previousPrefixDigest:hash,batchDigest:hash},lastSeq:5,prefixDigest:hash}
const ref={version:1,id:'ctxv1_'+hash,revision:hash,codec:'code-output-manifest-v1',encodedBytes:42,contentDigest:hash,completeness:'complete'}
const source={type:'agent/delivery-source',version:1,kind:'code',sourceNamespace:'code',recipientSessionId:'parent',generationId:'g',sourceId:'outer',callSeq:2,cellId:'cell',delivery:'tool',seq:4}
const end={type:'code/end',version:1,sourceSeq:4,cellId:'cell',execution:{dispatch:'dispatched',outcome:'succeeded'},result:{kind:'artifact',ref},output:{header:{kind:'code-output',version:1,sessionId:'parent',cellId:'cell',sourceId:'retention'},footer:{kind:'seal',count:0,digest:hash,terminal:{seq:5,receipt},status:'completed',store:null,accepted:0,omitted:0,truncated:false},unavailableTextCount:0}}
const handoff={type:'agent/delivery-handoff',version:1,kind:'code',sourceSeq:4}
function history(order:'before'|'after'|'none'='after'):any[]{
 const events:any[]=[{type:'agent/input/admitted',version:1,inputId:'human',text:'work',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'},seq:0}, {type:'agent/delivery-generation',version:1,op:'open',recipientSessionId:'parent',generationId:'g',originInputSeq:0,seq:1}, {type:'tool/call',name:'code_exec',callId:'call',args:{},seq:2},{type:'tool/dispatch',callId:'call',eventSeq:2,seq:3},source,{type:'code/cell',cellId:'cell',sessionId:'parent',parentCallId:'call',state:'completed',seq:5}]
 if(order==='before')events.push({...handoff,seq:events.length})
 events.push({...end,seq:events.length})
 if(order==='after')events.push({...handoff,seq:events.length})
 return events
}
const read=(events:any[])=>readDeliveries({formatVersion:14,header:{sessionId:'parent'},events} as never)
it.each(['before','after'] as const)('routes the original Code terminal with handoff %s',order=>{
 const events=history(order);expect(read(events).codePending()).toHaveLength(1)
 const prefix=legacyPrefixDigest(0,new Uint8Array()),bytes=encodeFactBatch('code-protocol',prefix,events).bytes,metadata={version:1 as const,legacyBodyBytes:0,legacyEventCount:0,legacyPrefixDigest:prefix,separatorBytes:0 as const}
 expect(readFactJournal(bytes,metadata,14,{sessionId:'parent'}).events).toEqual(events)
 expect(()=>readFactJournal(bytes,metadata,13,{sessionId:'parent'})).toThrow()
 for(const event of [source,end,handoff]){expect(()=>validateConversationEventShape(event as never,14)).not.toThrow();expect(()=>validateConversationEventShape(event as never,13)).toThrow()}
})
it('rejects foreign members and excludes foreground, incomplete and stopped candidates',()=>{
 expect(managedResultRefs(end as never)).toEqual([ref]);expect(()=>managedResultRefs({...end,extra:true} as never)).toThrow();expect(()=>managedResultRefs({...end,result:{kind:'artifact',ref:{...ref,codec:'json-utf8-v1'}}} as never)).toThrow()
 expect(read(history('none')).codePending()).toEqual([])
 for(const mutate of [(e:any[])=>{e[2].name='code_wait'},(e:any[])=>{e[5].cellId='foreign'},(e:any[])=>{e[6].output.header.sourceId='outer'},(e:any[])=>{e[6].output.footer.terminal.receipt.owner.sessionId='foreign'},(e:any[])=>{e[6].result.ref.codec='json-utf8-v1'},(e:any[])=>{e[6].cellId='foreign'}]){const events=structuredClone(history());mutate(events);expect(()=>read(events)).toThrow()}
 const incomplete=structuredClone(history());incomplete[6].output.unavailableTextCount=0;incomplete[6].result.ref.completeness='producer-incomplete';expect(read(incomplete).codePending()).toEqual([])
 const stopped=history();stopped.push({type:'agent/delivery-generation',version:1,op:'close',recipientSessionId:'parent',fenceId:'stop',reason:'user-stop',seq:stopped.length});expect(read(stopped).codePending()).toEqual([])
 const duplicate=history();duplicate.push({...end,seq:duplicate.length});expect(()=>read(duplicate)).toThrow()
 const duplicateSource=history();duplicateSource.push({...source,sourceId:'other',seq:duplicateSource.length});expect(()=>read(duplicateSource)).toThrow()
 for(const mutate of [(e:any)=>{e.output.footer.omitted=1},(e:any)=>{e.output.unavailableTextCount=1},(e:any)=>{e.output.extra=true},(e:any)=>{e.output.header.extra=true}]){const bad=structuredClone(end);mutate(bad);expect(validDeliveryEvent(bad)).toBe(false)}
 const badOutcome=structuredClone(history());badOutcome[6].execution.outcome='failed';expect(read(badOutcome).codePending()).toEqual([])
 const interrupted=structuredClone(history());interrupted[5].state='interrupted';interrupted[6].output.footer.status='interrupted';interrupted[6].execution.outcome='canceled';expect(read(interrupted).codePending()).toEqual([])
 for(const branch of [{execution:{dispatch:'not-dispatched',outcome:'unknown'},reason:'launch-refused'},{execution:{dispatch:'unknown',outcome:'unknown'},reason:'launch-unknown'},{execution:{dispatch:'dispatched',outcome:'failed'},result:{kind:'unavailable',reason:'quota'}}]){const events=history();events[6]={type:'code/end',version:1,sourceSeq:4,cellId:'cell',...branch,seq:6};expect(read(events).codePending()).toEqual([])}
})
it('reconciles one Code receipt and rejects duplicate receipts',()=>{
 const events=history(),key={kind:'code',sourceNamespace:'code',recipientSessionId:'parent',sourceId:'outer',resultRevision:ref.revision},inputId=deliveryInputId(key as never)
 events.push({type:'agent/delivery-received',version:1,key,sourceSeq:4,terminalSeq:6,inputId,seq:events.length})
 events.push({type:'agent/input/admitted',version:1,inputId,text:'done',delivery:'steer',intent:'system',provenance:{kind:'child-report',authority:'observation',scope:'turn',producer:'session.delivery.code'},synthetic:{scope:'turn',description:'Code completed',display:{kind:'task',title:'code',body:'done'}},seq:events.length})
 expect(read(events).codePending()).toEqual([]);expect(read(events).receipt(key as never)).toMatchObject({disposition:'pending'})
 expect(()=>read([...events,{...events[8],seq:events.length},{...events[9],seq:events.length+1}])).toThrow()
})
