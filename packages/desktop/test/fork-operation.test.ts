import { expect, it, vi } from 'vitest'
import type { DesktopBridge, DesktopRequest } from '../src/shared/bridge.ts'
import { ForkOperationError, type ForkOperation } from '@i-harness/sdk/fork'
import { createForkOperationController, createForkCallbackAdapters } from '../src/renderer/session/fork-operation.ts'
import { preparedFork, readyFork } from './helpers/fork-contract.ts'
import { createGatewayForkFixture } from '../../desktop-gateway/test/helpers/fork-fixture.ts'
import { RpcError } from '@i-harness/sdk'
import { readForkHostErrorData } from '@i-harness/sdk/fork'

function fixture(reply?: (request: DesktopRequest) => Promise<unknown>) {
  let selection: object = { workspaceId: 'w', sessionId: 'a' }, version = 0, minted = 0
  const request = vi.fn(async (input: DesktopRequest) => {
    if (reply) return reply(input)
    if (input.kind === 'desktop/session/fork/prepare') return preparedFork('a')
    if (input.kind === 'desktop/session/fork/begin' || input.kind === 'desktop/session/fork/retry') return readyFork(input.operation, input.kind.endsWith('retry') ? 'adopted' : 'ready')
    throw new Error('Unexpected request')
  })
  const navigate = vi.fn(), refresh = vi.fn(async (_workspaceId: string) => {})
  const controller = createForkOperationController({ bridge: { request } satisfies Pick<DesktopBridge, 'request'>, selection: () => selection, navigationVersion: () => version,
    identity: () => ({ operationId: 'operation-' + ++minted, targetSessionId: 'target-' + minted, createdAt: '2026-10-27T00:00:00.000Z' }), refresh, navigate })
  return { controller, request, refresh, navigate, minted: () => minted, change() { selection = { workspaceId: 'w', sessionId: 'a' }; version++ } }
}

it('joins preparation and dispatch, stores identity before mutation and success before refresh', async () => {
  const preparation = Promise.withResolvers<unknown>(), refreshed = Promise.withResolvers<void>()
  let f!: ReturnType<typeof fixture>
  f = fixture(async input => {
    if (input.kind === 'desktop/session/fork/prepare') return preparation.promise
    if (input.kind !== 'desktop/session/fork/begin') throw new Error('Unexpected request')
    expect(f.controller.state('w', 'a').operation).toEqual(input.operation)
    return readyFork(input.operation)
  })
  f.refresh.mockImplementation(async () => { expect(f.controller.state('w', 'a').outcome?.kind).toBe('ready'); await refreshed.promise })
  const adapters = createForkCallbackAdapters(f.controller), first = adapters.inWorkspace('w', 'a', 'fork'), duplicate = adapters.inSelection('w', 'a', 'fork')
  expect(duplicate).toBe(first); expect(f.minted()).toBe(0)
  await Promise.resolve(); expect(f.request).toHaveBeenCalledTimes(1)
  preparation.resolve(preparedFork('a'))
  await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce())
  expect(f.minted()).toBe(1); expect(f.navigate).not.toHaveBeenCalled()
  refreshed.resolve(); await first; expect(f.navigate).toHaveBeenCalledExactlyOnceWith('w', 'target-1')
})

it.each(['transport', 'malformed', 'cleanup', 'blocked'] as const)('retains the same operation through %s failure and requalifies by retry', async failure => {
  let operation!: ForkOperation
  const f = fixture(async input => {
    if (input.kind === 'desktop/session/fork/prepare') return preparedFork('a')
    if (input.kind === 'desktop/session/fork/retry') { expect(input.operation).toEqual(operation); return readyFork(operation, 'adopted') }
    if (input.kind !== 'desktop/session/fork/begin') throw new Error('Unexpected request')
    operation = input.operation
    if (failure === 'transport') throw new Error('Reply lost')
    if (failure === 'malformed') return { ...readyFork(operation), sessionId: 'other-target' }
    if (failure === 'cleanup') return { version: 1, kind: 'session-fork-error', operation, capture: 'captured', reason: 'cleanup-incomplete', lastOutcome: readyFork(operation) }
    return { version: 1, kind: 'blocked', operation, capture: 'unknown', reason: 'unknown', token: { version: 1, invocation: operation.invocation, phase: 'header', manifest: 'unknown' } }
  })
  await expect(f.controller.run('w', 'a')).rejects.toMatchObject({ name: 'ForkOperationError', kind: { transport: 'transport', malformed: 'protocol', cleanup: 'cleanup', blocked: 'outcome' }[failure] })
  expect(f.controller.state('w', 'a').operation).toEqual(operation); expect(f.navigate).not.toHaveBeenCalled()
  expect((await f.controller.run('w', 'a')).kind).toBe('adopted'); expect(f.minted()).toBe(1)
  expect(f.request.mock.calls.filter(([input]) => input.kind === 'desktop/session/fork/prepare')).toHaveLength(1)
})

it('retains READY after refresh failure, permits refresh-only retry and requires passive qualification for later navigation', async () => {
  const f = fixture(); f.refresh.mockRejectedValueOnce(new Error('dashboard offline'))
  await expect(f.controller.run('w', 'a')).rejects.toThrow('dashboard offline')
  const operation = f.controller.state('w', 'a').operation
  expect(f.controller.state('w', 'a').outcome?.kind).toBe('ready'); expect(f.navigate).not.toHaveBeenCalled()
  await f.controller.refresh('w')
  expect(f.request).toHaveBeenCalledTimes(2); expect(f.navigate).not.toHaveBeenCalled()
  await f.controller.run('w', 'a')
  expect(f.request.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'desktop/session/fork/retry', operation })
  expect(f.navigate).toHaveBeenCalledExactlyOnceWith('w', 'target-1'); expect(f.minted()).toBe(1)
})

it.each(['preparation', 'execution', 'refresh'] as const)('selection ABA during %s retires navigation without cancelling the operation', async phase => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = fixture(async input => {
    if (input.kind === 'desktop/session/fork/prepare') { if (phase === 'preparation') { entered.resolve(); await release.promise } return preparedFork('a') }
    if (input.kind === 'desktop/session/fork/begin') { if (phase === 'execution') { entered.resolve(); await release.promise } return readyFork(input.operation) }
    if (input.kind === 'desktop/session/fork/retry') return readyFork(input.operation, 'adopted')
    throw new Error('Unexpected request')
  })
  if (phase === 'refresh') f.refresh.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
  const running = f.controller.run('w', 'a'); await entered.promise; f.change(); f.change(); release.resolve()
  expect((await running).kind).toBe('ready'); expect(f.navigate).not.toHaveBeenCalled()
  await f.controller.run('w', 'a'); expect(f.navigate).toHaveBeenCalledOnce(); expect(f.minted()).toBe(1)
  expect(f.request.mock.calls.some(([input]) => (input as { kind: string }).kind === 'session/cancel')).toBe(false)
})

it('fresh identity requires explicit intent after the prior flight settled', async () => {
  const gate = Promise.withResolvers<void>(), f = fixture()
  f.refresh.mockImplementationOnce(async () => gate.promise)
  const first = f.controller.run('w', 'a')
  await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce())
  await expect(f.controller.fresh('w', 'a')).rejects.toThrow(/progress|running/i)
  expect(f.minted()).toBe(1); gate.resolve(); await first
  await f.controller.fresh('w', 'a'); expect(f.minted()).toBe(2)
  expect(f.controller.state('w', 'a').operation?.invocation.targetSessionId).toBe('target-2')
})

it('blocked outcome remains explicit rather than navigating or manufacturing success', async () => {
  const f = fixture(async input => {
    if (input.kind === 'desktop/session/fork/prepare') return preparedFork('a')
    if (input.kind !== 'desktop/session/fork/begin') throw new Error('Unexpected request')
    return { version: 1, kind: 'not-issued', operation: input.operation, capture: 'uncaptured', reason: 'busy' }
  })
  const failure = await f.controller.run('w', 'a').catch(error => error)
  expect(failure).toBeInstanceOf(ForkOperationError); expect(failure.outcome).toMatchObject({ kind: 'not-issued', reason: 'busy' })
  expect(f.refresh).not.toHaveBeenCalled(); expect(f.navigate).not.toHaveBeenCalled()
})

it('retains known cleanup through lost/malformed and early replies, then permits fresh after a post-cleanup source block', async () => {
  let begins = 0, retries = 0, original!: ForkOperation
  const f = fixture(async input => {
    if (input.kind === 'desktop/session/fork/prepare') return preparedFork('a')
    if (input.kind === 'desktop/session/fork/begin') {
      if (++begins > 1) return readyFork(input.operation)
      original = input.operation
      return { version: 1, kind: 'session-fork-error', operation: original, capture: 'captured', reason: 'cleanup-incomplete', lastOutcome: readyFork(original) }
    }
    if (input.kind !== 'desktop/session/fork/retry') throw new Error('Unexpected request')
    if (++retries === 1) throw new Error('Recovery reply lost')
    if (retries === 2) return { ...readyFork(original), sessionId: 'wrong-target' }
    if (retries === 3) return { version: 1, kind: 'session-fork-error', operation: original, capture: 'captured', reason: 'internal', lastOutcome: readyFork(original) }
    if (retries === 4) return { version: 1, kind: 'refused', operation: original, capture: 'unknown', reason: 'conflict' }
    if (retries === 5) return { version: 1, kind: 'not-issued', operation: original, capture: 'unknown', reason: 'cancelled' }
    return { version: 1, kind: 'blocked', operation: original, capture: 'unknown', reason: 'source-changed', token: { version: 1, invocation: original.invocation, phase: 'dependencies', manifestDigest: 'a'.repeat(64) } }
  })
  await expect(f.controller.run('w', 'a')).rejects.toMatchObject({ kind: 'cleanup' })
  for (let step = 0; step < 6; step++) {
    await expect(f.controller.fresh('w', 'a')).rejects.toThrow(/recover/i)
    expect(f.controller.state('w', 'a').operation).toEqual(original); expect(f.minted()).toBe(1)
    await f.controller.run('w', 'a').catch(() => {})
    expect(f.controller.state('w', 'a').cleanupPending).toBe(step < 5)
  }
  expect(f.navigate).not.toHaveBeenCalled()
  await f.controller.fresh('w', 'a'); expect(f.minted()).toBe(2); expect(f.navigate).toHaveBeenCalledExactlyOnceWith('w', 'target-2')
})

it('actual original Gateway cleanup can acknowledge before a source block and the renderer permits an explicit fresh target', async () => {
  const server = await createGatewayForkFixture()
  await server.coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'real source' }, { type: 'turn/end' }])
  const source = await server.coordinator.openManagedDocument('source')
  // Actual quota refusal leaves the original public target incomplete; the
  // actual L1 disposer is held before its first action, not replaced by a receipt.
  await server.runtime.contextOutput.configure({ maxDiskBytes: 1 })
  const close = server.runtime.contextOutput.closeLegacyForkTransfer.bind(server.runtime.contextOutput), scopes: unknown[] = []
  const transfer = server.runtime.prepareBootstrapTransfer.bind(server.runtime), closedTransfers: { closed: boolean }[] = []
  vi.spyOn(server.runtime, 'prepareBootstrapTransfer').mockImplementation((...args) => {
    const actual = transfer(...args), close = actual.close.bind(actual), record = { closed: false }; closedTransfers.push(record)
    actual.close = () => { close(); record.closed = true }
    return actual
  })
  let fail = true, minted = 0, captures = 0
  server.runtime.contextOutput.closeLegacyForkTransfer = async scope => { scopes.push(scope); if (fail) throw new Error('Original cleanup pending'); return close(scope) }
  const capture = server.coordinator.bootstrapSemanticTargetWithCapture!.bind(server.coordinator)
  server.coordinator.bootstrapSemanticTargetWithCapture = (input, guards, use) => capture(input, guards, async () => { captures++; return use() })
  const navigate = vi.fn(), selection = {}
  const controller = createForkOperationController({ selection: () => selection, navigationVersion: () => 0, refresh: async () => {}, navigate,
    identity: () => ({ operationId: 'real-ui-' + ++minted, targetSessionId: 'real-ui-target-' + minted, createdAt: '2026-10-27T00:00:00.000Z' }),
    bridge: { async request(input) {
      if (input.kind === 'desktop/session/fork/prepare') return server.call('session/fork/prepare', input.request)
      if (input.kind !== 'desktop/session/fork/begin' && input.kind !== 'desktop/session/fork/retry') throw new Error('Unexpected UI request')
      try { return await server.call(input.kind.endsWith('/begin') ? 'session/fork/begin' : 'session/fork/retry', { operation: input.operation }) }
      catch (cause) { if (cause instanceof RpcError) return readForkHostErrorData(cause.data, input.operation); throw cause }
    } } })
  try {
    await expect(controller.run('w', 'source')).rejects.toMatchObject({ kind: 'cleanup' })
    const original = controller.state('w', 'source').operation!
    expect(controller.state('w', 'source').cleanupPending).toBe(true)
    await expect(controller.fresh('w', 'source')).rejects.toThrow(/recover/i)
    expect(minted).toBe(1); expect(captures).toBe(1)
    fail = false
    expect((await source.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
    const blocked = await controller.run('w', 'source').catch(error => error)
    expect(blocked).toBeInstanceOf(ForkOperationError)
    expect(blocked.outcome).toMatchObject({ kind: 'blocked', reason: 'source-changed' })
    expect(scopes[0]).toBe(scopes[1]); expect(scopes).toHaveLength(2)
    expect(closedTransfers).toHaveLength(2); expect(closedTransfers.every(record => record.closed)).toBe(true)
    expect(controller.state('w', 'source').cleanupPending).toBe(false); expect(navigate).not.toHaveBeenCalled()
    expect(controller.state('w', 'source').operation).toEqual(original); expect(captures).toBe(1)
    await server.runtime.contextOutput.configure({ maxDiskBytes: 100_000_000 })
    const fresh = await controller.fresh('w', 'source')
    expect(fresh).toMatchObject({ kind: 'ready', sessionId: 'real-ui-target-2' })
    expect(captures).toBe(2); expect(navigate).toHaveBeenCalledExactlyOnceWith('w', 'real-ui-target-2')
  } finally { fail = false; await server.close() }
})
