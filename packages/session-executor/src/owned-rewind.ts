import {diagnosticsFor} from '@i-harness/diagnostics'
import {subscribeManagedExecution,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {RewindError,RewindRecorder,RewindStore} from '@i-harness/rewind'
export {withManagedRewindFacts} from './lifecycle/rewind-facts.ts'

const diagnostics=diagnosticsFor('mount')
export interface OwnedRewindHandle {
 readonly store:RewindStore
 readonly recorder:RewindRecorder
 drain():Promise<void>
 close():Promise<void>
}

/** Retain the original recorder before any FS tool can take a preimage. */
export async function mountOwnedRewind(options:{domain:ManagedExecutionDomain;root:string;workspace:string;assertCurrent():void;retain(close:()=>Promise<void>):void}):Promise<OwnedRewindHandle|undefined>{
 const {domain,root,workspace}=options
 options.assertCurrent()
 const store=new RewindStore({root,sessionId:domain.sessionId,workspace})
 let retired=false,unsubscribe:(()=>void)|undefined,drain=Promise.resolve(),closing:Promise<void>|undefined
 let recorder:RewindRecorder|undefined
 const close=()=>{if(closing)return closing;retired=true;unsubscribe?.();unsubscribe=undefined;closing=(async()=>{await drain;await recorder?.flush()})();return closing}
 options.retain(close)
 let mismatch=false
 try{await store.assertWorkspace(workspace)}catch(error){mismatch=error instanceof RewindError&&error.code==='REWIND_WORKSPACE_MISMATCH';diagnostics.warn(`[rewind] ${error instanceof Error?error.message:String(error)}`)}
 options.assertCurrent();if(retired)throw Error('Original Rewind mount retired')
 if(mismatch)return undefined
 try{const recovered=await store.recoverPending();if(recovered!==null)diagnostics.warn(`[rewind] recovered an unfinished turn (anchor seq ${recovered.anchorSeq}, ${recovered.entries.length} file(s)) as an orphan — plan() reports it`)}catch(error){diagnostics.warn(`[rewind] pending-turn recovery failed: ${error instanceof Error?error.message:String(error)}`)}
 options.assertCurrent();if(retired)throw Error('Original Rewind mount retired')
 recorder=new RewindRecorder({store,workspace});const original=recorder
 unsubscribe=subscribeManagedExecution(domain,event=>{
  if(event.type==='user/message')original.begin(event.seq??0,event.text)
  else if(event.type==='turn/end'){
   const finalized=original.finalize()
   drain=drain.then(async()=>{const point=await finalized;if(point===null)return;const committed={...point,turnIndex:(await store.readPoints()).length};await store.appendPoint(committed);await original.commit(committed.anchorSeq)}).catch(error=>{diagnostics.warn(`[rewind] point append failed: ${error instanceof Error?error.message:String(error)}`)})
  }
 })
 return Object.freeze({store,recorder:original,drain(){return drain},close})
}
