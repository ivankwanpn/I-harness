import { randomUUID } from 'node:crypto'
import { currentToolResultProducer, registerToolResultDependency, type ToolExec, type ToolResultDependency } from '@i-harness/core-tools'
import { createExecFrameCapture } from '@i-harness/output-retention'
import type { ContextOutputService, ResultArtifactScope } from '@i-harness/context-output'
import type { ExecFrameCapture, ExecResultRetention } from '@i-harness/exec'
import { resultSourceBinding } from './result-sources.ts'

/** The actual native capture token outlives a promoted startup source; it owns
 * storage only and can never invoke a command or acquire new execution rights. */
export function createExecResultRetention(service: ContextOutputService | undefined, previewBytes = 64000): ExecResultRetention {
  const captures = new WeakSet<ExecFrameCapture>(), observers = new WeakMap<ToolExec, WeakMap<ExecFrameCapture, ToolResultDependency>>()
  const origins = new WeakMap<ExecFrameCapture, string>()
  return {
    previewBytes,
    begin(input) {
      const exec = currentToolResultProducer(), binding = exec ? resultSourceBinding(exec) : undefined, operationId = randomUUID()
      let scope: ResultArtifactScope | undefined
      const capture = createExecFrameCapture({ sourceId: input.sourceId, async openArtifact() {
        if (!service || !binding?.source || !binding.view || !binding.sessionId || binding.sessionId !== input.owner.sessionId) throw Object.assign(new Error('Native result owner unavailable'), { code: 'ARTIFACT_OWNER_UNSUPPORTED' })
        scope ??= service.registerResultScope({ operationId, sessionId: binding.sessionId, callId: binding.callId!, ...(binding.descriptor ? { source: binding.descriptor } : {}) }, () => captures.has(capture))
        return service.beginResult(scope, 'exec-frames-v1')
      } })
      captures.add(capture); origins.set(capture, input.owner.sessionId)
      return capture
    },
    observe(capture) {
      const exec = currentToolResultProducer()
      if (!exec || !captures.has(capture)) return
      let byCapture = observers.get(exec)
      if (!byCapture) { byCapture = new WeakMap(); observers.set(exec, byCapture) }
      let observed = byCapture.get(capture)
      if (!observed) {
        const target = resultSourceBinding(exec)?.sessionId, origin = origins.get(capture)
        observed = { sourceId: capture.sourceId, async settle() {
          const result = await capture.settle()
          if (result.kind !== 'ready' || result.dependency.retention.kind !== 'artifact' || !target || !origin || target === origin) return result
          if (!service) return { kind: 'recovery-required' }
          try { await service.grant({ sessionId: origin }, [result.dependency.retention.ref.id], target) }
          catch { return { kind: 'recovery-required' } }
          return result
        } }
        byCapture.set(capture, observed)
      }
      registerToolResultDependency(exec, observed)
    },
  }
}
