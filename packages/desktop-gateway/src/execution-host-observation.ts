import { randomUUID } from 'node:crypto'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { assertRetainedBindingReferenceFor, observationCleanupFor, observeColdExecutionWrites, preflightRetainedCoordinatorFor, assertRetainedCleanupOperation, createRetainedCleanupOperation, finishRetainedCleanupOperation, joinRetainedRetirementSinks, preflightRetainedBindingReleaseFor, assertOutsideRetirementSink, requestRetainedReferenceRetirementFor, runRetainedRetirementSink, type RetainedCleanupOperation, type RetainedExistingBinding } from '@i-harness/session-persistence/internal/retained-inspection'
import type { SessionService, SessionAssembly } from '@i-harness/session-executor'
import type { createProjectScopeBroker } from './project-scope.ts'
import type { createDesktopExecution } from './execution.ts'

type Notice = { kind: 'invalidate' | 'retired'; epoch: string; revision: number }
/** Private composition of original owners. No wire authority or timer. */
export function createExecutionHostObservation(coordinator: SessionCoordinator, projects: Pick<ReturnType<typeof createProjectScopeBroker>, 'observeExecutionBinding'>, service: Pick<SessionService, 'liveAssembly' | 'onExecutionSurfaceLifecycle'>, execution: ReturnType<typeof createDesktopExecution>) {
  type Owned = { preflight(): void; fence(): void; drain(operation: RetainedCleanupOperation, retry?: boolean): Promise<void>; settleRetirement(): Promise<void>; settleNotice(): Promise<void>; settleExternalClose(): Promise<void> }
  const leases = new Set<Owned>()
  let closing = false, closeFlight: Promise<void> | undefined
  const failures = (results: PromiseSettledResult<unknown>[]) => results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  const raise = (input: unknown[]) => { const errors = [...new Set(input)]; if (errors.length === 1) throw errors[0]; if (errors.length) throw new AggregateError(errors, 'Execution observation cleanup failed') }
  const preflight = () => { preflightRetainedCoordinatorFor(coordinator); for (const lease of leases) lease.preflight(); assertOutsideRetirementSink(coordinator) }
  const fence = () => { preflight(); closing = true; for (const lease of leases) lease.fence() }
  function outer(lease: Owned, retry = true): Promise<void> {
    try { lease.preflight(); assertOutsideRetirementSink(coordinator) } catch (error) { return Promise.reject(error) }
    lease.fence()
    const operation = createRetainedCleanupOperation()
    return (async () => {
      try { const resource = await Promise.allSettled([lease.drain(operation, retry)]); const sinks = await Promise.allSettled([lease.settleRetirement(), lease.settleNotice(), joinRetainedRetirementSinks(operation)]); raise([...failures(resource), ...failures(sinks)]) }
      finally { finishRetainedCleanupOperation(operation) }
    })()
  }
  return {
    fence,
    supported() {
      if(!coordinator.retainExistingSessionBindingObservation||!service.onExecutionSurfaceLifecycle)return false
      try{preflightRetainedCoordinatorFor(coordinator);return true}catch{return false}
    },
    async subscribe(sessionId: string, sink: (notice: Notice) => void) {
      if (closing || leases.size >= 32 || !coordinator.retainExistingSessionBindingObservation || !service.onExecutionSurfaceLifecycle) throw Error('Execution observation unavailable')
      assertOutsideRetirementSink(coordinator)
      const epoch = randomUUID(), setup = Promise.withResolvers<void>()
      void setup.promise.catch(() => {})
      let revision = 0, active = true, source: SessionAssembly | undefined, enumerating = true, retiredNotice = false
      let terminalSource: { kind: 'published' | 'retiring' | 'removed'; assembly: SessionAssembly } | undefined
      let acquisitionCleanup: ReturnType<typeof observationCleanupFor>, acquisitionReported = false, acquisitionFailure: { error: unknown } | undefined
      let reference: RetainedExistingBinding | undefined, broker: ReturnType<typeof projects.observeExecutionBinding> | undefined
      let externalClose: Promise<void> | undefined, retirementFlight: Promise<void> | undefined, resourcesClean = false
      let read: Promise<unknown> | undefined, drainFlight: Promise<void> | undefined, noticePending = false, writing = false
      let noticeError: { error: unknown } | undefined
      type NoticeCompletion = { done: Promise<void>; observed: boolean; outcome?: { ok: true } | { ok: false; error: unknown } }
      let retiredCompletion: NoticeCompletion | undefined
      const forgetCompleted = () => {
        if (resourcesClean && !retirementFlight && !externalClose && (!retiredCompletion || retiredCompletion.outcome?.ok || retiredCompletion.observed)) leases.delete(lease)
      }
      const disposers: { dispose(): void; done: boolean }[] = []
      const add = (dispose: (() => void) | undefined) => { if (dispose) disposers.push({ dispose, done: false }) }
      const reliable = () => !terminalSource && (!source || (typeof source.onExecutionSurfaceChanged === 'function' && source.executionSurfaceState?.() === 'available'))
      const terminate = () => {
        if (!active) return
        active = false
        if (reference) {
          // Original nonwaiting ticket is safe even inside a real retained read.
          const pending = requestRetainedReferenceRetirementFor(coordinator, reference, 'Execution source retired')
          retirementFlight = pending
          void pending.then(() => { if (retirementFlight === pending) retirementFlight = undefined; forgetCompleted() }, () => {})
        }
      }
      const notify = (kind: Notice['kind'], operation?: RetainedCleanupOperation) => {
        const invoke = (): void | Promise<void> => { try {
          const returned = (sink as (notice: Notice) => unknown)({ kind, epoch, revision })
          if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') return Promise.resolve(returned).then(() => {}, error => { if (kind !== 'retired') noticeError = { error }; terminate(); throw error })
        } catch (error) { noticeError = { error }; terminate(); throw error } }
        if (operation) {
          // Publish local completion before invoking the original sink. Resource
          // drain never waits this record; independent full boundaries do.
          const result = Promise.withResolvers<void>()
          const record: NoticeCompletion = { done: result.promise, observed: false }
          retiredCompletion = record; void record.done.catch(() => {})
          try {
            const original = runRetainedRetirementSink(operation, coordinator, lease, invoke)
            void original.then(() => { record.outcome = { ok: true }; result.resolve(); forgetCompleted() }, error => { record.outcome = { ok: false, error }; result.reject(error) })
          } catch (error) { record.outcome = { ok: false, error }; result.reject(error) }
          return
        }
        try { void Promise.resolve(invoke()).catch(() => {}) } catch { /* stored on this owned record; original ticket drives cleanup */ }
      }
      const dirty = () => {
        if (!active) return
        if (!reliable() || revision === Number.MAX_SAFE_INTEGER) { terminate(); return }
        revision++
        if (!noticePending) { noticePending = true; queueMicrotask(() => { noticePending = false; if (active) notify('invalidate') }) }
      }
      const lease = {
        epoch,
        preflight() { if(writing) throw Error('Execution writer cannot close its own lease'); preflightRetainedCoordinatorFor(coordinator, [sessionId]); if (reference) preflightRetainedBindingReleaseFor(coordinator, reference) },
        fence() { active = false },
        async settleExternalClose() { await externalClose },
        async settleRetirement() { const pending = retirementFlight; try { await pending } finally { if (retirementFlight === pending) retirementFlight = undefined; forgetCompleted() } },
        async settleNotice() {
          const record = retiredCompletion
          if (!record || record.observed) return
          try { await record.done } finally { record.observed = true; forgetCompleted() }
        },
        drain(operation: RetainedCleanupOperation, retry = true): Promise<void> {
          active = false
          if (drainFlight) return drainFlight
          const deferred = Promise.withResolvers<void>(); drainFlight = deferred.promise; void drainFlight.catch(() => {})
          void (async () => {
            await setup.promise.catch(() => {}); await read?.catch(() => {})
            const jobs: Promise<unknown>[] = disposers.filter(item => !item.done).map(async item => { await item.dispose(); item.done = true })
            if (acquisitionCleanup) jobs.push(Promise.resolve().then(async () => {
              if (!retry || !acquisitionReported) throw acquisitionFailure!.error
              await acquisitionCleanup!.retry(operation); acquisitionCleanup = undefined
            }))
            if (reference) jobs.push(Promise.resolve().then(() => reference!.release(operation)))
            const errors = failures(await Promise.allSettled(jobs))
            if (noticeError) { errors.unshift(noticeError.error); noticeError = undefined }
            resourcesClean = !errors.length
            forgetCompleted()
            raise(errors)
          })().then(deferred.resolve, deferred.reject).finally(() => { drainFlight = undefined })
          return deferred.promise
        },
        close(): Promise<void> {
          try { lease.preflight(); assertOutsideRetirementSink(coordinator) } catch (error) { return Promise.reject(error) }
          if (externalClose) return externalClose
          const flight = outer(lease); externalClose = flight
          void flight.finally(() => { if (externalClose === flight) externalClose = undefined; forgetCompleted() }).catch(() => {})
          return flight
        },
        withCurrent<T>(write: (stamp: { epoch: string; revision: number }) => T): T {
          if(writing) throw Error('Execution writer reentry')
          if (!active || !reference || !broker || !reliable() || source !== service.liveAssembly(sessionId)) throw Error('Execution source retired or unavailable')
          reference.assertCurrent(); broker.assertCurrent()
          writing=true
          try { return write({ epoch, revision }) } catch(error) {terminate();throw error} finally {writing=false}
        },
        async snapshot(options: { offset?: number; limit?: number } = {}) {
          if (!active || !reference || !broker) throw Error('Execution observation retired or unavailable')
          if (!reliable()) { terminate(); throw Error('Execution source unavailable') }
          reference.assertCurrent(); broker.assertCurrent()
          if (read) return { kind: 'reset' as const, epoch, revision }
          const initial = revision, captured = source
          const check = () => { try { if (!active || source !== captured || service.liveAssembly(sessionId) !== captured || !reliable()) throw Error('Execution source retired or unavailable'); reference!.assertCurrent(); broker!.assertCurrent() } catch (error) { terminate(); throw error } }
          const flight = reference.withRead(profile => execution.read(sessionId, options, check, profile)); read = flight
          try { const value = await flight; check(); return initial === revision ? { kind: 'snapshot' as const, epoch, revision, value } : { kind: 'reset' as const, epoch, revision } }
          catch (error) { terminate(); throw error }
          finally { if (read === flight) read = undefined }
        },
      }
      leases.add(lease)
      const retire = (operation: RetainedCleanupOperation) => {
        active = false
        if (!retiredNotice) { retiredNotice = true; notify('retired', operation) }
        // Acquisition's own failure cleanup must not await its public result.
        if (!reference) return
        return lease.drain(operation)
      }
      const acquisition = (async () => {
        add(observeColdExecutionWrites(coordinator, id => { if (id === sessionId) dirty() }))
        add(service.onExecutionSurfaceLifecycle!(event => {
          if (event.sessionId !== sessionId) return
          if (event.kind !== 'published' || !enumerating || source && source !== event.assembly) { terminalSource = { kind: event.kind, assembly: event.assembly }; terminate(); return }
          source = event.assembly
          add(source.onExecutionSurfaceChanged?.(dirty))
        }, { includeExisting: true }))
        enumerating = false
        reference = await coordinator.retainExistingSessionBindingObservation!({ sessionId }, retire)
        if (!active || closing) throw Error('Execution observation retired')
        assertRetainedBindingReferenceFor(coordinator, reference)
        if (reference.metadata().sessionId !== sessionId) throw Error('Execution retained identity mismatch')
        broker = projects.observeExecutionBinding(reference, retire); add(() => broker!.release())
        reference.assertCurrent(); broker.assertCurrent()
        if (source !== service.liveAssembly(sessionId) || !reliable()) throw Error('Execution source unavailable')
      })()
      void acquisition.then(setup.resolve, error => { acquisitionFailure = { error }; acquisitionCleanup = observationCleanupFor(coordinator, error); setup.reject(error) })
      try { await acquisition; return Object.freeze({ epoch, snapshot: lease.snapshot, close: lease.close, withCurrent: lease.withCurrent }) }
      catch (error) { try { await outer(lease, false) } catch (cleanup) { throw new AggregateError([error, cleanup], 'Execution acquisition and cleanup failed') } finally { acquisitionReported = true }; throw error }
    },
    close(supplied?: RetainedCleanupOperation): Promise<void> {
      try { if (supplied) assertRetainedCleanupOperation(supplied); fence() } catch (error) { return Promise.reject(error) }
      if (closeFlight) return closeFlight
      const operation = supplied ?? createRetainedCleanupOperation()
      const flight = (async () => {
        try { const selected = [...leases]; const resources = failures(await Promise.allSettled(selected.map(lease => lease.drain(operation)))); const sinks = failures(await Promise.allSettled([...selected.map(lease => lease.settleRetirement()), ...selected.map(lease => lease.settleNotice()), ...selected.map(lease => lease.settleExternalClose()), joinRetainedRetirementSinks(operation)])); raise([...resources, ...sinks]) }
        finally { if (!supplied) finishRetainedCleanupOperation(operation) }
      })()
      closeFlight = flight; void flight.finally(() => { if (closeFlight === flight) closeFlight = undefined }).catch(() => {})
      return flight
    },
  }
}
