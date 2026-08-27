export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access"
export type ConfinedSandboxMode = Exclude<SandboxMode, "danger-full-access">
export type SandboxEnforcement = "full" | "partial"

export interface SandboxExecutionPolicy {
  mode: SandboxMode
  workspaceRoot: string
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

export class SandboxUnavailableError extends Error {
  constructor(mode: ConfinedSandboxMode, detail?: string) {
    super(
      `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; `
      + "refusing to run the command unconfined. Install bubblewrap (Linux) or ensure the ACL "
      + "restricted-token runner can start (Windows) — otherwise switch the consumer to "
      + "danger-full-access."
      + (detail === undefined ? "" : ` Runner failure: ${detail}`),
    )
    this.name = "SandboxUnavailableError"
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
export { canonicalPath, writableRoots } from "./roots.ts"
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
