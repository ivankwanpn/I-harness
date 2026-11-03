import {assertManagedExecutionSession} from '@i-harness/core-session/internal/execution'
import {isManagedExecutionAttachment,type ManagedExecutionAttachment} from '../../session-persistence/src/execution-internal.ts'
import type {InstructionEnvironment} from '../../session-executor/src/context/instructions/contracts.ts'
import type {AuthorityState} from '@i-harness/sandbox'

/** The Desktop host owns the shared instruction environment; each runtime
 * retains only its own availability fence, not the shared watch lifetime. */
export function createOwnedGatewayInstructions(options:{workspace:string;environment:InstructionEnvironment;authorityFor(id:string):Promise<()=>AuthorityState>}) {
 return async (sessionId:string,execution:ManagedExecutionAttachment,retain:(cleanup:()=>void|Promise<void>)=>void) => {
  if(!isManagedExecutionAttachment(execution))throw TypeError('Original execution attachment required')
   assertManagedExecutionSession(execution.identity,execution.owner,sessionId)
  const observation=execution.observe();observation.assertCurrent()
  let retired=false
  retain(()=>{retired=true})
  const authority=await options.authorityFor(sessionId)
  observation.assertCurrent()
  if(retired)throw Error('Original instruction binding retired')
  return {environment:options.environment,cwd:options.workspace,authority,available:()=>!retired}
 }
}
