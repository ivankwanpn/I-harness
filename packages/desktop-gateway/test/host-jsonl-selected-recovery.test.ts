import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createSelectedResultsHostFixture, executeSelected, prepareSelected, seedManagedRows, storedSession,
} from './helpers/selected-results-host.ts'

/** Fire-and-forget counters for the real kernel seams this suite faults. A test
 *  only observes them; they never replace a capability check. */
const control = vi.hoisted(() => ({
  /** One target whose selected confirmation is acknowledged as unknown after the
   *  frames were really committed: a partial publication with durable frames. */
  failConfirmFor: undefined as string | undefined,
  confirmFailed: false,
  /** Hold one warm publication so a host close must join its in-flight work. */
  holdPublish: false,
  publishEntered: undefined as undefined | (() => void),
  publishLeave: undefined as undefined | (() => void),
  holderCreates: 0,
  holderCloses: 0,
}))

vi.mock('@i-harness/session-persistence-jsonl', async importOriginal => {
  const actual = await importOriginal<typeof import('@i-harness/session-persistence-jsonl')>()
  return {
    ...actual,
    createJsonlBackend(root: string, options?: Parameters<typeof actual.createJsonlBackend>[1]) {
      const next: NonNullable<Parameters<typeof actual.createJsonlBackend>[1]> = {
        ...options,
        wrap(backend) {
          options?.wrap?.(backend)
          const journal = (backend as unknown as { selectedJournal?: { confirmFrames?: (...args: never[]) => Promise<unknown> } }).selectedJournal
          const confirm = journal?.confirmFrames
          if (!journal || typeof confirm !== 'function') return
          journal.confirmFrames = async (...args: never[]) => {
            const id = args[0] as string
            const outcome = await (confirm as (...values: never[]) => Promise<unknown>).apply(journal, args)
            if (control.failConfirmFor === id && !control.confirmFailed) {
              control.confirmFailed = true
              // The durable confirmation happened; only its acknowledgement is
              // lost, exactly the partial-publication window the contract keeps.
              return { kind: 'unknown' }
            }
            return outcome
          }
        },
      }
      return actual.createJsonlBackend(root, next as never) as ReturnType<typeof actual.createJsonlBackend>
    },
  } as typeof actual
})

vi.mock('../src/context-runtime.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/context-runtime.ts')>()
  return {
    ...actual,
    async createNativeContextRuntime(options: Parameters<typeof actual.createNativeContextRuntime>[0]) {
      const runtime = await actual.createNativeContextRuntime(options)
      return new Proxy(runtime, {
        get(target, property) {
          if (property !== 'createSelectedSourceHolder') {
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return (input: unknown) => {
            control.holderCreates++
            const holder = target.createSelectedSourceHolder(input)
            return {
              async captureFirst(signal?: AbortSignal) { return holder.captureFirst(signal) },
              async publishWarm(signal?: AbortSignal) {
                if (control.holdPublish) { control.publishEntered?.(); await new Promise<void>(resolve => { control.publishLeave = resolve }) }
                return holder.publishWarm(signal)
              },
              async close() { control.holderCloses++; return holder.close() },
            }
          }
        },
      })
    },
  }
})

function resetControl() {
  control.failConfirmFor = undefined
  control.confirmFailed = false
  control.holdPublish = false
  control.publishEntered = undefined
  control.publishLeave = undefined
  control.holderCreates = 0
  control.holderCloses = 0
}

/** A completed operation adopts its exact receipt after a host restart even
 *  when the source has been archived and its retained results cleared. */
it('adopts a completed JSONL operation after restarting the host and clearing the source', async () => {
  const fixture = await createSelectedResultsHostFixture({ store: 'jsonl' })
  let sourceSessionId = ''
  let ref: { id: string; revision: string; contentDigest: string; encodedBytes: number } = { id: '', revision: '', contentDigest: '', encodedBytes: 0 }
  let expected = ''
  let operation: unknown
  let receipt: unknown
  const first = await fixture.open()
  try {
    await first.call('initialize')
    const created = await first.call('session/create') as { sessionId: string }
    sourceSessionId = created.sessionId
    await first.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const source = await storedSession(fixture.sessionDir, sourceSessionId, 'jsonl')
    ref = source.results[0]!.ref
    expected = (await first.readAll(sourceSessionId, ref)).text
    const prepared = await prepareSelected(first, sourceSessionId, 'restart-child', 'restart-op')
    operation = prepared.operation
    const begin = await executeSelected(first, operation)
    expect(begin).toMatchObject({ kind: 'ready' })
    receipt = begin.receipt
  } finally { await first.close().catch(() => {}) }

  const second = await fixture.open()
  try {
    await second.call('initialize')
    await second.call('desktop/session/manage', { sessionId: sourceSessionId, action: 'archive' })
    await second.call('desktop/context-subsystems/action', { command: { target: 'context', action: 'clear', sessionId: sourceSessionId } })
    const retried = await executeSelected(second, operation, 'retry')
    expect(retried).toMatchObject({ kind: 'adopted', sessionId: 'restart-child' })
    expect(retried.receipt).toEqual(receipt)
    expect((await second.readAll('restart-child', ref)).text).toBe(expected)
    // The adopted outcome is durable: another retry adopts it again with no
    // capture, publication or qualification work.
    expect(await executeSelected(second, operation, 'retry')).toMatchObject({ kind: 'adopted', receipt })
    // An archived target is a policy refusal, never a silent second capture.
    await second.call('desktop/session/manage', { sessionId: 'restart-child', action: 'archive' })
    expect(await executeSelected(second, operation, 'retry')).toMatchObject({ kind: 'refused', reason: 'target-policy' })
  } finally {
    await second.close().catch(() => {})
    await fixture.dispose()
  }
}, 240000)

/** A publication interrupted after its durable frames were confirmed but before
 *  the target's READY commit answers one legal blocked token, repeats nothing,
 *  and is adopted by the original cold qualification after a restart. */
it('blocks a partial publication, repeats no effect and adopts it after a restart', async () => {
  resetControl()
  const fixture = await createSelectedResultsHostFixture({ store: 'jsonl' })
  let sourceSessionId = ''
  let ref: { id: string; revision: string; contentDigest: string; encodedBytes: number } = { id: '', revision: '', contentDigest: '', encodedBytes: 0 }
  let expected = ''
  let operation: unknown
  let partialBytes: Buffer = Buffer.alloc(0)
  const first = await fixture.open()
  try {
    await first.call('initialize')
    const created = await first.call('session/create') as { sessionId: string }
    sourceSessionId = created.sessionId
    await first.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const source = await storedSession(fixture.sessionDir, sourceSessionId, 'jsonl')
    ref = source.results[0]!.ref
    expected = (await first.readAll(sourceSessionId, ref)).text

    control.failConfirmFor = 'partial-child'
    const prepared = await prepareSelected(first, sourceSessionId, 'partial-child', 'partial-op')
    operation = prepared.operation
    const blocked = await executeSelected(first, operation)
    expect(blocked).toMatchObject({ kind: 'blocked', capture: 'captured', reason: 'unknown' })
    expect(blocked.token).toMatchObject({ version: 2, phase: 'header', manifest: 'unknown' })
    expect(control.confirmFailed).toBe(true)
    // Same-process retry cannot cold-inspect a warm target entry, so it answers
    // the same retryable block instead of fabricating a second target.
    expect(await executeSelected(first, operation, 'retry')).toMatchObject({ kind: 'blocked', capture: 'captured' })
    expect(control.holderCreates).toBe(1)
    partialBytes = await readFile(join(fixture.sessionDir, 'partial-child.jsonl'))
    // No duplicate effect: the incomplete target bytes never changed again.
    expect(await readFile(join(fixture.sessionDir, 'partial-child.jsonl'))).toEqual(partialBytes)
    const sourceAfter = await storedSession(fixture.sessionDir, sourceSessionId, 'jsonl')
    expect(sourceAfter.results).toHaveLength(1)
  } finally { await first.close().catch(() => {}) }

  const second = await fixture.open()
  try {
    await second.call('initialize')
    const retried = await executeSelected(second, operation, 'retry')
    expect(retried).toMatchObject({ kind: 'adopted', sessionId: 'partial-child' })
    expect(retried.receipt.results).toMatchObject({ version: 1, rows: 1, pages: 1 })
    // The cold qualification never creates a second holder or a second target.
    expect(control.holderCreates).toBe(1)
    expect((await second.readAll('partial-child', ref)).text).toBe(expected)
    const child = await storedSession(fixture.sessionDir, 'partial-child', 'jsonl')
    expect(seedManagedRows(child.events).map(row => row.ref!.id)).toEqual([ref.id])
    expect(child.events.filter(event => event.type === 'conversation/seed-manifest')).toHaveLength(1)
    expect((await executeSelected(second, operation, 'retry'))).toMatchObject({ kind: 'adopted', receipt: retried.receipt })
  } finally {
    await second.close().catch(() => {})
    await fixture.dispose()
  }
}, 240000)

/** Shutdown joins the selected controller: a warm publication still in flight
 *  keeps the host open until its holder really closed, then close completes. */
it('completes host close while a selected publication is in flight', async () => {
  resetControl()
  const fixture = await createSelectedResultsHostFixture({ store: 'jsonl' })
  const client = await fixture.open()
  let begin: Promise<unknown> | undefined
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    const sourceSessionId = created.sessionId
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const entered = Promise.withResolvers<void>()
    control.holdPublish = true
    control.publishEntered = () => entered.resolve()
    const prepared = await prepareSelected(client, sourceSessionId, 'in-flight-child', 'in-flight-op')
    begin = client.call('session/fork/begin', { operation: prepared.operation }).then(value => value, error => error)
    await entered.promise
    expect(control.holderCreates).toBe(1)
    let closed = false
    const closing = client.close().then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(closed).toBe(false)
    control.publishLeave?.()
    const outcome = await begin
    await closing
    expect(closed).toBe(true)
    // The holder was joined exactly once on the abort path and the RPC answered
    // with the contract's own outcome or the host's closing error, never a hang.
    expect(control.holderCloses).toBeGreaterThanOrEqual(1)
    expect(outcome).toBeDefined()
  } finally {
    control.publishLeave?.()
    await begin?.catch(() => {})
    await client.close().catch(() => {})
    await fixture.dispose()
  }
}, 240000)
