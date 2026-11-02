import { assertOriginalExecPair, createWorkflowStepFactory } from '@i-harness/exec/direct-reservation'
export function createScopedWorkflowExec(pair: Parameters<typeof createWorkflowStepFactory>[0], cwd: string, policy: () => SandboxExecutionPolicy | undefined) {
  return createWorkflowStepFactory(pair, command => ({ ...command, cwd: command.cwd ?? cwd, sandbox: command.sandbox ?? policy() }))
}
import { bindPreparedShellLeaf } from '@i-harness/core-tools'
import { createExecDeliveryOwner } from './lifecycle/exec-delivery-owner.ts'
import type { ExecCommand, ExecResult, ExecService, ExecStreamRunOptions, PromotedRun } from "@i-harness/exec"
import type { SandboxExecutionPolicy } from "@i-harness/sandbox"

/** Background/search consumers share live standing policy. A tool that already
 * resolved approval carries its own snapshot, which this adapter preserves. */
export function createScopedExec(base: ExecService, cwd: string, policy: () => SandboxExecutionPolicy | undefined): ExecService {
  const commandFor = (command: ExecCommand): ExecCommand => ({ ...command, cwd: command.cwd ?? cwd, sandbox: command.sandbox ?? policy() })
  return scopedService(base,cwd,policy,commandFor)
}
function scopedService(base:ExecService,cwd:string,policy:()=>SandboxExecutionPolicy|undefined,commandFor:(command:ExecCommand)=>ExecCommand):ExecService {
  function run(command: ExecCommand): Promise<ExecResult>
  function run(command: ExecCommand, options: ExecStreamRunOptions): Promise<ExecResult>
  function run(command: ExecCommand, options: Parameters<ExecService["run"]>[1]): Promise<ExecResult | PromotedRun>
  function run(command: ExecCommand, options?: Parameters<ExecService["run"]>[1] | ExecStreamRunOptions): Promise<ExecResult | PromotedRun> {
    const scoped = commandFor(command)
    if (options === undefined) return base.run(scoped)
    return "stream" in options ? base.run(scoped, options) : base.run(scoped, options)
  }
  return {
    ...base,
    run,
    runBackground: (command) => base.runBackground(commandFor(command)),
    launchTransport: request => base.launchTransport({ ...request, cwd: request.cwd ?? cwd, sandbox: request.sandbox ?? policy() }),
  }
}

/** Original contexts select only explicitly constructed scoped pairs, including inherited leaves. */
const directContexts = new WeakMap<import('@i-harness/core-plugin').PluginContext, (claim:import('@i-harness/core-tools').PreparedShellBodyClaim)=>Pick<ExecService,'run'|'runBackground'>>()
/** Privileged composition requires the actual paired constructor value. */
export function createScopedExecWithReservation(pair: ReturnType<typeof import('@i-harness/exec/direct-reservation').createExecServiceWithReservation>, cwd:string,
  policy:()=>SandboxExecutionPolicy|undefined, prepare:import('./lifecycle/exec-delivery-owner.ts').PrepareExecDelivery,
  context?:import('@i-harness/core-plugin').PluginContext) {
  assertOriginalExecPair(pair)
  const commandFor=(command:ExecCommand):ExecCommand=>({...command,cwd:command.cwd??cwd,sandbox:command.sandbox??policy()})
  const service=scopedService(pair.service,cwd,policy,commandFor)
  const claimRun=(claim:import('@i-harness/core-tools').PreparedShellBodyClaim)=>{
    let used=false
    async function start(command:ExecCommand,mode:'foreground'|'background',options?:import('@i-harness/exec').ExecRunOptions){
      if(used)throw new Error('Direct Shell run already consumed');used=true
      claim.assertCurrent();claim.consume()
      const issuer=claim.takeExecSourceIssuer()
      if(!issuer)throw new Error('Original model Exec issuer required')
      const reservation=pair.port.reserve(),instanceId=pair.port.instanceId(reservation)
      let owner:ReturnType<typeof createExecDeliveryOwner>|undefined,installed=false,started=false
      try{
        owner=createExecDeliveryOwner(issuer,{view:claim.context.view,sessionId:claim.context.sessionId??claim.exec.sessionId!,callId:claim.exec.callId!,callSeq:claim.exec.callEventSeq!,sourceId:instanceId},mode==='background'?'parent':'tool',prepare)
        pair.port.attachDelivery(reservation,owner);installed=true
        const scoped=commandFor(command)
        claim.assertCurrent();issuer.assertAdmissionCurrent()
        started=true
        return await pair.port.start(reservation,scoped,mode,options)
      }catch(cause){
        if(!started)try{
          if(installed)await pair.port.abortDelivery(reservation)
          else{if(owner){owner.failed(undefined);await owner.close()};pair.port.release(reservation)}
        }catch(cleanup){throw new AggregateError([cause,cleanup],'Direct Shell preparation and cleanup failed')}
        else if(owner){
          owner.failed(undefined)
          try{await owner.close()}catch(cleanup){throw new AggregateError([cause,cleanup],'Direct Shell execution and source cleanup failed')}
        }
        throw cause
      }
    }
    const run=Object.freeze({
      run(command:ExecCommand,options?:import('@i-harness/exec').ExecRunOptions){if(this!==run)throw new Error('Foreign direct Shell receiver');return start(command,'foreground',options)},
      runBackground(command:ExecCommand){if(this!==run)throw new Error('Foreign direct Shell receiver');return start(command,'background')},
    }) as Pick<ExecService,'run'|'runBackground'>
    return run
  }
  if(context){if(directContexts.has(context))throw new Error('Original scoped Exec already constructed');directContexts.set(context,claimRun)}
  const direct=(tool:import('@i-harness/core-tools').Tool,leaf:import('@i-harness/core-tools').Tool['execute'])=>{
    const entry=bindPreparedShellLeaf(tool,leaf)
    const directEntry=Object.freeze({enter(exec:import('@i-harness/core-tools').ToolExec){
      if(this!==directEntry)throw new Error('Foreign direct entry receiver')
      const claim=entry.enter(exec)
      if(!claim||!claim.hasExecSourceIssuer())return
      const original=context?directContexts.get(claim.context.context):claimRun
      if(!original)throw new Error('Original scoped Exec context unavailable')
      return original(claim)
    }})
    return directEntry
  }
  return {service,direct}
}
