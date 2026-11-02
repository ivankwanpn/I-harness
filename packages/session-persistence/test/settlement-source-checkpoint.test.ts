import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { BackendFactOutcome } from '../src/index.ts'
const journalProbes = vi.hoisted(() => new WeakMap<Function, { onIssue?: (key: import('@i-harness/core-session').BatchKey) => void; afterAppend?: (outcome: BackendFactOutcome) => BackendFactOutcome }>())
// Install the probe inside the original backend constructor, before its exact
// method descriptors are captured. The real journal append still owns the IO.
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts', async original => {
  const real = await original<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>()
  return { ...real, createFactJournalBackend(...args: Parameters<typeof real.createFactJournalBackend>) {
    const journal = real.createFactJournalBackend(...args), append = journal.appendOwnedBatch!, probe: NonNullable<ReturnType<typeof journalProbes.get>> = {}
    const observed: typeof append = async (...input) => { probe.onIssue?.(input[3].key); const outcome = await append(...input); return probe.afterAppend?.(outcome) ?? outcome }
    journalProbes.set(observed, probe)
    return { ...journal, appendOwnedBatch: observed }
  } }
})
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { checkpointControls, ownerState, terminal, traceCheckpoint } from '../../core-session/test/source-checkpoint-controls.ts'
const createSessionCoordinator = (backend: ReturnType<typeof createJsonlBackend>) => composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)

checkpointControls(async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'checkpoint-')), backend = createJsonlBackend(root), store = createSessionCoordinator(backend)
  const probe = journalProbes.get(backend.appendOwnedBatch!)!
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction()
  expect(document.view.formatVersion).toBe(14)
  return { action, view: document.view, assertOptional() { action.assertOpen() }, watchNativeIssues(listener) { probe.onIssue = listener; return () => { probe.onIssue = undefined } }, async cleanup(expectedRecovery) { if (expectedRecovery) await expect(store.close()).rejects.toThrow(); else await store.close() } }
}, 'committed')

it('keeps ordinary zero-argument pre-drain and post-drain behavior during a C-only late capture', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'ordinary-checkpoint-control-')), store = createSessionCoordinator(createJsonlBackend(root))
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction()
  let beforeLifecycle: string[] = []
  const source = action.registerSettlementSource(async () => { beforeLifecycle = document.view.events.filter(event => event.type === 'context/recovery').map(event => event.recoveryId) })
  const off = (await import('@i-harness/core-session')).subscribe(document.view, event => {
    if (event.type === 'context/recovery' && event.recoveryId === 'A') source.recovery.capture({ ...terminal, recoveryId: 'L' })
  })
  try {
    source.recovery.capture({ ...terminal, recoveryId: 'A' }); source.recovery.capture({ ...terminal, recoveryId: 'B' })
    await source.close()
    expect(beforeLifecycle).toEqual(['A', 'B'])
    expect(document.view.events.filter(event => event.type === 'context/recovery').map(event => event.recoveryId)).toEqual(['A', 'B', 'L'])
    expect(() => source.assertHeld()).toThrow()
  } finally { off(); action.finish(); await store.close() }
})

it('reconciles an already-issued unknown exact native key without allocating or issuing a replacement', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'checkpoint-key-')), backend = createJsonlBackend(root), store = createSessionCoordinator(backend)
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction(), { owner } = ownerState()
  const source = action.registerSettlementSource(async () => {}, undefined, owner), probe = journalProbes.get(backend.appendOwnedBatch!)!
  let issues = 0, receipt: import('@i-harness/core-session').FactReceipt | undefined
  probe.afterAppend = outcome => { issues++; if (outcome.kind === 'committed') { receipt = outcome.receipt; return { kind: 'unknown', key: receipt.key } }; return outcome }
  try {
    const fact = source.recovery.capture({ ...terminal, ownerSessionId: id })
    expect(await fact.admit()).toEqual({ kind: 'unknown', key: receipt!.key }); source.holdRecovery()
    expect(await source.checkpoint()).toEqual({ kind: 'settled' })
    const disposition = await fact.observe()
    expect(disposition).toEqual({ kind: 'committed', receipt, seqs: [0] }); expect(issues).toBe(1)
    traceCheckpoint('native-exact-unknown-reconciliation', { action, source, owner, fact, key: receipt!.key }, { cut: owner.readCut(), disposition, originalReceipt: receipt, issues })
    expect((await backend.read(id)).events).toHaveLength(1); await source.close()
  } finally { action.finish(); await store.close() }
})
