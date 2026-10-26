import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { contextSourceIdentity } from '@i-harness/context-output'
import * as api from '../src/lifecycle/result-observation.ts'
import { acquireResultReadStore } from '../src/lifecycle/result-store.ts'

it('uses actual held metadata/view, revokes escaped context and rejects an append before returning data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-ro-'))
  const c = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  try {
    await c.create({ sessionId: 'source', title: 'real' })
    const document = await c.openManagedDocument('source'), scope = api.createResultObservationScope()
    const escaped = Promise.withResolvers<() => void>(), resume = Promise.withResolvers<void>()
    let escapedRead!: Promise<unknown>
    await c.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async observation => {
      const profile = vi.spyOn(c, 'profile').mockRejectedValue(new Error('profile recursion'))
      await scope.run({ sessionId: 'source', sessionIds: ['source'], observation, document,
        currentSource: () => ({ sourceId: contextSourceIdentity('w', root), readonly: true }), assertHostCurrent() {} }, async () => {
        expect(scope.current('source')?.metadata.title).toBe('real')
        expect(scope.current('source')?.view).toBe(document.view)
        escapedRead = (async () => { await resume.promise; return scope.current('source') })()
        escaped.resolve(() => {})
      })
      expect(profile).not.toHaveBeenCalled(); profile.mockRestore()
    })
    resume.resolve(); await expect(escapedRead).rejects.toThrow('expired')
    await expect(c.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, observation => scope.run({ sessionId: 'source', sessionIds: ['source'], observation, document,
      currentSource: () => ({ sourceId: 'source', readonly: true }), assertHostCurrent() {} }, async () => {
        await document.metadata.admit({ type: 'plan/mode', mode: 'on' })
        return 'must not escape'
      }))).rejects.toThrow('view changed')
  } finally { await c.close(); await rm(root, { recursive: true, force: true }) }
})
it('actual shared service reads real managed and legacy data under held source without public policy recursion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-orp-')), settings = join(root, 'settings.json')
  await writeFile(settings, JSON.stringify({ contextSubsystems: { contextOutput: { enabled: true } } }))
  const c = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await c.create({ sessionId: 'source' })
  const lease = await acquireResultReadStore({ workspace: root, coordinator: c, sessionId: 'source', contextOutputSettingsPath: settings, readCallerAvailable: () => true })
  try {
    const owner = lease.service!, source = await lease.sourceFor!('source')
    const ref = await owner.capture({ sessionId: 'source', callId: 'legacy', label: 'real', text: 'VISIBLE retained legacy', complete: true, source })
    if (!ref) throw new Error('Real legacy capture refused')
    await c.append('source', [{ type: 'context/result-ref', ref }])
    const issued = owner.registerResultScope({ operationId: 'real-managed', sessionId: 'source', callId: 'managed', source }, () => true)
    const sink = await owner.beginResult(issued, 'text-utf8-v1'); await sink.write(Buffer.from('VISIBLE retained managed'))
    const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Real managed result refused')
    const document = await c.openManagedDocument('source')
    await c.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, observation => lease.observations!.run({ sessionId: 'source', sessionIds: ['source'], observation, document,
      currentSource: () => source!, assertHostCurrent() {} }, async () => {
      const profile = vi.spyOn(c, 'profile').mockRejectedValue(new Error('profile recursion'))
      const originalSnapshot = c.snapshot
      const snapshot = vi.fn(async () => { throw new Error('snapshot recursion') })
      c.snapshot = snapshot
      const getDocument = vi.spyOn(c, 'getDocument').mockRejectedValue(new Error('binding recursion'))
      try {
        expect(await lease.sourceFor!('source')).toEqual(source)
        expect(await owner.readResult({ sessionId: 'source' }, { ref: saved.ref })).toMatchObject({ data: { text: 'VISIBLE retained managed' } })
        const observed = api.legacyObservationFor(lease.observations!.current('source')!)
        expect(await owner.readLegacyObserved({ sessionId: 'source' }, { refId: ref.id }, observed)).toMatchObject({ text: 'VISIBLE retained legacy' })
        expect((await owner.searchLegacyObserved({ sessionId: 'source' }, { query: 'VISIBLE' }, observed)).hits).toHaveLength(1)
        expect(profile).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled(); expect(getDocument).not.toHaveBeenCalled()
      } finally { profile.mockRestore(); c.snapshot = originalSnapshot; getDocument.mockRestore() }
    }))
  } finally { await lease.release(); await c.close(); await rm(root, { recursive: true, force: true }) }
})
