import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && args[1] === 'r') {
      const close = handle.close.bind(handle)
      handle.close = async () => { fault.entered?.(); await fault.gate; await close() }
    }
    return handle
  } }
})
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { heldFactOwner } from '../../session-persistence/src/coordinator/fact-owner.ts'
import { createBootstrapHeaderBackend } from '../src/backend/bootstrap-header.ts'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createPredecessorSession } from './helpers/predecessor.ts'

it('fences a late tracked flight while settlement joins the original delayed read close', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-header-ledger-admission-'))
  const ownership = createOwnership({ lockRoot: root }, { lock: { enabled: true } }), claim = await ownership.pinOwnership('target')
  const held = heldFactOwner({ sessionId: 'target', incarnation: 'original' }, ownership, () => claim.assertHeld())
  const backend = createBootstrapHeaderBackend(id => join(root, `${id}.jsonl`), async () => {}, root)
  const route = { protocol: 'public' as const, invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-30T00:00:00.000Z', requestDigest: 'a'.repeat(64) } }
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  await createPredecessorSession(createJsonlBackend(root), root, 'target', 13, route.invocation.createdAt)
  fault.target = join(root, 'target.jsonl'); fault.gate = gate.promise; fault.entered = entered.resolve
  backend.trackHeaderOwner('target', held)
  const original = backend.readTrackedState(route, held); void original.catch(() => {})
  let settle: Promise<void> | undefined
  try {
    await entered.promise
    let settled = false; settle = backend.settleTrackedHeaderIO('target', held).then(() => { settled = true })
    const late = backend.readTrackedState(route, held).then(() => 'admitted', () => 'refused')
    // A late admission must refuse synchronously at the owner boundary, without waiting for the read close.
    const checkpoint = await Promise.race([late, new Promise<'waiting'>(resolve => setImmediate(() => resolve('waiting')))])
    expect(checkpoint).toBe('refused'); expect(settled).toBe(false)
    gate.resolve(); expect((await original).kind).toBe('present'); await settle
    expect((await backend.readTrackedState(route, held)).kind).toBe('present')
  } finally { gate.resolve(); await original.catch(() => {}); await settle?.catch(() => {}); fault.target = ''; fault.gate = undefined; fault.entered = undefined; await backend.settleTrackedHeaderIO('target', held); await claim.release(); await rm(root, { recursive: true, force: true }) }
})
