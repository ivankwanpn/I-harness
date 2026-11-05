import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapturedActionFact, CodeSettlementFact, FactOutcome, SettlementFacts } from '@i-harness/core-session'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createCodeModeEventFacts } from '../src/event-facts.ts'

// Retained original-owner regression: changing source admission/retirement or
// optional cancellation should require revisiting these observed boundaries.
// Every wrapper delegates once, preserving the original object and error.
async function fixture(control: string) {
  const root = await mkdtemp(join(tmpdir(), 'ih-owner-'))
  const trace: unknown[] = [], cleanupFailures: unknown[] = []
  const ids = new WeakMap<object, number>()
  let nextId = 0, overflow = 0
  const identity = (value: object) => {
    if (!ids.has(value)) ids.set(value, ++nextId)
    return ids.get(value)!
  }
  const errorData = (value: unknown): unknown => {
    if (!(value instanceof Error)) return value
    return { identity: identity(value), name: value.name, message: value.message,
      code: (value as Error & { code?: string }).code, stack: value.stack,
      outcome: (value as Error & { outcome?: unknown }).outcome,
      cause: errorData(value.cause),
      errors: value instanceof AggregateError ? value.errors.map(errorData) : undefined }
  }
  const note = (kind: string, data: object = {}) => {
    if (trace.length < 256) trace.push({ sequence: trace.length + 1, kind, ...data })
    else overflow++
  }
  const backend = createJsonlBackend(root)
  const append = backend.appendOwnedBatch!.bind(backend)
  vi.spyOn(backend as Required<Pick<typeof backend, 'appendOwnedBatch'>>, 'appendOwnedBatch').mockImplementation(async (...args) => {
    const batch = args[3]
    note('backend.append', { batch: identity(batch), key: batch.key,
      bytesHex: Buffer.from(batch.bytes).toString('hex') })
    const outcome = await append(...args)
    note('backend.outcome', { batch: identity(batch), outcome })
    return outcome
  })
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const instrumentCapture = (capture: CapturedActionFact<FactOutcome>) => {
    const captureId = identity(capture)
    for (const method of ['admit', 'reconcile'] as const) {
      const original = capture[method].bind(capture)
      vi.spyOn(capture, method).mockImplementation(async () => {
        note('capture.call', { capture: captureId, method })
        const outcome = await original()
        note('capture.outcome', { capture: captureId, method, outcome })
        return outcome
      })
    }
  }
  const instrumentSource = (source: SettlementFacts<FactOutcome>, actionId: number) => {
    const sourceId = identity(source), capture = source.code.capture.bind(source.code)
    vi.spyOn(source.code, 'capture').mockImplementation(event => {
      note('source.capture', { source: sourceId, event: identity(event), eventBytes: JSON.stringify(event) })
      const original = capture(event)
      note('source.captured', { source: sourceId, capture: identity(original) })
      instrumentCapture(original)
      return original
    })
    const close = source.close.bind(source), hold = source.holdRecovery.bind(source)
    vi.spyOn(source, 'holdRecovery').mockImplementation(() => {
      note('source.hold', { source: sourceId, action: actionId }); return hold()
    })
    vi.spyOn(source, 'close').mockImplementation(async () => {
      note('source.close', { source: sourceId })
      try { await close(); note('source.closed', { source: sourceId }) }
      catch (error) { note('source.close.error', { source: sourceId, error: errorData(error) }); throw error }
    })
    return source
  }
  const begin = document.beginAction.bind(document)
  vi.spyOn(document, 'beginAction').mockImplementation(signal => {
    const action = begin(signal), actionId = identity(action)
    note('action.begin', { action: actionId, owner: action.owner, owned: document.ownsAction?.(action) })
    const register = action.registerSettlementSource.bind(action)
    vi.spyOn(action, 'registerSettlementSource').mockImplementation((...args) => {
      note('source.register', { action: actionId })
      try {
        const source = register(...args)
        note('source.registered', { action: actionId, source: identity(source) })
        return instrumentSource(source, actionId)
      } catch (error) { note('source.register.error', { action: actionId, error: errorData(error) }); throw error }
    })
    const store = action.captureCodeStore.bind(action)
    vi.spyOn(action, 'captureCodeStore').mockImplementation(event => {
      const capture = store(event)
      note('store.capture', { action: actionId, capture: identity(capture), event: identity(event), eventBytes: JSON.stringify(event) })
      instrumentCapture(capture)
      return capture
    })
    const stop = action.stop.bind(action)
    vi.spyOn(action, 'stop').mockImplementation(() => {
      note('action.stop', { action: actionId, abortedBefore: action.signal.aborted })
      stop(); note('action.stopped', { action: actionId, aborted: action.signal.aborted })
    })
    return action
  })
  const facts = createCodeModeEventFacts(document, async () => { await facts.required({ type: 'code/cell', cellId: 'original', state: 'terminated' }) })
  await facts.optional({ type: 'code/cell', cellId: 'original', state: 'started' })
  const outerAction = document.beginAction()
  const outer = outerAction.registerSettlementSource(async () => { note('outer.drain') })
  outerAction.finish()
  const output = (preview: string): CodeSettlementFact => ({ type: 'code/output', cellId: 'original', envelope: {
    version: 1, execution: { outcome: 'succeeded', dispatch: 'not-dispatched' }, preview, media: [],
    retention: { kind: 'unavailable', reason: 'quota' } } })
  const snapshot = async () => {
    const raw = await readFile(join(root, `${id}.jsonl`))
    note('observations.recorded', { state: facts.observationState(), events: document.view.events,
      journalBytesHex: raw.toString('hex') })
    return raw
  }
  const finish = async (raw?: Buffer) => {
    note('cleanup.begin')
    // Release fixture-owned resources after recording. This is not recovery of
    // an actual runtime/batch, and the refused producer is never submitted again.
    for (const [name, close] of [ ['outer', () => outer.close()], ['facts', () => facts.close()],
      ['coordinator', () => coordinator.close()] ] as const) {
      try { await close(); note('cleanup.closed', { name }) }
      catch (error) { const failure = { name, error: errorData(error) }; cleanupFailures.push(failure); note('cleanup.error', failure) }
    }
    const evidence = process.env.IH_OWNER_CONTROL_EVIDENCE_ROOT ?? root
    await mkdir(evidence, { recursive: true })
    if (raw) await writeFile(join(evidence, `${control}.jsonl`), raw, { flag: 'wx' })
    await writeFile(join(evidence, `${control}.json`), JSON.stringify({ control, root, id,
      sourceOwner: outerAction.owner, trace, overflow, cleanupFailures }, null, 2), { flag: 'wx' })
    console.log(`owner-control evidence: ${join(evidence, `${control}.json`)}`)
    expect(overflow).toBe(0)
    expect(cleanupFailures).toEqual([])
  }
  return { facts, outer, note, identity, errorData, output, snapshot, finish, document, trace }
}

for (const order of ['closed-first', 'open-backlog'] as const) {
  it(`retains same-cell source admission under an unchanged outer hold: ${order}`, async () => {
    const f = await fixture(order), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const first = f.output('first original π\n'), second = f.output('second original 二\n')
    let preparedFirst = 0, preparedSecond = 0, installedFirst = 0, installedSecond = 0
    let raw: Buffer | undefined
    try {
      const firstReceipt = f.facts.requiredPrepared('original', async () => {
        preparedFirst++; f.note('prepare.first', { event: f.identity(first) })
        entered.resolve(); await gate.promise; return first
      }, () => { installedFirst++; f.note('install.first') })
      await entered.promise
      f.outer.holdRecovery()
      let secondReceipt: Promise<void> | undefined, synchronousError: unknown
      if (order === 'closed-first') { gate.resolve(); await firstReceipt }
      try {
        secondReceipt = f.facts.requiredPrepared('original', async () => {
          preparedSecond++; f.note('prepare.second', { event: f.identity(second) }); return second
        }, () => { installedSecond++; f.note('install.second') })
        f.note('second.returned.promise')
      } catch (error) { synchronousError = error; f.note('second.synchronous.error', { error: f.errorData(error) }) }
      if (order === 'open-backlog') { gate.resolve(); await firstReceipt }; await secondReceipt
      f.note('counters', { preparedFirst, preparedSecond, installedFirst, installedSecond,
        inputFirst: JSON.stringify(first), inputSecond: JSON.stringify(second) })
      raw = await f.snapshot()
      expect(preparedFirst).toBe(1); expect(installedFirst).toBe(1)
      const events = f.document.view.events.filter(event => event.type === 'code/output')
      expect(events.map(event => event.envelope?.preview)).toEqual(['first original π\n', 'second original 二\n'])
      expect(events.map(({ seq: _seq, ...event }) => JSON.stringify(event))).toEqual([JSON.stringify(first), JSON.stringify(second)])
      expect(synchronousError).toBeUndefined(); expect(preparedSecond).toBe(1); expect(installedSecond).toBe(1)
      // The actual outer hold is still fencing optional authority in both arms.
      expect(() => f.document.beginAction()).toThrow(expect.objectContaining({ code: 'FACT_RECOVERY_REQUIRED' }))
      expect(f.trace.filter(item => (item as { kind: string }).kind === 'source.hold')).toHaveLength(1)
      expect(f.trace.filter(item => (item as { kind: string; source?: number }).kind === 'source.closed'
        && (item as { source?: number }).source === f.identity(f.outer))).toHaveLength(0)
    } finally { gate.resolve(); await f.finish(raw) }
  })
}

it('characterizes original optional store not-issued under the outer hold, then original Stop cancellation', async () => {
  const f = await fixture('store-stop')
  let installed = 0, cancelled = 0, raw: Buffer | undefined
  const original = { type: 'code/store' as const, version: 1 as const, cellId: 'original', writes: [['kept-original', 7] as [string, number]] }
  try {
    f.outer.holdRecovery()
    await expect(f.facts.store(original, () => { installed++; f.note('store.install') },
      () => { cancelled++; f.note('store.cancel') })).rejects.toMatchObject({
      code: 'FACT_RECOVERY_REQUIRED', outcome: { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' } })
    f.note('store.before.stop', { installed, cancelled, state: f.facts.observationState() })
    expect(installed).toBe(0); expect(cancelled).toBe(0)
    f.facts.stopOptional()
    await f.facts.refresh()
    f.note('store.after.stop', { installed, cancelled, state: f.facts.observationState(), inputBytes: JSON.stringify(original) })
    raw = await f.snapshot()
    expect(installed).toBe(0); expect(cancelled).toBe(1)
    expect(f.document.view.events.filter(event => event.type === 'code/store')).toEqual([])
    expect(() => f.document.beginAction()).toThrow(expect.objectContaining({ code: 'FACT_RECOVERY_REQUIRED' }))
    expect(f.trace.filter(item => (item as { kind: string }).kind === 'store.capture')).toHaveLength(1)
  } finally { await f.finish(raw) }
})
