import type { SandboxMode } from "./index.ts"

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
export interface RootExit { exitCode: number | null; signal?: string }
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
