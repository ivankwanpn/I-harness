export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access"
export type ConfinedSandboxMode = Exclude<SandboxMode, "danger-full-access">
export type SandboxEnforcement = "full" | "partial"

export interface SandboxExecutionPolicy {
  mode: SandboxMode
  workspaceRoot: string
  sessionId?: string
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
