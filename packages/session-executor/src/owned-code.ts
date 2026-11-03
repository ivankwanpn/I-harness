import {registerCodeMode,type CodeModeConfig,type CodeModeMount} from '@i-harness/code-mode'
import type {ContextCapture,ContextOutputService} from '@i-harness/context-output'
import type {ManagedRegistryConstruction} from './managed-assembly.ts'
import {createCodeTextRetention} from './lifecycle/code-text-retention.ts'
import {createCodeFinalOutputRetention} from './lifecycle/code-final-output-retention.ts'

/** The caller retains the output lease before invoking this mount. */
export interface OwnedCodeOutput {
 readonly service:ContextOutputService
 sourceFor(sessionId:string):Promise<ContextCapture['source']>
}
export async function mountOwnedCode(original:ManagedRegistryConstruction,output:OwnedCodeOutput,config:CodeModeConfig):Promise<CodeModeMount>{
 original.assertCurrent()
 const mount=registerCodeMode(original.ctx,original.tools,{kind:'managed-execution',execution:original.execution,domain:original.domain,sessionId:original.domain.sessionId,config,
  retainText:createCodeTextRetention({service:output.service,sourceFor:output.sourceFor,sessionId:original.domain.sessionId}),
  finalOutput:createCodeFinalOutputRetention({service:output.service,sourceFor:output.sourceFor})})
 original.retain(()=>mount.dispose())
 await mount.ready?.()
 original.assertCurrent()
 return mount
}
