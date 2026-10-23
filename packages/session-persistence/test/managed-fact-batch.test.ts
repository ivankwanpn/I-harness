import { expect, it } from 'vitest'
import { createSessionCoordinator } from '../src/index.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'

const terminal = { type: 'context/recovery' as const, version: 1 as const, ownerSessionId: 'owner', recoveryId: 'original', logicalStepSeq: 0, bindingFingerprint: 'a'.repeat(64), rejectedInputFingerprint: 'b'.repeat(64), state: 'blocked' as const, retryConsumed: true }

it('refuses managed activation without actual exclusive ownership and owned batch backend', async () => {
  const backend = { id: 'jsonl', capabilities: { seekableRead: false, rawArtifacts: false } } as any
  const coordinator = createSessionCoordinator(backend)
  await expect(coordinator.openManagedDocument('s')).rejects.toMatchObject({ code: 'FACT_OWNER_UNSUPPORTED' })
})

it('uses the original managed metadata frame for immutable held terminal recovery after Stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-managed-recovery-')), backend = createJsonlBackend(root)
  const store = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await store.create()
  const document = await store.openManagedDocument(id), action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  try {
    const draft = { ...terminal, ownerSessionId: id }, original = source.recovery.capture(draft)
    draft.recoveryId = 'changed'
    action.stop()
    expect(await action.facts.metadata.admit(terminal)).toMatchObject({ kind: 'not-issued', code: 'FACT_CANCELLED' })
    expect(await original.admit()).toMatchObject({ kind: 'committed', receipt: { key: { count: 1 } } })
    expect(document.view.events.at(-1)).toMatchObject({ recoveryId: 'original', state: 'blocked' })
    expect(await source.recovery.capture({ ...terminal, ownerSessionId: id, state: 'resolved' }).admit()).toMatchObject({ kind: 'committed' })
    await source.close()
    expect(() => source.recovery.capture(terminal)).toThrow('closed')
    expect((await backend.read(id)).events.map(item => item.type === 'context/recovery' ? item.state : item.type)).toEqual(['blocked', 'resolved'])
  } finally { action.finish(); await store.close() }
})

it('quarantines invalid managed terminal drafts without invoking executable data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-managed-recovery-invalid-')), backend = createJsonlBackend(root)
  const store = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await store.create()
  const document = await store.openManagedDocument(id), action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  let reads = 0
  const accessor = Object.defineProperty({ ...terminal }, 'reason', { enumerable: true, get() { reads++; return 'unsafe' } })
  for (const draft of [{ ...terminal, state: 'required' }, { ...terminal, state: 'retry-started' }, { ...terminal, type: 'context/budget' }, { ...terminal, seq: 1 }, { ...terminal, ignorable: true }, { ...terminal, envelope: {} }, { ...terminal, extra: true }, accessor, Object.assign(new (class {})(), terminal), new Proxy(terminal, {})]) {
    expect(await source.recovery.capture(draft as never).admit()).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
  }
  expect(reads).toBe(0)
  expect((await backend.read(id)).events).toHaveLength(0)
  expect(() => document.beginAction()).toThrow('reconciliation')
  action.finish()
  await expect(source.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  await expect(store.close()).rejects.toThrow()
})
