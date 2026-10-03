import { randomUUID } from "node:crypto"
import type { ApprovalAuthorityProvider, PreparedApprovalInput, PreparedApprovalProvider } from "@i-harness/core-tools"
export type { ApprovalRememberView } from "@i-harness/core-tools"
import { canonicalApprovalArguments, createApprovalRuleStore, prepareApprovalEvidence, type ApprovalEvidence, type ApprovalRule } from "@i-harness/guard-approval"
import type { ApprovalRequest } from "@i-harness/interaction"
import type { SessionAssembly } from "@i-harness/session-executor"

export interface RememberApprovalOptions { scope: "session" | "workspace"; expiresAt: number }
export interface ApprovalRuleCandidate { requestId: string; sessionId: string; name: string; arguments: string }
export interface ApprovalRulesState { rules: ApprovalRule[]; candidates: ApprovalRuleCandidate[] }
export interface ApprovalRulesAdapterOptions {
  filePath: string
  /** A revision of current approval/sandbox/Plan/role/hooks and project authority.
   * Missing authority must return undefined and leaves this operation one-time. */
  policyIdentity(assembly: SessionAssembly): { workspaceId: string; revision: string } | undefined
  clock?: () => number
}

export function createApprovalRulesAdapter(options: ApprovalRulesAdapterOptions) {
  const clock = options.clock ?? Date.now
  const store = createApprovalRuleStore(options.filePath, clock)
  const candidates = new Map<string, { evidence: ApprovalEvidence; input: PreparedApprovalInput; assembly: SessionAssembly; expiresAt: number }>()
  function current(assembly: SessionAssembly, input: PreparedApprovalInput) {
    const policy = options.policyIdentity(assembly)
    return prepareApprovalEvidence({ ...input, workspaceId: policy?.workspaceId ?? "", policyRevision: policy?.revision ?? "" })
  }
  function forget(request: ApprovalRequest): void { if (request.remember?.candidateId) candidates.delete(request.remember.candidateId) }
  return {
    attach(assembly: SessionAssembly): void {
      const authority: ApprovalAuthorityProvider = (input) => {
        const policy = options.policyIdentity(assembly)
        const workspaceId = policy?.workspaceId, revision = policy?.revision
        return () => {
          const currentPolicy = options.policyIdentity(assembly)
          return (input.sessionId === undefined || input.sessionId === assembly.sessionId)
            && input.validateBinding?.() !== false
            && currentPolicy?.workspaceId === workspaceId && currentPolicy?.revision === revision
        }
      }
      assembly.ctx.services.register("approval/authority", authority)
      const provider: PreparedApprovalProvider = (input) => {
        if (input.sessionId !== undefined && input.sessionId !== assembly.sessionId) return { remembered: false, remember: { available: false, reason: "prepared caller identity differs from the attached approval authority" } }
        for (const [id, row] of candidates) if (row.expiresAt <= clock()) candidates.delete(id)
        const prepared = current(assembly, input)
        if (!prepared.evidence) return { remembered: false, remember: { available: false, reason: prepared.reason } }
        const originalEvidence = prepared.evidence
        const sameEvidence = () => {
          const next = current(assembly, input).evidence
          return next !== undefined && canonicalApprovalArguments(next) === canonicalApprovalArguments(originalEvidence)
        }
        if (store.matches(prepared.evidence, assembly.sessionId)) return { remembered: true, remember: { available: true }, validate: () => sameEvidence() && store.matches(originalEvidence, assembly.sessionId) }
        if (candidates.size >= 1000) return { remembered: false, remember: { available: false, reason: "too many pending rule candidates" } }
        const candidateId = randomUUID()
        candidates.set(candidateId, { evidence: prepared.evidence, input, assembly, expiresAt: clock() + 86400000 })
        return { remembered: false, remember: { available: true, candidateId, arguments: prepared.evidence.arguments }, validate: sameEvidence }
      }
      assembly.ctx.services.register("approval/prepared", provider)
    },
    grant(request: ApprovalRequest, sessionId: string, remember: RememberApprovalOptions): ApprovalRule {
      const candidate = request.remember?.candidateId ? candidates.get(request.remember.candidateId) : undefined
      if (!candidate || candidate.assembly.sessionId !== sessionId || candidate.expiresAt <= clock()) throw new Error("live prepared approval candidate is unavailable")
      const prepared = current(candidate.assembly, candidate.input)
      if (!prepared.evidence || canonicalApprovalArguments(prepared.evidence) !== canonicalApprovalArguments(candidate.evidence)) throw new Error("prepared operation or current policy changed; request fresh approval")
      if (remember.scope !== "session" && remember.scope !== "workspace") throw new Error("invalid approval rule scope")
      return store.add(candidate.evidence, remember.scope === "session" ? { kind: "session", sessionId } : { kind: "workspace" }, remember.expiresAt)
    },
    forget,
    list(workspaceId: string): ApprovalRule[] { return store.list().filter((rule) => rule.evidence.workspaceId === workspaceId) },
    state(workspaceId: string, pending: readonly { requestId: string; sessionId: string; kind: string; payload: unknown; state?: string }[]): ApprovalRulesState {
      return { rules: store.list().filter((rule) => rule.evidence.workspaceId === workspaceId), candidates: pending.flatMap((row) => {
        const request = row.payload as ApprovalRequest
        const candidate = request?.remember?.candidateId ? candidates.get(request.remember.candidateId) : undefined
        return row.kind === "approval" && row.state !== "interrupted" && candidate?.evidence.workspaceId === workspaceId
          ? [{ requestId: row.requestId, sessionId: row.sessionId, name: request.name, arguments: candidate.evidence.arguments }] : []
      }) }
    },
    revoke(workspaceId: string, id: string): void {
      if (!store.list().some((rule) => rule.id === id && rule.evidence.workspaceId === workspaceId)) throw new Error("approval rule is not in this workspace")
      store.revoke(id)
    },
    removeSession(sessionId: string): void {
      store.removeSession(sessionId)
      for (const [id, row] of candidates) if (row.assembly.sessionId === sessionId) candidates.delete(id)
    },
  }
}
export type ApprovalRulesAdapter = ReturnType<typeof createApprovalRulesAdapter>
