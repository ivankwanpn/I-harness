import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlBackend } from '../src/index.ts'
import { createSessionCoordinator } from './helpers/composed.ts'

it('refuses queued and capacity-waiting optional groups while preserving an already issued original receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r4a-hold-capacity-'))
  const issued = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let writes = 0
  // Bound before construction: patching the backend afterwards is rejected as
  // PROCESS_READ_UNAVAILABLE by the original-descriptor guard.
  const backend = createJsonlBackend(root, { wrapOwnedBatch: append => async (...args) => { writes++; const outcome = await append(...args); if (writes === 1) { issued.resolve(); await release.promise } return outcome } })
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true }, maxPendingGroups: 1 })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), action = document.beginAction()
  const source = action.registerSettlementSource(async () => {})
  try {
    const original = action.facts.metadata.admit({ type: 'plan/mode', mode: 'on' })
    await issued.promise
    const waiting = action.facts.metadata.admit({ type: 'plan/mode', mode: 'off' })
    source.holdRecovery()
    expect(await waiting).toEqual({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    expect(() => document.registerReceivedInputSource(async () => {})).toThrowError('Managed facts require reconciliation')
    expect(await document.importSeed([])).toEqual({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    release.resolve()
    expect(await original).toHaveProperty('kind', 'committed')
    expect((await backend.read(id)).events.map(event => event.type)).toEqual(['plan/mode'])
    await source.close()
    const queued = action.facts.metadata.admit({ type: 'plan/mode', mode: 'off' })
    await Promise.resolve()
    const other = action.registerSettlementSource(async () => {})
    other.holdRecovery()
    expect(await queued).toEqual({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    await other.close(); action.finish()
    expect(writes).toBe(1)
  } finally { release.resolve(); await source.close(); await coordinator.close() }
})

it('rechecks a new source hold at the actual backend beforeIssue boundary without issuing or retrying the optional group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r4a-hold-before-issue-'))
  let attempts = 0, source!: { holdRecovery(): void }
  const backend = createJsonlBackend(root, { wrapOwnedBatch: append => async (...args) => { attempts++; source.holdRecovery(); return append(...args) } })
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), action = document.beginAction()
  source = action.registerSettlementSource(async () => {})
  try {
    expect(await action.facts.metadata.admit({ type: 'plan/mode', mode: 'on' })).toEqual({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    expect((await backend.read(id)).events).toEqual([])
    expect(attempts).toBe(1)
    await source.close(); action.finish()
    const later = document.beginAction(); later.finish()
  } finally { await source.close(); await coordinator.close() }
})