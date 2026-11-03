import type {PreparedCall} from '@i-harness/core-tools'
const barriers=new WeakMap<PreparedCall,ReturnType<typeof Promise.withResolvers<void>>>()
/** Issued only for the actual retained model member. */
export function reserveTeamResultBarrier(prepared:PreparedCall):Promise<void>{if(barriers.has(prepared))throw TypeError('Original Team result already reserved');const pending=Promise.withResolvers<void>();barriers.set(prepared,pending);return pending.promise}
/** The original batch record calls this only after the tool/result ACK. */
export function acknowledgeTeamResult(prepared:PreparedCall):void{const pending=barriers.get(prepared);if(pending){barriers.delete(prepared);pending.resolve()}}
