import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type SessionEvent, type SessionHistoryPageOptions } from '@i-harness/core-session'
import { materializeSessionHistoryPage, planSessionHistoryPage, sessionHistoryFact } from '@i-harness/core-session/internal/archive'
import { nodeIo } from '../../session-commit-log/src/io.ts'
import { generationPath } from '../../session-commit-log/src/paths.ts'
import { COMMIT_LOG_GENERATION, openCommitLog } from '@i-harness/session-commit-log'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'
import { createSessionCoordinator } from '../src/index.ts'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'

const id = 'history', roots: string[] = []
const make = (root: string) => createCommitCoordinator({ root, now: () => new Date('2026-01-01T00:00:00Z') })
const tail = { beforeSeq: Number.MAX_SAFE_INTEGER, afterSeq: 0, limit: 1, includeTurns: true }
async function fixture(entries: SessionEvent[]) {
  const root = await mkdtemp(join(tmpdir(), 'ih-commit-page-')); roots.push(root)
  const seed = make(root)
  try { await seed.create({ sessionId: id }); await seed.append(id, entries) } finally { await seed.close() }
  return { root, path: generationPath(root, id, COMMIT_LOG_GENERATION), reader: make(root) }
}
const simple = (text: string): SessionEvent[] => [{ type: 'turn/start' }, { type: 'user/message', text }, { type: 'assistant/message', text: 'ok' }, { type: 'turn/end' }]
async function original(reader: ReturnType<typeof make>, options: SessionHistoryPageOptions) {
  const { session } = await reader.snapshot(id)
  const plan = planSessionHistoryPage(session.events.map(sessionHistoryFact), options)!
  return materializeSessionHistoryPage(plan, plan.ordinals.map(seq => session.events[seq]!))
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('returns the same turns, sequence range and hydrated image from before the requested page', async () => {
  const image = { mediaType: 'image/png' as const, dataBase64: 'AQID' }
  const f = await fixture([{ type: 'agent/input/admitted', version: 1, inputId: 'photo', text: 'inspect', images: [image], delivery: 'queue', intent: 'user' },
    { type: 'turn/start' }, { type: 'agent/input/promoted', version: 1, inputId: 'photo' },
    { type: 'user/message', text: 'inspect', input: { inputId: 'photo', intent: 'user' }, imageInputId: 'photo' }, { type: 'assistant/message', text: 'seen' }, { type: 'turn/end' }])
  try {
    const cases: SessionHistoryPageOptions[] = [tail, { ...tail, beforeSeq: 4 }, { ...tail, beforeSeq: 0 }, { afterSeq: 2, limit: 3 }]
    for (const options of cases) {
      const page = await f.reader.readHistoryPage(id, options)
      expect(page).toEqual(await original(f.reader, options))
      if (options.beforeSeq === 4) expect(page?.images.get(3)).toEqual([image])
    }
  } finally { await f.reader.close() }
})

it('detects equal-length replacement and same-mtime corruption outside the selected page', async () => {
  const a = await fixture(simple('Alpha')), b = await fixture(simple('Bravo'))
  const fixed = new Date('2025-01-01T00:00:00Z')
  try {
    await utimes(a.path, fixed, fixed)
    await utimes(b.path, fixed, fixed)
    const select = { afterSeq: 1, limit: 1 }
    expect((await a.reader.readHistoryPage(id, select))?.events[0]).toMatchObject({ text: 'Alpha' })
    expect((await stat(a.path)).size).toBe((await stat(b.path)).size)
    await rename(b.path, a.path)
    expect((await a.reader.readHistoryPage(id, select))?.events[0]).toMatchObject({ text: 'Bravo' })
    const before = await stat(a.path, { bigint: true })
    const bytes = await readFile(a.path), offset = bytes.indexOf('Bravo')
    expect(offset).toBeGreaterThan(-1)
    bytes[offset] = 'X'.charCodeAt(0)
    await writeFile(a.path, bytes); await utimes(a.path, fixed, fixed)
    const after = await stat(a.path, { bigint: true })
    expect([after.ino, after.size, after.mtimeNs]).toEqual([before.ino, before.size, before.mtimeNs])
    await expect(a.reader.readHistoryPage(id, tail)).rejects.toThrow(/digest/i)
  } finally { await a.reader.close(); await b.reader.close() }
})

it('rechecks an original indexed page when a separate writer appends while the selected bytes are held', async () => {
  const f = await fixture(simple('first')), writer = make(f.root)
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let armed = true
  try {
    expect((await f.reader.readHistoryPage(id, tail))?.headSeq).toBe(4)
    const open = nodeIo.open.bind(nodeIo)
    vi.spyOn(nodeIo, 'open').mockImplementation(async (path, mode) => {
      const handle = await open(path, mode)
      if (path === f.path && mode === 'r') {
        const read = handle.read.bind(handle)
        Object.defineProperty(handle, 'read', { configurable: true, value: async (...args: Parameters<typeof read>) => {
          const result = await read(...args)
          if (armed) { armed = false; held.resolve(); await release.promise }
          return result
        } })
      }
      return handle
    })
    const reading = f.reader.readHistoryPage(id, tail)
    await held.promise
    await writer.append(id, simple('second'))
    release.resolve()
    expect(await reading).toBeUndefined()
    expect(await f.reader.readHistoryPage(id, tail)).toMatchObject({ startSeq: 7, headSeq: 8 })
  } finally { release.resolve(); await writer.close(); await f.reader.close() }
})

it('observes deletion and recreation and does not modify a torn tail during inspection', async () => {
  const f = await fixture(simple('old')), writer = make(f.root)
  try {
    expect((await f.reader.readHistoryPage(id, tail))?.headSeq).toBe(4)
    await writer.deleteOwnedSession(id, { documents: [] })
    await expect(f.reader.readHistoryPage(id, tail)).rejects.toMatchObject({ code: 'COMMIT_LOG_NOT_FOUND' })
    await writer.create({ sessionId: id }); await writer.append(id, simple('new')); await writer.close()
    expect((await f.reader.readHistoryPage(id, { afterSeq: 1, limit: 1 }))?.events[0]).toMatchObject({ text: 'new' })
    await appendFile(f.path, '{"torn":')
    const before = await readFile(f.path)
    expect(await f.reader.readHistoryPage(id, tail)).toEqual(await original(f.reader, tail))
    expect(await readFile(f.path)).toEqual(before)
  } finally { await writer.close(); await f.reader.close() }
})

it('uses bounded neighboring spans beyond 16,384 events and hydrates an image from before that viewport', async () => {
  const image = { mediaType: 'image/png' as const, dataBase64: 'AQID' }
  const entries: SessionEvent[] = [{ type: 'agent/input/admitted', version: 1, inputId: 'photo', text: 'look', images: [image], intent: 'user', delivery: 'queue' }]
  for (let i = 0; i < 4_100; i++) entries.push(...simple('ordinary ' + i))
  const userOrdinal = entries.length + 2
  entries.push({ type: 'turn/start' }, { type: 'agent/input/promoted', version: 1, inputId: 'photo' },
    { type: 'user/message', text: 'look', input: { inputId: 'photo', intent: 'user' }, imageInputId: 'photo' }, { type: 'turn/end' })
  const f = await fixture(entries)
  let full = 0, selectedBytes = 0
  try {
    const open = nodeIo.open.bind(nodeIo)
    vi.spyOn(nodeIo, 'open').mockImplementation(async (path, mode) => {
      const handle = await open(path, mode)
      if (path === f.path && mode === 'r') {
        const all = handle.readFile.bind(handle), range = handle.read.bind(handle)
        Object.defineProperty(handle, 'readFile', { configurable: true, value: (...args: Parameters<typeof all>) => { full++; return all(...args) } })
        Object.defineProperty(handle, 'read', { configurable: true, value: async (...args: Parameters<typeof range>) => {
          const result = await range(...args); selectedBytes += result.bytesRead; return result
        } })
      }
      return handle
    })
    expect((await f.reader.readHistoryPage(id, tail))?.headSeq).toBe(entries.length)
    const imagePage = await f.reader.readHistoryPage(id, { ...tail, beforeSeq: userOrdinal + 1 })
    expect(imagePage?.images.get(userOrdinal)).toEqual([image])
    expect(imagePage?.turns).toEqual([{ startSeq: userOrdinal - 2, endSeq: userOrdinal + 1 }])
    expect(full).toBe(1); expect(selectedBytes).toBeGreaterThan(0); expect(selectedBytes).toBeLessThan(2_048)
    expect((await f.reader.readHistoryPage(id, { ...tail, beforeSeq: 10 }))?.startSeq).toBe(9)
    expect((await f.reader.readHistoryPage(id, { ...tail, beforeSeq: 9 }))?.startSeq).toBe(8)
    expect(full).toBe(2)
  } finally { await f.reader.close() }
}, 30_000)

it('resolves reused logical sequence numbers to the new physical entry after a rewind', async () => {
  const f = await fixture(simple('initial'))
  try {
    expect((await f.reader.readHistoryPage(id, tail))?.headSeq).toBe(4)
    const log = await openCommitLog({ root: f.root, sessionId: id }, 'write')
    try {
      await log.append({ ops: [{ kind: 'rewind', toSeq: 1 }] })
      await log.append({ entries: [{ type: 'user/message', seq: 1, text: 'replacement' }, { type: 'turn/end', seq: 2 }] })
    } finally { await log.close() }
    expect((await f.reader.readHistoryPage(id, tail))?.headSeq).toBe(3)
    const page = await f.reader.readHistoryPage(id, { afterSeq: 1, limit: 1 })
    expect(page?.events).toEqual([{ type: 'user/message', seq: 1, text: 'replacement' }])
  } finally { await f.reader.close() }
})

it('leaves legacy sessions on their original read-only snapshot path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-history-legacy-')); roots.push(root)
  const legacy = createSessionCoordinator(createJsonlBackend(root))
  try { await legacy.create({ sessionId: id }); await legacy.append(id, simple('legacy')) } finally { await legacy.close() }
  const path = join(root, id + '.jsonl'), before = await readFile(path)
  const reader = createJsonlCommitCoordinator(root)
  try {
    expect(await reader.readHistoryPage(id, tail)).toBeUndefined()
    expect((await reader.snapshot(id)).session.events[1]).toMatchObject({ text: 'legacy' })
    expect(await readFile(path)).toEqual(before)
    await expect(stat(generationPath(root, id, COMMIT_LOG_GENERATION))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await reader.close() }
})

it('applies the original session format preflight even when a good requested row lies outside a malformed event', async () => {
  const f = await fixture([{ type: 'context/budget', snapshot: null } as unknown as SessionEvent, ...simple('otherwise valid')])
  try {
    await expect(f.reader.snapshot(id)).rejects.toThrow(/unsupported/i)
    await expect(f.reader.readHistoryPage(id, tail)).rejects.toThrow(/unsupported/i)
  } finally { await f.reader.close() }
})
