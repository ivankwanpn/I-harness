import { randomUUID } from 'node:crypto'
import { currentToolResultProducer, registerToolResultDependency, type ToolExec, type ToolResultDependency } from '@i-harness/core-tools'
import { createExecFrameCapture } from '@i-harness/output-retention'
import type { ContextOutputService, ResultArtifactScope } from '@i-harness/context-output'
import type { ExecFrameCapture, ExecFrameObservation, ExecResultRetention } from '@i-harness/exec'
import { resultSourceBinding } from './result-sources.ts'

/** The actual native capture token outlives a promoted startup source; it owns
 * storage only and can never invoke a command or acquire new execution rights. */
export function createExecResultRetention(service: ContextOutputService | undefined, previewBytes = 64000): ExecResultRetention {
  const captures = new WeakSet<ExecFrameCapture>(), origins = new WeakMap<ExecFrameCapture, string>()
  /** The startup caller's session target, used only for passive settlement. */
  const startupTargets = new WeakMap<ExecFrameCapture, string | undefined>()
  const passive = new WeakMap<ExecFrameCapture, ToolResultDependency>()
  const observers = new WeakMap<ExecFrameCapture, WeakMap<ToolExec, ToolResultDependency>>()

  /** Reads settle the same original artifact; only the grant target differs. */
  function dependencyFor(capture: ExecFrameCapture, target: string | undefined): ToolResultDependency {
    return { sourceId: capture.sourceId, async settle() {
      const result = await capture.settle()
      if (result.kind !== 'ready' || result.dependency.retention.kind !== 'artifact' || !service || !target) return result
      const origin = origins.get(capture)
      if (!origin || origin === target) return result
      try { await service.grant({ sessionId: origin }, [result.dependency.retention.ref.id], target) }
      catch { return { kind: 'recovery-required' } }
      return result
    } }
  }
  function passiveDependency(capture: ExecFrameCapture): ToolResultDependency {
    let dependency = passive.get(capture)
    if (!dependency) { dependency = dependencyFor(capture, startupTargets.get(capture)); passive.set(capture, dependency) }
    return dependency
  }
  /** One dependency handle per observing tool exec; concurrent reads inside the
   * same call reuse it, a later genuine reader gets its own registration. */
  function observerDependency(capture: ExecFrameCapture, exec: ToolExec): ToolResultDependency {
    let byExec = observers.get(capture)
    if (!byExec) { byExec = new WeakMap(); observers.set(capture, byExec) }
    let dependency = byExec.get(exec)
    if (!dependency) { dependency = dependencyFor(capture, resultSourceBinding(exec)?.sessionId ?? startupTargets.get(capture)); byExec.set(exec, dependency) }
    return dependency
  }
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
      captures.add(capture); origins.set(capture, input.owner.sessionId); startupTargets.set(capture, binding?.sessionId)
      return capture
    },
    async settle(capture): Promise<ExecFrameObservation> {
      if (!captures.has(capture)) return { kind: 'recovery-required' }
      return passiveDependency(capture).settle()
    },
    async observe(capture): Promise<ExecFrameObservation> {
      if (!captures.has(capture)) return { kind: 'recovery-required' }
      const exec = currentToolResultProducer()
      // No genuine prepared call is present: this is the passive owner path.
      if (!exec) return passiveDependency(capture).settle()
      const dependency = observerDependency(capture, exec)
      // Registration is synchronous so the observer's finalizer sees it; a
      // conflicting handle would only be a forged/duplicated source identity.
      registerToolResultDependency(exec, dependency)
      return dependency.settle()
    },
  }
}
