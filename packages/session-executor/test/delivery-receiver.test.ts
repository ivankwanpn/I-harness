// Real native B2 birth setup has a separate resource envelope; this is not a latency qualification.
const NATIVE_B2_CASE_MS = 60_000
import { expect, it } from 'vitest'
import { createDeliveryFixture } from './helpers/delivery-fixture.ts'
import { receivedInputsFor } from '../src/lifecycle/received-inputs.ts'
import { DeliverySourcesError, OriginalTerminalRecoveryError } from '../../subagent/src/task-notification.ts'

it('keeps an old eligible child across an ordinary followup and delivers its receipt once', async () => {
  const f = await createDeliveryFixture()
  try {
    await f.start()
    await f.service.submit('parent', 'new human followup', new AbortController().signal)
    f.releaseChild()
    await f.waitForDeliveryRequest()
    const events = (await f.backend.read('parent')).events
    await f.evidence('ordinary-followup')
    const receipts = events.filter(e => e.type === 'agent/delivery-received')
    expect(receipts).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId === receipts[0]!.inputId)).toHaveLength(1)
    expect(f.launchCount()).toBe(1)
    expect(JSON.stringify(f.parentRequests.at(-1)!.messages)).toContain('original child result')
  } catch (e) { await f.evidence('ordinary-followup-failure', e); throw e }
  finally { await f.close() }
}, NATIVE_B2_CASE_MS)

it('does not admit retained child bytes before the original terminal commits', async () => {
  const f = await createDeliveryFixture({ holdTerminal: true })
  try {
    await f.start(); f.releaseChild(); await f.waitForHeldTerminal()
    const events = (await f.backend.read('parent')).events
    await f.evidence('held-original-terminal')
    expect(events.filter(e => e.type === 'subagent/end')).toHaveLength(0)
    expect(events.filter(e => e.type === 'agent/input/admitted' && e.intent === 'system')).toHaveLength(0)
    f.releaseTerminal(); await f.waitForDeliveryRequest()
    expect(f.launchCount()).toBe(1)
  } catch (e) { await f.evidence('held-original-terminal-failure', e); throw e }
  finally { await f.close() }
}, NATIVE_B2_CASE_MS)

it('idle Stop followed by a new human input cannot revive the older child', async () => {
  const f = await createDeliveryFixture()
  try {
    await f.start(); f.service.cancelRunning!('parent')
    const close = await f.service.awaitDeliveryStop('parent')
    expect(close).toMatchObject({ durability: 'durable' })
    await f.service.submit('parent', 'new human after Stop', new AbortController().signal)
    f.releaseChild(); await f.waitForTerminalCommitted()
    // Joining actual child/source persistence establishes a causal completed
    // source boundary; no arbitrary delay is used as a zero-wake oracle.
    const assembly = await f.service.assemblyFor('parent')
    await assembly.managedDocument?.settleFinishedActions()
    await assembly.drainParentNotifications?.()
    await f.evidence('stop-new-human')
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'agent/input/admitted' && e.intent === 'system')).toHaveLength(0)
    expect(f.launchCount()).toBe(1)
  } catch (e) { await f.evidence('stop-new-human-failure', e); throw e }
  finally { await f.close() }
}, NATIVE_B2_CASE_MS)

it('two genuine sources with equal presentation have distinct receipts and same-source rerender keeps original input', async () => {
  const f = await createDeliveryFixture({ spawnCount: 2 })
  try {
    await f.start()
    const assembly = await f.service.assemblyFor('parent'), adapter = receivedInputsFor(assembly.factOwner, 'parent').delivery
    const admit = adapter.admit.bind(adapter)
    // Targeted presentation control: actual receiver/source/lane remain real.
    // The independent default rendering control above uses the source text.
    adapter.admit = evidence => admit(evidence, { text: 'equal supplied presentation', description: 'equal', display: { kind: 'task', title: 'equal', body: 'equal' } })
    f.releaseChild(); await f.waitForConsumed()
    const events = (await f.backend.read('parent')).events
    const receipts = events.filter(e => e.type === 'agent/delivery-received')
    expect(receipts).toHaveLength(2)
    expect(new Set(receipts.map(e => e.inputId)).size).toBe(2)
    const inputs = events.filter(e => e.type === 'agent/input/admitted').filter(e => e.intent === 'system')
    expect(inputs.map(e => e.text)).toEqual(['equal supplied presentation', 'equal supplied presentation'])
    for (const receipt of receipts) {
      expect(await admit({ sourceSeq: receipt.sourceSeq, terminalSeq: receipt.terminalSeq }, { text: 'changed rerender', description: 'changed', display: { kind: 'task', title: 'changed', body: 'changed' } })).toMatchObject({ inputId: receipt.inputId, disposition: 'claimed' })
      expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId === receipt.inputId)).toHaveLength(1)
    }
    expect(f.launchCount()).toBe(2)
    expect((await f.backend.read('parent')).events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(2)
    await f.evidence('equal-presentation-stable-key')
  } catch (e) { await f.evidence('equal-presentation-failure', e); throw e }
  finally { await f.close() }
}, NATIVE_B2_CASE_MS)

it('reconciles a physically landed receipt on its original handle before one parent request', async () => {
  const f = await createDeliveryFixture({ holdReceiptUnknown: true })
  const boundary = async <T>(name: string, work: Promise<T>, resourceMs = 3000) => {
    let timer: ReturnType<typeof setTimeout>
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Original receipt boundary pending: ' + name)), resourceMs) })]) }
    catch (error) { await f.evidence('receipt-boundary-' + name, error); throw error }
    finally { clearTimeout(timer!) }
  }
  try {
    // Native B2 birth setup has its own functional envelope; receipt boundaries stay three seconds.
    await boundary('native-child-startup', f.start(), 20_000); f.releaseChild(); await boundary('physical-unknown', f.waitForReceiptUnknown())
    expect(f.parentRequests).toHaveLength(2)
    expect(f.receiptKeys.length).toBeGreaterThan(0)
    const assembly = await f.service.assemblyFor('parent')
    const source = assembly.session.events.find(e => e.type === 'agent/delivery-source')!
    const terminal = assembly.session.events.find(e => e.type === 'subagent/end')!
    await expect(boundary('original-rerender-observation', receivedInputsFor(assembly.factOwner, 'parent').delivery.admit({ sourceSeq: source.seq!, terminalSeq: terminal.seq! }, { text: 'changed uncertain presentation', description: 'changed', display: { kind: 'task', title: 'changed', body: 'changed' } }))).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    f.releaseReceipt(); await boundary('actual-parent-request', f.waitForDeliveryRequest()); await boundary('actual-claim', f.waitForConsumed())
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))).toHaveLength(1)
    expect(new Set(f.receiptKeys).size).toBe(1)
    const originalInput = events.filter(e => e.type === 'agent/input/admitted').find(e => e.intent === 'system')!
    expect(originalInput.text).toContain('original child result')
    expect(originalInput.text).not.toContain('changed uncertain presentation')
    expect(f.launchCount()).toBe(1)
    await f.evidence('original-receipt-unknown')
  } catch (e) { await f.evidence('original-receipt-unknown-failure', e); throw e }
  finally { f.releaseReceipt(); await boundary('original-cleanup', f.close()) }
}, NATIVE_B2_CASE_MS)

it.each(['synthetic', 'unknown', 'delegated', 'b2'] as const)('a %s parent keeps accepted unbound spawn and original result read without retrospective delivery authority', async compatibilityOrigin => {
  const f = await createDeliveryFixture({ compatibilityOrigin })
  try {
    await f.start(); f.releaseChild(); await f.waitForTerminalCommitted()
    const assembly = await f.service.assemblyFor('parent')
    await assembly.drainParentNotifications?.()
    let events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'agent/delivery-generation' || e.type === 'agent/delivery-source' || e.type === 'agent/delivery-received')).toHaveLength(0)
    expect(events.filter(e => e.type === 'subagent/end' && e.outcome === 'completed')).toHaveLength(1)
    await f.service.submit('parent', 'read original retained result', new AbortController().signal)
    events = (await f.backend.read('parent')).events
    expect(events.some(e => e.type === 'tool/result' && e.name === 'get_task_output' && JSON.stringify(e.envelope).includes('original child result'))).toBe(true)
    expect(events.filter(e => e.type === 'agent/delivery-source' || e.type === 'agent/delivery-received')).toHaveLength(0)
    expect(f.launchCount()).toBe(1)
    await f.evidence(compatibilityOrigin + '-unavailable-readable')
  } catch (e) { await f.evidence(compatibilityOrigin + '-unavailable-failure', e); throw e }
  finally { await f.close() }
}, NATIVE_B2_CASE_MS)

it('Stop during actual receiver preparation retires only its never-issued admission and confirms the original close', async () => {
  const f = await createDeliveryFixture({ holdReceiptBeforeIssue: true })
  try {
    await f.start(); f.releaseChild(); await f.waitForReceiptPrepared()
    f.service.cancelRunning!('parent')
    f.releaseReceiptPreparation()
    const receipt = await f.service.awaitDeliveryStop('parent')
    expect(receipt).toMatchObject({ durability: 'durable' })
    await f.service.submit('parent', 'fresh human after prepared Stop', new AbortController().signal)
    const assembly = await f.service.assemblyFor('parent')
    await assembly.drainParentNotifications?.()
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(0)
    expect(events.filter(e => e.type === 'agent/input/admitted' && e.intent === 'system')).toHaveLength(0)
    expect(events.filter(e => e.type === 'subagent/end' && e.outcome === 'completed')).toHaveLength(1)
    expect(f.launchCount()).toBe(1)
    await f.evidence('stop-before-receipt-issue')
  } catch (e) { await f.evidence('stop-before-receipt-issue-failure', e); throw e }
  finally { await f.close() }
}, NATIVE_B2_CASE_MS)

it('a normal active step claims the receipt before its queued idle hint without a second delivery action', async () => {
  const f = await createDeliveryFixture({ holdParentStep: true })
  const running = f.start(); void running.catch(() => {})
  try {
    await f.waitForParentStep()
    f.releaseChild(); await f.waitForReceiptPrepared()
    // The source drain waits for actual admission; its hint uses the existing
    // service chain while the original model step remains held.
    const assembly = await f.service.assemblyFor('parent')
    await assembly.drainParentNotifications?.()
    expect(f.parentRequests).toHaveLength(2)
    f.releaseParentStep(); await running
    await f.waitForDeliveryRequest(); await f.waitForConsumed()
    const events = (await f.backend.read('parent')).events
    const receipt = events.find(e => e.type === 'agent/delivery-received')!
    expect(receipt.type).toBe('agent/delivery-received')
    if (receipt.type !== 'agent/delivery-received') throw new Error('Missing actual receipt')
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId === receipt.inputId)).toHaveLength(1)
    expect(events.filter(e => e.type === 'context/action' && e.op === 'open' && e.origin.kind === 'observation-input' && e.origin.inputId === receipt.inputId)).toHaveLength(0)
    await f.service.submit('parent', 'later normal human', new AbortController().signal)
    expect(f.executionErrors()).toEqual([])
    expect(f.launchCount()).toBe(1)
    await f.evidence('active-claim-before-idle-hint')
  } catch (e) { await f.evidence('active-claim-before-idle-hint-failure', e); throw e }
  finally { f.releaseParentStep(); await running.catch(() => {}); await f.close() }
}, NATIVE_B2_CASE_MS)

it('an issued-unknown trusted generation open retains its original debt and prevents child launch', async () => {
  const f = await createDeliveryFixture({ holdOpenUnknown: true })
  const running = f.start(); void running.catch(() => {})
  try {
    await f.waitForOpenUnknown()
    await expect(running).rejects.toBeTruthy()
    expect(f.launchCount()).toBe(0)
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'agent/delivery-generation' && e.op === 'open')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/delivery-source' || e.type === 'agent/delivery-received')).toHaveLength(0)
    const assembly = await f.service.assemblyFor('parent')
    // The same failed tool source must keep its instruction pin until its
    // original open capture reconciles. No manager may force-release that pin.
    await expect(assembly.dispose()).rejects.toMatchObject({message:'Assembly original source cleanup incomplete'})
    f.releaseOpen()
    await receivedInputsFor(assembly.factOwner, 'parent').delivery.settle()
    await assembly.dispose()
    const trace=f.originalOpenTrace();expect(trace.filter(entry=>entry.phase==='append')).toHaveLength(1);expect(trace.some(entry=>entry.phase==='reconcile')).toBe(true);expect(new Set(trace.map(entry=>entry.batchId)).size).toBe(1)
    expect(f.launchCount()).toBe(0)
    await f.evidence('trusted-open-unknown-no-launch')
  } catch (e) { await f.evidence('trusted-open-unknown-failure', e); throw e }
  finally { f.releaseOpen(); await running.catch(() => {}); await f.close();expect(f.warningMessages()).toEqual([]) }
}, NATIVE_B2_CASE_MS)

it('a lost original terminal acknowledgment activates same-capture recovery without a read or source close', async () => {
  const f = await createDeliveryFixture({ holdTerminalUnknown: true })
  try {
    await f.start(); f.releaseChild()
    await f.waitForTerminalReconcile()
    expect(f.parentRequests).toHaveLength(2)
    f.releaseTerminalOutcome()
    await f.waitForDeliveryRequest(); await f.waitForConsumed()
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'subagent/end')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))).toHaveLength(1)
    expect(new Set(f.terminalKeys).size).toBe(1)
    expect(f.launchCount()).toBe(1)
    await f.evidence('original-terminal-unknown-recovery')
  } catch (e) { await f.evidence('original-terminal-unknown-failure', e); throw e }
  finally { f.releaseTerminalOutcome(); await f.close() }
}, NATIVE_B2_CASE_MS)

it('original unknown terminal recovery continues after Stop while the generation forbids admission and wake', async () => {
  const f = await createDeliveryFixture({ holdTerminalUnknown: true, expectStopDiagnostics: true })
  try {
    await f.start(); f.releaseChild(); await f.waitForTerminalReconcile()
    f.service.cancelRunning!('parent')
    f.releaseTerminalOutcome()
    const first = await f.service.awaitDeliveryStop('parent').then(receipt => ({ receipt }), error => ({ error }))
    if ('error' in first) {
      // An already running source-only attempt may have observed unknown
      // before the backend gate opened. Its rejection is truthful; the next
      // explicit call reconciles the same original source/close, not a new Stop.
      expect(first.error).toBeInstanceOf(DeliverySourcesError)
      expect(first.error.errors).toHaveLength(1)
      expect(first.error.errors[0]).toBeInstanceOf(OriginalTerminalRecoveryError)
      expect(first.error.errors[0].outcome).toMatchObject({ kind: 'unknown', key: { batchId: f.terminalKeys[0] } })
      await f.evidence('stop-original-known-unknown-ack', first.error)
      expect(await f.service.awaitDeliveryStop('parent')).toMatchObject({ durability: 'durable' })
    } else expect(first.receipt).toMatchObject({ durability: 'durable' })
    await f.service.submit('parent', 'fresh human after source recovery Stop', new AbortController().signal)
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'subagent/end')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(0)
    expect(events.filter(e => e.type === 'agent/input/admitted' && e.intent === 'system')).toHaveLength(0)
    expect(new Set(f.terminalKeys).size).toBe(1)
    expect(f.launchCount()).toBe(1)
    await f.evidence('original-terminal-recovery-after-stop')
    const taskDocument = await f.coordinator.getDocument('task-parent') as import('@i-harness/subagent').TaskProtocolDocument
    expect(taskDocument.formatVersion).toBe(3)
    const originalTask=taskDocument.tasks[0]!,birth=originalTask.childBirth!,source=events.find(event=>event.type==='agent/delivery-source')!
    expect(birth).toMatchObject({version:1,kind:'task-child-birth',request:{core:{caller:{kind:'task',taskId:originalTask.id,parentSessionId:'parent',toolCallId:'original-spawn-0',callEventSeq:source.callSeq}}}})
    expect(originalTask.childSessionId).toBe(birth.request.invocation.targetSessionId)
    const child=await f.backend.read(birth.request.invocation.targetSessionId)
    expect(child.meta).toBeDefined()
    expect(child.meta!.semanticSeed).toMatchObject({operationId:birth.request.invocation.operationId})
    expect(taskDocument.notifications[0]).toMatchObject({ status: 'suppressed' })
    expect(taskDocument.notifications[0]!.timeDelivered).toBeUndefined()
    expect(taskDocument.notifications[0]!.timeWoken).toBeUndefined()
    for (const task of taskDocument.tasks) for (const field of ['generationId', 'sourceSeq', 'terminalSeq', 'receiverClaim']) expect(task).not.toHaveProperty(field)
  } catch (e) { await f.evidence('original-terminal-recovery-after-stop-failure', e); throw e }
  finally { f.releaseTerminalOutcome(); await f.close() }
}, NATIVE_B2_CASE_MS)

it('Stop source-only settlement stays independent of a held admission after original unknown-end recovery', async () => {
  const f = await createDeliveryFixture({ holdTerminalUnknown: true, holdReceiptBeforeIssue: true, expectStopDiagnostics: true })
  try {
    await f.start(); f.releaseChild(); await f.waitForTerminalReconcile()
    f.releaseTerminalOutcome(); await f.waitForReceiptPrepared()
    const assembly = await f.service.assemblyFor('parent')
    f.service.cancelRunning!('parent')
    const stopped = f.service.awaitDeliveryStop('parent'); void stopped.catch(() => {})
    expect(assembly.settleParentDeliverySources).toBeTypeOf('function')
    await assembly.settleParentDeliverySources!()
    expect(f.parentRequests).toHaveLength(2)
    expect(assembly.session.events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(0)
    f.releaseReceiptPreparation()
    expect(await stopped).toMatchObject({ durability: 'durable' })
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(0)
    expect(events.filter(e => e.type === 'subagent/end')).toHaveLength(1)
    expect(f.launchCount()).toBe(1)
    await f.evidence('source-only-stop-held-admission')
  } catch (e) { await f.evidence('source-only-stop-held-admission-failure', e); throw e }
  finally { f.releaseReceiptPreparation(); f.releaseTerminalOutcome(); await f.close() }
}, NATIVE_B2_CASE_MS)

it('a pending original receipt is scheduled after its first pre-claim prerequisite failure settles and a real owner signal arrives', async () => {
  const f = await createDeliveryFixture()
  let blocked = true, resourceCloses = 0, registeredOrder: number | undefined
  const resourceFault = new Error('original finished source resource release blocked')
  let source: import('@i-harness/core-session').SettlementFacts<import('@i-harness/core-session').ProducerFactOutcome> | undefined
  let off: (() => void) | undefined
  try {
    await f.start()
    const assembly = await f.service.assemblyFor('parent'), action = assembly.factOwner.beginAction()
    source = action.registerSettlementSource(async () => {
      resourceCloses++
      const receipt = assembly.session.events.find(e => e.type === 'agent/delivery-received')
      if (receipt?.type === 'agent/delivery-received' && registeredOrder === undefined) registeredOrder = f.service.queue('parent').find(row => row.id === receipt.inputId)?.order
      if (blocked) throw resourceFault
    })
    action.finish()
    const originalCloseFailure = await source.close().then(() => { throw new Error('Original held source unexpectedly closed') }, error => error)
    expect(originalCloseFailure).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', errors: [resourceFault] })
    const removed = Promise.withResolvers<void>()
    off = f.service.onExecutionState!(state => {
      if (state.sessionId !== 'parent' || !f.executionErrors().length || registeredOrder === undefined) return
      const receipt = assembly.session.events.find(e => e.type === 'agent/delivery-received')
      if (receipt?.type === 'agent/delivery-received' && f.service.queue('parent').find(row => row.id === receipt.inputId)?.order !== registeredOrder) removed.resolve()
    })
    f.releaseChild()
    await Promise.race([removed.promise, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Registered pre-claim failure did not remove its service row')), 5000); void removed.promise.finally(() => clearTimeout(timer)) })])
    const before = (await f.backend.read('parent')).events
    const receipt = before.find(e => e.type === 'agent/delivery-received')!
    if (receipt.type !== 'agent/delivery-received') throw new Error('Missing original receipt')
    expect(f.launchCount()).toBe(1)
    expect(f.parentRequests).toHaveLength(2)
    expect(f.executionErrors()).toHaveLength(1)
    expect(assembly.inbox.isPending(receipt.inputId)).toBe(true)
    expect(before.filter(e => e.type === 'agent/input/promoted' && e.inputId === receipt.inputId)).toHaveLength(0)
    expect(Number.isInteger(registeredOrder)).toBe(true)
    expect(f.service.queue('parent').find(row => row.id === receipt.inputId)?.order).not.toBe(registeredOrder)
    await f.evidence('preclaim-failure-original-pending', { kind: 'controlled-original-source-prerequisite', originalCloseFailure, resourceCloses, resourceReleased: false, registeredOrder, pendingProjectionOrder: f.service.queue('parent').find(row => row.id === receipt.inputId)?.order })
    blocked = false; await source.close()
    // A real same-owner received-input cancellation dirties the receiver. It
    // neither supplies another child/end nor submits model work of its own.
    await assembly.inbox.admit({ inputId: 'original-recovery-signal', text: 'cancelled control input', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture.recovery' } })
    await assembly.inbox.cancel('original-recovery-signal', 'original prerequisite recovered')
    await f.waitForDeliveryRequest(); await f.waitForConsumed()
    const after = (await f.backend.read('parent')).events
    expect(after.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    expect(after.filter(e => e.type === 'agent/input/promoted' && e.inputId === receipt.inputId)).toHaveLength(1)
    expect(f.parentRequests).toHaveLength(3)
    expect(f.launchCount()).toBe(1)
    expect(resourceCloses).toBe(3)
    await f.evidence('preclaim-original-recovered-on-real-signal', { kind: 'controlled-original-source-prerequisite', originalCloseFailure, resourceCloses, resourceReleased: true })
  } catch (e) { await f.evidence('preclaim-original-recovery-failure', e); throw e }
  finally { off?.(); blocked = false; await source?.close(); await f.close() }
}, NATIVE_B2_CASE_MS)

it('a claimed delivery whose actual model request fails is never resubmitted by a later owner signal', async () => {
  const f = await createDeliveryFixture({ failDelivery: true })
  let off: (() => void) | undefined
  try {
    await f.start()
    const failed = Promise.withResolvers<void>()
    off = f.service.onExecutionState!(state => {
      if (state.sessionId === 'parent' && !state.running && state.queued === 0 && f.executionErrors().length === 1) failed.resolve()
    })
    f.releaseChild(); await f.waitForDeliveryRequest(); await f.waitForConsumed()
    await Promise.race([failed.promise, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Original failed model submission did not settle')), 5000); void failed.promise.finally(() => clearTimeout(timer)) })])
    const assembly = await f.service.assemblyFor('parent')
    await assembly.inbox.admit({ inputId: 'after-failed-model-signal', text: 'cancelled control input', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture.recovery' } })
    await assembly.inbox.cancel('after-failed-model-signal', 'real state signal after failed model')
    await assembly.drainParentNotifications?.(true)
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))).toHaveLength(1)
    expect(f.parentRequests).toHaveLength(3)
    expect(f.executionErrors()).toHaveLength(1)
    expect(f.launchCount()).toBe(1)
    await f.evidence('claimed-failed-model-no-resubmit')
  } catch (e) { await f.evidence('claimed-failed-model-no-resubmit-failure', e); throw e }
  finally { off?.(); await f.close() }
  expect(f.parentRequests).toHaveLength(3)
}, NATIVE_B2_CASE_MS)
