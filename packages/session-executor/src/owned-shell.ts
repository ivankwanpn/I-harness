import {registerExecWithReservation,type ExecExecutionHost} from '@i-harness/exec'
import {createShellTools,type ShellToolDeps} from '@i-harness/shell'
import {createContextOutputTools,type ContextOutputService,type ContextCapture} from '@i-harness/context-output'
import {createExecutionApprovalPolicy} from '@i-harness/guard-approval'
import type {ManagedRegistryConstruction} from './managed-assembly.ts'
import {createScopedPrivateExecWithReservation,createScopedWorkflowExec} from './scoped-exec.ts'
import {createExecResultRetention} from './lifecycle/exec-result-retention.ts'
import {receivedExecutionInputsFor} from './lifecycle/execution-inputs.ts'

/** Trusted original resources supplied by the concrete host, with their exact retained cleanup. */
export interface OwnedShellOptions {
 executionFor?(sessionId:string):ExecExecutionHost
 acquireExecution?(sessionId:string,retain:(cleanup:()=>void|Promise<void>)=>void,execution:import('../../session-persistence/src/execution-internal.ts').ManagedExecutionAttachment):Promise<ExecExecutionHost>
 acquireOutput(sessionId:string,retain:(cleanup:()=>void|Promise<void>)=>void):OwnedShellOutput|Promise<OwnedShellOutput>
 agentShell:NonNullable<ShellToolDeps['agentShell']>
 agentShellFor?(sessionId:string):ReturnType<NonNullable<ShellToolDeps['agentShell']>>
}
export interface OwnedShellOutput {readonly service:ContextOutputService;readonly sourceFor?:(sessionId:string)=>Promise<ContextCapture['source']>}
export interface OwnedShellMount {readonly service:import('@i-harness/exec').ExecService;readonly workflowSteps:import('@i-harness/exec/direct-reservation').WorkflowStepFactory}
export function mountOwnedShell(original:ManagedRegistryConstruction,workspace:string,options:OwnedShellOptions,output:OwnedShellOutput,approvalInstalled:boolean,acquiredExecution?:ExecExecutionHost):OwnedShellMount{
 original.assertCurrent()
 const execution=acquiredExecution??options.executionFor?.(original.domain.sessionId)
 if(!execution)throw TypeError('Original Shell execution unavailable')
 if(execution.defaultOwner?.sessionId!==original.domain.sessionId)throw TypeError('Original Shell execution owner required')
 original.assertCurrent()
 const pair=registerExecWithReservation(original.ctx,{workspaceRoot:workspace,execution,resultRetention:createExecResultRetention(output.service)})
 original.retain(()=>pair.service.dispose())
 const recipient=receivedExecutionInputsFor(original.execution).execDelivery(original.domain)
 const scoped=createScopedPrivateExecWithReservation(pair,workspace,()=>undefined,original.execution,original.domain,original.ctx,recipient)
 for(const tool of createShellTools({exec:scoped.service,directEntry:scoped.direct,agentShell:()=>options.agentShellFor?options.agentShellFor(original.domain.sessionId):options.agentShell()}))original.tools.register(tool)
 for(const tool of createContextOutputTools(output.service))original.tools.register(tool)
 original.tools.promote(['context_output_read'])
 if(!approvalInstalled)createExecutionApprovalPolicy(original.ctx,original.tools,{workspace,workspaceRoots:()=>[workspace]})
 original.assertCurrent()
 return Object.freeze({service:scoped.service,workflowSteps:createScopedWorkflowExec(pair,workspace,()=>undefined)})
}
