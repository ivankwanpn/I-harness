import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSessionCoordinator } from '../src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { checkpointControls, ownerState, terminal, traceCheckpoint } from '../../core-session/test/source-checkpoint-controls.ts'

checkpointControls(async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'checkpoint-')), backend = createJsonlBackend(root), store = createSessionCoordinator(backend, { lock: { enabled: true } })
  const append = backend.appendOwnedBatch!.bind(backend)
  let onIssue: ((key: import('@i-harness/core-session').BatchKey) => void) | undefined
  backend.appendOwnedBatch = async (...args) => { onIssue?.(args[3].key); return append(...args) }
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction()
  return { action, view: document.view, assertOptional() { action.assertOpen() }, watchNativeIssues(listener) { onIssue = listener; return () => { onIssue = undefined } }, async cleanup(expectedRecovery) { if (expectedRecovery) await expect(store.close()).rejects.toThrow(); else await store.close() } }
}, 'committed')

it('keeps ordinary zero-argument pre-drain and post-drain behavior during a C-only late capture', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'ordinary-checkpoint-control-')), store = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
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
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'checkpoint-key-')), backend = createJsonlBackend(root), store = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction(), { owner } = ownerState()
  const source = action.registerSettlementSource(async () => {}, undefined, owner), append = backend.appendOwnedBatch!
  let issues = 0, receipt: import('@i-harness/core-session').FactReceipt | undefined
  backend.appendOwnedBatch = async (...args) => { issues++; const outcome = await append(...args); if (outcome.kind === 'committed') { receipt = outcome.receipt; return { kind: 'unknown', key: receipt.key } }; return outcome }
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
