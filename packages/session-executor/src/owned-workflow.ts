import {registerWorkflow,type WorkflowMountHandle} from '@i-harness/workflow'
import type {ManagedRegistryConstruction} from './managed-assembly.ts'
import type {OwnedShellMount,OwnedShellOutput} from './owned-shell.ts'
import {createManagedWorkflowLaunch} from '../../workflow/src/managed-delivery.ts'
import {createWorkflowResultRetention} from './lifecycle/workflow-result-retention.ts'
import {receivedExecutionInputsFor} from './lifecycle/execution-inputs.ts'

/** Original Workflow tools reuse the exact mounted Shell native step owner. */
export function mountOwnedWorkflow(original:ManagedRegistryConstruction,workspace:string,shell:OwnedShellMount,output:OwnedShellOutput):WorkflowMountHandle&{reconcileCapturedHandoffs():Promise<void>}{
 original.assertCurrent();if(!output.sourceFor)throw TypeError('Original Workflow output source required')
 if(original.tools.get('workflow_run')||original.tools.get('workflow_list'))throw Error('Original Workflow tools already registered')
 let cancelRun:((run:import('../../workflow/src/runner.ts').OwnedWorkflowRunHandle)=>void)|undefined
 const recipient=receivedExecutionInputsFor(original.execution).workflowDelivery(original.domain)
 const managed=createManagedWorkflowLaunch(original.domain,createWorkflowResultRetention({service:output.service,sourceFor:output.sourceFor.bind(output),domain:original.domain}),run=>{if(!cancelRun)throw Error('Original Workflow cancellation owner unavailable');cancelRun(run)},async input=>{const prepared=await recipient.prepareWorkflowLaunch(input);if(prepared.kind!=='bound')throw Object.assign(Error('Private Workflow launch unavailable'),{reason:prepared.reason});return prepared})
 const mount=registerWorkflow(original.ctx,original.tools,{workspace,exec:shell.service,steps:shell.workflowSteps,managed:managed.launch,owner:original.domain.sessionId})
 const executor=mount.executor,kill=executor.killJob;cancelRun=run=>{Reflect.apply(kill,executor,[run.jobId])}
 original.retain(async()=>{await managed.close();await mount.unmount()});original.assertCurrent();return Object.assign(mount,{reconcileCapturedHandoffs:managed.reconcileCapturedHandoffs})
}
