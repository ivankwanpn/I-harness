import { AsyncLocalStorage } from 'node:async_hooks'
import { isManagedFactOwner, isNondurableSession, type FactOwner, type SessionView } from '@i-harness/core-session'
import type { AuthorityState } from '@i-harness/sandbox'
import type { InstructionTarget } from '@i-harness/instructions'
import type { ToolExec } from '@i-harness/core-tools'
import type { InstructionReadScope } from '@i-harness/fs'
import type { ChildInstructionContextFactory } from '@i-harness/subagent'
import type { createMainInstructionManager } from './manager.ts'
import type { InstructionEnvironment } from './contracts.ts'
import { InstructionSlot, type CleanupFlight, type SlotOwner } from './child-host/slot.ts'
import { observedRejection, reentrantClose, trackOperation, unavailable, type Operation } from './child-host/operations.ts'

export function createChildInstructionHost(options: {
  environment: InstructionEnvironment; cwd: string; authority: () => AuthorityState; available: () => boolean
  root: { session: SessionView; factOwner: FactOwner; manager: ReturnType<typeof createMainInstructionManager> }
}) {
  const { environment, cwd, authority, available: hostAvailable } = options
  const { session: rootSession, factOwner: rootOwner, manager: rootManager } = options.root
  if (rootOwner.view !== rootSession) throw new TypeError('Root instruction owner/view mismatch')
  const managerOptions = { environment, cwd, authority }
  const slots = new WeakMap<SessionView, InstructionSlot>(), owned = new Set<InstructionSlot>()
  const roots = new Set<Operation>(), flights = new Set<CleanupFlight>()
  // The original's async continuations must also reject self-join, while an
  // unrelated external close can join its pending work.
  const originalCalls = new AsyncLocalStorage<{ active: boolean }>()
  let retired = false, constructing = false, closing: Promise<void> | undefined
  const invoking = () => originalCalls.getStore()?.active === true
  const invoke = <T>(original: () => T): T => {
    const call = { active: true }
    return originalCalls.run(call, () => {
      try {
        const result = original()
        if (result instanceof Promise) void result.then(() => { call.active = false }, () => { call.active = false })
        else call.active = false
        return result
      } catch (error) { call.active = false; throw error }
    })
  }
  const available = () => !retired && invoke(hostAvailable) && !retired
  const owner: SlotOwner = { available, invoking: () => constructing || invoking(), invoke,
    admit(flight) {
      flights.add(flight)
      void flight.work.then(() => { flights.delete(flight) }, () => { flights.delete(flight) })
    },
    remove(slot) { if (slots.get(slot.session) === slot) { slots.delete(slot.session); owned.delete(slot) } },
  }
  const create: ChildInstructionContextFactory = input => {
    if (constructing || invoking() || retired) throw unavailable()
    constructing = true
    try {
      // Caller aliases are mutable. Capture each original capability once and
      // fence getter reentry before any subsequent capture or resource work.
      const capture = <T>(read: () => T): T => { const value = read(); if (retired) throw unavailable(); return value }
      const session = capture(() => input.session), factOwner = capture(() => input.factOwner)
      const lifetime = capture(() => input.lifetime), lifetimeAvailable = capture(() => lifetime.available)
      const ownerView = capture(() => factOwner.view)
      if (ownerView !== session || session === rootSession
        || (!isNondurableSession(session) && !isManagedFactOwner(session, factOwner))) throw new TypeError('Exact original child instruction owner required')
      if (retired) throw unavailable()
      const previous = slots.get(session)
      if (previous) {
        if (previous.factOwner === factOwner) previous.retryConstructionCleanup()
        throw unavailable()
      }
      const slot = new InstructionSlot(session, factOwner, () => Reflect.apply(lifetimeAvailable, lifetime, []), owner)
      slots.set(session, slot); owned.add(slot)
      return slot.construct(managerOptions)
    } finally { constructing = false }
  }
  Object.defineProperty(create, 'settleFailed', { value: (input: Parameters<ChildInstructionContextFactory>[0]) => {
    const slot = slots.get(input.session)
    if (!slot) return Promise.resolve()
    if (slot.factOwner !== input.factOwner) return observedRejection(new TypeError('Original child instruction owner mismatch'))
    if (!slot.failed) return observedRejection(Object.assign(new Error('Original failed instruction construction unavailable'), { code: 'FACT_RECOVERY_REQUIRED' }))
    return slot.close()
  } })
  const retire = () => { retired = true; for (const slot of owned) slot.retire() }
  const close = (): Promise<void> => {
    retire()
    if (constructing || invoking()) return observedRejection(reentrantClose())
    if (closing) return closing
    const deferred = Promise.withResolvers<void>()
    closing = deferred.promise
    void closing.then(() => { closing = undefined }, () => { closing = undefined })
    const rootSnapshot = [...roots], admitted = [...flights], children = [...owned]
    void Promise.resolve().then(async () => {
      const outcomes = await Promise.allSettled([
        ...rootSnapshot.map(original => original.work.then(() => {}, () => {})),
        ...admitted.map(flight => flight.work.then(() => {}, () => {})),
        ...children.map(slot => slot.close()),
      ])
      const errors = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      for (const flight of admitted) if (!flight.reported && !flight.slot.clean && flight.result?.status === 'rejected') {
        errors.push(flight.result.reason); flight.reported = true
      }
      if (errors.length) throw new AggregateError(errors, 'Child instruction cleanup incomplete')
    }).then(deferred.resolve, deferred.reject)
    return deferred.promise
  }
  return { create, diagnosticsFor(session: SessionView, factOwner: FactOwner) {
    if (!available() || factOwner.view !== session) return undefined
    if (session === rootSession) return factOwner === rootOwner ? rootManager.diagnostics : undefined
    const slot = slots.get(session)
    return slot && slot.factOwner === factOwner ? slot.diagnostics() : undefined
  }, observe(target: InstructionTarget, exec: ToolExec): Promise<InstructionReadScope> {
    if (!available()) return Promise.resolve({ status: 'unavailable', reason: 'mapping-unavailable' })
    const session = exec.session
    if (!session) return Promise.resolve({ status: 'reference-only', reason: 'outside-root' })
    if (session === rootSession) {
      return trackOperation(roots, () => invoke(() => rootManager.observe(target))).work.then(result =>
        available() ? result : { status: 'unavailable', reason: 'mapping-unavailable' })
    }
    const slot = slots.get(session)
    return slot ? slot.observe(target) : Promise.resolve({ status: 'reference-only', reason: 'outside-root' })
  }, retire, close }
}
