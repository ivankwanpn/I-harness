import { captureContextPayload, reductionSourceCurrent, reductionTarget, type ContextSnapshot, type ContextReductionPorts, type ReductionGroup, type ReductionPolicy, type ReductionRewrite, type ReductionPreparation } from '@i-harness/context-engine'
import { projectConversationCandidate } from '@i-harness/core-session'
import { prepareModelRequest, modelFailureFacts } from '@i-harness/llm-seam'
import { projectionFingerprint } from '@i-harness/token-meter'
import { randomUUID } from 'node:crypto'
import { buildContextRequest } from '../request-input.ts'
import { sameRequestCandidate, type RequestEvidence } from '../request-snapshot.ts'
import type { AgentConfig, AgentDeps } from '../types.ts'
import type { createOwnedBudget } from '../budget.ts'
import { createReductionPublication } from './publication.ts'

interface Proof { source: ContextSnapshot; groups: readonly ReductionGroup[]; rewrites: readonly ReductionRewrite[]; rewriteIdentity: string; current: RequestEvidence; assessmentRevision: string }
/** Snapshots expose only immutable data. All clients, assessments and proofs stay private. */
export function createReductionBridge(deps: AgentDeps & AgentConfig, captureCandidate: () => RequestEvidence, ownedBudget: ReturnType<typeof createOwnedBudget>, bindingCurrent: () => boolean, policy: ReductionPolicy, signal = deps.signal, refresh = () => {}, requireSurface = true, requestScope?: import('@i-harness/llm-seam').LLMRequest['requestScope']): ContextReductionPorts {
  const evidence = new WeakMap<ContextSnapshot, RequestEvidence>(), proofs = new WeakMap<object, Proof>()
  let ports: ContextReductionPorts
  const capture = () => { refresh(); const value = captureCandidate(); evidence.set(value.snapshot, value); return value.snapshot }
  const current = (source: ContextSnapshot, groups: readonly ReductionGroup[]) => {
    try { const prior = evidence.get(source), now = captureCandidate(); return bindingCurrent() && !!prior && prior.model === now.model && prior.bindingIdentity === now.bindingIdentity && reductionSourceCurrent(source, groups, now.snapshot, requireSurface) }
    catch { return false }
  }
  const preparationCurrent = (proof: Proof) => ports.current(proof.source, proof.groups) && sameRequestCandidate(proof.current, captureCandidate()) && ownedBudget.assessmentRevision() === proof.assessmentRevision
  const publish = createReductionPublication(deps, (source, groups, rewrites, token) => {
    const proof = proofs.get(token)
    return !!proof && proof.source === source && proof.groups === groups && proof.rewrites === rewrites && proof.rewriteIdentity === projectionFingerprint(rewrites) && preparationCurrent(proof)
  })
  async function prepare(source: ContextSnapshot, groups: readonly ReductionGroup[], rewrites: readonly ReductionRewrite[]): Promise<ReductionPreparation> {
    if (!ports.current(source, groups)) return { kind: 'stale' }
    const prior = evidence.get(source)!, now = captureCandidate(), assessmentRevision = ownedBudget.assessmentRevision()
    let conversation = now.snapshot.conversation
    try {
      if (rewrites.length) conversation = captureContextPayload(projectConversationCandidate(deps.session, rewrites, {
        candidateId: randomUUID(), ownerSessionId: source.coordinates.ownerSessionId, capturePayload: value => captureContextPayload(value),
      }).projection)
      const request = buildContextRequest({ conversation, surface: now.snapshot.surface }, { sessionId: deps.sessionId, signal, requestScope })
      const prepared = await prepareModelRequest(prior.model, request)
      const assessed = ownedBudget.probe(prepared, now, rewrites.length > 0, policy.reserveRatio)
      const token = Object.freeze({}), proof = { source, groups, rewrites, rewriteIdentity: projectionFingerprint(rewrites), current: now, assessmentRevision }
      if (!preparationCurrent(proof)) return { kind: 'stale' }
      proofs.set(token, proof)
      const { input, packet } = assessed.prepared.measurement, budget = assessed.snapshot
      const bytes = packet.bodyBytes ?? packet.sdkCommandBytesEstimate ?? Object.values(input.components).reduce((n, component) => n + component.textUtf8Bytes + component.structuredBytes + component.binaryBytes, 0)
      return { kind: 'assessed', capacityFit: assessed.capacityFit, target: reductionTarget({ capacityFit: assessed.capacityFit, inputTokens: budget.admissionInputTokens, outputReserve: budget.outputReserve, contextWindow: budget.contextWindow }, policy),
        currentView: projectionFingerprint([now.snapshot.coordinates.semanticRevision, now.snapshot.coordinates.protectionRevision, now.snapshot.surfaceRevision, assessmentRevision]),
        inputTokens: Object.values(input.components).reduce((n, component) => n + component.heuristicTokens, 0), inputBytes: bytes, inputFingerprint: input.inputFingerprint,
        shape: projectionFingerprint([input.bindingFingerprint, input.shapeFingerprint, now.snapshot.surface.binding]), fixedInput: input.overriddenInputFields.includes('messages')
          || budget.contextWindow !== undefined && input.components.system.heuristicTokens + input.components.toolSchemas.heuristicTokens + budget.safetyMargin >= (policy.thresholdRatio ?? .8) * budget.contextWindow, proof: token }
    } catch (error) {
      if ((error as { code?: string }).code === 'CONTEXT_INPUT_STALE') return { kind: 'stale' }
      if (modelFailureFacts(error)?.reason === 'native-replay') return { kind: 'blocked', reason: 'source-unrepresentable' }
      return { kind: 'blocked', reason: 'capacity-unavailable' }
    }
  }
  return ports = { capture, current, prepare, publish }
}
