import { runManualCompaction } from './manual-compaction.ts'
import type { PluginContext } from "@i-harness/core-plugin"
import { randomUUID } from "node:crypto"
import type { Agent, AgentConfig, AgentDeps } from "./types.ts"
import { createAgentContext } from "./context.ts"
import { createTurnRunner } from "./turn.ts"
import { createNondurableFactOwner, isNondurableSession, isManagedFactOwner } from '@i-harness/core-session'
import { trackSettlementSource } from './settlement-source.ts'
import { savingFailure } from './saving-failure.ts'
import { borrowApprovalGeneration, assertBorrowedApprovalGeneration } from './tool-generation.ts'
import { createExecutionDependencies } from './dependencies.ts'
import { consumeAgentModelOrigin } from '../tool-batch/model-origin.ts'
import { createLiveInvocation } from '../tool-batch/live-continuation.ts'

export function createAgent(ctx: PluginContext, host: AgentDeps & AgentConfig): Agent {
  const deps = createExecutionDependencies(host)
  const factOwner = deps.factOwner ?? (isNondurableSession(deps.session) ? createNondurableFactOwner(deps.session) : undefined)
  if (!factOwner || factOwner.view !== deps.session) throw Object.assign(new Error('Managed Agent requires matching owned facts'), { code: 'FACT_OWNER_UNSUPPORTED' })
  if (!isNondurableSession(deps.session) && !isManagedFactOwner(deps.session, factOwner)) throw Object.assign(new Error('Managed Agent requires actual document ownership'), { code: 'FACT_OWNER_UNSUPPORTED' })
  const modelOrigin = host.modelCallOrigin ? consumeAgentModelOrigin(host.modelCallOrigin, deps.session, factOwner, deps.tools) : undefined
  // LC09: capture this read-only capability from the already validated real
  // owner. A host readiness callback cannot substitute for its recovery fence.
  const assertReady = (factOwner as typeof factOwner & { assertReady?: () => void }).assertReady
  if (!isNondurableSession(deps.session) && typeof assertReady === 'function') deps.assertLiveOwnerReady = () => {
    if (factOwner.view !== deps.session) throw Object.assign(new Error('Live owner view no longer matches'), { code: 'FACT_OWNER_UNSUPPORTED' })
    assertReady.call(factOwner)
  }
  const borrowedBinding = deps.sharedGeneration
  deps.sharedBudget = borrowApprovalGeneration(borrowedBinding, factOwner.view)
  const borrowedAction = deps.sharedBudget
  if (borrowedBinding && borrowedAction) deps.assertBorrowedGeneration = () => assertBorrowedApprovalGeneration(borrowedBinding, factOwner.view, borrowedAction)
  if (deps.sharedBudget && deps.generationFactory) throw Object.assign(new Error('Conflicting generation ownership'), { code: 'GENERATION_CONFLICT' })
  if (!isNondurableSession(factOwner.view) && !deps.generationFactory && !deps.sharedBudget) throw Object.assign(new Error('Managed Agent requires generation lifecycle composition'), { code: 'GENERATION_UNSUPPORTED' })
  // Standalone agents without persisted IDs still own separate conversations.
  const requestSessionId = deps.sessionId ?? randomUUID()
  let activeOperations = 0
  async function track<T>(operation: () => Promise<T>): Promise<T> {
    if (activeOperations > 0) throw Object.assign(new Error('Agent invocation is already active'), { code: 'AGENT_BUSY' })
    activeOperations++
    try { return await operation() }
    finally { activeOperations-- }
  }
  // Desktop turns have no arbitrary step ceiling. Explicit callers may still
  // provide a finite limit for bounded automation and tests.
  const maxTurns = deps.maxTurns
  const maxParallel = deps.maxParallelToolCalls ?? 10
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error(`maxParallelToolCalls must be a positive integer (got ${maxParallel})`)
  }
  const context = createAgentContext(deps, requestSessionId)
  const runTurn = createTurnRunner(ctx, deps, context, requestSessionId, maxTurns, maxParallel)
  const withFactAction = async <T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const action = factOwner.beginAction(signal ?? deps.signal)
    let lifecycle: AgentDeps['generationLifecycle']
    let preparation: AgentDeps['inputPreparation']
    let sourceFacts: AgentDeps['sourceFacts']
    let running: Promise<T> | undefined
    let value!: T, failure: unknown, failed = false
    const recordFailure = (error: unknown, classification: string) => {
      failure = failed ? savingFailure(failure, [error], classification) : error
      failed = true
    }
    const sourceDrains = new Set<import('@i-harness/core-session').SettlementFacts<import('@i-harness/core-session').ProducerFactOutcome>>()
    // A drain can fail on a transient reconciliation state (a pending write, a
    // snapshot lock); a bounded retry lets the turn settle without wedging the
    // session, while a genuinely broken source still surfaces after the budget.
    const closeSettled = async (close: () => Promise<void>) => {
      let last: unknown
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await close(); return }
        catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 60 * (attempt + 1))) }
      }
      throw last
    }
    const drainDelegates = async () => {
      const results = await Promise.allSettled([...sourceDrains].map(source => closeSettled(() => source.close())))
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Agent settlement requires recovery')
    }
    try {
      deps.generationAction = undefined
      // A deferred original acceptance may still need to close this generation
      // after its frame is reconciled. Keep that genuine source open through
      // the original operation and delegated closures, including host close.
      deps.generationLifecycle = lifecycle = deps.generationFactory?.(action, { async beforeDrain() {
        try { await running } catch { /* The caller retains its original failure. */ }
        await drainDelegates()
      } })
      deps.inputPreparation = preparation = deps.inputPreparationFactory?.(action)
      deps.facts = action.facts
      deps.assertFactOpen = action.assertOpen.bind(action)
      deps.captureContextReduction = action.captureContextReduction?.bind(action)
      deps.captureSoftReduction = action.captureSoftReduction.bind(action)
      deps.captureInputPromotion = action.captureInputPromotion.bind(action)
      deps.captureModelExchange = action.captureModelExchange.bind(action)
      sourceFacts = action.registerSettlementSource(async () => {
        let operationFailure: unknown
        try { await running } catch (error) { operationFailure = error }
        await drainDelegates()
        await lifecycle?.drain()
        if (String((operationFailure as { code?: string })?.code ?? '').startsWith('FACT_')) {
          if (['FACT_CAPTURE_FAILED', 'FACT_INVALID_GROUP'].includes((operationFailure as { code: string }).code)) throw operationFailure
          await factOwner.drain?.()
        }
      })
      deps.sourceFacts = sourceFacts
      const invocationSource = sourceFacts
      deps.registerFactSource = drain => {
        const source = trackSettlementSource(invocationSource, drain, () => sourceDrains.delete(source))
        sourceDrains.add(source)
        return source
      }
      if (!isNondurableSession(factOwner.view)) deps.liveInvocation = createLiveInvocation(factOwner.view, action, drain => {
        const source = action.registerSettlementSource(drain), close = source.close.bind(source)
        source.close = async () => { await close(); sourceDrains.delete(source) }
        sourceDrains.add(source)
        return source
      }, modelOrigin)
      running = operation(action.signal)
      value = await running
    } catch (error) { failure = error; failed = true }
    deps.liveInvocation?.invalidate()
    deps.liveInvocation = undefined
    // Settle every resource actually created, even when later setup or close
    // throws. These locals always belong to this invocation.
    try { await preparation?.close() }
    catch (error) { recordFailure(error, 'Input preparation settlement requires recovery') }
    try { if (!sourceFacts) await lifecycle?.drain() }
    catch (error) { recordFailure(error, 'Generation settlement requires recovery') }
    try { action.finish() }
    catch (error) { recordFailure(error, 'Action finish requires recovery') }
    try { if (sourceFacts) await closeSettled(() => sourceFacts!.close()) }
    catch (settlement) {
      if (!failed) throw settlement
      throw Object.assign(savingFailure(failure, [settlement], 'Agent settlement requires recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
    }
    if (failed) throw failure
    return value
  }
  const startTurn: typeof runTurn = (...args) => withFactAction(args[1], signal => { args[1] = signal; return runTurn(...args) })
  return {
    runAdmitted: (task, signal, images, inputId, options) => track(() => startTurn(task, signal, images, inputId, options, 'agent.run')),
    contextBudget: () => context.readBudget(),
    updateContext(config) {
      if (activeOperations > 0) throw new Error("agent is busy")
      context.update(config)
    },
    run: (task, signal, images, inputId, options) => track(() => startTurn(task, signal, images, inputId, options, "agent.run")),
    followup: (message, signal, options) => track(() => startTurn(message, signal, undefined, undefined, options, "agent.followup")),
    compact: (instructions, options) => track(() => withFactAction(options?.signal, signal => runManualCompaction(deps, context, instructions, { ...options, signal }))),
  }
}
