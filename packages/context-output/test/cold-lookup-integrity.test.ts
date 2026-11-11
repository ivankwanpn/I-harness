import { expect, it, vi } from 'vitest'
import { io, observeOpen, contentOpens } from './integrity-io.ts'
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: observeOpen(fs.open), rename: async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    await io.beforeRename?.(String(from), String(to)); return fs.rename(from, to)
  } }
})
import { readFile, writeFile, readdir, rename, symlink, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fixture, commit, hash, inventory, contained, record } from './integrity-fixture.ts'
import type { ContextOutputService } from '../src/types.ts'

async function outcome(service: ContextOutputService, operationId: string, id: string) {
  try { return await service.reconcileResult(operationId, id) }
  catch (cause) { return { kind: 'error' as const, message: cause instanceof Error ? cause.message : String(cause) } }
}

it('cold lookup preserves authentic capturing, staged, refused and committed phases without writes or producer recovery', async () => {
  const f = await fixture('cold-phases')
  let deleted!: (documents: readonly string[]) => Promise<void>
  const { createContextOutputService } = await import('../src/index.ts')
  const refusal = createContextOutputService({ root: resolve(f.root, 'refusal'), workspaceId: 'integrity', documentDeletions: listener => { deleted = listener; return () => {} } })
  try {
    const saved = await commit(f.service, 'committed', Buffer.from('committed original bytes'))
    const capturing = f.service.registerResultScope({ operationId: 'capturing', sessionId: 'owner', callId: 'capturing' }, () => true)
    await f.service.beginResult(capturing, 'text-utf8-v1')
    const staged = f.service.registerResultScope({ operationId: 'staged', sessionId: 'owner', callId: 'staged' }, () => true)
    const sink = await f.service.beginResult(staged, 'text-utf8-v1'); await sink.write(Buffer.from('staged original'))
    const publicationFailure = new Error('fixture native manifest rename cut')
    io.beforeRename = async (_from, to) => { if (to.endsWith('manifest.json')) throw publicationFailure }
    const stagedResult = await sink.finish('complete')
    expect(stagedResult).toEqual({ kind: 'recovery-required', operationId: 'staged', cause: publicationFailure })
    if (stagedResult.kind !== 'recovery-required') throw Error('Original publication failure was lost')
    expect(stagedResult.cause).toBe(publicationFailure); io.stop()
    const refusedScope = refusal.registerResultScope({ operationId: 'refused', sessionId: 'owner', documentId: 'deleted-doc', callId: 'refused' }, () => true)
    const refusedSink = await refusal.beginResult(refusedScope, 'text-utf8-v1'); await refusedSink.write(Buffer.from('refused original'))
    await deleted(['deleted-doc'])
    expect(await refusedSink.finish('complete')).toEqual({ kind: 'refused', reason: 'capture-canceled', observedEncodedBytes: 16 })
    const stagedRefusalScope = refusal.registerResultScope({ operationId: 'staged-refused', sessionId: 'owner', documentId: 'stage-doc', callId: 'staged-refused' }, () => true)
    const stagedRefusalSink = await refusal.beginResult(stagedRefusalScope, 'text-utf8-v1'); await stagedRefusalSink.write(Buffer.from('staged-refusal'))
    const renameEntered = Promise.withResolvers<void>(), releaseRename = Promise.withResolvers<void>()
    io.beforeRename = async (_from, to) => { if (to.endsWith('manifest.json')) { renameEntered.resolve(); await releaseRename.promise } }
    const finishing = stagedRefusalSink.finish('complete')
    let deletion: Promise<void> | undefined
    try {
      await Promise.race([renameEntered.promise, finishing.then(result => {
        throw new Error('Original staged publication ended before its manifest rename gate', { cause: result })
      })])
      // A real host deletion arrives from outside the mutation callback. Its
      // synchronous lifetime fence precedes the paused native publication.
      deletion = deleted(['stage-doc'])
      const deletedOriginal = expect(deletion).resolves.toBeUndefined()
      releaseRename.resolve()
      await expect(finishing).resolves.toEqual({ kind: 'refused', reason: 'capture-canceled', observedEncodedBytes: 14 })
      await deletedOriginal
    } finally { releaseRename.resolve(); await Promise.allSettled([finishing, deletion]) }
    io.stop()
    await refusal.close(); await f.reopen()
    const coldRefusal = createContextOutputService({ root: resolve(f.root, 'refusal'), workspaceId: 'integrity' })
    const refFor = (operationId: string) => ({ id: `ctxv1_${hash(JSON.stringify(['integrity', 'owner', operationId, operationId]))}` })
    const before = await inventory(f.root); io.reset()
    const observed = {
      committed: await outcome(f.service, 'committed', saved.ref.id),
      capturing: await outcome(f.service, 'capturing', refFor('capturing').id),
      staged: await outcome(f.service, 'staged', refFor('staged').id),
      refused: await outcome(coldRefusal, 'refused', refFor('refused').id),
      stagedRefused: await outcome(coldRefusal, 'staged-refused', refFor('staged-refused').id),
    }
    const reads = [...io.reads], opens = [...io.opens]; io.stop()
    expect(observed).toEqual({ committed: { kind: 'committed', ref: saved.ref }, capturing: { kind: 'recovery-required', operationId: 'capturing' }, staged: { kind: 'recovery-required', operationId: 'staged' }, refused: { kind: 'refused', reason: 'capture-canceled', observedEncodedBytes: 16 }, stagedRefused: { kind: 'refused', reason: 'capture-canceled', observedEncodedBytes: 14 } })
    expect(opens.some(path => /[\\/](body|index)$/.test(path))).toBe(false)
    expect(reads.filter(event => event.path.endsWith('operation.json')).length).toBeGreaterThanOrEqual(4)
    expect(await inventory(f.root)).toEqual(before)
    expect(await readdir(f.directory(refFor('capturing')))).not.toContain('manifest.json')
    const refusalDir = resolve(f.root, 'refusal', 'context-output', hash('integrity'), 'managed-v1', refFor('refused').id)
    expect(await readdir(refusalDir)).not.toContain('body')
    const retainedRefusal = JSON.parse(await readFile(resolve(refusalDir, '..', refFor('staged-refused').id, 'operation.json'), 'utf8'))
    expect(retainedRefusal.ref).toBeDefined(); expect(retainedRefusal.manifest).toBeDefined()
    await record(`phases-${f.root.split(/[\\/]/).at(-1)}`, { observed, reads, opens, unchangedInventory: before })
    await coldRefusal.close()
  } finally { io.stop(); await refusal.close(); await f.close() }
})

it('cold commitment rejects inconsistent original metadata and bounded malformed records', async () => {
  const f = await fixture('cold-static')
  try {
    const a = await commit(f.service, 'original-a', Buffer.from('A retained literal'))
    const b = await commit(f.service, 'original-b', Buffer.from('B unrelated literal'))
    await f.reopen()
    const path = resolve(f.directory(a.ref), 'operation.json'), manifestPath = resolve(f.directory(a.ref), 'manifest.json')
    const original = await readFile(path), manifest = await readFile(manifestPath), operation = JSON.parse(original.toString())
    io.reset(); expect(await outcome(f.service, 'original-a', a.ref.id)).toEqual({ kind: 'committed', ref: a.ref })
    expect(io.reads.some(event => event.path === path && event.actual === original.length)).toBe(true)
    expect(contentOpens()).toHaveLength(0); io.stop()
    const rows: [string, unknown][] = [
      ['wrong-operation', { ...operation, owner: { ...operation.owner, operationId: 'foreign' } }],
      ['missing-owner', { ...operation, owner: undefined }], ['missing-ref', { ...operation, ref: undefined }],
      ['operation-version', { ...operation, version: 2 }], ['owner-null', { ...operation, owner: null }],
      ['empty-session', { ...operation, owner: { ...operation.owner, sessionId: '' } }],
      ['invalid-document', { ...operation, owner: { ...operation.owner, documentId: 3 } }],
      ['invalid-source', { ...operation, owner: { ...operation.owner, source: { sourceId: '' } } }],
      ['invalid-ref-version', { ...operation, ref: { ...a.ref, version: 2 } }],
      ['different-ref-id', { ...operation, ref: { ...a.ref, id: b.ref.id } }], ['different-operation-id', { ...operation, id: b.ref.id }],
      ['different-owner-call', { ...operation, owner: { ...operation.owner, callId: 'foreign' } }],
      ['different-codec', { ...operation, codec: 'json-utf8-v1' }], ['different-count', { ...operation, encodedBytes: 900 }],
      ['different-ref-revision', { ...operation, ref: { ...a.ref, revision: '0'.repeat(64) } }],
      ['different-ref-codec', { ...operation, ref: { ...a.ref, codec: 'json-utf8-v1' } }],
      ['different-ref-count', { ...operation, ref: { ...a.ref, encodedBytes: 19 } }],
      ['different-ref-digest', { ...operation, ref: { ...a.ref, contentDigest: '0'.repeat(64) } }],
      ['different-ref-completeness', { ...operation, ref: { ...a.ref, completeness: 'source-limited' } }],
      ['missing-embedded-manifest', { ...operation, manifest: undefined }],
      ['different-embedded-manifest', { ...operation, manifest: { ...operation.manifest, treeRoot: '0'.repeat(64) } }],
      ['unsafe-count', { ...operation, encodedBytes: Number.MAX_SAFE_INTEGER + 1 }],
      ['fractional-count', { ...operation, encodedBytes: 1.5 }], ['negative-count', { ...operation, encodedBytes: -1 }],
      ['invalid-phase', { ...operation, phase: 'almost-committed' }],
    ]
    const observed: Record<string, unknown> = {}
    for (const [name, value] of rows) {
      await writeFile(path, JSON.stringify(value)); const before = await inventory(f.root); io.reset()
      const actual = await outcome(f.service, 'original-a', a.ref.id); observed[name] = { actual, opens: [...io.opens], reads: [...io.reads] }; io.stop()
      expect.soft(actual.kind, name).not.toBe('committed'); expect.soft(await inventory(f.root), `${name}: no repair`).toEqual(before)
    }
    await writeFile(path, original)
    // Missing body/index does not change a valid cold metadata receipt; a page still refuses.
    const bodyPath = resolve(f.directory(a.ref), 'body'), indexPath = resolve(f.directory(a.ref), 'index')
    await rename(bodyPath, bodyPath + '.held'); await rename(indexPath, indexPath + '.held')
    io.reset(); expect(await outcome(f.service, 'original-a', a.ref.id)).toEqual({ kind: 'committed', ref: a.ref }); expect(contentOpens()).toHaveLength(0); io.stop()
    await expect(f.service.readResult({ sessionId: 'owner' }, { ref: a.ref })).rejects.toThrow()
    await rename(bodyPath + '.held', bodyPath); await rename(indexPath + '.held', indexPath)
    for (const [name, data] of [['truncated', '{'], ['oversize', ' '.repeat(65537)]] as const) {
      await writeFile(path, data); io.reset(); const actual = await outcome(f.service, 'original-a', a.ref.id)
      observed[name] = { actual, reads: [...io.reads] }; expect.soft(actual.kind, name).toBe('error')
      if (name === 'oversize') expect.soft(io.reads).toHaveLength(0)
      io.stop()
    }
    await writeFile(path, original)
    for (const [name, data] of [['missing-disk-manifest', undefined], ['damaged-disk-manifest', '{}']] as const) {
      if (data === undefined) await rm(manifestPath); else await writeFile(manifestPath, data)
      io.reset(); const actual = await outcome(f.service, 'original-a', a.ref.id); observed[name] = { actual, reads: [...io.reads] }; io.stop()
      expect.soft(actual.kind, name).not.toBe('committed'); await writeFile(manifestPath, manifest)
    }
    await record(`cold-static-${f.root.split(/[\\/]/).at(-1)}`, observed)
  } finally { io.stop(); await f.close() }
})

for (const component of ['directory', 'operation.json', 'manifest.json'] as const) {
it(`cold lookup never opens metadata through a fixture ${component} link outside its managed owner`, async context => {
  const f = await fixture('cold-junction')
  try {
    const a = await commit(f.service, 'original', Buffer.from('original A'))
    await f.reopen(); io.reset(); expect(await outcome(f.service, 'original', a.ref.id)).toEqual({ kind: 'committed', ref: a.ref })
    expect(io.reads.filter(event => event.path.endsWith('operation.json')).length).toBeGreaterThan(0); io.stop()
    const target = component === 'directory' ? f.directory(a.ref) : resolve(f.directory(a.ref), component), sibling = resolve(f.root, 'outside-managed-owner')
    await contained(f.root, target); await contained(f.root, sibling)
    await rename(target, sibling)
    try { await symlink(sibling, target, component === 'directory' ? 'junction' : 'file') }
    catch (cause) {
      if (process.platform === 'win32' && component !== 'directory' && (cause as NodeJS.ErrnoException).code === 'EPERM')
        context.skip('Windows file symlink privilege is unavailable, confirmed by the actual fixture link creation')
      throw cause
    }
    const before = await inventory(f.root); io.reset()
    const actual = await outcome(f.service, 'original', a.ref.id), opens = [...io.opens], reads = [...io.reads]; io.stop()
    await record(`cold-junction-${f.root.split(/[\\/]/).at(-1)}`, { component, actual, opens, reads, foreignMetadataDigest: hash(await readFile(component === 'directory' ? resolve(sibling, 'operation.json') : sibling)) })
    const linkedFile = component === 'directory' ? resolve(target, 'operation.json') : target
    expect.soft(actual.kind).not.toBe('committed'); expect.soft(opens.filter(path => path === linkedFile)).toHaveLength(0)
    expect(await inventory(f.root)).toEqual(before)
  } finally { io.stop(); await f.close() }
})
}

it('cold lookup returns only the operation observation whose original identity was validated', async () => {
  const f = await fixture('cold-two-read')
  try {
    const a = await commit(f.service, 'original-a', Buffer.from('original A'))
    const b = await commit(f.service, 'unrelated-b', Buffer.from('foreign B'))
    await f.reopen()
    const path = resolve(f.directory(a.ref), 'operation.json'), original = await readFile(path), replacement = await readFile(resolve(f.directory(b.ref), 'operation.json'))
    io.reset(); expect(await outcome(f.service, 'original-a', a.ref.id)).toEqual({ kind: 'committed', ref: a.ref })
    const calibratedReads = [...io.reads].filter(event => event.path === path); expect(calibratedReads.length).toBeGreaterThan(0)
    io.reset(); let replaced = false
    io.afterRead = async event => { if (!replaced && event.path === path) { replaced = true; await writeFile(path, replacement) } }
    const actual = await outcome(f.service, 'original-a', a.ref.id), reads = [...io.reads], opens = [...io.opens]; io.stop()
    expect(replaced).toBe(true)
    await record(`cold-observations-${f.root.split(/[\\/]/).at(-1)}`, { calibratedReads, actual, a: a.ref, b: b.ref, firstDigest: hash(original), replacementDigest: hash(replacement), reads, opens })
    expect.soft(actual.kind === 'committed' ? actual.ref : undefined).not.toEqual(b.ref)
    if (actual.kind === 'committed') expect.soft(actual.ref).toEqual(a.ref)
    expect(await readFile(path)).toEqual(replacement)
  } finally { io.stop(); await f.close() }
})
