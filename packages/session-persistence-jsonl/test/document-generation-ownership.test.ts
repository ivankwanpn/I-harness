import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { AsyncResource } from 'node:async_hooks'
import { createSessionCoordinator, SessionLockConflictError } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createJsonlCommitCoordinator } from '../src/commit-coordinator.ts'
import { createCommitCoordinator, createOwnedLegacySessionStore, isCommittedDocumentClaimed } from '@i-harness/session-persistence/internal/commit'

const roots: string[] = [], owners: { close(): Promise<void> }[] = []
afterEach(async () => {
  const closed = await Promise.allSettled(owners.splice(0).map(owner => owner.close()))
  const failures = closed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length) throw new AggregateError(failures, 'Original document owners did not close')
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-document-generation-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  { name: 'navigation', prefix: 'desktop-navigation-', legacy: { version: 1, pinned: false, unread: false }, modern: { version: 1, pinned: true, unread: false }, late: { version: 1, pinned: false, unread: true } },
  { name: 'project binding', prefix: 'desktop-session-project-', legacy: { version: 1, projectId: 'before' }, modern: { version: 1, projectId: 'modern' }, late: { version: 1, projectId: 'late' } },
])('fences a normal legacy $name write after the modern document has claimed the key', async fixture => {
  const root = await mkdtemp(join(tmpdir(), 'ih-document-generation-')); roots.push(root)
  const options = { lock: { enabled: true, lockRoot: root } }
  const legacy = createSessionCoordinator(createJsonlBackend(root), options)
  const modern = createJsonlCommitCoordinator(root, options)
  owners.push(legacy, modern)
  const key = fixture.prefix + createHash('sha256').update('conversation').digest('hex')
  await legacy.putDocumentStrict!(key, fixture.legacy)
  expect(await modern.getDocument(key)).toEqual(fixture.legacy)
  const original = await readFile(join(root, `${key}.doc.jsonl`))
  await modern.putDocumentStrict(key, fixture.modern)
  expect(await modern.getDocument(key)).toEqual(fixture.modern)

  // Both calls use their normal coordinator admission and native document I/O.
  // The legacy side must not ACK a value the canonical reader will hide.
  const late = await Promise.allSettled([legacy.putDocumentStrict!(key, fixture.late)])
  expect(await modern.getDocument(key)).toEqual(fixture.modern)
  expect(late).toMatchObject([{ status: 'rejected', reason: { code: 'SESSION_FORMAT_SUPERSEDED' } }])
  expect(await readFile(join(root, `${key}.doc.jsonl`))).toEqual(original)

  const unclaimed = key + '-unclaimed'
  await legacy.putDocumentStrict!(unclaimed, fixture.late)
  expect(await modern.getDocument(unclaimed)).toEqual(fixture.late)
}, 15000)

it('does not turn a corrupt committed document store into permission for an older writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-document-generation-')); roots.push(root)
  const options = { lock: { enabled: true, lockRoot: root } }
  const legacy = createSessionCoordinator(createJsonlBackend(root), options), modern = createJsonlCommitCoordinator(root, options)
  owners.push(legacy, modern)
  const key = 'desktop-navigation-' + createHash('sha256').update('corrupt').digest('hex')
  const old = { version: 1, pinned: false, unread: false }
  await legacy.putDocumentStrict!(key, old)
  const original = await readFile(join(root, `${key}.doc.jsonl`))
  await modern.putDocumentStrict(key, { version: 1, pinned: true, unread: false })
  await writeFile(join(root, '__documents__', 'session.v15.jsonl'), 'not a committed document record\n')
  await expect(isCommittedDocumentClaimed(root, key)).rejects.toThrow()
  await expect(legacy.putDocumentStrict!(key, old)).rejects.toThrow()
  expect(await readFile(join(root, `${key}.doc.jsonl`))).toEqual(original)
}, 15000)

it('retains a cleared document claim through a real checkpoint and cold restart without reviving legacy bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-document-generation-')); roots.push(root)
  const options = { lock: { enabled: true, lockRoot: root } }
  const legacy = createSessionCoordinator(createJsonlBackend(root), options)
  const modern = createJsonlCommitCoordinator(root, options)
  owners.push(legacy, modern)
  const key = 'desktop-navigation-' + createHash('sha256').update('conversation').digest('hex')
  const old = { version: 1, pinned: false, unread: false }
  await legacy.putDocumentStrict!(key, old)
  const original = await readFile(join(root, `${key}.doc.jsonl`))
  await modern.create({ sessionId: 'conversation' })
  await modern.putDocumentStrict(key, { version: 1, pinned: true, unread: true })
  await modern.deleteOwnedSession('conversation', { documents: [key] })
  expect(await modern.getDocument(key)).toBeUndefined()
  for (let revision = 0; revision < 70; revision++) await modern.putDocumentStrict('maintenance', { revision })
  const checkpoint = await readFile(join(root, '__documents__', 'session.v15.jsonl'), 'utf8')
  expect(checkpoint.trim().split('\n').length).toBeLessThan(20)
  await modern.close(); await legacy.close()

  const cold = createJsonlCommitCoordinator(root, options)
  const oldWriter = createSessionCoordinator(createJsonlBackend(root), options)
  owners.push(cold, oldWriter)
  expect(await isCommittedDocumentClaimed(root, key)).toBe(true)
  expect(await cold.getDocument(key)).toBeUndefined()
  await expect(oldWriter.putDocumentStrict!(key, old)).rejects.toMatchObject({ code: 'SESSION_FORMAT_SUPERSEDED' })
  expect(await readFile(join(root, `${key}.doc.jsonl`))).toEqual(original)
}, 30000)

it('makes both normal writer routes contend on the existing original document lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-document-generation-')); roots.push(root)
  const options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 5, acquireDeadlineMs: 50 }
  const holder = createOwnedLegacySessionStore(createJsonlBackend(root), options)
  const legacy = createSessionCoordinator(createJsonlBackend(root), options), modern = createJsonlCommitCoordinator(root, options)
  owners.push({ close: () => holder.close!() }, legacy, modern)
  const key = 'desktop-navigation-' + createHash('sha256').update('held').digest('hex')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const holding = holder.withDocuments!([key], async () => { entered.resolve(); await release.promise })
  try {
    await entered.promise
    const results = await Promise.allSettled([legacy.putDocumentStrict!(key, { version: 1, pinned: true, unread: false }), modern.putDocumentStrict(key, { version: 1, pinned: false, unread: true })])
    expect(results).toHaveLength(2)
    for (const result of results) { expect(result.status).toBe('rejected'); if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(SessionLockConflictError) }
    expect(await isCommittedDocumentClaimed(root, key)).toBe(false)
  } finally { release.resolve(); await holding }
  await modern.putDocumentStrict(key, { version: 1, pinned: false, unread: true })
  expect(await isCommittedDocumentClaimed(root, key)).toBe(true)
}, 15000)

it('admits the document flight before a synchronous scope callback starts close and joins the held original scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-document-generation-')); roots.push(root)
  const options = { lock: { enabled: true, lockRoot: root } }
  const original = createOwnedLegacySessionStore(createJsonlBackend(root), options)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const external = new AsyncResource('external-document-close')
  let closing: Promise<void> | undefined, closed = false
  const modern = createCommitCoordinator({ root, ...options, legacy: { ...original, withDocuments(keys, work) {
    closing = external.runInAsyncScope(() => modern.close())
    void closing.then(() => { closed = true }, () => { closed = true })
    return original.withDocuments!(keys, async () => { entered.resolve(); await release.promise; return work() })
  } } })
  owners.push(modern)
  const key = 'desktop-navigation-' + createHash('sha256').update('closing').digest('hex')
  const publication = modern.putDocumentStrict(key, { version: 1, pinned: true, unread: false })
  try {
    await Promise.race([entered.promise, publication.then(() => { throw Error('Publication escaped its held document scope') })])
    expect(closing).toBeDefined(); expect(closed).toBe(false)
    release.resolve(); await publication; await closing
    const cold = createJsonlCommitCoordinator(root, options); owners.push(cold)
    expect(await cold.getDocument(key)).toEqual({ version: 1, pinned: true, unread: false })
  } finally { release.resolve(); await Promise.allSettled([publication, ...(closing ? [closing] : [])]); external.emitDestroy() }
}, 15000)

it('refuses a document callback awaiting its own coordinator close before any publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-document-generation-')); roots.push(root)
  const options = { lock: { enabled: true, lockRoot: root } }, original = createOwnedLegacySessionStore(createJsonlBackend(root), options)
  const modern = createCommitCoordinator({ root, ...options, legacy: { ...original, async withDocuments(keys, work) {
    await modern.close()
    return original.withDocuments!(keys, work)
  } } })
  owners.push(modern)
  const key = 'desktop-navigation-' + createHash('sha256').update('self-close').digest('hex')
  await expect(modern.putDocumentStrict(key, { version: 1, pinned: true, unread: false })).rejects.toThrow('Cannot close a coordinator from its own accepted operation')
  expect(await isCommittedDocumentClaimed(root, key)).toBe(false)
}, 15000)
