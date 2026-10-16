import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'

it.each(['second-first', 'last-first', 'concurrent', 'multiple-event-groups'] as const)('returns each original group slice after shared-key reconciliation (%s)', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-shared-key-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  let writes = 0, reconciles = 0
  backend.appendOwnedBatch = async (...args) => { writes++; await append(...args); return { kind: 'unknown', key: args[3].key } }
  backend.reconcileOwnedBatch = async (...args) => { reconciles++; return reconcile(...args) }
  const action = document.beginAction(), source = document.registerReceivedInputSource(async () => {})
  const counts = mode === 'multiple-event-groups' ? [2, 1, 3] : [1, 1, 1]
  const facts = counts.map((count, index) => mode === 'multiple-event-groups'
    ? action.captureTeamTransaction(Array.from({ length: count }, (_, offset) => ({ type: 'team/member' as const, version: 1 as const, teamId: 't', member: { id: `${index}-${offset}`, name: `${index}-${offset}`, description: '', provider: 'fixture', context: 'fresh' as const, phase: 'active' as const } })))
    : source.captureAdmitted({ type: 'agent/input/admitted', version: 1, inputId: String(index), text: String(index), delivery: 'queue', intent: 'user' }))
  const expected = counts.map((count, index) => Array.from({ length: count }, (_, offset) => counts.slice(0, index).reduce((sum, value) => sum + value, 0) + offset))
  try {
    const outcomes = await Promise.all(facts.map(fact => fact.admit()))
    expect(outcomes.every(outcome => outcome.kind === 'unknown')).toBe(true)
    expect(outcomes).toEqual([outcomes[0], outcomes[0], outcomes[0]])
    const order = mode === 'second-first' ? [1, 0, 2] : [2, 1, 0]
    const recovered = mode === 'concurrent' ? await Promise.all(order.map(index => facts[index]!.reconcile())) : []
    if (mode !== 'concurrent') for (const index of order) recovered.push(await facts[index]!.reconcile())
    for (const [offset, index] of order.entries()) {
      expect(recovered[offset]).toMatchObject({ kind: 'committed', seqs: expected[index] })
      expect(await facts[index]!.observe()).toEqual(recovered[offset])
      if (outcomes[index]!.kind === 'unknown' && recovered[offset]!.kind === 'committed') expect(recovered[offset]!.receipt.key).toEqual(outcomes[index]!.key)
    }
    expect([writes, reconciles]).toEqual([1, 1])
    expect(document.view.events.map(event => event.seq)).toEqual(expected.flat())
    await source.close()
  } finally { action.finish(); await coordinator.close().catch(() => {}) }
})
