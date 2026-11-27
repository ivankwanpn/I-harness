import {isHeldFactOwner,type HeldFactOwner,type PersistenceBackend} from '@i-harness/session-persistence'
import {validJournalPrefix,type JournalPrefix,type SessionEventView} from '@i-harness/core-session'
import type {OriginalWriterDependencyScope} from '@i-harness/core-session/internal/execution'
import type {createArchiveReadOwner} from './archive-read-owner.ts'
import {readSessionArchive} from './archive-reader.ts'
import type {RestoredArchiveFraming,VerifiedArchiveBody} from './verified-archive-body.ts'
import {types} from 'node:util'
import {associateExecutionDependencies} from '../../../session-persistence/src/execution-internal.ts'

type Opener=(id:string,held:HeldFactOwner,prefix:Readonly<JournalPrefix>)=>OriginalWriterDependencyScope
const owners=new WeakMap<object,Opener>()
/** Private original JSONL construction. This read port cannot issue facts. */
export function associateOwnedExecutionReader(backend:PersistenceBackend,ports:{assertOriginal():void;filePath(id:string):string;assertNotDeleted(kind:string,id:string):Promise<void>;archive:ReturnType<typeof createArchiveReadOwner>;register(id:string,held:HeldFactOwner):void;settleBirth(id:string,held:HeldFactOwner):Promise<void>;qualify(id:string,held:HeldFactOwner,prefix:Parameters<NonNullable<Parameters<typeof readSessionArchive>[3]>>[0]):Promise<void>}){
 if(owners.has(backend))throw TypeError('Owned dependency reader already associated')
 const verifiedBodies=new WeakMap<HeldFactOwner,{ body: VerifiedArchiveBody; restored?: RestoredArchiveFraming }>()
 owners.set(backend,(id,held,prefix)=>{
  ports.assertOriginal();if(!isHeldFactOwner(held)||held.owner.sessionId!==id)throw TypeError('Original held writer required')
  if(!prefix||types.isProxy(prefix)||![Object.prototype,null].includes(Object.getPrototypeOf(prefix))||Reflect.ownKeys(prefix).length!==3||['eventCount','bodyBytes','prefixDigest'].some(key=>{const field=Object.getOwnPropertyDescriptor(prefix,key);return !field||!('value'in field)||!field.enumerable})||!validJournalPrefix(prefix))throw TypeError('Original writer prefix required')
  const expected=Object.freeze({...prefix}),assertHeld=held.assertHeld.bind(held),descriptor=Object.getOwnPropertyDescriptor(held,'assertHeld')!
  const check=()=>{ports.assertOriginal();if(Object.getOwnPropertyDescriptor(held,'assertHeld')?.value!==descriptor.value)throw TypeError('Changed held writer');assertHeld()}
  ports.register(id,held)
  const original=ports.archive.openHeld(ports.filePath(id),check)
  const readEvents=async(ordinals:readonly number[]):Promise<readonly SessionEventView[]>=>{
   original.assertCurrent()
   if(!Array.isArray(ordinals)||types.isProxy(ordinals)||ordinals.length>expected.eventCount)throw RangeError('Invalid dependency selection')
   const requested:number[]=[]
   for(let index=0;index<ordinals.length;index++){
    const field=Object.getOwnPropertyDescriptor(ordinals,index),ordinal=field?.value
    if(!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=expected.eventCount)throw RangeError('Dependency ordinal out of bounds')
    requested.push(ordinal)
   }
   const selected=new Set(requested)
   if(selected.size!==requested.length)throw RangeError('Duplicate dependency ordinal')
   if(!requested.length)return []
   const observation=await original.read(async(handle,extent)=>{
    await ports.assertNotDeleted('session',id);check()
    const prior = verifiedBodies.get(held)
    const result=await readSessionArchive(handle,extent,false,birth=>ports.qualify(id,held,birth),{
     ordinals:selected,prefix:expected,assertCurrent:check,held:true,...(prior?.restored ? {restored:prior.restored} : {verified:prior?.body}),
    })
    if(result.header.sessionId!==id)throw Error('Owned dependency header mismatch')
    const records=new Map(result.events.map(event=>[event.seq,event]))
    await ports.assertNotDeleted('session',id);check()
    const events=requested.map(ordinal=>{
     const event=records.get(ordinal)
     if(!event)throw Error('Owned dependency ordinal mismatch')
     return event
    })
    return {events,verified:result.verified}
   })
   original.assertCurrent()
   const latest=verifiedBodies.get(held)
   if(observation.verified&&(!latest||latest.body.prefix.bodyBytes<=expected.bodyBytes))verifiedBodies.set(held,{body:observation.verified})
   return observation.events
  }
  const scope:OriginalWriterDependencyScope=Object.freeze({assertCurrent(){if(this!==scope)throw TypeError('Foreign dependency receiver');original.assertCurrent()},async readEvent(ordinal:number){
   if(this!==scope)throw TypeError('Foreign dependency receiver')
   return (await readEvents([ordinal]))[0]!
  },readEvents(ordinals:readonly number[]){
   if(this!==scope)throw TypeError('Foreign dependency receiver')
   return readEvents(ordinals)
  },async close(){if(this!==scope)throw TypeError('Foreign dependency receiver');const errors:unknown[]=[];try{await original.close()}catch(error){errors.push(error)}try{await ports.settleBirth(id,held)}catch(error){errors.push(error)}if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'Owned dependency cleanup unresolved')}})
  return scope
 })
 associateExecutionDependencies(backend,(id,held,prefix)=>openOwnedExecutionDependencies(backend,id,held,prefix))
 return (id: string, held: HeldFactOwner, restored: RestoredArchiveFraming) => {
  ports.assertOriginal()
  if (!isHeldFactOwner(held) || held.owner.sessionId !== id) return
  held.assertHeld()
  if (!verifiedBodies.has(held)) verifiedBodies.set(held, { body: restored.body, restored })
 }
}
export function openOwnedExecutionDependencies(backend:object,id:string,held:HeldFactOwner,prefix:Readonly<JournalPrefix>):OriginalWriterDependencyScope{
 const open=owners.get(backend);if(!open)throw TypeError('Original dependency backend required');return open(id,held,prefix)
}
