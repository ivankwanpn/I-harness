import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'
import type { ColdFinalization, ColdTargetAccess, OriginalColdBootstrap, OriginalColdQualifiers, ColdAdoptedOutcome } from './cold-finalization-types.ts'
import type { ColdSelectedTarget } from './cold-selected-target.ts'
import type { SessionBindingObservation, SessionMeta } from './types.ts'
const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!
const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener

function methods<T extends object>(original:T,names:readonly (keyof T)[]):T {
 if(!original||types.isProxy(original))throw TypeError('Original cold constructor required')
 const descriptors=Object.getOwnPropertyDescriptors(original),result={} as T
 for(const name of names){const d=descriptors[name as string];if(!d||!('value'in d)||typeof d.value!=='function'||types.isProxy(d.value))throw TypeError('Original cold method required')
  Object.defineProperty(result,name,{value:(...args:unknown[])=>{const now=Object.getOwnPropertyDescriptor(original,name);if(!now||!('value'in now)||now.value!==d.value)throw TypeError('Changed cold constructor');return Reflect.apply(d.value,original,args)}})
 }
 return Object.freeze(result)
}
export interface ColdFinalizationBinding {
 ticket(access:ColdTargetAccess,operations:{revoke():void;close():Promise<void>;retryClose():Promise<void>;assertOutside():void}):{join():Promise<void>;assertCurrent():void;finish():void;scope(metadata:Readonly<SessionMeta>):{use(work:(binding:SessionBindingObservation)=>Promise<void>):Promise<void>;close():Promise<void>}}
}
/** Subordinate state machine; all admission/resources remain binding-owned. */
export function createColdFinalizationFactory(bootstrap:OriginalColdBootstrap,binding:ColdFinalizationBinding,qualifiers?:OriginalColdQualifiers){
 const original=methods(bootstrap,['capture']),attempts=new WeakMap<object,ColdFinalization>(),context=new AsyncLocalStorage<object>()
 let producer=qualifiers&&methods(qualifiers,['begin']),installed=!!producer
 const factory={installQualifiers(value:OriginalColdQualifiers){if(this!==factory)throw TypeError('Invalid cold factory receiver');if(installed)throw Error('Cold qualifiers already installed');producer=methods(value,['begin']);installed=true},begin(target:ColdSelectedTarget,options?:{signal?:AbortSignal}):ColdFinalization{
  if(this!==factory)throw TypeError('Invalid cold factory receiver')
  if(options&&(typeof options!=='object'||types.isProxy(options)))throw TypeError('Invalid cold finalization options')
  const field=options&&Object.getOwnPropertyDescriptor(options,'signal')
  if(field&&!('value'in field))throw TypeError('Invalid cold finalization signal')
  const signal=field?.value as AbortSignal|undefined,isAborted=()=>signal!==undefined&&Reflect.apply(aborted,signal,[])
  const access=original.capture(target);access.assertOutside();if(context.getStore()===access.identity)throw Error('Cold finalization self-use')
  if(isAborted())throw Error('Cold finalization stopped')
  const old=attempts.get(access.identity);if(old)return old
  if(!producer)throw Error('COLD_FINALIZATION_UNSUPPORTED')
  const make=producer
  let phase:'acquiring'|'qualifying'|'sealed'|'settling'|'settled'|'committed'|'closed'='acquiring',revoked=false
  let useFlight:Promise<void>|undefined,settleFlight:Promise<void>|undefined,closeFlight:Promise<void>|undefined,outcome:ColdAdoptedOutcome|undefined
  let scope:ReturnType<ReturnType<ColdFinalizationBinding['ticket']>['scope']>|undefined,qualification:ReturnType<OriginalColdQualifiers['begin']>|undefined
  let qualifierSettled=false,qualifierClosed=false,listener=false,revocationError:{cause:unknown}|undefined
  const outside=()=>{access.assertOutside();if(context.getStore()===access.identity)throw Error('Cold finalization self-use')}
  const check=()=>{if(revoked||isAborted()||phase==='closed')throw Error('Cold finalization revoked');ticket.assertCurrent();access.assertCurrent()}
  const revoke=()=>{if(revoked)return;revoked=true;try{context.run(access.identity,()=>qualification?.revoke())}catch(cause){revocationError={cause}}}
  const finish=()=>{if(listener){Reflect.apply(remove,signal,['abort',revoke]);listener=false}ticket.finish();access.detach(handle);attempts.delete(access.identity)}
  const settleResources=async(close:boolean)=>{
   if(qualification){if(close&&!qualifierClosed){await context.run(access.identity,()=>qualification!.close());qualifierClosed=true;qualifierSettled=true}else if(!qualifierSettled){await context.run(access.identity,()=>qualification!.settle());qualifierSettled=true}}
   await scope?.close();await access.settle()
  }
  const handle:ColdFinalization=Object.freeze({
   use(){if(this!==handle)throw TypeError('Invalid cold finalizer receiver');outside();if(useFlight)return useFlight;check()
    useFlight=Promise.resolve().then(async()=>{await ticket.join();check();await access.use(async cold=>{
     check();scope=ticket.scope(cold.metadata)
     await scope.use(bindingObservation=>context.run(access.identity,async()=>{
      check();phase='qualifying';qualification=methods(make.begin(cold,bindingObservation),['qualify','sealWhileActive','settle','assertSettledCurrent','revoke','close'])
      await qualification.qualify();cold.assertCurrent();bindingObservation.assertCurrent();check();qualification.sealWhileActive();phase='sealed'
     }))
    });check()}).catch(error=>{revoke();throw error});void useFlight.catch(()=>{});return useFlight
   },
   settle(){if(this!==handle)throw TypeError('Invalid cold finalizer receiver');outside();if(settleFlight)return settleFlight
    const flight=(async()=>{if(!useFlight)throw Error('Cold finalization unused');await useFlight;check();if(phase!=='sealed'&&phase!=='settling'&&phase!=='settled')throw Error('Cold finalization unsealed');phase='settling';await settleResources(false);try{check();context.run(access.identity,()=>qualification!.assertSettledCurrent())}catch(error){revoke();throw error}phase='settled'})()
    settleFlight=flight;void flight.finally(()=>{if(settleFlight===flight)settleFlight=undefined}).catch(()=>{});return flight
   },
   retrySettlement(){if(this!==handle)throw TypeError('Invalid cold finalizer receiver');return handle.settle()},
   commitReady(){if(this!==handle)throw TypeError('Invalid cold finalizer receiver');outside();if(outcome)return outcome;check();if(phase!=='settled'||settleFlight||closeFlight)throw Error('Cold finalization not settled');phase='settling'
    try{context.run(access.identity,()=>qualification!.assertSettledCurrent());check();outcome=access.commit();phase='committed';finish();return outcome}catch(error){revoke();throw error}
   },
   close(){if(this!==handle)throw TypeError('Invalid cold finalizer receiver');outside();if(phase==='committed'||phase==='closed')return Promise.resolve();if(closeFlight)return closeFlight;revoke()
    const flight=(async()=>{await useFlight?.catch(()=>{});await settleFlight?.catch(()=>{});await settleResources(true);if(revocationError){const {cause}=revocationError;revocationError=undefined;throw cause}phase='closed';finish()})()
    closeFlight=flight;void flight.finally(()=>{if(closeFlight===flight)closeFlight=undefined}).catch(()=>{});return flight
   },retryClose(){if(this!==handle)throw TypeError('Invalid cold finalizer receiver');return handle.close()},
  })
  const ticket=binding.ticket(access,{revoke,close:()=>handle.close(),retryClose:()=>handle.retryClose(),assertOutside:outside})
  try{access.attach(handle,revoke);attempts.set(access.identity,handle)
   if(signal){Reflect.apply(add,signal,['abort',revoke,{once:true}]);listener=true}
  }catch(error){ticket.finish();access.detach(handle);attempts.delete(access.identity);throw error}
  return handle
 }}
 return Object.freeze(factory)
}
