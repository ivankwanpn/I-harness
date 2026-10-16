import type { ProcessSpec } from "@i-harness/sandbox"
import type { SupervisedExecution } from "../execution-supervisor.ts"
import type { CollectResult } from "../spill.ts"
import type { ExecResult } from "../index.ts"

export type StreamMetadata = NonNullable<ExecResult["stream"]>
export type Channel = "stdout" | "stderr"
export type Capture = {
  readonly lifetime?: ProcessSpec["lifetime"]
  readonly complete: Promise<ExecResult>
  readonly execution: SupervisedExecution
  output(): { stdout: CollectResult; stderr: CollectResult }
  diagnostics(): { outputAbandoned: boolean; discardedOutputBytes: number } | undefined
}
