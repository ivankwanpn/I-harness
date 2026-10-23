import { expect, it, vi, afterEach } from 'vitest'
const cuts = vi.hoisted(() => ({ afterRead: undefined as undefined | ((path: string) => Promise<void>), afterLink: undefined as undefined | ((path: string) => Promise<void>) }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args), read = handle.read.bind(handle)
      handle.read = (async (...readArgs: [Buffer, number, number, number]) => { const result = await read(...readArgs); await cuts.afterRead?.(String(args[0])); return result }) as typeof handle.read
      return handle
    },
    link: async (...args: Parameters<typeof fs.link>) => { await fs.link(...args); await cuts.afterLink?.(String(args[1])) },
  }
})
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { ManagedArtifactRef, ResultDependency } from '@i-harness/core-session'
import type { ContextOutputService } from '../src/types.ts'

const evidence = resolve(import.meta.dirname, '../../../.tmp/context-parallel-artifact-20261023/settlement')
await mkdir(evidence, { recursive: true }); process.env.IH_CONFIG_DIR = resolve(evidence, 'config')
const { createContextOutputService } = await import('../src/index.ts')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

afterEach(() => { cuts.afterRead = undefined; cuts.afterLink = undefined })
async function fixture(body?: (entries: ResultDependency[]) => string, transform?: (entries: ResultDependency[], service: ContextOutputService) => ResultDependency[] | Promise<ResultDependency[]>) {
  const root = await mkdtemp(resolve(evidence, 'original-'))
  const service = createContextOutputService({ root, workspaceId: 'foundations', authorizeResult: () => true })
  const owner = { operationId: 'member', sessionId: 'original', callId: 'member' }
  const memberScope = service.registerResultScope(owner, () => true)
  const sink = await service.beginResult(memberScope, 'exec-frames-v1')
  await sink.write(Buffer.from('IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eA=="}\n'))
  const member = await sink.finish('complete'); if (member.kind !== 'committed') throw new Error('Member fixture refused')
  let entries: ResultDependency[] = ['first', 'second'].map(sourceId => ({ kind: 'exec-frames', sourceId, retention: { kind: 'artifact', ref: member.ref } }))
  if (transform) entries = await transform(entries, service)
  const scope = service.registerResultDependencyScope({ operationId: 'catalog', sessionId: 'original', callId: 'catalog' }, () => true, entries)
  const catalogSink = await service.beginResult(scope, 'json-utf8-v1')
  await catalogSink.write(Buffer.from(body ? body(entries) : JSON.stringify({ version: 1, kind: 'result-dependencies', entries })))
  const catalog = await catalogSink.finish('complete'); if (catalog.kind !== 'committed') throw new Error('Catalog fixture refused')
  const managed = resolve(root, 'context-output', hash('foundations'), 'managed-v1')
  return { root, service, scope, member: member.ref, catalog: catalog.ref, managed, entries }
}

it('settles repeated identical member refs with the first ordinal and preserves every original catalog observation', async () => {
  const f = await fixture()
  try {
    const original = await Promise.all([f.catalog, f.member].flatMap(ref => ['operation.json', 'body'].map(name => readFile(resolve(f.managed, ref.id, name)))))
    expect(await f.service.settleResultDependencyMembership(f.scope, f.catalog)).toBe('ready')
    expect(await f.service.settleResultDependencyMembership(f.scope, f.catalog)).toBe('ready')
    const folder = resolve(f.managed, f.member.id, 'pin-memberships', hash('original'))
    const names = await readdir(folder)
    expect(names).toHaveLength(1)
    expect(JSON.parse(await readFile(resolve(folder, names[0]!), 'utf8'))).toMatchObject({ sourceId: 'first', ordinal: 0 })
    expect(await f.service.readExecResult({ sessionId: 'original' }, { ref: f.member, viaCatalog: f.catalog })).toMatchObject({ frames: [{ data: 'eA==' }] })
    expect(await Promise.all([f.catalog, f.member].flatMap(ref => ['operation.json', 'body'].map(name => readFile(resolve(f.managed, ref.id, name)))))).toEqual(original)
  } finally { await f.service.close() }
})

it('continues the same first canonical companion after a real publication response loss without losing unavailable observations', async () => {
  const f = await fixture(undefined, entries => [entries[0]!, { kind: 'exec-frames', sourceId: 'missing', retention: { kind: 'unavailable', reason: 'capture-canceled', observedEncodedBytes: 123 } }, entries[1]!])
  let path = ''
  cuts.afterLink = async published => { if (published.includes('pin-memberships')) { path = published; throw new Error('real publication acknowledgement lost') } }
  try {
    const body = await readFile(resolve(f.managed, f.catalog.id, 'body'))
    expect(await f.service.settleResultDependencyMembership(f.scope, f.catalog)).toBe('recovery-required')
    const first = await readFile(path)
    expect(JSON.parse(first.toString())).toMatchObject({ ordinal: 0, sourceId: 'first' })
    cuts.afterLink = undefined
    expect(await f.service.settleResultDependencyMembership(f.scope, f.catalog)).toBe('ready')
    expect(await readFile(path)).toEqual(first)
    expect(await readFile(resolve(f.managed, f.catalog.id, 'body'))).toEqual(body)
    expect(JSON.parse(body.toString()).entries).toHaveLength(3)
  } finally { cuts.afterLink = undefined; await f.service.close() }
})

it('keeps distinct member witnesses at their actual ordinals in a mixed A/unavailable/B/A catalog', async () => {
  let second!: ManagedArtifactRef
  const f = await fixture(undefined, async (entries, service) => {
    const scope = service.registerResultScope({ operationId: 'second-member', sessionId: 'original', callId: 'second-member' }, () => true), sink = await service.beginResult(scope, 'exec-frames-v1')
    await sink.write(Buffer.from('IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eQ=="}\n'))
    const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Second member fixture refused')
    second = saved.ref
    return [entries[0]!, { kind: 'exec-frames', sourceId: 'unavailable', retention: { kind: 'unavailable', reason: 'quota' } }, { kind: 'exec-frames', sourceId: 'distinct', retention: { kind: 'artifact', ref: second } }, entries[1]!]
  })
  try {
    expect(await f.service.settleResultDependencyMembership(f.scope, f.catalog)).toBe('ready')
    for (const [member, ordinal, sourceId] of [[f.member, 0, 'first'], [second, 2, 'distinct']] as const) {
      const folder = resolve(f.managed, member.id, 'pin-memberships', hash('original')), names = await readdir(folder)
      expect(names).toHaveLength(1)
      expect(JSON.parse(await readFile(resolve(folder, names[0]!), 'utf8'))).toMatchObject({ ordinal, sourceId })
    }
    expect(await f.service.readExecResult({ sessionId: 'original' }, { ref: second, viaCatalog: f.catalog })).toMatchObject({ frames: [{ data: 'eQ==' }] })
    expect(JSON.parse(await readFile(resolve(f.managed, f.catalog.id, 'body'), 'utf8')).entries.map((e: ResultDependency) => e.sourceId)).toEqual(['first', 'unavailable', 'distinct', 'second'])
  } finally { await f.service.close() }
})

it('checks a later identical alias against its physical original pin before publishing a canonical companion', async () => {
  const f = await fixture(), pin = resolve(f.managed, f.member.id, 'pins', hash('original') + '.json')
  let memberReads = 0
  cuts.afterRead = async path => {
    if (path === resolve(f.managed, f.member.id, 'operation.json') && ++memberReads === 2) await rm(pin)
  }
  try {
    expect(await f.service.settleResultDependencyMembership(f.scope, f.catalog)).toBe('recovery-required')
    expect(memberReads).toBe(2)
    await expect(readdir(resolve(f.managed, f.member.id, 'pin-memberships'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { cuts.afterRead = undefined; await f.service.close() }
})

it('refuses a conflicting later alias or noncanonical existing witness without modifying immutable bytes', async () => {
  const f = await fixture(undefined, entries => [entries[0]!, { ...entries[1]!, retention: { kind: 'artifact', ref: { ...(entries[1]!.retention as { kind: 'artifact'; ref: ManagedArtifactRef }).ref, contentDigest: 'f'.repeat(64) } } }])
  try {
    expect(await f.service.settleResultDependencyMembership(f.scope, f.catalog)).toBe('recovery-required')
    await expect(readdir(resolve(f.managed, f.member.id, 'pin-memberships'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.service.close() }
  const valid = await fixture()
  try {
    expect(await valid.service.settleResultDependencyMembership(valid.scope, valid.catalog)).toBe('ready')
    const folder = resolve(valid.managed, valid.member.id, 'pin-memberships', hash('original')), names = await readdir(folder), path = resolve(folder, names.find(name => name.endsWith('.json'))!)
    const record = JSON.parse(await readFile(path, 'utf8')), noncanonical = JSON.stringify({ ...record, ordinal: 1, sourceId: 'second' })
    await writeFile(path, noncanonical)
    expect(await valid.service.settleResultDependencyMembership(valid.scope, valid.catalog)).toBe('recovery-required')
    expect(await readFile(path, 'utf8')).toBe(noncanonical)
  } finally { await valid.service.close() }
})

it('refuses a committed catalog whose actual entries disagree with the captured registration before publishing companions', async () => {
  const f = await fixture(entries => JSON.stringify({ version: 1, kind: 'result-dependencies', entries: [{ ...entries[0], sourceId: 'foreign' }, entries[1]] }))
  try {
    expect(await f.service.settleResultDependencyMembership(f.scope, f.catalog)).toBe('recovery-required')
    await expect(readdir(resolve(f.managed, f.member.id, 'pin-memberships'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.service.close() }
})

it('refuses non-enumerable registration metadata instead of dropping it during capture', async () => {
  const f = await fixture()
  try {
    const hidden = Object.defineProperty({ kind: 'exec-frames', sourceId: 'hidden', retention: { kind: 'unavailable', reason: 'quota' } }, 'foreign', { value: true })
    expect(() => f.service.registerResultDependencyScope({ operationId: 'hidden', sessionId: 'original', callId: 'hidden' }, () => true, [hidden as ResultDependency])).toThrow()
  } finally { await f.service.close() }
})
