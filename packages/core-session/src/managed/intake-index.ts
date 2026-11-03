import type { SessionEventView } from './types.ts'
import {freezeJsonData} from './capture.ts'

/** Original admission ordinals/IDs plus only currently pending input payloads.
 * Public initialization already qualified its history; live stages preserve
 * the original pending-admission checks. */
export function createManagedIntakeIndex() {
  const admissions=new Map<string,number>(),pending=new Set<string>()
  const records=new Map<string,Readonly<{seq:number;inherited:boolean}>>()
  const cancellations=new Map<string,number>()
  const payloads=new Map<string,import('./types.ts').DeepReadonly<import('../inbox.ts').PendingInput>>()
  let revision=0
  return {
    admission(inputId:string){return admissions.get(inputId)},
    everAdmitted(inputId:string){return admissions.has(inputId)},
    isPending(inputId:string){return pending.has(inputId)},
    record(inputId:string){return records.get(inputId)},
    lastCancellationSeq(inputId:string){return cancellations.get(inputId)},
    pending(fromSeq=0){return Object.freeze([...payloads.values()].filter(input=>input.admittedSeq>=fromSeq))},
    releasePayloads(){payloads.clear()},
    stage(events:readonly SessionEventView[],validate=true){
      const expected=revision,changed=new Map<string,boolean>(),nextAdmissions=new Map<string,number>(),nextRecords=new Map<string,Readonly<{seq:number;inherited:boolean}>>()
      const nextPayloads=new Map<string,import('./types.ts').DeepReadonly<import('../inbox.ts').PendingInput>|undefined>()
      const nextCancellations=new Map<string,number>()
      for(const event of events){
        if(event.type!=='agent/input/admitted'&&event.type!=='agent/input/promoted'&&event.type!=='agent/input/cancelled')continue
        const prior=changed.get(event.inputId)??pending.has(event.inputId)
        if(event.type==='agent/input/admitted'){
          if(validate&&(prior||!event.inputId||typeof event.text!=='string'||!event.text||!['queue','steer'].includes(event.delivery)||!['user','system'].includes(event.intent)))throw new TypeError('Invalid or duplicate input admission')
          nextAdmissions.set(event.inputId,event.seq!)
          nextRecords.set(event.inputId,Object.freeze({seq:event.seq!,inherited:event.provenance?.kind==='inherited'}))
          const {seq,type:_type,version:_version,ignorable:_ignorable,...input}=event
          nextPayloads.set(event.inputId,freezeJsonData({...input,admittedSeq:seq??0}))
          changed.set(event.inputId,true)
        }else{
          if(validate&&!prior)throw new TypeError('Input is not pending')
          changed.set(event.inputId,false)
          nextPayloads.set(event.inputId,undefined)
          if(event.type==='agent/input/cancelled')nextCancellations.set(event.inputId,event.seq!)
        }
      }
      let installed=false
      return {commit(){if(installed)return;if(revision!==expected)throw new TypeError('Stale managed intake suffix');for(const [id,seq]of nextAdmissions)admissions.set(id,seq);for(const [id,record]of nextRecords)records.set(id,record);for(const [id,seq]of nextCancellations)cancellations.set(id,seq);for(const [id,value]of changed){if(value)pending.add(id);else pending.delete(id)}for(const [id,value]of nextPayloads){if(value)payloads.set(id,value);else payloads.delete(id)}revision++;installed=true}}
    }
  }
}
