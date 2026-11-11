import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createSessionCoordinator, createReadOnlySessionCoordinator, type PersistenceBackend } from '../src/index.ts'
import { taskDocumentOperationsFor } from '../src/task-document-internal.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '../src/commit/facade.ts'
import { compileSemanticSeed } from '../src/semantic-seed.ts'

async function directory(run: (root: string) => Promise<void>) {
  const evidenceRoot = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, root = await mkdtemp(join(evidenceRoot, 'native-coordinator-'))
  try { await run(root) }
  finally {
    const tail = relative(evidenceRoot, root)
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
}

it.each(['jsonl', 'commit-log'] as const)('normal public %s composition creates current sessions and native task operations without a hidden validator', async store => {
  await directory(async root => {
    const coordinator = store === 'jsonl' ? createSessionCoordinator(createJsonlBackend(root)) : asSessionCoordinator(createJsonlCommitCoordinator(root, { lock: { enabled: true, lockRoot: root } }))
    try {
      expect(taskDocumentOperationsFor(coordinator)).toBeDefined()
      await coordinator.create({ sessionId: 'current' })
      expect(await coordinator.getDocument('task-current')).toMatchObject({ tasks: [], notifications: [] })
      const document = await coordinator.openManagedDocument('current'), action = document.beginAction()
      try { expect((await action.facts.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed') }
      finally { action.finish(); await document.close() }
      expect((await coordinator.snapshot!('current')).session.events).toContainEqual(expect.objectContaining({ type: 'plan/mode', mode: 'on' }))
    } finally { await coordinator.close() }
  })
})

it('rejects copied native constructor capabilities and preserves their immutable original identity', async () => {
  await directory(async root => {
    const backend = createJsonlBackend(root), descriptor = Object.getOwnPropertyDescriptor(backend, 'createCoordinator')!
    expect(() => Object.defineProperty(backend, 'createCoordinator', { value() { throw Error('Replacement must not run') } })).toThrow()
    const copied = { ...backend }
    Object.defineProperty(copied, 'createCoordinator', descriptor)
    expect(() => createSessionCoordinator(copied)).toThrow('Original JSONL backend receiver')
    const original = createSessionCoordinator(backend)
    try { await original.create({ sessionId: 'original' }) }
    finally { await original.close() }
  })
})

it.each(['jsonl', 'commit-log'] as const)('normal public %s semantic bootstrap and payload resume retain one original birth', async store => {
  await directory(async root => {
    const coordinator = store === 'jsonl' ? createSessionCoordinator(createJsonlBackend(root)) : asSessionCoordinator(createJsonlCommitCoordinator(root, { lock: { enabled: true, lockRoot: root } }))
    const request = {
      invocation: { version: 1 as const, operationId: 'bootstrap', targetSessionId: 'child', createdAt: '2026-11-01T00:00:00.000Z', requestDigest: 'a'.repeat(64) },
      target: { kind: 'new' as const }, metadata: { title: 'original' }, lineage: { origin: 'import' as const }, seed: compileSemanticSeed({ kind: 'none' }),
    }
    const never = async (): Promise<never> => { throw Error('Empty bootstrap has no dependency effects') }
    const guards = { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } }
    try {
      const first = await coordinator.bootstrapSemanticTarget(request, guards)
      expect(first.kind).toMatch(/ready/)
      if (first.kind !== 'ready' && first.kind !== 'already-ready') throw Error('Original public birth failed')
      const manifest = first.receipt.manifestDigest
      await coordinator.closeManagedDocument('child')
      const again = await coordinator.resumeSemanticTarget(request.invocation, guards, request)
      expect(again.kind).toMatch(/ready/)
      if (again.kind !== 'ready' && again.kind !== 'already-ready') throw Error('Original public replay failed')
      expect(again.receipt.manifestDigest).toBe(manifest)
      expect(again.document.view.events.filter(event => event.type === 'session/bootstrap')).toHaveLength(1)
      await coordinator.closeManagedDocument('child')
      expect((await coordinator.bootstrapSemanticTarget({ ...request, metadata: { title: 'different' } }, guards)).kind).toBe('refused')
    } finally { await coordinator.close() }
  })
})

it('refuses unsupported, mutable, and accessor factory shapes without invoking them', () => {
  let invoked = false
  const accessor = Object.defineProperty({}, 'createCoordinator', { get() { invoked = true; throw Error('Accessor must not run') } })
  const mutable = { createCoordinator() { invoked = true; throw Error('Unqualified callback must not run') } }
  for (const backend of [{}, accessor, mutable]) expect(() => createSessionCoordinator(backend as PersistenceBackend)).toThrow('original writable coordinator factory')
  expect(invoked).toBe(false)
})

it.each(['appendOwnedBatch', 'readJournalPrefix', 'getDocument'] as const)('does not publish a full native coordinator when construction withheld %s', async method => {
  await directory(async root => {
    const backend = createJsonlBackend(root, { wrap(original) { delete (original as unknown as Record<string, unknown>)[method] } })
    expect(() => createSessionCoordinator(backend)).toThrow(`capability unavailable: ${method}`)
  })
})

it('makes disabled ownership an explicit read-only choice rather than publishing an unusable writer', async () => {
  await directory(async root => {
    const backend = createJsonlBackend(root)
    expect(() => createSessionCoordinator(backend, { lock: { enabled: false } })).toThrow('createReadOnlySessionCoordinator')
    const reader = createReadOnlySessionCoordinator(backend, { lock: { enabled: false } })
    try { expect(await reader.list()).toEqual([]); expect('create' in reader).toBe(false) }
    finally { await reader.close() }
  })
})

it('keeps original lease option getters lazy across the native constructor delegation', async () => {
  await directory(async root => {
    let reads = 0
    const options = { get acquireDeadlineMs() { expect(this).toBe(options); reads++; return 1000 } }
    const coordinator = createSessionCoordinator(createJsonlBackend(root), options)
    try {
      expect(reads).toBe(0)
      await coordinator.create({ sessionId: 'lazy-budget' })
      expect(reads).toBeGreaterThan(0)
    } finally { await coordinator.close() }
  })
})
