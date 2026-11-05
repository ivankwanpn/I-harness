import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSession, exportConversationSeed, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { compileSemanticSeed } from '../src/semantic-seed.ts'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'
import { asSessionCoordinator } from '../src/commit/facade.ts'
import { hasSelectedSource, selectedSourceFor } from '../src/selected-source-owner.ts'

const roots: string[] = []
const coordinators: Array<ReturnType<typeof createCommitCoordinator>> = []
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ih-commit-fork-'))
  roots.push(root)
  const coordinator = createCommitCoordinator({ root })
  coordinators.push(coordinator)
  return { root, coordinator }
}
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close().catch(() => {})
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function append(session: ReturnType<typeof createSession>, event: Record<string, unknown>) {
  ;(session as unknown as { events: unknown[] }).events.push(event)
}

describe('commit-log public fork', () => {
  it('reports the selected-results capability as unavailable', async () => {
    const { coordinator } = await setup()
    const facade = asSessionCoordinator(coordinator)
    expect(hasSelectedSource(facade as never)).toBe(false)
    expect(() => selectedSourceFor(facade as never)).toThrow(/Original coordinator required/)
  })

  it('creates the fork child through the semantic capture', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 'parent' })
    const source = createSession()
    append(source, { type: 'user/message', seq: 0, text: 'source' })
    const exported = exportConversationSeed(source, { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
    if (exported.kind !== 'seed') throw new Error('seed refused')
    const request = {
      invocation: { version: 1 as const, operationId: 'fork-op', targetSessionId: 'forked', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'c'.repeat(64) },
      target: { kind: 'new' as const },
      metadata: { title: 'Fork' },
      lineage: { origin: 'fork' as const, parentSession: 'parent' },
      seed: compileSemanticSeed(exported),
    }
    const facade = asSessionCoordinator(coordinator)
    const outcome = await facade.bootstrapSemanticTargetWithCapture!(
      { invocation: request.invocation } as never,
      { assertCurrent() {}, dependencies: {} } as never,
      async () => request as never,
    )
    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.receipt.seedLength).toBe(request.seed.records.length)
    expect(outcome.receipt.dependencyClosureDigest).toBe(EMPTY_SEMANTIC_DEPENDENCY_DIGEST)
    expect(outcome.document.view.events.at(-1)?.type).toBe('session/bootstrap')
    await coordinator.closeManagedDocument('forked')
    const { session } = await coordinator.load('forked')
    expect(session.events.at(-1)?.type).toBe('session/bootstrap')
  })
})