import type { Capture, CaptureAttempt } from './capture/contracts.ts'
import type { ExecFrameCapture, ExecFrameObservation } from './capture/frames.ts'
/** Constructor-held original delivery owner; never a command/run option. */
export interface OriginalExecDeliveryOwner {
  prepareAttempt(attempt: CaptureAttempt, settle: (frames: ExecFrameCapture) => Promise<ExecFrameObservation | undefined>, retire: () => void): void
  admit(): Promise<void>
  issued(): void
  assertAdmissionCurrent(): void
  bind(capture: Capture, attempt: CaptureAttempt, settle: (frames: ExecFrameCapture) => Promise<ExecFrameObservation | undefined>): void
  failed(attempt: CaptureAttempt | undefined): void
  promoted(): Promise<void>
  close(): Promise<void>
  isClean(): boolean
}
