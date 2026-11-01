import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator } from '../src/index.ts'

it('retains the original cold lock until the last shared inspector releases it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inspector-owner-'))
  const backend = createJsonlBackend(root)
  const options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const first = createSessionCoordinator(backend, options), other = createSessionCoordinator(createJsonlBackend(root), options)
  try {
    await first.create({ sessionId: 'source' }); await first.releaseOwnership('source')
    const acquire = (first as any).retainExistingSessionBindingObservation
    expect(typeof acquire).toBe('function')
    const a = await acquire({ sessionId: 'source' }, () => {}), b = await acquire({ sessionId: 'source' }, () => {})
    expect(a.identity).toBe(b.identity)
    await a.release(); b.assertCurrent()
    await expect(other.adoptOwnership('source')).rejects.toThrow()
    await b.release(); await expect(other.adoptOwnership('source')).resolves.toBeUndefined()
  } finally { await first.close(); await other.close(); await rm(root, { recursive: true, force: true }) }
})
