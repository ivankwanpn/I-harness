import { expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalJsonData, encodeFactBatch, legacyPrefixDigest, readFactJournal } from '@i-harness/core-session'
import { createSessionCoordinator, compileSemanticSeed, createBootstrapRequestIntent, readForkRequestCore, type BootstrapRequest, type HeldFactOwner } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'
import { serializeHeader } from '../src/format.ts'
import { codecSeed, codecWire, codecRow, codecPage } from '../../core-session/test/fixtures/selected-results.ts'
import { compileSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { upgradeFactJournal } from '../src/backend/format-upgrade.ts'
import { pair } from '../../session-persistence/test/child-bootstrap-fixture.ts'

const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('No dependencies expected') }, async reconcile() { throw Error('No dependencies expected') } } }
const invocation = { version: 1 as const, operationId: 'deny', targetSessionId: 'target', createdAt: '2026-10-28T00:00:00.000Z', requestDigest: 'a'.repeat(64) }
function fixture(pages = false) {
  const exported = codecSeed('public-completed', pages ? [codecPage([codecRow()])] : []), wire = codecWire(exported)
  const journal = { version: 1, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 }
  const meta: any = { formatVersion: 13, sessionId: 'target', createdAt: invocation.createdAt, origin: 'fork', parentSession: 'source', ...wire.header, journal }
  const seed = encodeFactBatch('bootstrap:codec:seed', journal.legacyPrefixDigest, wire.records)
  const seedPrefix = JSON.parse(Buffer.from(seed.bytes).toString()).prefixDigest
  const completion = encodeFactBatch('bootstrap:codec:complete', seedPrefix, wire.events.slice(wire.records.length))
  const body = Buffer.concat([Buffer.from(seed.bytes), Buffer.from(completion.bytes)])
  return { exported, meta, body, raw: Buffer.concat([Buffer.from(canonicalJsonData(meta) + '\n'), body]) }
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

it.each([12, 13])('denies the direct old format upgrade leaf for V3 format%s without acknowledgment or byte changes', async formatVersion => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'v3-upgrade-')), path = join(root, 'target.jsonl'), f = fixture()
  const raw = Buffer.concat([Buffer.from(canonicalJsonData({ ...f.meta, formatVersion }) + '\n'), f.body])
  await writeFile(path, raw)
  await expect(upgradeFactJournal(path, formatVersion)).rejects.toThrow('Legacy upgrade')
  expect(await readFile(path)).toEqual(raw)
})

it('does not execute a supplied semanticSeed accessor while denying old create/serializer admission', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'v3-accessor-')), backend = createJsonlBackend(join(root, 'absent'))
  let reads = 0
  const meta: any = Object.defineProperty({}, 'semanticSeed', { enumerable: true, get() { reads++; throw Error('accessor executed') } })
  expect(() => serializeHeader(meta)).toThrow()
  await expect(backend.create('target', meta)).rejects.toThrow()
  expect(reads).toBe(0); expect(await readdir(root)).toEqual([])
})

it.each([false, true])('denies actual create/serializer and ordinary mutation leaves without target mutation (pages=%s)', async pages => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'v3-denials-')), backend = createJsonlBackend(join(root, 'absent')), f = fixture(pages)
  expect(readFactJournal(f.body, f.meta.journal, 13, f.meta).events.length).toBe(f.meta.seedLength + 1)
  expect(() => serializeHeader(f.meta)).toThrow('Legacy header writer')
  await expect(backend.create('target', f.meta)).rejects.toThrow('Legacy create')
  expect(await readdir(root)).toEqual([])
  const existing = createJsonlBackend(root), path = join(root, 'target.jsonl')
  await writeFile(path, f.raw)
  const attempts: [string, () => Promise<unknown>][] = [ ['append', () => existing.append('target', [{ type: 'plan/mode', mode: 'on' }])],
    ['replace', () => existing.replaceEvents!('target', [])], ['repair', () => existing.repair!('target')],
    ['metadata', () => existing.updateMeta!('target', { title: 'changed' })], ['upgrade', () => existing.upgradeSessionFormat!('target', 13, 13)] ]
  const reached: string[] = []
  for (const [name, run] of attempts) { await expect(run()).rejects.toThrow(); reached.push(name); expect(await readFile(path)).toEqual(f.raw) }
  console.log(JSON.stringify({ control: 'Task2 current old-family ordinary denial', root, pages, reached, before: sha(f.raw), after: sha(await readFile(path)) }))
})

it.each([false, true])('denies real held-owner prefix truncation and frame acknowledgment while preserving torn bytes (pages=%s)', async pages => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'v3-held-denials-')), backend = createJsonlBackend(root)
  let held: HeldFactOwner | undefined
  const append = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { held = args[1]; return append(...args) }
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  try {
    const request: BootstrapRequest = { invocation, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork', parentSession: 'source' }, seed: compileSemanticSeed({ kind: 'none' }) }
    expect((await coordinator.bootstrapSemanticTarget(request, guards)).kind).toBe('ready')
    if (!held) throw Error('Actual held backend owner required')
    const f = fixture(pages), path = join(root, 'target.jsonl'), torn = Buffer.concat([f.raw, Buffer.from('{"recordKind":')])
    await writeFile(path, torn)
    await expect(backend.readJournalPrefix!('target', held)).rejects.toThrow('Legacy owned prefix')
    expect(await readFile(path)).toEqual(torn)
    expect(await backend.confirmBootstrapFrames!('target', held, [])).toEqual({ kind: 'unknown' })
    expect(await readFile(path)).toEqual(torn)
    // A complete valid V3 fixture must still never receive an old ACK.
    await writeFile(path, f.raw)
    expect(await backend.confirmBootstrapFrames!('target', held, [])).toEqual({ kind: 'unknown' })
    expect(await readFile(path)).toEqual(f.raw)
    console.log(JSON.stringify({ control: 'Task2 actual held prefix/ACK denial', root, pages, owner: held.owner, tornBefore: sha(torn), fullAfter: sha(await readFile(path)), ack: 'unknown' }))
  } finally { await coordinator.close() }
})

it('spends an old public capture returning V3 without creating a header or replaying the payload callback', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'v3-capture-denial-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  try {
    const core = readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {} }), intent = createBootstrapRequestIntent(core, { kind: 'unmanaged' })
    const request = { invocation: { ...invocation, requestDigest: intent.requestDigest }, core, requestIntent: intent.intent }
    let callbacks = 0
    const payload: any = { invocation: request.invocation, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork', parentSession: 'source' }, seed: compileSelectedResultsSemanticSeed(codecSeed('public-completed')) }
    expect(await coordinator.bootstrapSemanticTargetWithCapture!(request, guards, async () => { callbacks++; return payload })).toEqual({ kind: 'refused', reason: 'manifest-invalid' })
    const before = await readdir(root); expect(before.some(name => name === 'target.jsonl')).toBe(false)
    expect(await coordinator.bootstrapSemanticTargetWithCapture!(request, guards, async () => { callbacks++; return payload })).toMatchObject({ kind: 'blocked', reason: 'payload-required' })
    expect(await readdir(root)).toEqual(before); expect(callbacks).toBe(1)
    console.log(JSON.stringify({ control: 'Task2 old public capture refusal', root, callbacks, targetHeader: false, entries: before }))
  } finally { await coordinator.close() }
})

it('refuses supplied V3 through actual generic bootstrap/resume and private child capture without target publication', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'v3-wrapper-denial-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  try {
    const payload: any = { invocation, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork', parentSession: 'source' }, seed: compileSelectedResultsSemanticSeed(codecSeed('public-completed')) }
    expect(await coordinator.bootstrapSemanticTarget(payload, guards)).toMatchObject({ kind: 'refused' })
    expect(await coordinator.resumeSemanticTarget(invocation, guards, payload)).toMatchObject({ kind: 'refused' })
    expect((await readdir(root)).filter(name => name.startsWith('target.jsonl'))).toEqual([])
    const child = pair(), childPayload: any = { ...child.payload, seed: compileSelectedResultsSemanticSeed(codecSeed()) }
    let callbacks = 0
    expect(await coordinator.bootstrapChildTargetWithCapture!(child.request, guards, async () => { callbacks++; return childPayload })).toMatchObject({ kind: 'refused' })
    expect((await readdir(root)).some(name => name === 'target.jsonl')).toBe(false)
    expect(await coordinator.bootstrapChildTargetWithCapture!(child.request, guards, async () => { callbacks++; return childPayload })).toMatchObject({ kind: 'blocked', reason: 'payload-required' })
    expect(callbacks).toBe(1)
  } finally { await coordinator.close() }
})
