import type {ManagedRegistryConstruction} from '../../session-executor/src/managed-assembly.ts'
import {createIsolatedInstructionHost} from '../../session-executor/src/context/instructions/isolated.ts'

/** Use the exact configured instruction binding already held by the original
 * managed manager. The returned factory is the real isolated review owner. */
export async function createOwnedGatewayGuardianInstructions(original:ManagedRegistryConstruction) {
 original.assertCurrent()
 const binding=original.instructions
 if(!binding)throw Error('Original configured instructions required for Guardian')
 let retired=false
 const host=createIsolatedInstructionHost({environment:binding.environment,cwd:binding.cwd,authority:binding.authority,available:()=>!retired&&binding.available()})
 try{original.retain(async()=>{retired=true;await host.close()})}catch(error){host.retire();try{await host.close()}catch(cleanup){throw new AggregateError([error,cleanup],'Guardian instruction retention failed',{cause:error})}throw error}
 original.assertCurrent()
 return host.create
}
