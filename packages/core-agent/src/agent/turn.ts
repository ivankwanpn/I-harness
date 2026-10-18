import { createResponseRunner } from './response.ts'
import { agentFacts, committedFactSeqs } from "./facts.ts"
import { ensureWritableContext } from "./context-readiness.ts"
import type { PluginContext } from "@i-harness/core-plugin"
import { isNondurableSession, type ImageInput } from "@i-harness/core-session"
import { randomUUID } from "node:crypto"
import { executeToolCalls } from "../execute-tool-calls.ts"
import type { AgentConfig, AgentDeps, AgentResult, TurnLifecycle, AgentInputOptions } from "./types.ts"
import type { AgentContext } from "./context.ts"
import { startStep, drainHookContext, feedbackText, hookRuntime } from "./step-input.ts"
import { createModelLoop } from "./model-loop.ts"
import { failTurn, closeStep, finishTurn } from "./finalization.ts"
import { ensureConversationSemantics } from "./exchange.ts"
import { prepareTurnInput } from "./input.ts"
import { savingFailure } from './saving-failure.ts'
import { toolGenerationFactory } from './tool-generation.ts'
import { promoteTurnInput } from './input-promotion.ts'
import { openDirectInput } from './direct-input.ts'

export function createTurnRunner(ctx: PluginContext, deps: AgentDeps & AgentConfig, context: AgentContext, requestSessionId: string, maxTurns: number | undefined, maxParallel: number) {
  // This budget and both subordinate owners persist across run/followup calls.
  let steps = 0
  const getSteps = () => steps
  const modelLoop = createModelLoop(deps)
  const respond = createResponseRunner(deps, context, modelLoop, getSteps)
  async function executeTurn(lifecycle: TurnLifecycle, message: string, signal?: AbortSignal, images?: ImageInput[], inputId?: string, options?: AgentInputOptions, producer = "agent.run"): Promise<AgentResult> {
    const start = { wall: Date.now(), monotonic: performance.now() }, abort = signal ?? deps.signal
    const direct = !isNondurableSession(deps.session) && !options?.generation && !deps.sharedBudget
      ? await openDirectInput(deps, { message, images, inputId, options, producer }, abort, start) : undefined
    if (direct) inputId = direct.inputId
    await ensureWritableContext(deps)
    const requestScope = Object.freeze({ sessionId: requestSessionId, turnId: randomUUID(), ...(deps.isSubagent ? { isSubagent: true } : {}) })
    const input = prepareTurnInput(deps.session, { message, images, inputId, options, producer })
    if (options?.generation) {
      if (!abort) throw Object.assign(new Error('Missing original generation signal'), { code: 'GENERATION_STALE' })
      if (options.delegatedOrigin) options.generation.adoptDelegated(deps.session, options.delegatedOrigin, abort)
      else {
        if (!inputId || !options.preparation) throw Object.assign(new Error('Missing original input preparation'), { code: 'GENERATION_STALE' })
        options.generation.adopt(deps.session, inputId, options.preparation.preparationId, abort)
      }
    }
    await ensureConversationSemantics(deps)
    const inputSeqs = committedFactSeqs(await promoteTurnInput(deps, { kind: 'input-start', ...(inputId ? { promoted: { type: 'agent/input/promoted', version: 1, inputId } } : {}), turn: { type: 'turn/start' }, message: input, ...(options?.preparation ? { preparation: options.preparation } : {}) }, lifecycle, () => { abort?.throwIfAborted(); (options?.generation ?? direct?.generation)?.assertOpen(); deps.sharedBudget?.signal.throwIfAborted() }))
    let generationOrigin: import('@i-harness/core-session').GenerationOrigin = { kind: 'input', seq: inputSeqs.at(-1)! }
    lifecycle.turnOpen = true
    // M25: host telemetry beside the session-log append (independent stream —
    // the session log itself is untouched; agent-invisible).
    deps.telemetry?.emit({ type: "turn/start", ts: Date.now(), data: { message } })

    let needsContinuation = true
    let stopContinuations = 0
    let promptSubmitted = false
    let firstGeneration = options?.generation ?? direct?.generation
    while (needsContinuation) {
      if (abort?.aborted) throw new Error("agent aborted")
      steps += 1
      if (maxTurns !== undefined && steps > maxTurns) throw new Error(`maxTurns exceeded: ${maxTurns}`)
      deps.generationAction = firstGeneration ?? await deps.generationLifecycle?.open('main', generationOrigin, { signal: abort, timeoutMs: deps.modelActionTimeoutMs, maxAttempts: deps.modelActionMaxAttempts })
      firstGeneration = undefined
      const stepStartSeq = await startStep(deps, lifecycle)
      await ctx.emit("agent/pre-step", { task: message, session: deps.session, sessionId: deps.sessionId, signal: abort, promptSubmission: !promptSubmitted })
      promptSubmitted = true
      await drainHookContext(ctx, deps)
      const { step, acceptedSeq } = await respond(lifecycle, stepStartSeq, abort, requestScope)
      if (acceptedSeq !== undefined) generationOrigin = { kind: 'predecessor', seq: acceptedSeq }
      const { batch, stepText, toolCallsThisStep, refusedThisStep, truncatedThisStep } = step
      if (batch.length > 0) {
        await executeToolCalls(ctx, deps.session, deps.tools, batch, {
          maxParallel, signal: abort, sessionId: deps.sessionId,
          facts: agentFacts(deps).tools, registerFactSource: deps.registerFactSource, assertFactOpen: deps.assertFactOpen,
          modelGeneration: toolGenerationFactory(deps),
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
    catch (error) {
      let failure = error
      try { await deps.generationAction?.close(signal?.aborted ? 'stopped' : 'failed') }
      catch (settlement) { failure = savingFailure(error, [settlement], 'Generation disposition requires recovery') }
      return failTurn(deps, lifecycle, failure)
    }
  }
}
