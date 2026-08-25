import type { SandboxMode } from "./index.ts"

// The strictly-wider table: what a call whose effective mode is the key may
// escalate TO. Checked at EXECUTION, never baked into a tool schema.
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
  "read-only": ["workspace-write", "danger-full-access"],
  "workspace-write": ["danger-full-access"],
}

export const ESCALATION_TARGETS: readonly SandboxMode[] = ["workspace-write", "danger-full-access"]

export function validateEscalationArgs(
  sandboxPermissions: string | undefined,
  justification: string | undefined,
): void {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error("invalid escalation: sandbox_permissions requires a justification")
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error("invalid escalation: justification is only valid together with sandbox_permissions")
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw new Error("invalid justification: expected a non-empty sentence")
  }
}

export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

export type EscalationOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable"

export interface EscalationApprover<A = object, C = string> {
  request(req: { agent: A; toolName: string; callId: C; reason: string; signal?: AbortSignal }): Promise<EscalationOutcome>
}

export interface EscalationApproval<A = object, C = string> {
  approver: EscalationApprover<A, C> | undefined
  agent: A | undefined
  callId: C
  toolName: string
  signal?: AbortSignal
}

export interface EscalationRequest {
  requestedMode: string
  justification: string
  effectiveMode: SandboxMode
  subject: string
}

export async function approveEscalation<A, C>(
  request: EscalationRequest,
  approval: EscalationApproval<A, C>,
): Promise<SandboxMode> {
  const { requestedMode: mode, effectiveMode, justification, subject } = request
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode as SandboxMode)) {
    throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`)
  }
  if (approval.approver === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`)
  }
  if (approval.agent === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`)
  }
  const outcome = await approval.approver.request({
    agent: approval.agent,
    toolName: approval.toolName,
    callId: approval.callId,
    reason: `escalate sandbox to ${mode}: ${justification}`,
    ...approval.signal ? { signal: approval.signal } : {},
  })
  switch (outcome) {
    case "allowed-once": return mode as SandboxMode
    case "rejected": throw new Error(`the user rejected escalating this ${subject} to "${mode}"`)
    case "cancelled": throw new Error(`approval for escalating to "${mode}" was cancelled`)
    case "unavailable": throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`)
    default: return assertNever(outcome)
  }
}

function assertNever(x: never): never {
  throw new Error(`unreachable outcome: ${String(x)}`)
}
