import { expect, it, vi } from 'vitest'
const controls = vi.hoisted(() => ({
  subs: [] as import('@i-harness/subagent').RegisterSubagentResult[],
  subStores: [] as (import('@i-harness/subagent').TaskResultStore | undefined)[],
  sourceInputs: [] as Parameters<NonNullable<import('@i-harness/subagent').TaskResultStore['forSource']>>[],
  holdSource: undefined as undefined | (() => Promise<void>), captures: 0,
  holdOpen: undefined as undefined | (() => Promise<void>), opens: 0, closes: 0, drains: 0,
}))
vi.mock('@i-harness/subagent', async original => {
  const native = await original<typeof import('@i-harness/subagent')>()
  return { ...native, registerSubagent(...args: Parameters<typeof native.registerSubagent>) {
    controls.subStores.push(args[2].results)
    const sub = native.registerSubagent(...args); controls.subs.push(sub); return sub
  } }
})
vi.mock('../src/lifecycle/generation-actions.ts', async original => {
  const native = await original<typeof import('../src/lifecycle/generation-actions.ts')>()
  return { ...native, createGenerationLifecycle(...args: Parameters<typeof native.createGenerationLifecycle>) {
    const lifecycle = native.createGenerationLifecycle(...args)
    if (args[1] !== 'child') return lifecycle
    const open = lifecycle.open.bind(lifecycle), drain = lifecycle.drain.bind(lifecycle)
    lifecycle.open = async (...input) => {
      controls.opens++
      const generation = await open(...input), close = generation.close.bind(generation)
      generation.close = async (...closeArgs) => { controls.closes++; await close(...closeArgs) }
      await controls.holdOpen?.()
      return generation
    }
    lifecycle.drain = async () => { controls.drains++; await drain() }
    return lifecycle
  } }
})
vi.mock('../src/lifecycle/task-result-retention.ts', async original => {
  const native = await original<typeof import('../src/lifecycle/task-result-retention.ts')>()
  return { ...native, createTaskResultRetention(...args: Parameters<typeof native.createTaskResultRetention>) {
    const store = native.createTaskResultRetention(...args), forSource = store.forSource!.bind(store)
    store.forSource = async (...input) => {
      controls.sourceInputs.push(input)
      const bound = await forSource(...input), capture = bound.capture.bind(bound)
      bound.capture = (...captureArgs) => { controls.captures++; return capture(...captureArgs) }
      await controls.holdSource?.()
      return bound
    }
    return store
  } }
})
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { builtinRoles, driveFollowups, type SubagentStateSnapshot } from '@i-harness/subagent'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '../src/service.ts'
import { controlledModel } from './controlled-model.ts'
import { createSessionAssembly } from '../src/assembly.ts'
import { registerCodeMode } from '@i-harness/code-mode'
import { createResidentActivation } from '../src/lifecycle/resident-activation.ts'

async function heldCold(limits: { timeoutMs?: number; maxAttempts?: number } = {}) {
  controls.subs = []; controls.subStores = []; controls.sourceInputs = []; controls.captures = 0; controls.holdSource = undefined
  controls.holdOpen = undefined; controls.opens = 0; controls.closes = 0; controls.drains = 0
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'gap-'))
  await writeFile(join(root, 'settings.json'), '{}')
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' }); await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent' })
  const child = await coordinator.openManagedDocument('child')
  await child.delivery.record({ type: 'subagent/inbox', messageId: 'original', message: 'queued', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
  await child.close(); await coordinator.releaseOwnership('child')
  const restoredState: SubagentStateSnapshot = { formatVersion: 1, jobs: [], roles: builtinRoles(), agentTable: [{ path: 'root/helper', status: 'waiting', mailbox: [], sessionId: 'child', roleName: 'general', lastInboxSeq: -1 }] }
  const mounted = Promise.withResolvers<import('../src/assembly.ts').SessionAssembly>(), release = Promise.withResolvers<void>()
  let requests = 0, mountFailure: { value: unknown } | undefined
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: 'test-mock', model: controlledModel(async function* () { requests++; yield { type: 'text/chunk', text: 'done' }; yield { type: 'end' } }), codeMode: { mode: 'off' }, restoredState,
    modelActionTimeoutMs: limits.timeoutMs, modelActionMaxAttempts: limits.maxAttempts,
    contextOutputSettingsPath: join(root, 'settings.json'), extensionsFor: async () => ({ options: {}, async mount(assembly) { mounted.resolve(assembly); await release.promise; if (mountFailure) throw mountFailure.value } }) })
  const constructing = service.assemblyFor('parent'); void constructing.catch(() => {})
  const assembly = await mounted.promise, sub = controls.subs.at(-1)!, entry = sub.table.get('root/helper')!
  return { service, coordinator, assembly, sub, entry, constructing, release: release.resolve, requests: () => requests,
    failMount(value: unknown) { mountFailure = { value } },
    async close() { release.resolve(); controls.holdSource = undefined; await constructing.catch(() => {}); await service.close(); await coordinator.close() } }
}

// Removing the service-owned publication gate lets the genuine restored inbox
// open a generation while the extension still holds construction.
it('holds the original cold inbox until exact live publication and runs a second inbox after creation exits', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'ra-'))
  await writeFile(join(root, 'settings.json'), '{}')
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent' })
  const child = await coordinator.openManagedDocument('child')
  await child.delivery.record({ type: 'subagent/inbox', messageId: 'original', message: 'first original inbox', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
  await child.close(); await coordinator.releaseOwnership('child')
  const restoredState: SubagentStateSnapshot = { formatVersion: 1, jobs: [], roles: builtinRoles(), agentTable: [{ path: 'root/helper', status: 'waiting', mailbox: [], sessionId: 'child', roleName: 'general', lastInboxSeq: -1 }] }
  const mounted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let requests = 0
  let held: import('../src/assembly.ts').SessionAssembly | undefined
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: 'test-mock', model: controlledModel(async function* () { requests++; yield { type: 'text/chunk', text: 'original result' }; yield { type: 'end' } }), codeMode: { mode: 'off' }, restoredState,
    contextOutputSettingsPath: join(root, 'settings.json'), extensionsFor: async () => ({ options: {}, async mount(assembly) { held = assembly; mounted.resolve(); await release.promise; return undefined } }) })
  const first = service.assemblyFor('parent'), repeated = service.assemblyFor('parent')
  try {
    await mounted.promise
    expect(held!.subagentState().agentTable[0]).toMatchObject({ status: 'waiting', lastInboxSeq: -1 })
    const document = await coordinator.openManagedDocument('child')
    expect(document.view.events.filter(e => e.type === 'context/action')).toEqual([])
    expect(document.view.events.filter(e => e.type === 'user/message')).toEqual([])
    expect(requests).toBe(0)
    release.resolve()
    const assembly = await first
    expect(await repeated).toBe(assembly)
    await expect.poll(() => requests).toBe(1)
    await expect.poll(() => assembly.subagentState().agentTable[0]?.status).toBe('waiting')
    await expect.poll(() => assembly.subagentState().agentTable[0]?.result?.kind).toBe('retained')
    expect(assembly.subagentState().agentTable[0]?.lastInboxSeq).toBe(0)
    const send = assembly.tools.get('followup_task')!
    await send.execute({ target: 'root/helper', message: 'second original inbox' }, {})
    await expect.poll(() => requests).toBe(2)
    await expect.poll(() => assembly.subagentState().agentTable[0]?.status).toBe('waiting')
    await expect.poll(() => assembly.subagentState().agentTable[0]?.result?.kind).toBe('retained')
  } finally { release.resolve(); await first.catch(() => {}); await repeated.catch(() => {}); await service.close(); await coordinator.close() }
}, 20_000)

it.each([false, true])('retains original root cleanup callbacks and dependencies across alias replacement (cancelFails=%s)', async cancelFails => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'bar-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const document = await coordinator.openManagedDocument('parent'), closeDocument = vi.spyOn(document, 'close')
  let cancels = 0, disposes = 0, fail = true, replacementCancels = 0, replacementDisposes = 0
  let originalMount: import('@i-harness/code-mode').CodeModeMount | undefined
  let originalCancel: import('@i-harness/code-mode').CodeModeMount['cancel'] | undefined
  let originalDispose: import('@i-harness/code-mode').CodeModeMount['dispose'] | undefined
  const assembly = await createSessionAssembly({ workspace: root, sessionId: 'parent', coordinator, modelPolicy: 'test-mock', codeMode: { mode: 'mixed' }, codeModeFactory(ctx, tools, options) {
    const mount = registerCodeMode(ctx, tools, options), cancel = mount.cancel.bind(mount), dispose = mount.dispose.bind(mount)
    mount.cancel = async function (...args) { expect(this).toBe(mount); cancels++; if (cancelFails && fail) throw undefined; await cancel(...args) }
    mount.dispose = async function () { expect(this).toBe(mount); disposes++; if (fail) throw false; await dispose() }
    originalMount = mount; originalCancel = mount.cancel; originalDispose = mount.dispose
    return mount
  } })
  try {
    await expect(assembly.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(closeDocument).not.toHaveBeenCalled()
    expect([cancels, disposes]).toEqual([1, 1])
    originalMount!.cancel = async () => { replacementCancels++ }
    originalMount!.dispose = async () => { replacementDisposes++ }
    await expect(assembly.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(closeDocument).not.toHaveBeenCalled()
    expect([cancels, disposes]).toEqual([cancelFails ? 2 : 1, 2])
    expect([replacementCancels, replacementDisposes]).toEqual([0, 0])
    fail = false
    await assembly.dispose()
    expect([cancels, disposes]).toEqual([cancelFails ? 3 : 1, 3])
    expect(closeDocument).toHaveBeenCalledTimes(1)
    await assembly.dispose()
    expect([cancels, disposes]).toEqual([cancelFails ? 3 : 1, 3])
    expect([replacementCancels, replacementDisposes]).toEqual([0, 0])
    expect(closeDocument).toHaveBeenCalledTimes(1)
    console.info('root-original-cleanup-evidence', JSON.stringify({ root, cancelFails, counts: { cancels, disposes, replacementCancels, replacementDisposes }, documentCloses: closeDocument.mock.calls.length }))
  } finally {
    fail = false
    originalMount!.cancel = originalCancel!; originalMount!.dispose = originalDispose!
    // A failing RED may have credited the replacement no-op. Close the exact
    // original fixture resource explicitly rather than leave that debt open.
    if (replacementDisposes) await originalDispose!.call(originalMount!)
    await assembly.dispose(); await coordinator.close()
  }
})

it.each(['close', 'extension-false', 'hook-revoke'] as const)('retires the exact pending service ticket before publication (%s)', async mode => {
  const f = await heldCold()
  let closing: Promise<void> | undefined
  try {
    expect(controls.sourceInputs).toEqual([])
    if (mode === 'close') closing = f.service.closeSession('parent')
    if (mode === 'extension-false') f.failMount(false)
    if (mode === 'hook-revoke') f.service.onAssembly(assembly => assembly.revokeNewWork())
    f.release()
    const result = await f.constructing.then(value => ({ value }), error => ({ error }))
    if (mode === 'extension-false') expect(result).toEqual({ error: false })
    if (mode === 'hook-revoke') expect(result).toHaveProperty('value', f.assembly)
    await closing
    await f.entry.followupChain
    expect(f.requests()).toBe(0); expect(controls.sourceInputs).toEqual([])
    expect(f.entry.lastInboxSeq).toBe(-1)
    expect(f.entry.session.events.filter(e => e.type === 'context/action' || e.type === 'user/message')).toEqual([])
  } finally { await closing; await f.close() }
})

it('joins the original late source with the exact current callback and admits no generation or generic error capture after retirement', async () => {
  const f = await heldCold(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  controls.holdSource = async () => { entered.resolve(); await release.promise }
  try {
    f.release(); await f.constructing; await entered.promise
    expect(controls.sourceInputs).toHaveLength(1)
    const [context, current] = controls.sourceInputs[0]!
    expect(context).toBeUndefined(); expect(current!()).toBe(true)
    f.assembly.revokeNewWork()
    expect(current!()).toBe(false)
    release.resolve(); await f.entry.followupChain
    expect(controls.sourceInputs).toHaveLength(1); expect(controls.captures).toBe(0)
    expect(f.requests()).toBe(0); expect(f.entry.lastInboxSeq).toBe(-1)
    expect(f.entry.session.events.filter(e => e.type === 'context/action' || e.type === 'user/message')).toEqual([])
  } finally { release.resolve(); await f.close() }
})

it.each(['prior-result', 'table-callback', 'job-callback'] as const)('revalidates the original service execution after %s', async gap => {
  const f = await heldCold(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let off = () => {}, previousSettles = 0
  try {
    if (gap === 'prior-result') {
      f.release(); await f.constructing
      await expect.poll(() => f.entry.result?.kind).toBe('retained')
      const previous = f.entry.resultCapture!, settle = previous.settle.bind(previous)
      previous.settle = async () => { previousSettles++; entered.resolve(); await release.promise; return settle() }
      controls.sourceInputs = []; controls.captures = 0
      await f.assembly.tools.get('followup_task')!.execute({ target: f.entry.path, message: 'next' }, {})
      await entered.promise
    } else if (gap === 'table-callback') {
      off = f.sub.table.subscribe(change => { if (change.entry === f.entry && change.entry.status === 'running') f.assembly.revokeNewWork() })
    } else {
      const job = f.sub.jobs.registerJob('root', 'subagent', 'original job')
      f.entry.jobId = job.id
      off = f.sub.jobs.subscribe(job.id, row => { if (row.status === 'running') f.assembly.revokeNewWork() })
    }
    const cursor = f.entry.lastInboxSeq
    if (gap === 'prior-result') f.assembly.revokeNewWork()
    else { f.release(); await f.constructing }
    release.resolve(); await f.entry.followupChain
    expect(f.entry.lastInboxSeq).toBe(cursor)
    expect(controls.sourceInputs).toEqual([]); expect(controls.captures).toBe(0)
    expect(f.requests()).toBe(gap === 'prior-result' ? 1 : 0)
    if (gap === 'prior-result') expect(previousSettles).toBe(1)
  } finally { off(); release.resolve(); await f.close() }
})

it('refuses synchronous reentrant assembly cleanup locally while retaining the original producer for external retry', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 're-'))
  let assembly: import('../src/assembly.ts').SessionAssembly | undefined
  let reenter = true, cancels = 0, disposes = 0
  assembly = await createSessionAssembly({ workspace: root, modelPolicy: 'test-mock', codeMode: { mode: 'mixed' }, codeModeFactory(ctx, tools, options) {
    const mount = registerCodeMode(ctx, tools, options), cancel = mount.cancel.bind(mount), dispose = mount.dispose.bind(mount)
    mount.cancel = async (...args) => { cancels++; if (reenter) { reenter = false; await assembly!.dispose() }; await cancel(...args) }
    mount.dispose = async () => { disposes++; await dispose() }
    return mount
  } })
  // Observe the same real cleanup flight from outside the reentrant callback.
  const closing = assembly.dispose()
  const outcome = await Promise.race([closing.then(() => 'resolved', () => 'rejected'), new Promise<string>(resolve => setTimeout(() => resolve('self-wait'), 100))])
  expect(outcome).toBe('rejected')
  await assembly.dispose()
  expect([cancels, disposes]).toEqual([1, 1])
}, 2000)

it('keeps the original immutable intent and expired clock when an unconsumed pending tuple is rescheduled', async () => {
  const f = await heldCold({ timeoutMs: 20, maxAttempts: 2 })
  try {
    const inbox = f.entry.session.events.find(e => e.type === 'subagent/inbox')!
    if (inbox.type !== 'subagent/inbox') throw Error('missing fixture inbox')
    const original = f.sub.captureFollowupGeneration!(f.entry, inbox)
    expect(Object.isFrozen(original)).toBe(true); expect(Object.isFrozen(original.start)).toBe(true)
    expect(original).toMatchObject({ timeoutMs: 20, maxAttempts: 2 })
    f.entry.controller.abort()
    await f.entry.followupChain
    f.entry.controller = new AbortController()
    const rescheduled = driveFollowups({ agents: f.sub.agents, table: f.sub.table, jobs: f.sub.jobs,
      activation: f.sub.followupActivation, captureGeneration: f.sub.captureFollowupGeneration, openGeneration: f.sub.followupGeneration,
      rebuild: (entry, controller, current) => f.sub.ensureResident(entry, controller, current) }, f.entry, 'child')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(f.sub.captureFollowupGeneration!(f.entry, inbox)).toBe(original)
    expect(controls.sourceInputs).toEqual([]); expect(f.requests()).toBe(0)
    f.release(); await f.constructing; await rescheduled
    expect(f.requests()).toBe(0)
    const opening = f.entry.session.events.find(e => e.type === 'context/action' && e.op === 'open')
    expect(opening).toMatchObject({ startedAt: original.start.wall, expiresAt: original.start.wall + 20 })
  } finally { await f.close() }
})

it('runs a legitimate active-ticket followup after interrupt aborted the older turn controller', async () => {
  const f = await heldCold()
  try {
    f.release(); await f.constructing
    await f.entry.followupChain
    expect(f.requests()).toBe(1)
    const older = f.entry.controller
    await f.assembly.tools.get('interrupt_agent')!.execute({ target: f.entry.path }, {})
    expect(older.signal.aborted).toBe(true)
    await f.assembly.tools.get('followup_task')!.execute({ target: f.entry.path, message: 'legitimate later turn' }, {})
    await f.entry.followupChain
    expect(f.requests()).toBe(2); expect(f.entry.controller).not.toBe(older)
    expect(f.entry.finalText).toBe('done')
  } finally { await f.close() }
})

it('separates pendingStop from active waits and permanently retires an unavailable original publication', async () => {
  let available = true
  const host = createResidentActivation(() => available), pendingStop = new AbortController(), external = new AbortController()
  const cancelled = host.ticket.wait(undefined, pendingStop.signal)
  pendingStop.abort(); expect(await cancelled).toBe(false)
  const first = host.ticket.wait(), repeated = host.ticket.wait()
  host.activate(); expect(await first).toBe(true); expect(await repeated).toBe(true)
  expect(await host.ticket.wait(undefined, pendingStop.signal)).toBe(true)
  external.abort(); expect(await host.ticket.wait(external.signal)).toBe(false)
  available = false; expect(host.ticket.current()).toBe(false)
  host.retire(); available = true; host.activate()
  expect(await host.ticket.wait()).toBe(false)
  const unavailable = createResidentActivation(() => false), held = unavailable.ticket.wait()
  unavailable.activate(); expect(await held).toBe(false); expect(unavailable.ticket.current()).toBe(false)
})

it('does not reacquire a source for the same unconsumed tuple after its original admitted source was interrupted', async () => {
  const f = await heldCold(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  controls.holdSource = async () => { entered.resolve(); await release.promise }
  try {
    f.release(); await f.constructing; await entered.promise
    f.entry.controller.abort(); release.resolve(); await f.entry.followupChain
    expect(f.entry.lastInboxSeq).toBe(-1); expect(controls.sourceInputs).toHaveLength(1)
    controls.holdSource = undefined
    const rescheduled = driveFollowups({ agents: f.sub.agents, table: f.sub.table, jobs: f.sub.jobs,
      activation: f.sub.followupActivation, captureGeneration: f.sub.captureFollowupGeneration, openGeneration: f.sub.followupGeneration,
      results: controls.subStores.at(-1), rebuild: (entry, controller, current) => f.sub.ensureResident(entry, controller, current) }, f.entry, 'child')
    await expect(rescheduled).rejects.toMatchObject({ code: 'GENERATION_CLOSED' })
    expect(controls.sourceInputs).toHaveLength(1)
    expect(f.requests()).toBe(0); expect(f.entry.lastInboxSeq).toBe(-1)
  } finally { release.resolve(); await f.close() }
})

it('does not reopen a ticket retired synchronously by its original availability callback', async () => {
  let checks = 0
  const host = createResidentActivation(() => { checks++; host.retire(); return true })
  const waiting = host.ticket.wait()
  host.activate()
  expect(await waiting).toBe(false)
  expect(host.ticket.current()).toBe(false)
  expect(await host.ticket.wait()).toBe(false)
  expect(checks).toBe(1)
})

it('latches a genuine late generation return and closes its exact lifecycle and action after service retirement', async () => {
  const f = await heldCold(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const owner = f.entry.factOwner!, begin = owner.beginAction.bind(owner)
  let actions = 0, finishes = 0
  owner.beginAction = (...args) => { const action = begin(...args), finish = action.finish.bind(action); actions++; action.finish = () => { finishes++; finish() }; return action }
  controls.holdOpen = async () => { entered.resolve(); await release.promise }
  try {
    f.release(); await f.constructing; await entered.promise
    expect([actions, controls.opens, controls.closes, controls.drains, finishes]).toEqual([1, 1, 0, 0, 0])
    f.assembly.revokeNewWork(); release.resolve(); await f.entry.followupChain
    expect([actions, controls.opens, controls.closes, controls.drains, finishes]).toEqual([1, 1, 1, 1, 1])
    expect(f.requests()).toBe(0); expect(controls.captures).toBe(0); expect(f.entry.lastInboxSeq).toBe(-1)
    expect(f.sub.agents.get('child')).toBeUndefined()
  } finally { release.resolve(); controls.holdOpen = undefined; await f.close() }
})

it('wakes an original pending waiter on exact entry replacement without waiting for global publication', async () => {
  const f = await heldCold()
  try {
    const originalDrive = f.entry.followupChain!
    f.sub.table.add(f.entry.path, { ...f.entry, controller: new AbortController() })
    await originalDrive
    expect(controls.sourceInputs).toEqual([]); expect(f.entry.lastInboxSeq).toBe(-1)
    f.release(); await f.constructing
    expect(f.requests()).toBe(0)
  } finally { await f.close() }
})

it.each([true, false])('opens a standalone ticket only at actual construction completion with its original caller gate (%s)', async callerAvailable => {
  controls.subs = []; controls.subStores = []; controls.sourceInputs = []; controls.captures = 0
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'direct-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' }); await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent' })
  const original = await coordinator.openManagedDocument('child')
  await original.delivery.record({ type: 'subagent/inbox', messageId: 'direct', message: 'direct queued inbox', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
  await original.close(); await coordinator.releaseOwnership('child')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let requests = 0
  const constructing = createSessionAssembly({ workspace: root, sessionId: 'parent', coordinator, executionCallerAvailable: () => callerAvailable, modelPolicy: 'test-mock',
    model: controlledModel(async function* () { requests++; yield { type: 'text/chunk', text: 'direct result' }; yield { type: 'end' } }),
    restoredState: { formatVersion: 1, roles: builtinRoles(), jobs: [], agentTable: [{ path: 'root/helper', status: 'waiting', sessionId: 'child', roleName: 'general', mailbox: [], lastInboxSeq: -1 }] },
    codeMode: { mode: 'mixed' }, codeModeFactory(ctx, tools, options) {
      const mount = registerCodeMode(ctx, tools, options), ready = mount.ready?.bind(mount)
      mount.ready = async () => { await ready?.(); if (options.sessionId === 'parent') { entered.resolve(); await release.promise } }
      return mount
    } })
  void constructing.catch(() => {})
  let assembly: import('../src/assembly.ts').SessionAssembly | undefined
  try {
    await entered.promise
    const sub = controls.subs.at(-1)!, entry = sub.table.get('root/helper')!
    expect(entry.status).toBe('waiting'); expect(controls.sourceInputs).toEqual([]); expect(requests).toBe(0)
    release.resolve(); assembly = await constructing; await entry.followupChain
    expect(requests).toBe(callerAvailable ? 1 : 0)
    expect(entry.lastInboxSeq).toBe(callerAvailable ? 0 : -1)
  } finally { release.resolve(); assembly ??= await constructing.catch(() => undefined); await assembly?.dispose(); await coordinator.close() }
}, 20_000)

it.each(['controller-field', 'caller-field'] as const)('captures the original assembly activation owner and caller callback once (%s)', async mutation => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'capture-'))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const supplied = createResidentActivation(() => true)
  const options: import('../src/assembly.ts').AssemblyOptions = { workspace: root, modelPolicy: 'test-mock', codeMode: { mode: 'mixed' },
    ...(mutation === 'controller-field' ? { residentActivation: supplied } : { executionCallerAvailable: () => false }),
    codeModeFactory(ctx, tools, input) {
      const mount = registerCodeMode(ctx, tools, input), ready = mount.ready?.bind(mount)
      mount.ready = async () => { await ready?.(); entered.resolve(); await release.promise }
      return mount
    } }
  const constructing = createSessionAssembly(options)
  let assembly: import('../src/assembly.ts').SessionAssembly | undefined
  try {
    await entered.promise
    if (mutation === 'controller-field') delete options.residentActivation
    else options.executionCallerAvailable = () => true
    release.resolve(); assembly = await constructing
    const ticket = controls.subs.at(-1)!.followupActivation!
    expect(ticket.current()).toBe(false)
    if (mutation === 'controller-field') { supplied.activate(); expect(ticket.current()).toBe(true) }
  } finally { release.resolve(); assembly ??= await constructing.catch(() => undefined); await assembly?.dispose() }
})
