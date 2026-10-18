import { isNondurableSession, type SessionEventView } from '@i-harness/core-session'
import type { AgentInputOptions } from '@i-harness/core-agent'
import type { ChildAgentEntry } from '../agent-table.ts'
import type { SubagentToolDeps } from '../tools/types.ts'
import { childFactOwner } from '../child/document.ts'

export interface FollowupGeneration {
  options?: AgentInputOptions
  close(): Promise<void>
}
/** The actual inbox executor owns this source before any resident resolver.
 * Reading/rebuilding metadata alone cannot construct it. */
export async function openFollowupGeneration(deps: SubagentToolDeps, entry: ChildAgentEntry, input: Extract<SessionEventView, { type: 'subagent/inbox' }>, controller: AbortController): Promise<FollowupGeneration> {
  const start = { wall: Date.now(), monotonic: performance.now() }
  const owner = await childFactOwner(entry, deps.childSessions?.coordinator)
  if (isNondurableSession(owner.view)) return { close: async () => {} }
  if (!entry.sessionId || !deps.generationFactoryFor) throw Object.assign(new Error('Child generation ownership is unavailable'), { code: 'GENERATION_UNSUPPORTED' })
  const action = owner.beginAction(controller.signal)
  const lifecycle = deps.generationFactoryFor(owner, entry.sessionId, () => entry.executionModel?.())(action)
  const origin = { kind: 'delegated-input' as const, ref: 'inbox' as const, seq: input.seq!, messageId: input.messageId }
  try {
    const generation = await lifecycle.open('main', origin, { signal: controller.signal, start, timeoutMs: deps.modelActionTimeoutMs, maxAttempts: deps.modelActionMaxAttempts })
    return { options: { generation, delegatedOrigin: origin, provenance: input.provenance! }, async close() {
      try { await generation.close(controller.signal.aborted ? 'stopped' : 'failed') }
      finally { try { await lifecycle.drain() } finally { action.finish() } }
    } }
  } catch (error) { try { await lifecycle.drain() } finally { action.finish() }; throw error }
}
