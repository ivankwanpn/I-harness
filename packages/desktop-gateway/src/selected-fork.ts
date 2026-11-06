import { createManagedSessionState } from '@i-harness/core-session'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { createCompletedPassiveContext } from '../../core-session/src/conversation/passive-seed-context.ts'
import { exportSelectedResultsConversationSeed } from '../../core-session/src/conversation/seed-export.ts'
import { compileSelectedResultsSemanticSeed, type CompiledSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'

/** Build the v3 seed a selected-results fork hands to the child. The source is
 *  read through the coordinator's own snapshot, so this works on any store that
 *  can fold a session (the commit log included). */
export async function captureSelectedResultsSeed(
  coordinator: SessionCoordinator, sourceSessionId: string, assertCurrent: () => void = () => {},
): Promise<{ kind: 'compiled'; compiled: CompiledSelectedResultsSemanticSeed } | { kind: 'refused'; reason: string }> {
  assertCurrent()
  const { session } = await coordinator.load(sourceSessionId)
  assertCurrent()
  const managed = createManagedSessionState(session as never, { sessionId: sourceSessionId })
  const factOwner = {} as never
  managed.bindOwner(factOwner)
  const owner = { kind: 'held-public-fork' as const, view: managed.view, factOwner, sourceSessionId, assertCurrent }
  const inherited = { assertCurrent, async *legacy() { assertCurrent() } }
  const context = createCompletedPassiveContext(owner as never, { kind: 'completed' })
  if (context.kind !== 'ready') return { kind: 'refused', reason: context.reason }
  assertCurrent()
  const exported = await exportSelectedResultsConversationSeed(context.context as never, inherited as never)
  assertCurrent()
  if (exported.kind !== 'seed') return { kind: 'refused', reason: 'unsupported-history' }
  return { kind: 'compiled', compiled: compileSelectedResultsSemanticSeed(exported) }
}