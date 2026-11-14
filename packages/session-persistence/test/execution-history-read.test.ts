import { expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { acquireManagedExecution } from '../src/execution-internal.ts'
import type { ManagedAction, CapturedActionFact, FactOutcome } from '@i-harness/core-session'

const observed = vi.hoisted(() => ({ entries: new Map<string, { flight?: Promise<unknown> }>() }))
vi.mock('../src/coordinator/managed-execution-source.ts', async load => {
  const actual = await load<typeof import('../src/coordinator/managed-execution-source.ts')>()
  return { ...actual, createManagedExecutionSource(...args: Parameters<typeof actual.createManagedExecutionSource>) {
    const source = actual.createManagedExecutionSource(...args)
    observed.entries.set(args[0].id, args[0].entry)
    return source
  } }
})

async function fixture() {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'execution-history-'))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const cut = { armed: false, held: false, unknown: false, appends: 0, callback: undefined as (() => Promise<void>) | undefined, extraRelease: undefined as (() => void) | undefined }
  const backend = createJsonlBackend(root, { wrapOwnedBatch: append => (...args) => {
    const writing = append(...args)
    if (!cut.armed || cut.held || !Buffer.from(args[3].bytes).toString('utf8').includes('history-after-ack')) return writing
    cut.appends++
    return writing.then(async outcome => {
      if (outcome.kind !== 'committed') throw Error('Original native commit missing')
      cut.held = true
      entered.resolve()
      await release.promise
      await cut.callback?.()
      return cut.unknown ? { kind: 'unknown' as const, key: args[3].key } : outcome
    })
  } })
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const flights = new Set<Promise<unknown>>()
  const track = <T>(flight: Promise<T>) => {
    flights.add(flight)
    void flight.finally(() => flights.delete(flight)).catch(() => {})
    return flight
  }
  let action: ManagedAction<FactOutcome> | undefined
  let capture: CapturedActionFact<FactOutcome> | undefined
  let outcome: FactOutcome | undefined
  onTestFinished(async () => {
    release.resolve(); cut.callback = undefined; cut.unknown = false
    cut.extraRelease?.()
    await Promise.allSettled([...flights])
    const failures: unknown[] = []
    if (capture && (outcome?.kind === 'unknown' || outcome?.kind === 'recovery-required')) {
      try { await capture.reconcile() } catch (error) { failures.push(error) }
    }
    try { action?.finish() } catch (error) { failures.push(error) }
    try { await coordinator.close() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Original history fixture cleanup failed')
  })
  await coordinator.create({ sessionId: 'owner' })
  await coordinator.append('owner', [{ type: 'turn/start' }, { type: 'user/message', text: 'original' }])
  const execution = await acquireManagedExecution(coordinator, 'owner')
  action = execution.owner.beginAction()
  const count = execution.observe().eventCount
  const write = () => {
    cut.armed = true
    capture = action!.captureMetadata!({ type: 'session/title', title: 'history-after-ack', source: 'user', messageSeqs: [] })
    return track(capture.admit().then(value => { outcome = value; return value }))
  }
  return { backend, coordinator, execution, action, count, cut, entered, release, track, write,
    reconcile: () => track(capture!.reconcile()) }
}

it('materializes one coherent history after the original native commit ACK installs', async () => {
  const f = await fixture(), writing = f.write()
  await f.entered.promise
  const reading = f.track(f.coordinator.snapshot!('owner'))
  await new Promise<void>(resolve => setImmediate(resolve))
  f.release.resolve()
  expect(await writing).toMatchObject({ kind: 'committed' })
  const snapshot = await reading
  expect(snapshot.session?.events).toHaveLength(f.count + 1)
  expect(snapshot.session?.events.map(event => event.seq)).toEqual(Array.from({ length: f.count + 1 }, (_, index) => index))
  expect(snapshot.session?.events.filter(event => event.type === 'session/title')).toHaveLength(1)
  expect(f.cut.appends).toBe(1)
}, 20_000)

it('refuses original callback reentry before replacing the queued history flight', async () => {
  const f = await fixture()
  const reentered = Promise.withResolvers<void>(), allowWriter = Promise.withResolvers<void>()
  f.cut.extraRelease = allowWriter.resolve
  const entry = observed.entries.get('owner')!
  let snapshotError: unknown, openError: unknown
  let afterReentry: Promise<unknown> | undefined
  f.cut.callback = async () => {
    snapshotError = await f.coordinator.snapshot!('owner').then(() => undefined, error => error)
    openError = await f.coordinator.openManagedDocument!('owner').then(() => undefined, error => error)
    afterReentry = entry.flight
    reentered.resolve()
    await allowWriter.promise
  }
  const writing = f.write()
  await f.entered.promise
  const reading = f.track(f.coordinator.snapshot!('owner'))
  await new Promise<void>(resolve => setImmediate(resolve))
  const originalFlight = entry.flight
  expect(originalFlight).toBeDefined()
  f.release.resolve()
  await Promise.race([reentered.promise, writing.then(() => { throw Error('Original reentry cut was not reached') })])
  expect(afterReentry).toBe(originalFlight)
  let closed = false
  const closing = f.track(f.coordinator.close().then(() => { closed = true }))
  expect(closed).toBe(false)
  allowWriter.resolve()
  expect(await writing).toMatchObject({ kind: 'committed' })
  expect(snapshotError).toBeInstanceOf(Error)
  expect((snapshotError as Error).message).toMatch(/Session operation reentry conflict/)
  expect(openError).toBeInstanceOf(Error)
  expect((openError as Error).message).toMatch(/Session operation reentry conflict/)
  expect((await reading).session?.events).toHaveLength(f.count + 1)
  await closing
  expect(f.cut.appends).toBe(1)
}, 20_000)

it('keeps the already materialized public view readable inside the original writer callback', async () => {
  const f = await fixture()
  expect((await f.coordinator.snapshot!('owner')).session?.events).toHaveLength(f.count)
  let observedCount: number | undefined
  f.cut.callback = async () => { observedCount = (await f.coordinator.snapshot!('owner')).session?.events.length }
  const writing = f.write()
  await f.entered.promise
  f.release.resolve()
  expect(await writing).toMatchObject({ kind: 'committed' })
  expect(observedCount).toBe(f.count)
  expect((await f.coordinator.snapshot!('owner')).session?.events).toHaveLength(f.count + 1)
}, 20_000)

it('withholds history on original UNKNOWN and recovers only that same committed batch', async () => {
  const f = await fixture(), writing = f.write()
  await f.entered.promise
  const reading = f.track(f.coordinator.snapshot!('owner')).then(value => ({ value }), error => ({ error }))
  await new Promise<void>(resolve => setImmediate(resolve))
  f.cut.unknown = true
  f.release.resolve()
  expect(await writing).toMatchObject({ kind: 'unknown' })
  const refused = await reading
  expect(refused).toHaveProperty('error')
  expect(Object.hasOwn(f.execution.owner, 'view')).toBe(false)
  f.cut.unknown = false
  expect(await f.reconcile()).toMatchObject({ kind: 'committed' })
  expect((await f.coordinator.snapshot!('owner')).session?.events).toHaveLength(f.count + 1)
  expect(f.cut.appends).toBe(1)
}, 20_000)

it('joins the accepted history and original write before close ACK and fences fresh reads', async () => {
  const f = await fixture(), writing = f.write()
  await f.entered.promise
  const reading = f.track(f.coordinator.snapshot!('owner'))
  await new Promise<void>(resolve => setImmediate(resolve))
  let closed = false
  const closing = f.track(f.coordinator.close().then(() => { closed = true }))
  await expect(f.coordinator.snapshot!('owner')).rejects.toThrow(/Coordinator is closed/)
  expect(closed).toBe(false)
  f.release.resolve()
  expect(await writing).toMatchObject({ kind: 'committed' })
  f.action.finish()
  const snapshot = await reading
  expect(snapshot.session?.events).toHaveLength(f.count + 1)
  await closing
  expect(closed).toBe(true)
}, 20_000)
