import { randomUUID } from 'node:crypto'
import { settlementSourceSessionId } from '@i-harness/core-session'
import { assertResultPrepared, assertPreparedExecutionOwnerContext, assertSyntheticResult, resultPresentation, toolResultDependencies, type ToolResultRetention } from '@i-harness/core-tools'
import { createResultCapture } from '@i-harness/output-retention'
import type { ContextCapture, ContextOutputService, ResultArtifactScope } from '@i-harness/context-output'
import { bindResultSource, resultSourceBinding } from './result-sources.ts'
import { withResultDependencies } from './result-dependencies.ts'
import {assertManagedSyntheticResult} from '../../../core-tools/src/registry/result-finalization.ts'

/** Composition binds source capabilities to the single workspace result owner. */
export function createToolResultRetention(service: ContextOutputService | undefined, sourceFor?: (sessionId: string) => Promise<ContextCapture['source']>, _ownerSessionId?: string): ToolResultRetention {
  const preparedSources = new WeakMap<object, Map<string, ContextCapture['source']>>()
  return {
    async prepareManaged(prepared,domain){
      const original=assertResultPrepared(prepared)
      if(original.domain!==domain||!original.source||prepared.exec.sessionId!==domain.sessionId)throw TypeError('Original private result owner required')
      const descriptor=service?await sourceFor?.(domain.sessionId):undefined
      const current=assertResultPrepared(prepared)
      if(current.domain!==domain||current.source!==original.source)throw TypeError('Original private result owner changed')
      bindResultSource(prepared.exec,{...original,prepared,sessionId:domain.sessionId,callId:prepared.exec.callId,descriptor})
    },
    async prepare(prepared, executionOwner) {
      assertPreparedExecutionOwnerContext(prepared, executionOwner)
      const original = assertResultPrepared(prepared)
      const sessionId = prepared.exec.sessionId
      const descriptor = sessionId && service ? await sourceFor?.(sessionId) : undefined
      assertPreparedExecutionOwnerContext(prepared, executionOwner)
      assertResultPrepared(prepared)
      bindResultSource(prepared.exec, { ...original, sessionId, callId: prepared.exec.callId, descriptor, ...(executionOwner ? {executionOwner} : {}) })
      if (original.source && prepared.exec.callId) {
        let calls = preparedSources.get(original.source)
        if (!calls) preparedSources.set(original.source, calls = new Map())
        calls.set(prepared.exec.callId, descriptor)
      }
    },
    capture(prepared, output, execution) {
      const original = assertResultPrepared(prepared), operationId = randomUUID()
      const sessionId = prepared.exec.sessionId
      let scope: ResultArtifactScope | undefined, catalogScope: ResultArtifactScope | undefined
      const descriptor = resultSourceBinding(prepared.exec)?.descriptor
      const primary = createResultCapture(output, execution, { presentation: resultPresentation(prepared), async openArtifact() {
        if (!service || !sessionId || !original.source || !original.view&&!original.domain) throw Object.assign(new Error('Result owner unavailable'), { code: 'ARTIFACT_OWNER_UNSUPPORTED' })
        scope ??= service.registerResultScope({ operationId, sessionId, callId: prepared.exec.callId!, ...(descriptor ? { source: descriptor } : {}) }, () => {
          assertResultPrepared(prepared)
          return true
        })
        return service.beginResult(scope, 'json-utf8-v1')
      } })
      const catalogId = randomUUID()
      return withResultDependencies(primary, toolResultDependencies(prepared.exec), async entries => {
        if (!service || !sessionId || !original.source || !original.view&&!original.domain) throw Object.assign(new Error('Result dependency owner unavailable'), { code: 'ARTIFACT_OWNER_UNSUPPORTED' })
        catalogScope ??= service.registerResultDependencyScope({ operationId: catalogId, sessionId, callId: prepared.exec.callId!, ...(descriptor ? { source: descriptor } : {}) }, () => { assertResultPrepared(prepared); return true }, entries)
        return service.beginResult(catalogScope, 'json-utf8-v1')
      }, ref => service && catalogScope ? service.settleResultDependencyMembership(catalogScope, ref) : Promise.resolve('recovery-required'))
    },
    captureSynthetic(context, output, execution) {
      assertSyntheticResult(context)
      const operationId = randomUUID()
      const sessionId = settlementSourceSessionId(context.view, context.source)
      const calls = preparedSources.get(context.source)
      // Resolve once from the authenticated original owner. Preparation already
      // captured this descriptor for dispatched failures; unknown-tool failures
      // have no prepared call and acquire it once at their original capture.
      const descriptor = calls?.has(context.callId) ? Promise.resolve(calls.get(context.callId)) : sessionId && service ? sourceFor?.(sessionId) : undefined
      let scope: ResultArtifactScope | undefined
      return createResultCapture(output, execution, { async openArtifact() {
        if (!service || !sessionId) throw Object.assign(new Error('Result owner unavailable'), { code: 'ARTIFACT_OWNER_UNSUPPORTED' })
        const source = await descriptor
        scope ??= service.registerResultScope({ operationId, sessionId, callId: context.callId, ...(source ? { source } : {}) }, () => { assertSyntheticResult(context); return true })
        return service.beginResult(scope, 'json-utf8-v1')
      } })
    },
    captureManagedSynthetic(context,output,execution){
      assertManagedSyntheticResult(context)
      const operationId=randomUUID(),sessionId=context.domain.sessionId
      const descriptor=service?sourceFor?.(sessionId):undefined
      let scope:ResultArtifactScope|undefined
      return createResultCapture(output,execution,{async openArtifact(){
        if(!service)throw Object.assign(new Error('Result owner unavailable'),{code:'ARTIFACT_OWNER_UNSUPPORTED'})
        const source=await descriptor;assertManagedSyntheticResult(context)
        scope??=service.registerResultScope({operationId,sessionId,callId:context.callId,...source?{source}:{}},()=>{assertManagedSyntheticResult(context);return true})
        return service.beginResult(scope,'json-utf8-v1')
      }})
    },
  }
}
