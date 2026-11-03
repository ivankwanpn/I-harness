import { configuration, identity } from '../config.ts'
import type { Store } from '../store.ts'
import type { CodeAccess, CodeRetrievalConfig, CodeRetrievalService } from '../types.ts'
import type { RetrievalTelemetry } from './status.ts'

/** Single admission, operation and serialized control owner for this service. */
export function createConfiguration(initial:CodeRetrievalConfig,store:Store,telemetry:Pick<RetrievalTelemetry,'reset'|'status'>) {
  let config=initial,closed=false,stopping=0
  type Operation={controller:AbortController;done:Promise<unknown>;sessionId:string}
  const active=new Set<Operation>()
  let controls:Promise<unknown>=Promise.resolve()
  function admit(access:CodeAccess,controlOwner=false) {
    identity(access.sessionId,'session ID');access.signal?.throwIfAborted()
    if(closed)throw new Error('Code Context is closed')
    if(!config.enabled)throw new Error('Code Context is disabled')
    if(stopping&&!controlOwner)throw new Error('Code Context is stopping')
  }
  function operation<T>(access:CodeAccess,run:(signal:AbortSignal,check:()=>void)=>Promise<T>,controller=new AbortController()):Promise<T> {
    const signal=access.signal?AbortSignal.any([access.signal,controller.signal]):controller.signal
    const deadline=Date.now()+config.deadlineMs
    const check=()=>{if(Date.now()>=deadline&&!signal.aborted)controller.abort(new Error('Code Context deadline exceeded'));signal.throwIfAborted()}
    const timer=setTimeout(()=>controller.abort(new Error('Code Context deadline exceeded')),config.deadlineMs)
    const item:Operation={controller,done:Promise.resolve(),sessionId:access.sessionId};active.add(item)
    const promise=Promise.resolve().then(()=>{check();return run(signal,check)}).finally(()=>{clearTimeout(timer);active.delete(item)})
    item.done=promise;return promise
  }
  function control<T>(fn:()=>Promise<T>):Promise<T> {
    stopping++
    const next=controls.then(async()=>{
      for(const item of active)item.controller.abort(new Error('Code Context operation cancelled'))
      await Promise.allSettled([...active].map(item=>item.done))
      return fn()
    }).finally(()=>{stopping--})
    controls=next.catch(()=>{});return next
  }
  const methods:Pick<CodeRetrievalService,'configure'|'cancel'|'clear'|'close'>={
    async configure(patch){const captured=structuredClone(patch);configuration(captured,config);await control(async()=>{if(closed)throw new Error('Code Context is closed');config=configuration(captured,config);telemetry.reset()});return telemetry.status()},
    async cancel(){await control(async()=>{});return telemetry.status()},
    async clear(){await control(async()=>{if(closed)throw new Error('Code Context is closed');await store.open(config.maxDiskBytes);store.clear();telemetry.reset()});return telemetry.status()},
    async close(){if(closed)return;await control(async()=>{store.close();closed=true})},
  }
  return {get config(){return config},get closed(){return closed},get stopping(){return stopping},get activeJobs(){return active.size},
    hasForeignOperation(sessionId:string){return [...active].some(item=>item.sessionId!==sessionId)},admit,operation,control,...methods}
}
export type ConfigurationOwner=ReturnType<typeof createConfiguration>
