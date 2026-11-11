import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import type { SessionAssembly, SessionService } from '@i-harness/session-executor'
import { createInstructionViews } from '../src/instructions/views.ts'
import { createDesktopRouter } from '../src/router.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-i6-lifetime-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  const { id } = await coordinator.create(), { id: child } = await coordinator.create({ origin: 'subagent', parentSession: id, subagentProtocolVersion: 1, seedLength: 0 })
  let live = true
  const owner = { read: () => ({ state: 'ready' as const }), subscribe: () => () => {} }
  const assembly = { instructionDiagnostics: () => live ? owner : undefined, subagentState: () => ({ agentTable: [{ sessionId: child, path: '/root/child', status: 'waiting' }] }), liveChildSession: () => ({}) } as unknown as SessionAssembly
  const listeners = new Set<() => void>()
  const service = { liveAssembly: () => assembly, instructionState: () => live ? owner.read() : { state: 'not-published' }, onInstructionsChanged: (_id: string, _child: unknown, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } as unknown as SessionService
  return { coordinator, service, owner, id, child, listeners, retire() { live = false; for (const listener of listeners) listener() }, async close() { await coordinator.close(); await rm(root, { recursive: true, force: true }) } }
}

it.each(['state', 'refresh'] as const)('fences %s retirement after report capture before the snapshot continuation without a subscription', async method => {
  const f = await fixture(), views = createInstructionViews(f.coordinator, f.service, async () => 'authority', () => {})
  const original = f.service.instructionState!
  f.service.instructionState = (...args) => { const report = original(...args); queueMicrotask(() => f.retire()); return report }
  if (method === 'refresh') {
    f.service.refreshInstructions = async () => ({ state: 'ready' })
    const read = f.owner.read
    vi.spyOn(f.owner, 'read').mockImplementation(() => { const report = read(); queueMicrotask(() => f.retire()); return report })
  }
  try {
    expect((await views.snapshot({ sessionId: f.id, childSessionId: f.child }, method === 'refresh')).report).toEqual({ state: 'revoked' })
    expect(f.listeners.size).toBe(0)
  } finally { views.close(); await f.close() }
})

it.each(['state', 'refresh'] as const)('fences the original %s operation at the actual router response write', async method => {
  const f = await fixture(), frames: any[] = []
  f.service.refreshInstructions = async () => f.owner.read()
  const original = createInstructionViews(f.coordinator, f.service, async () => 'authority', () => {})
  // Hold only the existing wire continuation: the original snapshot must retain
  // its lexical owner until it invokes the router's actual write callback.
  let retire = false
  const instructions = { ...original, async snapshotReply(...args: Parameters<typeof original.snapshotReply>) {
    const result = await original.snapshotReply(...args)
    if (retire) f.retire()
    return result
  } }
  const base = { async handleLine(line: string) { const value = JSON.parse(line); return JSON.stringify({ jsonrpc: '2.0', id: value.id, result: {} }) }, async close() {} }
  const router = createDesktopRouter(base as never, frame => frames.push(frame), { instructions } as never)
  try {
    await router.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    await router.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: `desktop/instructions/${method}`, params: { sessionId: f.id, childSessionId: f.child } }))
    expect(frames.find(frame => frame.id === 3).result.report.state).toBe('ready')
    retire = true
    await router.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: `desktop/instructions/${method}`, params: { sessionId: f.id, childSessionId: f.child } }))
    const response = frames.find(frame => frame.id === 2)
    expect(response.error || response.result?.report.state === 'revoked').toBeTruthy()
    expect(response.result?.report.state).not.toBe('ready')
  } finally { original.close(); await router.close(); await f.close() }
})

it('fences a retired original diagnostics owner after the final authorization await', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let checks = 0
  const views = createInstructionViews(f.coordinator, f.service, async () => { if (++checks === 4) { entered.resolve(); await release.promise }; return 'authority' }, () => {})
  try {
    const reading = views.snapshot({ sessionId: f.id, childSessionId: f.child }); await entered.promise
    f.retire(); release.resolve()
    expect((await reading).report.state).toBe('revoked')
  } finally { release.resolve(); views.close(); await f.close() }
})

it('rejects a late initial acknowledgement after close during final resolve', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let checks = 0
  const views = createInstructionViews(f.coordinator, f.service, async () => { if (++checks === 4) { entered.resolve(); await release.promise }; return 'authority' }, () => {})
  try {
    const admission = views.subscribe({ sessionId: f.id }); const rejected = expect(admission).rejects.toThrow()
    await entered.promise; views.close(); release.resolve(); await rejected
    expect(f.listeners.size).toBe(0)
  } finally { release.resolve(); views.close(); await f.close() }
})

it('bounds admitted and pending subscription members and releases original listeners', async () => {
  const f = await fixture()
  const views = createInstructionViews(f.coordinator, f.service, async () => 'authority', () => {}, { maxSubscriptions: 2, maxScopes: 1 })
  try {
    const a = await views.subscribe({ sessionId: f.id }), b = await views.subscribe({ sessionId: f.id })
    await expect(views.subscribe({ sessionId: f.id })).rejects.toThrow(/limit/i)
    expect(f.listeners.size).toBe(1)
    views.unsubscribe(a.subscriptionId); views.unsubscribe(b.subscriptionId); expect(f.listeners.size).toBe(0)
    const before = await views.snapshot({ sessionId: f.id })
    const c = await views.subscribe({ sessionId: f.id })
    expect(c.cursor.epoch).toBe(before.cursor.epoch); expect(c.cursor.revision).toBeGreaterThan(before.cursor.revision)
    views.close(); expect(f.listeners.size).toBe(0)
  } finally { views.close(); await f.close() }
})

it('retains capture invalidation until the original response owner acknowledges admission', async () => {
  const f = await fixture(), events: unknown[] = []
  const views = createInstructionViews(f.coordinator, f.service, async () => 'authority', event => events.push(event))
  vi.useFakeTimers()
  try {
    const value = await views.subscribe({ sessionId: f.id })
    for (const listener of f.listeners) listener()
    await vi.runAllTimersAsync()
    expect(events).toHaveLength(0)
    views.acknowledge(value.subscriptionId)
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ subscriptionId: value.subscriptionId, reason: 'changed' })))
    views.unsubscribe(value.subscriptionId); expect(f.listeners.size).toBe(0)
  } finally { vi.useRealTimers(); views.close(); await f.close() }
})

it('refuses the actual acknowledgement write after original admission is removed', async () => {
  const f = await fixture(), views = createInstructionViews(f.coordinator, f.service, async () => 'authority', () => {})
  try {
    const value = await views.subscribe({ sessionId: f.id }), write = vi.fn()
    views.close()
    expect(views.acknowledge(value.subscriptionId, write)).toBe(false)
    expect(write).not.toHaveBeenCalled(); expect(f.listeners.size).toBe(0)
  } finally { views.close(); await f.close() }
})

it('bounds pending authorization and distinct live scope listeners', async () => {
  const f = await fixture(), { id: second } = await f.coordinator.create()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let holding = true
  const views = createInstructionViews(f.coordinator, f.service, async () => { if (holding) { entered.resolve(); await release.promise }; return 'authority' }, () => {}, { maxSubscriptions: 1, maxScopes: 1 })
  try {
    const admission = views.subscribe({ sessionId: f.id }); await entered.promise
    await expect(views.subscribe({ sessionId: second })).rejects.toThrow(/limit/i)
    release.resolve(); const a = await admission
    holding = false; views.unsubscribe(a.subscriptionId)
    const b = await views.subscribe({ sessionId: second }); expect(f.listeners.size).toBe(1)
    views.unsubscribe(b.subscriptionId); expect(f.listeners.size).toBe(0)
  } finally { release.resolve(); views.close(); await f.close() }
  const g = await fixture(), { id: another } = await g.coordinator.create()
  const scopes = createInstructionViews(g.coordinator, g.service, async () => 'authority', () => {}, { maxSubscriptions: 2, maxScopes: 1 })
  try {
    await scopes.subscribe({ sessionId: g.id })
    await expect(scopes.subscribe({ sessionId: another })).rejects.toThrow(/scope limit/i)
    expect(g.listeners.size).toBe(1)
  } finally { scopes.close(); expect(g.listeners.size).toBe(0); await g.close() }
})
