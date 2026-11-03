import { expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover, planDiscovery } from '../src/discovery.ts'

it('retains canonical target and exact Git membership observed by discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-proof-membership-')), dir = join(root, 'nested'), file = join(dir, 'file.txt')
  try {
    await mkdir(dir); await mkdir(join(dir, '.git')); await writeFile(file, 'data')
    const scope = { cwd: root, roots: [root], globalSources: [], enabled: true, maxBytes: 24000 }
    const result = await discover(scope, planDiscovery(scope, [{ path: file, kind: 'file' }]))
    expect((result.targets[0] as unknown as { membership?: unknown }).membership).toMatchObject({
      root: await realpath(root), target: await realpath(file), boundary: dir,
      markers: [{ path: join(dir, '.git'), state: 'valid' }],
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('retains nearest-ancestor canonical identity for absent instruction candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-proof-absent-'))
  try {
    const scope = { cwd: root, roots: [root], globalSources: [], enabled: true, maxBytes: 24000 }
    const result = await discover(scope, planDiscovery(scope, [{ path: join(root, 'new.txt'), kind: 'file' }]))
    const absent = result.slots.find(slot => slot.path === join(root, 'AGENTS.md'))!
    expect(absent.presence).toBe('absent')
    expect(absent.canonicalPath).toBe(join(await realpath(root), 'AGENTS.md'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
