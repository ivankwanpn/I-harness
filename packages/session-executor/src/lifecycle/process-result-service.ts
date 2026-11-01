import { AsyncLocalStorage } from 'node:async_hooks'
import { createContextOutputService, type ContextCapture, type ContextOutputService } from '@i-harness/context-output'
import type { ManagedArtifactRef } from '@i-harness/core-session'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { inspectSelectedTarget } from '@i-harness/session-persistence/internal/selected-source-owner'
import { canonicalJsonData } from '@i-harness/core-session'
import { lookupProcessReadContext } from '@i-harness/session-persistence/internal/process-read-context'
import { beginOriginalResultOrderingRegistration } from '../../../session-persistence/src/result-ordering-internal.ts'
import { registerOriginalLegacyOrdering, commitOriginalLegacyOrdering, requireOriginalLegacyOrdering } from '../../../context-output/src/service.ts'
import { acquireSelectedMetadata as acquireCoreSelectedMetadata, selectedMetadataCleanupFor,selectedLegacyTransferFor, acquireColdManagedQualification as acquireCoreColdManagedQualification, revokeColdManagedQualifications, acquireColdSelectedQualification as acquireCoreColdSelectedQualification, revokeColdSelectedQualifications } from '../../../context-output/src/service.ts'

type ServiceOptions = Parameters<typeof createContextOutputService>[0]
type Policy = Omit<ServiceOptions, 'authorizeResult'> & {
  orderingCoordinators?: readonly SessionCoordinator[]
  coordinatorFor(sessionId: string): SessionCoordinator | undefined
  sourceFor(sessionId: string): Promise<NonNullable<ContextCapture['source']>>
  genericVisible(sessionId: string, ref: ManagedArtifactRef): Promise<boolean>
  guardedRead?<T>(sessionId: string, run: () => Promise<T>): Promise<T>
}
type Page = { coordinator: SessionCoordinator; id: string; available(): boolean }
const pages = new AsyncLocalStorage<Page>()
type Bridge = { withPage<T>(coordinator: SessionCoordinator, id: string, available: () => boolean, run: () => Promise<T>): Promise<T> }
const owners = new WeakMap<ContextOutputService, Bridge>()
export function lookupProcessResultService(service: ContextOutputService) { return owners.get(service) }

/** Creates the original service and its result authorization together. */
export function createProcessAwareResultService(policy: Policy) {
  const orderingIdentity = {}, registrations: ReturnType<typeof beginOriginalResultOrderingRegistration>[] = []
  try { for (const coordinator of new Set(policy.orderingCoordinators)) registrations.push(beginOriginalResultOrderingRegistration(coordinator, orderingIdentity)) }
  catch (failure) { for (const registration of registrations) registration.cancel(); throw failure }
  const ordered = new Set(policy.orderingCoordinators)
  let retired = false
  const failScope = (id: string) => { try { lookupProcessReadContext(undefined!, id) } catch { /* Original context latches its denial. */ } }
  const context = (id: string) => {
    const page = pages.getStore(), coordinator = page?.coordinator ?? policy.coordinatorFor(id)
    if (policy.orderingCoordinators && coordinator && !ordered.has(coordinator)) throw Error('Original result coordinator registration required')
    const process = lookupProcessReadContext(coordinator!, id)
    process?.assertPageAdmission()
    if (process && (!page || page.id !== id || !page.available())) { failScope(id); throw new Error('PROCESS_READ_UNAVAILABLE') }
    return process
  }
  let service: ContextOutputService
  try { service = createContextOutputService({ ...policy,
    authorizeResult: async (access, metadata) => {
      try {
        const process = context(access.sessionId); process?.assertCurrent()
        const deny = () => { if (process) failScope(access.sessionId); return false }
        if (metadata.workspaceId !== policy.workspaceId || !metadata.owner.source) return deny()
        const source = await policy.sourceFor(access.sessionId); process?.assertCurrent()
        if (source.sourceId !== metadata.owner.source.sourceId) return deny()
        if (!metadata.visibleVia && access.sessionId === metadata.owner.sessionId) return true
        const expected = metadata.visibleVia ?? metadata.ref
        if (process) return process.containsVisibleResult(expected) || deny()
        return await policy.genericVisible(access.sessionId, expected)
      } catch { failScope(access.sessionId); return false }
    },
    authorize: policy.authorize && (async (access, ref) => {
      try { if (context(access.sessionId)) { failScope(access.sessionId); throw new Error('PROCESS_READ_UNAVAILABLE') }; return await policy.authorize!(access, ref) } catch { return false }
    }),
  }); if (policy.orderingCoordinators) requireOriginalLegacyOrdering(service); for (const registration of registrations) commitOriginalLegacyOrdering(service, registration) }
  catch (failure) { for (const registration of registrations) registration.cancel(); throw failure }
  {
    const read = service.readResult.bind(service), exec = service.readExecResult.bind(service)
    const admitted = <T>(id: string, run: () => Promise<T>) => {
      context(id)?.assertPageAdmission()
      return policy.guardedRead ? policy.guardedRead(id, run) : run()
    }
    service.readResult = (access, query) => admitted(access.sessionId, () => read(access, query))
    service.readExecResult = (access, query) => admitted(access.sessionId, () => exec(access, query))
  }
  const readResult = Object.getOwnPropertyDescriptor(service, 'readResult'), readExecResult = Object.getOwnPropertyDescriptor(service, 'readExecResult')
  const assertMethods = () => {
    for (const [key, expected] of [['readResult', readResult], ['readExecResult', readExecResult]] as const) {
      const current = Object.getOwnPropertyDescriptor(service, key)
      if (!current || !expected || !('value' in current) || !('value' in expected) || current.value !== expected.value) throw new Error('PROCESS_READ_UNAVAILABLE')
    }
  }
  const bridge: Bridge = Object.freeze({ async withPage<T>(coordinator: SessionCoordinator, id: string, available: () => boolean, run: () => Promise<T>) {
    if (this !== bridge || retired || !available()) throw new Error('PROCESS_READ_UNAVAILABLE')
    const process = lookupProcessReadContext(coordinator, id)
    if (!process) return run()
    try { assertMethods(); process.assertPageAdmission() } catch (error) { failScope(id); throw error }
    return pages.run({ coordinator, id, available }, async () => {
      try {
        const result = await run(); if (retired || !available()) throw new Error('PROCESS_READ_UNAVAILABLE')
        assertMethods(); process.assertPageAdmission(); return result
      } catch (error) { failScope(id); throw error }
    })
  } })
  owners.set(service, bridge)
  const acquireSelectedMetadata=async(observation:Parameters<typeof acquireCoreSelectedMetadata>[1])=>{
    if(retired)throw Error('Original result service retired')
    const selected=await acquireCoreSelectedMetadata(service,observation)
    if(retired){await selected.close();throw Error('Original result service retired')}
    return selected
  }
  function acquireSelectedLegacyTransfer(coordinator:SessionCoordinator,target:object,capture:import('../../../context-output/src/legacy/fork-types.ts').SelectedLegacyCapture) {
    if(retired)throw Error('Original result service retired')
    const actual=inspectSelectedTarget(coordinator,target)
    if(canonicalJsonData(actual.facts)!==canonicalJsonData(capture.facts)||canonicalJsonData(actual.seed.records)!==canonicalJsonData(capture.targetView.events))throw Error('Original selected seed required')
    const owner=selectedLegacyTransferFor(service),scope=owner.register(capture)
    return Object.freeze({assertCurrent:()=>owner.assertCurrent(scope),confirm:()=>owner.confirm(scope),reconcile:()=>owner.reconcile(scope),close:()=>owner.closeScope(scope)})
  }
  const acquireColdManagedQualification = (...args: Parameters<typeof acquireCoreColdManagedQualification> extends [unknown, ...infer A] ? A : never) => {
    if (retired) throw Error('Original result service retired')
    assertMethods(); return acquireCoreColdManagedQualification(service, ...args)
  }
  const acquireColdSelectedQualification = (...args: Parameters<typeof acquireCoreColdSelectedQualification> extends [unknown, ...infer A] ? A : never) => {
    if (retired) throw Error('Original result service retired')
    assertMethods(); return acquireCoreColdSelectedQualification(service, ...args)
  }
  return { service, registerCoordinator(coordinator: SessionCoordinator) { if (retired) throw Error('Original result service retired'); if (!ordered.has(coordinator)) { registerOriginalLegacyOrdering(service, coordinator); ordered.add(coordinator) } }, acquireColdManagedQualification, acquireColdSelectedQualification, acquireSelectedLegacyTransfer, withPage: bridge.withPage.bind(bridge), acquireSelectedMetadata, selectedMetadataCleanupFor:(error:unknown)=>selectedMetadataCleanupFor(service,error), retireBridge() { retired = true; revokeColdManagedQualifications(service); revokeColdSelectedQualifications(service) } }
}
