import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '../src/commit/facade.ts'
import { compileSemanticSeed } from '../src/semantic-seed.ts'
import { EMPTY_SEMANTIC_DEPENDENCY_DIGEST, encodeFactBatch, createSession, append, exportConversationSeed } from '@i-harness/core-session'

it.each(['metadata', 'request', 'lineage', 'seed', 'initial', 'closure'] as const)('refuses conflicting %s under the same child operation without appending or manufacturing a receipt', async change => {
  const evidenceRoot = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!
  const root = await mkdtemp(join(evidenceRoot, 'child-idempotency-'))
  const coordinator = createJsonlCommitCoordinator(root, { lock: { enabled: true, lockRoot: root } })
  try {
    const request = {
      invocation: { version: 1 as const, operationId: 'original', targetSessionId: 'child', createdAt: '2026-11-01T00:00:00.000Z', requestDigest: 'a'.repeat(64) },
      target: { kind: 'new' as const }, metadata: { title: 'original' }, lineage: { origin: 'subagent' as const, parentSession: 'parent', subagentProtocolVersion: 1 as const }, seed: compileSemanticSeed({ kind: 'none' }),
      initial: { inputId: 'original-input', text: 'original work', parentSessionId: 'parent', startedAt: 100, expiresAt: 200 },
    }
    await coordinator.createChildSession(request, { closure: EMPTY_SEMANTIC_DEPENDENCY_DIGEST })
    await coordinator.closeManagedDocument('child')
    const path = join(root, 'child', 'session.v15.jsonl'), bytes = await readFile(path)
    const source = createSession(); append(source, { type: 'user/message', text: 'different seed' })
    const exported = exportConversationSeed(source, { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
    if (exported.kind !== 'seed') throw Error('Original fixture seed unavailable')
    const replay = change === 'metadata' ? { ...request, metadata: { title: 'unwritten replacement' } }
      : change === 'request' ? { ...request, invocation: { ...request.invocation, requestDigest: 'c'.repeat(64) } }
      : change === 'lineage' ? { ...request, lineage: { ...request.lineage, parentSession: 'foreign' }, initial: { ...request.initial, parentSessionId: 'foreign' } }
      : change === 'seed' ? { ...request, seed: compileSemanticSeed(exported) }
      : change === 'initial' ? { ...request, initial: { ...request.initial, text: 'different input' } } : request
    await expect(coordinator.createChildSession(replay, { closure: change === 'closure' ? 'd'.repeat(64) : EMPTY_SEMANTIC_DEPENDENCY_DIGEST })).rejects.toBeTruthy()
    expect(await readFile(path)).toEqual(bytes)
  } finally {
    await coordinator.close()
    const tail = relative(evidenceRoot, root)
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

it('qualifies the exact stored initial birth prefix for the current original document owner across reopen', async () => {
  const evidenceRoot = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, root = await mkdtemp(join(evidenceRoot, 'child-receipt-owner-'))
  const coordinator = createJsonlCommitCoordinator(root, { lock: { enabled: true, lockRoot: root } })
  try {
    const request = {
      invocation: { version: 1 as const, operationId: 'initial-birth', targetSessionId: 'child', createdAt: '2026-11-01T00:00:00.000Z', requestDigest: 'b'.repeat(64) },
      target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'subagent' as const, parentSession: 'parent', subagentProtocolVersion: 1 as const },
      seed: compileSemanticSeed({ kind: 'none' }), initial: { inputId: 'original-input', text: 'original work', parentSessionId: 'parent', startedAt: 100, expiresAt: 200 },
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const born = await coordinator.createChildSession(request, { closure: EMPTY_SEMANTIC_DEPENDENCY_DIGEST }), action = born.document.beginAction()
      try {
        expect(born.receipt.completion.owner).toEqual(Object.getOwnPropertyDescriptor(action, 'owner')!.value)
        expect(born.receipt.initial).toMatchObject({ inputId: 'original-input', startedAt: 100, expiresAt: 200 })
        const key = born.receipt.completion.key, actual = born.document.view.events.slice(key.firstSeq, key.firstSeq + key.count)
        expect(encodeFactBatch(key.batchId, key.previousPrefixDigest, actual).key).toEqual(key)
        if (attempt === 0) expect((await action.facts.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
      } finally { action.finish(); await coordinator.closeManagedDocument('child') }
    }
  } finally {
    await coordinator.close()
    const tail = relative(evidenceRoot, root)
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

it('inspects only original committed birth evidence while rename/archive and spoofed metadata stay separate', async () => {
  const evidenceRoot = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, root = await mkdtemp(join(evidenceRoot, 'child-inspection-'))
  const coordinator = asSessionCoordinator(createJsonlCommitCoordinator(root))
  const request = {
    invocation: { version: 1 as const, operationId: 'actual-birth', targetSessionId: 'child', createdAt: '2026-11-01T00:00:00.000Z', requestDigest: 'a'.repeat(64) },
    target: { kind: 'new' as const }, metadata: { title: 'original' }, lineage: { origin: 'import' as const }, seed: compileSemanticSeed({ kind: 'none' }),
  }
  const never = async (): Promise<never> => { throw Error('No dependencies expected') }
  try {
    expect((await coordinator.bootstrapSemanticTarget(request, { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } })).kind).toMatch(/ready/)
    await coordinator.closeManagedDocument('child')
    const actual = (await coordinator.profile('child')).meta.semanticSeed!
    await coordinator.updateMeta('child', { title: 'manual title', archived: true, semanticSeed: { ...actual, requestDigest: 'b'.repeat(64) } })
    expect((await coordinator.inspectBootstrap(request.invocation)).kind).toBe('ready')
    expect((await coordinator.inspectBootstrap({ ...request.invocation, createdAt: '2026-11-02T00:00:00.000Z' })).kind).toBe('conflict')
    expect((await coordinator.inspectBootstrap({ ...request.invocation, requestDigest: 'b'.repeat(64) })).kind).toBe('conflict')
    await coordinator.create({ sessionId: 'no-birth' })
    await coordinator.updateMeta('no-birth', { semanticSeed: actual })
    expect((await coordinator.inspectBootstrap({ ...request.invocation, targetSessionId: 'no-birth' })).kind).toBe('conflict')
    expect((await coordinator.profile('child')).meta).toMatchObject({ title: 'manual title', archived: true })
  } finally {
    await coordinator.close()
    const tail = relative(evidenceRoot, root)
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
