// Real native B2 birth setup has a separate resource envelope; this is not a latency qualification.
const NATIVE_B2_CASE_MS = 60_000
import { expect, it, vi } from 'vitest'
import { createDeliveryFixture } from './helpers/delivery-fixture.ts'
import { RecipientDeliveryRecoveryError } from '../src/lifecycle/recipient-delivery.ts'
import { createOwnedDocumentWrite } from '../../session-persistence-jsonl/src/backend/document-write.ts'

it('retries original transient receiver capture for a retained failed child without another input or terminal event', async () => {
  const warnings = ['original delivery settlement', 'delivery reconciliation failed'].map(prefix => `[i-harness] ${prefix}: FactRecoveryRequiredError: Managed facts require reconciliation`)
  const f = await createDeliveryFixture({ failChild: true, expectedWarnings: warnings })
  let refused = 0
  const document = await f.coordinator.openManagedDocument('parent')
  const register = document.registerReceivedInputSource.bind(document)
  document.registerReceivedInputSource = (...args) => {
    const source = register(...args), capture = source.captureDeliveryAdmission.bind(source)
    source.captureDeliveryAdmission = (...input) => {
      if (++refused <= 3) throw new RecipientDeliveryRecoveryError({ kind: 'retryable', phase: 'temporary-admission' })
      return capture(...input)
    }
    return source
  }
  try {
    await f.start(); f.releaseChild()
    // Three injected refusals persist their real FIFO states before the fourth
    // delivery. This is a functional recovery envelope, not a latency assertion.
    await f.waitForDeliveryRequest(15_000); await f.waitForConsumed()
    const events = (await f.backend.read('parent')).events
    const terminal = events.filter(e => e.type === 'subagent/end')
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ outcome: 'error', resultRevision: expect.any(String), envelope: { execution: { dispatch: 'dispatched', outcome: 'failed' } } })
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/admitted' && e.intent === 'user')).toHaveLength(1)
    expect(f.parentRequests).toHaveLength(3); expect(f.launchCount()).toBe(1)
    expect(refused).toBe(4)
    const end = events.find(e => e.type === 'subagent/end')!, receipt = events.find(e => e.type === 'agent/delivery-received')!, source = events.find(e => e.type === 'agent/delivery-source')!
    if (end.type !== 'subagent/end' || receipt.type !== 'agent/delivery-received' || source.type !== 'agent/delivery-source') throw new Error('Original route evidence absent')
    expect(receipt.key.resultRevision).toBe(end.resultRevision)
    expect(receipt.terminalSeq).toBe(end.seq); expect(receipt.sourceSeq).toBe(source.seq)
    expect(receipt.key.sourceId).toBe(end.taskId)
    const tasks = await f.coordinator.getDocument('task-parent') as { tasks: { outcome: string; result: { revision: string } }[]; notifications: { status: string; attempts: number }[] }
    expect(tasks.tasks).toEqual([expect.objectContaining({ outcome: 'error', result: expect.objectContaining({ revision: end.resultRevision }) })])
    expect(tasks.notifications).toEqual([expect.objectContaining({ status: 'delivered', attempts: 4 })])
    console.info('ordinary-retry-original-route', JSON.stringify({ launches: f.launchCount(), parentRequests: f.parentRequests.length, refusals: refused - 1, sourceSeq: source.seq, terminalSeq: end.seq, resultRevision: end.resultRevision, receipt: receipt.key, inputId: receipt.inputId }))
  } catch (error) { console.info('receiver-red-state', JSON.stringify({ refused, events: (await f.backend.read('parent')).events.filter(e => ['subagent/end', 'agent/delivery-received'].includes(e.type)), requests: f.parentRequests.length })); throw error } finally { await f.close() }
}, NATIVE_B2_CASE_MS)



it.each([undefined, false])('committed receiver input wakes once despite falsey source acknowledgement save failure (%j)', async failure => {
  const warnings = ['original delivery settlement', 'delivery reconciliation failed'].map(prefix => `[i-harness] ${prefix}: ${String(failure)}`)
  const f = await createDeliveryFixture({ expectedWarnings: warnings })
  let failures = 0
  const create = vi.mocked(createOwnedDocumentWrite).getMockImplementation()!
  vi.mocked(createOwnedDocumentWrite).mockImplementation(input => {
    const original = create(input), write = original.handle, data = JSON.parse(Buffer.from(input.bytes).toString('utf8')) as { notifications?: { status: string }[] }
    return { ...original, handle: { retry: write.retry.bind(write), reconcile: write.reconcile.bind(write), outcome: write.outcome.bind(write), async issue() {
      const outcome = await write.issue()
      if (input.path.startsWith(f.root) && input.path.endsWith('task-parent.doc.jsonl') && !failures && data.notifications?.some(row => row.status === 'delivered')) { failures++; throw failure }
      return outcome
    } } }
  })
  try {
    await f.start(); f.releaseChild(); await f.waitForDeliveryRequest(); await f.waitForConsumed()
    const events = (await f.backend.read('parent')).events
    expect(failures).toBe(1); expect(f.launchCount()).toBe(1); expect(f.parentRequests).toHaveLength(3)
    expect(events.filter(e => e.type === 'subagent/end')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))).toHaveLength(1)
  } finally { await f.close() }
}, NATIVE_B2_CASE_MS)
