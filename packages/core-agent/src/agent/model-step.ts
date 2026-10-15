import { append, publishTransient, type ModelActivityInfo } from "@i-harness/core-session"
import type { LLMStreamEvent, LLMUsage } from "@i-harness/llm-seam"
import { modelFailureFacts } from "@i-harness/llm-seam"
import type { BatchCall } from "../execute-tool-calls.ts"
import type { AgentDeps, TurnLifecycle } from "./types.ts"
import { createStepReasoning } from "./reasoning.ts"
import { TOOL_ABORTED_BEFORE_DISPATCH } from "@i-harness/core-tools"
import { randomUUID } from "node:crypto"

export function createModelStep(deps: Pick<AgentDeps, "session" | "telemetry">, reasoning: string[], recordCall: (ev: Extract<LLMStreamEvent, { type: "tool_call" }>) => BatchCall, lifecycle: TurnLifecycle, initialStartSeq: number, abort: AbortSignal | undefined, getSteps: () => number) {
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
  function discard(notDispatched: boolean) {
    modelFailed = true
    stepReasoning.flush()
    if (stepText || thinkingBlocks?.length || providerContinuation || truncatedThisStep || refusedThisStep) {
      append(deps.session, { type: "assistant/message", text: stepText, ...(thinkingBlocks?.length ? { thinkingBlocks } : {}), ...(providerContinuation ? { providerContinuation } : {}) })
    }
    if (notDispatched) for (const call of batch) {
      // This batch never entered the scheduler. Do not synthesize outcomes for
      // any earlier/unknown dispatched work.
      append(deps.session, { type: "tool/result", callId: call.callId, name: call.name, isError: true,
        output: { code: TOOL_ABORTED_BEFORE_DISPATCH, error: "Model attempt was not accepted; tool call was not dispatched" } })
    }
    stepText = ""
    reasoning.length = reasoningStart
    append(deps.session, { type: "step/failed" })
    lifecycle.stepFailed = true
  }
  return {
    confirm(received: import("@i-harness/llm-seam").ExecutionReceipt) { receipt = { ...received, actionId, attemptId } },
    discard() { discard(true) },
    accept(ev: LLMStreamEvent) {
      stepReasoning.checkPublication()
      if (abort?.aborted) throw new Error("agent aborted")
      if (providerEnded && ["text/chunk", "tool_call", "reasoning"].includes(ev.type)) throw Object.assign(new Error("Model produced content after completion"), { code: "MODEL_RESPONSE_INCOMPLETE" })
      if (ev.type !== "reasoning" && ev.type !== "usage" && ev.type !== "activity") stepReasoning.flush()
      switch (ev.type) {
        case "activity":
          modelActivity = ev.activity
          publishTransient(deps.session, { type: "model/activity", version: 1, ts: Date.now(), activity: ev.activity })
          break
        case "retry":
          if (!providerEnded && ev.retry.phase === "waiting" && reopenedRetry !== `${ev.retry.requestId}:${ev.retry.attempt}`) {
            if ((stepText || batch.length) && !ev.retry.discardOutput) throw new Error("model retry cannot preserve partial output")
            reopenedRetry = `${ev.retry.requestId}:${ev.retry.attempt}`
            // Keep failed output in the append-only audit, but exclude it
            // and its unexecuted calls from the next model projection.
            if (stepText) append(deps.session, { type: "assistant/message", text: stepText })
            append(deps.session, { type: "step/failed" })
            lifecycle.stepFailed = true
            append(deps.session, { type: "step/end" })
            lifecycle.stepOpen = false
            stepText = ""
            toolCallsThisStep = 0
            batch.length = 0
            stepUsage = {}
            receipt = undefined
            reasoning.length = reasoningStart
            stepReasoning.resetBlockIndex()
            truncatedThisStep = false
            refusedThisStep = false
            thinkingBlocks = undefined
            providerContinuation = undefined
            providerEnded = false
            endFingerprint = undefined
            stepStartSeq = deps.session.events.length
            attemptId = randomUUID()
            append(deps.session, { type: "step/start", actionId, attemptId })
            lifecycle.stepOpen = true
            lifecycle.stepFailed = false
          }
          append(deps.session, { type: "model/retry", version: 1, ts: Date.now(), retry: ev.retry })
          break
        case "text/chunk":
          stepText += ev.text
          break
        case "reasoning":
          stepReasoning.accept(ev)
          break
        case "tool_call": {
          batch.push(recordCall(ev))
          toolCallsThisStep += 1
          break
        }
        case "usage":
          // M5 T2. This `case` is the ONLY thing that turns a provider report
          // into something the host can see: the switch has no default and no
          // exhaustiveness assert, so without it the event is dropped in
          // silence — the run looks perfect and the numbers are simply absent.
          for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const) {
            const value = ev.usage[field]
            if (typeof value === "number" && Number.isFinite(value)) stepUsage[field] = value
          }
          if (ev.usage.inputTokenSemantics === "includes-cache" || ev.usage.inputTokenSemantics === "excludes-cache") stepUsage.inputTokenSemantics = ev.usage.inputTokenSemantics
          break
        case "error": {
          const modelFailure = modelFailureFacts(ev.error)
          deps.telemetry?.emit({ type: "provider/error", ts: Date.now(), data: { step: getSteps(), error: modelFailure?.message ?? "Model request failed.", ...(modelFailure ? { modelFailure } : {}) } })
          throw Object.assign(new Error(`model stream error: ${ev.error.message}`, { cause: ev.error }), {
            code: (ev.error as Error & { code?: string }).code,
            httpStatus: (ev.error as Error & { httpStatus?: number }).httpStatus,
            ...(modelFailure ? { modelFailure } : {}),
          })
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
    fail(error: unknown): never {
      discard(false)
      throw error
    },
    settle() {
      if (modelActivity && modelActivity.phase !== "settled") {
        publishTransient(deps.session, { type: "model/activity", version: 1, ts: Date.now(), activity: { ...modelActivity, phase: "settled", outcome: abort?.aborted ? "cancelled" : modelFailed ? "failed" : "completed" } })
      }
      stepReasoning.flush()
    },
    result() { return { receipt, stepText, toolCallsThisStep, batch, stepUsage, truncatedThisStep, refusedThisStep, thinkingBlocks, providerContinuation, providerEnded, identity: { actionId, attemptId, stepStartSeq } } },
  }
}

export type ModelStep = ReturnType<ReturnType<typeof createModelStep>["result"]>
