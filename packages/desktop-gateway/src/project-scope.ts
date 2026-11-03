import { createHash } from "node:crypto"
import { AsyncLocalStorage } from 'node:async_hooks'
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { SessionCoordinator, SessionMeta, ExistingSessionBindingObservation, SessionBindingObservation } from "@i-harness/session-persistence"
import { captureBootstrapTargetPreparationRequest, type BootstrapTargetPreparationRequest, type BootstrapTargetPreparationOutcome } from '@i-harness/session-persistence'
import { isStrictFactData, canonicalJsonData, captureSelectedResultsBootstrapPreparationFacts, type BootstrapPreparationFactsV2 } from '@i-harness/core-session'
import type { SessionProjectContext } from "@i-harness/session-executor"
import type { AuthorityState } from "@i-harness/sandbox"
import { createSessionManagementFence, type SessionManagementFence } from "./session-management-fence.ts"
import { captureBootstrapProject, captureSelectedProject as importSelectedProject, type BootstrapProjectCapture, type BootstrapProjectPreparation, type BootstrapTargetScope } from './bootstrap-project.ts'
import {captureTaskChildProject,type TaskChildProjectCapture} from './bootstrap-project.ts'
import { inspectSelectedTarget, captureOriginalColdObservation, captureOriginalColdBindingObservation, type ColdSelectedObservation } from '@i-harness/session-persistence/internal/selected-source-owner'
import { requestRetainedReferenceRetirementFor, runRetainedRetirementSink, assertOutsideRetirementSink, joinRetainedRetirementSinks, assertRetainedBindingReferenceFor, preflightRetainedBindingReleaseFor, observeRetainedBindingRetirementFor, createRetainedCleanupOperation, finishRetainedCleanupOperation, type RetainedExistingBinding, type RetainedCleanupOperation } from '@i-harness/session-persistence/internal/retained-inspection'
import { isConversationMetadata } from './session-visibility.ts'
import { projectBindingWritesFor } from '@i-harness/session-persistence/internal/project-binding-write'
import type { BindingObservations } from '../../session-persistence/src/coordinator/binding-observation.ts'
export type { BootstrapProjectCapture, BootstrapProjectPreparation, BootstrapTargetScope } from './bootstrap-project.ts'
export interface ProjectMoveOptions { assertIdle?(id: string): Promise<void>; drainSession?(id: string): Promise<void>; authorityChanged?(ids: readonly string[]): Promise<void>; fence?: SessionManagementFence }
export interface ColdTargetPolicy {
  qualify(): Promise<void>; sealWhileActive(): void; settle(): Promise<void>; assertSettledCurrent(): void
  targetScope(): BootstrapTargetScope; revoke(): void; close(): Promise<void>
}

interface Binding { bound: boolean; projectId?: string }
interface ConfirmedProjectScope { id: string; name: string; roots: string[]; primaryRoot?: string; unavailableReason?: string }
class ProjectFoldersUnavailable extends Error {}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid project or session ID")
  return value
}
async function directory(value: unknown, field: string): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`Project ${field} must be absolute directory paths`)
  try {
    const path = await realpath(value)
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory")
    return path
  } catch { throw new ProjectFoldersUnavailable(`Project ${field} must refer to an existing directory`) }
}

/** Session documents identify owners; only this process's main-confirmed
 * catalog supplies roots. Reopening a session never restores saved authority. */
export function createProjectScopeBroker(coordinator: SessionCoordinator, _workspace: string, visible: (id: string, meta: SessionMeta) => Promise<boolean> = async () => true, moveOptions: ProjectMoveOptions = {}) {
  const fence = moveOptions.fence ?? createSessionManagementFence()
  fence.associateRetainedDomain(coordinator)
  const projects = new Map<string, ConfirmedProjectScope>()
  const bindings = new Map<string, Binding>()
  const parents = new Map<string, string>()
  const loading = new Map<string, Promise<Binding>>()
  const operations = new Map<string, Promise<unknown>>()
  type BindingObservation = { ids: Set<string>; observation: ExistingSessionBindingObservation; assertCurrent(): void }
  const bindingObservations = new AsyncLocalStorage<readonly BindingObservation[]>()
  function currentObservation(id: string): BindingObservation | undefined {
    const captured = bindingObservations.getStore()?.findLast(scope => scope.ids.has(id))
    captured?.assertCurrent()
    return captured
  }
  const revisions = new Map<string, number>()
  const bindingRevisions = new Map<string, number>()
  let referenceRevision = 0
  let references: readonly string[] = []
  let referenceFailure: string | undefined
  const observed = new Set<string>()
  const pendingChanges = new Set<string>()
  const scopeUpdates = new Map<string, number>()
  type RetainedSource = { ids:Set<string>;revoke():void; preflight?():void }
  const retainedSources = new Set<RetainedSource>()
  const invalidateRetained = (ids?:readonly string[], except?: RetainedSource) => { for (const source of [...retainedSources]) if(source!==except&&(!ids||ids.some(id=>source.ids.has(id))))source.revoke() }
  const coldPolicyUse = new AsyncLocalStorage<{ identity: object; active: boolean }>()
  const coldPolicySeals = new WeakMap<object, object>()
  const policyAdmissions = new Map<string, object>()
  let globalPolicyAdmission = {}
  let referenceUpdates = 0
  function trackScopes<T>(ids: readonly string[], job: Promise<T>): Promise<T> {
    invalidateRetained()
    for (const id of ids) scopeUpdates.set(id, (scopeUpdates.get(id) ?? 0) + 1)
    return job.finally(() => { for (const id of ids) { const count = scopeUpdates.get(id)! - 1; if (count) scopeUpdates.set(id, count); else scopeUpdates.delete(id) } })
  }
  const withdrawn = new Set<string>()
  const requests = new Map<string, number>()
  const nextRequest = (id: string) => { const next = (requests.get(id) ?? 0) + 1; requests.set(id, next); return next }
  let closed = false
  let closing: Promise<void> | undefined
  const assertOpen = () => { if (closed) throw new Error("Project scope broker is closed") }
  let inspectorCount = 0
  let globalInspectorAdmissions = 0
  const pendingInspectorIds = new Map<string, number>()
  const inspectorPending = (id: string) => globalInspectorAdmissions > 0 || pendingInspectorIds.has(id)
  type Inspector = { id: string; preflight(): void; retire(operation: RetainedCleanupOperation): Promise<void> }
  const inspectors = new Set<Inspector>()
  type BrokerCleanup = { operation: RetainedCleanupOperation; active: boolean }
  const brokerOperation = new AsyncLocalStorage<BrokerCleanup>()
  function preflightInspectors(ids?: readonly string[], except?: RetainedSource) { for (const inspector of inspectors) if (!ids || ids.includes(inspector.id)) inspector.preflight(); for (const source of retainedSources) if (source !== except && (!ids || ids.some(id=>source.ids.has(id)))) source.preflight?.() }
  async function joinInspectorCleanup(jobs: readonly Promise<void>[]) {
    const results = await Promise.allSettled(jobs)
    const errors = [...new Set(results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))]
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Execution observation cleanup failed')
  }
  function retireInspectors(operation: RetainedCleanupOperation, ids?: readonly string[]) {
    return [...inspectors].filter(inspector => !ids || ids.includes(inspector.id)).map(inspector => inspector.retire(operation))
  }
  function invalidateInspectors(ids?: readonly string[], except?: RetainedSource) {
    const context = brokerOperation.getStore()
    const operation = context?.active ? context.operation : undefined
    if (operation) { void joinInspectorCleanup(retireInspectors(operation, ids)).catch(() => {}); return }
    preflightInspectors(ids, except)
    const own = createRetainedCleanupOperation()
    void joinInspectorCleanup(retireInspectors(own, ids)).finally(() => finishRetainedCleanupOperation(own)).catch(() => {})
  }
  let catalogPending = 0
  let catalogTail: Promise<unknown> = Promise.resolve()
  function catalog<T>(work: () => Promise<T>): Promise<T> {
    globalPolicyAdmission = {}
    catalogPending++
    const job = catalogTail.catch(() => undefined).then(() => { assertOpen(); return work() })
    catalogTail = job
    return job.finally(() => { catalogPending-- })
  }
  const key = (id: string) => `desktop-session-project-${createHash("sha256").update(id).digest("hex")}`
  async function ensureVisible(id: string): Promise<SessionMeta> {
    assertOpen()
    identifier(id)
    const captured = currentObservation(id)
    const meta = captured ? captured.observation.metadata(id) : (await coordinator.profile(id)).meta
    if (!await visible(id, meta)) throw new Error("Session is unavailable")
    captured?.assertCurrent()
    return meta
  }
  function load(id: string): Promise<Binding> {
    const captured = currentObservation(id)
    if (captured) {
      const document = captured.observation.binding(id)
      return Promise.resolve(parseBinding(document.kind === 'present' ? document.value : undefined))
    }
    const saved = bindings.get(id)
    if (saved) return Promise.resolve(saved)
    const pending = loading.get(id)
    if (pending) return pending
    const job = coordinator.getDocument(key(id)).then((document): Binding => {
      const value = parseBinding(document)
      bindings.set(id, value)
      return value
    }).finally(() => { loading.delete(id) })
    loading.set(id, job)
    return job
  }
  function parseBinding(document: unknown): Binding {
    if (document === undefined) return { bound: false }
    if (!object(document) || !isStrictFactData(document) || document.version !== 1
      || Object.getOwnPropertyNames(document).some(field => !['version', 'projectId'].includes(field))
      || Object.values(Object.getOwnPropertyDescriptors(document)).some(field => !field.enumerable || field.value === undefined)) throw new Error('Invalid session project binding')
    return { bound: true, ...(Object.hasOwn(document, 'projectId') ? { projectId: identifier(document.projectId) } : {}) }
  }
  function observeBinding(id: string, value: Binding, except?: RetainedSource) {
    if (canonicalJsonData(bindings.get(id)) !== canonicalJsonData(value)) { invalidateInspectors([id], except); invalidateRetained([id], except); bindingRevisions.set(id, (bindingRevisions.get(id) ?? 0) + 1) }
    bindings.set(id, value)
  }
  function serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    preflightInspectors([id]); policyAdmissions.set(id, {})
    invalidateRetained([id])
    const job = (operations.get(id) ?? Promise.resolve()).catch(() => undefined).then(work)
    operations.set(id, job)
    void job.finally(() => { if (operations.get(id) === job) operations.delete(id) }).catch(() => undefined)
    return job
  }
  async function save(id: string, projectId?: string): Promise<void> {
    assertOpen()
    bindingRevisions.set(id, (bindingRevisions.get(id) ?? 0) + 1)
    const document = { version: 1, ...(projectId ? { projectId } : {}) }
    const original = projectBindingWritesFor(coordinator)
    if (original) {
      const confirmed = parseBinding(await original.write(id, document))
      if (!confirmed.bound || confirmed.projectId !== projectId) throw new Error('Could not persist session project binding')
      bindings.set(id, confirmed); return
    }
    await coordinator.putDocument(key(id), document)
    // Coordinator background document errors are reported rather than thrown.
    // Readback is the commit check before exposing or acknowledging ownership.
    const saved = await coordinator.getDocument(key(id))
    const confirmed = parseBinding(saved)
    if (!confirmed.bound || confirmed.projectId !== projectId) throw new Error("Could not persist session project binding")
    bindings.set(id, { bound: true, ...(projectId ? { projectId } : {}) })
  }
  async function resolveOwner(id: string, ownedOperation?: string, reading = false): Promise<Binding> {
    const captured = currentObservation(id)
    const chain: string[] = []
    const visited = new Set<string>()
    let cursor = id
    for (;;) {
      if (visited.has(cursor) || chain.length >= 32) throw new Error("Invalid or excessive session project lineage")
      if (captured && !captured.ids.has(cursor)) throw new Error('Complete project lineage is not held by this observation')
      visited.add(cursor); chain.push(cursor)
      const meta = await ensureVisible(cursor)
      if (reading && meta.archived) throw new Error('Result source session archived')
      if ((await load(cursor)).bound) break
      if (!meta.parentSession || (meta.origin !== "subagent" && meta.origin !== "team")) { parents.delete(cursor); break }
      const parent = identifier(meta.parentSession)
      parents.set(cursor, parent)
      cursor = parent
    }
    // Validate the complete chain before waiting: cyclic metadata must not
    // cause two pending binds to wait on each other indefinitely.
    if (captured) captured.assertCurrent()
    else await Promise.all(chain.filter((sessionId) => sessionId !== ownedOperation).map((sessionId) => operations.get(sessionId)))
    return chain.map((sessionId) => bindings.get(sessionId)).find((binding) => binding?.bound) ?? { bound: false }
  }
  function liveOwner(id: string): string | undefined {
    const visited = new Set<string>()
    let cursor: string | undefined = id
    while (cursor) {
      if (visited.has(cursor) || visited.size >= 32) return undefined
      visited.add(cursor)
      const own = bindings.get(cursor)
      if (own?.bound) return own.projectId
      cursor = parents.get(cursor)
    }
    return undefined
  }
  async function projectFor(id: string): Promise<string | undefined> {
    return (await resolveOwner(id)).projectId
  }
  async function observedResultGetter(id:string,captured:BindingObservation) {
    await resolveOwner(id,undefined,true);captured.assertCurrent();observed.add(id)
    const get=()=>{captured.assertCurrent();const projectId=liveOwner(id),context=projectId?projects.get(projectId):undefined;return {...(projectId?{projectId}:{}),...(context?{scope:{id:context.id,name:context.name,primaryRoot:context.primaryRoot!,roots:[...context.roots]}}:{}),revision:`${authority(id).revision}:binding:${bindingRevisions.get(id)??0}`}}
    get();return get
  }
  function scopeSchema(value: unknown): ConfirmedProjectScope {
    if (!object(value)) throw new Error("Invalid project scope")
    const id = identifier(value.id)
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 256 || /[\u0000-\u001f\u007f]/.test(value.name)) throw new Error("Invalid project name")
    if (!Array.isArray(value.roots) || value.roots.length > 100) throw new Error("Project roots must contain existing absolute directories")
    if (value.roots.length === 0) {
      if (value.primaryRoot !== undefined) throw new Error("An empty project cannot have a primary root")
      return { id, name: value.name.trim(), roots: [] }
    }
    if (value.roots.some((root) => typeof root !== "string" || !isAbsolute(root))) throw new Error("Project roots must be absolute directory paths")
    const roots = value.roots as string[]
    if (new Set(roots.map((root) => pathKey(resolve(root)))).size !== roots.length) throw new Error("Project roots contain duplicate directories")
    if (typeof value.primaryRoot !== "string" || !isAbsolute(value.primaryRoot)
      || !roots.some((root) => pathKey(resolve(root)) === pathKey(resolve(value.primaryRoot as string)))) throw new Error("Project primary root must be an absolute project member")
    return { id, name: value.name.trim(), roots: [...roots], primaryRoot: value.primaryRoot }
  }
  async function resolveScope(scope: ConfirmedProjectScope): Promise<ConfirmedProjectScope> {
    if (scope.roots.length === 0) return scope
    const roots = await Promise.all(scope.roots.map((root) => directory(root, "roots")))
    if (new Set(roots.map(pathKey)).size !== roots.length) throw new Error("Project roots contain duplicate directories")
    const primaryIndex = scope.roots.findIndex((root) => pathKey(resolve(root)) === pathKey(resolve(scope.primaryRoot!)))
    return { ...scope, roots, primaryRoot: roots[primaryIndex]! }
  }
  function blocked(scope: ConfirmedProjectScope): ConfirmedProjectScope {
    return { id: scope.id, name: scope.name, roots: [], unavailableReason: "Project folders are unavailable" }
  }
  function assertAvailable(projectId?: string): void {
    const context = projectId ? projects.get(projectId) : undefined
    if (projectId && (!context || withdrawn.has(projectId))) throw new Error("Project authority revoked: catalog entry missing")
    if (context?.unavailableReason) throw new Error(context.unavailableReason)
    if (context && (context.roots.length === 0 || context.primaryRoot === undefined)) throw new Error("Project has no workspace folders")
  }
  function authority(id: string): AuthorityState {
    const projectId = liveOwner(id)
    const revision = `${projectId ?? "unbound"}:${revisions.get(projectId ?? "") ?? 0}:refs:${referenceRevision}`
    if (closed) return { kind: "unavailable", revision, reason: "Project scope service closed" }
    if (referenceFailure) return { kind: "unavailable", revision, reason: referenceFailure }
    if (!bindings.has(id)) return { kind: "unavailable", revision, reason: "Session authority not loaded" }
    if (!projectId) return { kind: "unbound", revision, workspaceRoot: _workspace, references: [...references] }
    const scope = projects.get(projectId)
    if (!scope || withdrawn.has(projectId)) return { kind: "revoked", revision, reason: "Project authority revoked: catalog entry missing" }
    if (scope.unavailableReason || !scope.primaryRoot || !scope.roots.length) return { kind: "unavailable", revision, reason: scope.unavailableReason ?? "Project has no workspace folders" }
    return { kind: "bound", revision, primaryRoot: scope.primaryRoot, roots: [...scope.roots], references: [...references] }
  }
  async function changed(projectIds: readonly string[], publish = true): Promise<void> {
    if(projectIds.length)invalidateRetained()
    for (const id of projectIds) {
      if (publish) revisions.set(id, (revisions.get(id) ?? 0) + 1)
      pendingChanges.add(id)
    }
    const ids = [...observed].filter(id => projectIds.includes(liveOwner(id) ?? ""))
    if (ids.length) await moveOptions.authorityChanged?.(ids)
    for (const id of projectIds) pendingChanges.delete(id)
  }
  function prepareProject(capture: Pick<BootstrapProjectCapture,'invocation'|'sourceSessionId'|'sourceAvailable'|'assertNewWorkCurrent'|'targetAvailable'> & {requestIntent:{project:BootstrapProjectCapture['requestIntent']['project']}}, inspect:()=>Promise<{invocation:BootstrapProjectCapture['invocation'];manifestDigest:string}|undefined>,coherent=false):BootstrapProjectPreparation {
      const id = capture.invocation.targetSessionId
      const projectId = capture.requestIntent.project.kind === 'project' ? capture.requestIntent.project.projectId : undefined
      let active = true, targetBaseline: string | undefined, sourceBaseline: string | undefined, attemptEpoch: string | undefined
      const fail = (reason: 'unknown'|'unavailable'|'conflict'|'policy'): never => { throw Object.assign(new Error('Bootstrap project ' + reason), { bootstrapReason: reason }) }
      const lifetime = () => { assertOpen(); if (!active || !capture.targetAvailable()) { active = false; fail('unavailable') } }
      const epoch = () => `${projectId ?? 'unassigned'}:${revisions.get(projectId ?? '') ?? 0}:refs:${referenceRevision}`
      const available = () => {
        lifetime()
        if (attemptEpoch !== undefined && attemptEpoch !== epoch()) { active = false; fail('policy') }
        if (referenceFailure || referenceUpdates || scopeUpdates.has(projectId ?? '') || pendingChanges.has(projectId ?? '')) fail('policy')
        assertAvailable(projectId)
      }
      const targetRevision = () => `${epoch()}:binding:${bindingRevisions.get(id) ?? 0}`
      const assertTargetCurrent = () => {
        available()
        if (!bindings.get(id)?.bound || bindings.get(id)?.projectId !== projectId || targetBaseline === undefined || targetBaseline !== targetRevision()) fail('policy')
      }
      const sourceRevision = () => {
        if (!capture.sourceSessionId) return epoch() + ':explicit-import'
        const chain: string[] = [], seen = new Set<string>()
        let cursor: string | undefined = capture.sourceSessionId
        while (cursor) {
          if (seen.has(cursor) || seen.size >= 32 || !bindings.has(cursor)) fail('policy')
          seen.add(cursor); chain.push(`${cursor}:${bindingRevisions.get(cursor) ?? 0}:${canonicalJsonData(bindings.get(cursor))}`)
          if (bindings.get(cursor)?.bound) break
          cursor = parents.get(cursor)
        }
        if (liveOwner(capture.sourceSessionId) !== projectId) fail('policy')
        return epoch() + ':' + canonicalJsonData(chain)
      }
      const newWork = (current: () => boolean) => {
        available()
        if (!capture.sourceAvailable() || !current()) fail('policy')
        capture.assertNewWorkCurrent()
      }
      const assertSourceCurrent = () => {
        newWork(() => true)
        if (sourceBaseline === undefined || sourceBaseline !== sourceRevision()) fail('policy')
      }
      async function readTargetBinding(): Promise<Binding> {
        try { return parseBinding(await coordinator.getDocument(key(id))) }
        catch (error) {
          // A previously acquired getter cannot survive an observation that
          // its durable authority is no longer verifiable. Initial uncertain
          // saves remain recoverable by exact passive readback.
          if (targetBaseline !== undefined) active = false
          throw error
        }
      }
      async function prepare(value: BootstrapTargetPreparationRequest, passive: boolean, current: () => boolean): Promise<BootstrapTargetPreparationOutcome> {
        let request: BootstrapTargetPreparationRequest
        try {
          request = captureBootstrapTargetPreparationRequest(value)
          if (canonicalJsonData(request.invocation) !== canonicalJsonData(capture.invocation)) return { kind: 'blocked', reason: 'conflict' }
        } catch { return { kind: 'blocked', reason: 'conflict' } }
        return serial(id, async () => {
          try {
            available()
            attemptEpoch ??= epoch()
            if (targetBaseline !== undefined) assertTargetCurrent()
            const generation = epoch()
            const check = () => { available(); if (generation !== epoch()) fail('policy'); if (!passive) { newWork(current); if (sourceBaseline !== undefined && sourceBaseline !== sourceRevision()) fail('policy') } }
            check()
            const inspection = await inspect()
            check()
            if (!inspection || inspection.manifestDigest !== request.manifestDigest
              || canonicalJsonData(inspection.invocation) !== canonicalJsonData(capture.invocation)) fail('conflict')
            if (!passive) {
              if (capture.sourceSessionId) { await resolveOwner(capture.sourceSessionId, undefined, true); check() }
              const revision = sourceRevision()
              if (sourceBaseline !== undefined && sourceBaseline !== revision) fail('policy')
              sourceBaseline ??= revision
              assertSourceCurrent()
            }
            await loading.get(id); check()
            // Always refresh durable identity: an earlier save may have landed
            // even though its response/readback did not confirm it.
            const own = await readTargetBinding(); check()
            observeBinding(id, own)
            if (own.bound && own.projectId !== projectId) fail('conflict')
            if (!own.bound) {
              if (passive || targetBaseline !== undefined) fail('unavailable')
              check()
              bindingRevisions.set(id, (bindingRevisions.get(id) ?? 0) + 1)
              const original = projectBindingWritesFor(coordinator), value = { version: 1, ...(projectId ? { projectId } : {}) }
              if (original) await original.write(id, value)
              else await coordinator.putDocument(key(id), value)
              check()
              const saved = await readTargetBinding(); check()
              if (!saved.bound || saved.projectId !== projectId) fail('unavailable')
              observeBinding(id, saved)
            }
            observed.add(id)
            if (projectId) {
              const declared = projects.get(projectId)!
              // Do not enter catalog(): its invalidation drain may itself be
              // waiting for this admitted bootstrap to finish.
              let resolved: ConfirmedProjectScope
              try { resolved = await resolveScope(declared) }
              catch (error) { if (targetBaseline !== undefined) active = false; throw error }
              check()
              if (canonicalJsonData(resolved) !== canonicalJsonData(projects.get(projectId))) { if (targetBaseline !== undefined) active = false; fail('policy') }
            }
            check()
            targetBaseline ??= targetRevision()
            assertTargetCurrent()
            return { kind: 'confirmed' }
          } catch (error) {
            return { kind: 'blocked', reason: (error as { bootstrapReason?: 'unknown'|'unavailable'|'conflict'|'policy' }).bootstrapReason ?? 'unavailable' }
          }
        })
      }
      const snapshotTarget=():BootstrapTargetScope=>{
        const scope=projectId?projects.get(projectId)!:undefined
        return {...(projectId?{projectId}:{}),...(scope?{scope:{id:scope.id,name:scope.name,roots:[...scope.roots],primaryRoot:scope.primaryRoot!}}:{}),revision:targetBaseline!}
      }
      const base={
        targetPreparation: Object.freeze({ confirm: (request: BootstrapTargetPreparationRequest, current: () => boolean) => prepare(request, false, current), reconcile: (request: BootstrapTargetPreparationRequest) => prepare(request, true, () => true), assertTargetCurrent }),
        targetScope():BootstrapTargetScope{assertTargetCurrent();return snapshotTarget()},assertSourceCurrent,close(){active=false},
      }
      if(!coherent)return base
      return Object.freeze({...base,kind:'coherent-project-observation-v1' as const,observeCurrent(mode:'active'|'passive'){
        if(mode!=='active'&&mode!=='passive')fail('policy')
        available();const generation=epoch()
        if(mode==='active'){
          if(!capture.sourceAvailable())fail('policy')
          capture.assertNewWorkCurrent()
          if(sourceBaseline===undefined||sourceBaseline!==sourceRevision())fail('policy')
        }
        assertOpen();if(!active||!capture.targetAvailable()||generation!==epoch()||referenceFailure||referenceUpdates||scopeUpdates.has(projectId??'')||pendingChanges.has(projectId??''))fail('policy')
        assertAvailable(projectId)
        if(!bindings.get(id)?.bound||bindings.get(id)?.projectId!==projectId||targetBaseline===undefined||targetBaseline!==targetRevision())fail('policy')
        return snapshotTarget()
      }})
    }
  const broker = {
    acquireColdTargetPolicy(input: ColdSelectedObservation, inputBinding: SessionBindingObservation): ColdTargetPolicy {
      const cold = captureOriginalColdObservation(coordinator, input), binding = captureOriginalColdBindingObservation(coordinator, cold, inputBinding)
      const metadata = cold.metadata, id = identifier(metadata.sessionId), expected = cold.birth.stage.captureReservation.request.requestIntent.project
      const projectId = expected.kind === 'project' ? expected.projectId : undefined
      let revoked = false, closedPolicy = false, qualified = false, sealed = false, settled = false
      let baseline: string | undefined, target: BootstrapTargetScope | undefined
      let management: ReturnType<SessionManagementFence['captureAdmission']> | undefined
      let managementObserver: ReturnType<SessionManagementFence['observe']> | undefined
      let qualification: Promise<void> | undefined, settlement: Promise<void> | undefined, closeFlight: Promise<void> | undefined
      const originalGlobal = globalPolicyAdmission, originalAdmission = policyAdmissions.get(id)
      const identity = {}
      const preflight = () => { const use = coldPolicyUse.getStore(); if (use?.active && use.identity === identity) throw Error('Cold policy self-mutation unavailable') }
      const retained: RetainedSource = { ids: new Set([id]), revoke() { revoked = true }, preflight }
      const stamp = () => canonicalJsonData([bindings.get(id), bindingRevisions.get(id) ?? 0, parents.get(id) ?? null,
        projectId ?? null, projectId ? projects.get(projectId) : null, revisions.get(projectId ?? '') ?? 0,
        requests.get(projectId ?? '') ?? 0, referenceRevision, references, referenceFailure ?? null])
      const independent = () => {
        if (revoked || closedPolicy || coldPolicySeals.get(handle) !== identity) throw Error('Cold project policy revoked')
        try {
          assertOpen(); management?.assertCurrent()
          if (globalPolicyAdmission !== originalGlobal || policyAdmissions.get(id) !== originalAdmission || inspectorPending(id) || operations.has(id) || loading.has(id) || catalogPending || referenceFailure || referenceUpdates || scopeUpdates.has(projectId ?? '') || pendingChanges.has(projectId ?? '') || parents.has(id)) throw Error('Cold project policy changed')
          assertAvailable(projectId)
          if (baseline !== undefined && stamp() !== baseline) throw Error('Cold project policy identity changed')
        } catch (failure) { revoked = true; throw failure }
      }
      const active = () => {
        independent(); captureOriginalColdObservation(coordinator, cold); captureOriginalColdBindingObservation(coordinator, cold, binding)
        if (canonicalJsonData(binding.metadata(id)) !== canonicalJsonData(metadata)) throw Error('Cold project metadata changed')
      }
      const handle: ColdTargetPolicy = Object.freeze({
        qualify() {
          if (this !== handle) throw TypeError('Invalid cold policy receiver')
          if (qualification) return qualification
          const use = { identity, active: true }
          qualification = coldPolicyUse.run(use, async () => {
            active()
            if (metadata.formatVersion !== 14 || metadata.archived || !isConversationMetadata(metadata) || expected.kind === 'unmanaged') throw Error('Cold target project policy unavailable')
            const document = binding.binding(id)
            if (document.kind !== 'present') throw Error('Explicit cold target binding required')
            const own = parseBinding(document.value)
            if (!own.bound || own.projectId !== projectId) throw Error('Cold target project binding conflict')
            observeBinding(id, own, retained); parents.delete(id); observed.add(id)
            management = fence.captureAdmission(id)
            managementObserver = fence.observe(id, () => handle.close(), preflight, () => retained.revoke())
            baseline = stamp(); active()
            const visibleNow = await visible(id, metadata); active()
            if (!visibleNow) throw Error('Cold target session is unavailable')
            const declared = projectId ? projects.get(projectId)! : undefined
            if (declared) { const resolved = await resolveScope(declared); active(); if (canonicalJsonData(resolved) !== canonicalJsonData(declared)) throw Error('Cold target project roots changed') }
            for (const reference of references) { const current = await realpath(reference); active(); if (pathKey(current) !== pathKey(reference)) throw Error('Cold target reference changed') }
            active()
            const scope = declared && Object.freeze({ id: declared.id, name: declared.name, primaryRoot: declared.primaryRoot!, roots: Object.freeze([...declared.roots]) as unknown as string[] })
            target = Object.freeze({ ...(projectId ? { projectId } : {}), ...(scope ? { scope } : {}), revision: baseline! })
            qualified = true
          }).catch(failure => { revoked = true; throw failure }).finally(() => { use.active = false })
          void qualification.catch(() => {}); return qualification
        },
        sealWhileActive() { if (this !== handle || !qualified || !target) throw Error('Cold target policy unverified'); active(); sealed = true },
        settle() {
          if (this !== handle) throw TypeError('Invalid cold policy receiver')
          preflight(); if (settlement) return settlement
          const flight = (async () => { if (!qualification) throw Error('Cold policy unused'); await qualification; if (!sealed) throw Error('Cold policy unsealed'); independent(); managementObserver?.release(); managementObserver = undefined; settled = true; retainedSources.delete(retained) })()
          settlement = flight; void flight.finally(() => { if (settlement === flight) settlement = undefined }).catch(() => {}); return flight
        },
        assertSettledCurrent() { if (this !== handle || !qualified || !sealed || !settled || settlement || closeFlight) throw Error('Cold policy unsettled'); independent() },
        targetScope() { if (this !== handle || !qualified || !target) throw Error('Cold target policy unavailable'); if (sealed) independent(); else active(); return target },
        revoke() { if (this !== handle) throw TypeError('Invalid cold policy receiver'); retained.revoke() },
        close() {
          if (this !== handle) throw TypeError('Invalid cold policy receiver')
          preflight(); if (closedPolicy) return Promise.resolve(); if (closeFlight) return closeFlight
          retained.revoke()
          const flight = (async () => { await qualification?.catch(() => {}); await settlement?.catch(() => {}); managementObserver?.release(); managementObserver = undefined; closedPolicy = true; retainedSources.delete(retained); coldPolicySeals.delete(handle) })()
          closeFlight = flight; void flight.finally(() => { if (closeFlight === flight) closeFlight = undefined }).catch(() => {}); return flight
        },
      })
      coldPolicySeals.set(handle, identity); retainedSources.add(retained); return handle
    },
    observeExecutionBinding(reference: RetainedExistingBinding, retired: (operation: RetainedCleanupOperation) => void | Promise<void>) {
      if (inspectorCount >= 32) throw new Error('Execution binding observation capacity reached')
      inspectorCount++
      let charged = true, active = true, detached = false, cleanupRequested = false, cleanupSettled = false
      let cleanupFailure: { error: unknown } | undefined
      let stopReference: (() => void) | undefined
      let inspector: Inspector | undefined
      let cleanup: Promise<void> | undefined
      let notified = false
      let fenceObserver: ReturnType<SessionManagementFence['observe']> | undefined
      const uncharge = () => { if (charged) { charged = false; inspectorCount--; if (inspector) inspectors.delete(inspector) } }
      const detach = () => { if (detached) return; detached = true; fenceObserver?.release(); stopReference?.() }
      const retire = (operation: RetainedCleanupOperation): Promise<void> => {
        active = false; cleanupRequested = true; detach()
        if (cleanup) return cleanup
        const result = Promise.withResolvers<void>(); cleanup = result.promise
        void cleanup.catch(() => {})
        let release: Promise<void>
        try { release = reference.release(operation) } catch (error) { release = Promise.reject(error) }
        let notification: Promise<void> = Promise.resolve()
        if (!notified) {
          notified = true
          try { notification = runRetainedRetirementSink(operation, coordinator, inspector!, () => retired(operation)) } catch (error) { notification = Promise.reject(error) }
        }
        void Promise.allSettled([release, notification]).then(results => {
          cleanupSettled = true
          if (results[0]!.status === 'fulfilled') uncharge()
          const errors = results.flatMap(value => value.status === 'rejected' ? [value.reason] : [])
          if (errors.length) { cleanup = undefined; cleanupFailure = { error: errors[0] }; result.reject(errors.length === 1 ? errors[0] : new AggregateError(errors, 'Execution observation cleanup failed')) }
          else result.resolve()
        })
        return result.promise
      }
      try {
        if (typeof retired !== 'function') throw new TypeError('Invalid retirement callback')
        assertRetainedBindingReferenceFor(coordinator, reference)
        preflightRetainedBindingReleaseFor(coordinator, reference)
        assertOpen()
        if (globalInspectorAdmissions) throw new Error('Project binding operation pending')
        const meta = reference.metadata(), id = identifier(meta.sessionId)
        fence.assertOpen(id)
        if (meta.archived || !isConversationMetadata(meta)) throw new Error('Session is unavailable')
        if (inspectorPending(id) || operations.has(id) || loading.has(id) || catalogPending) throw new Error('Project binding operation pending')
        const document = reference.binding(), own = parseBinding(document.kind === 'present' ? document.value : undefined)
        assertRetainedBindingReferenceFor(coordinator, reference)
        observeBinding(id, own); parents.delete(id)
        const projectId = own.projectId
        if (referenceFailure || referenceUpdates || scopeUpdates.has(projectId ?? '') || pendingChanges.has(projectId ?? '')) throw new Error('Project scope changed')
        assertAvailable(projectId)
        const stamp = canonicalJsonData([own, bindingRevisions.get(id) ?? 0, projectId ?? null, revisions.get(projectId ?? '') ?? 0, referenceRevision, projectId ? projects.get(projectId) : null])
        inspector = { id, preflight: () => preflightRetainedBindingReleaseFor(coordinator, reference), retire }
        inspectors.add(inspector)
        fenceObserver = fence.observe(id, operation => cleanup ?? retire(operation), inspector.preflight, operation => { void retire(operation).catch(() => {}) })
        if (!active) fenceObserver.release()
        stopReference = observeRetainedBindingRetirementFor(coordinator, reference, operation => retire(operation))
        if (!active) stopReference()
        const assertCurrent = () => {
          if (!active) throw new Error('Execution binding observation retired')
          try {
            assertOpen(); fenceObserver!.assertCurrent(); assertRetainedBindingReferenceFor(coordinator, reference)
            const currentMeta = reference.metadata()
            if (currentMeta.sessionId !== id || currentMeta.archived || !isConversationMetadata(currentMeta)) throw new Error('Session is unavailable')
            if (inspectorPending(id) || operations.has(id) || loading.has(id) || catalogPending || referenceFailure || referenceUpdates || scopeUpdates.has(projectId ?? '') || pendingChanges.has(projectId ?? '')) throw new Error('Project scope changed')
            assertAvailable(projectId)
            const current = canonicalJsonData([bindings.get(id), bindingRevisions.get(id) ?? 0, projectId ?? null, revisions.get(projectId ?? '') ?? 0, referenceRevision, projectId ? projects.get(projectId) : null])
            if (current !== stamp || parents.has(id)) throw new Error('Project binding observation changed')
          } catch (error) {
            active = false; cleanupRequested = true
            const ticket = requestRetainedReferenceRetirementFor(coordinator, reference, error)
            void ticket.then(() => { cleanupSettled = true; uncharge() }, failure => { cleanupSettled = true; cleanupFailure = { error: failure } })
            throw error
          }
        }
        assertCurrent()
        return Object.freeze({ assertCurrent, release() { active = false; detach(); if (!cleanupRequested || (cleanupSettled && !cleanupFailure)) uncharge() } })
      } catch (error) { if (inspector) invalidateInspectors([inspector.id]); else { active = false; fenceObserver?.release(); stopReference?.(); uncharge() }; throw error }
    },
    async retainSelectedBindingRead(sessionIds:readonly string[],binding:Awaited<ReturnType<BindingObservations['acquireSelectedBindingRead']>>,sourceId:string) {
      assertOpen();binding.assertCurrent()
      if(!sessionIds.length||sessionIds.length>32||new Set(sessionIds).size!==sessionIds.length||!sessionIds.includes(sourceId))throw Error('Invalid held project lineage')
      const ids=new Set(sessionIds.map(identifier)),observation=binding.observation
      let active=true,uses=0,drain=Promise.withResolvers<void>(),dependent:{revoke():void;close():Promise<void>}|undefined,used=false
      const revoke=()=>{active=false;dependent?.revoke()}
      const item={ids,revoke:()=>binding.revoke()}
      const dependency={revoke,async close(){revoke();if(uses)await drain.promise;if(dependent)await dependent.close();retainedSources.delete(item)}}
      try {
        binding.installRetirementDependency(dependency)
        for(const id of ids){if(operations.has(id)||loading.has(id))throw Error('Project binding operation pending');const meta=observation.metadata(id),doc=observation.binding(id),value=parseBinding(doc.kind==='present'?doc.value:undefined);observeBinding(id,value);if(!value.bound&&meta.parentSession&&['subagent','team'].includes(meta.origin??''))parents.set(id,identifier(meta.parentSession));else parents.delete(id)}
        retainedSources.add(item)
        const stamp=()=>canonicalJsonData([...ids].map(id=>[id,bindingRevisions.get(id)??0,authority(id).revision,liveOwner(id)??null])),original=stamp()
        const assertCurrent=()=>{assertOpen();binding.assertCurrent();if(!active||original!==stamp())throw Error('Project binding observation changed');for(const id of ids){if(operations.has(id)||loading.has(id))throw Error('Project binding operation pending');const projectId=liveOwner(id);if(referenceFailure||referenceUpdates||scopeUpdates.has(projectId??'')||pendingChanges.has(projectId??''))throw Error('Project scope changed');assertAvailable(projectId)}}
        const captured:BindingObservation={ids,observation,assertCurrent}
        let setupEntered=true
        const setupEntry:BindingObservation={ids,observation,assertCurrent(){if(!setupEntered)throw Error('Project observation expired');assertCurrent()}}
        // Setup is original binding work too: revocation joins this acquisition
        // before calling our dependency close or releasing its locks and pins.
        // Its ALS entry expires independently of the original lifetime capture
        // retained by the getter, on successful setup and before failed cleanup.
        let getter:Awaited<ReturnType<typeof observedResultGetter>>
        try {getter=await binding.use(()=>bindingObservations.run([...(bindingObservations.getStore()??[]),setupEntry],async()=>{assertCurrent();for(const id of ids)await ensureVisible(id);return observedResultGetter(sourceId,captured)}))}
        finally {setupEntered=false}
        assertCurrent();getter()
        return Object.freeze({sourceGetter:getter,assertCurrent,attachResult(result:{revoke():void;close():Promise<void>}){assertCurrent();if(used||dependent)throw Error('Result dependency already bound');dependent=result},async use<T>(work:()=>Promise<T>){assertCurrent();used=true;uses++;let entered=true;const entry:BindingObservation={ids,observation,assertCurrent(){if(!entered)throw Error('Project observation expired');assertCurrent()}};try{return await binding.use(()=>bindingObservations.run([...(bindingObservations.getStore()??[]),entry],async()=>{assertCurrent();const value=await work();assertCurrent();return value}))}finally{entered=false;if(!--uses){drain.resolve();drain=Promise.withResolvers<void>()}}},revoke:()=>binding.revoke(),close:()=>binding.release()})
      }catch(error){binding.revoke();try{await binding.release()}catch(cleanup){throw cleanup}throw error}
    },
    async withBindingObservation<T>(sessionIds: readonly string[], observation: ExistingSessionBindingObservation, use: () => Promise<T>): Promise<T> {
      assertOpen(); observation.assertCurrent()
      if (!sessionIds.length || sessionIds.length > 32 || new Set(sessionIds).size !== sessionIds.length) throw new Error('Invalid held project lineage')
      const ids = new Set(sessionIds.map(identifier))
      for (const id of ids) {
        if (operations.has(id) || loading.has(id)) throw new Error('Project binding operation pending')
        const meta = observation.metadata(id), document = observation.binding(id)
        const binding = parseBinding(document.kind === 'present' ? document.value : undefined)
        observeBinding(id, binding)
        if (!binding.bound && meta.parentSession && ['subagent', 'team'].includes(meta.origin ?? '')) parents.set(id, identifier(meta.parentSession))
        else parents.delete(id)
      }
      const stamp = () => canonicalJsonData([...ids].map(id => [id, bindingRevisions.get(id) ?? 0, authority(id).revision, liveOwner(id) ?? null]))
      const original = stamp()
      let active = true
      const captured: BindingObservation = { ids, observation, assertCurrent() {
        assertOpen(); observation.assertCurrent()
        if (!active) throw new Error('Project binding observation expired')
        if (original !== stamp()) throw new Error('Project binding observation changed')
        for (const id of ids) {
          if (operations.has(id) || loading.has(id)) throw new Error('Project binding operation pending')
          const projectId = liveOwner(id)
          if (referenceFailure || referenceUpdates || scopeUpdates.has(projectId ?? '') || pendingChanges.has(projectId ?? '')) throw new Error('Project scope changed')
          assertAvailable(projectId)
        }
      } }
      try {
        return await bindingObservations.run([...(bindingObservations.getStore() ?? []), captured], async () => {
          captured.assertCurrent()
          for (const id of ids) await ensureVisible(id)
          captured.assertCurrent(); const result = await use(); captured.assertCurrent(); return result
        })
      } finally { active = false }
    },
    prepareBootstrapInheritance(input: BootstrapProjectCapture): BootstrapProjectPreparation {
      const capture=captureBootstrapProject(input)
      return prepareProject(capture,async()=>{const inspection=await coordinator.inspectBootstrap(capture.invocation);return ['reserved','ready'].includes(inspection.kind)&&inspection.token&&'manifestDigest' in inspection.token?{invocation:inspection.invocation,manifestDigest:inspection.token.manifestDigest}:undefined})
    },
    prepareTaskChildInheritance(input:TaskChildProjectCapture):BootstrapProjectPreparation{
      const capture=captureTaskChildProject(input)
      return prepareProject(capture,async()=>{if(!coordinator.inspectChildBootstrap)return;const inspection=await coordinator.inspectChildBootstrap(capture.request);return ['reserved','ready'].includes(inspection.kind)&&inspection.token&&'manifestDigest'in inspection.token?{invocation:inspection.invocation,manifestDigest:inspection.token.manifestDigest}:undefined},true)
    },
    prepareSelectedInheritance(input: import('./bootstrap-project.ts').SelectedProjectCapture) {
      const capture=importSelectedProject(input),owner=prepareProject(capture,async()=>inspectSelectedTarget(coordinator,capture.target))
      const invoke=(input:BootstrapPreparationFactsV2,current:(()=>boolean)|undefined)=>{
        try{
          const facts=captureSelectedResultsBootstrapPreparationFacts(input),original=inspectSelectedTarget(coordinator,capture.target)
          if(canonicalJsonData(facts)!==canonicalJsonData(original.facts))throw Error('Selected preparation mismatch')
          const request={invocation:facts.invocation,manifestDigest:facts.manifestDigest}
          return current?owner.targetPreparation.confirm(request,current):owner.targetPreparation.reconcile(request)
        }catch{return Promise.resolve({kind:'blocked' as const,reason:'conflict' as const})}
      }
      return Object.freeze({confirm:(facts:BootstrapPreparationFactsV2,current:()=>boolean)=>invoke(facts,current),reconcile:(facts:BootstrapPreparationFactsV2)=>invoke(facts,undefined),assertTargetCurrent:owner.targetPreparation.assertTargetCurrent,targetScope:owner.targetScope,close:owner.close})
    },
    async authorityFor(id: string): Promise<() => AuthorityState> {
      await resolveOwner(id)
      observed.add(id)
      return () => authority(id)
    },
    /** Host-confirmed source registrations impose restrictions only. */
    configureReferences(paths: readonly string[]): Promise<void> {
      invalidateRetained()
      const requested = [...paths]
      referenceRevision++
      referenceUpdates++
      const initialFence = observed.size ? moveOptions.authorityChanged?.([...observed]) ?? Promise.resolve() : Promise.resolve()
      void initialFence.catch(() => {})
      return catalog(async () => {
        await initialFence
        let confirmed: string[]
        try {
          confirmed = await Promise.all(requested.map(async path => {
            if (!isAbsolute(path)) throw new Error("Reference root must be absolute")
            return realpath(path)
          }))
        } catch (error) {
          referenceFailure = "Readonly reference registration unavailable"
          referenceRevision++
          if (observed.size) await moveOptions.authorityChanged?.([...observed])
          throw error
        }
        referenceFailure = undefined
        references = Object.freeze([...new Set(confirmed)])
        referenceRevision++
        if (observed.size) await moveOptions.authorityChanged?.([...observed])
      }).finally(() => { referenceUpdates-- })
    },
    configure(value: unknown): Promise<{ projectId: string }> {
      const snapshot = structuredClone(value)
      let declared: ConfirmedProjectScope
      try { declared = scopeSchema(snapshot) } catch (error) { return Promise.reject(error) }
      const request = nextRequest(declared.id)
      // Publish the admission generation before canonicalization or queued work.
      const initialFence = changed([declared.id])
      void initialFence.catch(() => {})
      return trackScopes([declared.id], catalog(async () => {
        await initialFence
        try {
          const project = await resolveScope(declared)
          assertOpen()
          const publish = JSON.stringify(projects.get(project.id)) !== JSON.stringify(project)
          projects.set(project.id, project)
          if (requests.get(project.id) === request) withdrawn.delete(project.id)
          await changed([project.id], publish)
          return { projectId: project.id }
        } catch (error) {
          if (error instanceof ProjectFoldersUnavailable) { assertOpen(); projects.set(declared.id, blocked(declared)); await changed([declared.id]) }
          throw error
        }
      }))
    },
    sync(value: unknown): Promise<{ synchronized: true }> {
      const snapshot = structuredClone(value)
      let declarations: ConfirmedProjectScope[]
      try {
        if (!Array.isArray(snapshot) || snapshot.length > 2048) throw new Error("Invalid project scope catalog")
        declarations = snapshot.map(scopeSchema)
        if (new Set(declarations.map(project => project.id)).size !== declarations.length) throw new Error("Project scope catalog contains duplicate IDs")
      } catch (error) { return Promise.reject(error) }
      const declaredIds = new Set(declarations.map(project => project.id))
      const removed = [...projects.keys()].filter(id => !declaredIds.has(id))
      for (const id of removed) { withdrawn.add(id); nextRequest(id) }
      const requestIds = new Map(declarations.map(project => [project.id, nextRequest(project.id)]))
      const initialIds = [...removed, ...declarations.filter(project => withdrawn.has(project.id) || JSON.stringify(projects.get(project.id)) !== JSON.stringify(project)).map(project => project.id)]
      const initialFence = changed(initialIds)
      void initialFence.catch(() => {})
      return trackScopes([...declaredIds], catalog(async () => {
        await initialFence
        const confirmed = await Promise.all(declarations.map(async (project) => {
          try { return await resolveScope(project) }
          catch (error) { if (error instanceof ProjectFoldersUnavailable) return blocked(project); throw error }
        }))
        assertOpen()
        const next = new Map(confirmed.map(project => [project.id, project]))
        const affected = [...new Set([...projects.keys(), ...next.keys()])].filter(id => JSON.stringify(projects.get(id)) !== JSON.stringify(next.get(id)))
        const retries = [...pendingChanges].filter(id => !affected.includes(id))
        projects.clear()
        for (const project of confirmed) {
          projects.set(project.id, project)
          if (requests.get(project.id) === requestIds.get(project.id)) withdrawn.delete(project.id)
        }
        await changed(affected)
        await changed(retries, false)
        return { synchronized: true as const }
      }))
    },
    revoke(projectId: string): Promise<{ revoked: boolean }> {
      try { identifier(projectId) } catch (error) { return Promise.reject(error) }
      const revoked = projects.has(projectId) && !withdrawn.has(projectId)
      nextRequest(projectId); withdrawn.add(projectId)
      const drain = changed([projectId])
      void drain.catch(() => {})
      return catalog(async () => { await drain; projects.delete(projectId); return { revoked } })
    },
    bind(id: string, projectId?: string): Promise<{ sessionId: string; projectId?: string }> {
      return serial(id, async () => {
        await ensureVisible(id)
        if (projectId !== undefined) identifier(projectId)
        const own = await load(id)
        const existing = await resolveOwner(id, id)
        if (existing.bound) {
          if (projectId !== undefined && existing.projectId !== projectId) throw new Error("Session already belongs to another project; an explicit move is required")
          assertAvailable(existing.projectId)
          if (!own.bound) await save(id, existing.projectId)
          return { sessionId: id, ...(existing.projectId ? { projectId: existing.projectId } : {}) }
        }
        if (projectId !== undefined && !projects.has(projectId)) throw new Error("Project scope has not been confirmed by the current main process")
        assertAvailable(projectId)
        await save(id, projectId)
        return { sessionId: id, ...(projectId ? { projectId } : {}) }
      })
    },
    projectFor,
    /** Only a target's own durable binding can avoid ancestor traversal. */
    async resultReadScopeFor(id: string): Promise<(() => import('@i-harness/session-executor').ResultReadScope) | undefined> {
      const captured = currentObservation(id)
      if (captured) {
        return observedResultGetter(id,captured)
      }
      const meta = await ensureVisible(id)
      if (meta.archived) throw new Error('Session is archived')
      await operations.get(id)
      const own = await load(id)
      assertOpen()
      if (!own.bound) return undefined
      observed.add(id)
      const get = () => {
        assertOpen()
        if (!bindings.get(id)?.bound) throw new Error('Result read binding unavailable')
        const projectId = bindings.get(id)!.projectId
        assertAvailable(projectId)
        const context = projectId ? projects.get(projectId) : undefined
        return { ...(projectId ? { projectId } : {}), ...(context ? { scope: { id: context.id, name: context.name, primaryRoot: context.primaryRoot!, roots: [...context.roots] } } : {}),
          revision: `${bindingRevisions.get(id) ?? 0}:${projectId ?? 'unbound'}:${revisions.get(projectId ?? '') ?? 0}` }
      }
      get()
      return get
    },
    async nativeScopeFor(id:string):Promise<{projectId?:string;scope?:SessionProjectContext;revision:string}> {
      await resolveOwner(id, undefined, true)
      assertOpen()
      const projectId=liveOwner(id)
      const revision = authority(id).revision + ':binding:' + (bindingRevisions.get(id) ?? 0)
      if(!projectId)return {revision}
      const context=projects.get(projectId)
      if(!context)return {projectId,revision}
      assertAvailable(projectId)
      return {projectId,revision,scope:{id:context.id,name:context.name,roots:[...context.roots],primaryRoot:context.primaryRoot!}}
    },
    move(id: string, expectedOwner: string | undefined, projectId: string | undefined): Promise<{ sessionId: string; projectId?: string; executionWorkspace: string }> {
      return fence.exclusive(id, () => serial(id, async () => {
        const meta = await ensureVisible(id)
        if (meta.origin === "subagent" || meta.origin === "approval-review" || (meta.origin === "team" && meta.parentSession)) throw new Error("Session is unavailable for project move")
        if (!moveOptions.assertIdle) throw new Error("Idle project move inspection is unavailable")
        if (expectedOwner !== undefined) identifier(expectedOwner)
        if (projectId !== undefined) identifier(projectId)
        // A reader pin holds the native lock without adopting a live writer.
        const alreadyOwned = coordinator.hasLiveOwnership?.(id) ?? coordinator.ownerOf(id)
        await coordinator.adoptOwnership(id)
        try {
        // A second broker/process may have committed ownership since this
        // broker last resolved it. Compare durable identity under the lease.
        await loading.get(id)
        bindings.delete(id)
        const current = await resolveOwner(id, id)
        if (current.projectId !== expectedOwner) throw new Error("Session project owner changed; refresh before moving")
        for (const child of await coordinator.list()) if ((await coordinator.profile(child)).meta.parentSession === id) throw new Error("Session has descendants; coordinated project move is unavailable")
        await catalog(async () => {
          if (projectId !== undefined) {
            const declared = projects.get(projectId)
            if (!declared) throw new Error("Destination project has not been confirmed by the current main process")
            projects.set(projectId, await resolveScope(declared))
            assertAvailable(projectId)
          }
        })
        await moveOptions.assertIdle(id)
        await moveOptions.drainSession?.(id)
        await moveOptions.assertIdle(id)
        await catalog(async () => {
          await loading.get(id)
          bindings.delete(id)
          if ((await resolveOwner(id, id)).projectId !== expectedOwner) throw new Error("Session project owner changed; refresh before moving")
          if (projectId !== undefined) {
            const declared = projects.get(projectId)
            if (!declared) throw new Error("Destination project has not been confirmed by the current main process")
            const scope = await resolveScope(declared)
            projects.set(projectId, scope)
            assertAvailable(projectId)
          }
          await save(id, projectId)
        })
        return { sessionId: id, ...(projectId ? { projectId } : {}), executionWorkspace: _workspace }
        } finally { if (!alreadyOwned) await coordinator.releaseOwnership(id) }
      }), async () => {
        if (!moveOptions.assertIdle) throw new Error("Idle project move inspection is unavailable")
        await moveOptions.assertIdle(id)
      }, brokerOperation.getStore()?.operation)
    },
    async state(id: string): Promise<{ sessionId: string; projectId?: string }> {
      const projectId = await projectFor(id)
      return { sessionId: id, ...(projectId ? { projectId } : {}) }
    },
    /** Passive metadata only. Never loads a document or grants project authority. */
    projectSnapshotFor(id:string):string|undefined { return liveOwner(id) },
    async forSession(id: string): Promise<() => SessionProjectContext | undefined> {
      await resolveOwner(id)
      observed.add(id)
      return () => {
        const state = authority(id)
        if (state.kind === "revoked" || state.kind === "unavailable") throw new Error(state.reason)
        const projectId = liveOwner(id)
        const context = projectId ? projects.get(projectId) : undefined
        if (!context) return undefined
        assertAvailable(projectId)
        return { id: context.id, name: context.name, primaryRoot: context.primaryRoot!, roots: [...context.roots] }
      }
    },
    inherit(sourceId: string, childId: string): Promise<void> {
      return serial(childId, async () => {
        await ensureVisible(childId)
        const projectId = await projectFor(sourceId)
        const existing = await load(childId)
        if (existing.bound) {
          if (existing.projectId !== projectId) throw new Error("Forked session already belongs to another project")
          return
        }
        await save(childId, projectId)
      })
    },
    close(): Promise<void> {
      if (closing) return closing
      invalidateRetained()
      closed = true
      projects.clear()
      closing = Promise.allSettled([catalogTail, ...operations.values(), ...loading.values()]).then(async () => {
        if (observed.size) await moveOptions.authorityChanged?.([...observed])
      }).catch(error => { closing = undefined; throw error })
      return closing
    },
  }
  let inspectorClose: Promise<void> | undefined
  function admission<A extends unknown[], R>(original: (...args: A) => Promise<R>, selectedIds: (...args: A) => readonly string[] | undefined, isClose = false): (...args: A) => Promise<R> {
    return (...args) => {
      const ids = selectedIds(...args)
      try { preflightInspectors(ids); assertOutsideRetirementSink(coordinator) } catch (error) { return Promise.reject(error) }
      if (ids) for (const id of ids) policyAdmissions.set(id, {}); else globalPolicyAdmission = {}
      if (isClose && inspectorClose) return inspectorClose as Promise<R>
      const previous = brokerOperation.getStore()
      const inherited = previous?.active ? previous : undefined
      const context: BrokerCleanup = inherited ?? { operation: createRetainedCleanupOperation(), active: true }
      const operation = context.operation
      const done = Promise.withResolvers<R>()
      if (isClose) inspectorClose = done.promise as Promise<void>
      if (ids) for (const id of ids) pendingInspectorIds.set(id, (pendingInspectorIds.get(id) ?? 0) + 1)
      else globalInspectorAdmissions++
      brokerOperation.run(context, () => {
        const jobs = retireInspectors(operation, ids)
        // Preserve the original method's synchronous admission/revision and V1
        // revocation sites. Cleanup runs independently and is joined before the
        // outer operation settles; coordinator writes join the selected debt.
        let work: Promise<R>
        try { work = original(...args) } catch (error) { work = Promise.reject(error) }
        void (async () => {
          const [primary, cleanup] = await Promise.allSettled([work, joinInspectorCleanup([...jobs, joinRetainedRetirementSinks(operation)])])
          let outcome: { ok: true; value: R } | { ok: false; error: unknown }
          if (primary.status === 'rejected') outcome = { ok: false, error: cleanup.status === 'rejected' ? new AggregateError([primary.reason, cleanup.reason], 'Broker operation and cleanup failed') : primary.reason }
          else if (cleanup.status === 'rejected') outcome = { ok: false, error: cleanup.reason }
          else outcome = { ok: true, value: primary.value }
          if (!inherited) {
            context.active = false; finishRetainedCleanupOperation(operation)
          }
          if (ids) for (const id of ids) { const count = pendingInspectorIds.get(id)! - 1; if (count) pendingInspectorIds.set(id, count); else pendingInspectorIds.delete(id) }
          else globalInspectorAdmissions--
          if (outcome.ok) done.resolve(outcome.value)
          else { if (isClose) inspectorClose = undefined; done.reject(outcome.error) }
        })()
      })
      return done.promise
    }
  }
  broker.configureReferences = admission(broker.configureReferences, () => undefined)
  broker.configure = admission(broker.configure, () => undefined)
  broker.sync = admission(broker.sync, () => undefined)
  broker.revoke = admission(broker.revoke, () => undefined)
  broker.bind = admission(broker.bind, id => [id])
  broker.move = admission(broker.move, id => [id])
  broker.inherit = admission(broker.inherit, (_source, child) => [child])
  broker.close = admission(broker.close, () => undefined, true)
  return broker
}
