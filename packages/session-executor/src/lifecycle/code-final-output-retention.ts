import { createCodeOutputManifest } from '@i-harness/output-retention'
import { supportsManagedResultRefusal } from '@i-harness/context-output'
import type { CodeFinalOutputFactory } from '../../../code-mode/src/final-output.ts'
import type { ContextCapture, ContextOutputService, ResultArtifactScope } from '@i-harness/context-output'

/** Constructor opt-in only. ROOT composes the existing main/child mounts;
 * no model member, source issuer or delivery endpoint is installed here. */
export function createCodeFinalOutputRetention(options: {
  service: ContextOutputService
  sourceFor(sessionId:string): Promise<ContextCapture['source']>
}): CodeFinalOutputFactory {
  const service=options.service, sourceFor=options.sourceFor.bind(options)
  const register=service.registerResultScope.bind(service),begin=service.beginResult.bind(service),confirm=service.confirmResultOwner.bind(service)
  return input => {
    if(!supportsManagedResultRefusal(service))return {async append(){},seal(){},async finish(){return {kind:'unavailable',reason:'unsupported-owner'}}}
    const {cellId,sessionId,sourceId}=input,assertHeld=input.assertHeld.bind(input)
    // Retain the original source lookup promise before any possible reentry.
    const source=sourceFor(sessionId)
    void source.catch(()=>{})
    let scope:ResultArtifactScope|undefined
    return createCodeOutputManifest({version:1,kind:'code-output',sessionId,cellId,sourceId},{
      async supported(){assertHeld();const original=await source;assertHeld();return !!original?.sourceId},
      async open() {
        assertHeld()
        const original=await source
        assertHeld()
        scope ??= register({operationId:sourceId,sessionId,callId:cellId,...(original?{source:original}:{})},()=>{assertHeld();return true})
        return begin(scope,'code-output-manifest-v1')
      },
      async confirm(ref) {assertHeld();if(!scope)throw new Error('Original Code retention scope unavailable');await confirm(scope,ref);assertHeld()},
    })
  }
}
