import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { FactRecoveryRequiredError } from '@i-harness/core-session'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createToolRegistry, retainedToolOutcome, type RetainedOutcomeSink } from '../src/index.ts'

it('binds retained output to the actual prepared call and held source, consumes once and refuses an old incarnation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-registry-source-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let sink!: RetainedOutcomeSink, bodies = 0
  tools.register({ name: 'source', description: '', inputSchema: {}, execute: async (_args, exec) => {
    sink = exec.retainOutcome!(); sink.observed(); bodies++; sink.unavailable()
    throw new FactRecoveryRequiredError()
  } })
  try {
    const prepared = await tools.prepare({ name: 'source', args: {} }, undefined, { session: document.view, sessionId: id, settlementSource: source })
    const error = await tools.dispatch(prepared).then(() => { throw new Error('Expected recovery') }, error => error)
    const retained = retainedToolOutcome(error, prepared)!
    expect(await retained.take()).toEqual({ kind: 'recovery-required' })
    const another = await tools.prepare({ name: 'source', args: {} }, undefined, { session: document.view, sessionId: id, settlementSource: source })
    expect(retainedToolOutcome(error, another)).toBeUndefined()
    const value = { actual: 'body output' }
    sink.ready(value)
    expect(await retained.take()).toEqual({ kind: 'ready', output: value })
    expect(await retained.take()).toEqual({ kind: 'recovery-required' })
    expect(bodies).toBe(1)
    action.finish(); await document.close(); await coordinator.releaseOwnership(id)
    const reopened = await coordinator.openManagedDocument(id)
    expect(reopened.view).not.toBe(document.view)
    await expect(retained.take()).rejects.toMatchObject({ code: 'FACT_CLOSED' })
    expect(() => sink.ready({ actual: 'late replacement' })).toThrow()
  } finally { await coordinator.close().catch(() => {}); await ctx.scope.unmount() }
})

it('refuses a different document source before body effects and never brands a payload-shaped recovery error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-registry-fake-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const a = await coordinator.create(), b = await coordinator.create()
  const left = await coordinator.openManagedDocument(a.id), right = await coordinator.openManagedDocument(b.id)
  const action = left.beginAction(), source = action.registerSettlementSource(async () => {})
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let bodies = 0
  const fake = Object.assign(new Error('similar recovery error'), { code: 'FACT_RECOVERY_REQUIRED', retained: { output: 'invented' } })
  tools.register({ name: 'fake', description: '', inputSchema: {}, execute: async () => { bodies++; throw fake } })
  try {
    await expect(tools.prepare({ name: 'fake', args: {} }, undefined, { session: right.view, sessionId: b.id, settlementSource: source })).rejects.toMatchObject({ code: 'FACT_OWNER_UNSUPPORTED' })
    expect(bodies).toBe(0)
    const prepared = await tools.prepare({ name: 'fake', args: {} }, undefined, { session: left.view, sessionId: a.id, settlementSource: source })
    await expect(tools.dispatch(prepared)).rejects.toBe(fake)
    expect(retainedToolOutcome(fake, prepared)).toBeUndefined()
    expect(bodies).toBe(1)
    expect(left.view.events).toEqual([]); expect(right.view.events).toEqual([])
  } finally { action.finish(); await coordinator.close().catch(() => {}); await ctx.scope.unmount() }
})

it('retains an unsupported thenable as recovery data and never returns it as a ready output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-registry-thenable-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let sink!: RetainedOutcomeSink, invoked = 0
  tools.register({ name: 'retained', description: '', inputSchema: {}, execute: async (_args, exec) => { sink = exec.retainOutcome!(); sink.observed(); throw new FactRecoveryRequiredError() } })
  try {
    const prepared = await tools.prepare({ name: 'retained', args: {} }, undefined, { session: document.view, settlementSource: source })
    const error = await tools.dispatch(prepared).then(() => { throw new Error('Expected recovery') }, error => error)
    expect(() => sink.ready({ then() { invoked++ } })).toThrow(FactRecoveryRequiredError)
    expect(await retainedToolOutcome(error, prepared)!.take()).toEqual({ kind: 'recovery-required' })
    expect(invoked).toBe(0)
    expect(() => document.beginAction()).toThrow(FactRecoveryRequiredError)
    await expect(document.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  } finally { action.finish(); await coordinator.close().catch(() => {}); await ctx.scope.unmount() }
})

it('permits a permanent recovery latch only for the actual observed unresolved source, never before observation or after consumption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-registry-latch-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let consumed!: RetainedOutcomeSink
  tools.register({ name: 'settled', description: '', inputSchema: {}, execute: async (_args, exec) => {
    consumed = exec.retainOutcome!()
    expect(() => consumed.requireRecovery()).toThrow(FactRecoveryRequiredError)
    consumed.observed(); consumed.ready('actual settled output')
    return 'actual settled output'
  } })
  tools.register({ name: 'failed', description: '', inputSchema: {}, execute: async (_args, exec) => {
    const sink = exec.retainOutcome!()
    sink.observed(); sink.requireRecovery()
    throw new FactRecoveryRequiredError()
  } })
  try {
    const settled = await tools.prepare({ name: 'settled', args: {} }, undefined, { session: document.view, settlementSource: source })
    expect(await tools.dispatch(settled)).toBe('actual settled output')
    expect(() => consumed.requireRecovery()).toThrow(FactRecoveryRequiredError)
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).toMatchObject({ kind: 'committed' })
    const failed = await tools.prepare({ name: 'failed', args: {} }, undefined, { session: document.view, settlementSource: source })
    const error = await tools.dispatch(failed).catch(error => error)
    expect(await retainedToolOutcome(error, failed)!.take()).toEqual({ kind: 'recovery-required' })
    expect(() => document.beginAction()).toThrow(FactRecoveryRequiredError)
  } finally { action.finish(); await coordinator.close().catch(() => {}); await ctx.scope.unmount() }
})
