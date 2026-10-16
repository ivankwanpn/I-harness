import { agentFacts, committedFactSeqs } from "./facts.ts"
import { ensureWritableContext } from "./context-readiness.ts"
import type { PluginContext } from "@i-harness/core-plugin"
import { type ImageInput } from "@i-harness/core-session"
import { randomUUID } from "node:crypto"
import { executeToolCalls } from "../execute-tool-calls.ts"
import type { AgentConfig, AgentDeps, AgentResult, TurnLifecycle, AgentInputOptions } from "./types.ts"
import type { AgentContext } from "./context.ts"
import { createStepInput, startStep, drainHookContext, feedbackText, hookRuntime } from "./step-input.ts"
import { createModelLoop } from "./model-loop.ts"
import { failTurn, acceptCompletedModelStep, reportModelUsage, closeStep, finishTurn } from "./finalization.ts"
import { createAdmission, stalePreparedInput } from "./admission.ts"
import { createRecovery } from "./recovery.ts"
import { closeStepBoundary, openStepBoundary } from './boundaries.ts'
import { modelFailureFacts } from "@i-harness/llm-seam"
import { ensureConversationSemantics } from "./exchange.ts"
import { prepareTurnInput } from "./input.ts"
import { savingFailure } from './saving-failure.ts'

export function createTurnRunner(ctx: PluginContext, deps: AgentDeps & AgentConfig, context: AgentContext, requestSessionId: string, maxTurns: number | undefined, maxParallel: number) {
  // This budget and both subordinate owners persist across run/followup calls.
  let steps = 0
  const getSteps = () => steps
  const modelLoop = createModelLoop(deps)
  const prepareRequest = createStepInput(deps, context)
  const recovery = createRecovery(deps, context)
  const admit = createAdmission(deps, context, prepareRequest, recovery)
  async function executeTurn(lifecycle: TurnLifecycle, message: string, signal?: AbortSignal, images?: ImageInput[], inputId?: string, options?: AgentInputOptions, producer = "agent.run"): Promise<AgentResult> {
    await ensureWritableContext(deps)
    const requestScope = Object.freeze({ sessionId: requestSessionId, turnId: randomUUID(), ...(deps.isSubagent ? { isSubagent: true } : {}) })
    const abort = signal ?? deps.signal
    const input = prepareTurnInput(deps.session, { message, images, inputId, options, producer })
    await ensureConversationSemantics(deps)
    committedFactSeqs(await agentFacts(deps).inputs.start(inputId ? { type: 'agent/input/promoted', version: 1, inputId } : undefined, input))
    lifecycle.turnOpen = true
    // M25: host telemetry beside the session-log append (independent stream —
    // the session log itself is untouched; agent-invisible).
    deps.telemetry?.emit({ type: "turn/start", ts: Date.now(), data: { message } })

    let needsContinuation = true
    let stopContinuations = 0
    let promptSubmitted = false
    while (needsContinuation) {
      if (abort?.aborted) throw new Error("agent aborted")
      steps += 1
      if (maxTurns !== undefined && steps > maxTurns) throw new Error(`maxTurns exceeded: ${maxTurns}`)
      const stepStartSeq = await startStep(deps, lifecycle)
      let physicalStepStartSeq = stepStartSeq
      await ctx.emit("agent/pre-step", { task: message, session: deps.session, sessionId: deps.sessionId, signal: abort, promptSubmission: !promptSubmitted })
      promptSubmitted = true
      await drainHookContext(ctx, deps)
      const candidateState: import("./execution.ts").CandidateExecutionState & { staleRebuilds: number; compacted: boolean } = { staleRebuilds: 0, compacted: false, epochRebuilds: 0, hasStartedSend: false, hasObservedOutput: false }
      let candidate: Awaited<ReturnType<typeof admit>>
      let streamStep: ReturnType<typeof modelLoop.start>
      while (true) {
        candidate = await admit(abort, requestScope, getSteps, candidateState)
        streamStep = modelLoop.start(lifecycle, physicalStepStartSeq, abort, getSteps)
        const activeCandidate = candidate, activeStep = streamStep
        let physicalAttempts = 0, observed = false, rebuild = false
        let attemptFailure: unknown, failed = false
        let streamFailure: unknown, streamFailed = false
        try {
          try {
            for await (const ev of candidate.prepared.stream({ confirmExecution: confirmation => { const receipt = activeCandidate.execution.confirm(confirmation); if (receipt) activeStep.confirm(receipt) }, validateBeforeTransport: () => { activeCandidate.validateBeforeTransport(); physicalAttempts++; candidateState.hasStartedSend = true } })) {
              if (ev.type !== "activity" && ev.type !== "retry") { observed = true; candidateState.hasObservedOutput = true }
              await streamStep.accept(ev)
            }
          } catch (error) {
            streamFailure = error; streamFailed = true
            const failure = modelFailureFacts(error)
            if (["AUTH", "INVALID_API_KEY"].includes(failure?.code ?? (error as { code?: string })?.code ?? "")) context.ownedBudget.retire("execution-identity-changed")
            const handoff = candidate.execution.handoff()
            if ((error as { code?: string })?.code === "EXECUTION_IDENTITY_CHANGED" && handoff && !candidateState.hasStartedSend && !candidateState.hasObservedOutput && candidateState.epochRebuilds++ === 0) {
              candidateState.handoff = handoff
              rebuild = true
            } else if ((error as { code?: string })?.code === "CONTEXT_INPUT_STALE" && !physicalAttempts && !observed) {
              if (++candidateState.staleRebuilds > 3) await streamStep.fail(stalePreparedInput())
              rebuild = true
            } else if (!streamStep.result().providerEnded && failure?.code === "CONTEXT_WINDOW_EXCEEDED" && failure.reason === "context-limit") {
              await streamStep.discard()
              await closeStepBoundary(deps,lifecycle,{type:'step/end'})
              await recovery.require(error, candidate.prepared.measurement, stepStartSeq, abort)
              // Reopen only the physical model boundary. Hooks, admitted inputs
              // and prior accepted tool effects belong to the logical step.
              const failedStart = deps.session.events[streamStep.result().identity.stepStartSeq]
              physicalStepStartSeq = committedFactSeqs(await agentFacts(deps).agent.lifecycle({ type: "step/start", actionId: failedStart?.type === "step/start" ? failedStart.actionId : randomUUID(), attemptId: randomUUID() }))[0]!
              openStepBoundary(lifecycle)
              rebuild = true
            } else await streamStep.fail(error)
          }
          } catch (error) {
          const alreadyRetained = error instanceof AggregateError && Object.getOwnPropertyDescriptor(error, 'cause')?.value === streamFailure
          attemptFailure = streamFailed && error !== streamFailure && !alreadyRetained
            ? savingFailure(streamFailure, [error], 'model attempt saving failed') : error
          failed = true
          throw attemptFailure
        } finally {
          candidate.execution.close()
          try { await streamStep.settle() }
          catch (saving) {
            if (failed) throw savingFailure(attemptFailure, [saving], 'model step settlement failed')
            throw saving
          }
        }
        if (!rebuild) break
      }
      const { prepared } = candidate
      const step = streamStep.result()
      if (!step.providerEnded) await streamStep.fail(Object.assign(new Error("Model response ended without an explicit completion"), { code: "MODEL_RESPONSE_INCOMPLETE" }))
      if (step.truncatedThisStep || step.refusedThisStep) {
        reportModelUsage(deps, step)
        await streamStep.discard()
        await closeStep(deps, lifecycle, getSteps, step)
        throw Object.assign(new Error(step.refusedThisStep ? "Model refused the main response" : "Model output was truncated before completion"), { code: step.refusedThisStep ? "MODEL_REFUSED" : "MODEL_OUTPUT_TRUNCATED" })
      }
      await acceptCompletedModelStep(deps, context, lifecycle, step, prepared.measurement, abort, candidate.execution.attribution(step.receipt))
      await recovery.resolve(prepared.measurement, abort)
      const { batch, stepText, toolCallsThisStep, refusedThisStep, truncatedThisStep } = step
      if (batch.length > 0) {
        await executeToolCalls(ctx, deps.session, deps.tools, batch, {
          maxParallel, signal: abort, sessionId: deps.sessionId,
          facts: agentFacts(deps).tools, registerFactSource: deps.registerFactSource, assertFactOpen: deps.assertFactOpen,
          ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
          ...(deps.flush ? { flush: deps.flush } : {}),
        })
      }
      const emptyThisStep = await closeStep(deps, lifecycle, getSteps, step)
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
          committedFactSeqs(await agentFacts(deps).agent.feedback({ type: "user/message", text: feedbackText(reason), source: { kind: "plugin", plugin: "hooks" }, provenance: { kind: "plugin", authority: "observation", scope: "turn", producer: "agent.hooks" } }))
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
