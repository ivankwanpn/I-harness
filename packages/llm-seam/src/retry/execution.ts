import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ModelClient, LLMRequest, LLMStreamEvent, ModelRetryInfo } from '../index.ts'
import { backoffDelay, type ResolvedRetryPolicy } from './policy.ts'
import { retryErrorCode, isModelCapacityError } from '../provider-error/classify.ts'
import { terminalErrorCodes as TERMINAL_CODES } from '../provider-error/types.ts'
import { isGenerationError } from '../prepared/generation.ts'
import { isExecutionControlError } from '../prepared/execution.ts'
import { withOwnedPreparedRequests } from '../prepared/owned-wrappers.ts'

// Retry only the model request. Consumers must explicitly opt into discarding
// output; tools and earlier committed steps never belong to this boundary.
function createRetryingExecution(client: ModelClient, policy: ResolvedRetryPolicy, metadata?: { providerId?: string; modelId?: string }): ModelClient {
  async function* wrapped(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const requestId = randomUUID()
    let attemptNo = 0
    let recovery: ModelRetryInfo | undefined
    while (true) {
      request.signal?.throwIfAborted()
      if (recovery) yield { type: "retry", retry: { ...recovery, phase: "attempting" } }
      request.signal?.throwIfAborted()
      let produced = false
      let failure: unknown
      let failed = false
      let failureEvent: Extract<LLMStreamEvent, { type: "error" }> | undefined
      const pendingUsage: LLMStreamEvent[] = []
      try {
        for await (const ev of client.stream(request)) {
          request.signal?.throwIfAborted()
          const output = ev.type === "tool_call" || ((ev.type === "text/chunk" || ev.type === "reasoning") && ev.text.length > 0)
          if (output) produced = true
          if (ev.type === "usage") { pendingUsage.push(ev); continue }
          if (ev.type === "error") { failure = ev.error; failureEvent = ev; failed = true; break }
          if (recovery && (output || ev.type === "end")) {
            yield { type: "retry", retry: { ...recovery, phase: "recovered" } }
            recovery = undefined
          }
          if (ev.type === "end") { yield* pendingUsage; yield ev; return }
          yield ev
        }
      } catch (error) { failure = error; failed = true }
      request.signal?.throwIfAborted()
      if (!failed) {
        if (recovery) yield { type: "retry", retry: { ...recovery, phase: "recovered" } }
        yield* pendingUsage
        return
      }
      if (isGenerationError(failure) || isExecutionControlError(failure)) throw failure
      const code = retryErrorCode(failure)
      const retryable = !TERMINAL_CODES.has(code ?? "") && (policy.mode === "always" || policy.retryableCodes.includes(code ?? ""))
      const budgetExhausted = policy.mode === "normal" && attemptNo >= policy.maxRetries
      const detail = failure as { retryAfterAt?: number; httpStatus?: number } | undefined
      const serverWait = typeof detail?.retryAfterAt === "number" && Number.isFinite(detail.retryAfterAt) ? Math.max(0, detail.retryAfterAt - Date.now()) : 0
      if (retryable && (!produced || request.retryOutput === "discard") && !budgetExhausted && serverWait <= 60_000) {
        attemptNo++
        const capacityLimited = isModelCapacityError(failure)
        // Model capacity is temporary service load, not account quota. Give it
        // a fixed ten-second minimum while retaining any longer server advice.
        const delayMs = Math.max(serverWait, capacityLimited ? 10_000 : backoffDelay(policy, attemptNo))
        recovery = {
          requestId, phase: "waiting", attempt: attemptNo,
          ...(policy.mode === "normal" ? { maxRetries: policy.maxRetries } : {}),
          delayMs, nextAttemptAt: Date.now() + delayMs, code: capacityLimited ? "CAPACITY" : code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "UNKNOWN",
          ...(detail?.httpStatus === undefined ? {} : { httpStatus: detail.httpStatus }),
          ...(metadata?.providerId === undefined ? {} : { providerId: metadata.providerId.slice(0, 256) }),
          ...(metadata?.modelId === undefined ? {} : { modelId: metadata.modelId.slice(0, 256) }),
          ...(request.retryOutput === "discard" ? { discardOutput: true as const } : {}),
        }
        yield { type: "retry", retry: recovery }
        request.signal?.throwIfAborted()
        await delay(Math.max(0, recovery.nextAttemptAt! - Date.now()), undefined, { signal: request.signal })
        continue
      }
      if (failureEvent && !budgetExhausted) { yield failureEvent; return }
      throw failure
    }
  }
  return { stream: wrapped }
}


export function createRetryingClient(client: ModelClient, policy: ResolvedRetryPolicy, metadata?: { providerId?: string; modelId?: string }): ModelClient {
  return withOwnedPreparedRequests(client, inner => createRetryingExecution(inner, policy, metadata), { mode: policy.mode, maxRetries: policy.mode === 'normal' ? policy.maxRetries : 5 })
}
