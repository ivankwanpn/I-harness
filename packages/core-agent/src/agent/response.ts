import { randomUUID } from 'node:crypto'
import { modelFailureFacts, type LLMRequest } from '@i-harness/llm-seam'
import { agentFacts, committedFactSeqs } from './facts.ts'
import type { AgentDeps, AgentConfig, TurnLifecycle } from './types.ts'
import type { AgentContext } from './context.ts'
import type { createModelLoop } from './model-loop.ts'
import { createStepInput } from './step-input.ts'
import { createAdmission, stalePreparedInput } from './admission.ts'
import { createRecovery } from './recovery.ts'
import { closeStepBoundary, openStepBoundary } from './boundaries.ts'
import { acceptCompletedModelStep, reportModelUsage, closeStep } from './finalization.ts'
import { savingFailure } from './saving-failure.ts'

/** Own one logical response and every prepared physical attempt beneath it.
 * Hooks, inbox claims, accepted tool effects and turn lifetime stay outside. */
export function createResponseRunner(deps: AgentDeps & AgentConfig, context: AgentContext, modelLoop: ReturnType<typeof createModelLoop>, getSteps: () => number) {
  const prepareRequest = createStepInput(deps, context)
  const recovery = createRecovery(deps, context)
  const admit = createAdmission(deps, context, prepareRequest, recovery)
  return async function respond(lifecycle: TurnLifecycle, stepStartSeq: number, abort: AbortSignal | undefined, requestScope: LLMRequest['requestScope']) {
    let physicalStepStartSeq = stepStartSeq
    const candidateState: import("./execution.ts").CandidateExecutionState & import('./recovery.ts').RecoveryAdmissionState & { staleRebuilds: number; compacted: boolean } = { staleRebuilds: 0, compacted: false, reductionAttempts: { count: 0, staleRebuilds: 0 }, epochRebuilds: 0, hasStartedSend: false, hasObservedOutput: false }
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
          for await (const ev of candidate.prepared.stream({ generation: deps.sharedBudget?.control ?? deps.generationAction?.control(candidateState.recoveryId ? 'recovery' : 'main'), confirmExecution: confirmation => { const receipt = activeCandidate.execution.confirm(confirmation); if (receipt) activeStep.confirm(receipt) }, validateBeforeTransport: activeCandidate.validateBeforeTransport, onTransportIssue: () => { physicalAttempts++; candidateState.hasStartedSend = true } })) {
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
            if (++candidateState.reductionAttempts!.staleRebuilds > 3) await streamStep.fail(stalePreparedInput())
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
    await deps.generationAction?.close('accepted')
    const accepted = deps.session.events.findLast(event => event.type === 'model/exchange-accepted' && event.actionId === step.identity.actionId)
    const acceptedSeq = accepted?.seq
    await recovery.resolve(prepared.measurement, abort)
    return { step, acceptedSeq }
  }
}
