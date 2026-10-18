import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator, forkSession, SessionFormatUnsupportedError } from '@i-harness/session-persistence'
import { encodeFactBatch, legacyPrefixDigest, deriveMessages, fromJSONL, toJSONL, type SessionEvent } from '@i-harness/core-session'
import { createJsonlBackend } from '../src/index.ts'

function events(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, text: 'H', provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'session.seed' } },
    { type: 'step/start', seq: 2 }, { type: 'assistant/message', seq: 3, text: 'E1' }, { type: 'step/end', seq: 4 },
    { type: 'step/start', seq: 5 }, { type: 'assistant/message', seq: 6, text: 'E2' }, { type: 'step/end', seq: 7 }, { type: 'turn/end', seq: 8 },
    { type: 'compaction/replacement', version: 1, seq: 9, replacementId: 'r9', text: 'S', coverage: [
      { item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] },
    ], insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } },
  ]
}
const emptyJournal = () => ({ version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 as const })

it('commits, structurally exports, cold-loads and forks replacement history under child receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f2-journal-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), parent = await coordinator.openManagedDocument(id)
  try {
    const imported = await parent.importSeed(events())
    expect(imported.kind).toBe('committed')
    expect(deriveMessages(parent.view).map(message => message.content)).toEqual(['H', 'S', 'E2'])
    const path = join(root, `${id}.jsonl`), original = await readFile(path)
    await copyFile(path, join(root, 'byte-copy.jsonl'))
    expect(await readFile(join(root, 'byte-copy.jsonl'))).toEqual(original)
    const structural = toJSONL(parent.view)
    expect(deriveMessages(fromJSONL(structural)).map(message => message.content)).toEqual(['H', 'S', 'E2'])
    expect(JSON.parse(structural.split('\n')[0]!).journal).toEqual(emptyJournal())
    expect(structural).not.toContain('incarnation')
    const child = await forkSession(coordinator, id), target = await coordinator.openManagedDocument(child.sessionId)
    expect(deriveMessages(target.view).map(message => message.content)).toEqual(['H', 'S', 'E2'])
    expect(target.view.header).toMatchObject({ parentSession: id, seedLength: 10 })
    const outcome = await target.metadata.admit({ type: 'plan/mode', mode: 'on' })
    expect(outcome).toMatchObject({ kind: 'committed', receipt: { owner: { sessionId: child.sessionId } }, seqs: [10] })
    if (outcome.kind === 'committed' && imported.kind === 'committed') expect(outcome.receipt.owner).not.toEqual(imported.receipt.owner)
    expect(await readFile(path)).toEqual(original)
    await parent.close(); await coordinator.releaseOwnership(id)
    expect(deriveMessages((await coordinator.openManagedDocument(id)).view).map(message => message.content)).toEqual(['H', 'S', 'E2'])
    expect((await coordinator.snapshot!(id)).session.events[9]).toMatchObject({ type: 'compaction/replacement', replacementId: 'r9' })
  } finally { await coordinator.close() }
})

it('upgrades6 to9 by changing only the header and preserves journal metadata and exact body bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f2-upgrade-')), path = join(root, 's.jsonl')
  const legacy = Buffer.from(' { "type":"user/message", "seq":0, "text":"中文😀" }\r\n')
  const journal = { ...emptyJournal(), legacyBodyBytes: legacy.length, legacyEventCount: 1, legacyPrefixDigest: legacyPrefixDigest(1, legacy) }
  const frame = encodeFactBatch('old6', journal.legacyPrefixDigest, [{ type: 'plan/mode', mode: 'off', seq: 1 }])
  const body = Buffer.concat([legacy, frame.bytes])
  await writeFile(path, Buffer.concat([Buffer.from(JSON.stringify({ formatVersion: 6, sessionId: 's', createdAt: 'literal', journal, extension: { keep: true } }) + '\n'), body]))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  try {
    const document = await coordinator.openManagedDocument('s')
    const upgraded = await readFile(path), end = upgraded.indexOf(0x0a)
    expect(JSON.parse(upgraded.subarray(0, end).toString())).toMatchObject({ formatVersion: 9, journal, extension: { keep: true } })
    expect(upgraded.subarray(end + 1)).toEqual(body)
    expect(document.view.formatVersion).toBe(9)
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).toMatchObject({ kind: 'committed', seqs: [2] })
  } finally { await coordinator.close() }
})

it('refuses wrong format before repair or mutation and hides every event of a torn replacement frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f2-refusal-')), journal = emptyJournal(), frame = encodeFactBatch('atomic', journal.legacyPrefixDigest, events())
  const path = join(root, 's.jsonl'), header = (formatVersion: number) => Buffer.from(JSON.stringify({ formatVersion, sessionId: 's', createdAt: 'literal', journal }) + '\n')
  const wrong = Buffer.concat([header(6), frame.bytes])
  await writeFile(path, wrong)
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), repair = vi.spyOn(backend, 'repair')
  try {
    await expect(coordinator.loadOwned('s')).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    expect(repair).not.toHaveBeenCalled(); expect(await readFile(path)).toEqual(wrong)
    const torn = Buffer.concat([header(7), frame.bytes.subarray(0, frame.bytes.length - 2)])
    await writeFile(path, torn)
    expect((await coordinator.snapshot!('s')).session.events).toEqual([])
    expect(await readFile(path)).toEqual(torn)
  } finally { await coordinator.close() }
})

it('refuses a replacement batch if the actual owned file header was changed back to6', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f2-header-downgrade-')), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const path = join(root, `${id}.jsonl`)
  try {
    const raw = await readFile(path, 'utf8'), changed = raw.replace('"formatVersion":9', '"formatVersion":6')
    expect(changed).not.toBe(raw); await writeFile(path, changed)
    expect((await document.importSeed(events())).kind).not.toBe('committed')
    expect(document.view.events).toEqual([])
    expect(await readFile(path, 'utf8')).toBe(changed)
  } finally { await coordinator.close() }
})

it.each([1, 2, 3, 4, 5])('rejects a replacement in backend legacy format%s reads and repair before writing', async formatVersion => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f2-flat-refusal-')), path = join(root, 's.jsonl')
  const records = events(); records[1] = { type: 'user/message', seq: 1, text: 'H' }
  const raw = [JSON.stringify({ formatVersion, sessionId: 's' }), ...records.map(record => JSON.stringify(record)), '{"torn":'].join('\n')
  await writeFile(path, raw)
  const backend = createJsonlBackend(root)
  await expect(backend.read('s')).rejects.toMatchObject({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason: 'format' })
  await expect(backend.repair('s')).rejects.toMatchObject({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason: 'format' })
  expect(await readFile(path, 'utf8')).toBe(raw)
})
