import { agentFacts, committedFactSeqs } from "./facts.ts"
import { randomUUID } from "node:crypto"
import { deriveContextRecovery, type ContextRecoveryFacts } from "@i-harness/core-session"
import { modelFailureFacts } from "@i-harness/llm-seam"
import type { PreparedRequestMeasurement } from "@i-harness/token-meter"
import type { AgentDeps } from "./types.ts"
import type { AgentContext } from "./context.ts"
import { createRecoverySettlement } from './recovery-settlement.ts'
import { savingFailure } from './saving-failure.ts'

export interface RecoveryAdmissionState {
  reductionAttempts?: import('@i-harness/context-engine').ReductionAttempts
  recoveryCompacted?: boolean
  recoveryId?: string
  recoveryInputFingerprint?: string
}
type BlockedRecoveryError = Error & { code: 'CONTEXT_WINDOW_EXCEEDED'; recoveryBlocked: true }
export type RecoveryRequirement = { kind: 'not-applicable' } | { kind: 'required' } | { kind: 'blocked'; error: BlockedRecoveryError }
const cost = (measurement: PreparedRequestMeasurement) => Object.values(measurement.input.components).reduce((total, c) => ({ tokens: total.tokens + c.heuristicTokens, bytes: total.bytes + c.textUtf8Bytes + c.structuredBytes + c.binaryBytes }), { tokens: 0, bytes: 0 })

/** One model-attempt owner; no inbox claims, hooks, tools or reset lane. */
type RecoveryDeps=Pick<AgentDeps,'facts'|'registerFactSource'|'flush'> & {generationAction?:Pick<NonNullable<AgentDeps['generationAction']>,'phase'>;session?:AgentDeps['session'];recoveryObservation?:(binding:{providerId?:string;modelId:string;protocol:string})=>ContextRecoveryFacts|undefined}
type RecoveryContext=Pick<AgentContext,'ownedBudget'|'metadata'> & {compactor?:AgentContext['compactor'];recoverOwned?:(options:Parameters<NonNullable<AgentContext['compactor']>['recover']>[1])=>ReturnType<NonNullable<AgentContext['compactor']>['recover']>}
export function createRecovery(deps: RecoveryDeps, context: RecoveryContext) {
  const terminal = createRecoverySettlement(deps)
  const ownerSessionId = context.ownedBudget.ownerSessionId
  let lastFailure: unknown
  const current = (measurement: PreparedRequestMeasurement) => {const binding={...measurement.input,providerId:context.metadata()?.providerId??measurement.input.providerId};if(deps.recoveryObservation)return deps.recoveryObservation(binding);if(!deps.session)throw TypeError('Original recovery observation required');return deriveContextRecovery(deps.session,ownerSessionId,binding)}
  const flush = async (signal?: AbortSignal) => { await deps.flush?.(); signal?.throwIfAborted() }
  const draft = (previous: ContextRecoveryFacts, state: ContextRecoveryFacts["state"], extra: Partial<ContextRecoveryFacts> = {}) => {
    // Fold results may include the event envelope. Always publish only fields
    // from the scalar contract, never an inherited seq/type.
    const { version, ownerSessionId, recoveryId, logicalStepSeq, bindingFingerprint, rejectedInputFingerprint,
      inputTokens, contextLimit, providerId, modelId, protocol, shapeFingerprint, bindingConfigFingerprint,
      identityCoverage, inputCost, inputBytes, retryConsumed, retryInputFingerprint } = previous
    return { type: 'context/recovery' as const, version, ownerSessionId, recoveryId, logicalStepSeq, bindingFingerprint, rejectedInputFingerprint,
      inputTokens, contextLimit, providerId, modelId, protocol, shapeFingerprint, bindingConfigFingerprint, identityCoverage, inputCost, inputBytes, retryConsumed, retryInputFingerprint, state, ...extra }
  }
  const fact = async (previous: ContextRecoveryFacts, state: ContextRecoveryFacts["state"], extra: Partial<ContextRecoveryFacts> = {}) => {
    const event = draft(previous, state, extra)
    if (state === 'blocked' || state === 'resolved') await terminal.publish({ ...event, state })
    else if (state === 'retry-started' && deps.generationAction) await deps.generationAction.phase(event)
    else committedFactSeqs(await agentFacts(deps).metadata.admit(event))
  }
  const persistBlocked = async (previous: ContextRecoveryFacts, reason: string, signal?: AbortSignal): Promise<BlockedRecoveryError> => {
    await fact(previous, "blocked", { reason }); await terminal.checkpoint(signal)
    return Object.assign(new Error(`prompt_too_long: ${reason}`, { cause: lastFailure }), { code: "CONTEXT_WINDOW_EXCEEDED" as const, recoveryBlocked: true as const })
  }
  const blocked = async (previous: ContextRecoveryFacts, reason: string, signal?: AbortSignal): Promise<never> => { throw await persistBlocked(previous, reason, signal) }
  const progressed = (previous: ContextRecoveryFacts, measurement: PreparedRequestMeasurement) => {
    const input = measurement.input, candidateCost = cost(measurement)
    return input.coverage !== "incomplete" && !input.overriddenInputFields.some(field => field === "messages" || field === "system")
      && previous.bindingFingerprint === input.bindingFingerprint && previous.shapeFingerprint === input.shapeFingerprint
      && previous.bindingConfigFingerprint === context.metadata()?.bindingConfigFingerprint
      && previous.rejectedInputFingerprint !== input.inputFingerprint
      && previous.inputCost !== undefined && candidateCost.tokens < previous.inputCost
      && previous.inputBytes !== undefined && candidateCost.bytes <= previous.inputBytes
  }
  return {
    close: terminal.close,
    async require(error: unknown, measurement: PreparedRequestMeasurement, logicalStepSeq: number, signal?: AbortSignal): Promise<RecoveryRequirement> {
      const failure = modelFailureFacts(error)
      if (failure?.code !== "CONTEXT_WINDOW_EXCEEDED" || failure.reason !== "context-limit") return { kind: 'not-applicable' }
      lastFailure = error
      const previous = current(measurement), input = measurement.input, measured = cost(measurement)
      const metadata = context.metadata()
      const required: ContextRecoveryFacts = { version: 1, ownerSessionId, recoveryId: previous && previous.state !== "resolved" ? previous.recoveryId : randomUUID(), logicalStepSeq,
        bindingFingerprint: input.bindingFingerprint, rejectedInputFingerprint: input.inputFingerprint, shapeFingerprint: input.shapeFingerprint,
        ...(metadata?.providerId ?? input.providerId ? { providerId: metadata?.providerId ?? input.providerId } : {}), modelId: input.modelId, protocol: input.protocol,
        ...(metadata?.bindingConfigFingerprint ? { bindingConfigFingerprint: metadata.bindingConfigFingerprint } : {}), identityCoverage: metadata?.identityCoverage ?? "partial",
        inputCost: measured.tokens, inputBytes: measured.bytes, retryConsumed: previous?.state !== "resolved" && (previous?.retryConsumed === true || previous?.state === "retry-started"), state: "required",
        ...(failure.inputTokens !== undefined ? { inputTokens: failure.inputTokens } : {}), ...(failure.contextLimit !== undefined ? { contextLimit: failure.contextLimit } : {}) }
      await fact(required, "required"); await flush(signal)
      if (required.retryConsumed) return { kind: 'blocked', error: await persistBlocked(required, "The changed-input recovery attempt was also rejected; automatic retry is exhausted", signal) }
      return { kind: 'required' }
    },
    async admit(measurement: PreparedRequestMeasurement, state: RecoveryAdmissionState, signal?: AbortSignal): Promise<"clear" | "authorized" | "rebuild"> {
      const previous = current(measurement)
      if (!previous || previous.state === "resolved") return "clear"
      if (state.recoveryId === previous.recoveryId && state.recoveryInputFingerprint === measurement.input.inputFingerprint && previous.state === "retry-started" && progressed(previous, measurement)) return "authorized"
      if (previous.retryConsumed || previous.state === "retry-started") return blocked(previous, "Recovery retry was already consumed; no automatic attempt is permitted", signal)
      if (progressed(previous, measurement)) {
        // The projection itself, including local edits, must pass a durable
        // barrier before consuming the one main retry allowance.
        await flush(signal)
        await fact(previous, "retry-started", { retryConsumed: true, retryInputFingerprint: measurement.input.inputFingerprint })
        await flush(signal)
        state.recoveryId = previous.recoveryId; state.recoveryInputFingerprint = measurement.input.inputFingerprint
        return "authorized"
      }
      if (state.recoveryCompacted || !context.compactor&&!context.recoverOwned) return blocked(previous, "Protected or fixed input cannot be reduced under the rejected binding and shape", signal)
      state.recoveryCompacted = true
      const attempts = state.reductionAttempts ??= { count: 0, staleRebuilds: 0 }
      const options={signal,reason:'recovery' as const,maxSummaryCalls:8,attempts}
      const result = context.recoverOwned?await context.recoverOwned(options):await context.compactor!.recover(deps.session!,options)
      await flush(signal)
      if (result.publication === 'recovery-required') throw Object.assign(new Error('Context reduction publication requires reconciliation'), { code: 'FACT_RECOVERY_REQUIRED' })
      if (!result.compacted) return blocked(previous, result.blockedReason ? "Bounded summary admission could not produce a recovery checkpoint" : "No balanced older material can produce a reduced recovery input", signal)
      return "rebuild"
    },
    validate(measurement: PreparedRequestMeasurement, state: RecoveryAdmissionState) {
      const previous = current(measurement)
      if (previous && previous.state !== "resolved" && !(previous.state === "retry-started" && state.recoveryId === previous.recoveryId && state.recoveryInputFingerprint === measurement.input.inputFingerprint && progressed(previous, measurement))) {
        throw Object.assign(new Error("Provider rejection requires an owned changed-input recovery attempt"), { code: "CONTEXT_WINDOW_EXCEEDED", recoveryBlocked: true })
      }
    },
    async resolve(measurement: PreparedRequestMeasurement, signal?: AbortSignal) {
      const previous = current(measurement)
      if (!previous || previous.state === "resolved") return
      try {
        // Accepted main output must be durable before declaring its recovery
        // successful. A failed/aborted resolution barrier stays inspectable.
        await flush(signal)
        await fact(previous, "resolved"); await terminal.checkpoint(signal)
      } catch (error) {
        try { await terminal.correct({ ...draft(previous, "blocked", { reason: "Accepted main recovery resolution checkpoint did not complete" }), state: 'blocked' }) }
        catch (saving) { throw savingFailure(error, [saving], 'Recovery correction saving failed') }
        throw error
      }
    },
  }
}
