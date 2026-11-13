import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createContextOutputService } from '../src/index.ts'
import { ContextStore } from '../src/store.ts'

it.skipIf(process.platform !== 'win32')('captures, searches and cold-reopens an index whose journal exceeds the Windows short-path boundary', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ih-context-long-index-'))
  const workspaceId = 'long-native-index'
  const baseIndexPath = join(new ContextStore(base, workspaceId).directory, 'index.sqlite')
  const padding = 255 - baseIndexPath.length - 1
  expect(padding).toBeGreaterThan(0)
  const root = join(base, 'p'.repeat(padding))
  await mkdir(root)
  const indexPath = join(new ContextStore(root, workspaceId).directory, 'index.sqlite')
  expect(indexPath.length).toBe(255)
  expect((indexPath + '-journal').length).toBeGreaterThan(260)
  const options = { root, workspaceId, config: { enabled: true } }
  let service = createContextOutputService(options)
  try {
    const ref = await service.capture({ sessionId: 'owner', callId: 'capture', label: 'long path', text: 'original native needle', complete: true })
    expect(ref).toBeDefined()
    expect((await service.search({ sessionId: 'owner' }, { query: 'needle' })).hits.map(hit => hit.ref.id)).toEqual([ref!.id])
    await service.close()
    service = createContextOutputService(options)
    expect((await service.search({ sessionId: 'owner' }, { query: 'needle' })).hits.map(hit => hit.ref.id)).toEqual([ref!.id])
    expect((await service.read({ sessionId: 'owner' }, { refId: ref!.id })).text).toBe('original native needle')
  } finally {
    await service.close()
    const target = resolve(base)
    if (dirname(target) !== resolve(tmpdir()) || !target.startsWith(join(resolve(tmpdir()), 'ih-context-long-index-'))) {
      throw new Error('Unexpected long-index fixture cleanup path')
    }
    await rm(target, { recursive: true, force: true })
  }
})
