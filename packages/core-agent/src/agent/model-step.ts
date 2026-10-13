import { append, publishTransient, type ModelActivityInfo } from "@i-harness/core-session"
import type { LLMStreamEvent, LLMUsage } from "@i-harness/llm-seam"
import type { BatchCall } from "../execute-tool-calls.ts"
import type { AgentDeps, TurnLifecycle } from "./types.ts"
import type { AgentContext } from "./context.ts"
import { createStepReasoning } from "./reasoning.ts"

export function createModelStep(deps: Pick<AgentDeps, "session" | "telemetry">, context: Pick<AgentContext, "contextMeter">, reasoning: string[], recordCall: (ev: Extract<LLMStreamEvent, { type: "tool_call" }>) => BatchCall, lifecycle: TurnLifecycle, initialStartSeq: number, abort: AbortSignal | undefined, steps: number) {
  let stepStartSeq = initialStartSeq
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
  return {
    accept(ev: LLMStreamEvent) {
      stepReasoning.checkPublication()
      if (abort?.aborted) throw new Error("agent aborted")
      if (ev.type !== "reasoning" && ev.type !== "usage" && ev.type !== "activity") stepReasoning.flush()
      switch (ev.type) {
        case "activity":
          modelActivity = ev.activity
          publishTransient(deps.session, { type: "model/activity", version: 1, ts: Date.now(), activity: ev.activity })
          break
        case "retry":
          if (ev.retry.phase === "waiting" && ev.retry.discardOutput) {
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
            reasoning.length = reasoningStart
            stepReasoning.resetBlockIndex()
            truncatedThisStep = false
            refusedThisStep = false
            thinkingBlocks = undefined
            providerContinuation = undefined
            context.contextMeter.invalidate()
            stepStartSeq = deps.session.events.length
            append(deps.session, { type: "step/start" })
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
        case "error":
          deps.telemetry?.emit({ type: "provider/error", ts: Date.now(), data: { step: steps, error: ev.error.message } })
          throw Object.assign(new Error(`model stream error: ${ev.error.message}`, { cause: ev.error }), {
            code: (ev.error as Error & { code?: string }).code,
            httpStatus: (ev.error as Error & { httpStatus?: number }).httpStatus,
          })
        case "end":
          thinkingBlocks = ev.thinkingBlocks
          providerContinuation = ev.providerContinuation
          // Report ending bits to telemetry here and to the durable step end
          // later. Absent stays absent; neither bit is written as false.
          if (ev.truncated === true) {
            truncatedThisStep = true
            deps.telemetry?.emit({ type: "provider/truncated", ts: Date.now(), data: { step: steps } })
          }
          if (ev.refused === true) {
            refusedThisStep = true
            deps.telemetry?.emit({ type: "provider/refused", ts: Date.now(), data: { step: steps } })
          }
          break
      }
    },
    fail(error: unknown): never {
      modelFailed = true
      context.contextMeter.invalidate()
      stepReasoning.flush()
      if (stepText) {
        append(deps.session, { type: "assistant/message", text: stepText })
        stepText = ""
      }
      append(deps.session, { type: "step/failed" })
      lifecycle.stepFailed = true
      throw error
    },
    settle() {
      if (modelActivity && modelActivity.phase !== "settled") {
        publishTransient(deps.session, { type: "model/activity", version: 1, ts: Date.now(), activity: { ...modelActivity, phase: "settled", outcome: abort?.aborted ? "cancelled" : modelFailed ? "failed" : "completed" } })
      }
      stepReasoning.flush()
    },
    result() { return { stepText, toolCallsThisStep, batch, stepUsage, truncatedThisStep, refusedThisStep, thinkingBlocks, providerContinuation } },
  }
}

export type ModelStep = ReturnType<ReturnType<typeof createModelStep>["result"]>
