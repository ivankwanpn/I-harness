import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi, onTestFinished } from 'vitest'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { contextSourceIdentity } from '@i-harness/context-output'
import * as api from '../src/lifecycle/result-observation.ts'
import { acquireResultReadStore } from '../src/lifecycle/result-store.ts'
import { projectConversation } from '@i-harness/core-session'
import { legacyFixture } from '../../context-output/test/legacy-fork-fixture.ts'

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
        const held=scope.current('source');expect(held?.kind).toBe('public');if(held?.kind!=='public')throw Error('public observation required');expect(held.view).toBe(document.view)
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
it('reads and searches real READY L1 bytes after manifest-only shadow, including cold retained reads', async () => {
  // Real fork, live/cold observed reads and shadowing measured 8.076s.
  // Own admitted operations so a deadline cannot orphan a late setup/reopen.
  const pending = new Set<Promise<unknown>>()
  let retired = false, complete = false
  let initializing: ReturnType<typeof legacyFixture> | undefined
  let failedSetupCleanup: (() => Promise<void>) | undefined
  let closing: Promise<void> | undefined
  let primary: { cause: unknown } | undefined
  const runOwned = <T,>(run: () => Promise<T>): Promise<T> => {
    if (retired) throw Error('Original READY fixture retired')
    const original = run()
    pending.add(original)
    void original.then(() => pending.delete(original), () => pending.delete(original))
    return original
  }
  const close = (): Promise<void> => {
    retired = true
    if (complete) return Promise.resolve()
    if (closing) return closing
    const attempt = Promise.resolve().then(async () => {
      const failures: unknown[] = []
      let original: Awaited<ReturnType<typeof legacyFixture>> | undefined
      try { original = await initializing } catch (cause) { if (!primary || cause !== primary.cause) failures.push(cause) }
      const joined = await Promise.allSettled([...pending])
      for (const result of joined) {
        if (result.status === 'rejected' && (!primary || result.reason !== primary.cause)) failures.push(result.reason)
      }
      try {
        if (original) await original.close()
        else await failedSetupCleanup?.()
      } catch (cause) { failures.push(cause) }
      if (failures.length) throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original READY fixture cleanup failed', { cause: primary?.cause })
      complete = true
    })
    closing = attempt
    void attempt.finally(() => { if (closing === attempt) closing = undefined }).catch(() => {})
    return attempt
  }
  onTestFinished(close)
  initializing = runOwned(() => legacyFixture({ retainFailedSetupCleanup: cleanup => { failedSetupCleanup = cleanup } }))
  void initializing.catch(cause => { primary ??= { cause } })
  const f = await initializing
  if (retired) throw Error('Original READY fixture retired during setup')
  const scopes = api.createResultObservationScope()
  try {
    expect((await runOwned(() => f.run())).kind).toBe('ready')
    const target = await runOwned(() => f.coordinator().openManagedDocument('target'))
    expect((await runOwned(() => target.compaction.commit([{ type: 'compaction/summary', text: 'manifest metadata marker', shadowedSeqs: [0] }]))).kind).toBe('committed')
    expect(projectConversation(target.view).items.filter(item => item.provenance.kind === 'inherited')).toHaveLength(1)
    const readCurrent = async (visible: boolean) => {
      const c = f.coordinator(), document = await c.openManagedDocument('target'), getter = (await f.broker().resultReadScopeFor('target'))!, binding = getter()
      let escaped!: import('@i-harness/context-output').LegacyReadObservation
      await c.withExistingSessionBindingObservation!({ sessionIds: ['target'] }, observation => scopes.run({ sessionId: 'target', sessionIds: ['target'], observation, document,
        currentSource() { const current = getter(); if (current.revision !== binding.revision) throw new Error('Project scope changed'); return { sourceId: contextSourceIdentity('workspace', f.project.primaryRoot, current.scope), readonly: true } }, assertHostCurrent() {} }, async () => {
        const profile = vi.spyOn(c, 'profile').mockRejectedValue(new Error('profile recursion'))
        const getDocument = vi.spyOn(c, 'getDocument').mockRejectedValue(new Error('binding recursion'))
        const originalSnapshot = c.snapshot, snapshot = vi.fn(async () => { throw new Error('snapshot recursion') })
        c.snapshot = snapshot
        try {
          const observed = escaped = api.legacyObservationFor(scopes.current('target')!)
          expect(observed.bootstrap?.manifestDigest).toBe(document.view.header!.semanticSeed!.manifestDigest)
          if (visible) expect((await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observed)).text).toBe('VISIBLE retained text')
          else await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observed)).rejects.toThrow(/unauthorized|unavailable/i)
          expect((await f.service().searchLegacyObserved({ sessionId: 'target' }, { query: 'VISIBLE' }, observed)).hits.map(hit => hit.ref.id)).toEqual(visible ? [f.visible.id] : [])
          for (const ref of [f.hidden, f.future]) await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: ref.id }, observed)).rejects.toThrow()
          expect(profile).not.toHaveBeenCalled(); expect(getDocument).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled()
        } finally { profile.mockRestore(); getDocument.mockRestore(); c.snapshot = originalSnapshot }
      }))
      await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, escaped)).rejects.toThrow('expired')
    }
    await runOwned(() => readCurrent(true))
    await runOwned(() => f.sourceClear())
    await runOwned(() => f.reopen())
    const sourceCalls = f.sourceCalls()
    expect((await runOwned(() => f.run(true))).kind).toBe('already-ready')
    expect(f.sourceCalls()).toBe(sourceCalls)
    await runOwned(() => readCurrent(true))
    const cold = await runOwned(() => f.coordinator().openManagedDocument('target'))
    expect((await runOwned(() => cold.compaction.commit([{ type: 'compaction/summary', text: 'group shadowed', shadowedSeqs: [1] }]))).kind).toBe('committed')
    await runOwned(() => readCurrent(false))
  } catch (cause) { primary = { cause }; throw cause }
  finally { await close() }
}, 20000)
