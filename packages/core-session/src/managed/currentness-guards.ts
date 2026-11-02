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
