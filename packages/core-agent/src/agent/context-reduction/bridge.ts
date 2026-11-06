import { captureContextPayload, reductionSourceCurrent, type ContextSnapshot, type ContextReductionPorts, type ReductionGroup, type ReductionPolicy, type ReductionRewrite, type ReductionPreparation } from '@i-harness/context-engine'
import { projectConversationCandidate } from '@i-harness/core-session'
import { prepareModelRequest, modelFailureFacts } from '@i-harness/llm-seam'
import { projectionFingerprint } from '@i-harness/token-meter'
import { randomUUID } from 'node:crypto'
import { buildContextRequest } from '../request-input.ts'
import { sameRequestCandidate, type RequestEvidence } from '../request-snapshot.ts'
import type { AgentDeps } from '../types.ts'
import type { createOwnedBudget } from '../budget.ts'
import { createReductionPublication } from './publication.ts'
import { softWorkFacts } from './automatic.ts'
import { assertCurrentRepresentable } from '../current-representability.ts'

interface Proof { source: ContextSnapshot; groups: readonly ReductionGroup[]; rewrites: readonly ReductionRewrite[]; rewriteIdentity: string; current: RequestEvidence; assessmentRevision: string; afterKey: string; targetReady: boolean }
type BridgeDeps=Pick<AgentDeps,'sessionId'|'captureContextReduction'|'assertFactOpen'|'registerFactSource'> & {signal?:AbortSignal;session?:AgentDeps['session'];requestContext?:Pick<NonNullable<AgentDeps['requestContext']>,'retain'|'current'>;previewReduction?:(rewrites:readonly ReductionRewrite[],options:{candidateId:string;ownerSessionId:string;capturePayload:(value:unknown)=>unknown})=>Promise<{projection:ContextSnapshot['conversation'];assertCurrent():void}>;reductionCommitted?:Parameters<typeof createReductionPublication>[5]}
/** Snapshots expose only immutable data. All clients, assessments and proofs stay private. */
export function createReductionBridge(deps: BridgeDeps, captureCandidate: () => RequestEvidence, ownedBudget: ReturnType<typeof createOwnedBudget>, bindingCurrent: () => boolean, policy: ReductionPolicy, signal = deps.signal, refresh = () => {}, requireSurface = true, requestScope?: import('@i-harness/llm-seam').LLMRequest['requestScope'], softStart?: import('@i-harness/core-session').SoftReductionStart, publicationAbsent?: () => Promise<void>): ContextReductionPorts {
  const evidence = new WeakMap<ContextSnapshot, RequestEvidence>(), proofs = new WeakMap<object, Proof>()
  let ports: ContextReductionPorts
  const capture = () => { refresh(); const value = captureCandidate(); evidence.set(value.snapshot, value); return value.snapshot }
  const current = (source: ContextSnapshot, groups: readonly ReductionGroup[]) => {
    try { const prior = evidence.get(source), now = captureCandidate(); return bindingCurrent() && !!prior && (!deps.requestContext || deps.requestContext.current(prior.instructions)) && prior.model === now.model && prior.bindingIdentity === now.bindingIdentity && reductionSourceCurrent(source, groups, now.snapshot, requireSurface) }
    catch { return false }
  }
  const preparationCurrent = (proof: Proof) => ports.current(proof.source, proof.groups) && (!deps.requestContext || deps.requestContext.current(proof.current.instructions)) && sameRequestCandidate(proof.current, captureCandidate()) && ownedBudget.assessmentRevision() === proof.assessmentRevision
  const publish = createReductionPublication(deps, (source, groups, rewrites, token) => {
    const proof = proofs.get(token)
    return !!proof && proof.source === source && proof.groups === groups && proof.rewrites === rewrites && proof.rewriteIdentity === projectionFingerprint(rewrites) && preparationCurrent(proof)
  }, token => {
    const proof = proofs.get(token)
    if (!softStart || softStart.seq === undefined || !proof) return undefined
    return { type: 'context/soft-reduction', version: 1, op: 'terminal', ownerSessionId: softStart.ownerSessionId, sequenceId: softStart.sequenceId,
      startSeq: { kind: 'prior', seq: softStart.seq, expectedType: 'context/soft-reduction' }, workKey: softStart.workKey, sourceKey: softStart.sourceKey,
      outcome: proof.targetReady ? 'target-ready' : 'reduced-over-target', publication: 'committed', consumedBeforeKey: softStart.workKey, consumedAfterKey: proof.afterKey }
  }, publicationAbsent, source => evidence.get(source)?.instructions,deps.reductionCommitted)
  async function prepare(source: ContextSnapshot, groups: readonly ReductionGroup[], rewrites: readonly ReductionRewrite[]): Promise<ReductionPreparation> {
    if (!ports.current(source, groups)) return { kind: 'stale' }
    const prior = evidence.get(source)!, now = captureCandidate(), assessmentRevision = ownedBudget.assessmentRevision()
    let conversation = now.snapshot.conversation
    let preview:{assertCurrent():void}|undefined
    try {
      if (rewrites.length) {const options={candidateId:randomUUID(),ownerSessionId:source.coordinates.ownerSessionId,capturePayload:(value:unknown)=>captureContextPayload(value)};if(deps.previewReduction){const candidate=await deps.previewReduction(rewrites,options);preview=candidate;candidate.assertCurrent();conversation=captureContextPayload(candidate.projection)}else{if(!deps.session)throw TypeError('Original reduction preview required');conversation=captureContextPayload(projectConversationCandidate(deps.session,rewrites,options).projection)}}
      const request = buildContextRequest({ conversation, surface: now.snapshot.surface }, { sessionId: deps.sessionId, signal, requestScope })
      const prepared = await prepareModelRequest(prior.model, request)
      preview?.assertCurrent()
      assertCurrentRepresentable(now, prepared)
      const assessed = ownedBudget.probe(prepared, now, rewrites.length > 0, policy.reserveRatio, policy)
      assertCurrentRepresentable(now, assessed.prepared)
      const pressure = assessed.decision.pressure
      const targetReady = assessed.capacityFit === 'yes' && pressure.kind === 'known' && pressure.targetReady
      const token = Object.freeze({}), proof = { source, groups, rewrites, rewriteIdentity: projectionFingerprint(rewrites), current: now, assessmentRevision,
        afterKey: softWorkFacts(now.snapshot, policy, conversation).workKey, targetReady }
      if (!preparationCurrent(proof)) return { kind: 'stale' }
      proofs.set(token, proof)
      const { input, packet } = assessed.prepared.measurement, budget = assessed.snapshot
      const bytes = packet.bodyBytes ?? packet.sdkCommandBytesEstimate ?? Object.values(input.components).reduce((n, component) => n + component.textUtf8Bytes + component.structuredBytes + component.binaryBytes, 0)
      return { kind: 'assessed', capacityFit: assessed.capacityFit, target: pressure.kind === 'unavailable' ? 'unavailable' : targetReady ? 'ready' : 'over-target',
        currentView: projectionFingerprint([now.snapshot.coordinates.semanticRevision, now.snapshot.coordinates.protectionRevision, now.snapshot.surfaceRevision, assessmentRevision]),
        inputTokens: budget.admissionInputTokens, inputBytes: bytes, inputByteKind: packet.sizeKind, inputFingerprint: input.inputFingerprint,
        shape: projectionFingerprint([input.bindingFingerprint, input.shapeFingerprint, now.snapshot.surface.binding]), fixedInput: input.overriddenInputFields.includes('messages')
          || pressure.kind === 'known' && input.components.system.heuristicTokens + input.components.toolSchemas.heuristicTokens > pressure.target, proof: token }
    } catch (error) {
      if ((error as { code?: string }).code === 'CONTEXT_INPUT_STALE') return { kind: 'stale' }
      if ((error as { code?: string }).code === 'CONTEXT_CURRENT_UNREPRESENTABLE') return { kind: 'blocked', reason: 'source-unrepresentable' }
      if (modelFailureFacts(error)?.reason === 'native-replay') return { kind: 'blocked', reason: 'source-unrepresentable' }
      // A rejected replacement candidate (protected sources, incomplete units,
      // ambiguous turns) is a source-shape problem, not a capacity fact.
      if ((error as { code?: string } | null)?.code === 'SESSION_CONTEXT_REPLACEMENT_FORMAT') return { kind: 'blocked', reason: 'source-unrepresentable' }
      return { kind: 'blocked', reason: 'capacity-unavailable' }
    }
  }
  return ports = { capture, current, prepare, publish }
}
