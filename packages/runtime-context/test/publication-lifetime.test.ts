import { expect, it } from 'vitest'
import { createSession, createNondurableFactOwner } from '@i-harness/core-session'
import { createRuntimeContext } from '../src/index.ts'

it('finite original settlement joins only its entry flights and leaves a later render lease held', async () => {
  const session = createSession(), owner = createNondurableFactOwner(session)
  const firstEntered = Promise.withResolvers<void>(), firstRelease = Promise.withResolvers<void>(), laterEntered = Promise.withResolvers<void>(), laterRelease = Promise.withResolvers<void>()
  let getters = 0, sources = 0, captures = 0, finishes = 0, releases = 0, text = 'first'
  const rc = createRuntimeContext(session, signal => {
    sources++; const action = owner.beginAction(signal)
    return { finish() { finishes++; action.finish() }, captureRuntimeContext(record, check) { captures++; return action.captureRuntimeContext(record, check) } }
  })
  rc.registerSection('instructions', () => { getters++; return text })
  const first = rc.render(undefined, () => ({ async release() { releases++; firstEntered.resolve(); await firstRelease.promise } }))
  await firstEntered.promise
  const management = rc.settleOriginals()
  text = 'later'
  const later = rc.render(undefined, () => ({ async release() { releases++; laterEntered.resolve(); await laterRelease.promise } }))
  try {
    await laterEntered.promise
    firstRelease.resolve(); await first; await management
    expect([getters, sources, captures, finishes, releases]).toEqual([2, 2, 2, 2, 2])
    let laterDone = false; void later.then(() => { laterDone = true })
    await Promise.resolve(); expect(laterDone).toBe(false)
    laterRelease.resolve(); await later
    const observed = [getters, sources, captures, finishes, releases]
    await rc.settleOriginals(); await rc.close()
    expect([getters, sources, captures, finishes, releases]).toEqual(observed)
  } finally { firstRelease.resolve(); laterRelease.resolve(); await Promise.allSettled([first, later, management]); await rc.close() }
})

it('same-text and adjacent dedupe never acquire another publication lease', async () => {
  const session = createSession(), rc = createRuntimeContext(session), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let retains = 0, releases = 0
  rc.registerSection('instructions', () => 'same')
  const retain = () => { retains++; return { async release() { releases++; entered.resolve(); await release.promise } } }
  const first = rc.render(undefined, retain)
  await entered.promise
  const adjacent = rc.render(undefined, retain)
  try {
    expect(retains).toBe(1)
    release.resolve(); await Promise.all([first, adjacent])
    await rc.render(undefined, retain)
    expect([retains, releases]).toEqual([1, 1])
    expect(session.events.filter(event => event.type === 'runtime/context')).toHaveLength(1)
  } finally { release.resolve(); await Promise.allSettled([first, adjacent]); await rc.close() }
})

it('terminal publication retries the exact failed lease without finishing its action twice or reading getters', async () => {
  const session = createSession(), owner = createNondurableFactOwner(session)
  let finishes = 0, getters = 0, factories = 0, retains = 0, releases = 0, fail = true
  const fault = Error('original lease cleanup held')
  const rc = createRuntimeContext(session, signal => { factories++; const action = owner.beginAction(signal); return { finish() { finishes++; action.finish() }, captureRuntimeContext: action.captureRuntimeContext } })
  rc.registerSection('instructions', () => { getters++; return 'same body' })
  try {
    await expect(rc.render(undefined, () => { retains++; return { async release() { releases++; if (fail) throw fault } } })).rejects.toBe(fault)
    const observed = [getters, factories, retains]
    await expect(rc.settleOriginals()).rejects.toBe(fault)
    expect(finishes).toBe(1); expect(releases).toBe(2)
    expect([getters, factories, retains]).toEqual(observed)
    fail = false; await rc.settleOriginals()
    expect([finishes, releases]).toEqual([1, 3]); expect([getters, factories, retains]).toEqual(observed)
    await rc.render(undefined, () => { throw Error('same-text dedupe must not retain') })
    expect(session.events.filter(event => event.type === 'runtime/context')).toHaveLength(1)
  } finally { fail = false; await rc.close() }
})

it.each(['retain', 'capture'] as const)('balances only actually acquired original resources after %s setup failure', async mode => {
  const session = createSession(), owner = createNondurableFactOwner(session), fault = Error('original setup failure'), cleanup = Error('original setup lease cleanup failure')
  let finishes = 0, captures = 0, releases = 0, failRelease = true
  const rc = createRuntimeContext(session, signal => { const action = owner.beginAction(signal); return { finish() { finishes++; action.finish() }, captureRuntimeContext() { captures++; throw fault } } })
  rc.registerSection('instructions', () => 'setup only')
  try {
    const failed = await rc.render(undefined, () => { if (mode === 'retain') throw fault; return { async release() { releases++; if (failRelease) throw cleanup } } }).catch(error => error)
    if (mode === 'retain') expect(failed).toBe(fault)
    else { expect(failed).toBeInstanceOf(AggregateError); expect(failed.errors).toEqual([fault, cleanup]); expect(failed.cause).toBe(fault) }
    expect(finishes).toBe(1); expect(captures).toBe(mode === 'retain' ? 0 : 1); expect(session.events).toEqual([])
    failRelease = false; await rc.settleOriginals()
    expect(finishes).toBe(1); expect(releases).toBe(mode === 'retain' ? 0 : 2)
  } finally { failRelease = false; await rc.close() }
})

it('Stop after committed capture joins its original lease before rejecting readiness', async () => {
  const session = createSession(), rc = createRuntimeContext(session), stop = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let released = false
  rc.registerSection('instructions', () => 'already committed current')
  const run = rc.render(stop.signal, () => ({ async release() { entered.resolve(); await release.promise; released = true } })); void run.catch(() => {})
  try {
    await entered.promise; const reason = Error('actual Stop during original cleanup'); stop.abort(reason)
    expect(released).toBe(false); release.resolve()
    await expect(run).rejects.toBe(reason); expect(released).toBe(true)
    expect(session.events.filter(event => event.type === 'runtime/context')).toHaveLength(1)
    await rc.settleOriginals()
  } finally { release.resolve(); await run.catch(() => {}); await rc.close() }
})
