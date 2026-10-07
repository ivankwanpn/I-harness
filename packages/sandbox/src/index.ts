export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access"
export type {
  ExecutionTransport, ExecutionLifetime, BackendAssurance, StopReason, ExecutionOwner,
  BackendProbe, BackendRequirements, BackendDecision, ProcessSpec, AuthorityState,
  CompiledSandboxPolicy, ExecutionReceipt, RootExit, ExecutionSettlement,
  ExecutionHandle, PreparedExecution, ExecutionBackend, ExecutionOutput, ExecutionIo,
  TransportExecutionHandle, PreparedTransportExecution, TransportExecutionBackend,
} from "./execution.ts"
export { checkBackendRequirements } from "./backend-requirements.ts"
export { createExecutionLease } from "./execution-lease.ts"
export type ConfinedSandboxMode = Exclude<SandboxMode, "danger-full-access">
export type SandboxEnforcement = "full" | "partial"

export interface SandboxExecutionPolicy {
  mode: SandboxMode
  workspaceRoot: string
  /** Full approved project folder set. The default workspaceRoot is always included. */
  workspaceRoots?: readonly string[]
  sessionId?: string
  // M22 enforcement gate: when true, this policy demands a read-isolated
  // backend. default false — opting in is what turns capability absence into
  // a refuse-to-run.
  requireReadIsolation?: boolean
}

export interface SandboxPolicy extends SandboxExecutionPolicy {
  mode: ConfinedSandboxMode
}

export interface RunnerFailureRule {
  allowedExitCodes?: readonly number[]
  fatalSignatures: readonly string[]
  informationalLines?: readonly string[]
}

export interface ConfinedArgv {
  argv: string[]
  enforcement: SandboxEnforcement
  denialSignatures: readonly string[]
  runnerFailureRules: readonly RunnerFailureRule[]
}

// Abstract process-sandbox seam. confine() must return enforcing argv or fail
// closed by throwing; silent unconfined passthrough is forbidden.
export interface SandboxProvider {
  // M22 capability contract: optional. An undefined/missing declaration is
  // treated as `{ readIsolation: false }` (capabilities unknown = NOT
  // read-isolated) — fail closed, never fail open.
  capabilities?: { readIsolation: boolean }
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv
}

export const SANDBOX_UNAVAILABLE = "SANDBOX_UNAVAILABLE"

/**
 * WHY a confined command could not run — the distinction a consumer needs to
 * give the model advice it can ACT on:
 *
 *  - `no-backend`: nothing can confine in ANY mode here (no provider composed, a
 *    missing capability, a backend that failed its own probe or was disposed).
 *    No mode is worth asking for, so a consumer must NOT carry escalation
 *    guidance.
 *  - `command-not-run`: a backend IS composed and it started, and the confined
 *    COMMAND could not run — the runner failed, or (on Windows) an MSYS/Cygwin
 *    child died in DLL initialization before its body ran. The backend is not
 *    broken for everything: a wider mode is exactly the remedy, and `detail`
 *    names the program-level cause.
 *
 * Collapsing the two into one sentence is what made the shell tell the model
 * "no backend exists for any mode here" about a host whose backend confines
 * cmd.exe, node.exe and git.exe perfectly well.
 */
export type SandboxUnavailableKind = "no-backend" | "command-not-run"

export class SandboxUnavailableError extends Error {
  /** Defaults to `no-backend`: the reason this class was written for, and the
   * answer for every construction site that cannot know better. */
  readonly kind: SandboxUnavailableKind
  /** The RAW cause, or `undefined` when the producer named none. Carried apart
   * from `message` so a consumer can compose its own sentence WITHOUT nesting
   * this class's framing inside it — the shell learned that the hard way. */
  readonly detail: string | undefined
  constructor(mode: ConfinedSandboxMode, detail?: string, kind: SandboxUnavailableKind = "no-backend") {
    super(
      kind === "command-not-run"
        ? `sandbox mode "${mode}" could not run this command, so it was NOT run unconfined: `
          + (detail ?? "the confined command failed before it ran")
        : `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; `
          + "refusing to run the command unconfined. Install bubblewrap (Linux) or ensure the ACL "
          + "restricted-token runner can start (Windows) — otherwise switch the consumer to "
          + "danger-full-access."
          + (detail === undefined ? "" : ` Runner failure: ${detail}`),
    )
    this.name = "SandboxUnavailableError"
    this.kind = kind
    this.detail = detail
  }
}

// M22 enforcement gate: absorb codex windows.rs's "policy requires it but the
// backend can't deliver it → refuse to run" shape (refusing to run
// unsandboxed; windows.rs:121-129) — shape-level absorb (today every provider
// is readIsolation:false, so this gate is a fail-closed contract left for
// future account-style backends). Only confined modes reach this check:
// danger-full-access passthrough happens upstream in exec's resolveArgv.
// 形狀吸收（MIT；見 THIRD_PARTY_NOTICES——OpenAI codex-rs）。
export function assertSandboxCapable(policy: SandboxExecutionPolicy, provider: SandboxProvider): void {
  if (policy.requireReadIsolation === true && provider.capabilities?.readIsolation !== true) {
    throw new SandboxUnavailableError(
      (policy as SandboxPolicy).mode,
      "policy requires read isolation but this backend provides none (WRITE_RESTRICTED is read-visible on Windows; the codex-style elevated backend is not implemented in this build)",
    )
  }
}

export { classifyRunnerFailure, matchesSignature, type ShellLikeResult } from "./runner-failures.ts"
export { canonicalPath, workspaceRoots, writableRoots } from "./roots.ts"
export {
  WIDER_MODES,
  ESCALATION_TARGETS,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
} from "./escalation.ts"
export type {
  EscalationApproval,
  EscalationApprover,
  EscalationOutcome,
  EscalationRequest,
} from "./escalation.ts"
// M62: the ONE refusal shape for every confined surface (spec §3.2). Consumers
// that must stay unaware of the policy resolver (fs, shell) import this.
export { denialFor, type SandboxDenial, type SandboxSurface } from "./denial.ts"
// M62 ladder Task A: the REQUEST side of escalation (spec §3.3(b)). A surface that
// declares `sandbox_permissions` / `justification` composes an `EscalationContext`
// per call and hands the raw args here; the refusal it returns is the same
// `SandboxDenial` shape, with no escalation guidance (the request was refused, not
// the operation).
export {
  createApprovalEscalationApprover,
  resolveCallPolicy,
  type ApprovalPrompt,
  type CallPolicyResolution,
  type EscalationArgs,
  type EscalationContext,
} from "./call-policy.ts"
