import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSessionCoordinator } from '../src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { checkpointControls, ownerState, terminal, traceCheckpoint } from '../../core-session/test/source-checkpoint-controls.ts'

checkpointControls(async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'checkpoint-')), store = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction()
  return { action, view: document.view, assertOptional() { action.assertOpen() }, async cleanup(expectedRecovery) { if (expectedRecovery) await expect(store.close()).rejects.toThrow(); else await store.close() } }
}, 'committed')

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
