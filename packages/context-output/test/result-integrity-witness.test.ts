import { expect, it, vi } from 'vitest'
import { io, observeOpen, contentReads, contentOpens } from './integrity-io.ts'
vi.mock('node:fs/promises', async original => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, open: observeOpen(fs.open) } })
import { readFile, writeFile, rename, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ManagedArtifactRef, ResultDependency } from '@i-harness/core-session'
import { fixture, commit, hash, inventory, contained, record } from './integrity-fixture.ts'

async function witnessFixture() {
  const policies: { id: string; via?: string }[] = []
  let deleted!: (documents: readonly string[]) => Promise<void>
  const f = await fixture('witness-integrity', { authorizeResult: (_access, metadata) => { policies.push({ id: metadata.ref.id, via: metadata.visibleVia?.id }); return true }, documentDeletions: listener => { deleted = listener; return () => {} } })
  const frame = await commit(f.service, 'frame-original', Buffer.from('IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eA=="}\n'), 'exec-frames-v1', 'origin')
  await f.service.grant({ sessionId: 'origin' }, [frame.ref.id], 'target')
  const catalog = async (operationId: string) => {
    const entries: ResultDependency[] = [{ kind: 'exec-frames', sourceId: 'native-registration', retention: { kind: 'artifact', ref: frame.ref } }]
    const scope = f.service.registerResultDependencyScope({ operationId, sessionId: 'target', callId: operationId }, () => true, entries)
    const sink = await f.service.beginResult(scope, 'json-utf8-v1'); await sink.write(Buffer.from(JSON.stringify({ version: 1, kind: 'result-dependencies', entries })))
    const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Authentic catalog refused')
    expect(await f.service.settleResultDependencyMembership(scope, saved.ref)).toBe('ready'); return saved.ref
  }
  const c1 = await catalog('catalog1'), c2 = await catalog('catalog2')
  await f.reopen()
  const pathFor = (ref: ManagedArtifactRef) => resolve(f.directory(frame.ref), 'pin-memberships', hash('target'), hash(JSON.stringify([ref.id, ref.revision])) + '.json')
  const read = () => f.service.readExecResult({ sessionId: 'target' }, { ref: frame.ref, viaCatalog: c1, maxBytes: 900 })
  return { ...f, frame: frame.ref, c1, c2, path: pathFor(c1), otherPath: pathFor(c2), policies, read, deleted: (documents: readonly string[]) => deleted(documents) }
}

it('calibrates selected companion metadata, both policies and zero catalog body scans; malformed/cross-key witnesses deny before frame I/O', async () => {
  const f = await witnessFixture()
  try {
    const original = await readFile(f.path), companion = JSON.parse(original.toString()), other = await readFile(f.otherPath)
    f.policies.length = 0; io.reset(); expect(await f.read()).toMatchObject({ frames: [{ data: 'eA==' }], eof: true })
    expect(f.policies).toEqual([{ id: f.c1.id }, { id: f.frame.id, via: f.c1.id }, { id: f.c1.id }, { id: f.frame.id, via: f.c1.id }])
    expect(io.opens.filter(path => path === f.path)).toHaveLength(2)
    expect(io.reads.filter(event => event.path === f.path).map(event => event.actual)).toEqual([original.length, original.length])
    expect(contentOpens().every(path => path.startsWith(f.directory(f.frame)))).toBe(true)
    expect(contentReads().filter(event => event.path.endsWith('body')).length).toBe(3)
    const positive = { reads: [...io.reads], opens: [...io.opens], policies: [...f.policies] }; io.stop()
    const cases: [string, string][] = [
      ['truncated', original.subarray(0, -2).toString()], ['malformed', '{'], ['over8192', ' '.repeat(8193)],
      ...Object.entries({ version: 2, kind: 'other', workspaceId: 'foreign', documentId: 'foreign', sessionId: 'foreign', ordinal: 0.5 }).map(([key, value]): [string, string] => [key, JSON.stringify({ ...companion, [key]: value })]),
      ['unsafe-ordinal', JSON.stringify({ ...companion, ordinal: Number.MAX_SAFE_INTEGER + 1 })], ['cross-key-record', other.toString()],
    ]
    const observed: unknown[] = []
    for (const [name, bytes] of cases) {
      await writeFile(f.path, bytes); const before = await inventory(f.root); io.reset()
      let actual: unknown; try { actual = await f.read() } catch (cause) { actual = { refused: true, message: (cause as Error).message } }
      expect.soft(actual, name).toMatchObject({ refused: true }); expect.soft(contentOpens(), name).toHaveLength(0)
      if (name === 'over8192') expect.soft(io.reads.filter(event => event.path === f.path)).toHaveLength(0)
      observed.push({ name, actual, reads: [...io.reads], opens: [...io.opens] }); io.stop()
      expect.soft(await inventory(f.root), `${name}: no repair`).toEqual(before)
    }
    await writeFile(f.path, original)
    const body = resolve(f.directory(f.frame), 'body'), bytes = await readFile(body); bytes[9] = 91; await writeFile(body, bytes)
    await expect(f.read()).rejects.toThrow(/corrupt/)
    await record(`witness-${f.root.split(/[\\/]/).at(-1)}`, { positive, observed })
  } finally { io.stop(); await f.close() }
})

for (const component of ['file', 'document', 'memberships'] as const) {
it(`rejects fixture companion ${component} links before content and preserves foreign bytes`, async context => {
  const f = await witnessFixture()
  try {
    io.reset(); expect(await f.read()).toMatchObject({ frames: [{ data: 'eA==' }] }); expect(contentReads().length).toBeGreaterThan(0); io.stop()
    const path = component === 'file' ? f.path : component === 'document' ? resolve(f.path, '..') : resolve(f.path, '../..')
    const sibling = resolve(f.root, 'outside-companion')
    await contained(f.root, path); await contained(f.root, sibling); await rename(path, sibling)
    try { await symlink(sibling, path, component === 'file' ? 'file' : 'junction') }
    catch (cause) {
      if (process.platform === 'win32' && component === 'file' && (cause as NodeJS.ErrnoException).code === 'EPERM')
        context.skip('Windows file symlink privilege is unavailable, confirmed by the actual fixture link creation')
      throw cause
    }
    const before = await inventory(f.root); io.reset()
    await expect(f.read()).rejects.toThrow(/path/); expect(contentOpens()).toHaveLength(0); io.stop()
    expect(await inventory(f.root)).toEqual(before)
    if (component === 'document') {
      const foreignBefore = await inventory(sibling)
      // Original trusted store lifecycle callback, separately labeled from full Gateway deletion.
      await expect(f.deleted(['target'])).rejects.toThrow(/path/)
      expect(await inventory(sibling)).toEqual(foreignBefore)
    }
  } finally { io.stop(); await f.close() }
})
}

it('discards verified frame page when its selected companion changes after actual body I/O without repairing it', async () => {
  const f = await witnessFixture()
  try {
    const bytes = await readFile(f.path), original = JSON.parse(bytes.toString()); io.reset()
    expect(await f.read()).toMatchObject({ frames: [{ data: 'eA==' }] }); expect(contentReads().length).toBeGreaterThan(0)
    io.reset(); let changed = false
    io.afterRead = async event => { if (!changed && event.path === resolve(f.directory(f.frame), 'body')) { changed = true; await writeFile(f.path, JSON.stringify({ ...original, ordinal: -1 })) } }
    await expect(f.read()).rejects.toThrow(/corrupt/)
    expect(changed).toBe(true); expect(contentReads().some(event => event.actual > 0)).toBe(true)
    const observed = { reads: [...io.reads], opens: [...io.opens] }; io.stop()
    expect(JSON.parse(await readFile(f.path, 'utf8')).ordinal).toBe(-1)
    await record(`witness-changed-${f.root.split(/[\\/]/).at(-1)}`, observed)
  } finally { io.stop(); await f.close() }
})
