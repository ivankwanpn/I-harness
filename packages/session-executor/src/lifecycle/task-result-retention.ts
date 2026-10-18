import { createResultCapture } from '@i-harness/output-retention'
import type { ContextCapture, ContextOutputService, ResultArtifactScope } from '@i-harness/context-output'
import type { TaskResultStore } from '@i-harness/subagent'
import type { ResultFinalization } from '@i-harness/core-tools'
import { resultSourceBinding } from './result-sources.ts'

/** The existing task registry mints revisions from real terminal transitions.
 * Its document owns pins; the parent's current source/lineage owns access. */
export function createTaskResultRetention(service: ContextOutputService | undefined, sourceFor: ((sessionId: string) => Promise<ContextCapture['source']>) | undefined, parentSessionId?: string, stateId = parentSessionId): TaskResultStore {
  const build = (bound?: { source: ContextCapture['source']; current?: () => boolean }): TaskResultStore => ({
    ...(!bound ? { async forSource(context?: import('@i-harness/core-tools').ToolExec, current?: () => boolean) {
      const prepared = context ? resultSourceBinding(context) : undefined
      const source = prepared ? prepared.descriptor : parentSessionId ? await sourceFor?.(parentSessionId) : undefined
      return build({ source: source ? Object.freeze({ ...source }) : undefined, current })
    } } : {}),
    capture(task, body, revision, execution, current) {
      const identity = { id: task.id, parent: task.parentSessionId, outcome: task.outcome }
      let scope: ResultArtifactScope | undefined, active = true
      const source = bound?.source
      const primary = createResultCapture(body, execution ?? { outcome: task.outcome === 'completed' ? 'succeeded' : task.outcome === 'cancelled' ? 'canceled' : task.outcome === 'error' ? 'failed' : 'unknown', dispatch: task.recoveryReason === 'dispatch-unknown' ? 'unknown' : 'dispatched' }, {
        forceArtifact: true,
        async openArtifact() {
          if (!service || !parentSessionId || !stateId || sourceFor && !source) throw Object.assign(new Error('Task result owner unavailable'), { code: 'ARTIFACT_OWNER_UNSUPPORTED' })
          scope ??= service.registerResultScope({ operationId: revision, sessionId: parentSessionId, callId: task.id, documentId: `task-${stateId}`, ...(source ? { source } : {}) }, () => active && bound?.current?.() !== false && current?.() !== false && task.id === identity.id && task.parentSessionId === identity.parent && task.outcome === identity.outcome)
          return service.beginResult(scope, 'json-utf8-v1')
        },
      })
      type Result = Awaited<ReturnType<ResultFinalization['settle']>>
      let result: Result | undefined, running: Promise<Result> | undefined
      async function settle(): Promise<Result> {
        if (result) return result
        const captured = await primary.settle()
        if (captured.kind !== 'ready') return captured
        if (captured.envelope.retention.kind === 'artifact') {
          try { await service!.confirmResultOwner(scope!, captured.envelope.retention.ref) }
          catch (error) {
            if ((error as { code?: string }).code === 'ARTIFACT_QUOTA') {
              active = false
              return result = { ...captured, envelope: { ...captured.envelope, retention: { kind: 'unavailable', reason: 'quota', observedEncodedBytes: captured.envelope.retention.ref.encodedBytes } } }
            }
            return { kind: 'recovery-required' }
          }
        }
        active = false
        return result = captured
      }
      return { settle() {
        if (running) return running
        const pending = settle(); running = pending
        void pending.finally(() => { if (running === pending) running = undefined }).catch(() => {})
        return pending
      } }
    },
    async read(_task, ref, args) {
      if (!service || !parentSessionId) throw new Error('Task result owner unavailable')
      return service.readResult({ sessionId: parentSessionId }, { ref, ...args })
    },
  })
  return build()
}
