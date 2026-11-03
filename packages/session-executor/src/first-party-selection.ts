import {executionOptionMode} from './service/execution-mode.ts'
import {isOriginalDurableSessionLoader} from './durable-session.ts'
import {types} from 'node:util'
import type {SessionServiceOptions} from './service.ts'

/** First-party preflight is read-only and closes transient resources before
 * resolving. The host owns configuration and hook classification. */
export interface FirstPartySelection {
 readonly options:SessionServiceOptions
 prepare(sessionId:string):Promise<{kind:'managed'|'complete';assertCurrent():void}>
 refresh?(sessionId:string):Promise<void>
 release?(sessionId:string):Promise<void>
}
type Decision=Awaited<ReturnType<FirstPartySelection['prepare']>>
const owners=new WeakMap<SessionServiceOptions,FirstPartySelection>()
function dataMethod(owner:object,key:string){const field=Object.getOwnPropertyDescriptor(owner,key);if(!field||!('value' in field)||typeof field.value!=='function'||types.isProxy(field.value))throw TypeError('Original first-party '+key+' required');return field.value as (...args:any[])=>unknown}
function pinObject(value:unknown,label:string):()=>void {
 if(!value||typeof value!=='object'||types.isProxy(value))throw TypeError('Original '+label+' required')
 const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null&&proto!==Array.prototype)throw TypeError('Original '+label+' must be plain')
 const captured=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(captured)
 return ()=>{const now=Object.getOwnPropertyDescriptors(value);if(Object.getPrototypeOf(value)!==proto||Reflect.ownKeys(now).length!==keys.length||keys.some(key=>{const a=captured[key as keyof typeof captured],b=now[key as keyof typeof now];return !b||a!.value!==b.value||a!.get!==b.get||a!.set!==b.set||a!.enumerable!==b.enumerable||a!.configurable!==b.configurable||a!.writable!==b.writable}))throw Error('Original '+label+' changed')}
}
export function enrollFirstPartySelection(owner:FirstPartySelection):void {
 if(!owner||typeof owner!=='object'||types.isProxy(owner)||!Object.isFrozen(owner))throw TypeError('Original first-party paired product required')
 const productOptions=Object.getOwnPropertyDescriptor(owner,'options')
 if(!productOptions||!('value'in productOptions)||!productOptions.value)throw TypeError('Original first-party paired options required')
 const options=productOptions.value as SessionServiceOptions
 if(types.isProxy(options)||![null,Object.prototype].includes(Object.getPrototypeOf(options))||types.isProxy(owner)||!owner||![null,Object.prototype].includes(Object.getPrototypeOf(owner)))throw TypeError('Original first-party selection required')
 if(owners.has(options))throw TypeError('First-party selection already enrolled')
 for(const key of Reflect.ownKeys(options)) {
  const field=Object.getOwnPropertyDescriptor(options,key)
  if(typeof key!=='string'||!field||!('value'in field))throw TypeError('Original first-party options required')
  if(field.value===undefined)continue
  const mode=Object.getOwnPropertyDescriptor(executionOptionMode,key)?.value
  if(mode===undefined)throw TypeError('Unknown first-party service option: '+key)
  if(mode==='policy'&&field.value!=='required')throw TypeError('Custom model policy requires complete compatibility')
  if(['session','detachedSession','detachedPolicySession','policyDocument','policySession','restoredState'].includes(key))throw TypeError('Custom Session state requires complete compatibility: '+key)
 }
 const runtime=Object.getOwnPropertyDescriptor(options,'managedRuntime')
 if(!runtime||!('value' in runtime)||!runtime.value)throw TypeError('First-party managed runtime required')
 const runtimeChecks=[pinObject(runtime.value,'managed runtime')]
 for(const key of ['team','compact','shellRetention','wslExecution','skills','mcp','pluginMcp','pluginAgents','lsp','preset','additionalTools','guardian']){const field=Object.getOwnPropertyDescriptor(options,key);if(field&&'value'in field&&field.value!==undefined&&field.value!==null&&typeof field.value==='object')runtimeChecks.push(pinObject(field.value,'complete '+key))}
 const extra=Object.getOwnPropertyDescriptor(options,'additionalTools');if(extra&&'value'in extra&&Array.isArray(extra.value))for(const tool of extra.value)runtimeChecks.push(pinObject(tool,'additional tool'))
 for(const key of ['ownedShell','ownedTask','ownedCode','ownedRewind','ownedTitle','compact','tools']){const field=Object.getOwnPropertyDescriptor(runtime.value,key);if(field&&'value'in field&&field.value!==undefined)runtimeChecks.push(pinObject(field.value,'managed '+key));if(key==='tools'&&field&&'value'in field&&Array.isArray(field.value))for(const tool of field.value)runtimeChecks.push(pinObject(tool,'managed tool'))}
 const loader=Object.getOwnPropertyDescriptor(options,'sessionFor'),coordinator=Object.getOwnPropertyDescriptor(options,'coordinator')
 if(loader&&(!('value' in loader)||loader.value!==undefined&&(!coordinator||!('value' in coordinator)||!isOriginalDurableSessionLoader(loader.value,coordinator.value))))throw TypeError('Custom Session loader requires complete compatibility')
 const optionsPrototype=Object.getPrototypeOf(options),prepare=dataMethod(owner,'prepare'),refreshField=Object.getOwnPropertyDescriptor(owner,'refresh'),refresh=refreshField===undefined?undefined:dataMethod(owner,'refresh'),releaseField=Object.getOwnPropertyDescriptor(owner,'release'),release=releaseField===undefined?undefined:dataMethod(owner,'release'),captured=Object.getOwnPropertyDescriptors(options),keys=Reflect.ownKeys(captured)
 const check=()=>{const now=Object.getOwnPropertyDescriptors(options),actual=Reflect.ownKeys(now);if(Object.getPrototypeOf(options)!==optionsPrototype||actual.length!==keys.length||keys.some(key=>{const a=captured[key as keyof typeof captured],b=now[key as keyof typeof now];return !b||!('value'in b)||b.value!==a!.value||b.writable!==a!.writable||b.enumerable!==a!.enumerable||b.configurable!==a!.configurable}))throw Error('Original first-party options changed');for(const validate of runtimeChecks)validate();const product=Object.getOwnPropertyDescriptor(owner,'options');if(!product||!('value'in product)||product.value!==options)throw Error('Original first-party pair changed');if(dataMethod(owner,'prepare')!==prepare||(refresh===undefined?Object.hasOwn(owner,'refresh'):dataMethod(owner,'refresh')!==refresh)||(release===undefined?Object.hasOwn(owner,'release'):dataMethod(owner,'release')!==release))throw Error('Original first-party selector changed')}
 owners.set(options,Object.freeze({options,async prepare(id:string){check();const decision=await Reflect.apply(prepare,owner,[id]);check();const selected=captureFirstPartyDecision(decision);return Object.freeze({kind:selected.kind,assertCurrent(){check();selected.assertCurrent()}})},...(refresh?{async refresh(id:string){check();await Reflect.apply(refresh,owner,[id]);check()}}:{}),...(release?{async release(id:string){if(dataMethod(owner,'release')!==release)throw Error('Original first-party release changed');await Reflect.apply(release,owner,[id])}}:{})}))
}
function captureFirstPartyDecision(value:unknown):Decision {
 if(!value||typeof value!=='object'||types.isProxy(value)||![null,Object.prototype].includes(Object.getPrototypeOf(value)))throw TypeError('Original first-party decision required')
 const field=Object.getOwnPropertyDescriptor(value,'kind'),assert=dataMethod(value,'assertCurrent')
 if(!field||!('value'in field)||(field.value!=='managed'&&field.value!=='complete'))throw TypeError('Original first-party decision kind required')
 const kind=field.value
 return Object.freeze({kind,assertCurrent(){const now=Object.getOwnPropertyDescriptor(value,'kind');if(!now||!('value'in now)||now.value!==kind||dataMethod(value,'assertCurrent')!==assert)throw Error('Original first-party decision changed');const result=Reflect.apply(assert,value,[]);if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});throw TypeError('First-party currentness must be synchronous')}}})
}
export function firstPartySelectionFor(options:SessionServiceOptions):FirstPartySelection|undefined{return owners.get(options)}
