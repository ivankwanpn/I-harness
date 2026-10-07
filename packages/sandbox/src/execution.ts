import type { RunnerFailureRule, SandboxEnforcement, SandboxMode } from "./index.ts"

export type ExecutionTransport = "pipe" | "pty"
export type ExecutionLifetime = "complete-tree" | "retain-tree"
export type BackendAssurance = "verified" | "experimental" | "unverified"
export type StopReason = "cancelled" | "timeout" | "output-limit" | "authority-revoked" | "shutdown"
export interface ExecutionOwner { sessionId: string; parentSessionId?: string }
export interface BackendProbe {
  id: string
  availability: "available" | "unavailable"
  assurance: BackendAssurance
  features: Readonly<{
    writeIsolation: boolean; readIsolation: boolean; denyPaths: boolean
    pipes: boolean; pty: boolean; retainedTree: boolean
  }>
  detail?: string
}
export interface BackendRequirements {
  writeIsolation: boolean; readIsolation: boolean; denyPaths: boolean
  transport: ExecutionTransport; lifetime: ExecutionLifetime
  minimumAssurance: BackendAssurance
}
export type BackendDecision = { ok: true } | { ok: false; missing: readonly string[] }
export interface ProcessSpec {
  argv: readonly string[]; cwd: string; env: Readonly<Record<string, string>>
  owner: Readonly<ExecutionOwner>; transport: ExecutionTransport
  lifetime: ExecutionLifetime; argumentEncoding: "crt" | "cmd-verbatim"
  pty?: Readonly<{ cols: number; rows: number }>
}
export type AuthorityState =
  | { kind: "unbound"; revision: string; workspaceRoot: string }
  | { kind: "bound"; revision: string; primaryRoot: string; roots: readonly string[]; references: readonly string[] }
  | { kind: "revoked" | "unavailable"; revision: string; reason: string }
export interface CompiledSandboxPolicy {
  mode: SandboxMode; owner: Readonly<ExecutionOwner>; authorityRevision: string
  authorityKind: "unbound" | "bound"; primaryRoot: string
  readable: "caller"; authorityRoots: readonly string[]
  writeRoots: readonly string[]; referenceRoots: readonly string[]
  fingerprint: string
}
export interface ExecutionReceipt {
  executionId: string; backendId: string; policyFingerprint: string
  owner: Readonly<ExecutionOwner>; assurance: BackendAssurance
}
export interface RootExit {
  exitCode: number | null; signal?: string
  /** Driver-sanitized root status observation failure; null code is explicitly unknown. */
  observationError?: string
}
export type ExecutionSettlement =
  | { kind: "settled"; root: RootExit; treeEmpty: true; ioSettled: true; resourcesReleased: true }
  | { kind: "incomplete"; phase: "tree" | "io" | "release"; detail: string }
export interface ExecutionHandle {
  readonly receipt: ExecutionReceipt
  readonly rootExited: Promise<RootExit>
  readonly settled: Promise<ExecutionSettlement>
  cancel(reason: StopReason): Promise<ExecutionSettlement>
  release(): Promise<ExecutionSettlement>
}
export interface ExecutionOutput {
  channel: "stdout" | "stderr" | "pty"
  data: Uint8Array
}
export interface ExecutionIo {
  /** One consumer, retained before that consumer begins; driver must bound buffering. */
  output: AsyncIterable<ExecutionOutput>
  /** Present only when the producer can account for delivery loss. The count is
   * conservative payload bytes discarded during cancellation, including native
   * frames whose partial write cannot be measured exactly. */
  diagnostics?(): { outputAbandoned: boolean; discardedOutputBytes: number }
  write(data: Uint8Array): Promise<void>
  endInput(): Promise<void>
  resize?(cols: number, rows: number): Promise<void>
  signal?(signal: "INT" | "TERM" | "KILL"): Promise<void>
}
export interface TransportExecutionHandle extends ExecutionHandle {
  readonly pid: number
  readonly io: ExecutionIo
  /** Descriptive runner classification copied from the selected backend. */
  readonly runner?: Readonly<{
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureRules: readonly RunnerFailureRule[]
  }>
}
export interface PreparedExecution {
  readonly policy: CompiledSandboxPolicy
  /** Trusted supervisor authority fence; native launch atomicity remains a backend responsibility. */
  commit(validateAuthority: () => void): Promise<ExecutionHandle>
  rollback(): Promise<void>
}
export interface ExecutionBackend {
  probe(): Promise<BackendProbe>
  prepare(spec: ProcessSpec, policy: CompiledSandboxPolicy, signal?: AbortSignal): Promise<PreparedExecution>
}
export interface PreparedTransportExecution extends PreparedExecution {
  commit(validateAuthority: () => void): Promise<TransportExecutionHandle>
}
export interface TransportExecutionBackend extends ExecutionBackend {
  prepare(spec: ProcessSpec, policy: CompiledSandboxPolicy, signal?: AbortSignal): Promise<PreparedTransportExecution>
}
