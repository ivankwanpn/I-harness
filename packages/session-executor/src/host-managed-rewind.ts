import type {SessionService} from './service.ts'
import type {RewindStore} from '@i-harness/rewind'
import type {SessionEvent} from '@i-harness/core-session'
export type OriginalManagedRewind = {kind:'unavailable'} | {kind:'ready';store:RewindStore;assertCurrent():void;drain():Promise<void>;execute<T>(work:(append:(event:Extract<SessionEvent,{type:'rewind/point'}>)=>Promise<void>)=>Promise<T>,intent?:import('./lifecycle/rewind-intent.ts').RewindIntentHooks):Promise<T>}
const owners=new WeakMap<SessionService,(id:string)=>OriginalManagedRewind|undefined>()
export function associateOriginalManagedRewind(service:SessionService,read:(id:string)=>OriginalManagedRewind|undefined){if(owners.has(service))throw TypeError('Original managed Rewind already associated');owners.set(service,read)}
export function originalManagedRewindFor(service:SessionService,id:string):OriginalManagedRewind|undefined{const read=owners.get(service);return read?.(id)}
