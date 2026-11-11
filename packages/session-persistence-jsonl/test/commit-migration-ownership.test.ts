import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createJsonlCommitCoordinator } from '../src/commit-coordinator.ts'
import { createSessionCoordinator, compileSemanticSeed, rawHeaderDigest } from '@i-harness/session-persistence'
import { legacyPrefixDigest } from '@i-harness/core-session'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { createCommitCoordinator, createOwnedLegacySessionStore } from '@i-harness/session-persistence/internal/commit'
import { buildBootstrapHeader } from '../../session-persistence/src/coordinator/bootstrap-header.ts'
import { bootstrapPaths } from '../src/backend/bootstrap-stage.ts'

async function directory(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ih-migration-ownership-'))
  try { await run(root) }
  finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-migration-ownership-')) throw Error('Unsafe cleanup')
    await rm(root, { recursive: true, force: true })
  }
}

it('keeps a raw read-only legacy port readable and refuses unsupported write migration before publication', async () => {
  await directory(async root => {
    const backend = createJsonlBackend(root), writer = createSessionCoordinator(backend)
    await writer.create({ sessionId: 'source', title: 'old title' })
    const modern = createCommitCoordinator({ root, legacy: { read: id => backend.read(id), list: () => backend.list() } })
    try {
      expect((await modern.profile('source')).meta.title).toBe('old title')
      await expect(modern.updateMeta('source', { archived: true })).rejects.toMatchObject({ code: 'LEGACY_MIGRATION_UNSUPPORTED' })
      await writer.updateMeta('source', { title: 'acknowledged title' })
      expect((await modern.profile('source')).meta.title).toBe('acknowledged title')
    } finally { await modern.close(); await writer.close() }
  })
})

it('the actual JSONL adapter respects the original legacy writer and fences shadow writes after publication', async () => {
  await directory(async root => {
    const writer = createSessionCoordinator(createJsonlBackend(root))
    const modern = createJsonlCommitCoordinator(root, { acquireRetryMs: 5, acquireDeadlineMs: 60 })
    await writer.create({ sessionId: 'source', title: 'old title' })
    try {
      await writer.updateMeta('source', { title: 'acknowledged concurrent title' })
      const original = await readFile(join(root, 'source.jsonl'))
      await expect(modern.updateMeta('source', { archived: true })).rejects.toThrow()
      expect((await modern.profile('source')).meta.title).toBe('acknowledged concurrent title')
      await writer.releaseOwnership('source')
      await modern.updateMeta('source', { archived: true })
      expect((await modern.profile('source')).meta).toMatchObject({ title: 'acknowledged concurrent title', archived: true })
      await expect(writer.updateMeta('source', { title: 'must not be acknowledged' })).rejects.toMatchObject({ code: 'SESSION_FORMAT_SUPERSEDED' })
      await expect(createJsonlBackend(root).append('source', [])).rejects.toMatchObject({ code: 'SESSION_FORMAT_SUPERSEDED' })
      await expect(createJsonlBackend(root).putDocument('task-source', { changed: true })).rejects.toMatchObject({ code: 'SESSION_FORMAT_SUPERSEDED' })
      expect(await readFile(join(root, 'source.jsonl'))).toEqual(original)
    } finally { await modern.close(); await writer.close() }
  })
})

it('two migrators reselect the published generation under the same original legacy lease', async () => {
  await directory(async root => {
    const writer = createSessionCoordinator(createJsonlBackend(root))
    await writer.create({ sessionId: 'source', title: 'original title' })
    await writer.close()
    const original = await readFile(join(root, 'source.jsonl'))
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let held = false
    const backend = createJsonlBackend(root, { wrap(backend) {
      const read = backend.read
      backend.read = async id => {
        const value = await read(id)
        if (!held) { held = true; entered.resolve(); await release.promise }
        return value
      }
    } })
    const first = createCommitCoordinator({ root, legacy: createOwnedLegacySessionStore(backend), acquireDeadlineMs: 2000 })
    const second = createJsonlCommitCoordinator(root, { acquireRetryMs: 5, acquireDeadlineMs: 2000 })
    const publishing = first.updateMeta('source', { title: 'first committed title' })
    void publishing.catch(() => {})
    try {
      await entered.promise
      const following = second.updateMeta('source', { archived: true })
      void following.catch(() => {})
      release.resolve()
      await Promise.all([publishing, following])
      expect((await second.profile('source')).meta).toMatchObject({ title: 'first committed title', archived: true })
      expect(await readFile(join(root, 'source.jsonl'))).toEqual(original)
    } finally { release.resolve(); await publishing.catch(() => {}); await first.close(); await second.close() }
  })
})

it.each(['before-publication', 'after-publication'] as const)('retains exact legacy bytes through a %s cut and original retry', async phase => {
  await directory(async root => {
    const writer = createSessionCoordinator(createJsonlBackend(root))
    await writer.create({ sessionId: 'source', title: 'retained title' })
    await writer.append('source', [{ type: 'plan/mode', mode: 'on' }])
    await writer.close()
    const bytes = await readFile(join(root, 'source.jsonl'))
    const source = createOwnedLegacySessionStore(createJsonlBackend(root))
    const cut = new Error('Controlled migration publication cut')
    let armed = true
    const modern = createCommitCoordinator({ root, legacy: {
      ...source,
      migrate(id, publish) {
        return source.migrate!(id, async raw => {
          if (armed && phase === 'before-publication') { armed = false; throw cut }
          const result = await publish(raw)
          if (armed) { armed = false; throw cut }
          return result
        })
      },
    } })
    try {
      await expect(modern.updateMeta('source', { archived: true })).rejects.toBe(cut)
      expect((await modern.profile('source')).meta.title).toBe('retained title')
      await modern.updateMeta('source', { archived: true })
      await modern.updateMeta('source', { title: 'acknowledged modern title' })
      expect((await modern.snapshot('source')).session.events).toContainEqual(expect.objectContaining({ type: 'plan/mode', mode: 'on' }))
      expect((await modern.profile('source')).meta).toMatchObject({ title: 'acknowledged modern title', archived: true })
      expect(await readFile(join(root, 'source.jsonl'))).toEqual(bytes)
    } finally { await modern.close() }
    const cold = createJsonlCommitCoordinator(root)
    try {
      expect((await cold.profile('source')).meta).toMatchObject({ title: 'acknowledged modern title', archived: true })
      await cold.updateMeta('source', { archived: false })
      expect((await cold.snapshot('source')).session.events.filter(event => event.type === 'plan/mode')).toHaveLength(1)
      expect(await readFile(join(root, 'source.jsonl'))).toEqual(bytes)
    } finally { await cold.close() }
  })
})

it('new modern creation and fork cannot shadow an existing legacy target', async () => {
  await directory(async root => {
    const writer = createSessionCoordinator(createJsonlBackend(root))
    await writer.create({ sessionId: 'source', title: 'keep original identity' })
    await writer.close()
    const bytes = await readFile(join(root, 'source.jsonl'))
    const modern = createJsonlCommitCoordinator(root)
    try {
      await expect(modern.create({ sessionId: 'source', title: 'replacement' })).rejects.toMatchObject({ code: 'COMMIT_LOG_EXISTS' })
      await modern.create({ sessionId: 'new-parent' })
      await expect(modern.fork('new-parent', { sessionId: 'source' })).rejects.toMatchObject({ code: 'COMMIT_LOG_EXISTS' })
      expect((await modern.profile('source')).meta.title).toBe('keep original identity')
      expect(await readFile(join(root, 'source.jsonl'))).toEqual(bytes)
    } finally { await modern.close() }
  })
})

it.each([false, true])('explicit existing-empty target refuses without shadowing a legacy target with nonempty=%s', async nonempty => {
  await directory(async root => {
    const writer = createSessionCoordinator(createJsonlBackend(root))
    await writer.create({ sessionId: 'target', title: 'retained target' })
    if (nonempty) await writer.append('target', [{ type: 'plan/mode', mode: 'on' }])
    await writer.close()
    const bytes = await readFile(join(root, 'target.jsonl'))
    const modern = asSessionCoordinator(createJsonlCommitCoordinator(root))
    try {
      const request = {
        invocation: { version: 1 as const, operationId: 'existing-empty-request', targetSessionId: 'target', createdAt: '2026-11-01T00:00:00.000Z', requestDigest: 'a'.repeat(64) },
        target: { kind: 'existing-empty' as const, expectedHeaderDigest: rawHeaderDigest(bytes.subarray(0, bytes.indexOf(10))), expectedPrefix: { eventCount: 0, bodyBytes: 0, prefixDigest: legacyPrefixDigest(0, new Uint8Array()) } },
        metadata: {}, lineage: { origin: 'subagent' as const, parentSession: 'parent', subagentProtocolVersion: 1 as const }, seed: compileSemanticSeed({ kind: 'none' }),
      }
      expect(await modern.bootstrapSemanticTarget!(request, { assertCurrent() {}, dependencies: { async confirm() { throw Error('Unsupported target must not acquire dependencies') }, async reconcile() { throw Error('Unsupported target must not reconcile dependencies') } } })).toMatchObject(nonempty ? { kind: 'refused', reason: 'conflict' } : { kind: 'not-issued', reason: 'unsupported' })
      expect((await modern.profile('target')).meta.title).toBe('retained target')
      expect(await readFile(join(root, 'target.jsonl'))).toEqual(bytes)
    } finally { await modern.close() }
  })
})

it('does not treat an absent main file as a free target while an original bootstrap stage remains', async () => {
  await directory(async root => {
    const request = {
      invocation: { version: 1 as const, operationId: 'pending-birth', targetSessionId: 'pending', createdAt: '2026-11-01T00:00:00.000Z', requestDigest: 'c'.repeat(64) },
      target: { kind: 'new' as const }, metadata: { title: 'original pending birth' }, lineage: { origin: 'import' as const }, seed: compileSemanticSeed({ kind: 'none' }),
    }
    // A durable stage and no main file is the actual storage cut before header
    // publication. This negative fixture supplies no runtime authority token.
    const built = buildBootstrapHeader(request)
    const paths = bootstrapPaths(join(root, 'pending.jsonl'), request.invocation)
    await writeFile(paths.stage, built.operation.stageBytes)
    const original = await readFile(paths.stage)
    const modern = createJsonlCommitCoordinator(root)
    try {
      await expect(modern.create({ sessionId: 'pending' })).rejects.toMatchObject({ code: 'SESSION_BOOTSTRAP_INCOMPLETE' })
      expect(await readFile(paths.stage)).toEqual(original)
    } finally { await modern.close() }
    const legacy = createSessionCoordinator(createJsonlBackend(root))
    const never = async (): Promise<never> => { throw Error('Empty seed has no dependencies') }
    try {
      const resumed = await legacy.resumeSemanticTarget(request.invocation, { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } }, request)
      expect(resumed.kind).toMatch(/ready/)
      expect(await readFile(paths.stage)).toEqual(original)
    } finally { await legacy.close() }
    const migrated = createJsonlCommitCoordinator(root)
    try {
      await migrated.updateMeta('pending', { archived: true })
      expect((await migrated.profile('pending')).meta).toMatchObject({ title: 'original pending birth', archived: true })
      expect((await migrated.snapshot('pending')).session.events.filter(event => event.type === 'session/bootstrap')).toHaveLength(1)
      expect(await readFile(paths.stage)).toEqual(original)
    } finally { await migrated.close() }
  })
})
