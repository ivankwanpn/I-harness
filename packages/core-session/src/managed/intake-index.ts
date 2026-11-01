import type { SessionEventView } from './types.ts'

/** The original managed intake state: ordinals/IDs only, never raw payloads.
 * Public initialization already qualified its history; live stages preserve
 * the original pending-admission checks. */
export function createManagedIntakeIndex() {
  const admissions=new Map<string,number>(),pending=new Set<string>()
  let revision=0
  return {
    admission(inputId:string){return admissions.get(inputId)},
    everAdmitted(inputId:string){return admissions.has(inputId)},
    isPending(inputId:string){return pending.has(inputId)},
    stage(events:readonly SessionEventView[],validate=true){
      const expected=revision,changed=new Map<string,boolean>(),nextAdmissions=new Map<string,number>()
      for(const event of events){
        if(event.type!=='agent/input/admitted'&&event.type!=='agent/input/promoted'&&event.type!=='agent/input/cancelled')continue
        const prior=changed.get(event.inputId)??pending.has(event.inputId)
        if(event.type==='agent/input/admitted'){
          if(validate&&(prior||!event.inputId||typeof event.text!=='string'||!event.text||!['queue','steer'].includes(event.delivery)||!['user','system'].includes(event.intent)))throw new TypeError('Invalid or duplicate input admission')
          nextAdmissions.set(event.inputId,event.seq!)
          changed.set(event.inputId,true)
        }else{
          if(validate&&!prior)throw new TypeError('Input is not pending')
          changed.set(event.inputId,false)
        }
      }
      let installed=false
      return {commit(){if(installed)return;if(revision!==expected)throw new TypeError('Stale managed intake suffix');for(const [id,seq]of nextAdmissions)admissions.set(id,seq);for(const [id,value]of changed){if(value)pending.add(id);else pending.delete(id)}revision++;installed=true}}
    }
  }
}
