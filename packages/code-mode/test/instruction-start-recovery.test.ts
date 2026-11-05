import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createSession, decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createToolRegistry, instructionReplan } from '@i-harness/core-tools'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { registerCodeMode } from '../src/register.ts'

it('retains the original cell pin through an uncertain started receipt until interrupted settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-cell-start-recovery-')), backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), ctx = createContext(), origin = Object.freeze({ kind: 'accepted-instruction-call' as const })
  let released = 0, key: BatchKey | undefined, blocked = true
  const originalAppend = backend.appendOwnedBatch!, originalReconcile = backend.reconcileOwnedBatch!
  backend.reconcileOwnedBatch = async (...args) => blocked ? { kind: 'unknown', key: args[3].key } : originalReconcile(...args)
  backend.appendOwnedBatch = async (...args) => {
    const result = await originalAppend(...args)
    if (!key && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'code/cell' && event.state === 'started')) { key = args[3].key; return { kind: 'unknown', key } }
    return result
  }
  const tools = createToolRegistry(ctx, { instructionOriginVerifier: value => value === origin, instructionCellRetainer: () => ({ bind() { return origin }, async preflight() {}, async release() { released++ } }) })
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  try {
    await mount.ready!()
    const capture = tools.capture({ name: 'code_exec', args: { code: 'text("must not execute")' } })
    await expect(tools.dispatch(await tools.prepareCaptured(capture, undefined, origin))).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(key).toBeDefined(); expect(released).toBe(0)
    await expect(mount.dispose()).rejects.toBeDefined(); expect(released).toBe(0)
    blocked = false; await document.reconcile(key!); await mount.dispose()
    expect(released).toBe(1)
    expect((await backend.read(id)).events.filter(event => event.type === 'code/cell').map(event => event.state)).toEqual(['started', 'interrupted'])
  } finally { blocked = false; await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})

it('retains the original cell pin while Stop races a held started receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-cell-start-stop-')), backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), ctx = createContext(), origin = Object.freeze({ kind: 'accepted-instruction-call' as const })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), stop = new AbortController()
  let released = 0
  const originalAppend = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    const result = await originalAppend(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'code/cell' && event.state === 'started')) { entered.resolve(); await release.promise }
    return result
  }
  const tools = createToolRegistry(ctx, { instructionOriginVerifier: value => value === origin, instructionCellRetainer: () => ({ bind() { return origin }, async preflight() {}, async release() { released++ } }) })
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  try {
    await mount.ready!()
    const capture = tools.capture({ name: 'code_exec', args: { code: 'text("must not execute")' } })
    const work = tools.dispatch(await tools.prepareCaptured(capture, stop.signal, origin)); void work.catch(() => {})
    await entered.promise; stop.abort('Stop before worker'); expect(released).toBe(0)
    release.resolve(); await expect(work).rejects.toBeDefined(); await mount.dispose()
    expect(released).toBe(1)
    const states = (await backend.read(id)).events.filter(event => event.type === 'code/cell').map(event => event.state)
    expect(states[0]).toBe('started'); expect(states).toHaveLength(2); expect(['terminated', 'interrupted']).toContain(states[1])
  } finally { release.resolve(); await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})

it('retains the original cell pin and failed terminal through an unknown replan receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-cell-replan-recovery-')), backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), ctx = createContext(), origin = Object.freeze({ kind: 'accepted-instruction-call' as const })
  let released = 0, key: BatchKey | undefined, blocked = true, effects = 0
  const originalAppend = backend.appendOwnedBatch!, originalReconcile = backend.reconcileOwnedBatch!
  backend.reconcileOwnedBatch = async (...args) => blocked ? { kind: 'unknown', key: args[3].key } : originalReconcile(...args)
  backend.appendOwnedBatch = async (...args) => {
    const result = await originalAppend(...args)
    if (!key && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'code/cell' && event.state === 'failed')) { key = args[3].key; return { kind: 'unknown', key } }
    return result
  }
  const tools = createToolRegistry(ctx, { instructionsRequired: true, instructionOriginVerifier: value => value === origin, instructionCellRetainer: () => ({ bind() { return origin }, async preflight() { throw instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'unseen-rules', currentFingerprint: 'current' }) }, async release() { released++ } }) })
  tools.register({ name: 'write', description: '', inputSchema: {}, captureNativePlan: () => ({ targets: [{ path: process.cwd(), kind: 'directory', mode: 'mutate' }], operation: {} }), execute: async () => { effects++ } })
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  try {
    await mount.ready!()
    const capture = tools.capture({ name: 'code_exec', args: { code: "try { await tools.write({}) } catch { text('caught'); store('bad', true) }", yield_time_ms: 5000 } })
    await expect(tools.dispatch(await tools.prepareCaptured(capture, undefined, origin))).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(key).toBeDefined(); expect([released, effects]).toEqual([0, 0])
    await expect(mount.dispose()).rejects.toBeDefined(); expect(released).toBe(0)
    blocked = false; await document.reconcile(key!); await mount.dispose()
    expect(released).toBe(1)
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'code/cell').map(event => event.state)).toEqual(['started', 'failed'])
    expect(events.filter(event => event.type === 'code/store')).toEqual([])
  } finally { blocked = false; await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})

it('retains the original successful cell terminal when its pin release needs retry', async () => {
  const ctx = createContext(), session = createSession(), origin = Object.freeze({ kind: 'accepted-instruction-call' as const })
  let releases = 0
  const tools = createToolRegistry(ctx, { instructionOriginVerifier: value => value === origin, instructionCellRetainer: () => ({ bind() { return origin }, async preflight() {}, async release() { if (++releases === 1) throw new Error('original release failure') } }) })
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: 'mixed' } })
  try {
    const capture = tools.capture({ name: 'code_exec', args: { code: 'text("real")', yield_time_ms: 5000 } })
    await expect(tools.dispatch(await tools.prepareCaptured(capture, undefined, origin))).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(session.events.filter(event => event.type === 'code/cell').map(event => event.state)).toEqual(['started', 'completed'])
    await mount.dispose()
    expect(releases).toBe(2)
    expect(session.events.filter(event => event.type === 'code/cell').map(event => event.state)).toEqual(['started', 'completed'])
  } finally { await mount.dispose().catch(() => {}) }
})

it('does not release a policy-retired cell pin before its uncertain terminal settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-cell-policy-recovery-')), backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), ctx = createContext(), origin = Object.freeze({ kind: 'accepted-instruction-call' as const })
  let released = 0, key: BatchKey | undefined, blocked = true
  const originalAppend = backend.appendOwnedBatch!, originalReconcile = backend.reconcileOwnedBatch!
  backend.reconcileOwnedBatch = async (...args) => blocked ? { kind: 'unknown', key: args[3].key } : originalReconcile(...args)
  backend.appendOwnedBatch = async (...args) => {
    const result = await originalAppend(...args)
    if (!key && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'code/cell' && event.state === 'terminated')) { key = args[3].key; return { kind: 'unknown', key } }
    return result
  }
  const tools = createToolRegistry(ctx, { instructionOriginVerifier: value => value === origin, instructionCellRetainer: () => ({ bind() { return origin }, async preflight() {}, async release() { released++ } }) })
  tools.register({ name: 'blocked', description: '', inputSchema: {}, execute: async () => { throw new Error('must not execute') } })
  ctx.on('tools/pre-execute', input => { if ((input as { name: string }).name === 'blocked') throw Object.assign(new Error('denied'), { policyRefusal: true }) })
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  try {
    await mount.ready!()
    const capture = tools.capture({ name: 'code_exec', args: { code: 'await tools.blocked({})', yield_time_ms: 5000 } })
    await expect(tools.dispatch(await tools.prepareCaptured(capture, undefined, origin))).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(key).toBeDefined(); expect(released).toBe(0)
    await expect(mount.dispose()).rejects.toBeDefined(); expect(released).toBe(0)
    blocked = false; await document.reconcile(key!); await mount.dispose()
    expect(released).toBe(1)
    expect((await backend.read(id)).events.filter(event => event.type === 'code/cell').map(event => event.state)).toEqual(['started', 'terminated'])
  } finally { blocked = false; await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})
