import { agentFacts, committedFactSeqs } from "./facts.ts"
import { publishTransient, type ModelActivityInfo } from "@i-harness/core-session"
import type { LLMStreamEvent, LLMUsage } from "@i-harness/llm-seam"
import { modelFailureFacts, consumeRetryFailure } from "@i-harness/llm-seam"
import type { BatchCall } from "../execute-tool-calls.ts"
import type { AgentDeps, TurnLifecycle } from "./types.ts"
import { createStepReasoning } from "./reasoning.ts"
import { TOOL_ABORTED_BEFORE_DISPATCH } from "@i-harness/core-tools"
import { randomUUID } from "node:crypto"
import { closeStepBoundary, failStepBoundary, openStepBoundary } from './boundaries.ts'
import { savingFailure } from './saving-failure.ts'
import { reportModelUsage } from './finalization.ts'

export function createModelStep(deps: Pick<AgentDeps, "session" | "telemetry" | 'facts' | 'sourceFacts'>, reasoning: string[], recordCall: (ev: Extract<LLMStreamEvent, { type: "tool_call" }>) => Promise<BatchCall>, lifecycle: TurnLifecycle, initialStartSeq: number, abort: AbortSignal | undefined, getSteps: () => number) {
  let stepStartSeq = initialStartSeq
  const initialStart = deps.session.events[initialStartSeq]
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
  const reasoningStart = reasoning.length
  const batch: BatchCall[] = []
  // Endings belong to this step. Truncated and refused are independent bits;
  // neither leaks into a subsequent step or gets recorded as false.
  let truncatedThisStep = false
  let refusedThisStep = false
  let thinkingBlocks: Extract<LLMStreamEvent, { type: "end" }>["thinkingBlocks"]
  let providerContinuation: Extract<LLMStreamEvent, { type: "end" }>["providerContinuation"]
  const stepReasoning = createStepReasoning(deps, reasoning, abort, () => stepStartSeq)
  let modelActivity: ModelActivityInfo | undefined
  let modelFailed = false
  let providerEnded = false
  let failedSettlement: Promise<void> | undefined
  function discard() {
    return failedSettlement ??= settleFailedAttempt().catch(error => {
      // A backend-proven absence still owns this captured audit operation.
      // Keep optional work fenced until its existing source can settle it.
      deps.sourceFacts?.holdRecovery()
      throw error
    })
  }
  async function settleFailedAttempt() {
    modelFailed = true
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
    await failStepBoundary(deps,lifecycle)
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
        for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const) {
          const value = ev.usage[field]
          if (typeof value === "number" && Number.isFinite(value)) stepUsage[field] = value
        }
        if (ev.usage.inputTokenSemantics === "includes-cache" || ev.usage.inputTokenSemantics === "excludes-cache") stepUsage.inputTokenSemantics = ev.usage.inputTokenSemantics
        return
      }
      abort?.throwIfAborted()
      stepReasoning.checkPublication()
      if (providerEnded && ["text/chunk", "tool_call", "reasoning"].includes(ev.type)) throw Object.assign(new Error("Model produced content after completion"), { code: "MODEL_RESPONSE_INCOMPLETE" })
      if (ev.type !== "reasoning" && ev.type !== "activity") await stepReasoning.flush()
      switch (ev.type) {
        case "activity":
          modelActivity = ev.activity
          publishTransient(deps.session, { type: "model/activity", version: 1, ts: Date.now(), activity: ev.activity })
          break
        case "retry":
          if (!providerEnded && ev.retry.phase === "waiting" && reopenedRetry !== `${ev.retry.requestId}:${ev.retry.attempt}`) {
            if ((stepText || batch.length) && !ev.retry.discardOutput) throw new Error("model retry cannot preserve partial output")
            reopenedRetry = `${ev.retry.requestId}:${ev.retry.attempt}`
            const originalFailure = consumeRetryFailure(ev)
            try {
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
            stepText = ""
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
          stepText += ev.text
          break
        case "reasoning":
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
      try { await discard() }
      catch (saving) {
        throw savingFailure(error, [saving], 'model attempt saving failed')
      }
      throw error
    },
    async settle() {
      if (modelActivity && modelActivity.phase !== "settled") {
        publishTransient(deps.session, { type: "model/activity", version: 1, ts: Date.now(), activity: { ...modelActivity, phase: "settled", outcome: abort?.aborted ? "cancelled" : modelFailed ? "failed" : "completed" } })
      }
      await stepReasoning.flush()
    },
    result() { return { receipt, stepText, toolCallsThisStep, batch, stepUsage: usageReported ? {} : stepUsage, truncatedThisStep, refusedThisStep, thinkingBlocks, providerContinuation, providerEnded, identity: { actionId, attemptId, stepStartSeq } } },
  }
}

export type ModelStep = ReturnType<ReturnType<typeof createModelStep>["result"]>
