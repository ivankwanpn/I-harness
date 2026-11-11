import { expect, it, vi } from 'vitest'
const checked = vi.hoisted(() => ({ batches: 0, proofs: 0 }))
vi.mock('../../fs-lock/src/win32-artifact-path.ts', async load => {
  const original = await load<typeof import('../../fs-lock/src/win32-artifact-path.ts')>()
  return { ...original, checkWin32ArtifactPaths: function(this: unknown, ...args: Parameters<typeof original.checkWin32ArtifactPaths>) {
    checked.batches++; checked.proofs += args[0].length
    return Reflect.apply(original.checkWin32ArtifactPaths, this, args)
  } }
})
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createArtifactPathOwner } from '../../fs-lock/src/artifact-path.ts'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { assertArtifactCurrent, createArtifactCurrentGuard } from '../../session-persistence/src/coordinator/artifact-path-association.ts'
import { assertResultLineage, captureResultLineageGuard } from '../src/lifecycle/result-observation.ts'

async function fixture() {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'lineage-current-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'source' })
  return { root, coordinator, async close() { await coordinator.close(); await rm(root, { recursive: true, force: true }) } }
}

it('coalesces actual original metadata and before/after lineage proofs into one native batch', async () => {
  const f = await fixture()
  try {
    await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async read => {
      checked.batches = checked.proofs = 0
      assertResultLineage(read, ['source'], 'source')
      expect(checked.batches).toBe(1)
      expect(checked.proofs).toBeGreaterThan(0)
    })
  } finally { await f.close() }
})

it('flushes before a foreign metadata callback and refuses a real namespace replacement afterward', async () => {
  const f = await fixture(), directory = join(f.root, 'namespace')
  await mkdir(join(directory, 'child'), { recursive: true })
  const paths = createArtifactPathOwner(directory), proof = paths.capture(join(directory, 'child', 'value'))
  const current = createArtifactCurrentGuard(() => assertArtifactCurrent(proof))
  let calls = 0
  try {
    await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async read => {
      const metadata = read.metadata('source')
      const observation = { assertCurrent: current, binding: read.binding, metadata() {
        calls++
        expect(checked.proofs).toBeGreaterThan(0)
        renameSync(directory, directory + '-original')
        mkdirSync(join(directory, 'child'), { recursive: true })
        return metadata
      } }
      checked.batches = checked.proofs = 0
      expect(() => assertResultLineage(observation, ['source'], 'source')).toThrow()
      expect(calls).toBe(1)
    })
  } finally { paths.settleResources(); await f.close() }
})

it('does not inherit original metadata-reader batching through a copied receiver', async () => {
  const f = await fixture()
  try {
    await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async read => {
      let calls = 0
      const copied = { assertCurrent: read.assertCurrent, binding: read.binding, metadata(id: string) {
        expect(this).toBe(copied); calls++
        expect(checked.proofs).toBeGreaterThan(0)
        return read.metadata(id)
      } }
      checked.batches = checked.proofs = 0
      assertResultLineage(copied, ['source'], 'source')
      expect(calls).toBe(1)
      expect(checked.batches).toBeGreaterThan(1)
    })
  } finally { await f.close() }
})

it('preserves accessor counts and receivers without classifying through a getter', async () => {
  const f = await fixture()
  try {
    await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async read => {
      let currentReads = 0, metadataReads = 0
      const observation = { binding: read.binding,
        get assertCurrent() { currentReads++; return function(this: unknown) { expect(this).toBe(observation); read.assertCurrent() } },
        get metadata() { metadataReads++; return function(this: unknown, id: string) { expect(this).toBe(observation); return read.metadata(id) } },
      }
      expect(captureResultLineageGuard(observation)).toBeUndefined()
      expect([currentReads, metadataReads]).toEqual([0, 0])
      assertResultLineage(observation, ['source'], 'source')
      expect([currentReads, metadataReads]).toEqual([2, 1])
    })
  } finally { await f.close() }
})

it('keeps Proxy receivers unclassified and preserves their original method reads', async () => {
  const f = await fixture()
  try {
    await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async read => {
      const gets: PropertyKey[] = []
      const proxy = new Proxy(read, { get(target, key, receiver) { gets.push(key); return Reflect.get(target, key, receiver) } })
      expect(captureResultLineageGuard(proxy)).toBeUndefined()
      expect(gets).toEqual([])
      assertResultLineage(proxy, ['source'], 'source')
      expect(gets).toEqual(['assertCurrent', 'metadata', 'assertCurrent'])
    })
  } finally { await f.close() }
})

it('refuses assertion-method replacement from an opaque callback without invoking the replacement', async () => {
  const f = await fixture()
  try {
    await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async read => {
      let replacementCalls = 0
      const copied = { assertCurrent: read.assertCurrent, binding: read.binding, metadata(id: string) {
        copied.assertCurrent = () => { replacementCalls++ }
        return read.metadata(id)
      } }
      expect(() => assertResultLineage(copied, ['source'], 'source')).toThrow('Original result observation methods changed')
      expect(replacementCalls).toBe(0)
    })
  } finally { await f.close() }
})

it('does not revive an original observation after its actual scope retires', async () => {
  const f = await fixture()
  try {
    const retired = await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async read => read)
    expect(() => assertResultLineage(retired, ['source'], 'source')).toThrow()
  } finally { await f.close() }
})
