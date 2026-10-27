import { expect, it, vi } from 'vitest'
import type { CodeSettlementFact, SessionEvent } from '@i-harness/core-session'
import { fixture, output } from './cell-output-owner-fixture.ts'

it.each(['native', 'memory'] as const)('retains the admission-owned source for later output after a successful refresh (%s)', async mode => {
  const f = await fixture(mode)
  await f.admit('original')
  expect(f.sources).toHaveLength(2)
  const original = f.sources[1]!
  expect(original.descriptor).toBeDefined()
  await f.facts.requiredPrepared('original', async () => output('original', 'first'))
  original.source.assertHeld()
  await f.facts.requiredPrepared('original', async () => output('original', 'second'))
  expect(f.sources).toHaveLength(2)
  expect(original.captures).toHaveLength(2)
  expect(f.owner.view.events.filter(e => e.type === 'code/output').map(e => e.envelope?.preview)).toEqual(['first', 'second'])
  await f.terminal('original'); expect(() => original.source.assertHeld()).toThrow()
  await f.cleanup()
})

it.each(['native', 'memory'] as const)('global original order fences B during actual concurrent document/source close while A preparation is unknown (%s)', async mode => {
  const f = await fixture(mode)
  await f.admit('A'); await f.admit('B')
  let unknown = true, installed = 0
  await expect(f.facts.requiredPrepared('A', async () => { if (unknown) throw new Error('A original storage unknown'); return output('A') })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  await expect(f.facts.requiredPrepared('B', async () => output('B'), () => { installed++ })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  const closing = f.document ? [f.document.close()] : f.sources.map(s => s.source.close())
  await Promise.all(closing.map(p => expect(p).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })))
  expect(f.sources[2]!.captures).toHaveLength(0); expect(installed).toBe(0)
  expect(f.owner.view.events.filter(e => e.type === 'code/output')).toEqual([])
  unknown = false
  await f.facts.refresh(); expect(installed).toBe(1)
  await f.cleanup()
})

it.each(['native', 'memory'] as const)('mount cancellation supplies truthful seals for admitted cells without output (%s)', async mode => {
  const f = await fixture(mode); await f.admit('no-output')
  expect(f.sources).toHaveLength(2)
  await f.cleanup()
  expect(f.drains).toBe(1)
  expect(f.owner.view.events.filter(e => e.type === 'code/cell').map(e => e.state)).toEqual(['started', 'terminated'])
})


it.each(['native', 'memory'] as const)('the callback-enrolled original store is first not-issued under its output hold, then commits on the same capture without Stop (%s)', async mode => {
  const f = await fixture(mode); await f.admit('original')
  const cell = f.sources[1]!, held = cell.source.holdRecovery
  let unknown = true, installed = 0, cancelled = 0, store: Promise<void> | undefined
  await expect(f.facts.requiredPrepared('original', async () => { if (unknown) throw new Error('original output unknown'); return output('original') }, () => {
    store = f.facts.store({ type: 'code/store', version: 1, cellId: 'original', writes: [['answer', 42]] }, () => { installed++ }, () => { cancelled++ })
    void store.catch(() => {})
  })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  unknown = false; await f.facts.refresh(); await store
  expect(f.stores).toHaveLength(1)
  expect(f.stores[0]!.outcomes[0]).toMatchObject({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
  const disposition = await f.stores[0]!.capture.observe()
  expect(disposition.kind).toBe(mode === 'native' ? 'committed' : 'memory-committed')
  expect(await f.stores[0]!.capture.reconcile()).toEqual(disposition)
  expect([installed, cancelled]).toEqual([1, 0]); expect(cell.action.signal.aborted).toBe(false)
  expect(cell.source.holdRecovery).toBe(held); cell.source.assertHeld()
  await f.terminal('original'); await f.cleanup()
  if (mode === 'native') {
    const storeIssues = f.issues.filter(i => i.events.some(e => (e as {type?: string}).type === 'code/store'))
    expect(storeIssues).toHaveLength(1)
    expect(disposition).toMatchObject({ kind: 'committed', receipt: { key: storeIssues[0]!.key } })
  } else expect(disposition).not.toHaveProperty('receipt')
})

it.each(['native', 'memory'] as const)('releases only the old B output0 hold across Q=[B.output0,A.store,B.output1] and preserves a renewed output1 hold (%s)', async mode => {
  const f = await fixture(mode); await f.admit('A'); await f.admit('B')
  const b = f.sources[2]!
  let unknown0 = true, unknown1 = true, installed = 0
  await expect(f.facts.requiredPrepared('B', async () => { if (unknown0) throw new Error('B0 unknown'); return output('B', 'B0') })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  await expect(f.facts.store({ type: 'code/store', version: 1, cellId: 'A', writes: [['answer', 42]] }, () => { installed++ }, () => {})).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  await expect(f.facts.requiredPrepared('B', async () => { if (unknown1) throw new Error('B1 unknown'); return output('B', 'B1') })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  unknown0 = false
  await expect(f.facts.refresh()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  expect(f.stores).toHaveLength(1); expect(installed).toBe(1)
  expect(f.stores[0]!.outcomes.some(o => o.kind === 'not-issued')).toBe(true)
  expect(await f.stores[0]!.capture.observe()).toMatchObject({ kind: mode === 'native' ? 'committed' : 'memory-committed' })
  expect(b.descriptor!.readCut()).toMatchObject({ pending: 1, recoveryPending: 1, failed: false })
  expect(f.trace).toContainEqual(expect.objectContaining({ kind: 'checkpoint-success', result: { kind: 'progress' }, cut: expect.objectContaining({ pending: 1, recoveryPending: 0, failed: false }) }))
  b.source.assertHeld(); expect(f.facts.observationState()).toBe('unavailable')
  expect(() => f.owner.beginAction()).toThrow()
  await expect(b.source.checkpoint()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  expect(() => f.owner.beginAction()).toThrow()
  unknown1 = false; await f.facts.refresh()
  expect(f.owner.view.events.filter(e => e.type === 'code/output' || e.type === 'code/store').map(e => e.type === 'code/output' ? e.envelope?.preview : e.type)).toEqual(['B0', 'code/store', 'B1'])
  await f.cleanup()
})

it.each(['native', 'memory'] as const)('B precaptured but not-issued remains fenced by the global head after A installation failure (%s)', async mode => {
  const f = await fixture(mode); await f.admit('A'); await f.admit('B')
  const b = f.sources[2]!, original = b.source.code.capture(output('B'))
  expect(await original.observe()).toMatchObject({ kind: 'not-issued' })
  let aCalls = 0, bCalls = 0
  await expect(f.facts.requiredPrepared('A', async () => output('A'), () => { aCalls++; throw 0 })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  await expect(f.facts.requiredPrepared('B', async () => output('B'), () => { bCalls++ })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  const closing = f.document ? [f.document.close()] : f.sources.map(s => s.source.close())
  await Promise.all(closing.map(p => expect(p).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })))
  expect(await original.observe()).toMatchObject({ kind: 'not-issued' })
  expect([aCalls, bCalls]).toEqual([1, 0]); expect(b.captures).toHaveLength(1)
  expect(f.owner.view.events.filter(e => e.type === 'code/output').map(e => e.cellId)).toEqual(['A'])
  if (mode === 'native') expect(f.issues.flatMap(i => i.events).filter(e => (e as {type?: string; cellId?: string}).type === 'code/output' && (e as {cellId?: string}).cellId === 'B')).toEqual([])
  await f.cleanup(true)
})

it.each(['native', 'memory'] as const)('an independent outer hold still fences the same never-issued original store until original Stop cancels once (%s)', async mode => {
  const f = await fixture(mode); await f.admit('original')
  const outerAction = f.owner.beginAction(), outer = outerAction.registerSettlementSource(async () => {})
  outerAction.finish(); outer.holdRecovery()
  let installed = 0, cancelled = 0
  await expect(f.facts.store({ type: 'code/store', version: 1, cellId: 'original', writes: [['never', 7]] }, () => { installed++ }, () => { cancelled++ })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  expect(f.stores).toHaveLength(1)
  const capture = f.stores[0]!.capture
  expect(await capture.observe()).toMatchObject({ kind: 'not-issued' })
  f.facts.stopOptional(); await f.facts.refresh()
  expect([installed, cancelled]).toEqual([0, 1])
  expect(await capture.observe()).toMatchObject({ kind: 'not-issued' })
  expect(f.stores[0]!.capture).toBe(capture)
  expect(f.owner.view.events.filter(e => e.type === 'code/store')).toEqual([])
  expect(f.issues.filter(i => i.events.some(e => (e as {type?: string}).type === 'code/store'))).toEqual([])
  expect(() => f.owner.beginAction()).toThrow()
  await outer.close(); await f.cleanup()
})

it.each(['native', 'memory'] as const)('enqueues a failed admission interrupted terminal once and closes its original sealed source (%s)', async mode => {
  const f = await fixture(mode), signal = new AbortController()
  const begin = f.owner.beginAction.bind(f.owner)
  vi.spyOn(f.owner, 'beginAction').mockImplementation(abort => {
    const action = begin(abort), record = action.facts.code.record.bind(action.facts.code)
    vi.spyOn(action.facts.code, 'record').mockImplementation(event => { signal.abort(); return record(event) })
    return action
  })
  await expect(f.facts.optional({ type: 'code/cell', cellId: 'failed', state: 'started' }, signal.signal)).rejects.toThrow()
  await f.facts.required({ type: 'code/cell', cellId: 'failed', state: 'interrupted', error: 'caller repeats original failed admission' })
  await f.cleanup()
  expect(f.sources).toHaveLength(2)
  expect(f.owner.view.events.filter(e => e.type === 'code/cell').map(e => e.state)).toEqual(['interrupted'])
})


it.each(['native', 'memory'] as const)('a refused duplicate admission cannot seal or finish the actual live original cell (%s)', async mode => {
  const f = await fixture(mode); await f.admit('original')
  await expect(f.facts.optional({ type: 'code/cell', cellId: 'original', state: 'started' })).rejects.toThrow()
  await f.facts.requiredPrepared('original', async () => output('original'))
  expect(f.owner.view.events.filter(e => e.type === 'code/cell').map(e => e.state)).toEqual(['started'])
  await f.cleanup()
})

it.each(['native', 'memory'] as const)('an action refused source registration by original Stop is finished only by its truthful interrupted terminal (%s)', async mode => {
  const f = await fixture(mode), signal = new AbortController()
  let finished = 0
  const begin = f.owner.beginAction.bind(f.owner)
  vi.spyOn(f.owner, 'beginAction').mockImplementation(abort => {
    const action = begin(abort), finish = action.finish.bind(action)
    vi.spyOn(action, 'finish').mockImplementation(() => { finished++; finish() })
    signal.abort()
    return action
  })
  await expect(f.facts.optional({ type: 'code/cell', cellId: 'refused', state: 'started' }, signal.signal)).rejects.toThrow()
  await f.facts.refresh()
  expect(finished).toBe(1); expect(f.sources).toHaveLength(1)
  expect(f.owner.view.events.filter(e => e.type === 'code/cell').map(e => e.state)).toEqual(['interrupted'])
  await f.cleanup()
})

it.each(['native', 'memory'] as const)('the terminal enqueue seals synchronously while earlier enrolled output still settles on its original source (%s)', async mode => {
  const f = await fixture(mode); await f.admit('original')
  let unknown = true
  await expect(f.facts.requiredPrepared('original', async () => { if (unknown) throw new Error('unknown'); return output('original') })).rejects.toThrow()
  const terminal = f.terminal('original'); void terminal.catch(() => {})
  expect(() => f.facts.requiredPrepared('original', async () => output('original', 'after seal'))).toThrow()
  await expect(terminal).rejects.toThrow()
  unknown = false; await f.facts.refresh()
  expect(f.owner.view.events.filter(e => e.type === 'code/output' || e.type === 'code/cell').map(e => e.type === 'code/cell' ? e.state : e.type)).toEqual(['started', 'code/output', 'completed'])
  await f.cleanup()
})

it.each(['native', 'memory'] as const)('restart interruption owns only its real mount source and creates no fictitious cell (%s)', async mode => {
  const f = await fixture(mode)
  await f.facts.required({ type: 'code/cell', cellId: 'restart-only', state: 'interrupted' })
  expect(f.sources).toHaveLength(1)
  expect(() => f.facts.requiredPrepared('restart-only', async () => output('restart-only'))).toThrow()
  await f.cleanup()
})

it.each(['native', 'memory'] as const)('B retains its exact precaptured not-issued handle behind unknown A and later commits that handle at Q head (%s)', async mode => {
  const f = await fixture(mode); await f.admit('A'); await f.admit('B')
  const b = f.sources[2]!, event = output('B', 'original B π'), original = b.source.code.capture(event)
  const capture = b.source.code.capture.bind(b.source.code)
  vi.spyOn(b.source.code, 'capture').mockImplementation(value => value.type === 'code/output' ? original : capture(value))
  let unknown = true
  await expect(f.facts.requiredPrepared('A', async () => { if (unknown) throw new Error('A unknown'); return output('A') })).rejects.toThrow()
  await expect(f.facts.requiredPrepared('B', async () => event)).rejects.toThrow()
  await expect(b.source.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  expect(await original.observe()).toMatchObject({ kind: 'not-issued' })
  expect(f.owner.view.events.filter(e => e.type === 'code/output')).toEqual([])
  unknown = false; await f.facts.refresh()
  const outcome = await original.observe()
  expect(outcome.kind).toBe(mode === 'native' ? 'committed' : 'memory-committed')
  expect(await original.reconcile()).toEqual(outcome); expect(b.captures).toEqual([original])
  expect(f.owner.view.events.filter(e => e.type === 'code/output').map(e => e.cellId)).toEqual(['A', 'B'])
  await f.cleanup()
})

it.each(['native', 'memory'] as const)('reference continuations use the same global queue and freeze DTOs before lazy original capture (%s)', async mode => {
  const f = await fixture(mode); await f.admit('original')
  const capture = vi.spyOn(f.sources[0]!.source.retention, 'capture')
  let unknown = true
  await expect(f.facts.requiredPrepared('original', async () => { if (unknown) throw new Error('unknown'); return output('original') })).rejects.toThrow()
  const ref = { id: 'ref', workspaceId: 'workspace', sessionId: 'session', callId: 'call', label: 'original', revision: 'rev', bytes: 1, originalBytes: 1, complete: true, expiresAt: 9999999999999 }
  const continuation = f.facts.captureReference(ref); ref.label = 'later mutation'
  expect(capture).not.toHaveBeenCalled()
  await expect(continuation()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  expect(capture).not.toHaveBeenCalled()
  unknown = false; await continuation()
  expect(capture).toHaveBeenCalledTimes(1)
  expect(f.owner.view.events.filter(e => e.type === 'code/output' || e.type === 'context/result-ref').map(e => e.type)).toEqual(['code/output', 'context/result-ref'])
  expect(f.owner.view.events.find(e => e.type === 'context/result-ref')).toMatchObject({ ref: { label: 'original' } })
  await f.cleanup()
})

it.each(['native', 'memory'] as const)('original Stop preserves an already committed Store capture and never cancels or reinstalls it (%s)', async mode => {
  const f = await fixture(mode); await f.admit('original')
  let installed = 0, cancelled = 0
  await f.facts.store({ type: 'code/store', version: 1, cellId: 'original', writes: [['kept', 7]] }, () => { installed++ }, () => { cancelled++ })
  const capture = f.stores[0]!.capture, outcome = await capture.observe()
  f.facts.stopOptional(); await f.facts.refresh()
  expect(await capture.reconcile()).toEqual(outcome)
  expect([installed, cancelled]).toEqual([1, 0])
  expect(f.owner.view.events.filter(e => e.type === 'code/store')).toHaveLength(1)
  await f.cleanup()
})

it.each(['native', 'memory'] as const)('invalid original output capture quarantines its retained cell and cannot become a clean owner cut (%s)', async mode => {
  const f = await fixture(mode); await f.admit('original')
  await expect(f.facts.requiredPrepared('original', async () => ({ type: 'wrong', cellId: 'original' } as unknown as CodeSettlementFact))).rejects.toThrow()
  expect(f.sources[1]!.descriptor!.readCut().failed).toBe(true)
  await f.cleanup(true)
})

it.each(['native', 'memory'] as const)('invalid original Store capture stays owned and quarantines its action cell before source close (%s)', async mode => {
  const f = await fixture(mode); await f.admit('original')
  await expect(f.facts.store({ type: 'wrong', cellId: 'original', version: 1, writes: [] } as unknown as Extract<SessionEvent, {type: 'code/store'}>, () => {}, () => {})).rejects.toThrow()
  expect(f.sources[1]!.descriptor!.readCut().failed).toBe(true)
  expect(f.stores).toHaveLength(1)
  await f.cleanup(true)
})


it.each(['native', 'memory'] as const)('original Stop cannot acknowledge an invalid Store capture as a successful cancellation (%s)', async mode => {
  const f = await fixture(mode); await f.admit('original')
  let cancelled = 0
  const result = f.facts.store({ type: 'wrong', cellId: 'original', version: 1, writes: [] } as unknown as Extract<SessionEvent, {type: 'code/store'}>, () => {}, () => { cancelled++ })
  f.facts.stopOptional()
  await expect(result).rejects.toMatchObject({ code: 'FACT_INVALID_GROUP' })
  expect(cancelled).toBe(0); expect(f.sources[1]!.descriptor!.readCut().failed).toBe(true)
  await f.cleanup(true)
})
