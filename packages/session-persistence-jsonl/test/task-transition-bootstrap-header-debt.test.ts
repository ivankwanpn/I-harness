import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', fail: false, closes: 0 }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && (args[1] === 'wx' || args[1] === 'r+')) {
      const close = handle.close.bind(handle); handle.close = async () => { fault.closes++; if (fault.fail) throw false; await close() }
    }
    return handle
  } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { heldFactOwner, issuingFactOwner } from '../../session-persistence/src/coordinator/fact-owner.ts'
import { buildBootstrapHeader } from '../../session-persistence/src/coordinator/bootstrap-header.ts'
import { createBootstrapHeaderBackend } from '../src/backend/bootstrap-header.ts'

it('retains the original bootstrap header close until explicit settlement', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-bootstrap-header-debt-'))
  const owner = createOwnership({ lockRoot: root }, { lock: { enabled: true } }), claim = await owner.pinOwnership('target')
  const held = heldFactOwner({ sessionId: 'target', incarnation: 'original' }, owner, () => claim.assertHeld())
  const issuer = issuingFactOwner(held, () => claim.assertHeld())
  const backend = createBootstrapHeaderBackend(id => join(root, `${id}.jsonl`), async () => {}, root)
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const { operation } = buildBootstrapHeader(request)
  fault.target = join(root, 'target.jsonl'); fault.fail = true; fault.closes = 0
  try {
    backend.trackHeaderOwner('target', held)
    expect((await backend.prepareBootstrapHeader!('target', issuer, operation)).kind).toBe('unknown')
    expect((await readFile(fault.target, 'utf8')).length).toBeGreaterThan(0)
    await expect(backend.settleTrackedHeaderIO('target', held)).rejects.toThrow()
    fault.fail = false; await backend.settleTrackedHeaderIO('target', held)
    expect((await backend.reconcileBootstrapHeader!('target', held, operation)).kind).toBe('committed')
    await backend.settleTrackedHeaderIO('target', held)
  } finally { fault.fail = false; fault.target = ''; await claim.release(); await rm(root, { recursive: true, force: true }) }
})
