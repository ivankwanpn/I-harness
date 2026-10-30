import { expect, it, vi } from 'vitest'
import { backgroundEventForTool } from '@i-harness/core-tools'
import { createDeliveryFixture } from './helpers/delivery-fixture.ts'

it('genuine B completion yields held foreground A and promotes the original receipt', async () => {
  const f = await createDeliveryFixture({ activeForeground: true })
  const starting = f.start(); void starting.catch(() => {})
  try {
    await Promise.race([f.waitForForeground(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('foreground not started: ' + JSON.stringify(f.parentRequests.length) + ' launches ' + f.launchCount())), 4000))]); expect(f.launchCount()).toBe(2)
    f.releaseChild(); await Promise.race([f.waitForConsumed(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('receipt not consumed: ' + JSON.stringify(f.parentRequests.length) + ' launches ' + f.launchCount())), 4000))]); await starting
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))).toHaveLength(1)
    expect(f.launchCount()).toBe(2)
    const result = events.find(e => e.type === 'tool/result' && e.callId === 'foreground-a')
    expect(result).toMatchObject({ envelope: { retention: { kind: 'inline', value: { task_id: 'task-2', yielded: true, yield_reason: 'background-event' } } } })
    expect(JSON.stringify(result)).not.toContain('original child result')
  } catch (error) { console.info('active-wait-state', backgroundEventForTool({ session: (await f.service.assemblyFor('parent')).session })?.pending()); console.info('active-wait-failure', error, JSON.stringify((await f.backend.read('parent')).events.filter(e => ['subagent/start','subagent/end','agent/delivery-source','agent/delivery-received','agent/input/admitted','tool/result'].includes(e.type)))); throw error } finally { f.releaseChild(); f.releaseForeground(); await starting.catch(() => {}); await vi.waitFor(async () => { const doc = await f.coordinator.getDocument('task-parent') as { notifications: { submissionId: string; status: string }[] }; expect(doc.notifications.find(n => n.submissionId === 'task-2')?.status).toBe('delivered') }, { timeout: 5000 }); await f.close() }
}, 15000)
