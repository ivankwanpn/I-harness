import {registerExecWithReservation,type ExecExecutionHost,type NativeExecService} from '@i-harness/exec'
import {readOriginalPtyTransport} from '@i-harness/exec/direct-reservation'
import {createShellTools,type ShellToolDeps} from '@i-harness/shell'
import {createApprovalEscalationApprover,resolveWslWorkingDirectory,type ApprovalPrompt} from '@i-harness/sandbox'
import {createContextOutputTools,type ContextOutputService,type ContextCapture,type LegacyReadObservationRunner} from '@i-harness/context-output'
import {createExecutionApprovalPolicy} from '@i-harness/guard-approval'
import {createPreparedTerminalInvocationOwner} from '@i-harness/core-tools/internal/terminal-origin'
import {registerTerminal,type TerminalMountHandle} from '@i-harness/terminal'
import type {ManagedRegistryConstruction} from './managed-assembly.ts'
import {originalFilesystemPolicyFor} from './execution-runtime.ts'
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
export interface OwnedShellOutput {
 readonly service:ContextOutputService
 readonly sourceFor?:(sessionId:string)=>Promise<ContextCapture['source']>
 readonly withLegacyReadObservation?:LegacyReadObservationRunner
}
export interface OwnedShellMount {
 readonly service:import('@i-harness/exec').ExecService
 readonly terminal?:Pick<TerminalMountHandle['service'],'list'|'read'|'close'>
 readonly workflowSteps:import('@i-harness/exec/direct-reservation').WorkflowStepFactory
 listJobViews(): ReturnType<NativeExecService['listJobViews']>
 getJobView: NativeExecService['getJobView']
 killJob: NativeExecService['killJob']
 hasActiveJobs(): boolean
}

export function mountOwnedShell(original:ManagedRegistryConstruction,workspace:string,options:OwnedShellOptions,output:OwnedShellOutput,approvalInstalled:boolean,acquiredExecution?:ExecExecutionHost):OwnedShellMount{
 original.assertCurrent()
 const execution=acquiredExecution??options.executionFor?.(original.domain.sessionId)
 if(!execution)throw TypeError('Original Shell execution unavailable')
 if(execution.defaultOwner?.sessionId!==original.domain.sessionId)throw TypeError('Original Shell execution owner required')
 original.assertCurrent()
 const pair=registerExecWithReservation(original.ctx,{workspaceRoot:workspace,execution,resultRetention:createExecResultRetention(output.service)})
 original.retain(()=>pair.service.dispose())
 const recipient=receivedExecutionInputsFor(original.execution).execDelivery(original.domain)
 const instructions=original.instructions
 const wslDirectory=instructions?()=>resolveWslWorkingDirectory(workspace,instructions.authority()):undefined
 const scoped=createScopedPrivateExecWithReservation(pair,workspace,()=>undefined,original.execution,original.domain,original.ctx,recipient,wslDirectory)
 const nativePolicy=originalFilesystemPolicyFor(execution,original.execution)
 const pty=readOriginalPtyTransport(pair)
 let terminal:TerminalMountHandle|undefined
 if(nativePolicy){
  const originalOwner=execution.defaultOwner
  const invocations=createPreparedTerminalInvocationOwner(original.domain)
  terminal=registerTerminal(original.ctx,original.tools,{
   execService:scoped.service,cwd:workspace,
   sandboxPolicy:()=>nativePolicy.sandboxPolicy(),
   escalationApprover:createApprovalEscalationApprover(()=>original.ctx.services.get<ApprovalPrompt>('approval/answerer')),
   managed:{
    bindInvocation:invocations.bind,
    assertInvocation:invocations.assert,
    launch:pty.launch,
    assertPolicy(policy,admitted){
     if(!policy.authoritySnapshot)throw Error('Original terminal policy required')
     execution.resolvePolicy(originalOwner,policy)
     nativePolicy.assertActiveTransport(admitted)
    },
   },
  })
  const mount=terminal
  original.retain(()=>mount.dispose())
 }
 for(const tool of createShellTools({exec:scoped.service,directEntry:scoped.direct,agentShell:()=>options.agentShellFor?options.agentShellFor(original.domain.sessionId):options.agentShell()}))original.tools.register(tool)
 for(const tool of createContextOutputTools(output.service, {
  exposure: 'direct', withLegacyReadObservation: output.withLegacyReadObservation,
 }))original.tools.register(tool)
 original.tools.promote(['context_output_read'])
 if(!approvalInstalled)createExecutionApprovalPolicy(original.ctx,original.tools,{workspace,workspaceRoots:()=>[workspace]})
 original.assertCurrent()
 const service=terminal?.service
 const terminalView=service?Object.freeze({list:service.list.bind(service),read:service.read.bind(service),close:service.close.bind(service)}):undefined
 const hasActiveTerminal=service?.hasActiveWork.bind(service)
 return Object.freeze({
  service:scoped.service,terminal:terminalView,workflowSteps:createScopedWorkflowExec(pair,workspace,()=>undefined),
  listJobViews:pair.service.listJobViews.bind(pair.service),
  getJobView:pair.service.getJobView.bind(pair.service),
  killJob:pair.service.killJob.bind(pair.service),
  hasActiveJobs:()=>pair.service.hasActiveJobs()||!!hasActiveTerminal?.()||pty.hasPendingCleanup(),
 })
}
