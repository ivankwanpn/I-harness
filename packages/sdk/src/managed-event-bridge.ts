import { copyConversationData, type SessionEvent } from '@i-harness/core-session'
import { makeNotification, type RpcMessage } from './protocol.ts'
import { displaySessionEvent } from './image-transport.ts'
import type { ManagedExecutionAttachment } from '../../session-persistence/src/execution-internal.ts'

type Owner={observe():ReturnType<ManagedExecutionAttachment['observe']>;subscribe(listener:(event:SessionEvent)=>void):()=>void}

async function displayPromotedImage(owner: Owner, current: () => boolean, event: Extract<SessionEvent, {type:'user/message'}>) {
 const seq = event.seq, id = event.imageInputId
 if (seq === undefined || !Number.isSafeInteger(seq) || seq < 0 || !id) throw Error('image admission: user/message position is unavailable')
 let observation = owner.observe()
 for (let attempt = 0; current(); attempt++) {
  try {
   // Read just this committed message and its earlier image admission at
   // one verified journal prefix. A later append cannot alter these bytes.
   const page = await observation.readHistoryPage({ afterSeq: seq, limit: 1 })
   if (page) {
    const original = page.events[0]
    if (original?.type !== 'user/message' || original.seq !== seq || original.imageInputId !== id) throw Error('Promoted image history does not match its original event')
    return displaySessionEvent(event, page.images.get(seq))
   }
   // Some legacy record layouts only support an indexed admission read.
   const admission = await observation.inbox.admitted(id)
   if (admission?.inputId === id && admission.seq !== undefined && Number.isSafeInteger(admission.seq) &&
       admission.seq >= 0 && admission.seq < seq && admission.images?.length)
    return displaySessionEvent(event, admission.images)
   throw Error('image admission not found for user/message: ' + id)
  } catch (error) {
   if (!current()) return
   // Only the normal append race expires this observation with this error.
   // Missing evidence, failed reads and ownership/cleanup failures stay errors.
   if (!(error instanceof TypeError) || (error as {code?: string}).code !== 'EXECUTION_OBSERVATION_EXPIRED') throw error
   if (attempt === 1) throw Error('Live image lookup expired; read session/history at sequence ' + seq, {cause:error})
   const next = owner.observe()
   if (next.identity !== observation.identity || next.eventCount <= observation.eventCount) throw error
   observation = next
  }
 }
}

/** One ordered original publisher, with archive-backed image hydration and
 * retirement fencing. Callback returns immediately to the original installer. */
export function createManagedEventBridge(emit:(message:RpcMessage)=>void) {
 const active=new Map<string,{owner:Owner;off:()=>void;retired:boolean;waiters:Set<()=>void>;tail:Promise<void>}>()
 const retire=(id:string,owner?:Owner)=>{const row=active.get(id);if(!row||owner&&row.owner!==owner)return;active.delete(id);row.retired=true;for(const resolve of row.waiters)resolve();row.off()}
 return {
  attach(sessionId:string,owner:Owner){
   retire(sessionId)
   const row={owner,off:()=>{},retired:false,waiters:new Set<()=>void>(),tail:Promise.resolve()}
   const current=()=>!row.retired&&active.get(sessionId)===row
   row.off=owner.subscribe(event=>{
    let captured: ReturnType<typeof displaySessionEvent> | Extract<SessionEvent,{type:'user/message'}>
    try{
     captured=event.type==='user/message'&&event.imageInputId!==undefined ? copyConversationData(event) : displaySessionEvent(event)
    }catch(error){row.tail=row.tail.then(()=>{if(current())emit(makeNotification('session/status',{sessionId,status:'error',error:error instanceof Error?error.message:String(error)}))});return}
    row.tail=row.tail.then(async()=>{
     if(!current())return
     const wire = captured.type === 'user/message' && captured.imageInputId !== undefined
       ? await displayPromotedImage(owner,current,captured) : captured
     if(wire&&current())emit(makeNotification('session/event',{sessionId,event:wire}))
    }).catch(error=>{if(current())emit(makeNotification('session/status',{sessionId,status:'error',error:error instanceof Error?error.message:String(error)}))})
   })
   active.set(sessionId,row)
  },
  retire,
  async flush(sessionId:string){
   const row=active.get(sessionId)
   if(!row)return
   const retired=Promise.withResolvers<void>()
   row.waiters.add(retired.resolve)
   try{await Promise.race([row.tail,retired.promise])}finally{row.waiters.delete(retired.resolve)}
  },
  async close(){const rows=[...active.values()];for(const id of [...active.keys()])retire(id);await Promise.allSettled(rows.map(row=>row.tail))},
 }
}
