import {ensureReviewerRole,registerGuardian,type GuardianConfig} from '@i-harness/guard-approval'
import type {RegisterSubagentResult} from '@i-harness/subagent'
import type {ManagedRegistryConstruction} from '../../session-executor/src/managed-assembly.ts'
import {createOwnedGatewayGuardianInstructions} from './owned-gateway-guardian-instructions.ts'

type Config=Omit<GuardianConfig,'execution'|'parentSession'|'managedParent'|'parentRegistry'|'parentCtx'|'subagents'|'createIsolatedInstructionContext'>
/** Desktop's configured isolated Guardian on the same original Task owners.
 * Public/subagent Guardian remains on complete compatibility. */
export async function mountOwnedGatewayGuardian(original:ManagedRegistryConstruction,task:RegisterSubagentResult,config:Config) {
 original.assertCurrent()
 const createIsolatedInstructionContext=await createOwnedGatewayGuardianInstructions(original);original.assertCurrent()
 ensureReviewerRole(task.roles)
 const descriptors=Object.getOwnPropertyDescriptors(config)
 for(const field of Object.values(descriptors))if(field.get){const get=field.get;field.get=()=>Reflect.apply(get,config,[])}
 const actual=Object.defineProperties({}, {...descriptors,...Object.getOwnPropertyDescriptors({execution:'isolated' as const,managedParent:{domain:original.domain},parentRegistry:original.tools,parentCtx:original.ctx,subagents:{roles:task.roles,jobs:task.jobs,table:task.table,agents:task.agents},createIsolatedInstructionContext})}) as GuardianConfig
 await registerGuardian(original.ctx,actual);original.assertCurrent()
}
