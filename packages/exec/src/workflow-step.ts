import type { Capture, CaptureAttempt } from './capture/contracts.ts'
import type { ExecCommand, ExecResult, ExecFrameCapture, ExecFrameObservation } from './index.ts'
export interface OriginalStepBinding {
  assertAdmissionCurrent(): void
  admissionCreated(): void
  prepared(attempt: CaptureAttempt, settle: (frames: ExecFrameCapture) => Promise<ExecFrameObservation | undefined>): void
  bound(capture: Capture): void
  failed(attempt: CaptureAttempt | undefined, cause: unknown): void
}
const bindings = new WeakSet<object>(), factories = new WeakSet<object>()
export const isOriginalStepBinding = (value: object) => bindings.has(value)
export const isWorkflowStepFactory = (value: object) => factories.has(value)
export type StepOwnership = { kind: 'clean'; execution: 'not-dispatched' | 'dispatched' | 'unknown'; retained: 'ready' | 'unavailable' | 'unsupported' }
  | { kind: 'recovery-required'; cause: unknown }
export interface OwnedWorkflowStep {
  run(): Promise<ExecResult>
  join(): Promise<StepOwnership>
  reconcile(): Promise<StepOwnership>
  discard(): void
  release(): void
}
export interface WorkflowStepFactory { create(command: ExecCommand): OwnedWorkflowStep }
interface Port {
  reserve(): object
  attachStep(handle: object, binding: OriginalStepBinding): void
  release(handle: object): void
  start(handle: object, command: ExecCommand, mode: 'foreground'): Promise<unknown>
}
/** Constructor-private association. Observations never supply cleanup authority. */
export function constructWorkflowStepFactory(port: Port, scope: (command: ExecCommand) => ExecCommand): WorkflowStepFactory {
  const factory: WorkflowStepFactory = Object.freeze({ create(command: ExecCommand) {
    if (this !== factory) throw new Error('Foreign Workflow step factory')
    const reservation = port.reserve()
    let attempt: CaptureAttempt | undefined, capture: Capture | undefined
    let settleFrames: ((frames: ExecFrameCapture) => Promise<ExecFrameObservation | undefined>) | undefined
    let phase: 'reserved' | 'start-entered' | 'admission-created' | 'attempt-prepared' | 'native-bound' = 'reserved'
    let discarded = false, released = false, running: Promise<ExecResult> | undefined, joining: Promise<StepOwnership> | undefined
    let last: StepOwnership | undefined, runFinished = false
    let cleanAcknowledged = false
    function acknowledge(execution: 'not-dispatched' | 'dispatched' | 'unknown', retained: 'ready' | 'unavailable' | 'unsupported'): StepOwnership {
      cleanAcknowledged = true
      return last = Object.freeze({ kind: 'clean', execution, retained })
    }
    const failures: { cause: unknown }[] = []
    const binding: OriginalStepBinding = Object.freeze({
      assertAdmissionCurrent() { if (this !== binding || discarded || released) throw new Error('Workflow step retired') },
      admissionCreated() { if (this !== binding) throw new Error('Foreign step binding'); phase = 'admission-created' },
      prepared(original: CaptureAttempt, settle: (frames: ExecFrameCapture) => Promise<ExecFrameObservation | undefined>) { if (this !== binding || attempt) throw new Error('Foreign/reused step binding'); attempt = original; settleFrames = settle; phase = 'attempt-prepared' },
      bound(original: Capture) { if (this !== binding) throw new Error('Foreign step binding'); capture = original; phase = 'native-bound' },
      failed(original: CaptureAttempt | undefined, cause: unknown) { if (this !== binding) throw new Error('Foreign step binding'); attempt ??= original; failures.push({ cause }) },
    })
    bindings.add(binding); port.attachStep(reservation, binding)
    async function observe(retry: boolean): Promise<StepOwnership> {
      if (released) return last!
      if (discarded) return acknowledge('not-dispatched', 'unsupported')
      if (!running) throw new Error('Workflow step not started')
      await running.catch(() => {})
      await capture?.complete.catch(() => {})
      try {
        if (attempt) {
          if (retry) await attempt.retire(); else await attempt.retryCleanup()
          if (!attempt.isClean()) throw new Error('Original Workflow attempt cleanup unknown')
          const original = attempt.disposition(), frames = original.frames
          const observed = frames && settleFrames ? await settleFrames(frames) : undefined
          if (frames && observed?.kind !== 'ready') throw new Error('Original Workflow frames require recovery')
          return acknowledge(original.execution ? 'dispatched' : original.nativeStarted ? 'unknown' : 'not-dispatched',
            observed?.kind === 'ready' ? observed.dependency.retention.kind === 'artifact' ? 'ready' : 'unavailable' : 'unsupported')
        }
        // No attempt exists only before the original factory entered native admission.
        if (phase !== 'start-entered' && phase !== 'reserved') throw new Error('Original attempt missing')
        return acknowledge('not-dispatched', 'unsupported')
      } catch (cause) { cleanAcknowledged = false; return last = Object.freeze({ kind: 'recovery-required', cause }) }
    }
    const step: OwnedWorkflowStep = Object.freeze({
      run() {
        if (this !== step || discarded || released) return Promise.reject(new Error('Workflow step retired'))
        if (!running) {
          running = Promise.resolve().then(() => {
            let scoped: ExecCommand
            try { scoped = scope(command) } catch (cause) { port.release(reservation); discarded = true; throw cause }
            phase = 'start-entered'
            return port.start(reservation, scoped, 'foreground') as Promise<ExecResult>
          }).finally(() => { runFinished = true })
          void running.catch(() => {})
        }
        return running
      },
      join() { if (this !== step) return Promise.reject(new Error('Foreign Workflow step')); return joining ??= observe(false).finally(() => { joining = undefined }) },
      reconcile() { if (this !== step) return Promise.reject(new Error('Foreign Workflow step')); return joining ??= observe(true).finally(() => { joining = undefined }) },
      discard() { if (this !== step || running || discarded || released) throw new Error('Workflow step cannot discard'); port.release(reservation); discarded = true; acknowledge('not-dispatched', 'unsupported') },
      release() {
        if (this !== step || !cleanAcknowledged || (!discarded && !runFinished)) throw new Error('Workflow step cleanup not acknowledged')
        released = true; attempt = undefined; capture = undefined; settleFrames = undefined; running = undefined; failures.length = 0
      },
    })
    return step
  } })
  factories.add(factory)
  return factory
}
