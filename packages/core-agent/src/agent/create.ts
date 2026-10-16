import { ensureWritableContext } from "./context-readiness.ts"
import type { PluginContext } from "@i-harness/core-plugin"
import { randomUUID } from "node:crypto"
import type { Agent, AgentConfig, AgentDeps } from "./types.ts"
import { createAgentContext } from "./context.ts"
import { createTurnRunner } from "./turn.ts"
import { createNondurableFactOwner, isNondurableSession, isManagedFactOwner } from '@i-harness/core-session'
import { trackSettlementSource } from './settlement-source.ts'
import { savingFailure } from './saving-failure.ts'

export function createAgent(ctx: PluginContext, deps: AgentDeps & AgentConfig): Agent {
  // Preserve host live getters (notably reasoning/model bindings) while the
  // per-run fact ports remain private to this Agent instance.
  deps = Object.create(Object.getPrototypeOf(deps),Object.getOwnPropertyDescriptors(deps)) as typeof deps
  const factOwner = deps.factOwner ?? (isNondurableSession(deps.session) ? createNondurableFactOwner(deps.session) : undefined)
  if (!factOwner || factOwner.view !== deps.session) throw Object.assign(new Error('Managed Agent requires matching owned facts'), { code: 'FACT_OWNER_UNSUPPORTED' })
  if (!isNondurableSession(deps.session) && !isManagedFactOwner(deps.session, factOwner)) throw Object.assign(new Error('Managed Agent requires actual document ownership'), { code: 'FACT_OWNER_UNSUPPORTED' })
  // Standalone agents without persisted IDs still own separate conversations.
  const requestSessionId = deps.sessionId ?? randomUUID()
  let activeOperations = 0
  async function track<T>(operation: () => Promise<T>): Promise<T> {
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
    deps.facts = action.facts
    deps.assertFactOpen = action.assertOpen
    const sourceDrains = new Set<import('@i-harness/core-session').SettlementFacts<import('@i-harness/core-session').ProducerFactOutcome>>()
    let running: Promise<T>
    deps.sourceFacts = action.registerSettlementSource(async () => {
      let failure: unknown
      try { await running } catch (error) {
        failure = error
      }
      const results = await Promise.allSettled([...sourceDrains].map(source => source.close()))
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Agent settlement requires recovery')
      if (String((failure as { code?: string })?.code ?? '').startsWith('FACT_')) {
        if (['FACT_CAPTURE_FAILED', 'FACT_INVALID_GROUP'].includes((failure as { code: string }).code)) throw failure
        await factOwner.drain?.()
      }
    })
    const sourceFacts = deps.sourceFacts
    deps.registerFactSource = drain => {
      const source = trackSettlementSource(sourceFacts, drain, () => sourceDrains.delete(source))
      sourceDrains.add(source)
      return source
    }
    running = operation(action.signal)
    let value!: T, failure: unknown, failed = false
    try { value = await running }
    catch (error) { failure = error; failed = true }
    action.finish()
    try { await sourceFacts.close() }
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
    compact: (instructions, options) => track(() => withFactAction(options?.signal, async signal => {
      await ensureWritableContext(deps)
      context.refreshBinding()
      return context.compactor ? context.compactor.compact(deps.session, instructions, { ...options, signal }) : { compacted: false, shadowedSeqs: [] }
    })),
  }
}
