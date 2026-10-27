import { expect, it, vi } from 'vitest'
import { createCodeOutputPublisher } from '../src/output-facts.ts'
import { fixture } from './cell-output-owner-fixture.ts'

for (const mode of ['native', 'memory'] as const) for (const reason of [undefined, null, false, 0, '']) for (const kind of ['throw', 'reject'] as const) {
  it(`retains the exact ${kind} retention failure ${String(reason)} without invoking the original producer twice (${mode})`, async () => {
    const f = await fixture(mode); await f.admit('original')
    let calls = 0, resumed = 0
    const publish = createCodeOutputPublisher(f.facts, input => {
      calls++; input.retainOutcome!(async () => { resumed++; return { kind: 'unavailable', reason: 'quota' } })
      if (kind === 'throw') throw reason
      return Promise.reject(reason)
    })
    const error = await publish({ type: 'output', cellId: 'original', origin: {}, item: { type: 'text', text: 'original literal π' } }).catch(error => error)
    expect(error).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' }); expect(containsRaw(error, reason)).toBe(true)
    await expect(f.facts.refresh()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect([calls, resumed]).toEqual([1, 0])
    expect(f.sources[1]!.captures).toHaveLength(0)
    await f.cleanup(true)
  })
}

for (const mode of ['native', 'memory'] as const) for (const reason of [undefined, null, false, 0, '']) for (const kind of ['output', 'terminal', 'store', 'cancel'] as const) {
  it(`keeps the original ${kind} callback obligation after raw failure ${String(reason)} and reentry (${mode})`, async () => {
    const f = await fixture(mode); await f.admit('original')
    let calls = 0
    const callback = () => { calls++; void f.facts.refresh().catch(() => {}); throw reason }
    let result: Promise<void>
    if (kind === 'output') result = f.facts.requiredPrepared('original', async () => ({ type: 'code/output', cellId: 'original', content: { type: 'text', text: 'literal' } }), callback)
    else if (kind === 'terminal') result = f.terminal('original', callback)
    else if (kind === 'store') result = f.facts.store({ type: 'code/store', version: 1, cellId: 'original', writes: [] }, callback, () => {})
    else {
      const outerAction = f.owner.beginAction(), outer = outerAction.registerSettlementSource(async () => {})
      outerAction.finish(); outer.holdRecovery()
      await expect(f.facts.store({ type: 'code/store', version: 1, cellId: 'original', writes: [] }, () => {}, callback)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      f.facts.stopOptional(); result = f.facts.refresh()
    }
    const error = await result.catch(error => error)
    expect(error).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' }); expect(containsRaw(error, reason)).toBe(true)
    await expect(f.facts.refresh()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(calls).toBe(1)
    expect(() => f.facts.assertObserved()).toThrow()
    expect(f.facts.observationState()).toBe('unavailable')
    await f.cleanup(true)
  })
}

function containsRaw(error: unknown, reason: unknown): boolean {
  if (Object.is(error, reason)) return true
  if (error instanceof AggregateError && error.errors.some(value => containsRaw(value, reason))) return true
  return error instanceof Error && Object.hasOwn(error, 'cause') && containsRaw(error.cause, reason)
}
for (const mode of ['native', 'memory'] as const) for (const reason of [undefined, null, false, 0, '']) {
  it(`retains a failed original terminal onSettled/action finish with exact raw reason ${String(reason)} (${mode})`, async () => {
    const f = await fixture(mode); await f.admit('original')
    let commits = 0, finishes = 0
    const cell = f.sources[1]!
    vi.spyOn(cell.action, 'finish').mockImplementation(() => { finishes++; void f.facts.refresh().catch(() => {}); throw reason })
    const error = await f.terminal('original', () => { commits++ }).then(() => { throw new Error('unexpected clean terminal') }, error => error)
    expect(containsRaw(error, reason)).toBe(true)
    await expect(f.facts.refresh()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect([commits, finishes]).toEqual([1, 1])
    expect(() => f.facts.assertObserved()).toThrow()
    expect(cell.descriptor!.readCut().failed).toBe(true)
    await f.cleanup(true)
  })
}


it('a synchronous callback may return its reentrant original drive without holding the pump lane', async () => {
  const f = await fixture('memory'); await f.admit('original')
  let calls = 0
  await f.facts.requiredPrepared('original', async () => ({ type: 'code/output', cellId: 'original', content: { type: 'text', text: 'literal' } }), () => { calls++; return f.facts.refresh() })
  expect(calls).toBe(1)
  await f.cleanup()
})

it('revisits only the registered original recovery-required retention handle after synchronous producer reentry', async () => {
  const f = await fixture('memory'); await f.admit('original')
  let calls = 0, resumed = 0, installed = 0
  const publish = createCodeOutputPublisher(f.facts, input => {
    calls++; void f.facts.refresh().catch(() => {})
    input.retainOutcome!(async () => { resumed++; return { kind: 'unavailable', reason: 'quota' } })
    return Promise.resolve({ kind: 'recovery-required' })
  })
  await expect(publish({ type: 'output', cellId: 'original', origin: {}, item: { type: 'text', text: 'original retained π' }, committed: () => { installed++ } })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  await f.facts.refresh()
  expect([calls, resumed, installed]).toEqual([1, 1, 1])
  expect(f.sources[1]!.captures).toHaveLength(1)
  expect(f.owner.view.events.filter(e => e.type === 'code/output')).toMatchObject([{ envelope: { preview: 'original retained π' } }])
  await f.cleanup()
})

it.each(['native', 'memory'] as const)('passes the exact original admission-owned assertHeld to the one retention invocation (%s)', async mode => {
  const f = await fixture(mode); await f.admit('original')
  let actual: (() => void) | undefined, calls = 0
  const publish = createCodeOutputPublisher(f.facts, input => { calls++; actual = input.assertHeld; input.assertHeld!(); return Promise.resolve({ kind: 'unavailable', reason: 'quota' }) })
  await publish({ type: 'output', cellId: 'original', origin: {}, item: { type: 'text', text: 'original π' } })
  expect(calls).toBe(1); expect(actual).toBe(f.sources[1]!.source.assertHeld)
  await f.cleanup()
})

for (const mode of ['native', 'memory'] as const) for (const kind of ['retention', 'installation'] as const) {
  it(`an already waiting original source close rejects a later irreversible ${kind} failure without inventing its seal (${mode})`, async () => {
    const f = await fixture(mode); await f.admit('original')
    const cell = f.sources[1]!, closing = cell.source.close()
    void closing.catch(() => {})
    await cell.lifecycleEntered
    let finishes = 0, invocations = 0
    vi.spyOn(cell.action, 'finish').mockImplementation(() => { finishes++ })
    const publish = createCodeOutputPublisher(f.facts, () => { invocations++; return kind === 'retention' ? Promise.reject(undefined) : Promise.resolve({ kind: 'unavailable', reason: 'quota' }) })
    await expect(publish({ type: 'output', cellId: 'original', origin: {}, item: { type: 'text', text: 'original late π' }, committed: () => { if (kind === 'installation') { invocations++; throw undefined } } })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    f.note('late-failure-before-close-join', { failure: kind, finishes, invocations, reason: 'raw-undefined', cut: cell.descriptor!.readCut() })
    await f.save('late-failure-before-close-join')
    const closeError = await closing.catch(error => error)
    expect(closeError).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' }); expect(containsRaw(closeError, undefined)).toBe(true)
    expect(finishes).toBe(0); expect(f.sources).toHaveLength(2)
    cell.source.assertHeld()
    expect(cell.descriptor!.readCut()).toMatchObject({ pending: 1, failed: true })
    expect(f.owner.view.events.filter(e => e.type === 'code/cell').map(e => e.state)).toEqual(['started'])
    await expect(f.facts.refresh()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(invocations).toBe(kind === 'retention' ? 1 : 2)
    f.facts.stopOptional()
    expect(cell.action.signal.aborted).toBe(true)
    await expect(f.facts.required({ type: 'code/cell', cellId: 'original', state: 'terminated' })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(finishes).toBe(0)
    expect(f.owner.view.events.filter(e => e.type === 'code/cell').map(e => e.state)).toEqual(['started'])
    await f.cleanup(true)
  })
}

it.each(['native', 'memory'] as const)('a waiting original close stays live through retryable original resume rejection and succeeds only after the actual terminal seal (%s)', async mode => {
  const f = await fixture(mode); await f.admit('original')
  const cell = f.sources[1]!, closing = cell.source.close()
  let ended = false, unknown = true, invoked = 0, resumed = 0, installed = 0
  void closing.then(() => { ended = true }, () => { ended = true })
  await cell.lifecycleEntered
  const publish = createCodeOutputPublisher(f.facts, input => {
    invoked++
    input.retainOutcome!(async () => { resumed++; if (unknown) throw Object.assign(new Error('original resumable uncertainty'), { code: 'FACT_RECOVERY_REQUIRED' }); return { kind: 'unavailable', reason: 'quota' } })
    return Promise.resolve({ kind: 'recovery-required' })
  })
  await expect(publish({ type: 'output', cellId: 'original', origin: {}, item: { type: 'text', text: 'retryable π' }, committed: () => { installed++ } })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  await expect(f.facts.refresh()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  expect(ended).toBe(false); expect(cell.descriptor!.readCut()).toMatchObject({ pending: 1, failed: false })
  unknown = false; await f.facts.refresh()
  expect([invoked, resumed, installed]).toEqual([1, 2, 1])
  expect(ended).toBe(false); expect(cell.descriptor!.readCut()).toMatchObject({ pending: 0, failed: false })
  await f.terminal('original'); await closing
  expect(ended).toBe(true)
  expect(f.owner.view.events.filter(e => e.type === 'code/cell').map(e => e.state)).toEqual(['started', 'completed'])
  await f.cleanup()
})

it.each(['native', 'memory'] as const)('a real seal racing a sticky callback failure cannot acknowledge the original output or close its source (%s)', async mode => {
  const f = await fixture(mode); await f.admit('original')
  const cell = f.sources[1]!, closing = cell.source.close()
  void closing.catch(() => {})
  await cell.lifecycleEntered
  let calls = 0, finishes = 0
  vi.spyOn(cell.action, 'finish').mockImplementation(() => { finishes++ })
  await expect(f.facts.requiredPrepared('original', async () => ({ type: 'code/output', cellId: 'original', content: { type: 'text', text: 'original' } }), () => {
    calls++; void f.terminal('original').catch(() => {}); throw 0
  })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  const error = await closing.catch(error => error)
  expect(error).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' }); expect(containsRaw(error, 0)).toBe(true)
  cell.source.assertHeld()
  expect([calls, finishes]).toEqual([1, 0])
  expect(cell.descriptor!.readCut()).toMatchObject({ pending: 1, failed: true })
  expect(f.owner.view.events.filter(e => e.type === 'code/cell').map(e => e.state)).toEqual(['started'])
  await f.cleanup(true)
})

it.each(['native', 'memory'] as const)('revisiting the same sticky original retention failure does not create another failure transition (%s)', async mode => {
  const f = await fixture(mode); await f.admit('original')
  const cell = f.sources[1]!, publish = createCodeOutputPublisher(f.facts, () => Promise.reject(0))
  await expect(publish({ type: 'output', cellId: 'original', origin: {}, item: { type: 'text', text: 'once' } })).rejects.toThrow()
  const cut = cell.descriptor!.readCut()
  expect(cut.failed).toBe(true)
  await expect(f.facts.refresh()).rejects.toThrow()
  expect(cell.descriptor!.isCurrent(cut)).toBe(true)
  await f.cleanup(true)
})
