import { expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { ResultDependency } from '@i-harness/core-session'
const evidence = resolve(import.meta.dirname, '../../../.tmp/context-r4a-native-dependencies-20261021-implementation')
await mkdir(evidence, { recursive: true }); process.env.IH_CONFIG_DIR = resolve(evidence, 'config')
const { createContextOutputService, createContextOutputTools } = await import('../src/index.ts')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

// Storage-owner seam only. The separate session-executor test proves genuine
// native registration, live ancestry and shipping closed-fact policy.
it('keeps genuine catalog scopes immutable and refuses missing, corrupt, unrelated and unpinned witnesses', async () => {
  const root = await mkdtemp(resolve(evidence, 'membership-owner-'))
  const visible = new Set<string>(), captured = 'original-captured-source'
  let deleted!: (documents: readonly string[]) => Promise<void>
  const service = createContextOutputService({ root, workspaceId: 'owner-seam', documentDeletions: listener => { deleted = listener; return () => {} }, authorizeResult: (access, metadata) => metadata.owner.source?.sourceId === captured
    && (metadata.visibleVia ? visible.has(metadata.visibleVia.id) : access.sessionId === metadata.owner.sessionId) })
  try {
    const frameScope = service.registerResultScope({ operationId: 'frame-op', sessionId: 'origin', callId: 'native', source: { sourceId: captured } }, () => true)
    const frameSink = await service.beginResult(frameScope, 'exec-frames-v1')
    await frameSink.write(Buffer.from('IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eA=="}\n'))
    const frame = await frameSink.finish('complete'); if (frame.kind !== 'committed') throw new Error('Original frame fixture refused')
    await service.grant({ sessionId: 'origin' }, [frame.ref.id], 'target')
    const entries: ResultDependency[] = [{ kind: 'exec-frames', sourceId: 'native-source-identity', retention: { kind: 'artifact', ref: frame.ref } }]
    const originalCatalogBody = JSON.stringify({ version: 1, kind: 'result-dependencies', entries })
    let current = true
    const callerOwner = { operationId: 'catalog-op', sessionId: 'target', callId: 'observe', source: { sourceId: captured } }
    const scope = service.registerResultDependencyScope(callerOwner, () => current, entries)
    callerOwner.sessionId = 'caller-mutated'; callerOwner.source.sourceId = 'caller-mutated-source'; entries[0]!.sourceId = 'caller-mutated-native'
    const sink = await service.beginResult(scope, 'json-utf8-v1')
    await sink.write(Buffer.from(originalCatalogBody))
    const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Original catalog fixture refused')
    expect(await service.settleResultDependencyMembership({ operationId: scope.operationId }, saved.ref)).toBe('recovery-required')
    const base = resolve(root, 'context-output', sha('owner-seam'), 'managed-v1'), frameDir = resolve(base, frame.ref.id)
    const pin = resolve(frameDir, 'pins', sha('target') + '.json')
    await rename(pin, pin + '.held')
    expect(await service.settleResultDependencyMembership(scope, saved.ref)).toBe('recovery-required')
    await expect(readFile(pin)).rejects.toMatchObject({ code: 'ENOENT' })
    await rename(pin + '.held', pin)
    expect(await service.settleResultDependencyMembership(scope, saved.ref)).toBe('ready')
    const path = resolve(frameDir, 'pin-memberships', sha('target'), sha(JSON.stringify([saved.ref.id, saved.ref.revision])) + '.json')
    const original = await readFile(path, 'utf8'), record = JSON.parse(original)
    expect(record).toMatchObject({ documentId: 'target', sessionId: 'target', catalogOperationId: 'catalog-op', sourceId: 'native-source-identity', ordinal: 0 })
    expect(Buffer.byteLength(original)).toBeLessThanOrEqual(8192)
    visible.add(saved.ref.id)
    const tool = createContextOutputTools(service).find(tool => tool.name === 'context_output_read')!
    expect(await tool.execute({ refId: 'legacy-ref', viaCatalog: saved.ref }, { sessionId: 'target' })).toEqual({ kind: 'unavailable', reason: 'range' })
    expect(await service.readExecResult({ sessionId: 'target' }, { ref: frame.ref, viaCatalog: saved.ref })).toMatchObject({ frames: [{ data: 'eA==' }] })
    await expect(service.readExecResult({ sessionId: 'target' }, { ref: frame.ref })).rejects.toThrow(/unauthorized/)
    await expect(service.readResult({ sessionId: 'target' }, { ref: saved.ref, viaCatalog: saved.ref })).rejects.toThrow()
    for (const corrupted of [
      { ...record, extra: true }, { ...record, ordinal: -1 }, { ...record, catalogOperationId: 'wrong-original-operation' },
      { ...record, memberRef: { ...frame.ref, contentDigest: '0'.repeat(64) } }, { ...record, catalogRef: { ...saved.ref, completeness: 'source-limited' } },
      { ...record, sourceId: 'x'.repeat(9000) },
    ]) {
      await writeFile(path, JSON.stringify(corrupted))
      await expect(service.readExecResult({ sessionId: 'target' }, { ref: frame.ref, viaCatalog: saved.ref })).rejects.toThrow()
      await expect(service.readResult({ sessionId: 'target' }, { ref: frame.ref, viaCatalog: saved.ref })).rejects.toThrow()
    }
    await rm(path)
    await expect(service.readExecResult({ sessionId: 'target' }, { ref: frame.ref, viaCatalog: saved.ref })).rejects.toThrow()
    await writeFile(path, original)
    const unrelatedScope = service.registerResultScope({ operationId: 'unrelated-json', sessionId: 'target', callId: 'data', source: { sourceId: captured } }, () => true)
    const unrelatedSink = await service.beginResult(unrelatedScope, 'json-utf8-v1'); await unrelatedSink.write(Buffer.from(JSON.stringify({ ref: frame.ref, entries: [frame.ref] })))
    const unrelated = await unrelatedSink.finish('complete'); if (unrelated.kind !== 'committed') throw new Error('Unrelated JSON fixture refused')
    visible.add(unrelated.ref.id)
    await expect(service.readExecResult({ sessionId: 'target' }, { ref: frame.ref, viaCatalog: unrelated.ref })).rejects.toThrow()
    visible.delete(saved.ref.id)
    await expect(service.readExecResult({ sessionId: 'target' }, { ref: frame.ref, viaCatalog: saved.ref })).rejects.toThrow(/unauthorized/)
    visible.add(saved.ref.id)
    const catalogPin = resolve(base, saved.ref.id, 'pins', sha('target') + '.json')
    await rename(catalogPin, catalogPin + '.held')
    await expect(service.readExecResult({ sessionId: 'target' }, { ref: frame.ref, viaCatalog: saved.ref })).rejects.toThrow()
    await rename(catalogPin + '.held', catalogPin)
    await service.grant({ sessionId: 'origin' }, [frame.ref.id], 'other-target')
    const otherEntries: ResultDependency[] = [{ kind: 'exec-frames', sourceId: 'native-source-identity', retention: { kind: 'artifact', ref: frame.ref } }]
    const otherScope = service.registerResultDependencyScope({ operationId: 'other-catalog-op', sessionId: 'other-target', callId: 'other-observe', source: { sourceId: captured } }, () => true, otherEntries)
    const otherSink = await service.beginResult(otherScope, 'json-utf8-v1')
    await otherSink.write(Buffer.from(JSON.stringify({ version: 1, kind: 'result-dependencies', entries: otherEntries })))
    const other = await otherSink.finish('complete'); if (other.kind !== 'committed') throw new Error('Other original target fixture refused')
    expect(await service.settleResultDependencyMembership(otherScope, other.ref)).toBe('ready')
    visible.add(other.ref.id)
    const otherPath = resolve(frameDir, 'pin-memberships', sha('other-target'), sha(JSON.stringify([other.ref.id, other.ref.revision])) + '.json')
    const otherBefore = await readFile(otherPath)
    await deleted(['target'])
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(otherPath)).toEqual(otherBefore)
    expect(await service.readExecResult({ sessionId: 'other-target' }, { ref: frame.ref, viaCatalog: other.ref })).toMatchObject({ frames: [{ data: 'eA==' }] })
    current = false
    expect(await service.settleResultDependencyMembership(scope, saved.ref)).toBe('recovery-required')
    await writeFile(resolve(root, 'owner-seam-receipt.json'), JSON.stringify({ frame: frame.ref, catalog: saved.ref, originalRecord: record, originalOwnerCloned: true, originalEntriesCloned: true, missingPinDidNotGrant: true, monotonicOriginalScopeRevoked: true }, null, 2))
  } finally { await service.close() }
}, 30000)
