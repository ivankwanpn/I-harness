import type { ExecutionOwner, ExecutionSettlement, RootExit } from "@i-harness/sandbox"
import type { ResultDependency } from "@i-harness/core-session"
import type { BackgroundJobStatus, BackgroundJobView, NativeJobIdentity } from "../index.ts"
import type { Capture } from "../capture/contracts.ts"

export type Job = {
  readonly instanceId: string; readonly nativeJob: NativeJobIdentity
  id: string; capture: Capture; status: BackgroundJobStatus; owner: Readonly<ExecutionOwner>
  listeners: Set<(view: BackgroundJobView) => void>
  exitCode?: number; root?: RootExit; settlement?: ExecutionSettlement; failure?: string; cleanupDetail?: string
  /** Exact settled frame dependency, retained by this original job owner. */
  retained?: ResultDependency; retentionFailure?: 'recovery-required' | 'unavailable'
  /** Settlement join: one promise per job, settled with its terminal view. */
  retention?: Promise<void>
}
