import { retainModelAcceptance, type LiveInvocation } from '../tool-batch/live-continuation.ts'
import { randomUUID } from "node:crypto"
import { isNondurableSession, type AcceptedRequestAttributionV1, type ExchangeAcceptedEvent, type AcceptedDraft, type ProducerFactOutcome, type CapturedActionFact } from "@i-harness/core-session"
import { agentFacts, committedFactSeqs } from './facts.ts'
import type { AgentDeps } from "./types.ts"
import type { ModelStep } from "./model-step.ts"

export interface ModelAttemptIdentity { actionId: string; attemptId: string; stepStartSeq: number }
export async function ensureConversationSemantics(deps: Pick<AgentDeps, 'session' | 'facts'>): Promise<void> {
  if (deps.session.events.some(event => event.type === "conversation/semantics")) return
  committedFactSeqs(await agentFacts(deps).agent.lifecycle({ type: "conversation/semantics", version: 1, mode: "accepted-exchange-v1" }))
}
/** Assistant and acceptance share one receipt before any effect preparation. */
export async function acceptModelExchange(deps: Pick<AgentDeps, "session" | "flush" | 'facts' | 'generationAction' | 'captureModelExchange'> & { liveInvocation?: LiveInvocation }, input: { identity: ModelAttemptIdentity; step: ModelStep; request?: AcceptedRequestAttributionV1; onAccepted?: (event: ExchangeAcceptedEvent) => void; onOutcome?: (outcome: ProducerFactOutcome) => void; onCapture?: (capture: CapturedActionFact<ProducerFactOutcome>) => void; signal?: AbortSignal }): Promise<import('./request-context.ts').AcceptedExchange> {
  const { identity, step, signal } = input
  if (signal?.aborted) throw new Error("agent aborted")
  if (!step.providerEnded) throw Object.assign(new Error("Model response ended without an explicit completion"), { code: "MODEL_RESPONSE_INCOMPLETE" })
  const request = input.request
  if (request && (!step.receipt || step.receipt.candidateId !== request.candidateId || step.receipt.sendId !== request.sendId || step.receipt.payloadId !== request.payloadId || step.receipt.semanticId !== request.semanticId || step.receipt.payloadKind !== request.payloadKind || step.receipt.identity?.authEpoch !== request.executionEpochId || step.receipt.actionId !== identity.actionId || step.receipt.attemptId !== identity.attemptId)) throw new Error("Acceptance receipt does not match physical attempt")
  const acceptance: AcceptedDraft = { type: "model/exchange-accepted", ...(request ? { version: 2 as const, request } : { version: 1 as const }), exchangeId: randomUUID(), actionId: identity.actionId, attemptId: identity.attemptId,
    stepStartSeq: { kind: 'prior', seq: identity.stepStartSeq, expectedType: 'step/start' }, assistantSeq: { kind: 'group', position: 0, expectedType: 'assistant/message' },
    callSeqs: step.batch.map(call => ({ kind: 'prior', seq: call.eventSeq!, expectedType: 'tool/call' })),
  }
  let originalCapture: object | undefined
  let seqs: readonly number[]
  let acceptedOutcome: import('./request-context.ts').AcceptedExchange['outcome']
  try {
    const assistant = { type: 'assistant/message' as const, text: step.stepText,
      ...(step.thinkingBlocks?.length ? { thinkingBlocks: step.thinkingBlocks } : {}), ...(step.providerContinuation ? { providerContinuation: step.providerContinuation } : {}),
    }, generation = deps.generationAction?.acceptance(step.receipt)
    const capture = deps.captureModelExchange?.(assistant, acceptance, generation)
    originalCapture = capture
    if (capture) input.onCapture?.(capture)
    const outcome = await (capture ? capture.admit() : agentFacts(deps).agent.accept(assistant, acceptance, generation))
    input.onOutcome?.(outcome)
    seqs = committedFactSeqs(outcome)
    if (outcome.kind !== 'committed' && outcome.kind !== 'memory-committed') throw new Error('Acceptance outcome unavailable')
    acceptedOutcome = outcome
  } catch (error) {
    // The explicit memory API retains its synchronous append-hook contract.
    // An observer may throw after insertion; this is no durable receipt.
    if (isNondurableSession(deps.session)) {
      const inserted = deps.session.events.findLast(event => event.type === 'model/exchange-accepted' && event.exchangeId === acceptance.exchangeId)
      if (inserted?.type === 'model/exchange-accepted') input.onAccepted?.(inserted)
    }
    throw error
  }
  const acceptedSeq = seqs[1]!, written = deps.session.events[acceptedSeq]
  if (written?.type !== 'model/exchange-accepted') throw new Error('Committed acceptance is unavailable')
  input.onAccepted?.(written)
  await deps.flush?.()
  signal?.throwIfAborted()
  const accepted = { acceptedSeq, outcome: acceptedOutcome }
  retainModelAcceptance(deps.liveInvocation, accepted, originalCapture, deps.generationAction, step.batch)
  return accepted
}
