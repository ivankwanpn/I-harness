import { expect, it } from 'vitest'
import { createManagedSessionState } from '../../core-session/src/managed/view.ts'
import { createCompletedPassiveContext } from '../../core-session/src/conversation/passive-seed-context.ts'
import { exportSelectedResultsConversationSeed } from '../../core-session/src/conversation/seed-export.ts'
import type { FactOwner } from '../../core-session/src/managed/ports.ts'
import { codecRef } from '../../core-session/test/fixtures/selected-results.ts'

// Prototype: can a v3 selected-results seed be produced from a plain Session
// (the shape the commit log folds) without the legacy createDocuments path?
function declaredSource() {
  const events: any[] = [
    { type: 'turn/start' }, { type: 'step/start' },
    { type: 'tool/call', callId: 'c', name: 'read', args: {} },
    { type: 'assistant/message', text: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
    { type: 'tool/dispatch', callId: 'c', eventSeq: 2 },
    { type: 'tool/result', callId: 'c', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'artifact', ref: { ...codecRef } } } },
    { type: 'step/end' }, { type: 'turn/end' },
  ]
  return { formatVersion: 15, events: events.map((event, seq) => ({ ...event, seq })) }
}

function heldSource(source: ReturnType<typeof declaredSource>, sessionId: string) {
  const managed = createManagedSessionState(source as never, { sessionId }), factOwner = {} as FactOwner
  managed.bindOwner(factOwner)
  let current = true
  const assertCurrent = () => { if (!current) throw Error('retired source') }
  const owner = { kind: 'held-public-fork' as const, view: managed.view, factOwner, sourceSessionId: sessionId, assertCurrent }
  const inherited = { assertCurrent, async *legacy() { assertCurrent() } }
  const context = () => { const result = createCompletedPassiveContext(owner as never, { kind: 'completed' }); if (result.kind !== 'ready') throw Error(result.reason); return result.context }
  return { managed, owner, inherited, context, retire() { current = false } }
}

it('exports a v3 selected-results seed from a folded session', async () => {
  const source = heldSource(declaredSource(), 'S')
  const exported = await exportSelectedResultsConversationSeed(source.context() as never, source.inherited as never)
  expect(exported.kind).toBe('seed')
  if (exported.kind !== 'seed') throw Error(exported.reason)
  expect(exported.seed).toMatchObject({ version: 3, selection: { kind: 'completed' } })
  expect(exported.seed.results.summary).toMatchObject({ rows: expect.any(Number), pages: expect.any(Number) })
})
