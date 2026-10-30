import { randomUUID } from 'node:crypto'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { observeColdExecutionWrites } from '@i-harness/session-persistence/internal/retained-inspection'
import type { SessionService, SessionAssembly } from '@i-harness/session-executor'
import type { createProjectScopeBroker } from './project-scope.ts'
import type { createDesktopExecution } from './execution.ts'

type Notice = { kind: 'invalidate' | 'retired'; epoch: string; revision: number }
/** Private host owner. No timer, writable acquisition, or renderer authority. */
export function createExecutionHostObservation(coordinator: SessionCoordinator, projects: Pick<ReturnType<typeof createProjectScopeBroker>, 'observeExecutionBinding'>, service: Pick<SessionService, 'liveAssembly' | 'onExecutionSurfaceLifecycle'>, execution: ReturnType<typeof createDesktopExecution>) {
  let closing = false, charged = 0
  const leases = new Set<{ close(): Promise<void> }>()
  return {
    async subscribe(sessionId: string, sink: (notice: Notice) => void) {
      if (closing || charged >= 32 || !coordinator.retainExistingSessionBindingObservation) throw Error('Execution observation unavailable')
      charged++
      const epoch = randomUUID(); let revision = 0, active = true, source: SessionAssembly | undefined, sourceOff: (() => void) | undefined
      let reference: Awaited<ReturnType<NonNullable<SessionCoordinator['retainExistingSessionBindingObservation']>>> | undefined
      let broker: ReturnType<typeof projects.observeExecutionBinding> | undefined
      let flight: Promise<unknown> | undefined, releaseFlight: Promise<void> | undefined, released = false
      let offLifecycle: (() => void) | undefined, offCold: (() => void) | undefined
      let initialized = false, noticePending = false
      const notify = (kind: Notice['kind']) => { try { sink({ kind, epoch, revision }) } catch { active = false; queueMicrotask(() => { void lease.close().catch(() => {}) }) } }
      const dirty = () => { if (!active) return; if (revision === Number.MAX_SAFE_INTEGER) { active = false; notify('retired'); queueMicrotask(() => { void lease.close().catch(() => {}) }); return }; revision++; if (!noticePending) { noticePending = true; queueMicrotask(() => { noticePending = false; if (active) notify('invalidate') }) } }
      const attach = (next: SessionAssembly | undefined) => { if (source === next) return; if (initialized) { active = false; notify('retired'); queueMicrotask(() => { void lease.close().catch(() => {}) }); return }; sourceOff?.(); source = next; sourceOff = next?.onExecutionSurfaceChanged?.(dirty) }
      const detach = () => { offLifecycle?.(); offLifecycle = undefined; offCold?.(); offCold = undefined; sourceOff?.(); sourceOff = undefined; broker?.release() }
      const retire = (operation: Parameters<NonNullable<typeof reference>['release']>[0]) => { if (active) { active = false; notify('retired') }; detach(); return reference?.release(operation) }
      const lease = {
        epoch,
        async snapshot(options: { offset?: number; limit?: number } = {}) {
          if (!active || !reference || !broker) throw Error('Execution observation retired')
          if (flight) return { kind: 'reset' as const, epoch, revision }
          const initial = revision, captured = source
          const check = () => { if (!active || source !== captured || service.liveAssembly(sessionId) !== captured) throw Error('Execution source retired'); reference!.assertCurrent(); broker!.assertCurrent() }
          const read = reference.withRead(profile => execution.read(sessionId, options, check, profile)); flight = read
          try { const value = await read; check(); return initial === revision ? { kind: 'snapshot' as const, epoch, revision, value } : { kind: 'reset' as const, epoch, revision } }
          finally { if (flight === read) flight = undefined }
        },
        close(): Promise<void> {
          active = false; detach()
          if (released) return Promise.resolve()
          if (releaseFlight) return releaseFlight
          const pending = (async () => { await flight?.catch(() => {}); await reference?.release(); released = true; leases.delete(lease); charged-- })()
          releaseFlight = pending; void pending.finally(() => { if (releaseFlight === pending) releaseFlight = undefined }).catch(() => {})
          return pending
        },
      }
      leases.add(lease)
      try {
        offCold = observeColdExecutionWrites(coordinator, id => { if (id === sessionId) dirty() })
        offLifecycle = service.onExecutionSurfaceLifecycle?.(event => { if (event.sessionId === sessionId) { if (event.kind === 'published') attach(event.assembly); else if (source === event.assembly) attach(undefined) } }, { includeExisting: true })
        reference = await coordinator.retainExistingSessionBindingObservation({ sessionId }, operation => { void retire(operation) })
        if (!active || closing) throw Error('Execution observation retired')
        broker = projects.observeExecutionBinding(reference, operation => retire(operation))
        reference.assertCurrent(); broker.assertCurrent()
        const actual = service.liveAssembly(sessionId); if (source !== actual) attach(actual)
        initialized = true; return lease
      } catch (error) { await lease.close(); throw error }
    },
    async close() { closing = true; const results = await Promise.allSettled([...leases].map(lease => lease.close())); const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []); if (errors.length) throw new AggregateError(errors, 'Execution observation cleanup failed') },
  }
}
