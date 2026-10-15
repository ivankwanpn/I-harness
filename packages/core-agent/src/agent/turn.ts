import type { PluginContext } from "@i-harness/core-plugin"
import { append, type ImageInput } from "@i-harness/core-session"
import { randomUUID } from "node:crypto"
import { executeToolCalls } from "../execute-tool-calls.ts"
import type { AgentConfig, AgentDeps, AgentResult, TurnLifecycle, AgentInputOptions } from "./types.ts"
import type { AgentContext } from "./context.ts"
import { createStepInput, startStep, drainHookContext, feedbackText, hookRuntime } from "./step-input.ts"
import { createModelLoop } from "./model-loop.ts"
import { failTurn, completeModelStep, reportModelUsage, closeStep, finishTurn } from "./finalization.ts"
import { createAdmission, stalePreparedInput } from "./admission.ts"
import { createRecovery } from "./recovery.ts"
import { modelFailureFacts } from "@i-harness/llm-seam"
import { ensureConversationSemantics, acceptModelExchange } from "./exchange.ts"
import { prepareTurnInput } from "./input.ts"

export function createTurnRunner(ctx: PluginContext, deps: AgentDeps & AgentConfig, context: AgentContext, requestSessionId: string, maxTurns: number | undefined, maxParallel: number) {
  // This budget and both subordinate owners persist across run/followup calls.
  let steps = 0
  const getSteps = () => steps
  const modelLoop = createModelLoop(deps, context)
  const prepareRequest = createStepInput(deps, context)
  const recovery = createRecovery(deps, context)
  const admit = createAdmission(deps, context, prepareRequest, recovery)
  async function executeTurn(lifecycle: TurnLifecycle, message: string, signal?: AbortSignal, images?: ImageInput[], inputId?: string, options?: AgentInputOptions, producer = "agent.run"): Promise<AgentResult> {
    const requestScope = Object.freeze({ sessionId: requestSessionId, turnId: randomUUID(), ...(deps.isSubagent ? { isSubagent: true } : {}) })
    const abort = signal ?? deps.signal
    const input = prepareTurnInput(deps.session, { message, images, inputId, options, producer })
    ensureConversationSemantics(deps.session)
    append(deps.session, { type: "turn/start" })
    lifecycle.turnOpen = true
    // M25: host telemetry beside the session-log append (independent stream —
    // the session log itself is untouched; agent-invisible).
    deps.telemetry?.emit({ type: "turn/start", ts: Date.now(), data: { message } })
    append(deps.session, input)

    let needsContinuation = true
    let stopContinuations = 0
    let promptSubmitted = false
    while (needsContinuation) {
      if (abort?.aborted) throw new Error("agent aborted")
      steps += 1
      if (maxTurns !== undefined && steps > maxTurns) throw new Error(`maxTurns exceeded: ${maxTurns}`)
      const stepStartSeq = startStep(deps, lifecycle)
      let physicalStepStartSeq = stepStartSeq
      await ctx.emit("agent/pre-step", { task: message, session: deps.session, sessionId: deps.sessionId, signal: abort, promptSubmission: !promptSubmitted })
      promptSubmitted = true
      drainHookContext(ctx, deps)
      const candidateState = { staleRebuilds: 0, compacted: false }
      let candidate: Awaited<ReturnType<typeof admit>>
      let streamStep: ReturnType<typeof modelLoop.start>
      while (true) {
        candidate = await admit(abort, requestScope, getSteps, candidateState)
        streamStep = modelLoop.start(lifecycle, physicalStepStartSeq, abort, getSteps)
        let physicalAttempts = 0, observed = false, rebuild = false
        try {
          for await (const ev of candidate.prepared.stream({ validateBeforeTransport: () => { candidate.validateBeforeTransport(); physicalAttempts++ } })) {
            if (ev.type !== "activity" && ev.type !== "retry") observed = true
            streamStep.accept(ev)
          }
        } catch (error) {
          const failure = modelFailureFacts(error)
          if ((error as { code?: string })?.code === "CONTEXT_INPUT_STALE" && !physicalAttempts && !observed) {
            if (++candidateState.staleRebuilds > 3) streamStep.fail(stalePreparedInput())
            rebuild = true
          } else if (!streamStep.result().providerEnded && failure?.code === "CONTEXT_WINDOW_EXCEEDED" && failure.reason === "context-limit") {
            streamStep.discard()
            append(deps.session, { type: "step/end" }); lifecycle.stepOpen = false
            await recovery.require(error, candidate.prepared.measurement, stepStartSeq, abort)
            // Reopen only the physical model boundary. Hooks, admitted inputs
            // and prior accepted tool effects belong to the logical step.
            physicalStepStartSeq = deps.session.events.length
            const failedStart = deps.session.events[streamStep.result().identity.stepStartSeq]
            append(deps.session, { type: "step/start", actionId: failedStart?.type === "step/start" ? failedStart.actionId : randomUUID(), attemptId: randomUUID() }); lifecycle.stepOpen = true; lifecycle.stepFailed = false
            rebuild = true
          } else streamStep.fail(error)
        } finally { streamStep.settle() }
        if (!rebuild) break
      }
      const { request, requestRevision, prepared } = candidate
      const step = streamStep.result()
      if (!step.providerEnded) streamStep.fail(Object.assign(new Error("Model response ended without an explicit completion"), { code: "MODEL_RESPONSE_INCOMPLETE" }))
      if (step.truncatedThisStep || step.refusedThisStep) {
        reportModelUsage(deps, step)
        streamStep.discard()
        closeStep(deps, lifecycle, getSteps, step)
        throw Object.assign(new Error(step.refusedThisStep ? "Model refused the main response" : "Model output was truncated before completion"), { code: step.refusedThisStep ? "MODEL_REFUSED" : "MODEL_OUTPUT_TRUNCATED" })
      }
      completeModelStep(deps, context, request, requestRevision, abort, step, prepared.measurement)
      const acceptedSeq = deps.session.events.length + 1
      try { await acceptModelExchange(deps, { identity: step.identity, step, signal: abort }) }
      finally { lifecycle.providerCompleted = deps.session.events[acceptedSeq]?.type === "model/exchange-accepted" }
      await recovery.resolve(prepared.measurement, abort)
      const { batch, stepText, toolCallsThisStep, refusedThisStep, truncatedThisStep } = step
      if (batch.length > 0) {
        await executeToolCalls(ctx, deps.session, deps.tools, batch, {
          maxParallel, signal: abort, sessionId: deps.sessionId,
          ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
          ...(deps.flush ? { flush: deps.flush } : {}),
        })
      }
      const emptyThisStep = closeStep(deps, lifecycle, getSteps, step)
      // Continuation: after a step with tool calls, run another step so the
      // model can produce its final message. A step without tool calls is a
      // final answer → loop ends (per-turn mock semantics).
      needsContinuation = toolCallsThisStep > 0
      if (!needsContinuation && !refusedThisStep && !truncatedThisStep && !emptyThisStep) {
        // Trusted host hook adapters can ask for another step before the turn
        // ends. Their reason is plugin feedback, never a new user instruction
        // or an authority grant. Native agent/stop keeps its existing veto seam.
        let agentType: string | undefined
        try { agentType = ctx.services.get<string>("hooks/agent-type") } catch { /* root agent */ }
        const stopInput = {
          session: deps.session, sessionId: deps.sessionId, turns: steps,
          finalText: stepText, stopHookActive: stopContinuations > 0, signal: abort, agentType,
        }
        let verdict: { continuation?: { reason?: unknown } } | undefined
        let hookVerdict: { reason: string } | undefined
        try {
          verdict = await ctx.emit("agent/pre-stop", stopInput) as typeof verdict
          hookVerdict = await hookRuntime(ctx)?.beforeStop(stopInput)
        } catch (error) { if (abort?.aborted) throw new Error("agent aborted"); throw error }
        if (abort?.aborted) throw new Error("agent aborted")
        const reason = [verdict?.continuation?.reason, hookVerdict?.reason].filter(value => typeof value === "string" && value.trim()).join("\n\n")
        if (typeof reason === "string" && reason.trim()) {
          stopContinuations += 1
          append(deps.session, { type: "user/message", text: feedbackText(reason), source: { kind: "plugin", plugin: "hooks" }, provenance: { kind: "plugin", authority: "observation", scope: "turn", producer: "agent.hooks" } })
          needsContinuation = true
        }
      }
    }

    return finishTurn(ctx, deps, lifecycle, getSteps, modelLoop.reasoning)
  }
  return async function runTurn(message: string, signal?: AbortSignal, images?: ImageInput[], inputId?: string, options?: AgentInputOptions, producer?: string): Promise<AgentResult> {
    const lifecycle: TurnLifecycle = { turnOpen: false, stepOpen: false, providerCompleted: false, stepFailed: false }
    try { return await executeTurn(lifecycle, message, signal, images, inputId, options, producer) }
    catch (error) { return failTurn(deps, lifecycle, error) }
  }
}
