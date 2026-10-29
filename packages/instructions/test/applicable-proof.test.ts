import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFile, writeFile, symlink, unlink } from 'node:fs/promises'
import { createFsWatchService } from '@i-harness/fs-watch'
import { createInstructionObservationOwner, createObservedInstructionService } from '../src/index.ts'
import { temporary, ControlledWatch } from './helpers/observation-fixture.ts'
import * as pendingEpochs from '../src/pending-epochs.ts'
import { fixture } from './helpers/instruction-fixture.ts'

for (const destination of ['inside', 'outside'] as const) it(`revokes an existing target proof after canonical retarget ${destination}`, async () => {
  const f = await fixture(), outside = await temporary()
  try {
    await f.write('actual', 'inside'); await f.write('alternate', 'alternate'); await writeFile(join(outside.root, 'actual'), 'outside')
    const link = f.path('link'), target = { path: link, kind: 'file' as const }
    await symlink(f.path('actual'), link, 'file')
    const service = f.service(), issued = await service.prepare([target]), proof = service.proveApplicable(issued, [target])
    const sibling = { path: f.path('sibling'), kind: 'file' as const }
    await service.prepare([sibling]); service.assertApplicable(proof)
    await unlink(link); await symlink(destination === 'outside' ? join(outside.root, 'actual') : f.path('alternate'), link, 'file')
    const after = await service.prepare([{ path: f.path('another'), kind: 'file' }])
    expect(after.applicable.find(a => a.target.path === link)?.complete).toBe(destination === 'inside')
    expect(() => service.assertApplicable(proof)).toThrow()
    expect(() => service.proveApplicable(issued, [target])).toThrow()
  } finally { await f.cleanup(); await outside.remove() }
})

it('keeps an independent proof through real-owner sibling remapping but rejects genuine reset', async () => {
  const f = await fixture(), watch = new ControlledWatch(), owner = createInstructionObservationOwner(watch)
  await f.dir('a'); await f.dir('b'); await f.write('a/AGENTS.md', 'a'); const bPath = await f.write('b/AGENTS.md', 'b')
  const a = { path: f.path('a', 'file'), kind: 'file' as const }, b = { path: f.path('b', 'file'), kind: 'file' as const }
  const service = createObservedInstructionService({ scope: { cwd: f.root, roots: [f.root], globalSources: [], enabled: true, maxBytes: 24000 }, observation: owner })
  try {
    const acquired = watch.acquired.promise, started = service.prepare([a, b]), source = await acquired
    source.reset(); const issued = await started
    const ap = service.proveApplicable(issued, [a]), bp = service.proveApplicable(issued, [b])
    source.change(bPath)
    service.assertApplicable(ap)
    expect(() => service.assertApplicable(bp)).toThrow()
    await service.prepare([a, b]); service.assertApplicable(ap)
    expect(() => service.assertApplicable(bp)).toThrow()
    source.change(f.path('b', 'CLAUDE.md'), 'add')
    service.assertApplicable(ap)
    await service.prepare([a, b]); service.assertApplicable(ap)
    source.reset('overflow')
    expect(() => service.assertApplicable(ap)).toThrow()
    const fresh = await service.prepare([a, b]), freshProof = service.proveApplicable(fresh, [a])
    source.fail()
    expect(() => service.assertApplicable(freshProof)).toThrow()
  } finally { await service.close(); await owner.close(); await watch.close(); await f.cleanup() }
})

it('bounds real-owner sequential pending history while rejecting an older proof', async () => {
  const original = pendingEpochs.createPendingEpochs, observed: ReturnType<typeof original>[] = []
  const spy = vi.spyOn(pendingEpochs, 'createPendingEpochs').mockImplementation(() => { const value = original(); observed.push(value); return value })
  const temp = await temporary(), watch = createFsWatchService(), owner = createInstructionObservationOwner(watch)
  const target = { path: join(temp.root, 'file'), kind: 'file' as const }, path = join(temp.root, 'AGENTS.md')
  const service = createObservedInstructionService({ scope: { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }, observation: owner })
  try {
    const issued = await service.prepare([target]), proof = service.proveApplicable(issued, [target])
    for (let i = 0; i < 12; i++) { const lease = owner.beginPending([path]); lease.settle() }
    expect(() => service.assertApplicable(proof)).toThrow()
    const ledger = observed[0]!
    const retained = [...ledger.epochs.values()].reduce((sum, value) => sum + ((value as unknown) instanceof Map ? (value as unknown as Map<unknown, unknown>).size : 1), 0)
    expect(retained).toBeLessThanOrEqual(2)
    expect(ledger.owners.size).toBe(0)
  } finally { spy.mockRestore(); await service.close(); await owner.close(); await watch.close(); await temp.remove() }
})

it('invalidates an original proof after an observed same-byte external change', async () => {
  const f = await fixture()
  try {
    const rules = await f.write('AGENTS.md', 'unchanged'), target = { path: f.path('file.txt'), kind: 'file' as const }
    const service = f.service(), issued = await service.prepare([target])
    const proof = service.proveApplicable(issued, [target])
    service.assertApplicable(proof)
    f.observation.emit([rules])
    await service.prepare([target])
    expect(() => service.assertApplicable(proof)).toThrow()
  } finally { await f.cleanup() }
})

it('allows only its own pending transition and rejects an external observation under that lease', async () => {
  const temp = await temporary(), watch = createFsWatchService(), owner = createInstructionObservationOwner(watch)
  const candidate = join(temp.root, 'AGENTS.md'), target = { path: join(temp.root, 'file.txt'), kind: 'file' as const }
  const service = createObservedInstructionService({ scope: { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }, observation: owner })
  try {
    const issued = await service.prepare([target]), proof = service.proveApplicable(issued, [target])
    const own = service.beginOwnedWrite(proof, [candidate])
    service.assertApplicable(proof, own)
    service.invalidate([candidate])
    expect(() => service.assertApplicable(proof, own)).toThrow()
    service.settleOwnedWrite(own); service.settleOwnedWrite(own)
  } finally { await service.close(); await owner.close(); await watch.close(); await temp.remove() }
})

it('keeps an independent sibling proof current and rejects structural proof copies', async () => {
  const f = await fixture()
  try {
    await f.dir('a'); await f.dir('b'); await f.write('a/AGENTS.md', 'a'); const b = await f.write('b/AGENTS.md', 'b')
    const aTarget = { path: f.path('a', 'file'), kind: 'file' as const }, bTarget = { path: f.path('b', 'file'), kind: 'file' as const }
    const service = f.service(), issued = await service.prepare([aTarget, bTarget]), proof = service.proveApplicable(issued, [aTarget])
    expect(() => service.assertApplicable({ ...proof })).toThrow()
    f.observation.emit([b])
    service.assertApplicable(proof)
  } finally { await f.cleanup() }
})

it('accepts a newly prepared sibling target only when its full resolver slots were issued', async () => {
  const f = await fixture()
  try {
    await f.dir('a'); await f.dir('a/nested'); await f.write('a/AGENTS.md', 'a')
    const one = { path: f.path('a', 'one'), kind: 'file' as const }, sibling = { path: f.path('a', 'two'), kind: 'file' as const }, nested = { path: f.path('a', 'nested', 'new'), kind: 'file' as const }
    const service = f.service(), issued = await service.prepare([one])
    await service.prepare([sibling])
    service.assertApplicable(service.proveApplicable(issued, [sibling]))
    await service.prepare([nested])
    expect(() => service.proveApplicable(issued, [nested])).toThrow()
  } finally { await f.cleanup() }
})

it('rejects another pending write even after it settles and a rebuild restores the same bytes', async () => {
  const temp = await temporary(), watch = createFsWatchService(), owner = createInstructionObservationOwner(watch)
  const candidate = join(temp.root, 'AGENTS.md'), target = { path: join(temp.root, 'file'), kind: 'file' as const }
  const service = createObservedInstructionService({ scope: { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }, observation: owner })
  try {
    const issued = await service.prepare([target]), proof = service.proveApplicable(issued, [target])
    const own = service.beginOwnedWrite(proof, [candidate]), other = owner.beginPending([candidate])
    other.settle()
    expect(() => service.assertApplicable(proof, own)).toThrow()
    service.settleOwnedWrite(own)
    await service.prepare([target])
    expect(() => service.assertApplicable(proof)).toThrow()
  } finally { await service.close(); await owner.close(); await watch.close(); await temp.remove() }
})

it('permits a scoped proof when instructions are disabled and revokes it on close', async () => {
  const f = await fixture()
  try {
    const service = f.service({ enabled: false }), target = { path: f.path('data'), kind: 'file' as const }
    const issued = await service.prepare([target]), proof = service.proveApplicable(issued, [target])
    service.assertApplicable(proof)
    await service.close()
    expect(() => service.assertApplicable(proof)).toThrow()
  } finally { await f.cleanup() }
})

it('rejects a reentrant invalidation during pending admission and settles the original lease', async () => {
  const temp = await temporary(), watch = createFsWatchService(), owner = createInstructionObservationOwner(watch)
  const candidate = join(temp.root, 'AGENTS.md'), target = { path: join(temp.root, 'file'), kind: 'file' as const }
  const service = createObservedInstructionService({ scope: { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }, observation: owner })
  try {
    const issued = await service.prepare([target]), proof = service.proveApplicable(issued, [target])
    let once = true
    const unsubscribe = service.subscribe(() => { if (once) { once = false; service.invalidate([candidate]) } })
    expect(() => service.beginOwnedWrite(proof, [candidate])).toThrow()
    unsubscribe()
    expect(service.snapshot().candidates.every(c => c.pendingIds.length === 0)).toBe(true)
  } finally { await service.close(); await owner.close(); await watch.close(); await temp.remove() }
})

it('rejects forged and foreign snapshots and remembers a changed Git boundary after rebuild', async () => {
  const f = await fixture()
  try {
    await f.dir('sub'); const target = { path: f.path('sub', 'file'), kind: 'file' as const }, marker = f.path('sub', '.git')
    const service = f.service(), issued = await service.prepare([target])
    expect(() => service.proveApplicable({ ...issued }, [target])).toThrow()
    const proof = service.proveApplicable(issued, [target])
    await f.dir('sub/.git'); f.observation.emit([marker]); await service.prepare([target])
    expect(() => service.assertApplicable(proof)).toThrow()
    const foreign = f.service(); await foreign.prepare([target])
    expect(() => foreign.proveApplicable(issued, [target])).toThrow()
  } finally { await f.cleanup() }
})

it('compares known candidate paths with each resolved target scope', async () => {
  const f = await fixture()
  try {
    await f.dir('a'); await f.dir('b'); const candidate = await f.write('a/AGENTS.md', 'a')
    const a = { path: f.path('a', 'file'), kind: 'file' as const }, b = { path: f.path('b', 'file'), kind: 'file' as const }
    const service = f.service(); await service.prepare([a, b])
    expect(service.relation(candidate, a)).toBe('governs')
    expect(service.relation(candidate, b)).toBe('independent')
    expect(service.relation(f.path('unknown', 'AGENTS.md'), b)).toBe('unknown')
  } finally { await f.cleanup() }
})

it('settles an owned real rule write and rebuilds from the actual file bytes', async () => {
  const temp = await temporary(), watch = createFsWatchService(), owner = createInstructionObservationOwner(watch)
  const candidate = join(temp.root, 'AGENTS.md'), target = { path: join(temp.root, 'file'), kind: 'file' as const }
  const service = createObservedInstructionService({ scope: { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }, observation: owner })
  try {
    const issued = await service.prepare([target]), proof = service.proveApplicable(issued, [target])
    const own = service.beginOwnedWrite(proof, [candidate])
    service.assertApplicable(proof, own)
    await writeFile(candidate, 'actual owned bytes')
    service.settleOwnedWrite(own)
    expect(await readFile(candidate, 'utf8')).toBe('actual owned bytes')
    expect((await service.prepare([target])).text).toContain('actual owned bytes')
    expect(() => service.assertApplicable(proof)).toThrow()
  } finally { await service.close(); await owner.close(); await watch.close(); await temp.remove() }
})
