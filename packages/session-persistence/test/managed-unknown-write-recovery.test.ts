import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionCoordinator, createControlledJsonlBackend, ownedControls } from './helpers/composed.ts'
import { acquireManagedExecution } from '../src/execution-internal.ts'

/**
 * A failed append must never silently retire its batch, and an unresolved
 * unknown must never leave the owned writer permanently occupied: the only
 * legal way out of quarantine is the original pending frame's explicit
 * reconciliation, after which the same document accepts a legitimate write.
 */
it('reconciles an issued unknown batch to its durable commit and keeps the writer usable', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'ih-managed-unknown-commit-'))
  const backend = createControlledJsonlBackend(root), store = createSessionCoordinator(backend)
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction()
  const append = ownedControls(backend).append
  try {
    let dropped: import('@i-harness/core-session').BatchKey | undefined
    ownedControls(backend).append = async (...args) => {
      const outcome = await append(...args)
      // The bytes are durable, but the caller never receives the commit result.
      if (!dropped && outcome.kind === 'committed') {
        dropped = outcome.receipt.key
        return { kind: 'unknown', key: outcome.receipt.key }
      }
      return outcome
    }
    expect(await action.facts.metadata.admit({ type: 'sandbox/mode', mode: 'read-only' })).toMatchObject({ kind: 'unknown' })
    expect(dropped).toBeDefined()
    // No silent data loss: the public view did not advance and new work fails closed.
    expect(document.view.events).toHaveLength(0)
    expect(() => document.assertReady()).toThrow()
    expect(await action.facts.metadata.admit({ type: 'sandbox/mode', mode: 'read-only' })).toMatchObject({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    // The original pending frame reconciles to the durable commit it actually wrote.
    expect(await document.reconcile(dropped!)).toMatchObject({ kind: 'committed' })
    expect(document.view.events.map(event => event.type)).toEqual(['sandbox/mode'])
    document.assertReady()
    // The same writer accepts a later legitimate append from the recovered prefix.
    expect(await action.facts.metadata.admit({ type: 'sandbox/mode', mode: 'workspace-write' })).toMatchObject({ kind: 'committed' })
    expect((await backend.read(id)).events.map(event => event.type)).toEqual(['sandbox/mode', 'sandbox/mode'])
    expect(() => document.assertReady()).not.toThrow()
  } finally {
    ownedControls(backend).append = append
    action.finish()
    await store.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('recovers an issued unknown batch proven absent and accepts the legitimate retry', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'ih-managed-unknown-absent-'))
  const backend = createControlledJsonlBackend(root), store = createSessionCoordinator(backend)
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction()
  const append = ownedControls(backend).append
  try {
    let dropped: import('@i-harness/core-session').BatchKey | undefined
    ownedControls(backend).append = async (...args) => {
      if (dropped) return append(...args)
      const [, owner, , batch] = args
      // The batch is issued but never written: reconciliation must prove absence.
      owner.beforeIssue()
      dropped = batch.key
      return { kind: 'unknown', key: batch.key }
    }
    expect(await action.facts.metadata.admit({ type: 'sandbox/mode', mode: 'read-only' })).toMatchObject({ kind: 'unknown' })
    expect(() => document.assertReady()).toThrow()
    expect(await action.facts.metadata.admit({ type: 'sandbox/mode', mode: 'read-only' })).toMatchObject({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    expect(await document.reconcile(dropped!)).toMatchObject({ kind: 'absent' })
    document.assertReady()
    // A second reconcile of the same retired frame is a settled no-op, never a hang.
    expect(await document.reconcile(dropped!)).toMatchObject({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    expect(await action.facts.metadata.admit({ type: 'sandbox/mode', mode: 'read-only' })).toMatchObject({ kind: 'committed' })
    expect((await backend.read(id)).events.map(event => event.type)).toEqual(['sandbox/mode'])
  } finally {
    ownedControls(backend).append = append
    action.finish()
    await store.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('clears a never-issued failed write without occupying the writer', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'ih-managed-unissued-'))
  const backend = createControlledJsonlBackend(root), store = createSessionCoordinator(backend)
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction()
  const append = ownedControls(backend).append
  try {
    let fail = true
    ownedControls(backend).append = async (...args) => { if (fail) throw new Error('controlled append transport failure'); return append(...args) }
    expect((await action.facts.metadata.admit({ type: 'sandbox/mode', mode: 'read-only' })).kind).toBe('not-issued')
    // A never-issued failure is provably absent: the writer must accept the retry.
    fail = false
    document.assertReady()
    expect(await action.facts.metadata.admit({ type: 'sandbox/mode', mode: 'read-only' })).toMatchObject({ kind: 'committed' })
    expect((await backend.read(id)).events.map(event => event.type)).toEqual(['sandbox/mode'])
  } finally {
    ownedControls(backend).append = append
    action.finish()
    await store.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('lets the staged writer reconcile an unissued conflict to absence instead of trapping it', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'ih-managed-staged-conflict-'))
  const backend = createControlledJsonlBackend(root), coordinator = createSessionCoordinator(backend)
  await coordinator.create({ sessionId: 'parent' })
  const execution = await acquireManagedExecution(coordinator, 'parent'), document = execution.owner as unknown as import('../src/index.ts').ManagedDocument, action = execution.owner.beginAction()
  const append = ownedControls(backend).append, reconcile = ownedControls(backend).reconcile
  try {
    let key: import('@i-harness/core-session').BatchKey | undefined
    ownedControls(backend).append = async (...args) => { key = args[3].key; return { kind: 'conflict', key: args[3].key } }
    expect(await action.facts.metadata.admit({ type: 'sandbox/mode', mode: 'read-only' })).toMatchObject({ kind: 'conflict' })
    expect(key).toBeDefined()
    expect(() => document.assertReady()).toThrow()
    // The backend still reports a conflict for the never-issued frame; that outcome
    // is provably absent, so explicit reconciliation must clear the staged writer.
    ownedControls(backend).append = append
    ownedControls(backend).reconcile = async (...args) => ({ kind: 'conflict', key: args[3].key })
    expect(await document.reconcile(key!)).toMatchObject({ kind: 'absent' })
    document.assertReady()
    ownedControls(backend).reconcile = reconcile
    expect(await action.facts.metadata.admit({ type: 'sandbox/mode', mode: 'read-only' })).toMatchObject({ kind: 'committed' })
    expect((await backend.read('parent')).events.map(event => event.type)).toEqual(['sandbox/mode'])
  } finally {
    ownedControls(backend).append = append
    ownedControls(backend).reconcile = reconcile
    action.finish()
    await execution.close().catch(() => {})
    await coordinator.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

