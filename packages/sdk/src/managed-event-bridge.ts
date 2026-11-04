import { copyConversationData, type SessionEvent } from '@i-harness/core-session'
import { makeNotification, type RpcMessage } from './protocol.ts'
import type { ManagedExecutionAttachment } from '../../session-persistence/src/execution-internal.ts'

type Owner={observe():ReturnType<ManagedExecutionAttachment['observe']>;subscribe(listener:(event:SessionEvent)=>void):()=>void}
/** One ordered original publisher, with archive-backed image hydration and
 * retirement fencing. Callback returns immediately to the original installer. */
export function createManagedEventBridge(emit:(message:RpcMessage)=>void) {
 const active=new Map<string,{owner:Owner;off:()=>void;retired:boolean;tail:Promise<void>}>()
 const retire=(id:string,owner?:Owner)=>{const row=active.get(id);if(!row||owner&&row.owner!==owner)return;active.delete(id);row.retired=true;row.off()}
 return {
  attach(sessionId:string,owner:Owner){
   retire(sessionId)
   const row={owner,off:()=>{},retired:false,tail:Promise.resolve()}
   const current=()=>!row.retired&&active.get(sessionId)===row
   row.off=owner.subscribe(event=>{
    let captured:SessionEvent
    try{captured=copyConversationData(event)}catch(error){row.tail=row.tail.then(()=>{if(current())emit(makeNotification('session/status',{sessionId,status:'error',error:error instanceof Error?error.message:String(error)}))});return}
    row.tail=row.tail.then(async()=>{
     if(!current())return
     let wire:SessionEvent=captured
     if(captured.type==='agent/input/admitted'&&captured.images!==undefined){const {images:_images,...rest}=captured;wire=rest}
     else if(captured.type==='user/message'&&captured.imageInputId!==undefined){
      if(!Number.isSafeInteger(captured.seq)||captured.seq===undefined)throw Error('image admission: user/message position is unavailable')
      const observation=owner.observe();observation.assertCurrent()
      const admission=await observation.inbox.admitted(captured.imageInputId)
      observation.assertCurrent()
      if(!admission||admission.inputId!==captured.imageInputId||!Number.isSafeInteger(admission.seq)||admission.seq===undefined||admission.seq>=captured.seq||!admission.images?.length)throw Error('image admission not found for user/message: '+captured.imageInputId)
      wire={...captured,images:copyConversationData(admission.images)}
     }
     if(current())emit(makeNotification('session/event',{sessionId,event:wire}))
    }).catch(error=>{if(current())emit(makeNotification('session/status',{sessionId,status:'error',error:error instanceof Error?error.message:String(error)}))})
   })
   active.set(sessionId,row)
  },
  retire,
  async close(){const rows=[...active.values()];for(const id of [...active.keys()])retire(id);await Promise.allSettled(rows.map(row=>row.tail))},
 }
}
