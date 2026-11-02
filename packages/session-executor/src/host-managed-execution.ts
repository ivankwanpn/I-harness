import type {SessionService} from './service.ts'
import type {ManagedExecutionAttachment} from '../../session-persistence/src/execution-internal.ts'

export type OriginalManagedRuntime=Readonly<{execution:ManagedExecutionAttachment;domain:import('@i-harness/core-session/internal/execution').ManagedExecutionDomain;tools:import('@i-harness/core-tools').ToolRegistry;assertCurrent():void}>
type Owner={read(id:string):ManagedExecutionAttachment|undefined;runtime(id:string):OriginalManagedRuntime|undefined;prepareRuntime(id:string):Promise<OriginalManagedRuntime|undefined>;retain(id:string,execution:ManagedExecutionAttachment,cleanup:()=>Promise<void>):void}
const owners=new WeakMap<SessionService,Owner>()
/** Internal first-party lookup only; never constructs or publishes a runtime. */
export function associateOriginalManagedExecution(service:SessionService,owner:Owner){if(owners.has(service))throw TypeError('Original managed execution already associated');owners.set(service,owner)}
export function originalManagedExecutionFor(service:SessionService,id:string):ManagedExecutionAttachment|undefined{return owners.get(service)?.read(id)}
export function originalManagedRuntimeFor(service:SessionService,id:string):OriginalManagedRuntime|undefined{return owners.get(service)?.runtime(id)}
export function prepareOriginalManagedRuntime(service:SessionService,id:string):Promise<OriginalManagedRuntime|undefined>{const owner=owners.get(service);if(!owner)return Promise.reject(TypeError('Original managed execution unavailable'));return owner.prepareRuntime(id)}
export function retainManagedExecutionCleanup(service:SessionService,id:string,execution:ManagedExecutionAttachment,cleanup:()=>Promise<void>):void{const owner=owners.get(service);if(!owner)throw TypeError('Original managed execution unavailable');owner.retain(id,execution,cleanup)}
