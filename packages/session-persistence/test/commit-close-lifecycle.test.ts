import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createSessionCoordinator } from '../src/index.ts'
import { createCommitCoordinator, createOwnedLegacySessionStore } from '../src/commit/coordinator.ts'
import { asSessionCoordinator } from '../src/commit/facade.ts'
import { taskDocumentStorageContract } from '../src/task-state-internal.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/backend-factory.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'

async function directory(run: (root: string) => Promise<void>) {
  const base = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!
  const root = await mkdtemp(join(base, 'commit-close-'))
  try { await run(root) }
  finally {
    const tail = relative(base, root)
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw Error('Unsafe cleanup')
    await rm(root, { recursive: true, force: true })
  }
}

it('the public JSONL coordinator also retires fresh mutation after close', async () => {
  await directory(async root => {
    const coordinator = createSessionCoordinator(createJsonlBackend(root))
    await coordinator.create({ sessionId: 'retired' })
    await coordinator.close()
    const before = await readFile(join(root, 'retired.jsonl'))
    await expect(coordinator.updateMeta('retired', { title: 'must not be written' })).rejects.toThrow()
    expect(await readFile(join(root, 'retired.jsonl'))).toEqual(before)
  })
})

it('joins an accepted native JSONL metadata write before retiring its private backend', async () => {
  await directory(async root => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let armed = false
    const backend = createJsonlBackend(root, { wrap(backend) {
      const update = backend.updateMeta!
      backend.updateMeta = async (...args) => {
        if (armed) { entered.resolve(); await release.promise }
        return update(...args)
      }
    } })
    const coordinator = createSessionCoordinator(backend)
    await coordinator.create({ sessionId: 'accepted' })
    armed = true
    const writing = coordinator.updateMeta('accepted', { title: 'acknowledged original write' })
    void writing.catch(() => {})
    try {
      await entered.promise
      const closing = coordinator.close()
      await expect(coordinator.profile('accepted')).rejects.toMatchObject({ code: 'FACT_CLOSED' })
      release.resolve()
      await writing
      await closing
      const cold = createSessionCoordinator(createJsonlBackend(root))
      try { expect((await cold.profile('accepted')).meta.title).toBe('acknowledged original write') }
      finally { await cold.close() }
    } finally { release.resolve(); await writing.catch(() => {}); await coordinator.close() }
  })
})

it('rejects fresh modern reads and writes after close while memory status and repeated close remain usable', async () => {
  await directory(async root => {
    const original = createJsonlCommitCoordinator(root), coordinator = asSessionCoordinator(original)
    await coordinator.create({ sessionId: 'existing' })
    const documents = original.capabilities().documents
    await coordinator.close()
    const before = await readFile(join(root, 'existing', 'session.v15.jsonl'))
    for (const run of [
      () => coordinator.create({ sessionId: 'late' }),
      () => coordinator.updateMeta('existing', { title: 'late' }),
      () => coordinator.append('existing', [{ type: 'plan/mode', mode: 'on' }]),
      () => coordinator.putDocumentStrict!('late', { value: true }),
      () => coordinator.profile('existing'),
      () => coordinator.snapshot!('existing'),
      () => coordinator.getDocument('task-existing'),
      () => documents.putDocument('private-late', { value: true }),
      () => documents.getDocument('task-existing'),
    ]) await expect(Promise.resolve().then(run)).rejects.toMatchObject({ code: 'COMMIT_LOG_CLOSED' })
    expect(original.ownerOf('existing')).toBe(false)
    expect(original.hasLiveOwnership('existing')).toBe(false)
    await coordinator.close()
    expect(await readFile(join(root, 'existing', 'session.v15.jsonl'))).toEqual(before)
  })
})

it('joins an accepted facade create through its captured initial Task document after close starts', async () => {
  await directory(async root => {
    const source = createOwnedLegacySessionStore(createJsonlBackend(root))
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const original = createCommitCoordinator({ root, legacy: {
      ...source,
      async withDocuments(keys, work) {
        if (keys.includes('task-accepted')) { entered.resolve(); await release.promise }
        return source.withDocuments!(keys, work)
      },
    } })
    const initial = taskDocumentStorageContract.empty()
    const coordinator = asSessionCoordinator(original, { taskDocument: { validator: taskDocumentStorageContract, empty: () => initial } })
    const creating = coordinator.create({ sessionId: 'accepted' })
    void creating.catch(() => {})
    try {
      await entered.promise
      let closed = false
      const closing = coordinator.close().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      initial.notifications.push({ invalid: true } as never)
      release.resolve()
      await creating
      await closing
      const cold = createJsonlCommitCoordinator(root)
      try { expect(await cold.getDocument('task-accepted')).toMatchObject({ tasks: [], notifications: [] }) }
      finally { await cold.close() }
    } finally { release.resolve(); await creating.catch(() => {}); await coordinator.close() }
  })
})

it('joins an accepted original legacy migration before retiring its resource owner', async () => {
  await directory(async root => {
    const writer = createSessionCoordinator(createJsonlBackend(root))
    await writer.create({ sessionId: 'legacy', title: 'retained' })
    await writer.close()
    const bytes = await readFile(join(root, 'legacy.jsonl'))
    const source = createOwnedLegacySessionStore(createJsonlBackend(root))
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const coordinator = createCommitCoordinator({ root, legacy: {
      ...source,
      migrate(id, publish) {
        return source.migrate!(id, async value => { entered.resolve(); await release.promise; return publish(value) })
      },
    } })
    const writing = coordinator.updateMeta('legacy', { archived: true })
    void writing.catch(() => {})
    try {
      await entered.promise
      const closing = coordinator.close()
      await expect(coordinator.profile('legacy')).rejects.toMatchObject({ code: 'COMMIT_LOG_CLOSED' })
      release.resolve()
      await writing
      await closing
      const cold = createJsonlCommitCoordinator(root)
      try { expect((await cold.profile('legacy')).meta).toMatchObject({ title: 'retained', archived: true }) }
      finally { await cold.close() }
      expect(await readFile(join(root, 'legacy.jsonl'))).toEqual(bytes)
    } finally { release.resolve(); await writing.catch(() => {}); await coordinator.close() }
  })
})

it('keeps original required document settlement available while public admission closes', async () => {
  await directory(async root => {
    const original = createJsonlCommitCoordinator(root), coordinator = asSessionCoordinator(original)
    await coordinator.create({ sessionId: 'owned' })
    const document = await coordinator.openManagedDocument('owned'), action = document.beginAction()
    const documents = original.capabilities().documents
    let settled = false
    action.registerSettlementSource(async () => {
      if (settled) return
      await expect(coordinator.close()).rejects.toThrow('own accepted operation')
      await expect(coordinator.putDocumentStrict!('fresh-public', {})).rejects.toMatchObject({ code: 'COMMIT_LOG_CLOSED' })
      await documents.putDocument('original-cleanup', { acknowledged: true })
      expect(await documents.getDocument('original-cleanup')).toEqual({ acknowledged: true })
      settled = true
    })
    action.finish()
    await coordinator.close()
    expect(settled).toBe(true)
    const cold = createJsonlCommitCoordinator(root)
    try { expect(await cold.getDocument('original-cleanup')).toEqual({ acknowledged: true }) }
    finally { await cold.close() }
  })
})

it.each(['jsonl', 'commit-log'] as const)('locally refuses a %s callback joining its own close without retiring unrelated work', async store => {
  await directory(async root => {
    const coordinator = store === 'jsonl' ? createSessionCoordinator(createJsonlBackend(root)) : createJsonlCommitCoordinator(root)
    await coordinator.create({ sessionId: 'source' })
    const result = await coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async () => {
      await expect(coordinator.close()).rejects.toThrow('own accepted operation')
      return 'original observation'
    })
    expect(result).toBe('original observation')
    expect((await coordinator.profile('source')).meta.sessionId).toBe('source')
    await coordinator.close()
  })
})

it.each([undefined, null, false, 0, ''])('preserves a falsey accepted write failure through close: %s', async failure => {
  await directory(async root => {
    const source = createOwnedLegacySessionStore(createJsonlBackend(root))
    const coordinator = createCommitCoordinator({ root, legacy: {
      ...source,
      withDocuments() { return Promise.reject(failure) },
    } })
    const writing = coordinator.putDocument('failed', {})
    void writing.catch(() => {})
    const closing = coordinator.close()
    await expect(writing).rejects.toBe(failure)
    await expect(closing).rejects.toMatchObject({ errors: expect.arrayContaining([failure]) })
    await coordinator.close()
  })
})
