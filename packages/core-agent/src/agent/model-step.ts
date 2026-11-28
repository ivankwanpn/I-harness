import { agentFacts, committedFactSeqs } from "./facts.ts"
import { type ModelActivityInfo } from "@i-harness/core-session"
import type { LLMStreamEvent, LLMUsage } from "@i-harness/llm-seam"
import { modelFailureFacts, consumeRetryFailure, mergeUsageReport, hasConflictingUsage } from "@i-harness/llm-seam"
import type { BatchCall } from "../execute-tool-calls.ts"
import type { AgentDeps, TurnLifecycle } from "./types.ts"
import { createStepReasoning } from "./reasoning.ts"
import { TOOL_ABORTED_BEFORE_DISPATCH } from "@i-harness/core-tools"
import { randomUUID } from "node:crypto"
import { closeStepBoundary, failStepBoundary, openStepBoundary } from './boundaries.ts'
import { savingFailure } from './saving-failure.ts'
import { reportModelUsage } from './finalization.ts'
import {modelStreamSource,type ModelStreamDependencies} from './stream-source.ts'

export function createModelStep(deps: ModelStreamDependencies & Pick<AgentDeps,'telemetry'>, reasoning: string[], recordCall: (ev: Extract<LLMStreamEvent, { type: "tool_call" }>) => Promise<BatchCall>, lifecycle: TurnLifecycle, initialStartSeq: number, abort: AbortSignal | undefined, getSteps: () => number, originalStart?:Extract<import('@i-harness/core-session').SessionEventView,{type:'step/start'}>) {
  const stream=modelStreamSource(deps)
  let stepStartSeq = initialStartSeq
  const initialStart = originalStart??deps.session?.events[initialStartSeq]
  if(!deps.session&&(!originalStart||originalStart.seq!==initialStartSeq))throw TypeError('Original private step member required')
  const actionId = initialStart?.type === "step/start" ? initialStart.actionId! : ""
  let attemptId = initialStart?.type === "step/start" ? initialStart.attemptId! : ""
  let reopenedRetry: string | undefined
  let endFingerprint: string | undefined
  let receipt: (import("@i-harness/llm-seam").ExecutionReceipt & { actionId: string; attemptId: string }) | undefined
  let stepText = ""
  let toolCallsThisStep = 0
  // Reports merge within this attempt; a discarded retry resets usage.
  let stepUsage: LLMUsage = {}
  let usageReported = false
  let firstOutputAt: number | undefined
  let streamEndedAt: number | undefined
  const reasoningStart = reasoning.length
  const batch: BatchCall[] = []
  // Endings belong to this step. Truncated and refused are independent bits;
  // neither leaks into a subsequent step or gets recorded as false.
  let truncatedThisStep = false
  let refusedThisStep = false
  let thinkingBlocks: Extract<LLMStreamEvent, { type: "end" }>["thinkingBlocks"]
  let providerContinuation: Extract<LLMStreamEvent, { type: "end" }>["providerContinuation"]
  const stepReasoning = createStepReasoning(deps, reasoning, abort, () => stepStartSeq)
  let previewOffset = 0
  let previewTimer: ReturnType<typeof setTimeout> | undefined
  let previewParts: string[] = []
  let previewError: { cause: unknown } | undefined
  const clearPreviewTimer = () => {
    if (previewTimer !== undefined) clearTimeout(previewTimer)
    previewTimer = undefined
  }
  const flushPreview = () => {
    clearPreviewTimer()
    if (previewParts.length === 0) return
    const text = previewParts.join("")
    previewParts = []
    if (abort?.aborted) return
    const offset = previewOffset
    previewOffset += text.length
    stream.publish({ type: "assistant/chunk", stepStartSeq, offset, text })
  }
  const publishText = (text: string) => {
    previewParts.push(text)
    if (previewOffset === 0) flushPreview()
    else if (previewTimer === undefined) previewTimer = setTimeout(() => {
      try { flushPreview() }
      catch (cause) { previewError = { cause } }
    }, 50)
  }
  let modelActivity: ModelActivityInfo | undefined
  let modelFailed = false
  let providerEnded = false
  let failedSettlement: Promise<void> | undefined
  function discard(error?: unknown) {
    return failedSettlement ??= settleFailedAttempt(error).catch(error => {
      // A backend-proven absence still owns this captured audit operation.
      // Keep optional work fenced until its existing source can settle it.
      deps.sourceFacts?.holdRecovery()
      throw error
    })
  }
  async function settleFailedAttempt(error?: unknown) {
    modelFailed = true
    clearPreviewTimer()
    previewParts = []
    const failedBatch = [...batch], failedText = stepText
    const nativeThinking = thinkingBlocks, nativeContinuation = providerContinuation
    // Retain all local outcomes before the first awaited save. If an audit
    // acknowledgment is lost, the existing source can finish these exact
    // captures after reconciliation without recreating the failed attempt.
    const results = failedBatch.map(call => {
      const event = { type: "tool/result" as const, callId: call.callId, name: call.name, isError: true as const,
        output: { code: TOOL_ABORTED_BEFORE_DISPATCH, error: "Model attempt was not accepted; tool call was not dispatched" } }
      return deps.sourceFacts?.tools.captureResult(event) ?? { admit: () => agentFacts(deps).tools.result(event) }
    })
    await stepReasoning.flush()
    if (failedText || nativeThinking?.length || nativeContinuation || truncatedThisStep || refusedThisStep) {
      committedFactSeqs(await (deps.sourceFacts?.lifecycle ?? agentFacts(deps).agent).auditAssistant({ type: "assistant/message", text: failedText, ...(nativeThinking?.length ? { thinkingBlocks: nativeThinking } : {}), ...(nativeContinuation ? { providerContinuation: nativeContinuation } : {}) }))
    }
    for (const result of results) committedFactSeqs(await result.admit())
    await failStepBoundary(deps,lifecycle,error)
    await closeStepBoundary(deps,lifecycle,{type:'step/end', ...(truncatedThisStep ? { truncated: true } : {}), ...(refusedThisStep ? { refused: true } : {})})
  }
  return {
    confirm(received: import("@i-harness/llm-seam").ExecutionReceipt) { receipt = { ...received, actionId, attemptId } },
    discard,
    async accept(ev: LLMStreamEvent) {
      // Billing observations may finish crossing the stream boundary after
      // Stop. Accumulate them on this original attempt without publishing
      // content or accepting completion; the failure owner reports them.
      if (ev.type === 'usage') {
        mergeUsageReport(stepUsage, ev.usage)
        return
      }
      abort?.throwIfAborted()
      const receivedAt = ev.type === "text/chunk" || ev.type === "reasoning" || ev.type === "end" ? performance.now() : undefined
      const settlingRetry = ev.type === "retry" && !providerEnded && ev.retry.phase === "waiting" && reopenedRetry !== `${ev.retry.requestId}:${ev.retry.attempt}`
      // Stop above remains authoritative. Once handling a genuine waiting event,
      // retain its provider failure before publication checks can throw.
      const originalFailure = ev.type === "retry" && ev.retry.phase === "waiting" ? consumeRetryFailure(ev) : undefined
      try {
        stepReasoning.checkPublication()
        if (previewError) throw previewError.cause
        if (providerEnded && ["text/chunk", "tool_call", "reasoning"].includes(ev.type)) throw Object.assign(new Error("Model produced content after completion"), { code: "MODEL_RESPONSE_INCOMPLETE" })
        // Live text can precede the durable reasoning acknowledgement. The
        // canonical attempt still observes the original write order.
        if (ev.type === "text/chunk" && ev.text.length > 0) publishText(ev.text)
        if (ev.type === "end" || ev.type === "tool_call") flushPreview()
        // Failed reasoning belongs to the cached settlement, not a preliminary
        // save that could be recaptured by the outer failure/finalization path.
        if (ev.type !== "reasoning" && ev.type !== "activity" && !settlingRetry) await stepReasoning.flush()
      } catch (saving) {
        if (originalFailure) throw savingFailure(originalFailure.failure, [saving], 'model retry settlement failed')
        throw saving
      }
      switch (ev.type) {
        case "activity":
          modelActivity = ev.activity
          stream.publish({ type: "model/activity", version: 1, ts: Date.now(), activity: ev.activity })
          break
        case "retry":
          if (settlingRetry) {
            try {
              if ((stepText || batch.length) && !ev.retry.discardOutput) throw new Error("model retry cannot preserve partial output")
              reopenedRetry = `${ev.retry.requestId}:${ev.retry.attempt}`
              // Mark delivery before invoking an observer: a throwing sink
              // must not cause the response catch to report these counters twice.
              usageReported = true
              if (Object.keys(stepUsage).length) reportModelUsage(deps, { stepUsage })
              await discard()
            } catch (saving) {
              if (originalFailure) throw savingFailure(originalFailure.failure, [saving], 'model retry settlement failed')
              throw saving
            }
            stepUsage = {}
            usageReported = false
            firstOutputAt = undefined
            streamEndedAt = undefined
            stepText = ""
            previewOffset = 0
            toolCallsThisStep = 0
            batch.length = 0
            receipt = undefined
            reasoning.length = reasoningStart
            stepReasoning.resetBlockIndex()
            truncatedThisStep = false
            refusedThisStep = false
            thinkingBlocks = undefined
            providerContinuation = undefined
            providerEnded = false
            endFingerprint = undefined
            attemptId = randomUUID()
            stepStartSeq = committedFactSeqs(await agentFacts(deps).agent.lifecycle({ type: "step/start", actionId, attemptId }))[0]!
            openStepBoundary(lifecycle)
            failedSettlement = undefined
            modelFailed = false
          }
          committedFactSeqs(await agentFacts(deps).agent.lifecycle({ type: "model/retry", version: 1, ts: Date.now(), retry: ev.retry }))
          break
        case "text/chunk":
          if (ev.text.length > 0) firstOutputAt ??= receivedAt
          stepText += ev.text
          break
        case "reasoning":
          if (ev.text.length > 0) firstOutputAt ??= receivedAt
          await stepReasoning.accept(ev)
          break
        case "tool_call": {
          batch.push(await recordCall(ev))
          toolCallsThisStep += 1
          break
        }
        case "error": {
          const modelFailure = modelFailureFacts(ev.error)
          const failure = Object.assign(new Error(`model stream error: ${ev.error.message}`, { cause: ev.error }), {
            code: (ev.error as Error & { code?: string }).code,
            httpStatus: (ev.error as Error & { httpStatus?: number }).httpStatus,
            ...(modelFailure ? { modelFailure } : {}),
          })
          try {
            deps.telemetry?.emit({ type: "provider/error", ts: Date.now(), data: { step: getSteps(), error: modelFailure?.message ?? "Model request failed.", ...(modelFailure ? { modelFailure } : {}) } })
          } catch (reporting) { throw savingFailure(failure, [reporting], 'model error reporting failed') }
          throw failure
        }
        case "end":
          if (providerEnded && endFingerprint !== JSON.stringify(ev)) throw Object.assign(new Error("Conflicting model completion records"), { code: "MODEL_RESPONSE_INCOMPLETE" })
          endFingerprint = JSON.stringify(ev)
          streamEndedAt ??= receivedAt
          providerEnded = true
          thinkingBlocks = ev.thinkingBlocks
          providerContinuation = ev.providerContinuation
          // Report ending bits to telemetry here and to the durable step end
          // later. Absent stays absent; neither bit is written as false.
          if (ev.truncated === true) {
            truncatedThisStep = true
            deps.telemetry?.emit({ type: "provider/truncated", ts: Date.now(), data: { step: getSteps() } })
          }
          if (ev.refused === true) {
            refusedThisStep = true
            deps.telemetry?.emit({ type: "provider/refused", ts: Date.now(), data: { step: getSteps() } })
          }
          break
      }
    },
    async fail(error: unknown): Promise<never> {
      try { await discard(error) }
      catch (saving) {
        throw savingFailure(error, [saving], 'model attempt saving failed')
      }
      throw error
    },
    async settle() {
      clearPreviewTimer()
      previewParts = []
      if (modelActivity && modelActivity.phase !== "settled") {
        stream.publish({ type: "model/activity", version: 1, ts: Date.now(), activity: { ...modelActivity, phase: "settled", outcome: abort?.aborted ? "cancelled" : modelFailed ? "failed" : "completed" } })
      }
      await (failedSettlement ?? stepReasoning.flush())
    },
    result() {
      const outputTokens = stepUsage.outputTokens
      const generationMs = firstOutputAt === undefined || streamEndedAt === undefined ? 0 : Math.round(streamEndedAt - firstOutputAt)
      const generation = !modelFailed && !hasConflictingUsage(stepUsage) && outputTokens !== undefined && Number.isSafeInteger(outputTokens) && outputTokens > 0 && generationMs > 0
        ? { outputTokens, generationMs } : undefined
      return { receipt, stepText, toolCallsThisStep, batch, stepUsage: usageReported ? {} : stepUsage, generation, truncatedThisStep, refusedThisStep, thinkingBlocks, providerContinuation, providerEnded, identity: { actionId, attemptId, stepStartSeq } }
    },
  }
}

export type ModelStep = ReturnType<ReturnType<typeof createModelStep>["result"]>
