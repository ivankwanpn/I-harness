import { expect, it, vi } from 'vitest'
const faults = vi.hoisted(() => ({ target: '', fail: false, closes: 0 }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === faults.target && args[1] === 'r') {
      const close = handle.close.bind(handle)
      handle.close = async () => { faults.closes++; if (faults.fail) throw false; await close() }
    }
    return handle
  } }
})
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlBackend, lookupJsonlProcessRead } from '../src/backend-factory.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { issueHeldTaskDocumentScope } from '../../session-persistence/src/coordinator/task-document-scope.ts'

it('retains the original history file close failure until explicit settlement', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-history-debt-'))
  const backend = createJsonlBackend(root), owner = createOwnership(backend, { lock: { enabled: true } })
  const pin = await owner.pinOwnership('p'), lease = await owner.acquireLease('doc:task-p')
  const scope = issueHeldTaskDocumentScope(owner, 'p', pin, { assertActive() { if (!lease.held) throw Error('revoked') } })
  try {
    await backend.create('p', { sessionId: 'p', formatVersion: 13, createdAt: '2026-01-01' })
    faults.target = join(root, 'p.jsonl'); faults.fail = true; faults.closes = 0
    const reader = lookupJsonlProcessRead(backend)!.openTaskHistory(scope)
    await expect(reader.observe()).rejects.toBe(false)
    await expect(reader.settleResources()).rejects.toBe(false)
    expect(faults.closes).toBe(2); faults.fail = false
    await reader.settleResources(); expect(faults.closes).toBe(3)
    await expect(reader.observe()).rejects.toBe(false)
  } finally { faults.fail = false; faults.target = ''; await lease.release(); await pin.release(); await rm(root, { recursive: true, force: true }) }
})
