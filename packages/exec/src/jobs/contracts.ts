import type { ExecutionOwner, ExecutionSettlement, RootExit } from "@i-harness/sandbox"
import type { BackgroundJobStatus, BackgroundJobView } from "../index.ts"
import type { Capture } from "../capture/contracts.ts"

export type Job = {
  id: string; capture: Capture; status: BackgroundJobStatus; owner: Readonly<ExecutionOwner>
  listeners: Set<(view: BackgroundJobView) => void>
  exitCode?: number; root?: RootExit; settlement?: ExecutionSettlement; failure?: string; cleanupDetail?: string
}
