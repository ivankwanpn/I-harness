import { randomUUID } from "node:crypto"
import type { ApprovalAuthorityProvider, PreparedApprovalInput, PreparedApprovalProvider } from "@i-harness/core-tools"
export type { ApprovalRememberView } from "@i-harness/core-tools"
import { canonicalApprovalArguments, createApprovalRuleStore, prepareApprovalEvidence, type ApprovalEvidence, type ApprovalRule } from "@i-harness/guard-approval"
import type { ApprovalRequest } from "@i-harness/interaction"
import type { SessionAssembly } from "@i-harness/session-executor"

export interface OwnedApprovalOwner { ctx: SessionAssembly["ctx"]; sessionId: string; tools: NonNullable<SessionAssembly["tools"]> }
export interface RememberApprovalOptions { scope: "session" | "workspace"; expiresAt: number }
export interface ApprovalRuleCandidate { requestId: string; sessionId: string; name: string; arguments: string }
export interface ApprovalRulesState { rules: ApprovalRule[]; candidates: ApprovalRuleCandidate[] }
export interface ApprovalRulesAdapterOptions {
  filePath: string
  /** A revision of current approval/sandbox/Plan/role/hooks and project authority.
   * Missing authority must return undefined and leaves this operation one-time. */
  policyIdentity(assembly: SessionAssembly): { workspaceId: string; revision: string } | undefined
  ownedPolicyIdentity?(owner: OwnedApprovalOwner): { workspaceId: string; revision: string } | undefined
  clock?: () => number
}

export function createApprovalRulesAdapter(options: ApprovalRulesAdapterOptions) {
  const clock = options.clock ?? Date.now
  const store = createApprovalRuleStore(options.filePath, clock)
  type Owner = SessionAssembly | OwnedApprovalOwner
  type Policy = () => { workspaceId: string; revision: string } | undefined
  const candidates = new Map<string, { evidence: ApprovalEvidence; input: PreparedApprovalInput; assembly: Owner; policy: Policy; expiresAt: number }>()
  function current(policyNow: Policy, input: PreparedApprovalInput) {
    const policy = policyNow()
    return prepareApprovalEvidence({ ...input, workspaceId: policy?.workspaceId ?? "", policyRevision: policy?.revision ?? "" })
  }
  function forget(request: ApprovalRequest): void { if (request.remember?.candidateId) candidates.delete(request.remember.candidateId) }
  function attachAuthority(assembly: Owner, policyNow: Policy, childCallerFor?: SessionAssembly["ownedToolCaller"]): void {
      const authority: ApprovalAuthorityProvider = (input) => {
        const policy = policyNow()
        const workspaceId = policy?.workspaceId, revision = policy?.revision
        const rootCaller = input.sessionId === undefined || input.sessionId === assembly.sessionId
        const childCaller = rootCaller ? undefined : childCallerFor?.(input)
        return () => {
          const currentPolicy = policyNow()
          const currentChild = rootCaller ? undefined : childCallerFor?.(input)
          // An owned host (managed execution) has no parent assembly to supply a
          // child-caller table, so child calls are validated by their exact
          // registry/tool binding instead: a forged sessionId cannot pass the
          // registry identity check, and the policy must still be the same one.
          const childValid = childCaller !== undefined
            ? childCaller.validate() && currentChild !== undefined && currentChild.sessionId === childCaller.sessionId
              && currentChild.role === childCaller.role && currentChild.snapshot === childCaller.snapshot
            : childCallerFor === undefined && input.sessionId !== undefined && input.registry !== undefined
              && input.registry.get(input.call.name) === input.tool
          // Both the captured and the current identity must exist. Comparing
          // optional fields with `===` made two unavailable identities
          // (undefined === undefined) pass as "unchanged", so a revoked host
          // authority validated as valid.
          return policy !== undefined && currentPolicy !== undefined
            && (rootCaller ? (input.sessionId === undefined || input.sessionId === assembly.sessionId)
                && (assembly.tools === undefined || input.registry === assembly.tools)
              : childValid)
            && input.validateBinding?.() !== false
            && currentPolicy.workspaceId === workspaceId && currentPolicy.revision === revision
        }
      }
      assembly.ctx.services.register("approval/authority", authority)
      const provider: PreparedApprovalProvider = (input) => {
        if (input.sessionId !== undefined && input.sessionId !== assembly.sessionId) return { remembered: false, remember: { available: false, reason: "prepared caller identity differs from the attached approval authority" } }
        for (const [id, row] of candidates) if (row.expiresAt <= clock()) candidates.delete(id)
        const prepared = current(policyNow, input)
        if (!prepared.evidence) return { remembered: false, remember: { available: false, reason: prepared.reason } }
        const originalEvidence = prepared.evidence
        const sameEvidence = () => {
          const next = current(policyNow, input).evidence
          return next !== undefined && canonicalApprovalArguments(next) === canonicalApprovalArguments(originalEvidence)
        }
        if (store.matches(prepared.evidence, assembly.sessionId)) return { remembered: true, remember: { available: true }, validate: () => sameEvidence() && store.matches(originalEvidence, assembly.sessionId) }
        if (candidates.size >= 1000) return { remembered: false, remember: { available: false, reason: "too many pending rule candidates" } }
        const candidateId = randomUUID()
        candidates.set(candidateId, { evidence: prepared.evidence, input, assembly, policy: policyNow, expiresAt: clock() + 86400000 })
        return { remembered: false, remember: { available: true, candidateId, arguments: prepared.evidence.arguments }, validate: sameEvidence }
      }
      assembly.ctx.services.register("approval/prepared", provider)
    }
  return {
    attach(assembly: SessionAssembly): void { attachAuthority(assembly, () => options.policyIdentity(assembly), assembly.ownedToolCaller?.bind(assembly)) },
    attachOwned(owner: OwnedApprovalOwner): void {
      if (!options.ownedPolicyIdentity) throw new Error("owned approval policy authority is unavailable")
      attachAuthority(owner, () => options.ownedPolicyIdentity!(owner))
    },
    grant(request: ApprovalRequest, sessionId: string, remember: RememberApprovalOptions): ApprovalRule {
      const candidate = request.remember?.candidateId ? candidates.get(request.remember.candidateId) : undefined
      if (!candidate || candidate.assembly.sessionId !== sessionId || candidate.expiresAt <= clock()) throw new Error("live prepared approval candidate is unavailable")
      const prepared = current(candidate.policy, candidate.input)
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
