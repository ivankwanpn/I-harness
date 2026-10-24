import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createJsonlBackend } from '../src/index.ts'
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir), stat: vi.fn(actual.stat) }
})

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() { const root = await fs.mkdtemp(join(tmpdir(), 'observed-jsonl-')); roots.push(root); return { root, backend: createJsonlBackend(root) } }
it('strict reads distinguish actual absent, present and malformed document data', async () => {
  const { root, backend } = await fixture()
  expect(await backend.readDocumentObserved!('binding')).toEqual({ kind: 'absent' })
  await backend.putDocument('binding', { projectId: 'p' })
  expect(await backend.readDocumentObserved!('binding')).toEqual({ kind: 'present', value: { projectId: 'p' } })
  await fs.writeFile(join(root, 'binding.doc.jsonl'), '{broken')
  await expect(backend.readDocumentObserved!('binding')).rejects.toThrow()
})
it.each(['EACCES', 'EIO'])('strict read propagates %s while legacy read stays tolerant', async code => {
  const { root, backend } = await fixture()
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile
  vi.spyOn(fs, 'readFile').mockImplementation(((path: unknown, ...args: unknown[]) => {
    if (path === join(root, 'binding.doc.jsonl')) return Promise.reject(Object.assign(new Error(code), { code }))
    return (original as Function)(path, ...args)
  }) as typeof fs.readFile)
  expect(await backend.getDocument('binding')).toBeUndefined()
  await expect(backend.readDocumentObserved!('binding')).rejects.toMatchObject({ code })
})
it('missing storage root and durable session tombstone never become absent binding', async () => {
  const { root, backend } = await fixture()
  await fs.rm(root, { recursive: true })
  await expect(backend.readDocumentObserved!('binding')).rejects.toThrow()
  await fs.mkdir(root)
  const digest = createHash('sha256').update('source').digest('hex')
  await fs.writeFile(join(root, `desktop-deleted-session-${digest}.tombstone`), '{}')
  await expect(backend.readDocumentObserved!(`desktop-session-project-${digest}`)).rejects.toMatchObject({ code: 'SESSION_DELETED' })
})
it('inaccessible storage root and unknown tombstone state throw before any binding read', async () => {
  const { backend } = await fixture()
  const read = vi.spyOn(fs, 'readFile')
  vi.spyOn(fs, 'readdir').mockRejectedValueOnce(Object.assign(new Error('root inaccessible'), { code: 'EACCES' }))
  await expect(backend.readDocumentObserved!('binding')).rejects.toMatchObject({ code: 'EACCES' })
  expect(read).not.toHaveBeenCalled()
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).stat
  vi.spyOn(fs, 'stat').mockImplementation(((path: string, ...args: unknown[]) => path.endsWith('.tombstone') ? Promise.reject(Object.assign(new Error('unknown marker'), { code: 'EIO' })) : (original as Function)(path, ...args)) as typeof fs.stat)
  await expect(backend.readDocumentObserved!('binding')).rejects.toMatchObject({ code: 'EIO' })
  expect(read).not.toHaveBeenCalled()
})
it('rechecks durable tombstones after the actual binding file read', async () => {
  const { root, backend } = await fixture()
  const digest = createHash('sha256').update('source').digest('hex'), key = `desktop-session-project-${digest}`
  await backend.putDocument(key, { projectId: 'p' })
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile
  vi.spyOn(fs, 'readFile').mockImplementation((async (path: string, ...args: unknown[]) => {
    const data = await (original as Function)(path, ...args)
    if (path === join(root, `${key}.doc.jsonl`)) await fs.writeFile(join(root, `desktop-deleted-session-${digest}.tombstone`), '{}')
    return data
  }) as typeof fs.readFile)
  await expect(backend.readDocumentObserved!(key)).rejects.toMatchObject({ code: 'SESSION_DELETED' })
})
