import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { compileSemanticSeed } from '../src/semantic-seed.ts'
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createMutations } from '../src/coordinator/mutations.ts'
import { createLoads } from '../src/coordinator/load.ts'
import { createManagedDocuments } from '../src/coordinator/managed-documents.ts'
import { createProcessReadLatches } from '../src/coordinator/process-read-latches.ts'

it('fences the actual bootstrap target from admission through ready publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-bootstrap-latch-')), backend = createJsonlBackend(root), options = { lock: { enabled: true } }
  const ownership = createOwnership(backend, options), latches = createProcessReadLatches(), mutations = createMutations(backend, ownership, 200, () => {})
  const loads = createLoads(backend, ownership, mutations), managed = createManagedDocuments(backend, ownership, loads.loadOwned, options, () => {}, mutations, latches)
  const invocation = { version: 1 as const, operationId: 'process-bootstrap', targetSessionId: 'target', createdAt: new Date().toISOString(), requestDigest: 'a'.repeat(64) }
  const request = { invocation, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'import' as const }, seed: compileSemanticSeed({ kind: 'none' }) }
  const never = async (): Promise<never> => { throw new Error('no dependencies') }
  try {
    const reader = latches.capture({ sessionId: 'target', documentKeys: [], mode: 'cold' })
    const operation = managed.bootstrapSemanticTarget(request, { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } })
    const denied = (() => { try { reader.assertCurrent(); return false } catch { return true } })()
    expect((await operation).kind).toBe('ready'); expect(denied).toBe(true)
  } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }) }
})

it('retains the original target witness through a blocked bootstrap and its actual resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-bootstrap-retry-')), backend = createJsonlBackend(root), options = { lock: { enabled: true } }
  const original = backend.prepareBootstrapHeader!
  backend.prepareBootstrapHeader = async (...args) => { await original(...args); return { kind: 'unknown' } }
  const ownership = createOwnership(backend, options), latches = createProcessReadLatches(), mutations = createMutations(backend, ownership, 200, () => {})
  const loads = createLoads(backend, ownership, mutations), managed = createManagedDocuments(backend, ownership, loads.loadOwned, options, () => {}, mutations, latches)
  const invocation = { version: 1 as const, operationId: 'process-retry', targetSessionId: 'target', createdAt: new Date().toISOString(), requestDigest: 'b'.repeat(64) }
  const request = { invocation, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'import' as const }, seed: compileSemanticSeed({ kind: 'none' }) }
  const never = async (): Promise<never> => { throw new Error('no dependencies') }, guards = { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } }
  try {
    expect((await managed.bootstrapSemanticTarget(request, guards)).kind).toBe('blocked')
    expect(() => latches.capture({ sessionId: 'target', documentKeys: [], mode: 'cold' })).toThrow()
    backend.prepareBootstrapHeader = original
    expect(['ready', 'already-ready']).toContain((await managed.resumeSemanticTarget(invocation, guards, request)).kind)
    expect(() => latches.capture({ sessionId: 'target', documentKeys: [], mode: 'cold' })).not.toThrow()
  } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }) }
})
