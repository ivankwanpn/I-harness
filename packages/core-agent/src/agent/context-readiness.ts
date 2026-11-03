import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import type { AgentDeps } from './types.ts'
/** The persistence owner establishes its durable header; the Agent checks only
 * its actual in-memory Session. Flush/ownership guesses grant no readiness. */
export async function ensureWritableContext(deps: Pick<AgentDeps, 'session' | 'ensureWritableContext'>): Promise<void> {
  await deps.ensureWritableContext?.()
  if (deps.session.formatVersion !== CURRENT_FORMAT_VERSION) throw Object.assign(new Error('Explicitly upgrade the Session or provide ensureWritableContext before model execution'), { code: 'CONTEXT_FORMAT_PRECONDITION' })
}
