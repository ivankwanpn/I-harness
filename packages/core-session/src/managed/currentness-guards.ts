/** Dependency-neutral constructor association. No paths, authority or successful
 * check results are stored here; an executor recognizes only its exact guards. */
import {types} from 'node:util'
type Guard = () => void
export type OriginalCurrentnessDescriptorRecipe = Readonly<{
  receiver: object
  method: Guard
  before: readonly (readonly [PropertyKey, unknown, string?])[]
  after: readonly (readonly [PropertyKey, unknown, string?])[]
  message: string
}>
export type OriginalCurrentnessExecutor = Readonly<{
  compose(guards: readonly Guard[]): Guard
  immediate(check: Guard): void
  bindDescriptors?(recipe: OriginalCurrentnessDescriptorRecipe): Guard
  read?<T>(operation:()=>T):T
  sourceCheck?(operation:Guard):Guard
}>
const guards = new WeakMap<Guard, OriginalCurrentnessExecutor>()
const functionPrototype=Function.prototype,originalBind=Object.getOwnPropertyDescriptor(functionPrototype,'bind')?.value
export function associateOriginalCurrentnessGuard(guard: Guard, executor: OriginalCurrentnessExecutor): void {
  const previous = guards.get(guard)
  if (previous && previous !== executor) throw TypeError('Original currentness executor changed')
  guards.set(guard, executor)
}
/** Only exact guards from one original executor can yield an enrolled output. */
export function composeOriginalCurrentnessGuards(...checks: readonly Guard[]): Guard | undefined {
  const executor = checks.length ? guards.get(checks[0]!) : undefined
  if (!executor || checks.some(check => guards.get(check) !== executor)) return
  return executor.compose(checks)
}
/** Preserve one original method's receiver and constructor-captured data fields.
 * The recipe contains no callback or caller assertion of local purity. */
export function bindOriginalCurrentnessDescriptors(recipe: OriginalCurrentnessDescriptorRecipe): Guard | undefined {
  if (!recipe || typeof recipe !== 'object' || types.isProxy(recipe)) return
  const fields=Object.getOwnPropertyDescriptors(recipe),keys=['receiver','method','before','after','message'] as const
  if(Reflect.ownKeys(fields).length!==keys.length||keys.some(key=>!fields[key]||!('value'in fields[key]!)))return
  const receiver=fields.receiver!.value,method=fields.method!.value,message=fields.message!.value
  if(!receiver||typeof receiver!=='object'||types.isProxy(receiver)||typeof method!=='function'||typeof message!=='string')return
  const executor = guards.get(method)
  if (!executor?.bindDescriptors) return
  if(types.isProxy(method)||Object.getPrototypeOf(method)!==functionPrototype||Object.getOwnPropertyDescriptor(method,'bind')||Object.getOwnPropertyDescriptor(functionPrototype,'bind')?.value!==originalBind)return
  const copy=(input:unknown):OriginalCurrentnessDescriptorRecipe['before']|undefined=>{
    if(types.isProxy(input)||!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype)return
    const list=Object.getOwnPropertyDescriptors(input) as unknown as PropertyDescriptorMap,length=list.length?.value
    if(typeof length!=='number'||!Number.isSafeInteger(length)||length<0||Reflect.ownKeys(list).length!==length+1)return
    const result:(readonly [PropertyKey,unknown,string?])[]=[]
    for(let index=0;index<length;index++){
      const item=list[String(index)];if(!item||!('value'in item)||types.isProxy(item.value)||!Array.isArray(item.value))return
      const pair=Object.getOwnPropertyDescriptors(item.value) as unknown as PropertyDescriptorMap,key=pair['0'],value=pair['1'],size=pair.length?.value
      if((size!==2&&size!==3)||Reflect.ownKeys(pair).length!==size+1||!key||!value||!('value'in key)||!('value'in value)||!['string','number','symbol'].includes(typeof key.value))return
      const detail=pair['2'];if(size===3&&(!detail||!('value'in detail)||typeof detail.value!=='string'))return
      result.push(Object.freeze(size===3?[key.value,value.value,detail!.value] as const:[key.value,value.value] as const))
    }
    return Object.freeze(result)
  }
  const before=copy(fields.before!.value),after=copy(fields.after!.value);if(!before||!after)return
  return executor.bindDescriptors(Object.freeze({receiver,method,before,after,message}))
}
/** An unknown dependency is never borrowed into an original batching interval. */
export function runUnassociatedCurrentnessChecks(...checks: readonly Guard[]): void {
  const executor = checks.map(check => guards.get(check)).find(value => value !== undefined)
  const run = () => { for (const check of checks) check() }
  if (executor) executor.immediate(run)
  else run()
}
/** Internal original read construction, never an enrollment of the callback.
 * Callers must suspend accumulation around every opaque operation. */
export function runOriginalCurrentnessRead<T>(guard:Guard,operation:()=>T):T {
  const executor=guards.get(guard)
  return executor?.read?executor.read(operation):operation()
}
export function runOpaqueCurrentnessRead<T>(guard:Guard,operation:()=>T):T {
  const executor=guards.get(guard);if(!executor)return operation()
  let result:T;executor.immediate(()=>{result=operation()});return result!
}
/** Only the original source constructor supplies its existing descriptor checks. */
export function wrapOriginalSourceCurrentness(original:Guard,operation:Guard):Guard|undefined {
  return guards.get(original)?.sourceCheck?.(operation)
}
type Reader={kind:'get'|'method';get:(...args:any[])=>unknown;set:unknown;enumerable:boolean|undefined;prototype:object|null;executor:OriginalCurrentnessExecutor}
const readers=new WeakMap<object,Map<PropertyKey,Reader>>()
const factories=new WeakMap<Function,OriginalCurrentnessExecutor>()
export function associateOriginalCurrentnessFactory(factory:Function,executor:OriginalCurrentnessExecutor):void{const previous=factories.get(factory);if(previous&&previous!==executor)throw TypeError('Original reader factory changed');factories.set(factory,executor)}
export function originalCurrentnessFactoryMatches(factory:Function,receiver:object,key:PropertyKey):boolean{const record=originalReader(receiver,key);return !!record&&factories.get(factory)===record.executor}
export function associateOriginalCurrentnessReader(receiver:object,key:PropertyKey,executor:OriginalCurrentnessExecutor):void {
  if(types.isProxy(receiver))throw TypeError('Original metadata receiver required')
  const field=Object.getOwnPropertyDescriptor(receiver,key)
  const method=field?.get??field?.value
  if(!field||typeof method!=='function'||types.isProxy(method))throw TypeError('Original metadata reader required')
  let fields=readers.get(receiver);if(!fields){fields=new Map();readers.set(receiver,fields)}
  fields.set(key,{kind:field.get?'get':'method',get:method,set:field.set,enumerable:field.enumerable,prototype:Object.getPrototypeOf(receiver),executor})
}
function originalReader(receiver:object,key:PropertyKey):Reader|undefined {
  const record=readers.get(receiver)?.get(key);if(!record)return
  const field=Object.getOwnPropertyDescriptor(receiver,key)
  if(!field||(record.kind==='get'?field.get:field.value)!==record.get||field.set!==record.set||field.enumerable!==record.enumerable||Object.getPrototypeOf(receiver)!==record.prototype)return
  return record
}
/** Propagation is by the original receiver/getter identity, never by its value. */
export function propagateOriginalCurrentnessReader(from:object,key:PropertyKey,to:object,toKey:PropertyKey,dependencies:readonly Guard[]=[],readerDependencies:readonly (readonly [object,PropertyKey])[]=[]):void {
  const record=originalReader(from,key);if(!record||dependencies.some(guard=>guards.get(guard)!==record.executor)||readerDependencies.some(([object,field])=>originalReader(object,field)?.executor!==record.executor))return
  associateOriginalCurrentnessReader(to,toKey,record.executor)
}
export function readOriginalCurrentnessMember<T>(guard:Guard,receiver:object,key:PropertyKey):T {
  const record=originalReader(receiver,key),executor=guards.get(guard)
  if(record?.kind==='get'&&record.executor===executor)return Reflect.apply(record.get,receiver,[]) as T
  return runOpaqueCurrentnessRead(guard,()=>Reflect.get(receiver,key)) as T
}
export function bindOriginalCurrentnessMethod(receiver:object,key:PropertyKey):((...args:any[])=>unknown)|undefined {
  const record=originalReader(receiver,key)
  if(record?.kind!=='method'||Object.getPrototypeOf(record.get)!==functionPrototype||Object.getOwnPropertyDescriptor(record.get,'bind')||Object.getOwnPropertyDescriptor(functionPrototype,'bind')?.value!==originalBind)return
  return (...args:any[])=>{if(originalReader(receiver,key)===record)return Reflect.apply(record.get,receiver,args);let value:unknown;record.executor.immediate(()=>{value=Reflect.apply(record.get,receiver,args)});return value}
}
export function callOriginalCurrentnessMethod<T>(guard:Guard,receiver:object,key:PropertyKey,args:readonly unknown[]):T {
  const record=originalReader(receiver,key)
  if(record?.kind==='method'&&record.executor===guards.get(guard))return Reflect.apply(record.get,receiver,args) as T
  return runOpaqueCurrentnessRead(guard,()=>Reflect.apply(Reflect.get(receiver,key),receiver,args)) as T
}
