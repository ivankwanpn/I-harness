import { randomUUID } from 'node:crypto'
import { currentToolResultProducer, registerToolResultDependency, type ToolExec, type ToolResultDependency } from '@i-harness/core-tools'
import { createExecFrameCapture } from '@i-harness/output-retention'
import type { ContextOutputService, ResultArtifactScope } from '@i-harness/context-output'
import { summarizeExecFrames, type ExecFrameSummary } from '@i-harness/context-output'
import { sameManagedArtifactRef, type ManagedArtifactRef } from '@i-harness/core-session'
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
  const summaries = new WeakMap<ExecFrameCapture, { ref: ManagedArtifactRef; summary: ExecFrameSummary }>()
  const scans = new WeakMap<ExecFrameCapture, { ref: ManagedArtifactRef; controller: AbortController; promise: Promise<ExecFrameSummary>; readers: number }>()

  function scan(capture: ExecFrameCapture, ref: ManagedArtifactRef, origin: string, signal?: AbortSignal): Promise<ExecFrameSummary> {
    let flight = scans.get(capture)
    if (!flight || flight.controller.signal.aborted || !sameManagedArtifactRef(flight.ref, ref)) {
      const controller = new AbortController()
      const promise = summarizeExecFrames(ref, (cursor, maxBytes) => service!.readExecResult({ sessionId: origin, signal: controller.signal }, { ref, cursor, maxBytes }), controller.signal)
      flight = { ref, controller, promise, readers: 0 }
      scans.set(capture, flight)
      const original = flight
      void promise.then(summary => {
        if (!controller.signal.aborted) summaries.set(capture, { ref, summary })
        if (scans.get(capture) === original) scans.delete(capture)
      }, () => { if (scans.get(capture) === original) scans.delete(capture) })
    }
    const joined = flight
    joined.readers++
    return new Promise((resolve, reject) => {
      let detached = false
      const detach = () => {
        if (detached) return false
        detached = true; signal?.removeEventListener('abort', abort)
        if (--joined.readers === 0) joined.controller.abort()
        return true
      }
      const abort = () => { if (detach()) reject(signal!.reason) }
      signal?.addEventListener('abort', abort, { once: true })
      void joined.promise.then(value => { if (detach()) resolve(value) }, cause => { if (detach()) reject(cause) })
      if (signal?.aborted) abort()
    })
  }

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
    async summarize(capture, { signal } = {}) {
      signal?.throwIfAborted()
      // No caller-supplied ref/owner is accepted by this trusted port.
      const origin = origins.get(capture)
      if (!captures.has(capture) || !origin || !service) return { kind: 'unavailable', reason: 'unsupported-owner' }
      const settled = await capture.settle()
      signal?.throwIfAborted()
      if (settled.kind !== 'ready') return settled
      const dependency = settled.dependency
      if (dependency.retention.kind === 'unavailable') return { kind: 'unavailable', reason: dependency.retention.reason }
      const ref = Object.freeze({ ...dependency.retention.ref })
      const read = (cursor: import('@i-harness/core-session').ExecFrameCursor, maxBytes: number) => service.readExecResult({ sessionId: origin, signal }, { ref, cursor, maxBytes })
      try {
        const cached = summaries.get(capture)
        let summary: ExecFrameSummary
        if (cached && sameManagedArtifactRef(cached.ref, ref)) {
          // Cache is computation only: even a hit must recheck original authority.
          await read({ recordOffset: 9, sliceOffset: 0 }, 32768)
          summary = cached.summary
        } else {
          // Reader cancellation detaches only this waiter. The shared scan is
          // cancelled only when no readers remain; rejected flights are cleared.
          summary = await scan(capture, ref, origin, signal)
          // Revalidate this caller's original authority after the shared await.
          await read({ recordOffset: 9, sliceOffset: 0 }, 32768)
        }
        signal?.throwIfAborted()
        summaries.set(capture, { ref, summary })
        return { kind: 'retained-summary', dependency, summary }
      } catch (cause) {
        signal?.throwIfAborted()
        return { kind: 'unavailable', reason: 'read-unavailable' }
      }
    },
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
