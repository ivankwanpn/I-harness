import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/backend-factory.ts'

const probe = vi.hoisted(() => ({
  target: '',
  sources: [] as string[],
  beforeRename: undefined as ((source: string) => Promise<void> | void) | undefined,
}))

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    async rename(from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) {
      if (String(to) === probe.target) {
        probe.sources.push(String(from))
        await probe.beforeRename?.(String(from))
      }
      await fs.rename(from, to)
    },
  }
})

const prefix = 'ih-legacy-document-sharing-'
const fixtures: { root: string; close: () => Promise<void> }[] = []
const initial = { state: 'running' }
const finished = { state: 'waiting' }

afterEach(async () => {
  probe.target = ''
  probe.sources.length = 0
  probe.beforeRename = undefined
  for (const { root, close } of fixtures.splice(0)) {
    try {
      await close()
    } finally {
      const path = resolve(root)
      if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith(prefix)) {
        throw new Error('Unexpected document fixture directory')
      }
      await rm(path, { recursive: true, force: true })
    }
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  fixtures.push({ root, close: () => coordinator.close() })
  await coordinator.putDocumentStrict!('parent', initial)
  probe.target = join(root, 'parent.doc.jsonl')
  return { root, coordinator }
}

it.skipIf(process.platform !== 'win32').each(['EPERM', 'EBUSY'])(
  'reuses the synced document candidate after a transient %s replacement failure',
  async code => {
    const { root, coordinator } = await fixture()
    probe.beforeRename = async source => {
      if (probe.sources.length !== 1) return
      expect(JSON.parse(await readFile(probe.target, 'utf8'))).toEqual(initial)
      expect(JSON.parse(await readFile(source, 'utf8'))).toEqual(finished)
      throw Object.assign(new Error('Temporary document sharing conflict'), { code })
    }

    await coordinator.putDocumentStrict!('parent', finished)
    expect(probe.sources).toHaveLength(2)
    expect(probe.sources[1]).toBe(probe.sources[0])
    await expect(coordinator.getDocument('parent')).resolves.toEqual(finished)
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  },
)

it.each([
  { code: 'EIO', retries: false },
  { code: 'EPERM', retries: process.platform === 'win32' },
])('reports a persistent $code and preserves the current document', async ({ code, retries }) => {
  const { root, coordinator } = await fixture()
  const failure = Object.assign(new Error('Document replacement failed'), { code })
  probe.beforeRename = () => { throw failure }

  await expect(coordinator.putDocumentStrict!('parent', finished)).rejects.toBe(failure)
  if (retries) {
    expect(probe.sources.length).toBeGreaterThan(1)
    expect(new Set(probe.sources).size).toBe(1)
  } else {
    expect(probe.sources).toHaveLength(1)
  }
  await expect(coordinator.getDocument('parent')).resolves.toEqual(initial)
  expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
})
