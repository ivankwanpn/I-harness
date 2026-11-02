import type {SessionService} from './service.ts'
const owners=new WeakMap<SessionService,(id:string)=>Promise<boolean>>()
export function associateOriginalTeamRetry(service:SessionService,retry:(id:string)=>Promise<boolean>){if(owners.has(service))throw TypeError('Original Team retry already associated');owners.set(service,retry)}
/** Retries only an existing retained original Team recovery, if present. */
export function retryOriginalTeamRecovery(service:SessionService,id:string):Promise<boolean>{return owners.get(service)?.(id)??Promise.resolve(false)}
