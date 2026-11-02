import { associateOriginalResultRevocation } from './coordinator/result-revocation.ts'
import { associateRestoredContextAcquisition } from './restored-context-internal.ts'
import {associateManagedExecution} from './execution-internal.ts'
import { attachArchiveReadResources } from './archive-read-internal.ts'
import type { PersistenceBackend, CoordinatorOptions, SessionCoordinator } from './coordinator/types.ts'
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import { createOwnership } from './coordinator/ownership.ts'
import { associateOriginalResultOrdering } from './result-ordering-internal.ts'
import { createColdExecutionWrites, associateColdExecutionWrites } from './coordinator/cold-execution-writes.ts'
import { createMutations } from './coordinator/mutations.ts'
import { createDocuments } from './coordinator/documents.ts'
import { createLoads } from './coordinator/load.ts'
import { createLifecycle } from './coordinator/lifecycle.ts'
import { associateProjectBindingWrites } from './coordinator/project-binding-write.ts'
import { associateDeletionPreparation } from './coordinator/deletion-preparation.ts'
import { createManagedDocuments } from './coordinator/managed-documents.ts'
import { assertOutsideForkController, closeForkControllerAdmission } from './fork-controller.ts'
import { associateObservationCleanupOwner } from './coordinator/binding-observation.ts'
import { associateRetainedCoordinatorClose, assertOutsideRetirementSink, createRetainedCleanupOperation, finishRetainedCleanupOperation, type RetainedCleanupOperation } from './coordinator/retained-cleanup.ts'
import { createProcessReadLatches } from './coordinator/process-read-latches.ts'
import type { ProcessReadStorage } from './coordinator/process-read-storage.ts'
import { captureBootstrapInvocation } from './coordinator/bootstrap-header.ts'
import type { BootstrapOutcome, BootstrapInvocation } from './coordinator/bootstrap-types.ts'
import { types as utilTypes } from 'node:util'
import type { TaskDocumentConfiguration } from './coordinator/task-document-operation.ts'
import { isTaskTransitionDrain, runTaskTransitionDrain, type TaskTransitionConfiguration } from './coordinator/task-document-transition.ts'
import { associateTaskDocumentOperations } from './coordinator/task-document-association.ts'
import { associateTaskDocumentTransitions } from './coordinator/task-transition-association.ts'
import { captureTaskSnapshot } from './coordinator/task-document-snapshot.ts'
import { retainSelectedSourceRead,retainTaskSourceRead,retainManagedTaskSourceRead } from './coordinator/managed-document.ts'
import { captureSelectedResultsRoute } from './coordinator/selected-results-route.ts'
import { readSelectedResultsOperation,type ForkOperationV2 } from './selected-results-fork-contract.ts'
type SelectedHandoff={source:{sourceSessionId:string;document:import('./coordinator/fact-types.ts').ManagedDocument;view:import('@i-harness/core-session').SessionView;events:import('@i-harness/core-session').SessionView['events'];eventCount:number;inherited:import('@i-harness/core-session').HeldInheritedResultMetadata};assertCurrent():void}
type OriginalSelectedOperation={first<T>(work:(handoff:SelectedHandoff)=>Promise<T>,signal?:AbortSignal):Promise<T>;warm<T>(work:(handoff:SelectedHandoff)=>Promise<T>,signal?:AbortSignal):Promise<T>;passive<T>(work:(handoff:{assertCurrent():never})=>Promise<T>):Promise<T>;exportOnceInCurrentUse():Promise<unknown>;confirmTarget():Promise<import('./coordinator/bootstrap-types.ts').BootstrapTargetPreparationOutcome>;confirmManagedDependencies():Promise<import('@i-harness/core-session').BootstrapDependencyOutcome>;confirmLegacyDependencies():Promise<{kind:'confirmed'}|{kind:'blocked';reason:'unknown'|'unavailable'|'conflict'|'policy'}>;reconcileLegacyDependencies():Promise<{kind:'confirmed'}|{kind:'blocked';reason:'unknown'|'unavailable'|'conflict'|'policy'}|undefined>;assertTargetCurrent():void;assertOutsideUse():void;revoke():void;drain():Promise<void>;close():Promise<void>}
const selectedSources=new WeakMap<SessionCoordinator,{acquire:ReturnType<typeof createDocuments>['observations']['acquireSelectedBindingRead'];cleanupForError:ReturnType<typeof createDocuments>['observations']['cleanupForError'];retainTask(owner:object,view:import('@i-harness/core-session').SessionView,onRevoke:()=>void):ReturnType<typeof retainTaskSourceRead>;retainManagedTask(domain:import('@i-harness/core-session/internal/execution').ManagedExecutionDomain,history:object,onRevoke:()=>void):ReturnType<typeof retainManagedTaskSourceRead>;retain(document:import('./coordinator/fact-types.ts').ManagedDocument,onRevoke:()=>void):ReturnType<typeof retainSelectedSourceRead>}>()
const selectedComposers=new WeakMap<SessionCoordinator,{beginCold:ReturnType<ReturnType<typeof createDocuments>["observations"]["createColdFinalizationFactory"]>["begin"];assertCapability():void;capture:ReturnType<typeof createManagedDocuments>['captureSelected'];prepare:ReturnType<typeof createManagedDocuments>['prepareSelectedCapture'];reconcile:ReturnType<typeof createManagedDocuments>['reconcileSelected'];inspect:ReturnType<typeof createManagedDocuments>['inspectSelected'];inspectCold:ReturnType<typeof createManagedDocuments>['inspectColdSelected'];coldRoute:ReturnType<typeof createManagedDocuments>['coldSelectedRoute'];useCold:ReturnType<typeof createManagedDocuments>['useColdSelected'];publish:ReturnType<typeof createManagedDocuments>['publishSelected'];release:ReturnType<typeof createManagedDocuments>['releaseSelected'];observations:ReturnType<typeof createDocuments>['observations'];targets:WeakMap<object,ReturnType<typeof createManagedDocuments>['inspectSelected'] extends (...args:any[])=>infer R?()=>R:never>}>()
export function beginColdSelectedFinalization(coordinator:SessionCoordinator,target:import('./coordinator/cold-selected-target.ts').ColdSelectedTarget,options?:{signal?:AbortSignal}) {const owner=selectedComposers.get(coordinator);if(!owner)throw TypeError('Original coordinator required');return owner.beginCold(target,options)}
const coldObservationOwners = new WeakMap<SessionCoordinator, { capture: ReturnType<typeof createManagedDocuments>['captureColdObservation']; binding: ReturnType<typeof createDocuments>['observations']['captureColdBindingObservation'] }>()
export function captureOriginalColdObservation(coordinator: SessionCoordinator, observation: import('./coordinator/cold-selected-target.ts').ColdSelectedObservation) {
  const original = coldObservationOwners.get(coordinator); if (!original) throw TypeError('Original cold coordinator required'); return original.capture(observation)
}
export function captureOriginalColdBindingObservation(coordinator: SessionCoordinator, cold: import('./coordinator/cold-selected-target.ts').ColdSelectedObservation, binding: import('./coordinator/types.ts').SessionBindingObservation) {
  const original = coldObservationOwners.get(coordinator); if (!original) throw TypeError('Original cold coordinator required'); original.capture(cold); return original.binding(cold.metadata, binding)
}
export function selectedSourceFor(coordinator:SessionCoordinator) {const owner=selectedSources.get(coordinator);if(!owner)throw new TypeError('Original coordinator required');return owner}
export function inspectSelectedTarget(coordinator:SessionCoordinator,target:object) {const inspect=selectedComposers.get(coordinator)?.targets.get(target);if(!inspect)throw TypeError('Original selected target required');return inspect()}
export function inspectColdSelectedTarget(coordinator:SessionCoordinator,route:import('./coordinator/selected-results-route.ts').SelectedResultsRoute) {const owner=selectedComposers.get(coordinator);if(!owner)throw TypeError('Original coordinator required');return owner.inspectCold(route)}
export async function useColdSelectedTarget<T>(coordinator:SessionCoordinator,target:object,work:(observation:import('./coordinator/cold-selected-target.ts').ColdSelectedObservation)=>Promise<T>):Promise<T> {
 const owner=selectedComposers.get(coordinator);if(!owner)throw TypeError('Original coordinator required')
 const route=owner.coldRoute(target)
 return owner.observations.withSelectedBootstrapMutation(route,()=>owner.useCold(target,work))
}
/** One trusted native factory supplies its original operation implementation once. */
export function createSelectedRuntimeCapture(coordinator:SessionCoordinator,makeOriginalOperation:(operation:ForkOperationV2,target:object)=>OriginalSelectedOperation) {
 const owner=selectedComposers.get(coordinator);if(!owner||typeof makeOriginalOperation!=='function'||utilTypes.isProxy(makeOriginalOperation))throw TypeError('Original selected construction required')
 owner.assertCapability()
 let retired=false;const holders=new Set<{close():Promise<void>}>()
 return Object.freeze({create(input:unknown){if(retired)throw Error('Selected runtime retired');const operation=readSelectedResultsOperation(input),identity=Object.freeze({}),route=captureSelectedResultsRoute({protocol:'public-results-v1',request:{invocation:operation.invocation,core:operation.prepared.core,requestIntent:operation.prepared.requestIntent}}),target=Object.freeze({}),capture=()=>original.exportOnceInCurrentUse();owner.targets.set(target,()=>owner.inspect(route,identity));let original:OriginalSelectedOperation;try{original=makeOriginalOperation(operation,target)}catch(error){owner.targets.delete(target);throw error}
  const run=(guard:()=>void)=>{const id=route.request.invocation.targetSessionId;owner.observations.assertOutsideObservedSession(id);return owner.observations.withSelectedBootstrapMutation(route,()=>{owner.prepare(route,identity,guard,capture);return owner.capture(route,identity,guard,capture)})}
  let closeFlight:Promise<void>|undefined,closed=false
  const holder=Object.freeze({first:original.first.bind(original),warm:original.warm.bind(original),passive:original.passive.bind(original),captureFirst(signal?:AbortSignal){return original.first(h=>run(h.assertCurrent),signal)},captureWarm(signal?:AbortSignal){return original.warm(h=>run(h.assertCurrent),signal)},confirmTarget(signal?:AbortSignal){return original.warm(()=>owner.observations.withSelectedBootstrapMutation(route,()=>original.confirmTarget()),signal)},confirmManagedDependencies(signal?:AbortSignal){return original.warm(()=>owner.observations.withSelectedBootstrapMutation(route,()=>original.confirmManagedDependencies()),signal)},confirmLegacyDependencies(signal?:AbortSignal){return original.warm(()=>owner.observations.withSelectedBootstrapMutation(route,()=>original.confirmLegacyDependencies()),signal)},publishWarm(signal?:AbortSignal){return original.warm(h=>owner.observations.withSelectedBootstrapMutation(route,async()=>{const target=await original.confirmTarget();if(target.kind!=='confirmed')return {kind:'blocked' as const};const managed=await original.confirmManagedDependencies();if(managed.kind!=='confirmed')return {kind:'blocked' as const};const legacy=await original.confirmLegacyDependencies();if(legacy.kind!=='confirmed')return {kind:'blocked' as const};h.assertCurrent();return owner.publish(route,identity,h.assertCurrent,original.assertTargetCurrent.bind(original),managed.closureDigest)}),signal)},reconcilePassive(){return original.passive(()=>owner.observations.withSelectedBootstrapMutation(route,async()=>{const result=await owner.reconcile(route,identity);const legacy=await original.reconcileLegacyDependencies();return legacy&&legacy.kind!=='confirmed'?{kind:'unknown' as const}:result}))},close(){original.assertOutsideUse();if(closed)return Promise.resolve();if(closeFlight)return closeFlight;original.revoke();const flight=(async()=>{await original.drain();await owner.release(route,identity);await original.close();owner.targets.delete(target);closed=true;holders.delete(holder)})();closeFlight=flight;void flight.finally(()=>{if(closeFlight===flight)closeFlight=undefined}).catch(()=>{});return flight}})
  holders.add(holder);return holder
 },async close(){retired=true;const results=await Promise.allSettled([...holders].map(holder=>holder.close())),errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'Selected operation cleanup unresolved')}})
}
export function createSessionCoordinatorCore(backend: PersistenceBackend, opts?: CoordinatorOptions, storage?: ProcessReadStorage, onConstruct?: (owners: { managed: ReturnType<typeof createManagedDocuments>; latches: ReturnType<typeof createProcessReadLatches> }) => void, taskStorage?: Omit<TaskDocumentConfiguration, 'captureParent'>, transitionStorage?: TaskTransitionConfiguration): SessionCoordinator {
  opts = opts && {...opts, originalExecutionFoldFactory: opts.originalExecutionFoldFactory}
  const assertDurableTransition = () => { if (CURRENT_FORMAT_VERSION >= 14 && !transitionStorage) throw new Error('TASK_TRANSITION_UNSUPPORTED') }
  const archiveReads = attachArchiveReadResources(backend)
  const report = opts?.reportBackgroundFailure
    ?? ((error: unknown) => { console.warn("[i-harness] background persistence failure:", error) })
  const maxDelayMs = opts?.maxDelayMs ?? 200
  const ownership = createOwnership(backend, opts)
  let managed: ReturnType<typeof createManagedDocuments>
  const processLatches = storage ? createProcessReadLatches(ownership.exclusionScope) : undefined
  const documents = createDocuments(backend, ownership, report, processLatches, taskStorage && { ...taskStorage, captureParent: document => managed.captureParent(document), captureRequiredParent:(document,source)=>managed.captureRequiredParent(document,source) }, transitionStorage)
  const observations = documents.observations
  let loads: ReturnType<typeof createLoads>
  const coldWrites = createColdExecutionWrites()
  const mutations = createMutations(backend, ownership, maxDelayMs, report, id => managed?.assertMutation(id), observations, processLatches, documents.taskTransitions, transitionStorage ? async (id, events) => { if (isTaskTransitionDrain(ownership, id)) await runTaskTransitionDrain(ownership, id, () => mutations.appendQueuedDrainUnlocked(id, events)); else await loads.transitionLoad(id, (check, markIssue) => mutations.appendTransitionUnlocked(id, events, check, markIssue), true) } : undefined, coldWrites)
  loads = createLoads(backend, ownership, mutations, processLatches, documents.taskTransitions, coldWrites, archiveReads?.withMutationRead)
  managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, report, mutations, processLatches, id => observations.assertOutsideOwnedOperations([id]), id => observations.revokeOwnedDocumentOperations(id), documents.taskTransitions, coldWrites)
  const coldFinalization=observations.createColdFinalizationFactory(managed.originalColdBootstrap)
  const lifecycle = createLifecycle(backend, ownership, mutations, documents, managed, processLatches)

  async function retire<T>(id: string, run: () => Promise<T>) {
    managed.assertOutsideCapture(id)
    observations.assertOutsideObservedSession(id)
    observations.assertOutsideOwnedOperations([id])
    observations.assertOutsideOwnedOperations([id])
    const token = processLatches?.beginMutation({ sessionIds: [id], documentKeys: [], kind: 'other' })
    let outcome: 'settled' | 'unknown' = 'unknown'
    try {
      const admission = observations.beginRetirement(id)
      try { await admission.join(); const result = await run(); outcome = 'settled'; return result } finally { admission.finish() }
    } catch (error) { outcome = 'unknown'; throw error } finally { token?.end(outcome) }
  }
  function trackBootstrap(input: unknown, wrapped: boolean, run: () => Promise<BootstrapOutcome>) {
    let invocation: BootstrapInvocation
    try {
      if (input && typeof input === 'object' && utilTypes.isProxy(input)) return run()
      const value = wrapped && input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'invocation')?.value : input
      invocation = captureBootstrapInvocation(value)
    } catch { return run() }
    observations.assertOutsideOwnedOperations([invocation.targetSessionId])
    return managed.trackBootstrapInvocation(invocation, run)
  }
  const coordinator: SessionCoordinator = {
    ...(ownership.lockEnabled && backend.readDocumentObserved && (process.platform === 'win32' || process.platform === 'linux') ? { withSessionBindingObservation: observations.withSessionBindingObservation, withExistingSessionBindingObservation: observations.withExistingSessionBindingObservation, retainExistingSessionBindingObservation: observations.retainExistingSessionBindingObservation } : {}),
    bootstrapSemanticTarget(request, guards) { if(CURRENT_FORMAT_VERSION>=14&&!transitionStorage)return Promise.resolve({kind:'not-issued',reason:'unsupported'}); if(managed.captureSelfConflict(request,true))return Promise.resolve({kind:'refused',reason:'conflict'}); return trackBootstrap(request,true,()=>observations.withBootstrapRequest(request, guards, (captured, capturedGuards) => managed.bootstrapSemanticTarget(captured, capturedGuards))) },
    resumeSemanticTarget(invocation, guards, originalPayload) { if(CURRENT_FORMAT_VERSION>=14&&!transitionStorage)return Promise.resolve({kind:'not-issued',reason:'unsupported'}); if(managed.captureSelfConflict(invocation))return Promise.resolve({kind:'refused',reason:'conflict'}); return trackBootstrap(invocation,false,()=>observations.withBootstrapResume(invocation, guards, originalPayload, (captured, capturedGuards, payload) => managed.resumeSemanticTarget(captured, capturedGuards, payload))) },
    ...(managed.captureSupported()?{
      inspectBootstrapCapture:managed.inspectBootstrapCapture,
      bootstrapSemanticTargetWithCapture(request:import('./coordinator/bootstrap-types.ts').BootstrapCaptureRequest,guards:import('./coordinator/bootstrap-types.ts').BootstrapGuards,capture:()=>Promise<import('./coordinator/bootstrap-types.ts').BootstrapRequest>){
        if(CURRENT_FORMAT_VERSION>=14&&!transitionStorage)return Promise.resolve<import('./coordinator/bootstrap-types.ts').BootstrapOutcome>({kind:'not-issued',reason:'unsupported'})
        if(managed.captureSelfConflict(request,true))return Promise.resolve<import('./coordinator/bootstrap-types.ts').BootstrapOutcome>({kind:'refused',reason:'conflict'})
        return trackBootstrap(request,true,()=>observations.withBootstrapCapture(request,guards,capture,managed.bootstrapSemanticTargetWithCapture))
      },
    }:{}),
    ...(managed.childSupported()?{
      inspectChildBootstrapCapture:managed.inspectChildBootstrapCapture,
      inspectChildBootstrap:managed.inspectChildBootstrap,
      bootstrapChildTargetWithCapture(request:import('./coordinator/child-bootstrap-intent.ts').ChildBootstrapCaptureRequest,guards:import('./coordinator/bootstrap-types.ts').BootstrapGuards,capture:()=>Promise<import('./coordinator/bootstrap-types.ts').BootstrapRequest>){
        if(CURRENT_FORMAT_VERSION>=14&&!transitionStorage)return Promise.resolve<import('./coordinator/bootstrap-types.ts').BootstrapOutcome>({kind:'not-issued',reason:'unsupported'})
        if(managed.captureSelfConflict(request,true))return Promise.resolve<import('./coordinator/bootstrap-types.ts').BootstrapOutcome>({kind:'refused',reason:'conflict'})
        return trackBootstrap(request,true,()=>observations.withChildBootstrapCapture(request,guards,capture,managed.bootstrapChildTargetWithCapture))
      },
      resumeChildTarget(request:import('./coordinator/child-bootstrap-intent.ts').ChildBootstrapCaptureRequest,guards:import('./coordinator/bootstrap-types.ts').BootstrapGuards,payload?:import('./coordinator/bootstrap-types.ts').BootstrapRequest){
        if(CURRENT_FORMAT_VERSION>=14&&!transitionStorage)return Promise.resolve<import('./coordinator/bootstrap-types.ts').BootstrapOutcome>({kind:'not-issued',reason:'unsupported'})
        if(managed.captureSelfConflict(request,true))return Promise.resolve<import('./coordinator/bootstrap-types.ts').BootstrapOutcome>({kind:'refused',reason:'conflict'})
        return trackBootstrap(request,true,()=>observations.withChildBootstrapResume(request,guards,payload,managed.resumeChildTarget))
      },
    }:{}),    inspectBootstrap: managed.inspectBootstrap,
    ...(backend.storageRoot === undefined ? {} : { storageRoot: backend.storageRoot }),
    async openManagedDocument(sessionId) { assertDurableTransition(); managed.assertOutsideCapture(sessionId); observations.assertOutsideObservedSession(sessionId); observations.assertManagedSessionAdmission(sessionId); return managed.open(sessionId) },
    revokeManagedDocumentNewWork: managed.revoke,
    closeManagedDocument(sessionId) { return retire(sessionId, () => managed.closeOne(sessionId)) },
    ...(backend.deletionReceipt ? { deletionReceipt: (sessionId: string) => backend.deletionReceipt!(sessionId) } : {}),
    ...(backend.deleteOwnedSession ? {
      async deleteOwnedSession(sessionId:string,manifest:import('./coordinator/types.ts').SessionArtifactManifest){
        managed.assertOutsideCapture(sessionId)
        return lifecycle.deleteOwnedSession(sessionId,manifest)
      },onDocumentDeleted:lifecycle.onDocumentDeleted,
    }:{}),
    ensureWritableFormat: transitionStorage ? async id => { const { session } = await loads.loadOwned(id); return { formatVersion: session.formatVersion } } : async id => { assertDurableTransition(); return mutations.ensureWritableFormat(id) },
    async create(meta) { assertDurableTransition(); return mutations.create(meta) },
    append(sessionId, events) {
      try { assertDurableTransition() } catch(error) { return Promise.reject(error) }
      if (managed.has(sessionId)) return Promise.reject(new Error('Managed document requires fact admission'))
      if (!transitionStorage) return mutations.append(sessionId, events)
      let captured: typeof events; try { captured = captureTaskSnapshot(events) as typeof events } catch (error) { return Promise.reject(error) }
      return loads.transitionLoad(sessionId, (check, markIssue) => mutations.appendTransitionUnlocked(sessionId, captured, check, markIssue)).then(() => {})
    },
    enqueue(sessionId, events) {
      assertDurableTransition()
      if (managed.has(sessionId)) throw new Error('Managed document requires fact admission')
      mutations.enqueue(sessionId, events)
    },
    async snapshot(sessionId) { archiveReads?.assertPublicReadAdmission(); const session = await managed.snapshot(sessionId); const candidate = session ? { session } : await loads.snapshot(sessionId); archiveReads?.assertPublicReadAdmission(); return candidate },
    async load(sessionId) { archiveReads?.assertPublicReadAdmission(); assertDurableTransition(); observations.assertOutsideObservedSession(sessionId); const session = await managed.snapshot(sessionId); const candidate = session ? { session } : await loads.load(sessionId); archiveReads?.assertPublicReadAdmission(); return candidate },
    async loadOwned(sessionId) { assertDurableTransition(); observations.assertOutsideObservedSession(sessionId); observations.assertManagedSessionAdmission(sessionId); const session = await managed.snapshot(sessionId); return session ? { session } : loads.loadOwned(sessionId) },
    async list() { return backend.list() },
    async profile(sessionId) { observations.assertOutsideObservedSession(sessionId); return backend.profile(sessionId) },
    updateMeta: async (id,patch) => {
      assertDurableTransition()
      managed.assertOutsideCapture(id);observations.assertOutsideObservedSession(id);observations.assertOutsideOwnedOperations([id]);observations.assertSessionAdmission(id);managed.assertMutation(id)
      if(typeof id!=='string'||!patch||typeof patch!=='object'||utilTypes.isProxy(patch))throw TypeError('Invalid metadata update')
      const taskMetadata=managed.beginTaskMetadataUpdate(id);let succeeded=false
      try {
        managed.invalidateMetadataWitness(id)
        if(!transitionStorage)return await mutations.updateMeta(id,patch)
        let updated: Awaited<ReturnType<typeof mutations.updateMetaTransitionUnlocked>> | undefined
        await loads.transitionLoad(id, async (_check, markIssue) => { updated = await mutations.updateMetaTransitionUnlocked(id, patch, markIssue,taskMetadata) })
        succeeded=true;return updated!
      } finally { taskMetadata?.finish(succeeded) }
    },
    async flush(id) { observations.assertOutsideOwnedOperations([id]); await mutations.flush(id); await documents.joinTaskDocumentIO() },
    async close() {
      const operation = createRetainedCleanupOperation()
      try { await closeWithRetained(operation) } finally { finishRetainedCleanupOperation(operation) }
    },
    putDocument: documents.putDocument,
    putDocumentStrict: documents.putDocumentStrict,
    getDocument: documents.getDocument,
    ownerOf: ownership.ownerOf,
    hasLiveOwnership: ownership.hasLiveOwnership,
    adoptOwnership: transitionStorage ? async id => { await loads.loadOwned(id) } : async id => { assertDurableTransition(); return mutations.adoptOwnership(id) },
    releaseOwnership(sessionId) { return retire(sessionId, async () => { await managed.closeOne(sessionId); await mutations.releaseOwnership(sessionId) }) },
  }
  async function closeWithRetained(operation: RetainedCleanupOperation) {
      managed.assertOutsideCapture()
      assertOutsideForkController(coordinator)
      observations.assertOutsideOwnedOperations([], [], true)
      observations.preflightClose()
      assertOutsideRetirementSink(coordinator)
      archiveReads?.fence()
      const join = observations.closeAdmission(operation)
      processLatches?.closeAdmission()
      const joinCapture = managed.closeCaptureAdmission()
      const joinFork = closeForkControllerAdmission(coordinator)
      const errors: unknown[] = []
      const joined=await Promise.allSettled([join(),joinCapture(),joinFork().then(() => managed.close())])
      for(const result of joined)if(result.status==='rejected')errors.push(result.reason)
      // Dependent original leases survive unresolved observation/managed work.
      if (errors.length === 0) await lifecycle.close(true, archiveReads?.settle)
      else {
        try { await lifecycle.close(false, archiveReads?.settle) } catch (error) { errors.push(error) }
        throw new AggregateError(errors, 'Coordinator cleanup is unresolved')
      }
  }
  associateRestoredContextAcquisition(coordinator,{acquire:id=>managed.acquireRestoredContext(id),assertAdmission(id){assertDurableTransition();managed.assertOutsideCapture(id);observations.assertOutsideObservedSession(id);observations.assertManagedSessionAdmission(id);archiveReads?.assertPublicReadAdmission()}})
  associateManagedExecution(coordinator,{acquire:id=>managed.acquireExecution(id),assertAdmission(id){assertDurableTransition();managed.assertOutsideCapture(id);observations.assertOutsideObservedSession(id);observations.assertManagedSessionAdmission(id);archiveReads?.assertPublicReadAdmission()}})
  associateRetainedCoordinatorClose(coordinator, closeWithRetained)
  associateOriginalResultOrdering(coordinator, ownership)
  if (ownership.lockEnabled) associateOriginalResultRevocation(coordinator, observations.createResultRevocationAdmission(ownership), ownership)
  if (ownership.lockEnabled) associateProjectBindingWrites(coordinator, documents)
  coldObservationOwners.set(coordinator, { capture: managed.captureColdObservation, binding: observations.captureColdBindingObservation })
  if (backend.deleteOwnedSession) associateDeletionPreparation(coordinator, lifecycle)
  associateColdExecutionWrites(coordinator, coldWrites)
  observations.associateRetainedCoordinator(coordinator)
  associateObservationCleanupOwner(coordinator, observations.cleanupForError)
  if (documents.taskOperations) associateTaskDocumentOperations(coordinator, documents.taskOperations)
  if (documents.taskTransitions) associateTaskDocumentTransitions(coordinator, documents.taskTransitions)
  selectedSources.set(coordinator,Object.freeze({acquire:observations.acquireSelectedBindingRead,cleanupForError:observations.cleanupForError,retainTask(owner,view,onRevoke){return retainTaskSourceRead(owner,view,ownership,onRevoke)},retainManagedTask(domain,history,onRevoke){return retainManagedTaskSourceRead(domain,history,ownership,onRevoke)},retain(document,onRevoke){return retainSelectedSourceRead(document,ownership,onRevoke)}}))
  selectedComposers.set(coordinator,{beginCold:(target,options)=>coldFinalization.begin(target,options),assertCapability:assertDurableTransition,capture:managed.captureSelected,prepare(...args){assertDurableTransition();return managed.prepareSelectedCapture(...args)},reconcile:managed.reconcileSelected,inspect:managed.inspectSelected,inspectCold(input){const route=captureSelectedResultsRoute(input);managed.assertColdInspectionAdmission(route.request.invocation.targetSessionId);assertDurableTransition();return observations.withSelectedBootstrapMutation(route,()=>managed.inspectColdSelected(route))},coldRoute:managed.coldSelectedRoute,useCold:managed.useColdSelected,publish:managed.publishSelected,release:managed.releaseSelected,observations,targets:new WeakMap()})
  if (processLatches) onConstruct?.({ managed, latches: processLatches })
  return coordinator
}
