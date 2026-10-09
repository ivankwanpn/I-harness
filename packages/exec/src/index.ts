import type { PluginContext } from "@i-harness/core-plugin"
import type {
  CompiledSandboxPolicy, ExecutionOwner, ExecutionTransport, ExecutionLifetime, ProcessSpec, SandboxExecutionPolicy,
  SandboxProvider, StopReason, TransportExecutionBackend, ExecutionSettlement,
} from "@i-harness/sandbox"
import type { ExecutionSupervisor, SupervisedExecution } from "./execution-supervisor.ts"
import { createExecService } from "./service.ts"
export { createExecService } from "./service.ts"

export { launchExecution } from "./execution-admission.ts"
export { createExecutionSupervisor } from "./execution-supervisor.ts"
export type { ExecutionLaunch, SupervisedExecution, ExecutionSupervisor, ExecutionReconciliationContext, ExecutionReconciler } from "./execution-supervisor.ts"
export { withExecCallerScope, currentExecCaller } from "./caller-scope.ts"
export { registerRetainedOutput, retainedOutputReader } from "./retained-output.ts"

export interface ExecCommand {
  /** Assigned by trusted tool registration, never exposed as model permission input. */
  executionTarget?: "host" | "wsl"
  argv: string[]
  windowsVerbatimArguments?: boolean
  cwd?: string
  /** Explicit empty object is an empty environment; omission inherits the host snapshot. */
  env?: Record<string, string>
  timeoutMs?: number
  input?: string
  inputBytes?: Uint8Array
  abortSignal?: AbortSignal
  sandbox?: SandboxExecutionPolicy
}
export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  stdoutSpillPath?: string
  stderrSpillPath?: string
  truncated?: { stdout: boolean; stderr: boolean }
  /** Trusted presentation loss, separate from stdout/stderr and root status. */
  outputDiagnostics?: { outputAbandoned: boolean; discardedOutputBytes: number }
  stream?: {
    bytesRead: { stdout: number; stderr: number }
    bytesAdmitted: { stdout: number; stderr: number }
    stopReason?: "consumer" | "output-limit" | "aborted" | "timeout"
  }
}
export interface ExecStreamRunOptions {
  stream: { maxBytes: number; onStdout(chunk: Buffer): void | "stop" }
  backgroundAfterMs?: never
}
export interface ExecSpillOptions { maxOutputBytes?: number; maxSpillBytes?: number; spillRoot?: string }
export interface ExecRunOptions { backgroundAfterMs?: number }
export interface PromotedRun { jobId: string; promoted: true; ranForegroundMs: number }
/** Running also covers a retained handle whose cleanup is incomplete; inspect settlement. */
export type BackgroundJobStatus = "running" | "completed" | "killed" | "error"
export interface BackgroundJobView {
  /** WSL jobs end and clean descendants when their root command exits. */
  lifetime?: ExecutionLifetime
  id: string; status: BackgroundJobStatus; stdout: string; stderr: string; exitCode?: number
  stdoutSpillPath?: string
  stderrSpillPath?: string
  truncated?: { stdout: boolean; stderr: boolean }
  owner?: string; parentSessionId?: string
  receipt?: SupervisedExecution["handle"]["receipt"]
  root?: Awaited<SupervisedExecution["handle"]["rootExited"]>
  settlement?: ExecutionSettlement
  cleanupDetail?: string
  outputDiagnostics?: { outputAbandoned: boolean; discardedOutputBytes: number }
}

/** Host functions are trusted composition, never values from tool/model JSON. */
export interface ExecExecutionHost {
  supervisor?: ExecutionSupervisor
  selectBackend(policy: CompiledSandboxPolicy, transport: ExecutionTransport, spec?: ProcessSpec): TransportExecutionBackend
  resolvePolicy(owner: Readonly<ExecutionOwner>, requested: SandboxExecutionPolicy | undefined): CompiledSandboxPolicy
  validateAuthority(policy: CompiledSandboxPolicy): void
  /** Automatic foreground presentation only; explicit background/transport lifetimes remain exact. */
  autoPromotionLifetime?(policy: CompiledSandboxPolicy): ProcessSpec["lifetime"]
  /** Trusted durable lineage projection; omitted hosts permit only the exact caller. */
  canAccessOwner?(caller: Readonly<ExecutionOwner>, target: Readonly<ExecutionOwner>): boolean
  defaultOwner?: Readonly<ExecutionOwner>
  dispose?(): Promise<void>
}
export interface ExecServiceOptions {
  execution?: ExecExecutionHost
  workspaceRoot?: string
  /** Trusted standalone composition only, for human Desktop's separate owner. */
  standaloneOwner?: Readonly<ExecutionOwner>
  spill?: ExecSpillOptions
  /** Previous argv wrapper dependency is retained in the type for migration diagnostics. */
  sandbox?: SandboxProvider
}

/** Terminal requests exact transport facts; the service binds owner, policy and backend. */
export interface ExecTransportRequest {
  executionTarget?: "host" | "wsl"
  argv: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>>
  transport: ProcessSpec["transport"]; lifetime: ExecutionLifetime
  argumentEncoding: ProcessSpec["argumentEncoding"]
  pty?: ProcessSpec["pty"]
  sandbox?: SandboxExecutionPolicy
  abortSignal?: AbortSignal
}
export interface ExecService {
  run(cmd: ExecCommand): Promise<ExecResult>
  run(cmd: ExecCommand, opts: ExecStreamRunOptions): Promise<ExecResult>
  run(cmd: ExecCommand, opts: ExecRunOptions): Promise<ExecResult | PromotedRun>
  runBackground(cmd: ExecCommand): Promise<{ jobId: string }>
  getOutput(jobId: string): BackgroundJobView
  listJobs(): BackgroundJobView[]
  killJob(jobId: string): Promise<"cancellation-requested" | "already-finished">
  launchTransport(request: ExecTransportRequest): Promise<SupervisedExecution>
  cancelExecution(id: string, reason: StopReason): Promise<ExecutionSettlement>
  dispose(): Promise<void>
}

export function registerExec(ctx: PluginContext, deps?: ExecServiceOptions): ExecService {
  const service = createExecService(deps)
  ctx.services.register("exec/service", service)
  return service
}
