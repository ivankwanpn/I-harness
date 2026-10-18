import { expect, it, vi } from 'vitest'
import { mkdtemp, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

it.each(['append', 'reconcile'] as const)('reports one safe known-sync cleanup diagnostic through the original coordinator (%s)', async operation => {
  for (const reporter of ['normal', 'throw', 'reject'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'ih-f1-cleanup-report-'))
    const report = vi.fn((_error: unknown) => { if (reporter === 'throw') throw new Error('reporter failed'); if (reporter === 'reject') return Promise.reject(new Error('reporter rejected')) })
    const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true }, reportBackgroundFailure: report })
    const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
    const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const append = backend.appendOwnedBatch!
    let writes = 0, truncates = 0, syncs = 0, closes = 0, key: import('@i-harness/core-session').BatchKey | undefined
    backend.appendOwnedBatch = async (...args) => { writes++; const outcome = await append(...args); if (operation === 'reconcile') { key = args[3].key; return { kind: 'unknown', key } }; return outcome }
    const closeFails = () => vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await native.open(...args)
      if (String(args[0]) !== join(root, id + '.jsonl') || args[1] !== 'r+') return handle
      return new Proxy(handle, { get(target, name) {
        if (name === 'close') return async () => { closes++; await target.close(); throw new Error('private raw filesystem detail') }
        if (name === 'sync') return async () => { syncs++; await target.sync() }
        if (name === 'truncate') return async (length: number) => { truncates++; await target.truncate(length) }
        const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    try {
      if (operation === 'append') closeFails()
      const admissions = await Promise.all(Array.from({ length: operation === 'append' ? 3 : 1 }, () => document.metadata.admit({ type: 'plan/mode', mode: 'on' })))
      let outcome = admissions[0]!
      if (operation === 'append') expect(admissions.map(value => value.kind === 'committed' ? value.seqs : undefined)).toEqual([[0], [1], [2]])
      if (operation === 'reconcile') { expect(outcome.kind).toBe('unknown'); closeFails(); outcome = await document.reconcile(key!) }
      expect(outcome).toMatchObject({ kind: 'committed', seqs: [0] })
      expect([writes, syncs, closes, truncates]).toEqual([1, 1, 1, 0])
      expect(report).toHaveBeenCalledOnce()
      const diagnostic = report.mock.calls[0]![0] as Error
      expect(diagnostic.message).toBe('Managed journal file close failed after sync')
      expect(diagnostic.message).not.toContain(root)
      expect(diagnostic.message).not.toContain('private raw')
      if (outcome.kind !== 'committed') throw new Error('Expected original receipt')
      await document.reconcile(outcome.receipt.key)
      expect(report).toHaveBeenCalledOnce()
      expect(writes).toBe(1)
    } finally { vi.mocked(open).mockImplementation(native.open); await coordinator.close() }
  }
})

it.each(['invalid', 'accessor'] as const)('keeps a valid original receipt when an optional cleanup marker is %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-cleanup-marker-')), backend = createJsonlBackend(root)
  const report = vi.fn(), coordinator = createSessionCoordinator(backend, { lock: { enabled: true }, reportBackgroundFailure: report })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), append = backend.appendOwnedBatch!
  let reads = 0, writes = 0
  backend.appendOwnedBatch = async (...args) => {
    writes++
    const outcome = await append(...args)
    if (outcome.kind !== 'committed') return outcome
    return Object.defineProperty({ ...outcome }, 'cleanupDiagnostic', mode === 'invalid' ? { value: 'private unexpected detail', enumerable: true } : { get() { reads++; throw new Error('must not execute') }, enumerable: true })
  }
  try {
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).toMatchObject({ kind: 'committed', seqs: [0] })
    expect([writes, reads]).toEqual([1, 0])
    expect(report).not.toHaveBeenCalled()
  } finally { await coordinator.close().catch(() => {}) }
})
