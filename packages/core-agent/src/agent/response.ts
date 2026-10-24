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
import { acceptCompletedModelStep, reportModelUsage, closeStep, settleFailedTurn } from './finalization.ts'
import { savingFailure } from './saving-failure.ts'
import { createUnstartedCallSettlement } from './unstarted-call-settlement.ts'
import { createAcceptanceSettlement } from './acceptance-settlement.ts'

/** Own one logical response and every prepared physical attempt beneath it.
 * Hooks, inbox claims, accepted tool effects and turn lifetime stay outside. */
export function createResponseRunner(deps: AgentDeps & AgentConfig, context: AgentContext, modelLoop: ReturnType<typeof createModelLoop>, getSteps: () => number) {
  const prepareRequest = createStepInput(deps, context)
  return async function respond(lifecycle: TurnLifecycle, stepStartSeq: number, abort: AbortSignal | undefined, requestScope: LLMRequest['requestScope']) {
    const recovery = createRecovery(deps, context)
    const unstarted = createUnstartedCallSettlement(deps)
    const owned = { session: deps.session, facts: deps.facts, sourceFacts: deps.sourceFacts, generationAction: deps.generationAction, flush: deps.flush, telemetry: deps.telemetry }
    const acceptance = createAcceptanceSettlement({ registerFactSource: deps.registerFactSource, flush: owned.flush }, unstarted.close)
    let acceptanceStarted = false
    const admit = createAdmission(deps, context, prepareRequest, recovery, candidate => {
      if (candidate.instructions) acceptance.retainContext(deps.requestContext!.retain(candidate.instructions))
    })
    let responseFailure: unknown, responseFailed = false
    let success: { step: import('./model-step.ts').ModelStep; accepted: import('./request-context.ts').AcceptedExchange; candidate: import('./request-snapshot.ts').RequestEvidence; issued?: import('@i-harness/llm-seam').ExecutionReceipt & { actionId: string; attemptId: string } } | undefined
    try {
    try {
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
      let semanticBlocked: Error | undefined
      let pendingReceipt: import('@i-harness/llm-seam').ExecutionReceipt | undefined, issuedReceipt: (import('@i-harness/llm-seam').ExecutionReceipt & { actionId: string; attemptId: string }) | undefined
      try {
        try {
          for await (const ev of candidate.prepared.stream({ generation: deps.sharedBudget?.control ?? deps.generationAction?.control(candidateState.recoveryId ? 'recovery' : 'main'), confirmExecution: confirmation => { const receipt = activeCandidate.execution.confirm(confirmation); pendingReceipt = receipt; if (receipt) activeStep.confirm(receipt) }, validateBeforeTransport: activeCandidate.validateBeforeTransport, onTransportIssue: () => { issuedReceipt = pendingReceipt ? { ...pendingReceipt, ...activeStep.result().identity } : undefined; pendingReceipt = undefined; physicalAttempts++; candidateState.hasStartedSend = true } })) {
            if (ev.type !== "activity" && ev.type !== "retry") { observed = true; candidateState.hasObservedOutput = true }
            await streamStep.accept(ev)
          }
        } catch (error) {
          streamFailure = error; streamFailed = true
          // Failed responses still have real billing observations. Keep them
          // on this attempt, without entering accepted calibration. The outer
          // catch retains the original failure if reporting itself fails.
          const failedStep = streamStep.result()
          if (Object.keys(failedStep.stepUsage).length) {
            try { reportModelUsage(deps, failedStep) }
            catch (reporting) {
              // Billing observers cannot skip the already-owned local audit.
              await streamStep.fail(savingFailure(error, [reporting], 'model usage reporting failed'))
            }
          }
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
            const required = await recovery.require(error, candidate.prepared.measurement, stepStartSeq, abort)
            if (required.kind === 'blocked') { semanticBlocked = required.error; throw semanticBlocked }
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
        attemptFailure = streamFailed && error !== streamFailure && error !== semanticBlocked && !alreadyRetained
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
      if (!rebuild) { success = { step: streamStep.result(), accepted: undefined!, candidate: candidate.captured, issued: issuedReceipt }; break }
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
    unstarted.capture(step.batch, candidate.captured.instructions ? deps.requestContext!.retain(candidate.captured.instructions) : undefined)
    acceptanceStarted = true
    const deferredFailure = (error: unknown) => acceptance.fail(async accepted => {
      lifecycle.providerCompleted = accepted
      await settleFailedTurn(owned, lifecycle, error, async () => { await owned.generationAction?.close(abort?.aborted ? 'stopped' : 'failed') }, false)
    })
    lifecycle.deferredFailure = deferredFailure
    const accepted = await acceptCompletedModelStep(deps, context, lifecycle, step, prepared.measurement, abort, candidate.execution.attribution(step.receipt), acceptance)
    await acceptance.close()
    if (lifecycle.deferredFailure === deferredFailure) lifecycle.deferredFailure = undefined
    await deps.generationAction?.close('accepted')
    await recovery.resolve(prepared.measurement, abort)
    if (!step.batch.length) await unstarted.close()
    success = { ...success!, step, accepted }
    } catch (error) { responseFailure = error; responseFailed = true; throw error }
    finally {
      const savingErrors: unknown[] = []
      if (responseFailed && !acceptanceStarted) try { await acceptance.close() } catch (saving) { savingErrors.push(saving) }
      if (responseFailed) try { await unstarted.close() } catch (saving) { savingErrors.push(saving) }
      try { await recovery.close() }
      catch (saving) { savingErrors.push(saving) }
      if (savingErrors.length) {
        if (responseFailed) throw savingFailure(responseFailure, savingErrors, 'Original response settlement failed')
        throw savingErrors.length === 1 ? savingErrors[0] : new AggregateError(savingErrors, 'Original response settlement failed')
      }
    }
    abort?.throwIfAborted()
    const { step, candidate, accepted, issued } = success!
    const receipt = step.receipt
    const matched = !!receipt && !!issued && receipt.actionId === step.identity.actionId && receipt.attemptId === step.identity.attemptId
      && issued.actionId === step.identity.actionId && issued.attemptId === step.identity.attemptId && JSON.stringify(receipt.identity) === JSON.stringify(issued.identity)
      && receipt.candidateId === issued.candidateId && receipt.sendId === issued.sendId && receipt.semanticId === issued.semanticId
      && receipt.payloadId === issued.payloadId && receipt.payloadKind === issued.payloadKind
    if (matched && candidate.instructions) deps.requestContext!.succeeded({ ...accepted, candidate, evidence: candidate.instructions, physicalExecutionReceipt: issued! })
    return { step, acceptedSeq: accepted.acceptedSeq, handoffBatch: unstarted.handoff }
    } catch (error) {
      // A success can still fail in original finally/Stop/notification. Only
      // this late path needs an additional original unstarted drain.
      if (!responseFailed) {
        try { await unstarted.close() }
        catch (saving) { throw savingFailure(error, [saving], 'Post-completion original settlement failed') }
      }
      throw error
    }
  }
}
