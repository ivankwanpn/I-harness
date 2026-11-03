import { randomUUID } from 'node:crypto'
import type { Agent, AgentConfig, AgentDeps } from './types.ts'
import type { AgentContext } from './context.ts'
import { agentFacts, committedFactSeqs } from './facts.ts'
import { ensureWritableContext } from './context-readiness.ts'

/** One explicit API invocation owns one command identity; inner compaction
 * helpers borrow its summary-only action and cannot create another pool. */
export async function runManualCompaction(deps: AgentDeps & AgentConfig, context: AgentContext, instructions?: string, options?: Parameters<NonNullable<Agent['compact']>>[1]) {
  const start = { wall: Date.now(), monotonic: performance.now() }
  let generation = options?.generation
  if (generation) generation.adoptManual(deps.session, options?.signal ?? deps.signal ?? new AbortController().signal)
  else if (deps.generationLifecycle) {
    const commandId = randomUUID()
    const [seq] = committedFactSeqs(await agentFacts(deps).metadata.admit({ type: 'command/run', commandId, name: 'compact', ...(instructions !== undefined ? { args: instructions } : {}), source: { kind: 'user' } }))
    generation = await deps.generationLifecycle.open('manual', { kind: 'command', seq: seq! }, { signal: options?.signal ?? deps.signal, timeoutMs: deps.modelActionTimeoutMs, start })
  }
  deps.generationAction = generation
  try {
    generation?.assertOpen()
    await ensureWritableContext(deps)
    context.refreshBinding()
    const { generation: _generation, ...runOptions } = options ?? {}
    const result = context.compactor ? await context.compactor.compact(deps.session, instructions, { ...runOptions, signal: generation?.signal ?? options?.signal })
      : { compacted: false, shadowedSeqs: [], outcome: 'unchanged' as const, publication: 'none' as const }
    await generation?.close('completed')
    return result
  } catch (error) {
    await generation?.close(options?.signal?.aborted ? 'stopped' : 'failed')
    throw error
  }
}
