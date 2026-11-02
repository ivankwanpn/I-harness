import {isHeldFactOwner,type HeldFactOwner,type PersistenceBackend} from '@i-harness/session-persistence'
import {validJournalPrefix,type JournalPrefix} from '@i-harness/core-session'
import type {OriginalWriterDependencyScope} from '@i-harness/core-session/internal/execution'
import type {createArchiveReadOwner} from './archive-read-owner.ts'
import {readSessionArchive} from './archive-reader.ts'
import {types} from 'node:util'
import {associateExecutionDependencies} from '../../../session-persistence/src/execution-internal.ts'

type Opener=(id:string,held:HeldFactOwner,prefix:Readonly<JournalPrefix>)=>OriginalWriterDependencyScope
const owners=new WeakMap<object,Opener>()
/** Private original JSONL construction. This read port cannot issue facts. */
export function associateOwnedExecutionReader(backend:PersistenceBackend,ports:{assertOriginal():void;filePath(id:string):string;assertNotDeleted(kind:string,id:string):Promise<void>;archive:ReturnType<typeof createArchiveReadOwner>;register(id:string,held:HeldFactOwner):void;settleBirth(id:string,held:HeldFactOwner):Promise<void>;qualify(id:string,held:HeldFactOwner,prefix:Parameters<NonNullable<Parameters<typeof readSessionArchive>[3]>>[0]):Promise<void>}){
 if(owners.has(backend))throw TypeError('Owned dependency reader already associated')
 owners.set(backend,(id,held,prefix)=>{
  ports.assertOriginal();if(!isHeldFactOwner(held)||held.owner.sessionId!==id)throw TypeError('Original held writer required')
  if(!prefix||types.isProxy(prefix)||![Object.prototype,null].includes(Object.getPrototypeOf(prefix))||Reflect.ownKeys(prefix).length!==3||['eventCount','bodyBytes','prefixDigest'].some(key=>{const field=Object.getOwnPropertyDescriptor(prefix,key);return !field||!('value'in field)||!field.enumerable})||!validJournalPrefix(prefix))throw TypeError('Original writer prefix required')
  const expected=Object.freeze({...prefix}),assertHeld=held.assertHeld.bind(held),descriptor=Object.getOwnPropertyDescriptor(held,'assertHeld')!
  const check=()=>{ports.assertOriginal();if(Object.getOwnPropertyDescriptor(held,'assertHeld')?.value!==descriptor.value)throw TypeError('Changed held writer');assertHeld()}
  ports.register(id,held)
  const original=ports.archive.openHeld(ports.filePath(id),check)
  const scope:OriginalWriterDependencyScope=Object.freeze({assertCurrent(){if(this!==scope)throw TypeError('Foreign dependency receiver');original.assertCurrent()},async readEvent(ordinal:number){
   if(this!==scope)throw TypeError('Foreign dependency receiver');original.assertCurrent();if(!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=expected.eventCount)throw RangeError('Dependency ordinal out of bounds')
   return original.read(async(handle,extent)=>{await ports.assertNotDeleted('session',id);check();const result=await readSessionArchive(handle,extent,false,birth=>ports.qualify(id,held,birth),{ordinal,prefix:expected,assertCurrent:check});if(result.header.sessionId!==id)throw Error('Owned dependency header mismatch');await ports.assertNotDeleted('session',id);check();return result.events[0]!})
  },async close(){if(this!==scope)throw TypeError('Foreign dependency receiver');const errors:unknown[]=[];try{await original.close()}catch(error){errors.push(error)}try{await ports.settleBirth(id,held)}catch(error){errors.push(error)}if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'Owned dependency cleanup unresolved')}})
  return scope
 })
 associateExecutionDependencies(backend,(id,held,prefix)=>openOwnedExecutionDependencies(backend,id,held,prefix))
}
export function openOwnedExecutionDependencies(backend:object,id:string,held:HeldFactOwner,prefix:Readonly<JournalPrefix>):OriginalWriterDependencyScope{
 const open=owners.get(backend);if(!open)throw TypeError('Original dependency backend required');return open(id,held,prefix)
}
