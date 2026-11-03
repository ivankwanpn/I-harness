import type {SessionAssembly} from './assembly.ts'
import type {SessionService} from './service.ts'

/** First-party dual-route host observers see only actual complete assemblies.
 * This internal seam does not alter the public Session-shaped hook contract. */
const registrations=new WeakMap<SessionService,(listener:(assembly:SessionAssembly)=>void,options?:{includeExisting?:boolean})=>()=>void>()
export function associateOriginalHostAssemblyObserver(service:SessionService,register:(listener:(assembly:SessionAssembly)=>void,options?:{includeExisting?:boolean})=>()=>void):void{
 if(registrations.has(service))throw TypeError('Original service observer already associated')
 registrations.set(service,register)
}
export function onOriginalHostAssembly(service:SessionService,listener:(assembly:SessionAssembly)=>void,options?:{includeExisting?:boolean}):()=>void{
 const register=registrations.get(service);if(!register)throw TypeError('Original service required');return register(listener,options)
}
