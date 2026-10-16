import { agentFacts, committedFactSeqs } from "./facts.ts"
import { randomUUID } from "node:crypto"
import { deriveContextRecovery, type ContextRecoveryFacts } from "@i-harness/core-session"
import { modelFailureFacts } from "@i-harness/llm-seam"
import type { PreparedRequestMeasurement } from "@i-harness/token-meter"
import type { AgentDeps } from "./types.ts"
import type { AgentContext } from "./context.ts"

export interface RecoveryAdmissionState {
  recoveryCompacted?: boolean
  recoveryId?: string
  recoveryInputFingerprint?: string
}
const cost = (measurement: PreparedRequestMeasurement) => Object.values(measurement.input.components).reduce((total, c) => ({ tokens: total.tokens + c.heuristicTokens, bytes: total.bytes + c.textUtf8Bytes + c.structuredBytes + c.binaryBytes }), { tokens: 0, bytes: 0 })

/** One model-attempt owner; no inbox claims, hooks, tools or reset lane. */
export function createRecovery(deps: AgentDeps, context: AgentContext) {
  const ownerSessionId = context.ownedBudget.ownerSessionId
  let lastFailure: unknown
  const current = (measurement: PreparedRequestMeasurement) => deriveContextRecovery(deps.session, ownerSessionId, { ...measurement.input, providerId: context.metadata()?.providerId ?? measurement.input.providerId })
  const flush = async (signal?: AbortSignal) => { await deps.flush?.(); signal?.throwIfAborted() }
  const fact = async (previous: ContextRecoveryFacts, state: ContextRecoveryFacts["state"], extra: Partial<ContextRecoveryFacts> = {}) => {
    // Fold results may include the event envelope. Always publish only fields
    // from the scalar contract, never an inherited seq/type.
    const { version, ownerSessionId, recoveryId, logicalStepSeq, bindingFingerprint, rejectedInputFingerprint,
      inputTokens, contextLimit, providerId, modelId, protocol, shapeFingerprint, bindingConfigFingerprint,
      identityCoverage, inputCost, inputBytes, retryConsumed, retryInputFingerprint } = previous
    committedFactSeqs(await agentFacts(deps).metadata.admit({ type: "context/recovery", version, ownerSessionId, recoveryId, logicalStepSeq, bindingFingerprint, rejectedInputFingerprint,
      inputTokens, contextLimit, providerId, modelId, protocol, shapeFingerprint, bindingConfigFingerprint, identityCoverage, inputCost, inputBytes, retryConsumed, retryInputFingerprint, state, ...extra }))
  }
  const blocked = async (previous: ContextRecoveryFacts, reason: string, signal?: AbortSignal): Promise<never> => {
    await fact(previous, "blocked", { reason }); await flush(signal)
    throw Object.assign(new Error(`prompt_too_long: ${reason}`, { cause: lastFailure }), { code: "CONTEXT_WINDOW_EXCEEDED", recoveryBlocked: true })
  }
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
    async require(error: unknown, measurement: PreparedRequestMeasurement, logicalStepSeq: number, signal?: AbortSignal) {
      const failure = modelFailureFacts(error)
      if (failure?.code !== "CONTEXT_WINDOW_EXCEEDED" || failure.reason !== "context-limit") return false
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
      if (required.retryConsumed) await blocked(required, "The changed-input recovery attempt was also rejected; automatic retry is exhausted", signal)
      return true
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
      if (state.recoveryCompacted || !context.compactor) return blocked(previous, "Protected or fixed input cannot be reduced under the rejected binding and shape", signal)
      state.recoveryCompacted = true
      const turn = deps.session.events.findLastIndex(event => event.type === "turn/start")
      const start = deps.session.events.findIndex((event, index) => index > turn && event.type === "user/message")
      const protectedSeqs = deps.session.events.slice(Math.max(0, start)).flatMap(event => event.seq === undefined ? [] : [event.seq])
      const result = await context.compactor.recover(deps.session, { signal, protectedSeqs, reason: "recovery", maxSummaryCalls: 8 })
      await flush(signal)
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
        await fact(previous, "resolved"); await flush(signal)
      } catch (error) {
        await fact(previous, "blocked", { reason: "Accepted main recovery resolution checkpoint did not complete" })
        // Persist the conservative state even when Stop was the reason. The
        // enclosing failed-turn owner remains responsible for save failures.
        try { await deps.flush?.() } catch { /* original checkpoint failure wins */ }
        throw error
      }
    },
  }
}
