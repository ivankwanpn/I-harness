import { types } from 'node:util'
import type { OriginalWriterDependencyScope } from './execution-types.ts'

/** Capture the original partially-open scope before any awaited read. Active
 * substitution refuses; cleanup always invokes the retained original method. */
export function captureWriterDependencies(input:OriginalWriterDependencyScope):OriginalWriterDependencyScope {
  const fail=():never=>{throw new TypeError('Original writer dependency scope changed')}
  if(!input||types.isProxy(input))return fail()
  const prototype=Object.getPrototypeOf(input)
  if(prototype!==Object.prototype&&prototype!==null)return fail()
  const batch = Object.getOwnPropertyDescriptor(input, 'readEvents')
  const names=['assertCurrent','readEvent','close', ...(batch ? ['readEvents'] as const : [])] as const
  const fields=names.map(name=>Object.getOwnPropertyDescriptor(input,name))
  if(Reflect.ownKeys(input).length!==names.length||fields.some(field=>!field||!('value'in field)||typeof field.value!=='function'||types.isProxy(field.value)))return fail()
  const current=()=>{
    if(Object.getPrototypeOf(input)!==prototype||Reflect.ownKeys(input).length!==names.length)fail()
    for(let index=0;index<names.length;index++){
      const actual=Object.getOwnPropertyDescriptor(input,names[index]!),original=fields[index]!
      if(!actual||!('value'in actual)||actual.value!==original.value||actual.enumerable!==original.enumerable)fail()
    }
  }
  const assert=fields[0]!.value.bind(input) as OriginalWriterDependencyScope['assertCurrent']
  const read=fields[1]!.value.bind(input) as OriginalWriterDependencyScope['readEvent']
  const close=fields[2]!.value.bind(input) as OriginalWriterDependencyScope['close']
  const readEvents = batch?.value.bind(input) as OriginalWriterDependencyScope['readEvents']
  return Object.freeze({
    assertCurrent(){current();assert();current()},
    async readEvent(ordinal:number){current();assert();const event=await read(ordinal);current();assert();return event},
    ...(readEvents ? { async readEvents(ordinals:readonly number[]) {
      current(); assert()
      const events = await readEvents(ordinals)
      current(); assert()
      if (!Array.isArray(events) || types.isProxy(events) || events.length !== ordinals.length ||
          ordinals.some((ordinal, index) => events[index]?.seq !== ordinal))
        throw new TypeError('Original selected dependency records required')
      return events
    } } : {}),
    close,
  })
}
