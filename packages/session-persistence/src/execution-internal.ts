import type {ManagedExecutionIdentity,ManagedExecutionOwner,OriginalWriterDependencyScope,ExecutionObservation,PreparedExecutionRequest} from '@i-harness/core-session/internal/execution'
import type {PreparedConversationArchive} from '@i-harness/core-session/internal/restoration'
import type {JournalPrefix} from '@i-harness/core-session'
import type {HeldFactOwner,ManagedDocument} from './coordinator/fact-types.ts'
export interface ManagedExecutionProducer extends ManagedExecutionOwner {
 beginAction:ManagedDocument['beginAction']
 registerReceivedInputSource:ManagedDocument['registerReceivedInputSource']
}
export interface ManagedExecutionAttachment {
 readonly identity:ManagedExecutionIdentity
 readonly owner:ManagedExecutionProducer
 prepare():Promise<PreparedConversationArchive>
 observe():ExecutionObservation
 prepareRequest(action:ReturnType<ManagedExecutionProducer['beginAction']>):Promise<PreparedExecutionRequest>
 revokeNewWork():void
 close():Promise<void>
}
const readers=new WeakMap<object,(id:string,held:HeldFactOwner,prefix:Readonly<JournalPrefix>)=>OriginalWriterDependencyScope>()
/** Original backend constructor only. This descriptor reader issues no facts. */
export function associateExecutionDependencies(backend:object,open:(id:string,held:HeldFactOwner,prefix:Readonly<JournalPrefix>)=>OriginalWriterDependencyScope){if(readers.has(backend))throw TypeError('Original dependency reader already associated');readers.set(backend,open)}
export function hasExecutionDependencies(backend:object){return readers.has(backend)}
export function openExecutionDependencies(backend:object,id:string,held:HeldFactOwner,prefix:Readonly<JournalPrefix>){const open=readers.get(backend);if(!open)throw TypeError('Original writer dependency reader unavailable');return open(id,held,prefix)}
const acquisitions=new WeakMap<object,{acquire(id:string):Promise<ManagedExecutionAttachment>;assertAdmission(id:string):void}>()
const originalAttachments=new WeakSet<object>()
/** Original acquisition result identity; copied/observational ports cannot enroll. */
export function isManagedExecutionAttachment(execution:object){return originalAttachments.has(execution)}
export function associateManagedExecution(coordinator:object,ports:{acquire(id:string):Promise<ManagedExecutionAttachment>;assertAdmission(id:string):void}){if(acquisitions.has(coordinator))throw TypeError('Original execution acquisition already associated');acquisitions.set(coordinator,{acquire:ports.acquire.bind(ports),assertAdmission:ports.assertAdmission.bind(ports)})}
export async function acquireManagedExecution(coordinator:object,id:string):Promise<ManagedExecutionAttachment>{const original=acquisitions.get(coordinator);if(!original)throw TypeError('Original execution coordinator required');original.assertAdmission(id);const execution=await original.acquire(id);try{original.assertAdmission(id);originalAttachments.add(execution);return execution}catch(primary){try{await execution.close()}catch(cleanup){throw new AggregateError([primary,cleanup],'Execution acquisition admission and cleanup failed')}throw primary}}
