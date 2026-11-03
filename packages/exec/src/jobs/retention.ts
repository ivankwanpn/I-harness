import type { ExecResult, ExecResultRetention, ExecFrameObservation, ExecFrameCapture } from '../index.ts'
import type { Capture } from '../capture/contracts.ts'
import type { Job } from './contracts.ts'

type Failure = ExecResult['retentionFailure']
function failure(result: ExecFrameObservation | undefined): Failure {
  return result?.kind === 'recovery-required' ? 'recovery-required'
    : result?.dependency.retention.kind === 'unavailable' ? 'unavailable' : undefined
}

/** The job registry delegates original capture retention here. Observer grants
 * do not change the capture's stored disposition or its native exit status. */
export function createJobRetention(owner: ExecResultRetention | undefined, jobFor: (capture: Capture) => Job | undefined, changed: () => void = () => {}) {
  const pending = new Map<ExecFrameCapture, Capture | undefined>()
  const ownerSettle = owner?.settle, ownerObserve = owner?.observe
  async function settleFrames(frames: ExecFrameCapture): Promise<ExecFrameObservation | undefined> {
    if (!owner) return undefined
    try {
      const result = await (ownerSettle ? ownerSettle.call(owner, frames) : frames.settle())
      if (result.kind === 'ready') pending.delete(frames)
      return result
    } catch { return { kind: 'recovery-required' } }
  }
  async function settle(capture: Capture): Promise<ExecFrameObservation | undefined> {
    if (!capture.frames || !owner) return undefined
    return settleFrames(capture.frames)
  }
  async function record(job: Job): Promise<void> {
    const result = await settle(job.capture)
    // A known immutable capture cannot be downgraded by a delayed observation.
    if (!result || job.retained) return
    const before = job.retained, previousFailure = job.retentionFailure
    if (result.kind === 'ready') {
      job.retained = result.dependency
      job.retentionFailure = failure(result)
    } else job.retentionFailure = 'recovery-required'
    if (before !== job.retained || previousFailure !== job.retentionFailure) changed()
  }
  async function currentObservation(capture: Capture): Promise<ExecFrameObservation | undefined> {
    if (!capture.frames || !owner) return undefined
    try { return await ownerObserve!.call(owner, capture.frames) }
    catch { return { kind: 'recovery-required' } }
  }
  return {
    trackFrames(frames: ExecFrameCapture) { if (owner) pending.set(frames, undefined) },
    settleFrames,
    track(capture: Capture): Capture {
      if (capture.frames && owner) pending.set(capture.frames, capture)
      return capture
    },
    record,
    async observe(capture: Capture): Promise<Failure> {
      // Invoke now: authentic registration must precede the caller's finalizer.
      // Its rejection is handled immediately, even while passive storage waits.
      const observed = currentObservation(capture)
      const job = jobFor(capture)
      let storedFailure: Failure
      if (job) { await record(job); storedFailure = job.retentionFailure }
      else storedFailure = failure(await settle(capture))
      const observedFailure = failure(await observed)
      return observedFailure === 'recovery-required' || storedFailure === 'recovery-required'
        ? 'recovery-required' : observedFailure ?? storedFailure
    },
    async drain(): Promise<string[]> {
      const unresolved: string[] = []
      await Promise.all([...pending].map(async ([frames, capture]) => {
        await capture?.complete.catch(() => {})
        const job = capture ? jobFor(capture) : undefined
        if (job) await record(job)
        else await settleFrames(frames)
        if (pending.has(frames)) unresolved.push(job?.id ?? capture?.execution.id ?? frames.sourceId)
      }))
      return unresolved
    },
  }
}
