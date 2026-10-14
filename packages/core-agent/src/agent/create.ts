import type { PluginContext } from "@i-harness/core-plugin"
import { randomUUID } from "node:crypto"
import type { Agent, AgentConfig, AgentDeps } from "./types.ts"
import { createAgentContext } from "./context.ts"
import { createTurnRunner } from "./turn.ts"

export function createAgent(ctx: PluginContext, deps: AgentDeps & AgentConfig): Agent {
  // Standalone agents without persisted IDs still own separate conversations.
  const requestSessionId = deps.sessionId ?? randomUUID()
  let activeOperations = 0
  async function track<T>(operation: () => Promise<T>): Promise<T> {
    activeOperations++
    try { return await operation() }
    catch (error) { context.contextMeter.invalidate(); throw error }
    finally { activeOperations-- }
  }
  // Desktop turns have no arbitrary step ceiling. Explicit callers may still
  // provide a finite limit for bounded automation and tests.
  const maxTurns = deps.maxTurns
  const maxParallel = deps.maxParallelToolCalls ?? 10
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error(`maxParallelToolCalls must be a positive integer (got ${maxParallel})`)
  }
  const context = createAgentContext(deps)
  const runTurn = createTurnRunner(ctx, deps, context, requestSessionId, maxTurns, maxParallel)
  return {
    contextBudget: () => context.readBudget(),
    updateContext(config) {
      if (activeOperations > 0) throw new Error("agent is busy")
      context.update(config)
    },
    run: (task, signal, images, inputId) => track(() => runTurn(task, signal, images, inputId)),
    followup: (message, signal) => track(() => runTurn(message, signal)),
    compact: (instructions?: string) => track(async () =>
      context.compactor ? context.compactor.compact(deps.session, instructions) : { compacted: false, shadowedSeqs: [] }),
  }
}
