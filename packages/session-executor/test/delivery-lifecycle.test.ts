import { expect, it, vi } from 'vitest'
import { decodeFactBatch, readDeliveries } from '@i-harness/core-session'
import { createDeliveryFixture } from './helpers/delivery-fixture.ts'
import { receivedInputsFor } from '../src/lifecycle/received-inputs.ts'
import { withRewindFacts } from '../src/lifecycle/rewind-facts.ts'
import type { SessionAssembly } from '../src/assembly.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { RewindService } from '@i-harness/rewind'

async function boundary<T>(name: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Lifecycle boundary pending: ' + name)), 4000) })]) }
  finally { clearTimeout(timer!) }
}

it('confirms the original delivery close before invoking any rewind restoration effect', async () => {
  const f = await createDeliveryFixture()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), effect = Promise.withResolvers<void>()
  let effects = 0
  try {
    await f.start()
    const owner = await f.coordinator.openManagedDocument('parent'), append = vi.mocked(f.backend.appendOwnedBatch!).getMockImplementation()!
    vi.mocked(f.backend.appendOwnedBatch!).mockImplementation(async (...args) => {
      if (decodeFactBatch(args[3].bytes).events.some(e => e.type === 'agent/delivery-generation' && e.op === 'close' && e.reason === 'rewind')) {
        entered.resolve(); await release.promise
      }
      return append(...args)
    })
    const rewinding = withRewindFacts(owner, async record => {
      effects++; effect.resolve()
      await record({ type: 'rewind/point', version: 1, targetTurn: 0, anchorSeq: 0, mode: 'conversation', fileOps: [] })
    })
    try {
      await boundary('close precedes restoration', Promise.race([entered.promise, effect.promise]))
      expect(effects).toBe(0)
      expect(readDeliveries(owner.view).activeGeneration()).toBeDefined()
    } finally { release.resolve(); await rewinding }
    expect(effects).toBe(1)
    const events = (await f.backend.read('parent')).events
    const close = events.find(e => e.type === 'agent/delivery-generation' && e.op === 'close')!
    const marker = events.find(e => e.type === 'rewind/point')!
    expect(close.seq!).toBeLessThan(marker.seq!)
    expect(readDeliveries(owner.view).activeGeneration()).toBeUndefined()
    await f.evidence('rewind-close-before-effects')
  } catch (error) { await f.evidence('rewind-close-before-effects-failure', error); throw error }
  finally { release.resolve(); await boundary('rewind cleanup', f.close()) }
}, 20000)

it('managed filesystem rewind fences its own genuine bound child before restoration and the late original end stays quiet', async () => {
  const f = await createDeliveryFixture({ rewindFsWrite: true })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  try {
    await writeFile(join(f.root, 'greet.txt'), 'hello')
    await f.start()
    const assembly = await f.service.assemblyFor('parent'), owner = await f.coordinator.openManagedDocument('parent')
    const store = assembly.rewind!.store
    expect(assembly.rewind!.drain).toBeTypeOf('function')
    await assembly.rewind!.drain!()
    const points = await store.readPoints()
    expect(points).toHaveLength(1)
    expect(points[0]!.files).toContainEqual({ path: 'greet.txt', status: 'modified', preBlob: hash('hello'), isNewFile: false, afterHash: hash('goodbye') })
    expect(readDeliveries(owner.view).activeGeneration()).toBeDefined()
    expect(owner.view.events.filter(e => e.type === 'agent/delivery-source')).toHaveLength(1)
    const append = vi.mocked(f.backend.appendOwnedBatch!).getMockImplementation()!
    vi.mocked(f.backend.appendOwnedBatch!).mockImplementation(async (...args) => {
      if (decodeFactBatch(args[3].bytes).events.some(e => e.type === 'agent/delivery-generation' && e.op === 'close' && e.reason === 'rewind')) { entered.resolve(); await release.promise }
      return append(...args)
    })
    const rewinding = withRewindFacts(owner, appendEvent => new RewindService({ store, workspace: f.root }).execute(0, 'all', { appendEvent }))
    try {
      await boundary('same bound child close before fs rewind', entered.promise)
      expect(await readFile(join(f.root, 'greet.txt'), 'utf8')).toBe('goodbye')
      expect(await store.readPoints()).toHaveLength(1)
    } finally { release.resolve() }
    expect(await rewinding).toMatchObject({ truncated: true, errors: [] })
    expect(await readFile(join(f.root, 'greet.txt'), 'utf8')).toBe('hello')
    expect(await store.readPoints()).toEqual([])
    expect(readDeliveries(owner.view).activeGeneration()).toBeUndefined()
    f.releaseChild(); await boundary('late original child terminal', f.waitForTerminalCommitted())
    await assembly.drainParentNotifications?.(); await owner.settleFinishedActions()
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'subagent/end')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(0)
    expect(f.parentRequests).toHaveLength(2); expect(f.launchCount()).toBe(1)
    await f.evidence('full-fs-rewind-original-bound-child')
  } catch (error) { await f.evidence('full-fs-rewind-original-bound-child-failure', error); throw error }
  finally { release.resolve(); await boundary('full fs original cleanup', f.close()) }
}, 20000)

it('original unclassified task save failure blocks terminal delivery until explicit same-source settlement recovers', async () => {
  const f = await createDeliveryFixture({ holdTaskSaveFailure: true })
  try {
    await f.start(); f.releaseChild(); await boundary('original task save refused', f.waitForTaskSaveFailed())
    const assembly = await f.service.assemblyFor('parent')
    // The source has not requested close yet; settleFinishedActions must not
    // drain arbitrary running sources. Explicitly close this exact retained
    // original spawn source rather than manufacturing a terminal handle.
    await expect(f.settleOriginalSpawnSources()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    await assembly.drainParentNotifications?.()
    const before = (await f.backend.read('parent')).events
    expect(before.filter(e => e.type === 'subagent/end' || e.type === 'agent/delivery-received')).toHaveLength(0)
    expect(f.parentRequests).toHaveLength(2); expect(f.launchCount()).toBe(1)
    await f.evidence('original-task-save-blocked')
    f.releaseTaskSave()
    await f.settleOriginalSpawnSources()
    await f.waitForDeliveryRequest(); await f.waitForConsumed()
    const after = (await f.backend.read('parent')).events
    expect(after.filter(e => e.type === 'subagent/end')).toHaveLength(1)
    expect(after.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    expect(after.filter(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))).toHaveLength(1)
    expect(f.launchCount()).toBe(1)
    await f.evidence('original-task-save-same-source-recovered')
  } catch (error) { await f.evidence('original-task-save-failure', error); throw error }
  finally { f.releaseTaskSave(); await boundary('original task save cleanup', f.close()) }
}, 20000)

it('Stop during actual lane promotion preparation prevents first claim issuance and no later human revives it', async () => {
  const f = await createDeliveryFixture({ expectStopDiagnostics: true })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await f.start()
    const append = vi.mocked(f.backend.appendOwnedBatch!).getMockImplementation()!
    vi.mocked(f.backend.appendOwnedBatch!).mockImplementation(async (...args) => {
      if (decodeFactBatch(args[3].bytes).events.some(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))) { entered.resolve(); await release.promise }
      return append(...args)
    })
    f.releaseChild(); await boundary('original lane promotion prepared', entered.promise)
    const assembly = await f.service.assemblyFor('parent')
    f.service.cancelRunning!('parent')
    expect(assembly.inbox.pending()).toHaveLength(0)
    release.resolve(); await boundary('original promotion retires before close', f.service.awaitDeliveryStop('parent'))
    await f.service.submit('parent', 'new human after held promotion Stop', new AbortController().signal)
    await assembly.drainParentNotifications?.()
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))).toHaveLength(0)
    expect(f.parentRequests.some(request => JSON.stringify(request.messages).includes('<task_result>'))).toBe(false)
    expect(f.launchCount()).toBe(1)
    await f.evidence('Stop-before-original-promotion-issue')
  } catch (error) { await f.evidence('Stop-before-original-promotion-issue-failure', error); throw error }
  finally { release.resolve(); await boundary('promotion Stop cleanup', f.close()) }
}, 20000)

it('a committed original claim remains consumed after Stop and graceful service reopen', async () => {
  const f = await createDeliveryFixture()
  try {
    await f.start(); f.releaseChild()
    await boundary('original claim committed', f.waitForConsumed()); await f.waitForDeliveryRequest()
    f.service.cancelRunning!('parent')
    await boundary('Stop after original consumption', f.service.awaitDeliveryStop('parent'))
    const before = (await f.backend.read('parent')).events, receipt = before.find(e => e.type === 'agent/delivery-received')!
    if (receipt.type !== 'agent/delivery-received') throw new Error('Original receipt missing')
    await boundary('graceful original service reopen', f.reopen())
    const assembly = await f.service.assemblyFor('parent'), requests = f.parentRequests.length
    await assembly.drainParentNotifications?.(); await assembly.managedDocument?.settleFinishedActions()
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId === receipt.inputId)).toHaveLength(1)
    expect(readDeliveries(assembly.session).receipt(receipt.key)?.disposition).toBe('claimed')
    expect(assembly.inbox.pending()).toEqual([])
    expect(f.parentRequests).toHaveLength(requests); expect(f.launchCount()).toBe(1)
    await f.evidence('committed-claim-Stop-reopen')
  } catch (error) { await f.evidence('committed-claim-Stop-reopen-failure', error); throw error }
  finally { await boundary('committed claim cleanup', f.close()) }
}, 20000)

it('a genuine active human steer preserves the original background generation and later child delivery', async () => {
  const f = await createDeliveryFixture({ holdParentStep: true })
  const running = f.start(); void running.catch(() => {})
  try {
    await f.waitForParentStep()
    const assembly = await f.service.assemblyFor('parent'), generation = readDeliveries(assembly.session).activeGeneration()
    await assembly.inbox.admit({ inputId: 'active-human-steer', text: 'human steering keeps original child', delivery: 'steer', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } })
    f.releaseParentStep(); await running
    expect(readDeliveries(assembly.session).activeGeneration()).toEqual(generation)
    expect(assembly.session.events.filter(e => e.type === 'agent/input/promoted' && e.inputId === 'active-human-steer')).toHaveLength(1)
    expect(f.parentRequests.some(request => JSON.stringify(request.messages).includes('human steering keeps original child'))).toBe(true)
    f.releaseChild(); await f.waitForDeliveryRequest(); await f.waitForConsumed()
    expect(f.launchCount()).toBe(1)
    expect((await f.backend.read('parent')).events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    await f.evidence('active-human-steer-original-generation')
  } catch (error) { await f.evidence('active-human-steer-original-generation-failure', error); throw error }
  finally { f.releaseParentStep(); await running.catch(() => {}); await boundary('human steer cleanup', f.close()) }
}, 20000)

it('failed extension mount preserves its primary error and exact original cleanup debt until explicit retry', async () => {
  const primary = new Error('original extension mount refused'), cleanup = new Error('original terminal disposer refused')
  let original: SessionAssembly | undefined, mounts = 0, terminalAttempts = 0, execAttempts = 0
  const f = await createDeliveryFixture({ expectedWarnings: ['Terminal disposal failed: Error: original terminal disposer refused'], extensionsFor: async () => ({ options: {}, async mount(assembly) {
    mounts++
    if (mounts !== 1) return
    original = assembly
    const terminal = assembly.ctx.services.get<{ dispose(): Promise<void> }>('terminal/service'), exec = assembly.ctx.services.get<{ dispose(): Promise<void> }>('exec/service')
    const closeTerminal = terminal.dispose.bind(terminal), closeExec = exec.dispose.bind(exec)
    terminal.dispose = async () => { if (++terminalAttempts === 1) throw cleanup; await closeTerminal() }
    exec.dispose = async () => { execAttempts++; await closeExec() }
    throw primary
  } }) })
  try {
    const failure = await f.service.assemblyFor('parent').then(() => undefined, error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.cause).toBe(primary)
    expect(failure.errors[0]).toBe(primary)
    expect(failure.errors[1]).toBeInstanceOf(AggregateError)
    expect(failure.errors[1].errors).toContain(cleanup)
    expect(terminalAttempts).toBe(1); expect(execAttempts).toBe(1)
    await expect(f.service.assemblyFor('parent')).rejects.toThrow(/cleanup incomplete/)
    expect(mounts).toBe(1)
    await boundary('original failed mount cleanup retry', f.service.closeSession('parent'))
    expect(terminalAttempts).toBe(2)
    const replacement = await f.service.assemblyFor('parent')
    expect(replacement).not.toBe(original); expect(mounts).toBe(2)
    await original!.drainParentNotifications?.()
    expect(f.parentRequests).toHaveLength(0)
    expect((await f.backend.read('parent')).events.some(e => e.type === 'agent/delivery-received')).toBe(false)
    await f.evidence('failed-extension-original-cleanup')
  } catch (error) { await f.evidence('failed-extension-original-cleanup-failure', error); throw error }
  finally { await boundary('failed mount final cleanup', f.close()) }
}, 20000)

it.each(['individual', 'tree'] as const)('%s cancellation settles the original child truth without a completed delivery or producer replay', async kind => {
  const f = await createDeliveryFixture()
  try {
    await f.start()
    const assembly = await f.service.assemblyFor('parent'), task = assembly.tasks().find(task => task.group === 'subagent')!
    const originalStart = assembly.session.events.find(e => e.type === 'subagent/start')!
    if (originalStart.type !== 'subagent/start') throw new Error('Original child start missing')
    const cancellation = kind === 'tree' ? assembly.tools.execute({ name: 'stop_task', args: { task_id: originalStart.taskId, reason: 'original subtree control' } }) : undefined
    if (kind === 'individual') expect(f.service.cancelTask('parent', task.id)).toBe('cancellation-requested')
    f.releaseChild()
    if (cancellation) expect((await cancellation).output).toMatchObject({ outcome: 'cancellation-requested', cancelled: 1, task_ids: [originalStart.taskId] })
    await boundary('cancelled original terminal', f.waitForTerminalCommitted())
    await assembly.managedDocument?.settleFinishedActions(); await assembly.drainParentNotifications?.()
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'subagent/end')).toEqual([expect.objectContaining({ taskId: originalStart.taskId, outcome: 'cancelled', envelope: expect.objectContaining({ execution: { outcome: 'canceled', dispatch: 'dispatched' } }) })])
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(0)
    expect(f.parentRequests).toHaveLength(2); expect(f.launchCount()).toBe(1)
    expect(f.service.cancelTask('parent', task.id)).toBe('already-finished')
    await f.evidence(kind + '-cancel-original-truth')
  } catch (error) { await f.evidence(kind + '-cancel-original-truth-failure', error); throw error }
  finally { f.releaseChild(); await boundary('cancel final cleanup', f.close()) }
}, 20000)

it('Stop confirms its fence during actual original artifact retention without discarding or replaying that result', async () => {
  const f = await createDeliveryFixture()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let originalFinishes = 0
  try {
    await f.start()
    const begin = f.output.beginResult.bind(f.output)
    f.output.beginResult = async (...args) => {
      const sink = await begin(...args), finish = sink.finish.bind(sink)
      sink.finish = async completeness => {
        entered.resolve(); await release.promise; originalFinishes++
        return finish(completeness)
      }
      return sink
    }
    f.releaseChild(); await boundary('original task artifact finish held', entered.promise)
    expect((await f.backend.read('parent')).events.some(e => e.type === 'subagent/end' || e.type === 'agent/delivery-received')).toBe(false)
    f.service.cancelRunning!('parent')
    expect(await boundary('Stop independent of original retention', f.service.awaitDeliveryStop('parent'))).toMatchObject({ durability: 'durable' })
    expect(originalFinishes).toBe(0)
    release.resolve(); await boundary('same original terminal after retention', f.waitForTerminalCommitted())
    const assembly = await f.service.assemblyFor('parent')
    await assembly.managedDocument?.settleFinishedActions(); await assembly.drainParentNotifications?.()
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'subagent/end')).toEqual([expect.objectContaining({ outcome: 'completed', envelope: expect.objectContaining({ execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: expect.objectContaining({ kind: 'artifact' }) }) })])
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(0)
    expect(originalFinishes).toBe(1); expect(f.launchCount()).toBe(1); expect(f.parentRequests).toHaveLength(2)
    await f.evidence('Stop-during-original-native-retention')
  } catch (error) { await f.evidence('Stop-during-original-native-retention-failure', error); throw error }
  finally { release.resolve(); await boundary('original retained source cleanup', f.close()) }
}, 20000)

it('reconciling a failed original rewind marker never repeats its completed restoration callback', async () => {
  const f = await createDeliveryFixture()
  let allow = false, effects = 0
  let owner: Awaited<ReturnType<typeof f.coordinator.openManagedDocument>> | undefined
  const primary = new Error('Original restoration failed after file effects')
  const keys: string[] = []
  try {
    await f.start()
    owner = await f.coordinator.openManagedDocument('parent')
    const append = vi.mocked(f.backend.appendOwnedBatch!).getMockImplementation()!, reconcile = vi.mocked(f.backend.reconcileOwnedBatch!).getMockImplementation()!
    vi.mocked(f.backend.appendOwnedBatch!).mockImplementation(async (...args) => {
      const outcome = await append(...args)
      if (decodeFactBatch(args[3].bytes).events.some(e => e.type === 'rewind/point')) {
        keys.push(args[3].key.batchId)
        return { kind: 'unknown', key: args[3].key }
      }
      return outcome
    })
    vi.mocked(f.backend.reconcileOwnedBatch!).mockImplementation(async (...args) => {
      if (keys.includes(args[3].key.batchId)) { keys.push(args[3].key.batchId); if (!allow) return { kind: 'unknown', key: args[3].key } }
      return reconcile(...args)
    })
    const failure = await withRewindFacts(owner, async record => {
      effects++
      try { await record({ type: 'rewind/point', version: 1, targetTurn: 0, anchorSeq: 0, mode: 'conversation', fileOps: [] }) }
      catch { throw primary }
    }).then(() => undefined, error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.cause).toBe(primary)
    expect(failure.errors[0]).toBe(primary)
    expect(failure.errors[1]).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(effects).toBe(1)
    allow = true; await owner.settleFinishedActions()
    expect(effects).toBe(1)
    expect(new Set(keys).size).toBe(1)
    expect(owner.view.events.filter(e => e.type === 'rewind/point')).toHaveLength(1)
    await f.evidence('rewind-marker-original-only')
  } catch (error) { await f.evidence('rewind-marker-original-only-failure', error); throw error }
  finally { allow = true; await owner?.settleFinishedActions(); await boundary('marker cleanup', f.close()) }
}, 20000)

it.each(['rerender-first', 'recovery-first', 'Stop-during-rerender'] as const)('original landed receipt interleaving: %s', async order => {
  const f = await createDeliveryFixture({ holdReceiptUnknown: true, holdReceiptReconcile: true, expectStopDiagnostics: true })
  try {
    await boundary('parent start', f.start()); f.releaseChild()
    await boundary('unknown receipt', f.waitForReceiptUnknown())
    await boundary('original reconciliation entered', f.waitForReceiptReconcile())
    const assembly = await f.service.assemblyFor('parent'), adapter = receivedInputsFor(assembly.factOwner, 'parent').delivery
    const source = assembly.session.events.find(e => e.type === 'agent/delivery-source')!, terminal = assembly.session.events.find(e => e.type === 'subagent/end')!
    const rerender = () => adapter.admit({ sourceSeq: source.seq!, terminalSeq: terminal.seq! }, { text: 'interleaved changed presentation', description: 'changed', display: { kind: 'task', title: 'changed', body: 'changed' } })
    let observation: Promise<unknown> | undefined
    if (order !== 'recovery-first') observation = rerender().then(value => ({ value }), error => ({ error }))
    if (order === 'Stop-during-rerender') {
      f.service.cancelRunning!('parent')
      expect(assembly.inbox.pending()).toHaveLength(0)
    }
    f.releaseReceipt(); f.releaseReceiptReconcile()
    if (observation) await boundary('rerender shares original reconciliation', observation)
    if (order === 'Stop-during-rerender') {
      await boundary('same original Stop close', f.service.awaitDeliveryStop('parent'))
      const oldDrain = assembly.drainParentNotifications!
      await boundary('retiring exact old assembly', f.service.closeSession('parent'))
      const replacement = await f.service.assemblyFor('parent')
      expect(replacement).not.toBe(assembly)
      const requests = f.parentRequests.length
      await boundary('old original callback after replacement', oldDrain())
      await replacement.drainParentNotifications?.()
      expect(f.parentRequests).toHaveLength(requests)
      expect(replacement.inbox.pending()).toHaveLength(0)
    } else {
      await boundary('original source drain', assembly.drainParentNotifications!())
      await boundary('parent request', f.waitForDeliveryRequest()); await boundary('claim', f.waitForConsumed())
      expect(await rerender()).toMatchObject({ disposition: 'claimed' })
    }
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))).toHaveLength(order === 'Stop-during-rerender' ? 0 : 1)
    const input = events.find(e => e.type === 'agent/input/admitted' && e.intent === 'system')!
    expect(input.type === 'agent/input/admitted' && input.text).toContain('original child result')
    expect(new Set(f.receiptKeys).size).toBe(1)
    expect(f.launchCount()).toBe(1)
    await f.evidence('receipt-interleaving-' + order)
  } catch (error) { await f.evidence('receipt-interleaving-' + order + '-failure', error); throw error }
  finally { f.releaseReceipt(); f.releaseReceiptReconcile(); await boundary('receipt lifecycle cleanup', f.close()) }
}, 20000)

it('Stop revokes synchronous pending eligibility while its original close is physically held', async () => {
  const f = await createDeliveryFixture({ holdParentStep: true })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    const starting = f.start().then(() => undefined, error => error); await f.waitForParentStep()
    f.releaseChild(); await f.waitForTerminalCommitted()
    const assembly = await f.service.assemblyFor('parent')
    // Real source drain commits the admission while the actual parent step is held.
    await assembly.drainParentNotifications?.()
    expect(assembly.inbox.pending()).toHaveLength(1)
    const append = vi.mocked(f.backend.appendOwnedBatch!).getMockImplementation()!
    vi.mocked(f.backend.appendOwnedBatch!).mockImplementation(async (...args) => {
      if (decodeFactBatch(args[3].bytes).events.some(e => e.type === 'agent/delivery-generation' && e.op === 'close')) { entered.resolve(); await release.promise }
      return append(...args)
    })
    f.service.cancelRunning!('parent')
    expect(assembly.inbox.pending()).toHaveLength(0)
    const stopped = f.service.awaitDeliveryStop('parent')
    let acknowledged = false; void stopped.then(() => { acknowledged = true })
    await boundary('Stop close entered', entered.promise)
    expect(acknowledged).toBe(false)
    release.resolve(); expect(await stopped).toMatchObject({ durability: 'durable' })
    f.releaseParentStep(); expect(await starting).toMatchObject({ name: 'AbortError' })
    expect((await f.backend.read('parent')).events.filter(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))).toHaveLength(0)
    expect(receivedInputsFor(assembly.factOwner, 'parent').inbox.pending()).toHaveLength(0)
    await f.evidence('stop-held-close-live-revocation')
  } catch (error) { await f.evidence('stop-held-close-live-revocation-failure', error); throw error }
  finally { release.resolve(); f.releaseParentStep(); await boundary('Stop cleanup', f.close()) }
}, 20000)

it('a failed rewind close has no effects and explicit reconciliation retries its exact original capture', async () => {
  const f = await createDeliveryFixture({ expectStopDiagnostics: true })
  let allow = false, effects = 0
  const keys: string[] = []
  try {
    await f.start()
    const owner = await f.coordinator.openManagedDocument('parent'), adapter = receivedInputsFor(owner, 'parent').delivery
    const append = vi.mocked(f.backend.appendOwnedBatch!).getMockImplementation()!, reconcile = vi.mocked(f.backend.reconcileOwnedBatch!).getMockImplementation()!
    let originalFence: string | undefined
    vi.mocked(f.backend.appendOwnedBatch!).mockImplementation(async (...args) => {
      const close = decodeFactBatch(args[3].bytes).events.find(e => e.type === 'agent/delivery-generation' && e.op === 'close')
      const outcome = await append(...args)
      if (close?.type === 'agent/delivery-generation' && close.op === 'close' && !allow) {
        originalFence = close.fenceId; keys.push(args[3].key.batchId)
        return { kind: 'unknown', key: args[3].key }
      }
      return outcome
    })
    vi.mocked(f.backend.reconcileOwnedBatch!).mockImplementation(async (...args) => {
      if (keys.includes(args[3].key.batchId)) {
        keys.push(args[3].key.batchId)
        if (!allow) return { kind: 'unknown', key: args[3].key }
      }
      return reconcile(...args)
    })
    await expect(withRewindFacts(owner, async () => { effects++ })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(effects).toBe(0)
    expect(originalFence).toBeDefined()
    allow = true
    expect(await adapter.closeReceipt(originalFence!)).toMatchObject({ fenceId: originalFence, durability: 'durable' })
    expect(new Set(keys).size).toBe(1)
    await withRewindFacts(owner, async record => {
      effects++
      await record({ type: 'rewind/point', version: 1, targetTurn: 0, anchorSeq: 0, mode: 'conversation', fileOps: [] })
    })
    await owner.settleFinishedActions()
    expect(effects).toBe(1)
    expect(owner.view.events.filter(e => e.type === 'rewind/point')).toHaveLength(1)
    await f.evidence('rewind-original-close-explicit-retry')
  } catch (error) { await f.evidence('rewind-original-close-explicit-retry-failure', error); throw error }
  finally { allow = true; await boundary('unknown rewind cleanup', f.close()) }
}, 20000)
