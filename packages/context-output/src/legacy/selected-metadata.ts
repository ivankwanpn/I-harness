import { freezeJsonData, type HeldInheritedResultMetadata } from '@i-harness/core-session'
import { captureObservation,hasOriginalZeroSource } from './observed-read.ts'
import { assertSelectedGrant, assertSelectedPlan, readSelectedPlan, qualifySelectedGraph, selectedRow, walkSelectedPages, type OriginalSelectedPlan } from './selected-readonly-plan.ts'
import type { ContextStore } from '../store.ts'
import type { LegacyReadObservation, LegacyRow } from './fork-types.ts'

type WithRead = <T>(work: (store: ContextStore) => Promise<T>) => Promise<T>
/** Private finite mode. Its observation is built from a nominal original cold
 * coordinator capture by the service, never an ordinary READY reader. */
export function createColdSelectedMetadata(observation: LegacyReadObservation, withRead: WithRead, settle: () => Promise<void>, assertService: () => void, onClosed: () => void) {
  let originalStore: ContextStore | undefined, plan: OriginalSelectedPlan | undefined, minimumExpiry: number | undefined
  let revoked = false, closed = false, qualified = false, sealed = false, settled = false
  let qualification: Promise<void> | undefined, settlement: Promise<void> | undefined, closing: Promise<void> | undefined
  const independent = () => {
    if (revoked || closed) throw Error('Cold legacy qualification revoked')
    try { assertService(); if (minimumExpiry !== undefined && Date.now() >= minimumExpiry) throw Error('Original selected metadata expired') }
    catch (failure) { revoked = true; throw failure }
  }
  const active = () => { independent(); observation.assertCurrent() }
  const handle = Object.freeze({
    qualify() {
      if (this !== handle) throw TypeError('Invalid cold legacy receiver')
      if (qualification) return qualification
      active()
      qualification = withRead(async store => {
        active(); originalStore = store; plan = await readSelectedPlan(store, observation, active)
        if (plan.root.version !== 2 || !plan.selected) throw Error('Original V2 selected legacy plan required')
        const proof = await qualifySelectedGraph(store, plan, observation, active); minimumExpiry = proof.minimumExpiry
        await assertSelectedPlan(store, plan, observation, active); active()
      }).then(() => { active(); qualified = true })
      void qualification.catch(() => {}); return qualification
    },
    sealWhileActive() { if (this !== handle || !qualified || !plan || !originalStore) throw Error('Cold legacy qualification unverified'); active(); sealed = true },
    settle() {
      if (this !== handle) throw TypeError('Invalid cold legacy receiver')
      if (settlement) return settlement
      const flight = (async () => { if (!qualification) throw Error('Cold legacy qualification unused'); await qualification; if (!sealed) throw Error('Cold legacy qualification unsealed'); await settle(); independent(); originalStore!.assertLegacyFilesSettled(); settled = true })()
      settlement = flight; void flight.finally(() => { if (settlement === flight) settlement = undefined }).catch(() => {}); return flight
    },
    assertSettledCurrent() {
      if (this !== handle || !qualified || !sealed || !settled || settlement || closing || !originalStore || !plan) throw Error('Cold legacy qualification unsettled')
      independent(); originalStore.assertLegacyFilesSettled()
    },
    revoke() { if (this !== handle) throw TypeError('Invalid cold legacy receiver'); revoked = true },
    close() {
      if (this !== handle) throw TypeError('Invalid cold legacy receiver')
      if (closed) return Promise.resolve(); if (closing) return closing
      revoked = true
      const flight = (async () => { await qualification?.catch(() => {}); await settlement?.catch(() => {}); await settle(); closed = true; onClosed() })()
      closing = flight; void flight.finally(() => { if (closing === flight) closing = undefined }).catch(() => {}); return flight
    },
  })
  return handle
}
/** Trusted original-service composition only; this input is not provenance. */
export async function createSelectedMetadata(input: LegacyReadObservation, withRead: WithRead, settle: (store: ContextStore) => Promise<void>, assertService: () => void, onClosed: () => void, service?:object) {
  const observation = captureObservation(input,service)
  let originalStore: ContextStore | undefined, plan: OriginalSelectedPlan | undefined, minimumExpiry: number | undefined
  let revoked = false, closed = false, entered = false, ended = false, qualified = false, noSource = false
  let iterator: AsyncGenerator<LegacyRow> | undefined, flight: Promise<unknown> | undefined, returnFlight: Promise<void> | undefined, closeFlight: Promise<void> | undefined, iteratorClosed = false
  const current = () => {
    if (revoked || closed) throw Error('Selected metadata reader revoked')
    try { assertService(); if(noSource){if(!hasOriginalZeroSource(observation,service))throw Error('Original zero-source proof unavailable')}else observation.assertCurrent(); if (minimumExpiry !== undefined && minimumExpiry <= Date.now()) throw Error('Original selected metadata expired') }
    catch (failure) { revoked = true; throw failure }
  }
  current()
  noSource=hasOriginalZeroSource(observation,service)
  if (observation.bootstrap && !noSource) await withRead(async store => {
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
              let row = await iterator!.next(); current()
              if (row.done) {
                await assertSelectedPlan(store, plan!, observation, current)
                await qualifySelectedGraph(store, plan!, observation, current)
                await assertSelectedPlan(store, plan!, observation, current); current()
                return { done: true as const, value: undefined }
              }
              let metadata = await selectedRow(store, plan!, row.value, observation, current)
              while(!metadata){row=await iterator!.next();current();if(row.done){await assertSelectedPlan(store,plan!,observation,current);await qualifySelectedGraph(store,plan!,observation,current);await assertSelectedPlan(store,plan!,observation,current);current();return {done:true as const,value:undefined}}metadata=await selectedRow(store,plan!,row.value,observation,current)}
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
