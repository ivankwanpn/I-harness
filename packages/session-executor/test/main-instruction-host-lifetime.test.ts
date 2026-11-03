import { expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchSettings } from '@i-harness/settings'
import { createFsWatchService, type FsWatchService } from '@i-harness/fs-watch'
import { createInstructionEnvironment } from '../src/index.ts'
import { rmWorkspaceSync } from './helpers.ts'

it('real trust, policy and IA borrowers retry their original failed leases before the outer watch closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-instruction-borrowers-')), settingsPath = join(root, 'settings.json'), trustPath = join(root, 'trust.json')
  await writeFile(settingsPath, JSON.stringify({ instructions: { enabled: true, maxBytes: 24000, globalSources: [] } })); await writeFile(trustPath, '{}'); await writeFile(join(root, 'AGENTS.md'), 'OBSERVED_BORROWED_SOURCE')
  const real = createFsWatchService(), attempts = new Map<string, number>(), originalFaults: string[] = []
  let parentCloses = 0
  const shared: FsWatchService = {
    acquire(options) {
      const lease = real.acquire(options), close = lease.close.bind(lease), key = JSON.stringify(options.roots)
      return { ...lease, async close() {
        const ordinal = (attempts.get(key) ?? 0) + 1; attempts.set(key, ordinal)
        if (ordinal === 1) { originalFaults.push(key); throw Error('same original borrower close fault') }
        await close()
      } }
    }, async close() { parentCloses++; await real.close() },
  }
  const trust = watchSettings(trustPath, async () => {}, { service: shared, onError() {} }), environment = createInstructionEnvironment({ settingsPath, watch: shared })
  const scope = { cwd: root, roots: [root], globalSources: [], enabled: true, maxBytes: 24000 }, source = environment.host.create(scope)
  try {
    await trust.ready; await environment.policy.ready()
    expect(await source.prepare([{ path: root, kind: 'directory' }])).toMatchObject({ complete: true, reliability: 'ready' })
    trust.dispose(); environment.dispose()
    expect(() => environment.host.create(scope)).toThrow('closed')
    const first = await Promise.allSettled([environment.close(), trust.close()])
    expect(first.some(result => result.status === 'rejected')).toBe(true)
    expect(parentCloses).toBe(0)
    await expect(source.prepare([])).rejects.toMatchObject({ code: 'INSTRUCTIONS_CLOSED' })
    await environment.close(); await trust.close()
    expect(parentCloses).toBe(0)
    expect(originalFaults.length).toBeGreaterThanOrEqual(3)
    expect([...attempts.values()].every(value => value >= 2)).toBe(true)
    await shared.close(); expect(parentCloses).toBe(1)
  } finally { await environment.close(); await trust.close(); await real.close(); rmWorkspaceSync(root) }
})
