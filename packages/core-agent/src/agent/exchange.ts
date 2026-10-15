import { randomUUID } from "node:crypto"
import { append, type Session, type AcceptedRequestAttributionV1, type ExchangeAcceptedEvent } from "@i-harness/core-session"
import type { AgentDeps } from "./types.ts"
import type { ModelStep } from "./model-step.ts"

export interface ModelAttemptIdentity { actionId: string; attemptId: string; stepStartSeq: number }
/** Called after the host has restored/seeded the archive, at the first new turn. */
export function ensureConversationSemantics(session: Session): void {
  if (session.events.some(event => event.type === "conversation/semantics")) return
  append(session, { type: "conversation/semantics", version: 1, mode: "accepted-exchange-v1" })
}
/** Sole accepted-response append owner. The next owner may prepare tools only after this checkpoint. */
export async function acceptModelExchange(deps: Pick<AgentDeps, "session" | "flush">, input: { identity: ModelAttemptIdentity; step: ModelStep; request?: AcceptedRequestAttributionV1; onAccepted?: (event: ExchangeAcceptedEvent) => void; signal?: AbortSignal }): Promise<number> {
  const { identity, step, signal } = input
  if (signal?.aborted) throw new Error("agent aborted")
  if (!step.providerEnded) throw Object.assign(new Error("Model response ended without an explicit completion"), { code: "MODEL_RESPONSE_INCOMPLETE" })
  append(deps.session, { type: "assistant/message", text: step.stepText,
    ...(step.thinkingBlocks?.length ? { thinkingBlocks: step.thinkingBlocks } : {}),
    ...(step.providerContinuation ? { providerContinuation: step.providerContinuation } : {}),
  })
  const assistantSeq = deps.session.events.length - 1
  const acceptedSeq = deps.session.events.length
  const request = input.request
  if (request && (!step.receipt || step.receipt.candidateId !== request.candidateId || step.receipt.sendId !== request.sendId || step.receipt.payloadId !== request.payloadId || step.receipt.semanticId !== request.semanticId || step.receipt.payloadKind !== request.payloadKind || step.receipt.identity?.authEpoch !== request.executionEpochId || step.receipt.actionId !== identity.actionId || step.receipt.attemptId !== identity.attemptId)) throw new Error("Acceptance receipt does not match physical attempt")
  const acceptance: ExchangeAcceptedEvent = { type: "model/exchange-accepted", ...(request ? { version: 2 as const, request } : { version: 1 as const }), exchangeId: randomUUID(), ...identity, assistantSeq, callSeqs: step.batch.map(call => call.eventSeq!) }
  const exact = JSON.stringify({ ...acceptance, seq: acceptedSeq })
  try { append(deps.session, acceptance) }
  finally {
    const written = deps.session.events[acceptedSeq]
    if (written?.type === "model/exchange-accepted" && JSON.stringify(written) === exact) input.onAccepted?.(written)
  }
  await deps.flush?.()
  return acceptedSeq
}
