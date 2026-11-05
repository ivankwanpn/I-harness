import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createRuntimeContext } from '../src/index.ts'

const installation = vi.hoisted(() => ({ blocked: false }))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return{...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const journal=original.createFactJournalBackend(...args);return{...journal,appendOwnedBatch:vi.fn(journal.appendOwnedBatch),reconcileOwnedBatch:vi.fn(journal.reconcileOwnedBatch)}}}})
vi.mock('@i-harness/core-session', async original => {
  const api = await original<typeof import('@i-harness/core-session')>()
  return { ...api, createManagedSessionState(...args: Parameters<typeof api.createManagedSessionState>) {
    const state = api.createManagedSessionState(...args), stage = state.stage
    state.stage = events => { const captured = stage(events); return { ...captured, install() { if (installation.blocked && events.some(event => event.type === 'runtime/context')) throw Error('actual runtime frame installation held'); captured.install() } } }
    return state
  } }
})

async function fixture(disposition: 'committed' | 'absent' | 'install') {
  const root = await mkdtemp(join(tmpdir(), 'ih-runtime-disposition-')), backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } },taskDocumentStorageContract), { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const append = vi.mocked(backend.appendOwnedBatch!).getMockImplementation()!, reconcile = vi.mocked(backend.reconcileOwnedBatch!).getMockImplementation()!
  let key: BatchKey | undefined, ready = false, issues = 0, getters = 0, factories = 0, captures = 0, finishes = 0, retains = 0, releases = 0, text = 'first'
  vi.mocked(backend.appendOwnedBatch!).mockImplementation(async (...args) => {
    const records = decodeFactBatch(args[3].bytes).events
    if (records.some(event => event.type === 'runtime/context')) {
      issues++
      if (!key) {
        key = args[3].key
        if (disposition === 'install') { installation.blocked = true; return append(...args) }
        if (disposition === 'committed') await append(...args)
        return { kind: 'unknown', key }
      }
    }
    return append(...args)
  })
  vi.mocked(backend.reconcileOwnedBatch!).mockImplementation((...args) => !ready && disposition !== 'install' && key?.batchId === args[3].key.batchId ? Promise.resolve({ kind: 'unknown', key: args[3].key }) : reconcile(...args))
  const rc = createRuntimeContext(document.view, signal => {
    factories++; const action = document.beginAction(signal)
    return { finish() { finishes++; action.finish() }, captureRuntimeContext(record, check) { captures++; return action.captureRuntimeContext(record, check) } }
  })
  rc.registerSection('instructions', () => { getters++; return text })
  const retain = () => { retains++; return { async release() { releases++ } } }
  return { rc, retain, get counts() { return { issues, getters, factories, captures, finishes, retains, releases } }, get key() { return key },
    next() { text = 'second' }, allow() { ready = true; installation.blocked = false },
    async close() { ready = true; installation.blocked = false; await rc.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) },
  }
}

it.each(['committed', 'install'] as const)('original-only management settles actual %s without getter/action/retain or publication replay', async disposition => {
  const f = await fixture(disposition)
  try {
    await expect(f.rc.render(undefined, f.retain)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(f.counts).toEqual({ issues: 1, getters: 1, factories: 1, captures: 1, finishes: 0, retains: 1, releases: 0 })
    await expect(f.rc.settleOriginals()).rejects.toThrow()
    f.next()
    await expect(f.rc.render(undefined, f.retain)).rejects.toThrow()
    expect(f.counts).toEqual({ issues: 1, getters: 2, factories: 1, captures: 1, finishes: 0, retains: 1, releases: 0 })
    f.allow(); await f.rc.settleOriginals()
    expect(f.counts).toEqual({ issues: 1, getters: 2, factories: 1, captures: 1, finishes: 1, retains: 1, releases: 1 })
    await f.rc.render(undefined, f.retain)
    expect(f.counts).toEqual({ issues: 2, getters: 3, factories: 2, captures: 2, finishes: 2, retains: 2, releases: 2 })
  } finally { await f.close() }
})

it('an absent original settles as a terminal disposition and does not fence later renders', async () => {
  const f = await fixture('absent')
  try {
    await expect(f.rc.render(undefined, f.retain)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    // Absent writes nothing, so there is no pending mutation to fence: the
    // settlement records the refusal and resolves.
    await expect(f.rc.settleOriginals()).resolves.toBeUndefined()
    expect(f.counts.issues).toBe(1)
    f.next()
    await f.rc.render(undefined, f.retain)
    expect(f.counts.issues).toBe(2)
    f.allow()
    await expect(f.rc.settleOriginals()).resolves.toBeUndefined()
    await f.rc.render(undefined, f.retain)
  } finally { await f.close() }
})

it('ordinary render reports an original known absence before any new capture and a later explicit render admits fresh bytes', async () => {
  const f = await fixture('absent')
  try {
    await expect(f.rc.render(undefined, f.retain)).rejects.toThrow()
    f.next(); f.allow()
    await expect(f.rc.render(undefined, f.retain)).rejects.toMatchObject({ outcome: { kind: 'absent', key: f.key } })
    expect(f.counts).toEqual({ issues: 1, getters: 2, factories: 1, captures: 1, finishes: 1, retains: 1, releases: 1 })
    await f.rc.render(undefined, f.retain)
    expect(f.counts.issues).toBe(2); expect(f.counts.captures).toBe(2)
  } finally { await f.close() }
})

it('close retains original unknown resources, fences new renders and retries only the same original disposition', async () => {
  const f = await fixture('committed')
  try {
    await expect(f.rc.render(undefined, f.retain)).rejects.toThrow()
    await expect(f.rc.close()).rejects.toThrow()
    await expect(f.rc.render(undefined, f.retain)).rejects.toThrow('closed')
    expect(f.counts).toEqual({ issues: 1, getters: 1, factories: 1, captures: 1, finishes: 0, retains: 1, releases: 0 })
    f.allow(); await f.rc.close()
    expect(f.counts).toEqual({ issues: 1, getters: 1, factories: 1, captures: 1, finishes: 1, retains: 1, releases: 1 })
  } finally { await f.close() }
})
