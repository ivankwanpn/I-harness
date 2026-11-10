import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { createJsonlCommitCoordinator } from '@i-harness/session-persistence-jsonl/internal/commit-coordinator'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
import { listStoredSessions } from '../src/sessions.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-cli-listing-current-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'ih-cli-listing-current-'))
  roots.push(path)
  return path
}
function coordinator(kind: 'jsonl' | 'commit-log', path: string, now?: () => Date): SessionCoordinator {
  const lock = { enabled: true, lockRoot: path }
  return kind === 'jsonl'
    ? createJsonlTaskTransitionCoordinator(path, { lock }, taskDocumentStorageContract)
    : asSessionCoordinator(createJsonlCommitCoordinator(path, { lock, ...(now ? { now } : {}) }), { taskDocument: { validator: taskDocumentStorageContract, empty: taskDocumentStorageContract.empty } })
}

it.each(['jsonl', 'commit-log'] as const)('lists committed manual titles after %s cold restart with Gateway title precedence', async kind => {
  const path = await root()
  const writer = coordinator(kind, path)
  try {
    await writer.create({ sessionId: 'manual', title: 'Old header title' })
    await writer.append('manual', [{ type: 'session/title', title: 'Auto candidate', source: 'provider', messageSeqs: [] }, { type: 'session/title', title: 'Acknowledged manual title', source: 'user', messageSeqs: [] }])
    await writer.create({ sessionId: 'legacy', title: 'Legacy header wins' })
    await writer.append('legacy', [{ type: 'session/title', title: 'Auto loses to header', source: 'provider', messageSeqs: [] }])
    await writer.create({ sessionId: 'automatic' })
    await writer.append('automatic', [{ type: 'session/title', title: 'Automatic title', source: 'fallback', messageSeqs: [] }])
  } finally { await writer.close() }

  const reader = coordinator(kind, path)
  const snapshot = vi.fn((id: string) => reader.snapshot!(id))
  const readOnly = {
    list: () => reader.list(),
    profile: (id: string) => reader.profile(id),
    snapshot,
    load: () => { throw Error('Listing must not enter the writable loader') },
    adoptOwnership: () => { throw Error('Listing must not adopt a writer') },
  } as unknown as SessionCoordinator
  try {
    const rows = await listStoredSessions(readOnly, path)
    expect(Object.fromEntries(rows.map(row => [row.id, row.title]))).toEqual({ manual: 'Acknowledged manual title', legacy: 'Legacy header wins', automatic: 'Automatic title' })
    expect(rows.every(row => row.problem === undefined)).toBe(true)
    expect(snapshot).toHaveBeenCalledTimes(3)
    for (const id of ['manual', 'legacy', 'automatic']) expect(reader.ownerOf(id)).toBe(false)
  } finally { await reader.close() }
})

it('sorts cold commit-log rows by finite store update time rather than legacy filenames or creation time', async () => {
  const path = await root()
  let time = new Date('2026-01-01T00:00:00.000Z')
  const writer = coordinator('commit-log', path, () => time)
  try {
    await writer.create({ sessionId: 'older-update', createdAt: '2030-01-01T00:00:00.000Z' })
    time = new Date('2026-01-02T00:00:00.000Z')
    await writer.create({ sessionId: 'newer-update', createdAt: '2000-01-01T00:00:00.000Z' })
  } finally { await writer.close() }
  const reader = coordinator('commit-log', path)
  try {
    const rows = await listStoredSessions(reader, path)
    expect(rows.map(row => row.id)).toEqual(['newer-update', 'older-update'])
    expect(rows.map(row => row.updatedAt)).toEqual([Date.parse('2026-01-02T00:00:00.000Z'), Date.parse('2026-01-01T00:00:00.000Z')])
    await expect(stat(join(path, 'newer-update.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await reader.close() }
})

it('retains legacy mtime and createdAt fallbacks and labels a corrupt snapshot row honestly', async () => {
  const path = await root()
  await writeFile(join(path, 'legacy.jsonl'), 'fixture')
  const mtime = new Date('2025-01-02T00:00:00.000Z')
  await utimes(join(path, 'legacy.jsonl'), mtime, mtime)
  const c = {
    list: async () => ['legacy', 'created', 'corrupt'],
    profile: async (id: string) => ({ meta: { sessionId: id, title: id + ' header', createdAt: '2020-01-01T00:00:00.000Z' }, updatedAt: id === 'legacy' ? Infinity : id === 'corrupt' ? 123 : Number.NaN }),
    snapshot: async (id: string) => { if (id === 'corrupt') throw Error('Saved facts are corrupt'); return { session: { events: [] } } },
  } as unknown as SessionCoordinator
  const rows = await listStoredSessions(c, path)
  expect(rows.find(row => row.id === 'legacy')?.updatedAt).toBe(mtime.getTime())
  expect(rows.find(row => row.id === 'created')?.updatedAt).toBe(Date.parse('2020-01-01T00:00:00.000Z'))
  expect(rows.find(row => row.id === 'corrupt')).toMatchObject({ title: 'corrupt header', updatedAt: 123, problem: 'log unreadable: Saved facts are corrupt' })
})
