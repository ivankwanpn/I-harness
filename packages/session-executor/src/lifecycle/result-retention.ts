import { randomUUID } from 'node:crypto'
import { settlementSourceSessionId } from '@i-harness/core-session'
import { assertResultPrepared, assertSyntheticResult, resultPresentation, toolResultDependencies, type ToolResultRetention } from '@i-harness/core-tools'
import { createResultCapture } from '@i-harness/output-retention'
import type { ContextCapture, ContextOutputService, ResultArtifactScope } from '@i-harness/context-output'
import { bindResultSource, resultSourceBinding } from './result-sources.ts'
import { withResultDependencies } from './result-dependencies.ts'

/** Composition binds source capabilities to the single workspace result owner. */
export function createToolResultRetention(service: ContextOutputService | undefined, sourceFor?: (sessionId: string) => Promise<ContextCapture['source']>, _ownerSessionId?: string): ToolResultRetention {
  const preparedSources = new WeakMap<object, Map<string, ContextCapture['source']>>()
  return {
    async prepare(prepared) {
      const original = assertResultPrepared(prepared)
      const sessionId = prepared.exec.sessionId
      const descriptor = sessionId && service ? await sourceFor?.(sessionId) : undefined
      bindResultSource(prepared.exec, { ...original, sessionId, callId: prepared.exec.callId, descriptor })
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
        if (!service || !sessionId || !original.view || !original.source) throw Object.assign(new Error('Result owner unavailable'), { code: 'ARTIFACT_OWNER_UNSUPPORTED' })
        scope ??= service.registerResultScope({ operationId, sessionId, callId: prepared.exec.callId!, ...(descriptor ? { source: descriptor } : {}) }, () => {
          assertResultPrepared(prepared)
          return true
        })
        return service.beginResult(scope, 'json-utf8-v1')
      } })
      const catalogId = randomUUID()
      return withResultDependencies(primary, toolResultDependencies(prepared.exec), async () => {
        if (!service || !sessionId || !original.view || !original.source) throw Object.assign(new Error('Result dependency owner unavailable'), { code: 'ARTIFACT_OWNER_UNSUPPORTED' })
        catalogScope ??= service.registerResultScope({ operationId: catalogId, sessionId, callId: prepared.exec.callId!, ...(descriptor ? { source: descriptor } : {}) }, () => { assertResultPrepared(prepared); return true })
        return service.beginResult(catalogScope, 'json-utf8-v1')
      })
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
  }
}
