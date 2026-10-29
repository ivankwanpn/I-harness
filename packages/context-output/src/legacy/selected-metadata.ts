import { freezeJsonData, type HeldInheritedResultMetadata } from '@i-harness/core-session'
import { captureObservation } from './observed-read.ts'
import { assertSelectedGrant, assertSelectedPlan, readSelectedPlan, qualifySelectedGraph, selectedRow, walkSelectedPages, type OriginalSelectedPlan } from './selected-readonly-plan.ts'
import type { ContextStore } from '../store.ts'
import type { LegacyReadObservation, LegacyRow } from './fork-types.ts'

type WithRead = <T>(work: (store: ContextStore) => Promise<T>) => Promise<T>
/** Trusted original-service composition only; this input is not provenance. */
export async function createSelectedMetadata(input: LegacyReadObservation, withRead: WithRead, settle: (store: ContextStore) => Promise<void>, assertService: () => void, onClosed: () => void) {
  const observation = captureObservation(input)
  let originalStore: ContextStore | undefined, plan: OriginalSelectedPlan | undefined, minimumExpiry: number | undefined
  let revoked = false, closed = false, entered = false, ended = false, qualified = false
  let iterator: AsyncGenerator<LegacyRow> | undefined, flight: Promise<unknown> | undefined, returnFlight: Promise<void> | undefined, closeFlight: Promise<void> | undefined, iteratorClosed = false
  const current = () => {
    if (revoked || closed) throw Error('Selected metadata reader revoked')
    try { assertService(); observation.assertCurrent(); if (minimumExpiry !== undefined && minimumExpiry <= Date.now()) throw Error('Original selected metadata expired') }
    catch (failure) { revoked = true; throw failure }
  }
  current()
  if (observation.bootstrap) await withRead(async store => {
    current(); originalStore = store; plan = await readSelectedPlan(store, observation, current)
    const proof = await qualifySelectedGraph(store, plan, observation, current); minimumExpiry = proof.minimumExpiry
    await assertSelectedPlan(store, plan, observation, current); current()
  })
  const finishIterator = () => {
    if (iteratorClosed) return Promise.resolve()
    if (returnFlight) return returnFlight
    const task = (async () => { if (flight) await flight.catch(() => {}); if (iterator) await iterator.return(undefined); iteratorClosed = true })()
    returnFlight = task; void task.finally(() => { if (returnFlight === task) returnFlight = undefined }).catch(() => {}); return task
  }
  const reader: HeldInheritedResultMetadata = Object.freeze({
    assertCurrent: current,
    legacy() {
      current(); if (entered) throw Error('Selected metadata iterator already entered'); entered = true
      if (plan) iterator = walkSelectedPages(originalStore!, plan, current)
      return {
        [Symbol.asyncIterator]() { return this },
        async next() {
          current(); if (ended) return { done: true as const, value: undefined }
          if (flight) { revoked = true; throw Error('Concurrent selected metadata iteration') }
          const task = (async () => {
            if (!plan) { qualified = ended = true; return { done: true as const, value: undefined } }
            const value = await withRead(async store => {
              current(); if (store !== originalStore) throw Error('Original metadata store changed')
              await assertSelectedPlan(store, plan!, observation, current)
              const row = await iterator!.next(); current()
              if (row.done) {
                await assertSelectedPlan(store, plan!, observation, current)
                await qualifySelectedGraph(store, plan!, observation, current)
                await assertSelectedPlan(store, plan!, observation, current); current()
                return { done: true as const, value: undefined }
              }
              const metadata = await selectedRow(store, plan!.root, row.value, observation.sourceId, current)
              await assertSelectedGrant(store, plan!, current); current()
              return { done: false as const, value: freezeJsonData(metadata) }
            })
            // Outside the shared gate, settle debt before EOF can qualify a DTO.
            // The whole next remains owned by this finite original-reader flight.
            if (value.done) { await settle(originalStore!); current(); qualified = ended = true }
            current(); return value
          })()
          flight = task
          try { return await task } catch (failure) { revoked = true; throw failure }
          finally { if (flight === task) flight = undefined }
        },
        async return() { ended = true; if (!qualified) revoked = true; await finishIterator(); return { done: true as const, value: undefined } },
      }
    },
  })
  return Object.freeze({
    reader, assertCurrent: current, revoke() { revoked = true },
    close() {
      if (closed) return Promise.resolve()
      if (closeFlight) return closeFlight
      revoked = true
      const task = (async () => { await finishIterator(); if (originalStore) await settle(originalStore); closed = true; onClosed() })()
      closeFlight = task; void task.finally(() => { if (closeFlight === task) closeFlight = undefined }).catch(() => {}); return task
    },
  })
}
